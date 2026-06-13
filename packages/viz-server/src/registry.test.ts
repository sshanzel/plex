import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReviewerConfig } from '@plex/core';
import { listRepos, resolveRepo, reposRoot } from './registry';

const cfg = (dataDir: string): ReviewerConfig => ({ dataDir } as ReviewerConfig);

describe('registry', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'plex-reg-'));
    // a usable repo: has graph + brain + a repo-path sidecar
    const a = path.join(root, 'alpha-12345678');
    mkdirSync(path.join(a, 'graph.kuzu'), { recursive: true });
    mkdirSync(path.join(a, 'brain.kuzu'), { recursive: true });
    writeFileSync(path.join(a, 'repo-path'), '/home/me/code/alpha\n');
    // brain-only repo (a worktree-style entry) — still usable
    mkdirSync(path.join(root, 'beta-abcdef01', 'brain.kuzu'), { recursive: true });
    // a dir with neither store — must be ignored
    mkdirSync(path.join(root, 'empty-00000000'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reposRoot: absolute dataDir is the root; relative returns null', () => {
    expect(reposRoot(cfg(root))).toBe(root);
    expect(reposRoot(cfg('.plex'))).toBeNull();
    expect(reposRoot(cfg(''))).toBe(path.join(os.homedir(), '.plex', 'repos'));
  });

  it('lists only dirs with a graph or brain, with friendly names', () => {
    const repos = listRepos(cfg(root));
    expect(repos.map((r) => r.id).sort()).toEqual(['alpha-12345678', 'beta-abcdef01']);
    const alpha = repos.find((r) => r.id === 'alpha-12345678')!;
    expect(alpha.name).toBe('alpha'); // from repo-path basename
    expect(alpha.hasGraph).toBe(true);
    expect(alpha.hasBrain).toBe(true);
    const beta = repos.find((r) => r.id === 'beta-abcdef01')!;
    expect(beta.hasGraph).toBe(false);
    expect(beta.name).toBe('beta'); // id with the -<hash> suffix stripped
  });

  it('resolveRepo accepts a known id and rejects traversal / unknown ids', () => {
    expect(resolveRepo(cfg(root), 'alpha-12345678')?.id).toBe('alpha-12345678');
    expect(resolveRepo(cfg(root), '../../etc')).toBeNull();
    expect(resolveRepo(cfg(root), '..')).toBeNull();
    expect(resolveRepo(cfg(root), 'nope-99999999')).toBeNull();
    expect(resolveRepo(cfg(root), 'empty-00000000')).toBeNull(); // dir exists but no store
    expect(resolveRepo(cfg('.plex'), 'alpha-12345678')).toBeNull(); // no central root
  });
});
