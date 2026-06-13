import { describe, it, expect } from 'vitest';
import { HEAL_RELABEL_ORDER, recordableHeadSha, priorRoundHeadSha, OUTCOME_BY_KIND, projectableOutcome } from './guards';

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

// #2 + PR #10 review: never persist a round with an empty headSha (poisons the next anchor), but
// carry the last anchor forward rather than skipping outright (a skipped round drops comments + fakes
// the heal split-signature). Skip only when there's no prior anchor at all.
describe('recordableHeadSha', () => {
  it('records the current head when it resolves', () => {
    expect(recordableHeadSha('abc123', 'old')).toBe('abc123');
  });
  it('carries the last anchor forward when the current head is empty/whitespace/missing', () => {
    expect(recordableHeadSha('', 'lastsha')).toBe('lastsha');
    expect(recordableHeadSha('   ', 'lastsha')).toBe('lastsha');
    expect(recordableHeadSha(undefined, 'lastsha')).toBe('lastsha');
  });
  it('returns "" (skip) only when neither a current nor a prior anchor exists', () => {
    expect(recordableHeadSha('', undefined)).toBe('');
    expect(recordableHeadSha(undefined, '')).toBe('');
  });
});

// PR #10 review / Linux brain-check flake: attribution anchors on the PRIOR round's head, so a
// crash-retry that already recorded the current round reproduces the same signal (idempotent) instead
// of comparing the head to itself.
describe('priorRoundHeadSha', () => {
  const rounds = [{ n: 1, headSha: 'h1' }, { n: 2, headSha: 'h2' }, { n: 3, headSha: 'h3' }];
  it('returns the head of the round before the given round number', () => {
    expect(priorRoundHeadSha(rounds, 4)).toBe('h3'); // a fresh round → previous latest
    expect(priorRoundHeadSha(rounds, 3)).toBe('h2'); // a same-head replay of round 3 → still round 2's head
    expect(priorRoundHeadSha(rounds, 2)).toBe('h1');
  });
  it('is undefined for the first round / when no prior round exists', () => {
    expect(priorRoundHeadSha(rounds, 1)).toBeUndefined();
    expect(priorRoundHeadSha([], 1)).toBeUndefined();
  });
  it('replaying an already-recorded round yields the SAME anchor as the first attempt (idempotent)', () => {
    const first = priorRoundHeadSha([{ n: 1, headSha: 'init' }], 2); // first attempt at round 2
    const replay = priorRoundHeadSha([{ n: 1, headSha: 'init' }, { n: 2, headSha: 'h2' }], 2); // round 2 already recorded
    expect(first).toBe('init');
    expect(replay).toBe('init'); // NOT 'h2' — the dropped-signal bug
  });
  it('tolerates gaps and unordered input (picks the highest n below round)', () => {
    expect(priorRoundHeadSha([{ n: 3, headSha: 'h3' }, { n: 1, headSha: 'h1' }], 5)).toBe('h3');
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
