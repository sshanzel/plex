// Cross-window co-change accumulation check (ADR-26 weak path) under the SHIPPED runtime:
// plain `node` driving the built CLI — each invocation is a fresh, stable node process.
// This deliberately does NOT live in the tsx integration lane: it needs build + update +
// update + read (4 Kùzu opens), which is over the tsx open budget (ADR-17 — the tsx
// `cochange-weak` scenario covers the single-window staging half).
//
//   pnpm build && node scripts/cochange-check.mjs
//
// Asserts: a pair coupling ONCE per incremental window (never reaching minPairCount within
// one) stages in CoChangePending, stays invisible to reads, and PROMOTES to a real
// CoChange edge once its accumulated cnt crosses the threshold — visible in `plex blast`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('cochange-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

const env = { ...process.env, PLEX_DATA_DIR: '.plex' }; // in-repo data dir; no embeddings needed
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const cli = (args, cwd) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const assert = (c, m) => {
  if (!c) {
    console.error(`✗ ${m}`);
    process.exit(1);
  }
  console.log(`✓ ${m}`);
};

const repo = mkdtempSync(join(tmpdir(), 'plex-ccp-'));
try {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  for (const f of ['c', 'd']) writeFileSync(join(repo, `src/${f}.ts`), `export const ${f} = 1;\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init'); // c-d coupled once — below minPairCount=2, pruned

  cli(['index', repo], repo);

  // Window 1: c-d couples once more → staged in CoChangePending, still NOT an edge.
  appendFileSync(join(repo, 'src/c.ts'), '// w1\n');
  appendFileSync(join(repo, 'src/d.ts'), '// w1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'w1');
  const u1 = cli(['index', repo, '--incremental'], repo);
  assert(/\(0 pairs\)/.test(u1), 'window 1: one occurrence stays staged, no pair promoted');
  const b1 = JSON.parse(cli(['blast', repo, '--files', 'src/c.ts'], repo));
  assert(
    !b1.neighbors.some((n) => String(n.node?.props?.path ?? n.node?.id ?? '') === 'src/d.ts'),
    'window 1: staged pair is invisible to reads (no CoChange edge)',
  );

  // Window 2: c-d couples again → accumulated cnt 2 ≥ minPairCount → PROMOTED.
  appendFileSync(join(repo, 'src/c.ts'), '// w2\n');
  appendFileSync(join(repo, 'src/d.ts'), '// w2\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'w2');
  const u2 = cli(['index', repo, '--incremental'], repo);
  assert(/\((\d+) pairs\)/.exec(u2)?.[1] >= 1, 'window 2: crossing the threshold across windows promotes the pair');
  const b2 = JSON.parse(cli(['blast', repo, '--files', 'src/c.ts'], repo));
  assert(
    b2.neighbors.some((n) => String(n.node?.props?.path ?? n.node?.id ?? '') === 'src/d.ts'),
    'window 2: the promoted pair is a real CoChange edge (visible in blast)',
  );

  console.log('cochange-check: all assertions passed.');
} finally {
  rmSync(repo, { recursive: true, force: true });
}
