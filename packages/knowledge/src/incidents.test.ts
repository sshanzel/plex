import { describe, it, expect } from 'vitest';
import type { Incident } from '@plex/core';
import { migrateIncidentAnchors } from './incidents';

const inc = (over: Partial<Incident>): Incident => ({ id: 'inc:x:h:t', source: 'review', ts: '2026-01-01', ...over });

describe('migrateIncidentAnchors', () => {
  const renames = new Map([['src/old.ts', 'src/new.ts']]);

  it('re-anchors file + symbol to the new path but keeps id/pitfallId', () => {
    const before = inc({ id: 'inc:src-old-ts:abc:1', pitfallId: 'pf:1', file: 'src/old.ts', symbol: 'src/old.ts#fn' });
    const { incidents, changed } = migrateIncidentAnchors([before], renames);
    expect(changed).toBe(true);
    expect(incidents[0]).toMatchObject({
      id: 'inc:src-old-ts:abc:1', // slug in the id is cosmetic — left as-is so provenance links survive
      pitfallId: 'pf:1',
      file: 'src/new.ts',
      symbol: 'src/new.ts#fn',
    });
  });

  it('preserves the FULL set and reports changed:false when nothing matched', () => {
    const others = [inc({ file: 'src/keep.ts' }), inc({ symbol: 'src/keep.ts#g' })];
    const { incidents, changed } = migrateIncidentAnchors(others, renames);
    expect(changed).toBe(false);
    expect(incidents).toHaveLength(2);
    expect(incidents).toEqual(others);
  });

  it('rewrites only the renamed incident within a mixed set', () => {
    const set = [inc({ file: 'src/old.ts' }), inc({ file: 'src/keep.ts' })];
    const { incidents, changed } = migrateIncidentAnchors(set, renames);
    expect(changed).toBe(true);
    expect(incidents.map((i) => i.file)).toEqual(['src/new.ts', 'src/keep.ts']);
  });
});
