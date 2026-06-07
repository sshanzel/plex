import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { repoId, repoPaths } from './paths';

// repoId + repoPaths are the foundation of centralized storage (ADR-30) AND of worktree
// isolation (ADR-32): distinct absolute paths MUST map to distinct data dirs, and the
// dataDir override modes must resolve exactly as documented. Pure logic — pin it tightly.
describe('repoId', () => {
  it('is basename + an 8-char path hash', () => {
    const id = repoId('/Users/me/projects/plex');
    expect(id).toMatch(/^plex-[0-9a-f]{8}$/);
  });

  it('is stable for the same absolute path and DISTINCT for different paths (worktree isolation)', () => {
    expect(repoId('/a/b/plex')).toBe(repoId('/a/b/plex'));
    // same basename, different parent → different id (else two worktrees collide)
    expect(repoId('/a/wt1/plex')).not.toBe(repoId('/a/wt2/plex'));
  });

  it('sanitizes filesystem-unsafe characters in the basename to underscores', () => {
    expect(repoId('/tmp/my repo@v2!')).toMatch(/^my_repo_v2_-[0-9a-f]{8}$/);
  });

  it('preserves dot/dash/underscore (already filesystem-safe)', () => {
    expect(repoId('/tmp/my-repo_v2.1')).toMatch(/^my-repo_v2\.1-[0-9a-f]{8}$/);
  });

  it('truncates a very long basename to 40 chars before the hash', () => {
    const long = 'a'.repeat(80);
    const id = repoId(`/tmp/${long}`);
    const base = id.slice(0, id.lastIndexOf('-'));
    expect(base).toHaveLength(40);
  });

  it('falls back to "repo" when the basename is empty (filesystem root)', () => {
    expect(repoId('/')).toMatch(/^repo-[0-9a-f]{8}$/);
  });

  it('resolves relative paths to absolute first (id is cwd-anchored, not literal)', () => {
    expect(repoId('.')).toBe(repoId(process.cwd()));
  });
});

describe('repoPaths', () => {
  const abs = '/Users/me/projects/plex';
  const id = repoId(abs);

  it('defaults to centralized ~/.plex/repos/<id> — nothing inside the repo', () => {
    const p = repoPaths(abs); // dataDir unset
    expect(p.reviewerDir).toBe(path.join(os.homedir(), '.plex', 'repos', id));
    expect(p.reviewerDir.startsWith(abs)).toBe(false); // NOT in the user's tree
  });

  it('treats an empty-string dataDir as centralized too', () => {
    expect(repoPaths(abs, '').reviewerDir).toBe(path.join(os.homedir(), '.plex', 'repos', id));
  });

  it('treats a RELATIVE dataDir as in-repo, co-located', () => {
    const p = repoPaths(abs, '.plex');
    expect(p.reviewerDir).toBe(path.join(abs, '.plex'));
    expect(p.graphDir).toBe(path.join(abs, '.plex', 'graph.kuzu'));
  });

  it('treats an ABSOLUTE dataDir as the repos ROOT: <dataDir>/<id>', () => {
    const p = repoPaths(abs, '/var/plexdata');
    expect(p.reviewerDir).toBe(path.join('/var/plexdata', id));
  });

  it('derives every artifact path from reviewerDir', () => {
    const p = repoPaths(abs, '.plex');
    const r = p.reviewerDir;
    expect(p.graphDir).toBe(path.join(r, 'graph.kuzu'));
    expect(p.brainDir).toBe(path.join(r, 'brain.kuzu'));
    expect(p.verdictsFile).toBe(path.join(r, 'verdicts.jsonl'));
    expect(p.miningStateFile).toBe(path.join(r, 'mining-state.json'));
    expect(p.logFile).toBe(path.join(r, 'log', 'events.jsonl'));
    expect(p.headShaFile).toBe(path.join(r, 'head.sha'));
    expect(p.repoPath).toBe(abs);
  });

  it('gives two different absolute repo paths NON-overlapping data dirs (worktree airtightness)', () => {
    const a = repoPaths('/a/wt1/plex', '').reviewerDir;
    const b = repoPaths('/a/wt2/plex', '').reviewerDir;
    expect(a).not.toBe(b);
  });
});
