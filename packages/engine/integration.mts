/**
 * Integration runner (run with `pnpm test:integration`).
 *
 * The Kùzu native addon does not survive vitest's worker-process teardown (tests pass
 * but the worker crashes on shutdown — see docs/adr ADR-16/M1 notes). A plain tsx
 * process exits cleanly, so the DB-and-subprocess-heavy scenarios live here instead of
 * in vitest, which keeps to pure unit tests.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type NormalizedDiff } from '@plex/core';
import {
  buildCodeGraph,
  updateCodeGraph,
  CodeGraphDB,
  getSymbolsInFile,
  getCoChangeEdges,
  getImportEdges,
  getRefEdges,
  getMeta,
} from '@plex/code-graph';
import { computeNeighborhood, publishNeighborhood } from '@plex/neighborhood';
import {
  indexRepo,
  assembleReviewContext,
  recordVerdict,
  readVerdicts,
  rankReviewFindings,
  seedKnowledge,
  submitVerdict,
  knowledgeStore,
} from './src/index';

const FALKOR_URL = process.env.PLEX_FALKORDB_URL ?? 'redis://localhost:6380';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Build a temp repo: db.ts + user.ts (user imports db) + util.ts, with co-change history. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-it-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/db.ts'), 'export function insert(u: unknown) {\n  return u;\n}\n');
  writeFileSync(
    join(repo, 'src/user.ts'),
    "import { insert } from './db';\nexport class UserService {\n  save(u: unknown) {\n    insert(u);\n  }\n}\n",
  );
  writeFileSync(join(repo, 'src/util.ts'), 'export const noop = () => {};\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  for (let i = 0; i < 3; i++) {
    appendFileSync(join(repo, 'src/db.ts'), `// rev ${i}\n`);
    appendFileSync(join(repo, 'src/user.ts'), `// rev ${i}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `couple ${i}`);
  }
  return repo;
}

const COCHANGE = { maxCommitFiles: 25, halfLifeDays: 365, minPairCount: 2, maxCommits: 0 };

type Scenario = { id: string; name: string; fn: () => Promise<void> };
const scenarios: Scenario[] = [];
const test = (id: string, name: string, fn: () => Promise<void>) => scenarios.push({ id, name, fn });

test('build', 'code-graph: build extracts files, symbols, imports, co-change', async () => {
  const repo = makeRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-db-')), 'g.kuzu');
  try {
    const res = await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    assert.equal(res.files, 3);
    assert.ok(res.symbols >= 3, `symbols ${res.symbols}`);
    assert.equal(res.imports, 1);
    assert.equal(res.coChangePairs, 1, 'only the db<->user pair survives minPairCount=2');

    const db = new CodeGraphDB(dbDir);
    try {
      const names = (await getSymbolsInFile(db, 'src/user.ts')).map((s) => s.name);
      assert.ok(names.includes('UserService') && names.includes('UserService.save'), names.join(','));
      assert.ok((await getCoChangeEdges(db, ['src/user.ts'])).some((e) => e.dst === 'src/db.ts'));
      assert.ok((await getImportEdges(db, ['src/user.ts'])).some((e) => e.dst === 'src/db.ts'));
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('neighborhood', 'neighborhood: maps hunk to symbols and finds coupled neighbor', async () => {
  const repo = makeRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-db-')), 'g.kuzu');
  try {
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    const diff: NormalizedDiff = {
      baseRef: 'HEAD',
      files: [
        {
          path: 'src/user.ts',
          status: 'modified',
          hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, newRanges: [{ start: 3, end: 4 }] }],
        },
      ],
    };
    const db = new CodeGraphDB(dbDir);
    try {
      const nb = await computeNeighborhood(db, 'r', diff, { maxHops: 2, maxNeighbors: 40, minScore: 0.01 });
      assert.ok(nb.changed.map((c) => c.symbol).includes('UserService.save'));
      const dbN = nb.neighbors.find((n) => String(n.node.props.path) === 'src/db.ts');
      assert.ok(dbN, 'db.ts neighbor present');
      assert.deepEqual(dbN!.via.sort(), ['co-change', 'import']);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('engine', 'engine: index -> assemble review context -> capture verdict', async () => {
  const repo = makeRepo();
  appendFileSync(join(repo, 'src/user.ts'), '\nexport function extra() {\n  return 1;\n}\n');
  git(repo, 'add', '-A');
  const config = resolveConfig();
  try {
    const res = await indexRepo(repo, config);
    assert.equal(res.files, 3);
    const ctx = await assembleReviewContext({ repoPath: repo, config, mode: 'staged' });
    assert.ok(ctx.changed.map((c) => c.symbol).includes('extra'));
    assert.ok(ctx.blastRadius.some((n) => String(n.node.props.path) === 'src/db.ts'));
    await recordVerdict(repo, { findingId: 'f1', kind: 'waive', scope: 'file' }, config);
    const verdicts = await readVerdicts(repo, config);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.findingId, 'f1');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('falkor', 'neighborhood: FalkorDB publish (best-effort)', async () => {
  const nb = {
    repo: 'r',
    changed: [{ repo: 'r', file: 'src/user.ts', startLine: 1, endLine: 2, symbol: 'X' }],
    neighbors: [
      { node: { id: 'src/db.ts', label: 'File' as const, props: { path: 'src/db.ts' } }, score: 1, via: ['co-change' as const], distance: 1 },
    ],
  };
  const res = await publishNeighborhood('pr_integration_test', nb, { url: FALKOR_URL });
  if (!res.published) {
    console.log(`  (skipped: FalkorDB not reachable at ${FALKOR_URL} — ${res.reason})`);
  }
});

test('incremental', 'code-graph: incremental update (ADR-25) — add/modify/delete, preserve incoming edges', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-inc-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-incdb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/b.ts'), 'export function b() {\n  return 1;\n}\n');
    writeFileSync(join(repo, 'src/a.ts'), "import { b } from './b';\nexport function a() {\n  return b();\n}\n");
    writeFileSync(join(repo, 'src/c.ts'), 'export const gone = true;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    // mutate: modify b (new symbol), delete c, add d — then commit (new HEAD).
    writeFileSync(join(repo, 'src/b.ts'), 'export function b() {\n  return 1;\n}\nexport function b2() {\n  return 2;\n}\n');
    rmSync(join(repo, 'src/c.ts'));
    writeFileSync(join(repo, 'src/d.ts'), 'export const fresh = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mutate');

    const res = await updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    assert.equal(res.incremental, true);
    assert.ok(res.added >= 1 && res.deleted >= 1 && res.modified >= 1, `delta a=${res.added} m=${res.modified} d=${res.deleted}`);

    const db = new CodeGraphDB(dbDir);
    try {
      const cGone = await db.run("MATCH (f:File {id:'src/c.ts'}) RETURN f.id AS id", {});
      assert.equal(cGone.length, 0, 'deleted file node removed');
      const dAdded = await db.run("MATCH (f:File {id:'src/d.ts'}) RETURN f.id AS id", {});
      assert.equal(dAdded.length, 1, 'added file node present');
      const bSyms = await getSymbolsInFile(db, 'src/b.ts');
      assert.ok(bSyms.some((s) => s.name === 'b2'), 'modified file re-extracted (new symbol b2)');
      const aImports = await getImportEdges(db, ['src/a.ts']);
      assert.ok(aImports.some((e) => e.dst === 'src/b.ts'), 'incoming edge a->b survived b being modified');
      const stamped = await getMeta(db, 'headSha');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
      assert.equal(stamped, head, 'headSha re-stamped to current HEAD');
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('precise', 'code-graph: precise resolver follows tsconfig path aliases', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-pre-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-predb-')), 'g.kuzu');
  try {
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
    );
    writeFileSync(join(repo, 'src/db.ts'), 'export function insert(u: unknown) {\n  return u;\n}\n');
    writeFileSync(
      join(repo, 'src/user.ts'),
      "import { insert } from '@app/db';\nexport function save(u: unknown) {\n  return insert(u);\n}\n",
    );
    const res = await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    assert.ok(res.refs >= 1, `expected precise refs, got ${res.refs}`);
    const db = new CodeGraphDB(dbDir);
    try {
      const refs = await getRefEdges(db, ['src/user.ts']);
      assert.ok(refs.some((e) => e.dst === 'src/db.ts'), 'alias import @app/db resolved to src/db.ts');
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('ranking', 'engine: merged ranked stream (agent + deterministic + waiver)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-rank-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'src/a.ts'), 'export function f(items: any[]) {\n  debugger;\n  return items;\n}\n');
    git(repo, 'add', '-A');

    const config = resolveConfig();
    const ranked = await rankReviewFindings(
      repo,
      config,
      [{ title: 'Possible null deref', severity: 'bug', confidence: 0.7, file: 'src/a.ts', startLine: 3, source: 'first-principles' }],
      { mode: 'staged' },
    );
    assert.ok(ranked.some((r) => r.tags?.includes('no-debugger')), 'deterministic debugger finding merged in');
    assert.ok(ranked.some((r) => r.title === 'Possible null deref'), 'agent finding present');
    assert.equal(ranked[0]!.triage, 'surface');
    assert.equal(ranked[0]!.severity, 'bug');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('knowledge', 'engine: seed -> review retrieves pitfalls -> learn on accept', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-kn-'));
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'reviewer-kdir-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(
      join(repo, 'plex.md'),
      '## Validation\n- Always validate user input before inserting into the database\n',
    );
    writeFileSync(join(repo, 'src/db.ts'), 'export const db = { insertUser(u: unknown) { return u; } };\n');
    writeFileSync(
      join(repo, 'src/user.ts'),
      "import { db } from './db';\nexport function saveUser(input: unknown) {\n  db.insertUser(input);\n}\n",
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    appendFileSync(
      join(repo, 'src/user.ts'),
      '\nexport function updateUserInput(input: any) {\n  db.insertUser(input);\n}\n',
    );
    git(repo, 'add', '-A');

    const config = resolveConfig({ knowledgeDir, embedding: { provider: 'fake' } }); // fake = test-only
    const seeded = await seedKnowledge(config, readFileSync(join(repo, 'plex.md'), 'utf8'));
    assert.ok(seeded >= 1, `seeded ${seeded}`);

    await indexRepo(repo, config);
    const ctx = await assembleReviewContext({ repoPath: repo, config, mode: 'staged' });
    assert.ok(ctx.knowledge.length >= 1, 'retrieved at least one relevant pitfall');
    assert.ok(ctx.knowledge[0]!.pitfall.title.toLowerCase().includes('validate'), 'retrieved the validation pitfall');

    await submitVerdict(repo, { findingId: 'f1', kind: 'accept', file: 'src/user.ts', title: 'validate input' }, config);
    const incidents = await knowledgeStore(config).incidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]!.outcome, 'accepted');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(knowledgeDir, { recursive: true, force: true });
  }
});

async function main(): Promise<void> {
  // Run one scenario per process (arg = scenario id). The Kùzu native addon under tsx
  // crashes after ~5 cumulative DB opens in a single process; a fresh process per
  // scenario stays well under that. `pnpm test:integration` chains the ids.
  const only = process.argv[2];
  const list = only ? scenarios.filter((s) => s.id === only) : scenarios;
  if (only && list.length === 0) {
    console.error(`unknown scenario: ${only} (have: ${scenarios.map((s) => s.id).join(', ')})`);
    process.exit(2);
  }
  let failed = 0;
  for (const s of list) {
    try {
      await s.fn();
      console.log(`✓ ${s.name}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${s.name}\n  ${e instanceof Error ? e.stack : String(e)}`);
    }
  }
  console.log(`${list.length - failed}/${list.length} scenario(s) passed${only ? ` [${only}]` : ''}.`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
