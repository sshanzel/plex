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
