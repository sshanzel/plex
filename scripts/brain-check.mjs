// Brain end-to-end check (M6, ADR-22/23) under the SHIPPED runtime: plain `node` driving
// the built CLI. The PR brain needs BOTH Kùzu and the FalkorDB worker; those two cannot
// share a tsx process (ADR-16/17), so this can't live in the tsx integration runner —
// but each CLI invocation here is a fresh, stable node process (ADR-19).
//
//   pnpm build && pnpm db:up && pnpm test:brain
//
// Skips cleanly when FalkorDB is unreachable; requires `dist/` (run `pnpm build`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const URL = process.env.PLEX_FALKORDB_URL ?? 'redis://localhost:56379';
const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('brain-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

// PLEX_DATA_DIR='.plex' keeps the graph inside the temp repo so cleanup removes it
// (default is centralized ~/.plex/repos/<id>, which rmSync(repo) wouldn't touch).
const env = { ...process.env, PLEX_FALKORDB_URL: URL, PLEX_EMBEDDING_PROVIDER: 'fake', PLEX_DATA_DIR: '.plex' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const cli = (args, cwd) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const assert = (c, m) => {
  if (!c) {
    console.error('✗ brain-check: ' + m);
    process.exit(1);
  }
};

const repo = mkdtempSync(join(tmpdir(), 'plex-brain-'));
let target;
try {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  cli(['index', repo], repo);

  // Round 1
  writeFileSync(join(repo, 'src/a.ts'), 'export function f(n) {\n  return n + 1;\n}\n');
  git(repo, 'add', '-A');
  let out;
  try {
    out = cli(['review', repo, '--staged', '--falkor', '--json'], repo);
  } catch (e) {
    const msg = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
    if (/unreachable|pnpm db:up|ECONNREFUSED|connect/i.test(msg)) {
      console.log(`(skipped: FalkorDB not reachable at ${URL})`);
      process.exit(0);
    }
    throw e;
  }
  const r1 = JSON.parse(out);
  target = r1.target;
  assert(r1.round === 1, `first review is round 1 (got ${r1.round})`);
  assert(typeof r1.target === 'string' && r1.target.length > 0, 'target assigned');

  // Round 2: commit the change (new HEAD), stage another change, review again.
  git(repo, 'commit', '-q', '-m', 'round1 change');
  appendFileSync(join(repo, 'src/a.ts'), 'export const y = 2;\n');
  git(repo, 'add', '-A');
  const r2 = JSON.parse(cli(['review', repo, '--staged', '--falkor', '--json'], repo));
  assert(r2.round === 2, `second review at a new HEAD is round 2 (got ${r2.round})`);
  assert((r2.priorRounds ?? []).length >= 1, 'sees the prior round');
  assert((r2.unexplainedChanges ?? []).length >= 1, 'committed change with no feedback flagged unexplained');

  // Round 3: autonomous fix inference (ADR-28). Inject a finding into round 2, then make
  // a commit whose content matches it — the next review must auto-accept it (no prompt).
  // (Fake embedder is bag-of-tokens, so identical tokens ⇒ cosine 1.0 ⇒ addressed.)
  const FT = 'alpha beta gamma';
  const gq = (cypher) => execFileSync('redis-cli', ['-u', URL, 'GRAPH.QUERY', target, cypher], { encoding: 'utf8' });
  gq(
    `MATCH (r:Round {target:'${target}', n:2}) MERGE (fi:Finding {id:'injm9'}) ` +
      `SET fi.target='${target}', fi.title='${FT}', fi.file='src/a.ts', fi.line=1 MERGE (fi)-[:IN_ROUND]->(r)`,
  );
  writeFileSync(join(repo, 'src/a.ts'), `// ${FT}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'addresses injm9');
  appendFileSync(join(repo, 'src/a.ts'), 'export const q = 9;\n');
  git(repo, 'add', '-A');
  const r3 = JSON.parse(cli(['review', repo, '--staged', '--falkor', '--json'], repo));
  assert(r3.round === 3, `third review is round 3 (got ${r3.round})`);
  assert((r3.inferredOutcomes ?? 0) >= 1, `addressed finding auto-accepted (inferredOutcomes ${r3.inferredOutcomes})`);
  assert(/fixed/.test(gq("MATCH (fi:Finding {id:'injm9'}) RETURN fi.outcome")), 'finding marked fixed in the brain');

  console.log('✓ brain: rounds + changed-without-feedback + autonomous fix-accept (node / built CLI)');
} finally {
  if (target) {
    try {
      execFileSync('redis-cli', ['-u', URL, 'GRAPH.DELETE', target], { stdio: 'pipe' });
    } catch {
      /* best-effort cleanup */
    }
  }
  rmSync(repo, { recursive: true, force: true });
}
