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
    expect(d.dismissals).toBe(4); // the evidence basis travels with the decision (provenance)
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
