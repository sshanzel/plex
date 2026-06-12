import { describe, it, expect } from 'vitest';
import { analyzeSource } from './builtin';

const SRC = `export async function handler(items: any[]) {
  console.log('start');
  for (const it of items) {
    await save(it);
  }
  if (a == b) {
    debugger;
  }
  try {
    risky();
  } catch (e) {}
  const ok = (x === null);
  return ok;
}
`;

describe('analyzeSource', () => {
  const rules = new Set(analyzeSource('h.ts', SRC).map((r) => r.rule));

  it('flags the codifiable issues', () => {
    expect(rules.has('no-explicit-any')).toBe(true);
    expect(rules.has('no-console')).toBe(true);
    expect(rules.has('no-loose-equality')).toBe(true);
    expect(rules.has('no-debugger')).toBe(true);
    expect(rules.has('no-empty-catch')).toBe(true);
  });

  it('exempts `=== null` from loose-equality and assigns expected severities', () => {
    const found = analyzeSource('h.ts', SRC);
    // only the `a == b` is loose; `x === null` is strict and exempt
    expect(found.filter((r) => r.rule === 'no-loose-equality')).toHaveLength(1);
    expect(found.find((r) => r.rule === 'no-debugger')!.severity).toBe('bug');
    expect(found.find((r) => r.rule === 'no-empty-catch')!.severity).toBe('improvement');
    expect(found.find((r) => r.rule === 'no-explicit-any')!.severity).toBe('nit');
  });
});
