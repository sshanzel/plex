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

  it('one dismissal does NOT suppress — at most demotes', async () => {
    const config = cfg();
    await reject(config);
    const m = await loadSuppressions(config, 'myrepo');
    expect(m.get('no-console')).not.toBe('suppress');
  });

  it('several consistent dismissals earn a repo-wide suppression', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    const m = await loadSuppressions(config, 'myrepo');
    expect(m.get('no-console')).toBe('suppress');
    // …and only ONE negative pitfall was minted for the rule (not one per dismissal).
    const negs = (await knowledgeStore(config).pitfalls()).filter((p) => p.polarity === 'negative');
    expect(negs).toHaveLength(1);
    expect(negs[0]!.suppressKey).toBe('no-console');
    expect(negs[0]!.language).toBe('ts'); // language captured for the C2 gate
  });

  it('a correction (the user fixes it) pulls it back out of suppression', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    expect((await loadSuppressions(config, 'myrepo')).get('no-console')).toBe('suppress');
    await learnSuppression(config, 'myrepo', { kind: 'accept', findingId: 'det:no-console:e.ts:1', file: 'e.ts' }, true);
    expect((await loadSuppressions(config, 'myrepo')).get('no-console')).not.toBe('suppress');
  });

  it('a retry (firstOfKind=false) does not double-count', async () => {
    const config = cfg();
    await learnSuppression(config, 'myrepo', { kind: 'reject', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, false);
    expect(await loadSuppressions(config, 'myrepo')).toEqual(new Map());
  });

  it('an accept with no prior negative pitfall mints nothing', async () => {
    const config = cfg();
    await learnSuppression(config, 'myrepo', { kind: 'accept', findingId: 'det:no-console:a.ts:1', file: 'a.ts' }, true);
    const negs = (await knowledgeStore(config).pitfalls()).filter((p) => p.polarity === 'negative');
    expect(negs).toHaveLength(0);
  });

  it('repo-scoped suppression does not leak to a different repo', async () => {
    const config = cfg();
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await reject(config, f);
    expect((await loadSuppressions(config, 'otherrepo')).size).toBe(0);
  });
});
