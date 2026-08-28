import { describe, it, expect } from 'vitest';
import { symbolKey, remapAnchor } from './code-path';

describe('remapAnchor', () => {
  const map = new Map([['src/old.ts', 'src/new.ts']]);

  it('rewrites a matching file anchor', () => {
    expect(remapAnchor(map, 'src/old.ts', undefined)).toEqual({ file: 'src/new.ts', symbol: undefined, changed: true });
  });

  it('rewrites a symbol’s file segment via the prefix rule', () => {
    expect(remapAnchor(map, 'src/old.ts', symbolKey('src/old.ts', 'foo'))).toEqual({
      file: 'src/new.ts',
      symbol: 'src/new.ts#foo',
      changed: true,
    });
  });

  it('leaves a non-matching anchor untouched (changed:false)', () => {
    expect(remapAnchor(map, 'src/other.ts', 'src/other.ts#foo')).toEqual({
      file: 'src/other.ts',
      symbol: 'src/other.ts#foo',
      changed: false,
    });
  });

  it('splits on the FIRST # so a # inside the name is safe', () => {
    expect(remapAnchor(map, undefined, 'src/old.ts#weird#name').symbol).toBe('src/new.ts#weird#name');
  });

  it('is a no-op for an empty rename map', () => {
    expect(remapAnchor(new Map(), 'src/old.ts', 'src/old.ts#foo').changed).toBe(false);
  });
});
