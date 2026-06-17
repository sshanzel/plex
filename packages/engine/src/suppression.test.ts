import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '@plex/core';
import { learnSuppression, loadSuppressions, suppressionKeyFor, languageOf, knowledgeStore } from './knowledge';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const cfg = () => {
  dir = mkdtempSync(join(tmpdir(), 'plex-supp-'));
  return resolveConfig({ knowledgeDir: dir });
};
// With the deterministic test-only embedder, so the first-principles (semantic) path is exercised.
const cfgEmbed = () => {
  dir = mkdtempSync(join(tmpdir(), 'plex-supp-'));
  return resolveConfig({ knowledgeDir: dir, embedding: { provider: 'fake' } });
};

describe('suppressionKeyFor', () => {
  it('parses the rule tag out of a deterministic finding id', () => {
    expect(suppressionKeyFor({ findingId: 'det:no-console:src/a.ts:42' })).toBe('no-console');
  });
  it('falls back to an explicit pattern', () => {
    expect(suppressionKeyFor({ pattern: 'no-foo' })).toBe('no-foo');
  });
  it('returns undefined for an untagged first-principles finding (no stable identity)', () => {
    expect(suppressionKeyFor({ findingId: 'agent:3' })).toBeUndefined();
    expect(suppressionKeyFor({})).toBeUndefined();
  });
});

describe('languageOf', () => {
  it('maps TS/JS family to ts and keeps others distinct', () => {
    expect(languageOf('src/a.tsx')).toBe('ts');
    expect(languageOf('m.mjs')).toBe('ts');
    expect(languageOf('s.py')).toBe('py');
    expect(languageOf('x.unknownext')).toBeUndefined();
    expect(languageOf(undefined)).toBeUndefined();
  });
});

