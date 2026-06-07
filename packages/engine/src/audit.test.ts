import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveConfig, type RankedFinding, type ReviewerConfig } from '@plex/core';
import { logAudit, readAudit, auditFinding, type FindingsSubmittedEvent } from './audit';
import { repoPaths } from './paths';

// audit.ts is pure fs/path (no Kùzu) → vitest-safe. The append-only log underpins
// attribution (ADR-24); a single corrupt line must not drop the whole trail.
let root: string;
let config: ReviewerConfig;
const repo = '/some/repo'; // logical repo path; data lands under the absolute dataDir root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plex-audit-'));
  config = resolveConfig({ dataDir: root }); // absolute dataDir → <root>/<repoId>/log/events.jsonl
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const evt = (over: Partial<FindingsSubmittedEvent> = {}): FindingsSubmittedEvent => ({
  type: 'findings_submitted',
  repo: 'r',
  target: 'r__staged',
  round: 1,
  ts: '2026-01-01T00:00:00Z',
  findings: [],
  ...over,
});

describe('auditFinding', () => {
  it('flattens a ranked finding to the event row (line = startLine, file = location.file)', () => {
    const f = {
      id: 'x',
      title: 'Null deref',
      body: '',
      source: 'first-principles',
      severity: 'bug',
      confidence: 0.7,
      signal: 0.42,
      location: { repo: 'r', file: 'src/a.ts', startLine: 12, endLine: 20 },
      triage: 'surface',
    } as RankedFinding;
    expect(auditFinding(f)).toEqual({
      title: 'Null deref',
      source: 'first-principles',
      severity: 'bug',
      confidence: 0.7,
      signal: 0.42,
      file: 'src/a.ts',
      line: 12,
      triage: 'surface',
    });
  });
});

describe('logAudit / readAudit', () => {
  it('returns [] when no log exists yet', async () => {
    expect(await readAudit(repo, config)).toEqual([]);
  });

  it('round-trips appended events in order', async () => {
    await logAudit(repo, config, evt({ round: 1 }));
    await logAudit(repo, config, evt({ round: 2 }));
    const got = await readAudit(repo, config);
    expect(got.map((e) => e.round)).toEqual([1, 2]);
  });

  it('keeps valid events when one line is corrupt', async () => {
    await logAudit(repo, config, evt({ round: 1 }));
    const logFile = repoPaths(repo, config.dataDir).logFile;
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, '{"type":"findings_submitted","round":2,\n'); // truncated line
    await logAudit(repo, config, evt({ round: 3 }));
    expect((await readAudit(repo, config)).map((e) => e.round)).toEqual([1, 3]);
  });

  it('logAudit never throws even if the log path cannot be created', async () => {
    // Point the data dir at a path under a regular FILE so mkdir fails — must be swallowed.
    const filePath = join(root, 'afile');
    appendFileSync(filePath, 'x');
    const bad = resolveConfig({ dataDir: join(filePath, 'nested') });
    await expect(logAudit(repo, bad, evt())).resolves.toBeUndefined();
  });
});
