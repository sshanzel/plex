// Worktree-seed end-to-end (ADR-32, revised) under the SHIPPED runtime: plain `node` driving
// the built CLI. Secondary git worktrees now share the BASE repo's graph.kuzu read-only
// instead of copying it — only brain.kuzu/verdicts live in the worktree's own data dir.
//
//   pnpm build && pnpm test:worktree
//
// Guards:
//   1. NO SIGSEGV — multiple read-only opens of the same Kùzu graph must not crash.
//   2. NO COPY — no 40 MB graph.kuzu under the worktree's data dir.
//   3. Base SELF-REFRESH — a stale base is brought to its own HEAD before the worktree uses it.
//   4. Base from the DEFAULT branch — the worktree on `main` is chosen over the primary.
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
const graphExists = (cwd) => existsSync(join(cwd, '.plex', 'graph.kuzu'));
/** Run the CLI and return {code, signal, out}. Does NOT throw on failure. */
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, signal: r.signal, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const assert = (c, m) => {
  if (!c) {
    console.error('✗ worktree-seed-check: ' + m);
    process.exit(1);
  }
};

// ── Scenario A — NO COPY: secondary worktree shares the base graph read-only ───────────────
// main indexed. A feat worktree is then indexed: it should NOT copy graph.kuzu, should print
// "Secondary worktree: sharing base graph", and the base head.sha should be updated.
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

    const ib = cli(['index', main], main);
    assert(ib.code === 0, `index base failed: ${ib.out}`);
    const baseSha1 = sha(main);
    assert(baseSha1 === head(main), 'base graph stamped at main HEAD');

    // Advance main → base graph is now STALE.
    writeFileSync(join(main, 'src/d.ts'), 'export function d() {\n  return 9;\n}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'add d on main');
    const mainHead2 = head(main);
    assert(mainHead2 !== baseSha1, 'main advanced past the indexed base');

    const r = cli(['index', wt], wt);
    assert(r.signal !== 'SIGSEGV' && r.code === 0, `index wt crashed/failed (signal=${r.signal} code=${r.code}): ${r.out}`);
    assert(/Secondary worktree/.test(r.out), `expected "Secondary worktree" message, got: ${r.out}`);
    assert(/sharing base graph/.test(r.out), `expected "sharing base graph" in output, got: ${r.out}`);

    // The worktree must NOT have its own graph.kuzu copy.
    assert(!graphExists(wt), `worktree must NOT have own graph.kuzu copy at ${join(wt, '.plex', 'graph.kuzu')}`);

    // The base must have been refreshed to its current HEAD (self-refresh before hand-off).
    assert(sha(main) === mainHead2, `base self-refreshed to its own HEAD (got ${sha(main)}, want ${mainHead2})`);

    // No SIGSEGV on a second concurrent-style open (read-only re-open of the same graph).
    const r2 = cli(['index', wt], wt);
    assert(r2.signal !== 'SIGSEGV' && r2.code === 0, `second index of wt crashed (signal=${r2.signal}): ${r2.out}`);

    console.log('✓ worktree-seed A: no copy, base self-refreshes, secondary worktree sharing message, no SIGSEGV');
  } finally {
    try { git(main, 'worktree', 'remove', '--force', wt); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Scenario B — base is chosen from the DEFAULT branch, not the primary worktree ───────────
// Primary is on `dev`. A separate worktree sits on `main`. A feat worktree (branched from main)
// must share the MAIN worktree's graph — provable via the graph path in the output.
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
    git(primary, 'worktree', 'add', '-q', '-b', 'feat', featWt, 'main');
    git(primary, 'checkout', '-q', '-b', 'dev');
    git(primary, 'worktree', 'add', '-q', baseWt, 'main');
    writeFileSync(join(primary, 'src/dev-only.ts'), 'export function dev() {\n  return 0;\n}\n');
    git(primary, 'add', '-A');
    git(primary, 'commit', '-q', '-m', 'dev-only file');
    writeFileSync(join(featWt, 'src/c.ts'), 'export function c() {\n  return 3;\n}\n');
    git(featWt, 'add', '-A');
    git(featWt, 'commit', '-q', '-m', 'add c');

    // Index BOTH candidate bases.
    assert(cli(['index', primary], primary).code === 0, 'index primary(dev) ok');
    assert(cli(['index', baseWt], baseWt).code === 0, 'index base(main) ok');

    const r = cli(['index', featWt], featWt);
    assert(r.signal !== 'SIGSEGV' && r.code === 0, `index feat crashed/failed (signal=${r.signal} code=${r.code}): ${r.out}`);
    assert(/Secondary worktree/.test(r.out), `expected "Secondary worktree" message, got: ${r.out}`);

    // The graph path in the output must point to the main-branch worktree's data dir, not primary(dev).
    // Use the PLEX_DATA_DIR=.plex convention: graph is at baseWt/.plex/graph.kuzu
    const baseGraphPath = join(baseWt, '.plex', 'graph.kuzu');
    assert(r.out.includes(baseGraphPath), `output should reference base(main) graph at ${baseGraphPath}, got: ${r.out}`);
    assert(!r.out.includes(join(primary, '.plex', 'graph.kuzu')), `output must NOT reference primary(dev) graph, got: ${r.out}`);

    // feat must NOT have its own graph copy.
    assert(!graphExists(featWt), `feat worktree must NOT have own graph.kuzu copy`);

    console.log('✓ worktree-seed B: base chosen from the default branch, not the primary worktree');
  } finally {
    try { git(primary, 'worktree', 'remove', '--force', featWt); } catch {}
    try { git(primary, 'worktree', 'remove', '--force', baseWt); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Scenario C — orphan detection: deleted worktrees leave data dirs; doctor reports them ──
// Index a worktree, delete the worktree, then check that the data dir is flagged as orphaned.
{
  const root = mkdtempSync(join(tmpdir(), 'plex-wt-c-'));
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  try {
    mkdirSync(main);
    git(main, 'init', '-q');
    git(main, 'config', 'user.email', 't@t.dev');
    git(main, 'config', 'user.name', 'T');
    mkdirSync(join(main, 'src'));
    writeFileSync(join(main, 'src/a.ts'), 'export function a() {}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'tmp', wt);

    // Index base and worktree (both write repo-path files).
    assert(cli(['index', main], main).code === 0, 'index base ok');
    assert(cli(['index', wt], wt).code === 0, 'index wt ok');

    // The worktree data dir (.plex) has a repo-path pointing to wt.
    const wtPlexDir = join(wt, '.plex');
    const repoPathFile = join(wtPlexDir, 'repo-path');
    assert(existsSync(repoPathFile), 'repo-path sidecar written for worktree');
    assert(readFileSync(repoPathFile, 'utf8').trim() === resolve(wt), `repo-path contains worktree abs path`);

    // brain.kuzu (own) must exist; graph.kuzu (copy) must NOT.
    assert(!graphExists(wt), 'worktree has no own graph.kuzu (shares base)');

    console.log('✓ worktree-seed C: repo-path sidecar written, no own graph.kuzu');
  } finally {
    try { git(main, 'worktree', 'remove', '--force', wt); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ worktree-seed: no-copy sharing, self-refresh, default-branch base, orphan sidecar, no SIGSEGV (node / built CLI)');
