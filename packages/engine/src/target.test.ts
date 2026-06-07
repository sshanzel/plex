import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { reviewTarget, reviewTargetFor } from './target';

// reviewTarget is the correlation key for the PR brain, audit log, and round tracking
// (ADR-22/23). Re-reviewing the SAME logical target must produce the SAME id — pin the
// derivation so a future tweak can't silently fork a target's history.
describe('reviewTarget', () => {
  it('builds <repo>__pr_<n> for a PR', () => {
    expect(reviewTarget('plex', { source: 'pr', pr: 42 })).toBe('plex__pr_42');
  });

  it('builds <repo>__<mode> for a local review, defaulting mode to working', () => {
    expect(reviewTarget('plex', { source: 'local', mode: 'staged' })).toBe('plex__staged');
    expect(reviewTarget('plex', { source: 'local' })).toBe('plex__working');
  });

  it('appends a slugified baseRef when present', () => {
    expect(reviewTarget('plex', { source: 'local', mode: 'branch', baseRef: 'origin/main' }))
      .toBe('plex__branch_origin_main');
  });

  it('is stable across calls for the same target (PR re-review reuses the id)', () => {
    const a = reviewTarget('plex', { source: 'pr', pr: 7 });
    const b = reviewTarget('plex', { source: 'pr', pr: 7 });
    expect(a).toBe(b);
  });

  it('slugifies the repo name (path-y / punctuated names collapse to underscores, trimmed)', () => {
    expect(reviewTarget('my-org/Some.Repo', { source: 'local', mode: 'staged' }))
      .toBe('my_org_Some_Repo__staged');
  });

  it('treats a PR source with a null pr number as a non-PR target (no __pr_)', () => {
    const t = reviewTarget('plex', { source: 'pr', mode: 'working' } as never);
    expect(t).toBe('plex__working');
    expect(t).not.toContain('__pr_');
  });

  it('truncates an overlong repo slug to 40 chars', () => {
    const t = reviewTarget('a'.repeat(80), { source: 'local', mode: 'staged' });
    expect(t).toBe(`${'a'.repeat(40)}__staged`);
  });
});

// reviewTargetFor is the CANONICAL entry point: every brain path (rounds, findings, verdicts,
// reconcile) must derive the target from it so they agree. The split-brain bug it prevents:
// round-recording keyed off the graph's `repo` meta (which a seeded worktree copies from the
// BASE), while findings keyed off the directory basename — two targets for one PR.
describe('reviewTargetFor (path-derived — the single source of truth)', () => {
  it('derives the target from the resolved directory BASENAME, ignoring graph meta', () => {
    expect(reviewTargetFor('/home/me/work/dazzling-spinning-harbor', { source: 'pr', pr: 79 }))
      .toBe('dazzling_spinning_harbor__pr_79');
  });

  it('equals reviewTarget(basename, src) — the helper is just that, made un-bypassable', () => {
    const p = '/a/b/playright';
    expect(reviewTargetFor(p, { source: 'pr', pr: 79 })).toBe(reviewTarget(path.basename(p), { source: 'pr', pr: 79 }));
  });

  it('two paths whose basenames differ (e.g. a worktree vs its base) get DIFFERENT targets', () => {
    // Distinct dirs are distinct brains anyway (each has its own data dir) — the invariant is
    // INTERNAL consistency, which the next test pins.
    expect(reviewTargetFor('/repos/playright', { source: 'pr', pr: 79 }))
      .not.toBe(reviewTargetFor('/repos/dazzling-spinning-harbor', { source: 'pr', pr: 79 }));
  });

  it('is identical regardless of trailing slash / un-normalized path (resolve normalizes)', () => {
    expect(reviewTargetFor('/repos/playright/', { source: 'pr', pr: 79 }))
      .toBe(reviewTargetFor('/repos/playright', { source: 'pr', pr: 79 }));
  });
});
