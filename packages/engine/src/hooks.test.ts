import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, uninstallHooks } from './hooks';

// hooks.ts is pure fs/path (no Kùzu) → vitest-safe. The fenced block must update/remove
// cleanly WITHOUT clobbering the user's own hook scripts, and must never corrupt a hook
// written for a non-shell interpreter.
let repo: string;
const hooksDir = (): string => join(repo, '.git', 'hooks');
const hookFile = (h: string): string => join(hooksDir(), h);
const CLI = '/opt/plex/dist/plex.js';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'plex-hooks-'));
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('installHooks', () => {
  it('throws if the path is not a git repo', () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    expect(() => installHooks(repo, CLI)).toThrow(/not a git repository/);
  });

  it('creates all three hooks (executable, each carrying the fenced block)', () => {
    const res = installHooks(repo, CLI);
    expect(res.hooks.sort()).toEqual(['post-checkout', 'post-merge', 'post-rewrite']);
    for (const h of res.hooks) {
      const f = hookFile(h);
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f, 'utf8')).toContain('>>> plex auto-index >>>');
      expect(statSync(f).mode & 0o777).toBe(0o755);
    }
  });

  it('is idempotent — re-installing is byte-identical (no duplicate block)', () => {
    installHooks(repo, CLI);
    const before = readFileSync(hookFile('post-merge'), 'utf8');
    installHooks(repo, CLI);
    const after = readFileSync(hookFile('post-merge'), 'utf8');
    expect(after).toBe(before);
    expect(after.match(/>>> plex auto-index >>>/g)).toHaveLength(1);
  });

  it('preserves a user\'s existing sh hook content (before AND after the block)', () => {
    writeFileSync(hookFile('post-merge'), '#!/bin/sh\necho "my custom hook"\n', 'utf8');
    installHooks(repo, CLI);
    const out = readFileSync(hookFile('post-merge'), 'utf8');
    expect(out).toContain('echo "my custom hook"');
    expect(out).toContain('>>> plex auto-index >>>');
  });

  it('updates the command in place when the CLI path changes (no second block)', () => {
    installHooks(repo, '/old/plex.js');
    installHooks(repo, '/new/plex.js');
    const out = readFileSync(hookFile('post-merge'), 'utf8');
    expect(out).toContain('/new/plex.js');
    expect(out).not.toContain('/old/plex.js');
    expect(out.match(/>>> plex auto-index >>>/g)).toHaveLength(1);
  });

  it('prepends a shebang to a hook that has none', () => {
    writeFileSync(hookFile('post-merge'), 'echo hi\n', 'utf8');
    installHooks(repo, CLI);
    expect(readFileSync(hookFile('post-merge'), 'utf8').startsWith('#!/bin/sh')).toBe(true);
  });

  it('SKIPS a non-shell hook (Python/Husky) instead of corrupting it', () => {
    const py = '#!/usr/bin/env python\nprint("hi")\n';
    writeFileSync(hookFile('post-merge'), py, 'utf8');
    const res = installHooks(repo, CLI);
    expect(res.skipped).toContain('post-merge');
    expect(res.hooks).not.toContain('post-merge');
    expect(readFileSync(hookFile('post-merge'), 'utf8')).toBe(py); // untouched
    expect(res.hooks).toContain('post-checkout'); // the others still install
  });
});

describe('uninstallHooks', () => {
  it('removes only the plex block, leaving surrounding user content', () => {
    writeFileSync(hookFile('post-merge'), '#!/bin/sh\necho before\n', 'utf8');
    installHooks(repo, CLI);
    const res = uninstallHooks(repo);
    expect(res.hooks).toContain('post-merge');
    const out = readFileSync(hookFile('post-merge'), 'utf8');
    expect(out).toContain('echo before');
    expect(out).not.toContain('plex auto-index');
  });

  it('is a no-op on a hook that has no plex block (not listed in result)', () => {
    writeFileSync(hookFile('post-merge'), '#!/bin/sh\necho mine\n', 'utf8');
    const res = uninstallHooks(repo);
    expect(res.hooks).not.toContain('post-merge');
    expect(readFileSync(hookFile('post-merge'), 'utf8')).toContain('echo mine');
  });
});
