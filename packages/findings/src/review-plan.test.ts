import { describe, it, expect } from 'vitest';
import { partitionByCoupling, reviewPlan } from './review-plan';

const f = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i + 1}.ts`);

describe('partitionByCoupling', () => {
  it('uncoupled files are singleton clusters', () => {
    expect(partitionByCoupling(['a', 'b', 'c'], []).map((c) => c.sort())).toEqual([['a'], ['b'], ['c']]);
  });
  it('transitively-coupled files form one cluster', () => {
    const out = partitionByCoupling(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(out).toHaveLength(1);
    expect(out[0]!.sort()).toEqual(['a', 'b', 'c']);
  });
  it('separates independent clusters', () => {
    const out = partitionByCoupling(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']]).map((c) => c.sort()).sort();
    expect(out).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('ignores edges to files outside the changed set', () => {
    const out = partitionByCoupling(['a', 'b'], [['a', 'z'], ['b', 'y']]); // z, y not changed
    expect(out.map((c) => c.sort()).sort()).toEqual([['a'], ['b']]);
  });
});

describe('reviewPlan (the guardrail)', () => {
  const bigSurface = 400;

  it('SINGLE for a small change (few files), regardless of surface', () => {
    const p = reviewPlan(f(3), [], { surface: bigSurface });
    expect(p.strategy).toBe('single');
    expect(p.units).toHaveLength(1);
    expect(p.reason).toMatch(/one reviewer is faster/);
  });

  it('SINGLE when the review surface is too small', () => {
    // 8 files in 4 independent clusters, but tiny surface → not worth fanning out
    const p = reviewPlan(f(8), [['f1.ts', 'f2.ts'], ['f3.ts', 'f4.ts'], ['f5.ts', 'f6.ts'], ['f7.ts', 'f8.ts']], { surface: 50 });
    expect(p.strategy).toBe('single');
    expect(p.reason).toMatch(/too small to parallelize/);
  });

  it('SINGLE when everything is one coupled cluster (don\'t sever cross-file reasoning)', () => {
    const chain = f(8).slice(0, -1).map((x, i) => [x, f(8)[i + 1]!] as [string, string]); // f1-f2-...-f8
    const p = reviewPlan(f(8), chain, { surface: bigSurface });
    expect(p.strategy).toBe('single');
    expect(p.reason).toMatch(/one coupled cluster/);
  });

  it('PARALLEL into the clusters when big + multi-cluster', () => {
    const files = f(9);
    const edges: [string, string][] = [
      ['f1.ts', 'f2.ts'], ['f2.ts', 'f3.ts'],
      ['f4.ts', 'f5.ts'], ['f5.ts', 'f6.ts'],
      ['f7.ts', 'f8.ts'], ['f8.ts', 'f9.ts'],
    ];
    const p = reviewPlan(files, edges, { surface: bigSurface });
    expect(p.strategy).toBe('parallel');
    expect(p.units).toHaveLength(3);
    expect(p.units.flatMap((u) => u.files).sort()).toEqual(files.sort()); // every file covered exactly once
  });

  it('caps the number of reviewers at maxAgents (merges the smallest)', () => {
    const files = f(12);
    const edges: [string, string][] = [
      ['f1.ts', 'f2.ts'], ['f3.ts', 'f4.ts'], ['f5.ts', 'f6.ts'],
      ['f7.ts', 'f8.ts'], ['f9.ts', 'f10.ts'], ['f11.ts', 'f12.ts'],
    ]; // 6 clusters of 2
    const p = reviewPlan(files, edges, { surface: bigSurface, maxAgents: 3 });
    expect(p.strategy).toBe('parallel');
    expect(p.units).toHaveLength(3); // 6 clusters merged down to 3
    expect(p.units.flatMap((u) => u.files).sort()).toEqual(files.sort());
  });

  it('folds a tiny (1-file) cluster into a significant one rather than giving it an agent', () => {
    const files = f(7); // f1-3 cluster, f4-6 cluster, f7 singleton
    const edges: [string, string][] = [
      ['f1.ts', 'f2.ts'], ['f2.ts', 'f3.ts'],
      ['f4.ts', 'f5.ts'], ['f5.ts', 'f6.ts'],
    ];
    const p = reviewPlan(files, edges, { surface: 200 });
    expect(p.strategy).toBe('parallel');
    expect(p.units).toHaveLength(2); // f7 folded in, not its own unit
    expect(p.units.flatMap((u) => u.files).sort()).toEqual(files.sort());
  });
});
