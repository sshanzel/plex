import { describe, it, expect } from 'vitest';
import type { Finding, FindingSource, Severity, Waiver } from '@plex/core';
import { rankFindings, type LearnedSuppression } from './rank';
import { dedupeFindings } from './dedupe';
import { computeSignal } from './signal';

let n = 0;
function mk(over: Partial<Finding> & { severity?: Severity; source?: FindingSource } = {}): Finding {
  n++;
  return {
    id: over.id ?? `f${n}`,
    title: over.title ?? `finding ${n}`,
    body: over.body ?? '',
    severity: over.severity ?? 'bug',
    confidence: over.confidence ?? 0.8,
    source: over.source ?? 'first-principles',
    location: over.location ?? { repo: 'r', file: 'src/a.ts', startLine: 10, endLine: 12 },
    ...over,
  };
}

describe('dedupeFindings', () => {
  it('merges same-issue findings across sources and corroborates confidence', () => {
    const merged = dedupeFindings([
      mk({ title: 'Null deref on user', source: 'first-principles', confidence: 0.6, severity: 'improvement' }),
      mk({ title: 'null deref on  user!', source: 'deterministic', confidence: 0.7, severity: 'bug' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.agreedSources.sort()).toEqual(['deterministic', 'first-principles']);
    expect(merged[0]!.severity).toBe('bug');
    expect(merged[0]!.confidence).toBeCloseTo(1 - 0.4 * 0.3, 5);
  });
});

describe('computeSignal', () => {
  it('ranks a confident bug above a confident nit', () => {
    const bug = computeSignal(mk({ severity: 'bug', confidence: 0.9 }), 1);
    const nit = computeSignal(mk({ severity: 'nit', confidence: 0.9 }), 1);
    expect(bug).toBeGreaterThan(nit);
  });
  it('does not let prevalence demote a bug, but does demote a nit', () => {
    const commonBug = computeSignal(mk({ severity: 'bug', prevalence: 0.9 }), 1);
    const rareBug = computeSignal(mk({ severity: 'bug', prevalence: 0 }), 1);
    expect(commonBug).toBeCloseTo(rareBug, 5);
    const commonNit = computeSignal(mk({ severity: 'nit', prevalence: 0.9 }), 1);
    const rareNit = computeSignal(mk({ severity: 'nit', prevalence: 0 }), 1);
    expect(commonNit).toBeLessThan(rareNit);
  });
  it('boosts signal when multiple sources agree', () => {
    const f = mk({ severity: 'bug', confidence: 0.7 });
    expect(computeSignal(f, 3)).toBeGreaterThan(computeSignal(f, 1));
  });
});

describe('rankFindings triage', () => {
  it('escalates a common bug to systemic-migration and demotes a common nit to convention', () => {
    const ranked = rankFindings([
      mk({ id: 'b', title: 'missing tenant filter', severity: 'bug', prevalence: 0.9, location: { repo: 'r', file: 'q.ts', startLine: 1, endLine: 1 } }),
      mk({ id: 'n', title: 'prefer const', severity: 'nit', prevalence: 0.9, location: { repo: 'r', file: 's.ts', startLine: 1, endLine: 1 } }),
    ]);
    expect(ranked.find((f) => f.id === 'b')!.triage).toBe('systemic-migration');
    expect(ranked.find((f) => f.id === 'n')!.triage).toBe('convention');
  });

  it('learned suppression: a rule tagged `suppress` → suppressed, `demote` → demoted (still visible)', () => {
    const suppressions = new Map<string, LearnedSuppression>([
      ['no-console', { tier: 'demote', repoWide: true }],
      ['no-await-in-loop', { tier: 'suppress', repoWide: true }],
    ]);
    const ranked = rankFindings(
      [
        mk({ id: 'keep', severity: 'nit', tags: ['no-loose-equality'], location: { repo: 'r', file: 'a.ts', startLine: 1, endLine: 1 } }),
        mk({ id: 'demoted', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'b.ts', startLine: 1, endLine: 1 } }),
        mk({ id: 'gone', severity: 'improvement', tags: ['no-await-in-loop'], location: { repo: 'r', file: 'c.ts', startLine: 1, endLine: 1 } }),
      ],
      { suppressions },
    );
    expect(ranked.find((f) => f.id === 'keep')!.triage).toBe('surface');
    expect(ranked.find((f) => f.id === 'demoted')!.triage).toBe('demoted');
    expect(ranked.find((f) => f.id === 'gone')!.triage).toBe('suppressed');
    // demoted sits below surface but above suppressed.
    expect(ranked.map((f) => f.id)).toEqual(['keep', 'demoted', 'gone']);
  });

  it('an explicit waiver still wins over a learned demote', () => {
    const ranked = rankFindings(
      [mk({ id: 'x', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'legacy.ts', startLine: 1, endLine: 1 } })],
      { suppressions: new Map([['no-console', { tier: 'demote', repoWide: true }]]), waivers: [{ scope: 'file', file: 'legacy.ts' }] },
    );
    expect(ranked[0]!.triage).toBe('suppressed'); // hard waiver, not the softer demote
  });

  it('location-scoped suppression: suppresses only at the dismissed symbol, surfaces the same rule elsewhere (ADR-48)', () => {
    // `no-console` was dismissed at src/cli.ts#run — that ONE instance should stay quiet, but a
    // console.log at a different symbol must still surface (the rule didn't become a repo-wide weight).
    const suppressions = new Map<string, LearnedSuppression>([
      ['no-console', { tier: 'suppress', repoWide: false, symbols: new Set(['src/cli.ts#run']) }],
    ]);
    const ranked = rankFindings(
      [
        mk({ id: 'dismissed', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'src/cli.ts', startLine: 5, endLine: 5, symbol: 'run' } }),
        mk({ id: 'elsewhere', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'src/api.ts', startLine: 9, endLine: 9, symbol: 'handler' } }),
        mk({ id: 'nosymbol', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'src/cli.ts', startLine: 40, endLine: 40 } }),
      ],
      { suppressions },
    );
    expect(ranked.find((f) => f.id === 'dismissed')!.triage).toBe('suppressed');
    expect(ranked.find((f) => f.id === 'elsewhere')!.triage).toBe('surface'); // different symbol → still surfaces
    expect(ranked.find((f) => f.id === 'nosymbol')!.triage).toBe('surface'); // no symbol to match → not suppressed
  });

  it('a repoWide decision suppresses every instance of the rule (back-compat)', () => {
    const suppressions = new Map<string, LearnedSuppression>([['no-console', { tier: 'suppress', repoWide: true }]]);
    const ranked = rankFindings(
      [
        mk({ id: 'a', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'src/cli.ts', startLine: 5, endLine: 5, symbol: 'run' } }),
        mk({ id: 'b', severity: 'nit', tags: ['no-console'], location: { repo: 'r', file: 'src/api.ts', startLine: 9, endLine: 9, symbol: 'handler' } }),
      ],
      { suppressions },
    );
    expect(ranked.every((f) => f.triage === 'suppressed')).toBe(true);
  });

  it('suppresses waived findings and sorts them last', () => {
    const waivers: Waiver[] = [{ scope: 'file', file: 'src/legacy.ts' }];
    const ranked = rankFindings(
      [
        mk({ id: 'keep', severity: 'bug', confidence: 0.9, location: { repo: 'r', file: 'src/a.ts', startLine: 5, endLine: 5 } }),
        mk({ id: 'waived', severity: 'bug', confidence: 0.9, location: { repo: 'r', file: 'src/legacy.ts', startLine: 5, endLine: 5 } }),
      ],
      { waivers },
    );
    expect(ranked.find((f) => f.id === 'waived')!.triage).toBe('suppressed');
    expect(ranked[ranked.length - 1]!.id).toBe('waived');
    expect(ranked[0]!.id).toBe('keep');
  });

  it('orders surfaced findings by signal (bug before nit)', () => {
    const ranked = rankFindings([
      mk({ id: 'nit', title: 'x', severity: 'nit', confidence: 0.9, location: { repo: 'r', file: 'a.ts', startLine: 1, endLine: 1 } }),
      mk({ id: 'bug', title: 'y', severity: 'bug', confidence: 0.9, location: { repo: 'r', file: 'b.ts', startLine: 1, endLine: 1 } }),
    ]);
    expect(ranked[0]!.id).toBe('bug');
  });

  it('strips the transient embedding from the returned stream (no vector leaks to consumers)', () => {
    const [out] = rankFindings([mk({ id: 'e', severity: 'bug', embedding: [0.11, 0.22, 0.33] })]);
    expect(out!.id).toBe('e');
    expect('embedding' in out!).toBe(false); // the ~1KB-16KB vector must not reach the agent/brain
  });

  it('still suppresses semantically via the embedding before it is stripped', () => {
    // The embedding is consumed by isWaived (semantic match) BEFORE the strip — proving the strip
    // doesn't break suppression. A category waiver carrying a matching vector suppresses the finding.
    const waivers: Waiver[] = [{ scope: 'category-global', embedding: [1, 0, 0] }];
    const ranked = rankFindings(
      [mk({ id: 'sem', severity: 'bug', embedding: [1, 0, 0] })],
      { waivers, semanticThreshold: 0.9 },
    );
    expect(ranked[0]!.triage).toBe('suppressed'); // matched via cosine ≥ 0.9
    expect('embedding' in ranked[0]!).toBe(false); // …and the vector still didn't leak out
  });
});
