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
import { execFileSync, spawnSync } from 'node:child_process';
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
// Retry the transient Kùzu-native SIGSEGV (ADR-17): a native crash, not a logic failure, and `index`
// is idempotent — a fresh child recovers. Only SIGSEGV retries; a real failure rethrows immediately.
const cli = (args, cwd) => {
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    } catch (e) {
      if (e.signal === 'SIGSEGV' && i < 8) continue;
      throw e;
    }
  }
};
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

  // Eviction: a staged pair that does NOT recur within a half-life ages out instead of
  // promoting at full undecayed weight. Stage e-f once (window 3), backdate its `ts`
  // beyond the half-life, then co-change it once more (window 4): with eviction the lane
  // was swept first, so the pair restarts at cnt 1 — no promotion. (Without eviction the
  // backdated cnt-1 row would reach cnt 2 and promote.)
  for (const f of ['e', 'f']) writeFileSync(join(repo, `src/${f}.ts`), `export const ${f} = 1;\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'w3 add ef'); // e-f coupled once → staged
  cli(['index', repo, '--incremental'], repo);

  // Backdate the pending lane in a CHILD node process: the Kùzu addon can SIGSEGV at
  // process exit after direct use, so the child's exit code is ignored — if the backdate
  // silently failed, the eviction assertion below fails loudly anyway.
  // Written into the repo root (not tmpdir) so the bare `kuzu` import resolves against
  // this repo's node_modules.
  const backdate = resolve(`.ccp-backdate-${process.pid}.tmp.mjs`);
  writeFileSync(
    backdate,
    `import { Database, Connection } from 'kuzu';
const db = new Database(${JSON.stringify(join(repo, '.plex', 'graph.kuzu'))});
const conn = new Connection(db);
const prep = await conn.prepare('MATCH (a:File)-[p:CoChangePending]->(b:File) SET p.ts = $ts');
await conn.execute(prep, { ts: 1.0 });
await conn.close();
await db.close();
console.log('backdated');
`,
  );
  const bd = spawnSync(process.execPath, [backdate], { cwd: resolve('.'), stdio: 'pipe' });
  rmSync(backdate, { force: true });
  if (!String(bd.stdout).includes('backdated')) {
    console.error(`✗ backdate helper did not run: ${bd.stderr}`);
    process.exit(1);
  }

  appendFileSync(join(repo, 'src/e.ts'), '// w4\n');
  appendFileSync(join(repo, 'src/f.ts'), '// w4\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'w4');
  const u4 = cli(['index', repo, '--incremental'], repo);
  assert(/\(0 pairs\)/.test(u4), 'eviction: a pair staged a half-life ago ages out — no stale promotion');

  console.log('cochange-check: all assertions passed.');
} finally {
  rmSync(repo, { recursive: true, force: true });
}
