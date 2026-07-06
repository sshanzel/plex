import { describe, expect, it } from 'vitest';
import { buildModuleIndex, resolvePythonImport } from './resolve-py';

const setup = (files: string[]) => {
  const fileSet = new Set(files);
  const index = buildModuleIndex(fileSet);
  return { fileSet, index, resolve: (from: string, spec: string) => resolvePythonImport(from, spec, index, fileSet) };
};

describe('buildModuleIndex + absolute imports', () => {
  it('flat layout: package at the repo root', () => {
    const { resolve } = setup(['pkg/__init__.py', 'pkg/db.py', 'pkg/sub/__init__.py', 'pkg/sub/util.py', 'main.py']);
    expect(resolve('main.py', 'pkg.db')).toBe('pkg/db.py');
    expect(resolve('main.py', 'pkg')).toBe('pkg/__init__.py');
    expect(resolve('main.py', 'pkg.sub.util')).toBe('pkg/sub/util.py');
  });

  it('src layout: imports resolve through the src/ root', () => {
    const { resolve } = setup(['src/flask/__init__.py', 'src/flask/app.py', 'tests/test_app.py']);
    expect(resolve('tests/test_app.py', 'flask.app')).toBe('src/flask/app.py');
    expect(resolve('tests/test_app.py', 'flask')).toBe('src/flask/__init__.py');
  });

  it('monorepo: walk-up-while-__init__ finds nested package roots', () => {
    const { resolve } = setup(['services/api/app/__init__.py', 'services/api/app/db.py', 'services/api/main.py']);
    expect(resolve('services/api/main.py', 'app.db')).toBe('services/api/app/db.py');
  });

  it('from pkg import name: submodule file wins over an __init__ symbol', () => {
    const { resolve } = setup(['pkg/__init__.py', 'pkg/models.py']);
    expect(resolve('main.py', 'pkg.models')).toBe('pkg/models.py'); // the submodule
    expect(resolve('main.py', 'pkg.create_app')).toBe('pkg/__init__.py'); // walk-down fallback: a symbol
  });

  it('PEP 420 namespace package under a src root resolves without __init__.py', () => {
    const { resolve } = setup(['src/ns/mod.py', 'src/other.py']);
    expect(resolve('src/other.py', 'ns.mod')).toBe('src/ns/mod.py');
  });

  it('stdlib/third-party specifiers resolve to null', () => {
    const { resolve } = setup(['pkg/__init__.py', 'pkg/a.py']);
    expect(resolve('pkg/a.py', 'os')).toBeNull();
    expect(resolve('pkg/a.py', 'numpy.linalg')).toBeNull();
  });

  it('ambiguous module names prefer the same package as the importer', () => {
    const files = [
      'services/a/app/__init__.py',
      'services/a/app/db.py',
      'services/a/main.py',
      'services/b/app/__init__.py',
      'services/b/app/db.py',
      'services/b/main.py',
    ];
    const { resolve } = setup(files);
    expect(resolve('services/a/main.py', 'app.db')).toBe('services/a/app/db.py');
    expect(resolve('services/b/main.py', 'app.db')).toBe('services/b/app/db.py');
  });

  it('a root-level __init__.py names no module and never collides', () => {
    const { resolve } = setup(['__init__.py', 'a.py']);
    expect(resolve('a.py', 'nothing')).toBeNull();
  });

  it('a package takes precedence over a same-named sibling module (Python finder order)', () => {
    const { resolve } = setup(['pkg/__init__.py', 'pkg/m.py', 'pkg/m/__init__.py', 'main.py']);
    expect(resolve('main.py', 'pkg.m')).toBe('pkg/m/__init__.py'); // absolute: index tie-break
    expect(resolve('pkg/__init__.py', '.m')).toBe('pkg/m/__init__.py'); // relative: ladder order
  });

  it('extraRoots opens an escape hatch for unconventional layouts', () => {
    const fileSet = new Set(['lib/deep/ns/mod.py', 'main.py']);
    const index = buildModuleIndex(fileSet, ['lib/deep']);
    expect(resolvePythonImport('main.py', 'ns.mod', index, fileSet)).toBe('lib/deep/ns/mod.py');
  });
});

describe('relative imports', () => {
  const files = [
    'pkg/__init__.py',
    'pkg/db.py',
    'pkg/api/__init__.py',
    'pkg/api/routes.py',
    'pkg/api/handlers.py',
  ];

  it('single dot: sibling module, package fallback', () => {
    const { resolve } = setup(files);
    expect(resolve('pkg/api/routes.py', '.handlers')).toBe('pkg/api/handlers.py');
    expect(resolve('pkg/api/routes.py', '.missing')).toBe('pkg/api/__init__.py'); // from . import <symbol>
  });

  it('double dot ascends to the parent package', () => {
    const { resolve } = setup(files);
    expect(resolve('pkg/api/routes.py', '..db')).toBe('pkg/db.py');
    expect(resolve('pkg/api/routes.py', '..')).toBe('pkg/__init__.py');
  });

  it('from .sub import name walks down: submodule first, then __init__', () => {
    const { resolve } = setup(files);
    expect(resolve('pkg/db.py', '.api.routes')).toBe('pkg/api/routes.py');
    expect(resolve('pkg/db.py', '.api.create')).toBe('pkg/api/__init__.py');
  });

  it('ascending above the repo root resolves to null', () => {
    const { resolve } = setup(files);
    expect(resolve('pkg/db.py', '...far')).toBeNull();
  });

  it('skips the importing file itself and falls back down the ladder', () => {
    // `from . import api` inside pkg/api.py: pkg/api.py is the self-match (skipped);
    // the package __init__ is the correct next rung, never the importer.
    const { resolve, fileSet } = setup(['pkg/__init__.py', 'pkg/api.py']);
    expect(fileSet.has('pkg/api.py')).toBe(true);
    expect(resolve('pkg/api.py', '.api')).toBe('pkg/__init__.py');
  });
});
