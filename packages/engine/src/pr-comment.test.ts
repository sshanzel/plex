import { describe, it, expect } from 'vitest';
import type { RankedFinding, LineRange, Severity, FindingSource } from '@plex/core';
import { buildReviewPayload } from './pr-comment';
import type { BrainFinding } from './brain';

let n = 0;
const mk = (over: {
  title?: string;
  severity?: Severity;
  triage?: RankedFinding['triage'];
  file?: string;
  line?: number;
  body?: string;
  source?: FindingSource;
} = {}): RankedFinding => {
  n++;
  return {
    id: `f${n}`,
    title: over.title ?? `finding ${n}`,
    body: over.body ?? '',
    severity: over.severity ?? 'bug',
    confidence: 0.8,
    source: over.source ?? 'first-principles',
    location: { repo: 'r', file: over.file ?? 'src/a.ts', startLine: over.line ?? 10, endLine: over.line ?? 10 },
    signal: 0.5,
    agreedSources: ['first-principles'],
    triage: over.triage ?? 'surface',
  };
};

const changed = (m: Record<string, LineRange[]>): Map<string, LineRange[]> => new Map(Object.entries(m));
const base = {
  priorFindings: [] as BrainFinding[],
  changed: changed({ 'src/a.ts': [{ start: 1, end: 50 }] }),
  skipNits: false,
  round: 1,
};

describe('buildReviewPayload', () => {
  it('inlines a finding that lands on a changed line', () => {
    const p = buildReviewPayload([mk({ title: 'Null deref', file: 'src/a.ts', line: 10 })], base);
    expect(p.count).toBe(1);
    expect(p.comments).toHaveLength(1);
    expect(p.comments[0]).toMatchObject({ path: 'src/a.ts', line: 10 });
    expect(p.comments[0]!.body).toContain('[bug]');
  });

  it('folds a finding NOT on a changed line into the summary body (coupled/blast-radius)', () => {
    const p = buildReviewPayload([mk({ title: 'Coupled risk', file: 'src/other.ts', line: 5 })], base);
    expect(p.comments).toHaveLength(0); // other.ts not in the diff
    expect(p.body).toContain('Coupled / not on changed lines');
    expect(p.body).toContain('Coupled risk');
    expect(p.count).toBe(1);
  });

  it('never posts suppressed/waived findings', () => {
    const p = buildReviewPayload([mk({ title: 'waived', triage: 'suppressed', line: 10 })], base);
    expect(p.count).toBe(0);
    expect(p.comments).toHaveLength(0);
  });

  it('posts nits by default, skips them only when skipNits is set', () => {
    const nit = [mk({ title: 'prefer const', severity: 'nit', line: 10 })];
    expect(buildReviewPayload(nit, base).count).toBe(1);
    expect(buildReviewPayload(nit, { ...base, skipNits: true }).count).toBe(0);
  });

  it('routes awareness findings to the "worth confirming" section, not inline', () => {
    const p = buildReviewPayload([mk({ title: 'two emit sites', severity: 'awareness', line: 10 })], base);
    expect(p.comments).toHaveLength(0);
    expect(p.body).toContain('Worth confirming');
    expect(p.body).toContain('two emit sites');
  });

  it('dedups against prior rounds — only findings new this round are posted', () => {
    const prior: BrainFinding[] = [{ id: 'x', file: 'src/a.ts', line: 10, title: 'Null deref' }];
    const p = buildReviewPayload(
      [mk({ title: 'Null deref', file: 'src/a.ts', line: 10 }), mk({ title: 'New one', file: 'src/a.ts', line: 20 })],
      { ...base, priorFindings: prior, round: 2 },
    );
    expect(p.count).toBe(1); // 'Null deref' was posted last round
    expect(p.comments).toHaveLength(1);
    expect(p.comments[0]!.body).toContain('New one');
  });
});
