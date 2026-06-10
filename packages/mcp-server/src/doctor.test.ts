import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveConfig } from '@plex/core';
import { buildDoctorReport, findOrphanedRepos, dirSizeBytes } from './doctor';

const base = {
  version: '0.2.0',
  config: resolveConfig({ embedding: { provider: 'voyage' }, dataDir: '' }),
  node: 'v22.0.0',
  pid: 1234,
};

describe('buildDoctorReport (the "is this build stale?" signal)', () => {
  it('flags stale when a NEWER build is on disk than the process loaded', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 1000, onDiskBuildMs: 5000 });
    expect(r.stale).toBe(true);
    expect(r.advice).toMatch(/reconnect Plex/i);
  });

  it('is NOT stale when disk == loaded (same build)', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 5000, onDiskBuildMs: 5000 });
    expect(r.stale).toBe(false);
    expect(r.advice).toMatch(/up to date/i);
  });

  it('is NOT stale when the on-disk build is older (e.g. clock jitter / unknown)', () => {
    expect(buildDoctorReport({ ...base, loadedBuildMs: 5000, onDiskBuildMs: 4000 }).stale).toBe(false);
    expect(buildDoctorReport({ ...base, loadedBuildMs: 5000, onDiskBuildMs: 0 }).stale).toBe(false);
  });

  it('surfaces the EFFECTIVE config (embeddings provider + dirs) so a config check is one call', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 1, onDiskBuildMs: 1 });
    expect(r.embeddings).toBe('voyage');
    expect(r.dataDir).toMatch(/centralized/); // dataDir '' renders as the centralized note
    expect(r.knowledgeDir).toContain('.plex');
  });

  it('renders unknown build times instead of an epoch date', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 0, onDiskBuildMs: 0 });
    expect(r.loadedBuild).toBe('unknown');
    expect(r.onDiskBuild).toBe('unknown');
  });

  it('omits orphanedRepos when all data dirs have live repo paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'plex-dr-'));
    try {
      const dir = join(root, 'myrepo-abc12345');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'repo-path'), root); // root exists on disk
      const r = buildDoctorReport({
        ...base,
        config: resolveConfig({ embedding: { provider: 'voyage' }, dataDir: root }),
        loadedBuildMs: 1,
        onDiskBuildMs: 1,
      });
      expect(r.orphanedRepos).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes orphanedRepos for data dirs whose repoPath no longer exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'plex-dr-'));
    try {
      const dir = join(root, 'gone-abc12345');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'repo-path'), '/nonexistent/path/that/does/not/exist');
      const r = buildDoctorReport({
        ...base,
        config: resolveConfig({ embedding: { provider: 'voyage' }, dataDir: root }),
        loadedBuildMs: 1,
        onDiskBuildMs: 1,
      });
      expect(r.orphanedRepos).toHaveLength(1);
      expect(r.orphanedRepos![0].repoPath).toBe('/nonexistent/path/that/does/not/exist');
      expect(r.orphanedRepos![0].dir).toBe(dir);
      expect(r.orphanedRepos![0].sizeBytes).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findOrphanedRepos', () => {
  it('returns empty array when reposRoot does not exist', () => {
    expect(findOrphanedRepos('/nonexistent/root/that/cannot/exist')).toEqual([]);
  });

  it('skips dirs without a repo-path sidecar (pre-v0.3.3 dirs)', () => {
    const root = mkdtempSync(join(tmpdir(), 'plex-fo-'));
    try {
      const dir = join(root, 'old-dir-no-sidecar');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'head.sha'), 'abc123');
      expect(findOrphanedRepos(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a dir whose repoPath no longer exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'plex-fo-'));
    try {
      const dir = join(root, 'deleted-repo-abc');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'repo-path'), '/absolutely/does/not/exist/anywhere');
      const orphans = findOrphanedRepos(root);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].repoPath).toBe('/absolutely/does/not/exist/anywhere');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT report a dir whose repoPath still exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'plex-fo-'));
    try {
      const liveRepo = mkdtempSync(join(tmpdir(), 'plex-live-'));
      const dir = join(root, 'live-repo-abc');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'repo-path'), liveRepo);
      expect(findOrphanedRepos(root)).toEqual([]);
      rmSync(liveRepo, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles a mix of orphaned and live dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'plex-fo-'));
    try {
      const liveRepo = mkdtempSync(join(tmpdir(), 'plex-live2-'));

      const live = join(root, 'live-abc');
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'repo-path'), liveRepo);

      const dead = join(root, 'dead-xyz');
      mkdirSync(dead, { recursive: true });
      writeFileSync(join(dead, 'repo-path'), '/gone/repo/path');

      const orphans = findOrphanedRepos(root);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].dir).toBe(dead);

      rmSync(liveRepo, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dirSizeBytes', () => {
  it('returns 0 for a nonexistent path', () => {
    expect(dirSizeBytes('/nonexistent/dir')).toBe(0);
  });

  it('returns a positive number for a dir with files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plex-sz-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'hello world');
      expect(dirSizeBytes(dir)).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sums files recursively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plex-sz-'));
    try {
      const sub = join(dir, 'sub');
      mkdirSync(sub);
      writeFileSync(join(dir, 'a.txt'), '12345');      // 5 bytes
      writeFileSync(join(sub, 'b.txt'), '1234567890'); // 10 bytes
      expect(dirSizeBytes(dir)).toBeGreaterThanOrEqual(15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
