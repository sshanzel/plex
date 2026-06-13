import { describe, it, expect } from 'vitest';
import type { Finding, Waiver } from '@plex/core';
import { waiverMatches, isWaived, firedSemanticSuppressions } from './waivers';
import { rankFindings } from './rank';

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f',
  title: 'Analytics event fires twice on mount',
  body: '',
  severity: 'bug',
  confidence: 0.6,
  source: 'first-principles',
  location: { repo: 'r', file: 'src/venue.tsx', startLine: 42, endLine: 42 },
  ...over,
});

describe('semantic waiver matching (ADR-27)', () => {
  it('a pattern-repo waiver suppresses the same issue by meaning, despite reworded title + moved line', () => {
    const w: Waiver = { scope: 'pattern-repo', title: 'venue_opened double-fire', embedding: [1, 0, 0] };
    // reworded title, different line — identity match would fail; semantic should catch it.
    const f = finding({ title: 'Double analytics emit when the screen re-renders', location: { repo: 'r', file: 'src/venue.tsx', startLine: 87, endLine: 90 }, embedding: [0.96, 0.05, 0] });
    expect(waiverMatches(f, w, 0.82)).toBe(true);
  });

  it('does not suppress a semantically different finding', () => {
    const w: Waiver = { scope: 'pattern-repo', title: 'venue_opened double-fire', embedding: [1, 0, 0] };
    const f = finding({ title: 'Missing null check on user', embedding: [0, 0, 1] });
    expect(waiverMatches(f, w, 0.82)).toBe(false);
  });

  it('semantic does NOT loosen precise (line/file) scopes', () => {
    const w: Waiver = { scope: 'line', file: 'src/venue.tsx', line: 42, embedding: [1, 0, 0] };
    const moved = finding({ location: { repo: 'r', file: 'src/venue.tsx', startLine: 99, endLine: 99 }, embedding: [1, 0, 0] });
    expect(waiverMatches(moved, w, 0.82)).toBe(false); // line scope stays exact
  });

  it('is off by default (no threshold) — pure identity behavior preserved', () => {
    const w: Waiver = { scope: 'pattern-repo', title: 'venue_opened double-fire', embedding: [1, 0, 0] };
    const f = finding({ title: 'totally different wording', embedding: [1, 0, 0] });
    expect(isWaived(f, [w])).toBe(false); // default threshold disables semantic
  });

  it('ranks a semantically-waived finding into the suppressed bucket', () => {
    const w: Waiver = { scope: 'pattern-repo', title: 'x', embedding: [1, 0, 0] };
    const f = finding({ title: 'reworded', embedding: [0.95, 0.05, 0] });
    const [r] = rankFindings([f], { waivers: [w], semanticThreshold: 0.82 });
    expect(r!.triage).toBe('suppressed');
  });
});

describe('firedSemanticSuppressions — audit attribution (ADR-41)', () => {
  // Embedding-keyed suppression decisions (their `key` is the negative pitfall id, not a tag).
  const decision = (key: string, embedding: number[]) => ({ key, tier: 'suppress' as const, embedding });

  it('returns only the semantic suppressions that matched a finding (the ones that shaped output)', () => {
    const fired = decision('neg:r:fp:abc', [1, 0, 0]); // matches the finding below
    const dormant = decision('neg:r:fp:xyz', [0, 0, 1]);
    const f = finding({ embedding: [0.96, 0.05, 0] });
    const applied = firedSemanticSuppressions([fired, dormant], [f], 0.82);
    expect(applied.map((d) => d.key)).toEqual(['neg:r:fp:abc']);
  });

  it('attributes consistently with the ranking — a finding it suppresses is the one it audits', () => {
    const d = decision('neg:r:fp:abc', [1, 0, 0]);
    const f = finding({ title: 'reworded', embedding: [0.95, 0.05, 0] });
    // The synthetic pattern-repo waiver this decision becomes suppresses f in the ranker…
    const [r] = rankFindings([f], { waivers: [{ scope: 'pattern-repo', embedding: d.embedding }], semanticThreshold: 0.82 });
    expect(r!.triage).toBe('suppressed');
    // …and the same predicate attributes it in the audit trail.
    expect(firedSemanticSuppressions([d], [f], 0.82)).toHaveLength(1);
  });

  it('a decision with no embedding, or below threshold, is not audited', () => {
    const noEmbed = { key: 'neg:r:fp:k', tier: 'suppress' as const, embedding: undefined as number[] | undefined };
    const below = decision('neg:r:fp:m', [0, 1, 0]);
    const f = finding({ embedding: [0.96, 0.05, 0] });
    expect(firedSemanticSuppressions([noEmbed, below], [f], 0.82)).toEqual([]);
  });
});

describe('awareness flags + acknowledge (ADR-31)', () => {
  it('an awareness finding surfaces in its own bucket — never suppressed by default, never a nit', () => {
    const f = finding({ severity: 'awareness', title: 'two playright_booking_payment_confirmed sites' });
    const [r] = rankFindings([f], {});
    expect(r!.triage).toBe('awareness');
  });

  it('an acknowledge (semantic waiver) suppresses the same flag going forward', () => {
    const ack: Waiver = { scope: 'pattern-repo', title: 'two payment sites', embedding: [1, 0, 0] };
    const f = finding({ severity: 'awareness', title: 'two payment-confirmed sites — intentional', embedding: [0.96, 0.04, 0] });
    const [r] = rankFindings([f], { waivers: [ack], semanticThreshold: 0.82 });
    expect(r!.triage).toBe('suppressed');
  });

  it('a materially changed flag (a 3rd site → different content) re-surfaces past the acknowledge', () => {
    const ack: Waiver = { scope: 'pattern-repo', title: 'two payment sites', embedding: [1, 0, 0] };
    const f = finding({ severity: 'awareness', title: 'now THREE payment-confirmed sites', embedding: [0.2, 0.9, 0.1] });
    const [r] = rankFindings([f], { waivers: [ack], semanticThreshold: 0.82 });
    expect(r!.triage).toBe('awareness'); // not suppressed — situation changed
  });
});
