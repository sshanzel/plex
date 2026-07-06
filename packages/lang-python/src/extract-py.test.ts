import { beforeAll, describe, expect, it } from 'vitest';
import { initPython } from './parser';
import { extractPythonSource } from './extract-py';

beforeAll(async () => {
  await initPython();
});

const extract = (src: string) => extractPythonSource('pkg/mod.py', src);
const sym = (src: string, name: string) => extract(src).symbols.find((s) => s.name === name);

describe('extractPythonSource — symbols', () => {
  it('captures functions, classes, and Class.method with TS-parity kinds', () => {
    const src = `def top(): pass

class App:
    def run(self): pass
    async def stop(self): pass
`;
    const { symbols } = extract(src);
    expect(sym(src, 'top')).toMatchObject({ kind: 'function', exported: true, startLine: 1 });
    expect(sym(src, 'App')).toMatchObject({ kind: 'class', exported: true });
    expect(sym(src, 'App.run')).toMatchObject({ kind: 'method', exported: true });
    expect(sym(src, 'App.stop')).toMatchObject({ kind: 'method' });
    expect(symbols).toHaveLength(4);
  });

  it('decorated definitions span from the first decorator (changed-line attribution)', () => {
    const src = `@decorator
@app.route("/x")
def handler(): pass
`;
    expect(sym(src, 'handler')).toMatchObject({ kind: 'function', startLine: 1, endLine: 3 });
  });

  it('decorated methods stay Class.method', () => {
    const src = `class C:
    @property
    def value(self): return 1
`;
    expect(sym(src, 'C.value')).toMatchObject({ kind: 'method', startLine: 2 });
  });

  it('nested defs keep their plain name and are not exported (TS parity)', () => {
    const src = `def outer():
    def inner(): pass
`;
    expect(sym(src, 'inner')).toMatchObject({ kind: 'function', exported: false });
    expect(sym(src, 'outer.inner')).toBeUndefined();
  });

  it('methods of a nested class qualify by the INNERMOST class', () => {
    const src = `class Outer:
    class Inner:
        def m(self): pass
`;
    expect(sym(src, 'Inner.m')).toMatchObject({ kind: 'method' });
    expect(sym(src, 'Inner')).toMatchObject({ kind: 'class' });
  });

  it('a def inside a method body is a plain function, not a method', () => {
    const src = `class C:
    def m(self):
        def helper(): pass
`;
    expect(sym(src, 'helper')).toMatchObject({ kind: 'function', exported: false });
    expect(sym(src, 'C.helper')).toBeUndefined();
  });

  it('underscore convention drives exported when there is no __all__', () => {
    const src = `def pub(): pass
def _priv(): pass

class _Hidden:
    def m(self): pass
`;
    expect(sym(src, 'pub')!.exported).toBe(true);
    expect(sym(src, '_priv')!.exported).toBe(false);
    expect(sym(src, '_Hidden')!.exported).toBe(false);
    expect(sym(src, '_Hidden.m')!.exported).toBe(false); // methods inherit the class flag
  });

  it('a literal __all__ overrides the underscore convention', () => {
    const src = `__all__ = ["_weird"]

def _weird(): pass
def unlisted(): pass
`;
    expect(sym(src, '_weird')!.exported).toBe(true);
    expect(sym(src, 'unlisted')!.exported).toBe(false);
  });

  it('module-level lambda assignment is a const (arrow-fn mirror); plain constants are not captured', () => {
    const src = `handler = lambda x: x
FOO = 1
_quiet = lambda: None
`;
    expect(sym(src, 'handler')).toMatchObject({ kind: 'const', exported: true });
    expect(sym(src, '_quiet')).toMatchObject({ kind: 'const', exported: false });
    expect(sym(src, 'FOO')).toBeUndefined();
  });

  it('PEP 695 type alias → kind type', () => {
    expect(sym('type Vector = list[float]\n', 'Vector')).toMatchObject({ kind: 'type', exported: true });
  });

  it('a broken file extracts recoverable symbols and nothing from ERROR regions', () => {
    // tree-sitter recovers `broken` as a real function_definition (the ERROR sits inside its
    // parameters) — extracting it is correct; the guard is against garbage-named phantoms.
    const { symbols } = extract('def broken(:\n    pass\n\ndef ok(): pass\n');
    expect(symbols.map((s) => s.name).sort()).toEqual(['broken', 'ok']);
  });

  it('a top-level ERROR region contributes nothing', () => {
    const { symbols } = extract('$$$ not python $$$\n\ndef ok(): pass\n');
    expect(symbols.map((s) => s.name)).toEqual(['ok']);
  });
});

describe('extractPythonSource — imports', () => {
  const imports = (src: string) => extract(src).imports;

  it('covers every static form', () => {
    const src = `import os
import a.b.c as abc, plain
from x.y import z as zz, w
from . import sib
from ..up import thing
from pkg import *
from .. import *
from __future__ import annotations
`;
    expect(imports(src)).toEqual([
      'os',
      'a.b.c',
      'plain',
      'x.y.z',
      'x.y.w',
      '.sib',
      '..up.thing',
      'pkg',
      '..',
    ]);
  });

  it('captures conditional, guarded, and function-scoped imports (real coupling)', () => {
    const src = `from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from .models import User
try:
    import fastjson
except ImportError:
    import json as fastjson

def lazy():
    from .heavy import compute
    return compute
`;
    expect(imports(src)).toEqual(expect.arrayContaining(['.models.User', 'fastjson', 'json', '.heavy.compute']));
  });

  it('captures literal dynamic imports only', () => {
    const src = `import importlib
m = importlib.import_module("dyn.mod")
n = __import__("dyn2")
k = importlib.import_module(name)
`;
    const got = imports(src);
    expect(got).toEqual(expect.arrayContaining(['dyn.mod', 'dyn2']));
    expect(got).toHaveLength(3); // importlib + the two literals; the variable arg contributes nothing
  });

  it('dedupes repeated specifiers', () => {
    expect(imports('import os\nimport os\n')).toEqual(['os']);
  });
});
