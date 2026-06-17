import { describe, it, expect } from 'vitest';
import type { Finding } from '@plex/core';
import { rankFindings } from './rank';
import { rankingNdcg } from './eval';

/**
 * RANKING QUALITY FLOOR — a fixed, labeled benchmark (docs/design/evals.md).
 *
 * The 303 unit tests pin *behavior*; this pins *quality*: a diverse corpus of findings with
 * ground-truth outcomes (what a user accepted/fixed vs rejected) is ranked by the REAL
 * pipeline, and the resulting nDCG must clear a floor. A formula tweak that quietly inverts
 * useful orderings (confidence ignored, severity collapsed, prevalence silencing bugs…)
 * fails HERE even if every behavior test still passes.
 *
 * The floor is set ~0.05 below the measured value at the time the corpus was written — it
 * absorbs small intentional re-weights but catches structural regressions. If you IMPROVE
 * ranking and the score rises, ratchet the floor up with it (and say so in the commit).
 */

const F = (over: Partial<Finding> & { id: string; title: string }): Finding => ({
  body: '',
  severity: 'bug',
  confidence: 0.8,
  source: 'first-principles',
  location: { repo: 'r', file: over.id + '.ts', startLine: 10, endLine: 12 },
  ...over,
});

// Ground truth: what a sensible reviewer's verdicts were. accepted/fixed = real (rel 2),
// acknowledged = worth raising (rel 1), rejected = noise (rel 0).
const CORPUS: { finding: Finding; outcome: string }[] = [
  { outcome: 'accepted', finding: F({ id: 'inj', title: 'SQL built by string concatenation from request input', severity: 'bug', confidence: 0.9, blastRadius: 0.8 }) },
  { outcome: 'fixed', finding: F({ id: 'race', title: 'concurrent writes to the session map may race under load', severity: 'bug', confidence: 0.45, blastRadius: 0.6 }) }, // potential bug: high severity, honest low confidence
  { outcome: 'accepted', finding: F({ id: 'swallow', title: 'catch block swallows the migration error silently', severity: 'improvement', confidence: 0.85, blastRadius: 0.3 }) },
  { outcome: 'fixed', finding: F({ id: 'systemic', title: 'date parsed with the local timezone in every report module', severity: 'bug', confidence: 0.8, prevalence: 0.7, blastRadius: 0.4 }) }, // common BUG → systemic, never silenced
  // corroborated across sources (dedupe merges these two into one finding)
  { outcome: 'accepted', finding: F({ id: 'loop', title: 'await inside the export loop serializes uploads', severity: 'improvement', confidence: 0.7, location: { repo: 'r', file: 'loop.ts', startLine: 5, endLine: 5 } }) },
  { outcome: 'accepted', finding: F({ id: 'loop-det', title: 'await inside the export loop serializes uploads', severity: 'improvement', confidence: 0.7, source: 'deterministic', location: { repo: 'r', file: 'loop.ts', startLine: 5, endLine: 5 } }) },
  // a flag worth confirming — acknowledged, partial credit
  { outcome: 'acknowledged', finding: F({ id: 'aware', title: 'the same analytics event is emitted from two surfaces', severity: 'note', confidence: 0.7 }) },
  { outcome: 'rejected', finding: F({ id: 'style', title: 'prefer const over let here', severity: 'nit', confidence: 0.9, prevalence: 0.8 }) },
  { outcome: 'rejected', finding: F({ id: 'console', title: 'leftover console.log', severity: 'nit', confidence: 0.6 }) },
  { outcome: 'rejected', finding: F({ id: 'hunch', title: 'this allocation might possibly leak in some path', severity: 'bug', confidence: 0.15 }) }, // unverified hunch
  { outcome: 'rejected', finding: F({ id: 'any', title: 'explicit any in a test helper', severity: 'nit', confidence: 0.7 }) },
  { outcome: 'rejected', finding: F({ id: 'naming', title: 'rename handler to onSubmit for consistency', severity: 'improvement', confidence: 0.4, prevalence: 0.6 }) },
  { outcome: 'rejected', finding: F({ id: 'conv', title: 'file does not follow the kebab-case convention', severity: 'nit', confidence: 0.85, prevalence: 0.9 }) },
];

const NDCG_FLOOR = 0.9;

describe('ranking quality floor (fixed labeled corpus)', () => {
  const ranked = rankFindings(CORPUS.map((c) => c.finding));
  const outcomeById = new Map(CORPUS.map((c) => [c.finding.id, c.outcome] as const));
  // dedupe merges loop + loop-det under one id — give the merged finding the label of either half
  outcomeById.set('loop-det', 'accepted');

  it(`orders real issues above noise: nDCG ≥ ${NDCG_FLOOR}`, () => {
    const score = rankingNdcg(ranked.map((f) => f.id), outcomeById);
    expect(score).toBeGreaterThanOrEqual(NDCG_FLOOR);
  });

  it('every accepted/fixed surface finding outranks every rejected one in the surface bucket', () => {
    const surface = ranked.filter((f) => f.triage === 'surface');
    const rel = (id: string): number => (['accepted', 'fixed'].includes(outcomeById.get(id) ?? '') ? 1 : 0);
    const worstReal = surface.reduce((m, f, i) => (rel(f.id) === 1 ? i : m), -1);
    const firstNoise = surface.findIndex((f) => rel(f.id) === 0);
    expect(firstNoise === -1 || worstReal < firstNoise).toBe(true);
  });

  it('the common bug escalates as systemic-migration — never silenced by prevalence', () => {
    expect(ranked.find((f) => f.id === 'systemic')!.triage).toBe('systemic-migration');
  });

  it('prevalent style noise demotes to convention', () => {
    expect(ranked.find((f) => f.id === 'conv')!.triage).toBe('convention');
    expect(ranked.find((f) => f.id === 'style')!.triage).toBe('convention');
  });
});
