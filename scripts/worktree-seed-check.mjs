// Worktree-seed end-to-end (ADR-32) under the SHIPPED runtime: plain `node` driving the
// built CLI. A secondary git worktree seeds its code graph from the BASE (default-branch)
// worktree instead of a full re-parse: refresh the base in an ISOLATED child, copy it, then
// apply only this branch's diff.
//
//   pnpm build && pnpm test:worktree
//
// This is the layer that actually exercises the isolated-child base refresh (the tsx
// `worktree-seed` scenario can't — `indexIsolated` no-ops without a built CLI beside argv[1]).
// It guards three things tsx can't:
//   1. NO SIGSEGV — opening the base's Kùzu *and* the copied graph in one process crashed
//      (exit 139). The base refresh must run in a child so this process opens Kùzu once.
//   2. Base SELF-REFRESH — a stale base is brought to its own HEAD before the copy.
//   3. Base from the DEFAULT branch — the worktree on `main` is chosen over the primary.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('worktree-seed-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

const env = { ...process.env, PLEX_DATA_DIR: '.plex', PLEX_EMBEDDING_PROVIDER: 'none' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const head = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
const sha = (cwd) => {
  const f = join(cwd, '.plex', 'head.sha');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
};
/** Run the CLI and return {code, signal, out}. Does NOT throw on failure (so we can assert on SIGSEGV). */
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, signal: r.signal, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
/**
 * Seed-index a worktree, tolerating ONE rare native Kùzu crash (ADR-17). A real regression
 * (e.g. the in-process double-open) SIGSEGVs on EVERY attempt → still fails here. The flaky
 * 1-in-N crash passes on retry. We clear the partial `.plex` first so the retry re-seeds (a
 * leftover partial graph would otherwise make `plex index` fall back to a full build), keeping
 * the "Seeded from base worktree" assertion meaningful. This mirrors the product's own
 * `indexIsolated` retry — the review flow is resilient the same way.
 */
const seedIndex = (repoPath) => {
  let r = cli(['index', repoPath], repoPath);
  if (r.signal === 'SIGSEGV') {
    rmSync(join(repoPath, '.plex'), { recursive: true, force: true });
    r = cli(['index', repoPath], repoPath);
  }
  return r;
};
const assert = (c, m) => {
  if (!c) {
    console.error('✗ worktree-seed-check: ' + m);
    process.exit(1);
  }
};

// ── Scenario A — self-refresh + seed + NO SIGSEGV ──────────────────────────────────────────
// main(a,b) indexed, then main advances (d added → base graph stale). A fresh feat worktree
// (a,b,c) must: refresh the base to main's new HEAD, copy it, apply only the feat diff (+c −d).
{
  const root = mkdtempSync(join(tmpdir(), 'plex-wt-a-'));
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  try {
    mkdirSync(main);
    git(main, 'init', '-q');
    git(main, 'config', 'user.email', 't@t.dev');
    git(main, 'config', 'user.name', 'T');
    mkdirSync(join(main, 'src'));
    writeFileSync(join(main, 'src/a.ts'), 'export function a() {\n  return 1;\n}\n');
    writeFileSync(join(main, 'src/b.ts'), "import { a } from './a';\nexport function b() {\n  return a() + 1;\n}\n");
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    writeFileSync(join(wt, 'src/c.ts'), 'export function c() {\n  return 2;\n}\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'add c');
    const featHead = head(wt);

    const ib = cli(['index', main], main);
    assert(ib.code === 0, `index base failed: ${ib.out}`);
    const baseSha1 = sha(main);
    assert(baseSha1 === head(main), 'base graph stamped at main HEAD');

    // advance main → the base graph is now STALE.
    writeFileSync(join(main, 'src/d.ts'), 'export function d() {\n  return 9;\n}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'add d on main');
    const mainHead2 = head(main);
    assert(mainHead2 !== baseSha1, 'main advanced past the indexed base');

    const r = seedIndex(wt);
    assert(r.signal !== 'SIGSEGV' && r.code === 0, `index wt crashed/failed (signal=${r.signal} code=${r.code}): ${r.out}`);
    assert(/Seeded from base worktree/.test(r.out), `expected seed, got: ${r.out}`);
    assert(/\(\+1 ~0 -1\)/.test(r.out), `expected +c −d diff applied to the copy, got: ${r.out}`);
    assert(sha(main) === mainHead2, `base self-refreshed to its own HEAD (got ${sha(main)}, want ${mainHead2})`);
    assert(sha(wt) === featHead, `worktree graph stamped at feat HEAD (got ${sha(wt)}, want ${featHead})`);
    assert(!new RegExp(`Graph: ${main}/`).test(r.out), 'worktree graph lives at the worktree path, not the base');
    console.log('✓ worktree-seed A: stale base self-refreshes, seed applies +c −d, no SIGSEGV');
  } finally {
    try { git(main, 'worktree', 'remove', '--force', wt); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Scenario B — base is chosen from the DEFAULT branch, not the primary worktree ───────────
// Primary is on `dev` (with a dev-only file). A separate worktree sits on `main`. A feat
// worktree (branched from main) must seed from the MAIN worktree — provable because seeding
// from dev would also DELETE dev-only.ts (a non-zero −deleted in the reported diff).
{
  const root = mkdtempSync(join(tmpdir(), 'plex-wt-b-'));
  const primary = join(root, 'primary');
  const baseWt = join(root, 'base');
  const featWt = join(root, 'feat');
  try {
    mkdirSync(primary);
    git(primary, 'init', '-q');
    git(primary, 'config', 'user.email', 't@t.dev');
    git(primary, 'config', 'user.name', 'T');
    mkdirSync(join(primary, 'src'));
    writeFileSync(join(primary, 'src/a.ts'), 'export function a() {\n  return 1;\n}\n');
    writeFileSync(join(primary, 'src/b.ts'), 'export function b() {\n  return 2;\n}\n');
    git(primary, 'add', '-A');
    git(primary, 'commit', '-q', '-m', 'init');
    // feat branches from main(a,b); primary then moves onto dev so `main` is free to be
    // checked out in its own worktree (you can't add a second worktree on a checked-out branch).
    git(primary, 'worktree', 'add', '-q', '-b', 'feat', featWt, 'main');
    git(primary, 'checkout', '-q', '-b', 'dev');
    git(primary, 'worktree', 'add', '-q', baseWt, 'main');
    writeFileSync(join(primary, 'src/dev-only.ts'), 'export function dev() {\n  return 0;\n}\n');
    git(primary, 'add', '-A');
    git(primary, 'commit', '-q', '-m', 'dev-only file');
    writeFileSync(join(featWt, 'src/c.ts'), 'export function c() {\n  return 3;\n}\n');
    git(featWt, 'add', '-A');
    git(featWt, 'commit', '-q', '-m', 'add c');

    // Index BOTH candidate bases so the choice is real: primary(dev) and base(main).
    assert(cli(['index', primary], primary).code === 0, 'index primary(dev) ok');
    assert(cli(['index', baseWt], baseWt).code === 0, 'index base(main) ok');

    const r = seedIndex(featWt);
    assert(r.signal !== 'SIGSEGV' && r.code === 0, `index feat crashed/failed (signal=${r.signal} code=${r.code}): ${r.out}`);
    assert(/Seeded from base worktree/.test(r.out), `expected seed, got: ${r.out}`);
    // main→feat = +c only. dev→feat would also be −dev-only.ts → seeding from dev shows -1.
    assert(/\(\+1 ~0 -0\)/.test(r.out), `seeded from the default-branch (main) worktree, not primary(dev): ${r.out}`);
    console.log('✓ worktree-seed B: base chosen from the default branch, not the primary worktree');
  } finally {
    try { git(primary, 'worktree', 'remove', '--force', featWt); } catch {}
    try { git(primary, 'worktree', 'remove', '--force', baseWt); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ worktree-seed: ADR-32 seed, self-refresh, default-branch base, no SIGSEGV (node / built CLI)');
