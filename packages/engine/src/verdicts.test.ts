import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type ReviewerConfig } from '@plex/core';
import { repoPaths } from './paths';
import { recordVerdict, readVerdicts, loadWaivers } from './verdicts';

// verdicts.ts is pure fs (no Kùzu) → vitest-safe. A waiver's embedding must be PERSISTED (so the
// next round can re-match it semantically, ADR-27) but never RETURNED to the caller, which echoes
// the verdict to the agent over MCP/CLI — a 1024-float vector there is dead tokens (A2).
let root: string;
let config: ReviewerConfig;
const repo = '/some/repo';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plex-verdicts-'));
  config = resolveConfig({ dataDir: root });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('recordVerdict', () => {
  it('persists the waiver embedding to the log but does NOT return it to the caller', async () => {
    const stored = await recordVerdict(
      repo,
      { findingId: 'f1', kind: 'waive', scope: 'category-global', title: 'unvalidated input', embedding: [0.1, 0.2, 0.3] },
      config,
    );
    // Returned value (echoed to the agent) is slim — no vector.
    expect('embedding' in stored).toBe(false);
    expect(stored.findingId).toBe('f1');
    expect(stored.ts).toBeTruthy();
    // …but the on-disk log keeps it for next-round semantic matching.
    const onDisk = await readVerdicts(repo, config);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('round-trips a plain verdict (no embedding to strip)', async () => {
    const stored = await recordVerdict(repo, { findingId: 'f2', kind: 'accept' }, config);
    expect('embedding' in stored).toBe(false);
    expect((await readVerdicts(repo, config))[0]!.kind).toBe('accept');
  });

  // #10 silent-failure audit: one corrupt line (a truncated final record from an interrupted append,
  // a partial fsync) must NOT discard EVERY verdict. The old whole-file `.map(JSON.parse)` threw and
  // the catch returned [] — total, silent loss of all waivers/suppressions, so every previously-waived
  // or -rejected finding re-surfaces with no error. Match store.ts/audit.ts: skip the bad line, keep
  // the rest. This is the verdict-store sibling of the same fault those two already guard against.
  it('skips a single corrupt line and keeps the surrounding valid verdicts', async () => {
    await recordVerdict(repo, { findingId: 'good1', kind: 'waive', file: 'a.ts', line: 1, title: 'first' }, config);
    // Inject a torn record between two good ones (exactly what an interrupted append leaves behind).
    appendFileSync(repoPaths(repo, config.dataDir).verdictsFile, '{"findingId":"torn","kind":"wai\n');
    await recordVerdict(repo, { findingId: 'good2', kind: 'reject', file: 'b.ts', line: 2, title: 'second' }, config);

    const ids = (await readVerdicts(repo, config)).map((v) => v.findingId).sort();
    expect(ids).toEqual(['good1', 'good2']); // not [] — the corrupt line is dropped, the rest survive
  });

  it('loadWaivers survives a corrupt verdict line (suppressions are not silently wiped)', async () => {
    await recordVerdict(repo, { findingId: 'w', kind: 'waive', scope: 'line', file: 'src/x.ts', line: 9, title: 'kept waiver' }, config);
    appendFileSync(repoPaths(repo, config.dataDir).verdictsFile, 'not json at all\n');
    const titles = (await loadWaivers(repo, config)).map((w) => w.title);
    expect(titles).toContain('kept waiver');
  });
});

describe('loadWaivers (which verdicts suppress the same finding next round)', () => {
  it('suppresses waive, acknowledge, and reject — but never accept', async () => {
    await recordVerdict(repo, { findingId: 'w', kind: 'waive', scope: 'line', file: 'a.ts', line: 1, title: 'waived issue' }, config);
    await recordVerdict(repo, { findingId: 'k', kind: 'acknowledge', file: 'b.ts', line: 2, title: 'acknowledged flag' }, config);
    await recordVerdict(repo, { findingId: 'r', kind: 'reject', file: 'c.ts', line: 3, title: 'rejected nit' }, config);
    await recordVerdict(repo, { findingId: 'a', kind: 'accept', file: 'd.ts', line: 4, title: 'accepted bug' }, config);

    const titles = (await loadWaivers(repo, config)).map((w) => w.title).sort();
    // reject now suppresses too, so a dismissed finding stops re-surfacing; accept never suppresses.
    expect(titles).toEqual(['acknowledged flag', 'rejected nit', 'waived issue']);
  });

  it('carries a rejected finding identity through as a suppressor (locality re-match)', async () => {
    // The exact case from review feedback: a deterministic await-in-loop the author rejected as
    // intentional should NOT re-surface every round just because codified checks recompute.
    await recordVerdict(repo, { findingId: 'r', kind: 'reject', scope: 'line', file: 'src/seed.ts', line: 12, title: 'await in loop' }, config);
    const w = (await loadWaivers(repo, config)).find((x) => x.title === 'await in loop');
    expect(w).toMatchObject({ file: 'src/seed.ts', line: 12, scope: 'line' });
  });

  it('item 2: a scope-less REJECT defaults to `line` (instance) — never `file` — so it cannot bury siblings', async () => {
    // C1 (ADR-39): one reject must silence only the exact finding, not every finding in the file.
    await recordVerdict(repo, { findingId: 'r', kind: 'reject', file: 'src/a.ts', line: 42, title: 'leftover console' }, config);
    await recordVerdict(repo, { findingId: 'w', kind: 'waive', file: 'src/a.ts', line: 7, title: 'false positive' }, config);
    const byTitle = Object.fromEntries((await loadWaivers(repo, config)).map((w) => [w.title, w]));
    expect(byTitle['leftover console']!.scope).toBe('line'); // reject → instance-only
    expect(byTitle['false positive']!.scope).toBe('file'); // waive keeps the broader default
  });
});
