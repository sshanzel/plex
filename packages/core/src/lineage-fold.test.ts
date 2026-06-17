import { describe, it, expect } from 'vitest';
import { foldLineage, parseLineageEvents, type LineageEvent } from './lineage-fold';

const finding = (id: string, over: Partial<Extract<LineageEvent, { k: 'finding' }>> = {}): LineageEvent => ({
  k: 'finding', target: 't', id, title: 'bug', severity: 'bug', confidence: 0.5, signal: 1, source: 'first-principles',
  file: 'a.ts', line: 10, triage: 'show', round: 1, blast: 0, prevalence: 0, agreement: 1, rule: '', symbol: '', ...over,
});

describe('foldLineage', () => {
  it('last finding event wins for fields; rounds LWW by n, sorted', () => {
    const v = foldLineage([
      { k: 'round', target: 't', n: 1, ts: 't1', headSha: 'aaa', baseRef: 'main' },
      { k: 'round', target: 't', n: 2, ts: 't2', headSha: 'bbb', baseRef: 'main' },
      finding('f1', { round: 1, triage: 'show' }),
      finding('f1', { round: 2, triage: 'demote' }), // re-raised
    ]);
    expect(v.rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]).toMatchObject({ id: 'f1', round: 2, triage: 'demote' });
  });

  it('outcome is orthogonal — a re-raised finding never resets a recorded outcome (ADR-28)', () => {
    const v = foldLineage([
      finding('f1'),
      { k: 'outcome', target: 't', findingId: 'f1', outcome: 'fixed' },
      finding('f1', { round: 3 }), // re-raised AFTER the outcome
    ]);
    expect(v.outcomeOf('f1')).toBe('fixed'); // not cleared by the later finding event
    expect(v.findings[0].round).toBe(3); // other fields still updated
    expect(v.outcomeOf('nope')).toBe(''); // unknown → empty
  });

  it('verdicts key by findingId (last wins)', () => {
    const v = foldLineage([
      { k: 'verdict', target: 't', findingId: 'f1', kind: 'waive', scope: '', ts: 't1', title: 'x', file: 'a.ts', line: 1 },
      { k: 'verdict', target: 't', findingId: 'f1', kind: 'accept', scope: '', ts: 't2', title: 'x', file: 'a.ts', line: 1 },
    ]);
    expect(v.verdicts).toHaveLength(1);
    expect(v.verdicts[0].kind).toBe('accept');
  });

  it('parseLineageEvents skips a torn final line, keeps the rest', () => {
    const body = JSON.stringify(finding('f1')) + '\n' + '{"k":"finding",broken';
    const events = parseLineageEvents(body);
    expect(events).toHaveLength(1);
    expect(foldLineage(events).findings).toHaveLength(1);
  });
});