describe('learnSuppression → loadSuppressions (C1: weighted, not a one-click kill)', () => {
  const reject = (config: ReturnType<typeof resolveConfig>, file = 'src/a.ts') =>
    learnSuppression(config, 'myrepo', { kind: 'reject', findingId: `det:no-console:${file}:1`, file }, true);

  const tierOf = async (config: ReturnType<typeof resolveConfig>, repo = 'myrepo', key = 'no-console') =>
    (await loadSuppressions(config, repo)).find((d) => d.key === key)?.tier;

  it('one dismissal does NOT suppress — at most demotes', async () => {
    const config = cfg();
    await reject(config);
    expect(await tierOf(config)).not.toBe('suppress');
  });

  it('several consistent dismissals earn a repo-wide suppression', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    const decisions = await loadSuppressions(config, 'myrepo');
    const d = decisions.find((x) => x.key === 'no-console')!;
    expect(d.tier).toBe('suppress');
    expect(d.dismissals).toBeCloseTo(4, 4); // ~4 (recency-decayed; fresh incidents ≈ full weight, ADR-41)
    expect(d.corrections).toBe(0);
    // …and only ONE negative pitfall was minted for the rule (not one per dismissal).
    const negs = (await knowledgeStore(config).pitfalls()).filter((p) => p.polarity === 'negative');
    expect(negs).toHaveLength(1);
    expect(negs[0]!.suppressKey).toBe('no-console');
    expect(negs[0]!.language).toBe('ts'); // language captured for the C2 gate
    // each dismissal incident records the verb as provenance (the history of WHY).
    const incs = (await knowledgeStore(config).incidents()).filter((i) => i.pitfallId === negs[0]!.id);
    expect(incs.every((i) => i.note?.startsWith('reject'))).toBe(true);
  });

  it('captures the dismissal reasoning (verdict note) in the suppression why + incident note', async () => {
    const config = cfg();
    const why = 'console is intentional here — CLI entrypoint logger';
    await learnSuppression(config, 'myrepo', { kind: 'waive', findingId: 'det:no-console:a.ts:1', file: 'a.ts', note: why }, true);
    const neg = (await knowledgeStore(config).pitfalls()).find((p) => p.polarity === 'negative')!;
    expect(neg.why).toContain(why); // the real reason, not the boilerplate template
    const inc = (await knowledgeStore(config).incidents()).find((i) => i.pitfallId === neg.id)!;
    expect(inc.note).toContain(why); // reasoning is on the incident provenance too
  });

  it('falls back to the boilerplate why when no reasoning is supplied', async () => {
    const config = cfg();
    await reject(config);
    const neg = (await knowledgeStore(config).pitfalls()).find((p) => p.polarity === 'negative')!;
    expect(neg.why).toContain('Learned suppression');
  });

  it('a correction (the user fixes it) pulls it back out of suppression', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    expect(await tierOf(config)).toBe('suppress');
    await learnSuppression(config, 'myrepo', { kind: 'accept', findingId: 'det:no-console:e.ts:1', file: 'e.ts' }, true);
    expect(await tierOf(config)).not.toBe('suppress');
  });

  it('item 1: an INFERRED accept refutes a suppression via `pattern` (brain id has no det: tag)', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    expect(await tierOf(config)).toBe('suppress');
    // reconcile/fix-inference path: a brain finding id (no det: rule) + the rule carried as `pattern`.
    await learnSuppression(
      config,
      'myrepo',
      { kind: 'accept', findingId: 'myrepo#x.ts:1#leftover-console-call', pattern: 'no-console', file: 'x.ts' },
      true,
    );
    expect(await tierOf(config)).not.toBe('suppress'); // the auto-accept reversal now fires
  });

  it('item 3: repeated dismissals in the SAME file (line drift) count once, not N times', async () => {
    const config = cfg();
    // Same file, different line-bearing ids — a persistent violation drifting across rounds.
    for (const line of [1, 5, 9, 13]) {
      await learnSuppression(config, 'myrepo', { kind: 'reject', findingId: `det:no-console:a.ts:${line}`, file: 'a.ts' }, true);
    }
    expect(await tierOf(config)).not.toBe('suppress'); // 4 line-drifted rejects in one file ≠ 4 independent
    const neg = (await knowledgeStore(config).pitfalls()).find((p) => p.polarity === 'negative')!;
    const dismissals = (await knowledgeStore(config).incidents()).filter((i) => i.pitfallId === neg.id && i.outcome === 'rejected');
    expect(dismissals).toHaveLength(1); // deduped by (rule, file)
  });

  it('item 2: a `waive` after a `reject` on the same file is recorded as an UPGRADE (both verbs on disk)', async () => {
    const config = cfg();
    // Escalation on the SAME (pitfall, file): "not now" → "this is wrong".
    await learnSuppression(config, 'myrepo', { kind: 'reject', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, true);
    await learnSuppression(config, 'myrepo', { kind: 'waive', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, true);
    const neg = (await knowledgeStore(config).pitfalls()).find((p) => p.polarity === 'negative')!;
    const dismissalIncs = (await knowledgeStore(config).incidents()).filter((i) => i.pitfallId === neg.id && i.outcome === 'rejected');
    // The waive WAS allowed through (unlike a flat reject re-dismissal) — both verbs on disk as provenance.
    expect(dismissalIncs.map((i) => i.verb).sort()).toEqual(['reject', 'waive']);
  });

  it('item 2: a `reject` after a `waive` does NOT downgrade (monotone upgrade only)', async () => {
    const config = cfg();
    await learnSuppression(config, 'myrepo', { kind: 'waive', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, true);
    await learnSuppression(config, 'myrepo', { kind: 'reject', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, true);
    const neg = (await knowledgeStore(config).pitfalls()).find((p) => p.polarity === 'negative')!;
    const dismissalIncs = (await knowledgeStore(config).incidents()).filter((i) => i.pitfallId === neg.id && i.outcome === 'rejected');
    expect(dismissalIncs.map((i) => i.verb)).toEqual(['waive']); // the later reject carried no new info → dropped
  });

  it('item 2: the upgraded `waive` half-life makes a suppression OUTLIVE an equivalent reject-only one', async () => {
    // Two independent stores: `up` escalates each dismissal reject→waive; `ctrl` stays reject-only.
    const upDir = mkdtempSync(join(tmpdir(), 'plex-supp-up-'));
    const ctrlDir = mkdtempSync(join(tmpdir(), 'plex-supp-ctrl-'));
    try {
      const up = resolveConfig({ knowledgeDir: upDir });
      const ctrl = resolveConfig({ knowledgeDir: ctrlDir });
      for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
        await learnSuppression(up, 'r', { kind: 'reject', findingId: `det:no-console:${f}:1`, file: f }, true);
        await learnSuppression(up, 'r', { kind: 'waive', findingId: `det:no-console:${f}:1`, file: f }, true); // escalate
        await learnSuppression(ctrl, 'r', { kind: 'reject', findingId: `det:no-console:${f}:1`, file: f }, true);
      }
      const tier = async (c: ReturnType<typeof resolveConfig>, now: Date) =>
        (await loadSuppressions(c, 'r', now)).find((d) => d.key === 'no-console')?.tier;
      const now = new Date();
      // Fresh: both suppress (the upgrade collapses each pair to one vote, so `up` isn't over-counted).
      expect(await tier(up, now)).toBe('suppress');
      expect(await tier(ctrl, now)).toBe('suppress');
      // +120d: reject (30d half-life) has decayed ~16× (0.5^4) → ctrl falls out entirely; the upgraded
      // waive (365d) is still ~0.8 weight → `up` is still actively suppressing. This is the whole point
      // of the escalation: a waive that lands after a reject must actually start persisting.
      const aged = new Date(now.getTime() + 120 * 86_400_000);
      expect(await tier(up, aged)).toBeDefined();
      expect(await tier(ctrl, aged)).toBeUndefined();
    } finally {
      rmSync(upDir, { recursive: true, force: true });
      rmSync(ctrlDir, { recursive: true, force: true });
    }
  });

  it('a retry (firstOfKind=false) does not double-count', async () => {
    const config = cfg();
    await learnSuppression(config, 'myrepo', { kind: 'reject', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, false);
    expect(await loadSuppressions(config, 'myrepo')).toEqual([]);
  });

  it('an accept with no prior negative pitfall mints nothing', async () => {
    const config = cfg();
    await learnSuppression(config, 'myrepo', { kind: 'accept', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, true);
    const negs = (await knowledgeStore(config).pitfalls()).filter((p) => p.polarity === 'negative');
    expect(negs).toHaveLength(0);
  });

  it('repo-scoped suppression does not leak to a different repo (until it generalizes)', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    expect(await loadSuppressions(config, 'otherrepo')).toEqual([]); // only ONE repo so far
  });

  const suppressIn = async (config: ReturnType<typeof resolveConfig>, repo: string, ext = 'ts') => {
    for (const f of ['a', 'b', 'c', 'd']) {
      await learnSuppression(config, repo, { kind: 'reject', findingId: `det:no-console:${f}.${ext}:1`, file: `${f}.${ext}` }, true);
    }
  };

  it('C2: a rule suppressed in ≥2 distinct repos of a language generalizes to a fresh repo', async () => {
    const config = cfg();
    await suppressIn(config, 'repoA');
    expect(await tierOf(config, 'freshRepo')).toBeUndefined(); // 1 repo — not yet
    await suppressIn(config, 'repoB');
    expect(await tierOf(config, 'freshRepo')).toBe('suppress'); // 2 repos — generalized
  });

  it('C2: languages never merge to reach the promotion threshold', async () => {
    const config = cfg();
    // The same key suppressed in ONE ts repo and ONE py repo — 2 repos, but 1 per language.
    for (const f of ['a', 'b', 'c', 'd'])
      await learnSuppression(config, 'tsRepo', { kind: 'reject', pattern: 'shared', findingId: `f${f}`, file: `${f}.ts` }, true);
    for (const f of ['a', 'b', 'c', 'd'])
      await learnSuppression(config, 'pyRepo', { kind: 'reject', pattern: 'shared', findingId: `f${f}`, file: `${f}.py` }, true);
    // Neither language reached 2 distinct repos → no cross-language generalization.
    expect(await tierOf(config, 'freshRepo', 'shared')).toBeUndefined();
  });
});

describe('first-principles suppression (semantic key, ADR-41)', () => {
  const negsOf = async (config: ReturnType<typeof resolveConfig>) =>
    (await knowledgeStore(config).pitfalls()).filter((p) => p.polarity === 'negative');
  // A first-principles dismissal: no `det:` id, no pattern — only a title (the semantic key).
  const fp = (config: ReturnType<typeof resolveConfig>, file: string, title = 'Possible null deref on `user.profile`') =>
    learnSuppression(config, 'myrepo', { kind: 'reject', findingId: `agent:${file}`, title, file }, true);

  it('mints an embedding-keyed negative pitfall (no suppressKey) for a dismissed first-principles finding', async () => {
    const config = cfgEmbed();
    await fp(config, 'a.ts');
    const negs = await negsOf(config);
    expect(negs).toHaveLength(1);
    expect(negs[0]!.suppressKey).toBeUndefined(); // identity is the embedding, not a tag
    expect(negs[0]!.embedding?.length).toBeGreaterThan(0);
  });

  it('accumulates repeated dismissals of the SAME issue onto ONE pitfall → suppress, carrying the vector', async () => {
    const config = cfgEmbed();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await fp(config, f); // same title → all match by cosine
    const negs = await negsOf(config);
    expect(negs).toHaveLength(1); // matched the first, did not mint duplicates
    const d = (await loadSuppressions(config, 'myrepo')).find((x) => x.pitfallId === negs[0]!.id)!;
    expect(d.tier).toBe('suppress');
    expect(d.embedding?.length).toBeGreaterThan(0); // ranking matches findings semantically via this
  });

  it('does NOT learn first-principles suppression without an embedding provider (deterministic-only degradation)', async () => {
    const config = cfg(); // provider 'none'
    await fp(config, 'a.ts');
    expect(await negsOf(config)).toHaveLength(0);
  });

  it('a corrective accept with no matching negative pitfall mints nothing', async () => {
    const config = cfgEmbed();
    await learnSuppression(config, 'myrepo', { kind: 'accept', findingId: 'agent:x', title: 'Unrelated', file: 'a.ts' }, true);
    expect(await negsOf(config)).toHaveLength(0);
  });
});
