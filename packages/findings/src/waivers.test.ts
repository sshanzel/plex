import { describe, it, expect } from 'vitest';
import type { Finding, Waiver } from '@plex/core';
import { waiverMatches, isWaived } from './waivers';
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
