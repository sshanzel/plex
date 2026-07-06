import { beforeAll, describe, expect, it } from 'vitest';
import { initPython, extractPythonSource } from '@plex/lang-python';
import { analyzePySource, PY_RULES } from './builtin-py';

beforeAll(async () => {
  await initPython();
});

const rulesOf = (src: string) => analyzePySource('h.py', src).map((f) => f.rule);
const find = (src: string, rule: string) => analyzePySource('h.py', src).filter((f) => f.rule === rule);

describe('analyzePySource — all rules fire on a multi-sin file', () => {
  it('reports every rule with its pinned severity', () => {
    const src = `import pdb

def f(x=[]):
    breakpoint()
    print(x)
    if x == None:
        pass
    try:
        pass
    except ValueError:
        pass
    try:
        pass
    except:
        return 1
    finally:
        return 2
`;
    const found = analyzePySource('h.py', src);
    const byRule = new Map(found.map((f) => [f.rule, f]));
    expect(new Set(byRule.keys())).toEqual(PY_RULES);
    expect(byRule.get('no-breakpoint')).toMatchObject({ severity: 'bug', confidence: 0.95 });
    expect(byRule.get('mutable-default-arg')).toMatchObject({ severity: 'bug', confidence: 0.9 });
    expect(byRule.get('no-return-in-finally')).toMatchObject({ severity: 'bug' });
    expect(byRule.get('no-bare-except')).toMatchObject({ severity: 'improvement' });
    expect(byRule.get('use-is-none')).toMatchObject({ severity: 'nit', confidence: 0.9 });
    expect(byRule.get('no-print')).toMatchObject({ severity: 'nit', confidence: 0.5 });
    // `except: pass` elsewhere pins no-silent-except; here the bare except has a real body.
    expect(rulesOf('try:\n    pass\nexcept:\n    pass\n')).toEqual(['no-silent-except']);
  });
});

describe('no-breakpoint', () => {
  it('fires on breakpoint(), pdb/ipdb set_trace, and pdb imports', () => {
    expect(rulesOf('breakpoint()\n')).toContain('no-breakpoint');
    expect(rulesOf('pdb.set_trace()\n')).toContain('no-breakpoint');
    expect(rulesOf('ipdb.set_trace()\n')).toContain('no-breakpoint');
    expect(rulesOf('import pdb\n')).toContain('no-breakpoint');
    expect(rulesOf('import ipdb as dbg\n')).toContain('no-breakpoint');
    expect(rulesOf('from pdb import set_trace\n')).toContain('no-breakpoint');
  });
  it('does not fire on lookalikes', () => {
    expect(rulesOf('db.breakpoint()\n')).toEqual([]);
    expect(rulesOf('import pdbx\n')).toEqual([]);
    expect(rulesOf('from mypdb import x\n')).toEqual([]);
    expect(rulesOf('obj.set_trace()\n')).toEqual([]);
  });
});

describe('mutable-default-arg', () => {
  it('fires on literal, constructor, comprehension, and lambda defaults', () => {
    expect(rulesOf('def f(x=[]): pass\n')).toContain('mutable-default-arg');
    expect(rulesOf('def f(x={}): pass\n')).toContain('mutable-default-arg');
    expect(rulesOf('def f(x={1}): pass\n')).toContain('mutable-default-arg');
    expect(rulesOf('def f(x: list[int] = []): pass\n')).toContain('mutable-default-arg');
    expect(rulesOf('def f(x=dict()): pass\n')).toContain('mutable-default-arg');
    expect(rulesOf('def f(x=[v for v in y]): pass\n')).toContain('mutable-default-arg');
    expect(rulesOf('g = lambda x=[]: x\n')).toContain('mutable-default-arg');
  });
  it('does not fire on immutable or sentinel defaults', () => {
    expect(rulesOf('def f(x=()): pass\n')).toEqual([]);
    expect(rulesOf('def f(x=None): pass\n')).toEqual([]);
    expect(rulesOf('def f(x=frozenset()): pass\n')).toEqual([]);
    expect(rulesOf('def f(x=0, y=""): pass\n')).toEqual([]);
  });
});

describe('no-return-in-finally', () => {
  it('fires on return directly inside finally', () => {
    expect(rulesOf('try:\n    pass\nfinally:\n    return 1\n')).toContain('no-return-in-finally');
  });
  it('a def nested inside the finally re-scopes its returns', () => {
    expect(rulesOf('try:\n    pass\nfinally:\n    def g():\n        return 1\n')).toEqual([]);
  });
  it('does not fire on returns in try/except bodies', () => {
    expect(rulesOf('try:\n    return 1\nexcept ValueError:\n    return 2\n')).toEqual([]);
  });
});

