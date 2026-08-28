import { describe, it, expect } from 'vitest';
import type { NormalizedDiff, DiffFile } from '@plex/core';
import { renameMapFromDiff } from './rename-migrate';
import { migrateWaiverAnchors, type StoredVerdict } from './verdicts';

const file = (over: Partial<DiffFile>): DiffFile => ({ path: 'x', status: 'modified', hunks: [], ...over });
const diff = (files: DiffFile[]): NormalizedDiff => ({ baseRef: 'HEAD', files });

describe('renameMapFromDiff', () => {
  it('maps only renamed files (old→new), ignoring adds/mods and no-op renames', () => {
    const m = renameMapFromDiff(
      diff([
        file({ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }),
        file({ path: 'src/mod.ts', status: 'modified' }),
        file({ path: 'src/same.ts', oldPath: 'src/same.ts', status: 'renamed' }), // degenerate, skipped
      ]),
    );
    expect([...m]).toEqual([['src/old.ts', 'src/new.ts']]);
  });

  it('is empty when nothing was renamed', () => {
    expect(renameMapFromDiff(diff([file({ path: 'a.ts' })])).size).toBe(0);
  });
});

describe('migrateWaiverAnchors', () => {
  const renames = new Map([['src/old.ts', 'src/new.ts']]);
  const v = (over: Partial<StoredVerdict>): StoredVerdict => ({ findingId: 'f', kind: 'waive', ts: '2026-01-01', ...over });

  it('re-anchors file + symbol to the new path', () => {
    const { verdicts, changed } = migrateWaiverAnchors([v({ file: 'src/old.ts', symbol: 'src/old.ts#fn' })], renames);
    expect(changed).toBe(true);
    expect(verdicts[0]).toMatchObject({ file: 'src/new.ts', symbol: 'src/new.ts#fn' });
  });

  it('preserves the full set and reports changed:false when nothing matched', () => {
    const set = [v({ file: 'src/keep.ts' }), v({ symbol: 'src/keep.ts#g' })];
    const { verdicts, changed } = migrateWaiverAnchors(set, renames);
    expect(changed).toBe(false);
    expect(verdicts).toEqual(set);
  });

  it('is idempotent — a second pass over already-migrated anchors is a no-op', () => {
    const once = migrateWaiverAnchors([v({ file: 'src/old.ts', symbol: 'src/old.ts#fn' })], renames);
    const twice = migrateWaiverAnchors(once.verdicts, renames);
    expect(twice.changed).toBe(false);
    expect(twice.verdicts).toEqual(once.verdicts);
  });
});
