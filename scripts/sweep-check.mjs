// Maintenance-worker E2E (ADR-43) under the SHIPPED runtime: plain `node` driving the built CLI
// (`dist/plex.js`). The worker opens Kùzu several times per run (enumerate targets + reconcile +
// re-index main), so it is a NODE-only check — tsx's ~5-open limit (ADR-17) would crash it, exactly
// like brain-check. Requires a build (`pnpm build`).
//
//   pnpm build && pnpm test:sweep
//
// It proves the worker runs end to end: it resolves + refreshes `main`'s graph when stale, manages
// its cursor/debounce/lock sidecars, releases the lock, and is idempotent (a second run finds the
// graph fresh and does nothing). The loop-closure (reconcile) path is covered by the `reconcile`
// integration scenario + the pure sweep units; the built CLI can't seed a brain finding to close.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('sweep-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

// Isolate the GLOBAL knowledge dir to a throwaway path — the consolidate job would otherwise touch
// the developer's real ~/.plex/knowledge (PLEX_DATA_DIR only scopes per-repo data, not the global KB).
const KDIR = mkdtempSync(join(tmpdir(), 'plex-sweep-k-'));
const env = { ...process.env, PLEX_EMBEDDING_PROVIDER: 'none', PLEX_DATA_DIR: '.plex', PLEX_KNOWLEDGE_DIR: KDIR };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const cli = (args, cwd) => {
  // Retry the transient Kùzu-native SIGSEGV (ADR-17) — a native crash, not a logic failure; the
  // worker's jobs are idempotent, so a fresh process recovers. Only SIGSEGV retries.
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    } catch (e) {
      if (e.signal === 'SIGSEGV' && i < 8) continue;
      throw e;
    }
  }
};
const assert = (c, m) => {
  if (!c) {
    console.error('✗ sweep-check: ' + m);
    process.exit(1);
  }
};

const repo = mkdtempSync(join(tmpdir(), 'plex-sweep-'));
try {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  // Index once (builds the graph + stamps head.sha), then advance HEAD so the graph is stale.
  cli(['index', repo], repo);
  const headFile = join(repo, '.plex', 'head.sha');
  assert(existsSync(headFile), 'index stamped head.sha');
  const sha1 = readFileSync(headFile, 'utf8').trim();
  appendFileSync(join(repo, 'src/a.ts'), 'export const y = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'advance');
  const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  assert(sha1 !== sha2, 'HEAD advanced past the indexed sha (graph is now stale)');

  // Run the worker. It resolves main (= this repo) and refreshes its graph.
  const out = cli(['sweep', repo], repo);
  assert(/graph:/.test(out), `sweep ran the graph job (${out.trim()})`);
  assert(readFileSync(headFile, 'utf8').trim() === sha2, 'graph-freshness re-indexed main to the new HEAD');
  assert(existsSync(join(repo, '.plex', 'sweep-state.json')), 'sweep-state.json cursor written');
  assert(!existsSync(join(repo, '.plex', 'sweep.lock')), 'single-flight lock released after the run');

  // Idempotent: a second sweep finds the graph fresh and does nothing (no crash, no re-index).
  const out2 = cli(['sweep', repo], repo);
  assert(/graph fresh/.test(out2), `second sweep: graph job no-op when fresh (${out2.trim()})`);

  console.log('✓ sweep: maintenance worker runs under node — refreshes main, manages sidecars + lock, idempotent (ADR-43)');
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(KDIR, { recursive: true, force: true });
}