describe('except priority — exactly one finding per clause', () => {
  it('pass-only body → no-silent-except (even when bare)', () => {
    expect(rulesOf('try:\n    pass\nexcept:\n    pass\n')).toEqual(['no-silent-except']);
    expect(rulesOf('try:\n    pass\nexcept Exception:\n    ...\n')).toEqual(['no-silent-except']);
  });
  it('a trailing comment does not defeat pass-only detection', () => {
    expect(rulesOf('try:\n    pass\nexcept:\n    pass  # noqa\n')).toEqual(['no-silent-except']);
    expect(rulesOf('try:\n    pass\nexcept ValueError:\n    pass  # intentional\n')).toEqual(['no-silent-except']);
    expect(rulesOf('try:\n    pass\nexcept ValueError:\n    # explain\n    pass\n')).toEqual(['no-silent-except']);
  });
  it('bare except with a real body → no-bare-except', () => {
    expect(rulesOf('try:\n    pass\nexcept:\n    raise\n')).toEqual(['no-bare-except']);
  });
  it('typed except with a real body → clean', () => {
    expect(rulesOf('try:\n    pass\nexcept ValueError as e:\n    raise\n')).toEqual([]);
  });
});

describe('use-is-none', () => {
  it('fires on ==/!= against None, once per comparison', () => {
    expect(rulesOf('x == None\n')).toEqual(['use-is-none']);
    expect(rulesOf('None != x\n')).toEqual(['use-is-none']);
    expect(find('a == b == None\n', 'use-is-none')).toHaveLength(1);
  });
  it('does not fire on is None, string "None", or none-adjacent-to-is chains', () => {
    expect(rulesOf('x is None\n')).toEqual([]);
    expect(rulesOf('x is not None\n')).toEqual([]);
    expect(rulesOf('x == "None"\n')).toEqual([]);
    expect(rulesOf('a == b is None\n')).toEqual([]);
  });
});

describe('no-print', () => {
  it('fires on bare print only', () => {
    expect(rulesOf('print("x")\n')).toEqual(['no-print']);
    expect(rulesOf('pprint(x)\n')).toEqual([]);
    expect(rulesOf('obj.print()\n')).toEqual([]);
  });
});

describe('enclosingSymbol (ADR-48) — dotted methods, matching the graph extractor', () => {
  const symbolOf = (src: string, rule: string) => find(src, rule)[0]?.symbol;

  it('method findings carry Class.method', () => {
    expect(symbolOf('class C:\n    def m(self):\n        print(1)\n', 'no-print')).toBe('C.m');
  });
  it('decorated async methods still qualify', () => {
    expect(
      symbolOf('class C:\n    @deco\n    async def m(self):\n        print(1)\n', 'no-print'),
    ).toBe('C.m');
  });
  it('nested defs keep the nearest plain name', () => {
    expect(symbolOf('def outer():\n    def inner():\n        print(1)\n', 'no-print')).toBe('inner');
  });
  it('lambda bound to a name scopes like a named function', () => {
    expect(symbolOf('f = lambda: print(1)\n', 'no-print')).toBe('f');
  });
  it('top level is undefined; class-level defaults scope to the class', () => {
    expect(symbolOf('print(1)\n', 'no-print')).toBeUndefined();
    expect(symbolOf('class C:\n    def m(self, x=[]):\n        pass\n', 'mutable-default-arg')).toBe('C.m');
  });

  it('CROSS-PIN: deterministic symbol === graph extractor symbol for the same def', () => {
    const src = 'class Service:\n    def handle(self, x=[]):\n        pass\n';
    const graphNames = extractPythonSource('h.py', src).symbols.map((s) => s.name);
    const detSymbol = find(src, 'mutable-default-arg')[0]!.symbol!;
    expect(graphNames).toContain(detSymbol);
  });

  it('CROSS-PIN holds on the shapes most likely to diverge: nested classes and decorated methods', () => {
    // The two walkers traverse independently — these are exactly where they could drift apart
    // (breaking ADR-47/48 code-path-memory keys) while both suites stay green.
    const nested = 'class Outer:\n    class Inner:\n        def m(self, x=[]):\n            pass\n';
    expect(extractPythonSource('h.py', nested).symbols.map((s) => s.name)).toContain(
      find(nested, 'mutable-default-arg')[0]!.symbol!,
    );
    const decorated = 'class C:\n    @deco\n    async def handler(self, x=[]):\n        pass\n';
    expect(extractPythonSource('h.py', decorated).symbols.map((s) => s.name)).toContain(
      find(decorated, 'mutable-default-arg')[0]!.symbol!,
    );
  });
});

describe('error tolerance', () => {
  it('a syntactically broken file returns cleanly with no phantom findings', () => {
    const found = analyzePySource('h.py', '$$$ not python $$$\n\nprint("ok")\n');
    expect(found.map((f) => f.rule)).toEqual(['no-print']);
  });
});
