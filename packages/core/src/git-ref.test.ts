import { describe, it, expect } from 'vitest';
import { isSafeGitRef } from './git-ref';

describe('isSafeGitRef', () => {
  it('accepts real branch/tag/sha/revision shapes', () => {
    for (const ref of ['main', 'master', 'release/1.x', 'v1.2.3', 'origin/main', 'a1b2c3d', 'HEAD~3', 'feature/foo-bar', 'main@{upstream}']) {
      expect(isSafeGitRef(ref)).toBe(true);
    }
  });

  it('rejects an option-injection ref (the actual threat: git reads a leading "-" as a flag)', () => {
    for (const ref of ['--upload-pack=touch /tmp/x', '-x', '--output=/tmp/p']) {
      expect(isSafeGitRef(ref)).toBe(false);
    }
  });

  it('rejects empty, over-long, a bare range op, and shell-ish/whitespace chars (never a real ref)', () => {
    expect(isSafeGitRef('')).toBe(false);
    expect(isSafeGitRef('a'.repeat(257))).toBe(false);
    expect(isSafeGitRef('..')).toBe(false);
    for (const ref of ['main; rm -rf /', 'a b', 'a|b', 'a$(b)', 'a`b`', 'a\nb']) {
      expect(isSafeGitRef(ref)).toBe(false);
    }
  });
});
