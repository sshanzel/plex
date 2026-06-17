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
    expect(found.filter((r) => r.rule === 'no-loose-equality')).toHaveLength(1);
    expect(found.find((r) => r.rule === 'no-debugger')!.severity).toBe('bug');
    expect(found.find((r) => r.rule === 'no-empty-catch')!.severity).toBe('improvement');
    expect(found.find((r) => r.rule === 'no-explicit-any')!.severity).toBe('nit');
  });

  it('anchors a finding to its enclosing symbol (ADR-48) across declaration shapes', () => {
    const sym = (src: string) => analyzeSource('h.ts', src).find((r) => r.rule === 'no-console')?.symbol;
    expect(sym('export function run() {\n  console.log(1);\n}\n')).toBe('run'); // function decl
    expect(sym('class C {\n  m() {\n    console.log(1);\n  }\n}\n')).toBe('m'); // method (nearest wins)
    expect(sym('const f = () => {\n  console.log(1);\n};\n')).toBe('f'); // arrow binding
    expect(sym('export const h = {\n  onTap: () => {\n    console.log(1);\n  },\n};\n')).toBe('onTap'); // object-literal property
    expect(sym('console.log(1);\n')).toBeUndefined(); // module top level
  });
});
