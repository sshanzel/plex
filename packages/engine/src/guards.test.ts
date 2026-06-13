import { describe, it, expect } from 'vitest';
import { HEAL_RELABEL_ORDER, shouldRecordRound, OUTCOME_BY_KIND, projectableOutcome } from './guards';

// #6: healSplitTarget re-keys 4 labels with no transaction. Round MUST be last so a partial-crash brain
// still reads as "split" (findings, no own rounds) and the next run finishes the migration.
describe('HEAL_RELABEL_ORDER (crash-safety of the split-target heal)', () => {
  it('re-keys Round LAST so a mid-migration crash stays detectable + re-healable', () => {
    expect(HEAL_RELABEL_ORDER[HEAL_RELABEL_ORDER.length - 1]).toBe('Round');
  });
  it('covers exactly the four brain node labels, once each', () => {
    expect([...HEAL_RELABEL_ORDER].sort()).toEqual(['Comment', 'Finding', 'Round', 'Verdict']);
  });
});

// #2: never persist a round with an empty headSha — it poisons the next round's lastHeadSha and kills
// fix-inference + reconcile (both key off it).
describe('shouldRecordRound', () => {
  it('records a round only when a real headSha is present', () => {
    expect(shouldRecordRound('abc123')).toBe(true);
  });
  it('refuses an empty / whitespace / missing headSha (a git failure that survived retry)', () => {
    expect(shouldRecordRound('')).toBe(false);
    expect(shouldRecordRound('   ')).toBe(false);
    expect(shouldRecordRound(undefined)).toBe(false);
  });
});

// #4: an empty findingId must not be projected — markFindingOutcome('') is a silent no-op MATCH that
// leaves the finding open to be re-accepted and double-counted.
describe('projectableOutcome', () => {
  it('maps each known verdict kind to its brain outcome when the findingId is present', () => {
    expect(projectableOutcome('accept', 'f1')).toBe('accepted');
    expect(projectableOutcome('reject', 'f1')).toBe('rejected');
    expect(projectableOutcome('waive', 'f1')).toBe('waived');
    expect(projectableOutcome('acknowledge', 'f1')).toBe('acknowledged');
    expect(OUTCOME_BY_KIND.accept).toBe('accepted');
  });
  it('returns null (skip the no-op write) for an empty or missing findingId', () => {
    expect(projectableOutcome('accept', '')).toBeNull();
    expect(projectableOutcome('reject', undefined)).toBeNull();
  });
  it('returns null for an unknown kind even with a valid findingId', () => {
    expect(projectableOutcome('bogus', 'f1')).toBeNull();
  });
});
