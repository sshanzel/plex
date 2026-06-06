import { describe, it, expect } from 'vitest';
import { extractFromSource, resolveRelativeImport } from './extract-ts';

describe('extractFromSource', () => {
  it('extracts exported functions, classes, methods, types and imports', () => {
    const src = `import { insert } from './db';
import type { T } from './types';
export class UserService {
  save(u: T) { insert(u); }
  private helper() {}
}
export function topLevel() {}
export const arrow = () => 1;
export interface Repo {}
type Alias = string;
`;
    const { symbols, imports } = extractFromSource('src/user.ts', src);
    const byName = new Map(symbols.map((s) => [s.name, s]));

    expect(imports.sort()).toEqual(['./db', './types']);
    expect(byName.get('UserService')?.kind).toBe('class');
    expect(byName.get('UserService.save')?.kind).toBe('method');
    expect(byName.get('topLevel')?.kind).toBe('function');
    expect(byName.get('arrow')?.kind).toBe('const');
    expect(byName.get('Repo')?.kind).toBe('interface');
    expect(byName.get('Alias')?.kind).toBe('type');
    expect(byName.get('UserService')?.exported).toBe(true);
    // line spans are 1-based
    expect(byName.get('UserService')!.startLine).toBe(3);
  });
});

describe('resolveRelativeImport', () => {
  const files = new Set(['src/db.ts', 'src/util/index.ts', 'src/types.ts']);

  it('resolves relative specifiers with extension inference and index files', () => {
    expect(resolveRelativeImport('src/user.ts', './db', files)).toBe('src/db.ts');
    expect(resolveRelativeImport('src/user.ts', './util', files)).toBe('src/util/index.ts');
  });

  it('returns null for bare/external and unresolved specifiers', () => {
    expect(resolveRelativeImport('src/user.ts', 'react', files)).toBeNull();
    expect(resolveRelativeImport('src/user.ts', './missing', files)).toBeNull();
  });
});
