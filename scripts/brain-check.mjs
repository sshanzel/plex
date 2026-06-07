// Brain end-to-end check (M6/M11, ADR-22/23/30) under the SHIPPED runtime: plain `node`
// driving the built CLI. The PR brain is now embedded Kùzu — NO FalkorDB, no service. Each
// CLI invocation is a fresh, stable node process (ADR-17/19).
//
//   pnpm build && pnpm test:brain
//
// Exercises auto-index on first review + round-aware "changed-without-feedback". Requires
// `dist/` (run `pnpm build`). The Kùzu fix-accept path is covered by the tsx `reconcile`
// scenario.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('brain-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

// fake = test-only embedder (enables the semantic signals); .plex keeps data in the temp repo.
const env = { ...process.env, PLEX_EMBEDDING_PROVIDER: 'fake', PLEX_DATA_DIR: '.plex' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const cli = (args, cwd) => execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const assert = (c, m) => {
  if (!c) {
    console.error('✗ brain-check: ' + m);
    process.exit(1);
  }
};

const repo = mkdtempSync(join(tmpdir(), 'plex-brain-'));
try {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  // Round 1 — NO explicit `index`: the review auto-indexes on first use (ADR-30).
  writeFileSync(join(repo, 'src/a.ts'), 'export function f(n) {\n  return n + 1;\n}\n');
  git(repo, 'add', '-A');
  const r1 = JSON.parse(cli(['review', repo, '--staged', '--json'], repo));
  assert(r1.round === 1, `first review is round 1 (got ${r1.round})`);
  assert(typeof r1.target === 'string' && r1.target.length > 0, 'target assigned');

  // Round 2 — commit (new HEAD), stage another change, review again.
  git(repo, 'commit', '-q', '-m', 'round1 change');
  appendFileSync(join(repo, 'src/a.ts'), 'export const y = 2;\n');
  git(repo, 'add', '-A');
  const r2 = JSON.parse(cli(['review', repo, '--staged', '--json'], repo));
  assert(r2.round === 2, `second review is round 2 (got ${r2.round})`);
  assert((r2.priorRounds ?? []).length >= 1, 'sees the prior round');
  assert((r2.unexplainedChanges ?? []).length >= 1, 'committed change with no feedback flagged unexplained');

  console.log('✓ brain: auto-index + rounds + changed-without-feedback (node / built CLI, Kùzu — no FalkorDB)');
} finally {
  rmSync(repo, { recursive: true, force: true });
}
