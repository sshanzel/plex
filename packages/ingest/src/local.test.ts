import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffFile } from '@plex/core';
import { getLocalDiff } from './local';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Integration test against real `git diff` output (the actual production path). */
describe('getLocalDiff (real git)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'reviewer-it-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'src/user.ts'),
      'export class UserService {\n  save(u) {\n    this.repo.insert(u);\n  }\n}\n',
    );
    writeFileSync(join(repo, 'src/old.ts'), 'export const x = 1;\nexport const y = 2;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    // modify + add + delete
    writeFileSync(
      join(repo, 'src/user.ts'),
      'export class UserService {\n  save(u) {\n    if (!u.id) throw new Error("missing id");\n    this.repo.insert(u);\n  }\n}\n',
    );
    writeFileSync(join(repo, 'src/new.ts'), 'export const a = 1;\nexport const b = 2;\n');
    rmSync(join(repo, 'src/old.ts'));
    git(repo, 'add', '-A');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('normalizes a real multi-file staged diff with correct statuses', async () => {
    const diff = await getLocalDiff({ cwd: repo, mode: 'staged' });
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f])) as Record<string, DiffFile>;

    expect(Object.keys(byPath).sort()).toEqual(['src/new.ts', 'src/old.ts', 'src/user.ts']);
    expect(byPath['src/user.ts']!.status).toBe('modified');
    expect(byPath['src/old.ts']!.status).toBe('deleted');
    expect(byPath['src/new.ts']!.status).toBe('added');

    // user.ts gained a guard line around new line 3
    const userRanges = byPath['src/user.ts']!.hunks.flatMap((h) => h.newRanges);
    expect(userRanges.some((r) => r.start <= 3 && r.end >= 3)).toBe(true);

    // new.ts adds its two lines
    expect(byPath['src/new.ts']!.hunks.flatMap((h) => h.newRanges)).toEqual([{ start: 1, end: 2 }]);
  });
});
