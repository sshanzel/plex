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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, appendFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { resolveConfig, symbolKey, type LanguagePlugin, type NormalizedDiff } from '@plex/core';
import {
  buildCodeGraph,
  updateCodeGraph,
  FullRebuildRequired,
  CodeGraphDB,
  getSymbolsInFile,
  getCoChangeEdges,
  getImportEdges,
  getRefEdges,
  getMeta,
  pluginFor,
} from '@plex/code-graph';
import { computeNeighborhood } from '@plex/neighborhood';
import { runDeterministic } from '@plex/deterministic';
import { getChangedFileTexts } from '@plex/ingest';
import { createEmbeddingProvider } from '@plex/knowledge';
import {
  indexRepo,
  assembleReviewContext,
  recordVerdict,
  readVerdicts,
  rankReviewFindings,
  submitVerdict,
  knowledgeStore,
  recordFixAccepts,
  rankingQuality,
  reviewTarget,
  reviewTargetFor,
  loadSuppressions,
  migrateRenamedAnchors,
  Brain,
} from './src/index';

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

test('gitignore-robust', 'code-graph: skips .gitignored files + survives duplicate symbol ids', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-gi-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-gidb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'report'));
    // A tracked source file with TWO same-named declarations on ONE line — the minified-bundle shape
    // that produced `file#name#startLine` PK collisions and crashed the whole index pre-fix.
    writeFileSync(join(repo, 'src/dup.js'), 'function h(){}function h(){}\n');
    // A gitignored build-output file — must NOT be indexed (the `playwright-report` bite).
    writeFileSync(join(repo, '.gitignore'), 'report/\n');
    writeFileSync(join(repo, 'report/ignored.ts'), 'export function secret() {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    // An UNTRACKED but NOT-ignored source file (created mid-feature, not yet `git add`ed) — must STILL
    // be indexed (`git ls-files --others --exclude-standard`), so a review's blast radius isn't empty
    // for its own new files. Left uncommitted on purpose.
    writeFileSync(join(repo, 'src/fresh.ts'), 'export function brandNew() {}\n');

    const res = await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE }); // must NOT throw on the dup PK
    const db = new CodeGraphDB(dbDir);
    try {
      const dup = (await getSymbolsInFile(db, 'src/dup.js')).map((s) => s.name);
      assert.deepEqual(dup.sort(), ['h', 'h'], `both duplicate symbols survived: ${dup.join(',')}`);
      // The gitignored file is absent: no File node, no `secret` symbol anywhere.
      assert.equal((await getSymbolsInFile(db, 'report/ignored.ts')).length, 0, 'gitignored file not indexed');
      // The untracked-not-ignored file IS indexed (working tree minus ignores, not tracked-only).
      assert.deepEqual((await getSymbolsInFile(db, 'src/fresh.ts')).map((s) => s.name), ['brandNew'], 'untracked-not-ignored file indexed');
      assert.equal(res.files, 2, `tracked dup.js + untracked fresh.ts indexed, report/ excluded (got ${res.files})`);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

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

      // A pure DELETION still produces a blast radius: the deleted file's node + edges are
      // in the (pre-deletion) graph, so its dependents surface — deleting a widely-used
      // module is the strongest breakage signal, not an empty radius. Same db handle (ADR-17).
      const delDiff: NormalizedDiff = {
        baseRef: 'HEAD',
        files: [{ path: 'src/user.ts', status: 'deleted', hunks: [] }],
      };
      const nbDel = await computeNeighborhood(db, 'r', delDiff, { maxHops: 2, maxNeighbors: 40, minScore: 0.01 });
      assert.equal(nbDel.changed[0]?.file, 'src/user.ts');
      assert.ok(
        nbDel.neighbors.some((n) => String(n.node.props.path) === 'src/db.ts'),
        'deletion surfaces dependents',
      );
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('blast-hub', "neighborhood: a changed barrel's importers are damped vs a direct coupling (hub fix)", async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-hub-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-hubdb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    // barrel.ts is a HUB (imported by 6 files); svc.ts is a DIRECT coupling (imported by exactly 1).
    writeFileSync(join(repo, 'src/barrel.ts'), 'export const reg = 1;\n');
    for (let i = 0; i < 6; i++) writeFileSync(join(repo, `src/c${i}.ts`), `import { reg } from './barrel';\nexport const c${i} = reg;\n`);
    writeFileSync(join(repo, 'src/svc.ts'), 'export const svc = 1;\n');
    writeFileSync(join(repo, 'src/solo.ts'), "import { svc } from './svc';\nexport const solo = svc;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init'); // single commit + minPairCount 2 ⇒ no co-change edges survive

    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    const oneLine = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, newRanges: [{ start: 1, end: 1 }] };
    const diff: NormalizedDiff = {
      baseRef: 'HEAD',
      files: [
        { path: 'src/barrel.ts', status: 'modified', hunks: [oneLine] },
        { path: 'src/svc.ts', status: 'modified', hunks: [oneLine] },
      ],
    };
    const db = new CodeGraphDB(dbDir);
    try {
      // PPR damps the barrel natively: its 6 importers split the walk's mass 6 ways, while svc's
      // lone importer gets it all — so a barrel importer must rank below the direct coupling.
      const nb = await computeNeighborhood(db, 'r', diff, { maxHops: 2, maxNeighbors: 40, minScore: 0.001 });
      const score = (p: string) => nb.neighbors.find((n) => String(n.node.props.path) === p)?.score ?? 0;
      const solo = score('src/solo.ts'); // importer of the LOW-degree svc → full weight
      const c0 = score('src/c0.ts'); //     importer of the HIGH-degree barrel → damped
      assert.ok(solo > 0, 'direct coupling (solo) present');
      assert.ok(c0 > 0, 'barrel importer present — damped, not dropped');
      assert.ok(solo > c0, `direct coupling ${solo.toFixed(3)} must outrank a barrel importer ${c0.toFixed(3)}`);
      assert.ok(c0 < 0.4, `barrel importer ${c0.toFixed(3)} is below the undamped import weight (0.4)`);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('blast-barrel', 'neighborhood: a barrel/re-export file is transparent — excluded from the radius, consumers surface through it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-bar-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-bardb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    // index.ts is a PURE BARREL: 0 own symbols, only `export … from` re-exports (a/b/c).
    writeFileSync(join(repo, 'src/index.ts'), "export * from './a';\nexport * from './b';\nexport * from './c';\n");
    for (const m of ['a', 'b', 'c']) writeFileSync(join(repo, `src/${m}.ts`), `export const ${m} = 1;\n`);
    // 5 consumers import from the barrel — so a.ts → consumers is reachable ONLY via index.ts.
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, `src/u${i}.ts`), `import { a } from './index';\nexport const u${i} = a;\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init'); // single commit ⇒ no co-change edges (minPairCount 2) — barrel is the only path

    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    const oneLine = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, newRanges: [{ start: 1, end: 1 }] };
    const diff: NormalizedDiff = {
      baseRef: 'HEAD',
      files: [{ path: 'src/a.ts', status: 'modified', hunks: [oneLine] }], // change a re-exported module
    };
    const db = new CodeGraphDB(dbDir);
    try {
      const nb = await computeNeighborhood(db, 'r', diff, { maxHops: 2, maxNeighbors: 40, minScore: 0.001 });
      const score = (p: string) => nb.neighbors.find((n) => String(n.node.props.path) === p)?.score ?? 0;
      // The barrel is plumbing, not a reviewable neighbor — it must be absent from the radius…
      assert.equal(score('src/index.ts'), 0, 'barrel (index.ts) is transparent — excluded from the blast radius');
      // …and its consumers, reachable ONLY through it, must still surface (mass passed through).
      const consumers = [0, 1, 2, 3, 4].map((i) => score(`src/u${i}.ts`));
      assert.ok(consumers.every((s) => s > 0), `all barrel consumers surface through the transparent barrel (${consumers.map((s) => s.toFixed(3)).join(', ')})`);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('cochange-hub', 'neighborhood: a promiscuous co-change file is damped vs an exclusive coupling (assoc. strength)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-coh-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-cohdb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    for (const f of ['seed', 'exclusive', 'promiscuous', 'o1', 'o2', 'o3', 'o4']) writeFileSync(join(repo, `src/${f}.ts`), `export const ${f} = 1;\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init'); // single commit + minPairCount 2 ⇒ no co-change from the build

    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    const db = new CodeGraphDB(dbDir);
    try {
      // Craft co-change: `exclusive` partners ONLY with seed; `promiscuous` partners with seed + 4 others.
      // Degrees ⇒ assoc(seed,exclusive)=1/√(2·1)=0.71  vs  assoc(seed,promiscuous)=1/√(2·5)=0.32.
      const co = [
        ['src/seed.ts', 'src/exclusive.ts'],
        ['src/seed.ts', 'src/promiscuous.ts'],
        ['src/promiscuous.ts', 'src/o1.ts'],
        ['src/promiscuous.ts', 'src/o2.ts'],
        ['src/promiscuous.ts', 'src/o3.ts'],
        ['src/promiscuous.ts', 'src/o4.ts'],
      ];
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) CREATE (a)-[:CoChange {weight:$w, cnt:$c}]->(b)',
        co.map(([a, b]) => ({ a, b, w: 1.0, c: 2 })),
      );

      const diff: NormalizedDiff = {
        baseRef: 'HEAD',
        files: [{ path: 'src/seed.ts', status: 'modified', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, newRanges: [{ start: 1, end: 1 }] }] }],
      };
      const nb = await computeNeighborhood(db, 'r', diff, { maxHops: 2, maxNeighbors: 40, minScore: 0.001 });
      const score = (p: string) => nb.neighbors.find((n) => String(n.node.props.path) === p)?.score ?? 0;
      const exclusive = score('src/exclusive.ts');
      const promiscuous = score('src/promiscuous.ts');
      assert.ok(exclusive > 0, 'exclusive coupling present');
      assert.ok(promiscuous > 0, 'promiscuous co-change present (damped, not dropped)');
      assert.ok(exclusive > promiscuous, `exclusive ${exclusive.toFixed(3)} must outrank promiscuous ${promiscuous.toFixed(3)}`);
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
  const config = resolveConfig({ dataDir: '.plex' });
  try {
    const res = await indexRepo(repo, config);
    assert.equal(res.files, 3);
    const ctx = await assembleReviewContext({ repoPath: repo, config, mode: 'staged' });
    assert.ok(ctx.changed.map((c) => c.symbol).includes('extra'));
    assert.ok(ctx.blastRadius.some((n) => String(n.node.props.path) === 'src/db.ts'));
    assert.ok(ctx.reviewPlan, 'reviewPlan present');
    assert.equal(ctx.reviewPlan!.strategy, 'single', 'a 1-file change stays single (below minFiles)');
    // No embedding provider configured here → the context carries the one-line onboarding nudge
    // for the agent to surface (points at `plex init`, never asks for the key in chat).
    assert.ok(
      ctx.notes.some((n) => n.toLowerCase().includes('embeddings are off') && n.includes('npx @sshanzel/plex init')),
      'embeddings-off onboarding note is present when no provider is configured',
    );
    await recordVerdict(repo, { findingId: 'f1', kind: 'waive', scope: 'file' }, config);
    const verdicts = await readVerdicts(repo, config);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.findingId, 'f1');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('review-plan', 'engine: reviewPlan fans out into coupled clusters (parallel-review wiring)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-rp-'));
  const config = resolveConfig({ dataDir: '.plex' });
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    // Two INDEPENDENT import chains: cluster A (a0<-a1<-a2), cluster B (b0<-b1<-b2). No edge
    // crosses the two, so changedFileCoupling must partition them into separate review units.
    writeFileSync(join(repo, 'src/a0.ts'), 'export const a0 = 0;\n');
    writeFileSync(join(repo, 'src/a1.ts'), "import { a0 } from './a0';\nexport const a1 = a0 + 1;\n");
    writeFileSync(join(repo, 'src/a2.ts'), "import { a1 } from './a1';\nexport const a2 = a1 + 1;\n");
    writeFileSync(join(repo, 'src/b0.ts'), 'export const b0 = 0;\n');
    writeFileSync(join(repo, 'src/b1.ts'), "import { b0 } from './b0';\nexport const b1 = b0 + 1;\n");
    writeFileSync(join(repo, 'src/b2.ts'), "import { b1 } from './b1';\nexport const b2 = b1 + 1;\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    await indexRepo(repo, config); // import edges are extracted from this committed state

    // Stage a large change across all 6 files so we clear minFiles (6) AND minSurface (150).
    const filler = (tag: string): string =>
      '\n' + Array.from({ length: 30 }, (_, i) => `export const ${tag}_${i} = ${i};`).join('\n') + '\n';
    for (const f of ['a0', 'a1', 'a2', 'b0', 'b1', 'b2']) appendFileSync(join(repo, `src/${f}.ts`), filler(f));
    git(repo, 'add', '-A'); // staged → HEAD unchanged → graph stays fresh (no re-index)

    const ctx = await assembleReviewContext({ repoPath: repo, config, mode: 'staged' });
    assert.ok(ctx.reviewPlan, 'reviewPlan present');
    assert.equal(ctx.reviewPlan!.strategy, 'parallel', 'big multi-cluster change fans out');
    assert.equal(ctx.reviewPlan!.units.length, 2, 'one review unit per import cluster');
    const sets = ctx.reviewPlan!.units.map((u) => u.files.map((p) => basename(p, '.ts')).sort().join(',')).sort();
    assert.deepEqual(sets, ['a0,a1,a2', 'b0,b1,b2'], 'units partition exactly by coupling');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('brain', 'engine: durable JSONL lineage brain — rounds, findings, comments, outcome (ADR-46)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-brain-'));
  const config = resolveConfig({ dataDir: '.plex' });
  const target = 'r__staged';
  try {
    const brain = await Brain.open(repo, config);
    try {
      assert.equal((await brain.loadRoundState(target)).lastN, 0, 'fresh target');
      await brain.recordRound(target, { target, n: 1, ts: 'now', headSha: 'sha1', baseRef: 'main' }, [
        { id: 'c1', file: 'a.ts', line: 1, body: 'this fires twice' },
      ]);
      await brain.writeFindings(target, 1, [
        { id: 'agent:0', title: 'venue_opened double-fire', body: '', severity: 'bug', confidence: 0.6, source: 'first-principles', location: { repo: 'r', file: 'a.ts', startLine: 1, endLine: 1 }, signal: 0.4, agreedSources: ['first-principles'], triage: 'surface' },
      ]);

      let st = await brain.loadRoundState(target);
      assert.equal(st.lastN, 1);
      assert.equal(st.lastHeadSha, 'sha1');
      assert.equal(st.priorFindings.length, 1, 'one un-outcomed finding');
      assert.ok(st.signals.some((s) => s.label.startsWith('finding:')) && st.signals.some((s) => s.label.startsWith('comment:')), 'finding + comment signals');

      // C-G1: re-raising the SAME defect (file+line+title) in a later round must reuse the node —
      // round is NOT part of the Finding identity. With round in the key this minted a 2nd node, so
      // when the fix landed every duplicate auto-accepted (multiple incidents) and un-fixed findings
      // piled up one orphaned un-outcomed node per round.
      await brain.recordRound(target, { target, n: 2, ts: 'now', headSha: 'sha2', baseRef: 'main' }, []);
      await brain.writeFindings(target, 2, [
        { id: 'agent:0', title: 'venue_opened double-fire', body: '', severity: 'bug', confidence: 0.6, source: 'first-principles', location: { repo: 'r', file: 'a.ts', startLine: 1, endLine: 1 }, signal: 0.4, agreedSources: ['first-principles'], triage: 'surface' },
      ]);
      st = await brain.loadRoundState(target);
      assert.equal(st.priorFindings.length, 1, 're-raised finding reuses the SAME node (round-free identity), not a duplicate');

      await brain.markFindingOutcome(st.priorFindings[0]!.id, 'fixed');
      st = await brain.loadRoundState(target);
      assert.equal(st.priorFindings.length, 0, 'outcome resolves the finding');
    } finally {
      await brain.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ranking-eval', 'engine: rankingQuality scores the signal ranking against outcomes (nDCG)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-rankeval-'));
  const config = resolveConfig({ dataDir: '.plex' });
  const target = 'r__staged';
  const mk = (title: string, signal: number, file: string, line: number, feat?: { blast?: number; prev?: number; sources?: ('first-principles' | 'deterministic')[] }) =>
    ({ id: title, title, body: '', severity: 'bug' as const, confidence: 0.6, source: 'first-principles' as const, location: { repo: 'r', file, startLine: line, endLine: line }, signal, blastRadius: feat?.blast, prevalence: feat?.prev, agreedSources: feat?.sources ?? ['first-principles' as const], triage: 'surface' as const });
  try {
    const brain = await Brain.open(repo, config);
    try {
      // Round 1 — ranking MATCHES outcomes: high-signal accepted, low-signal rejected → nDCG 1.
      await brain.recordRound(target, { target, n: 1, ts: 'now', headSha: 's1', baseRef: 'main' }, []);
      // 'a-good' carries distinctive raw features so we can assert they survive the round-trip (#2b).
      await brain.writeFindings(target, 1, [mk('a-good', 0.9, 'a.ts', 1, { blast: 0.7, prev: 0.3, sources: ['first-principles', 'deterministic'] }), mk('b-noise', 0.1, 'a.ts', 2)]);

      // #2b feature persistence: the raw signal inputs (blast/prevalence/agreement) round-trip through
      // Kùzu so a future re-weight fit can read them — and an unset feature persists as 0 (graceful).
      const round1 = (await brain.rankingSamples()).filter((s) => s.round === 1);
      const good = round1.find((s) => s.signal === 0.9)!; // 'a-good' — unique signal within the round
      const noise = round1.find((s) => s.signal === 0.1)!; // 'b-noise'
      assert.ok(good && noise, 'both round-1 findings persisted');
      assert.equal(good.blast, 0.7, 'blast persisted');
      assert.equal(good.prevalence, 0.3, 'prevalence persisted');
      assert.equal(good.agreement, 2, 'agreement = #independent sources persisted');
      assert.equal(noise.blast, 0, 'an unset blast persists as 0 (not null/NaN)');
      assert.equal(noise.agreement, 1, 'agreement defaults to 1 (the finding itself)');
      // Round 2 — ranking INVERTED: low-signal accepted, high-signal rejected → nDCG < 1.
      await brain.recordRound(target, { target, n: 2, ts: 'now', headSha: 's2', baseRef: 'main' }, []);
      await brain.writeFindings(target, 2, [mk('c-overrated', 0.9, 'b.ts', 1), mk('d-underrated', 0.1, 'b.ts', 2)]);

      const byTitle = new Map((await brain.loadRoundState(target)).priorFindings.map((f) => [f.title, f.id]));
      await brain.markFindingOutcome(byTitle.get('a-good')!, 'fixed'); // relevant, ranked first  → good
      await brain.markFindingOutcome(byTitle.get('b-noise')!, 'rejected');
      await brain.markFindingOutcome(byTitle.get('c-overrated')!, 'rejected'); // irrelevant, ranked first → bad
      await brain.markFindingOutcome(byTitle.get('d-underrated')!, 'fixed');
    } finally {
      await brain.close(); // close before rankingQuality opens its own (Kùzu single-writer)
    }

    const q = await rankingQuality(repo, config);
    assert.equal(q.labeledFindings, 4, 'all four findings have a recorded outcome');
    assert.equal(q.positives, 2, 'two fixed findings are positive labels');
    assert.equal(q.negatives, 2, 'two rejected findings are negative labels');
    assert.equal(q.evaluableRounds, 2, 'both rounds are evaluable (≥2 findings + a positive)');
    assert.ok(q.meanNdcg !== null, 'a score was produced');
    // round1 nDCG=1, round2 nDCG=0.63 ⇒ mean ≈ 0.815 — strictly between the inverted round and perfect.
    assert.ok(q.meanNdcg! > 0.6 && q.meanNdcg! < 1, `mean nDCG should reflect one good + one inverted round (got ${q.meanNdcg})`);
    // Readiness verdict (deferred #1): 2 rounds is far below the CV floor ⇒ NOT YET, keep defaults.
    assert.equal(q.verdict, 'not-yet', 'too few rounds to attempt a re-weight');
    assert.ok(/NOT YET/.test(q.note) && /round/.test(q.note), `verdict note names the binding gate (got: ${q.note})`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
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

/** src-layout Python repo: mypkg with an __init__.py barrel + relative imports + co-change history. */
function makePyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-py-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src/mypkg'), { recursive: true });
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src/mypkg/__init__.py'), 'from .app import create_app\nfrom .db import connect\n');
  writeFileSync(join(repo, 'src/mypkg/db.py'), 'def connect(url=None):\n    return url\n');
  writeFileSync(
    join(repo, 'src/mypkg/app.py'),
    'from .db import connect\n\nclass App:\n    def __init__(self):\n        self.conn = connect()\n\n    def run(self):\n        pass\n\ndef create_app():\n    return App()\n',
  );
  writeFileSync(join(repo, 'tests/test_app.py'), 'from mypkg import create_app\n\ndef test_create():\n    assert create_app()\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  for (let i = 0; i < 3; i++) {
    appendFileSync(join(repo, 'src/mypkg/db.py'), `# rev ${i}\n`);
    appendFileSync(join(repo, 'src/mypkg/app.py'), `# rev ${i}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `couple ${i}`);
  }
  return repo;
}

test('py-graph', 'code-graph: Python src-layout — dotted symbols, __init__ barrel, relative imports, blast radius (ADR-52)', async () => {
  const repo = makePyRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-pydb-')), 'g.kuzu');
  try {
    const res = await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    assert.equal(res.files, 4);
    assert.equal(res.symbols, 6, `connect, App, App.__init__, App.run, create_app, test_create (got ${res.symbols})`);
    assert.equal(res.imports, 4, `__init__→{app,db}, app→db, test→__init__ (got ${res.imports})`);
    assert.equal(res.coChangePairs, 1, 'db<->app couple survives minPairCount=2');

    const db = new CodeGraphDB(dbDir);
    try {
      const appSyms = (await getSymbolsInFile(db, 'src/mypkg/app.py')).map((s) => s.name);
      assert.ok(appSyms.includes('App.__init__') && appSyms.includes('App.run'), `dotted methods: ${appSyms.join(',')}`);
      // Absolute import through the src/ root: tests/test_app.py → the package __init__.
      const testImports = await getImportEdges(db, ['tests/test_app.py']);
      assert.ok(testImports.some((e) => e.dst === 'src/mypkg/__init__.py'), 'src-layout absolute import resolved');

      // Blast radius of a db.py change: app.py couples via BOTH import and co-change, and the
      // pure re-export __init__.py behaves as a transparent barrel (0 own symbols, degree ≥ 3).
      const diff: NormalizedDiff = {
        baseRef: 'HEAD',
        files: [{ path: 'src/mypkg/db.py', status: 'modified', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, newRanges: [{ start: 1, end: 2 }] }] }],
      };
      const nb = await computeNeighborhood(db, 'r', diff, { maxHops: 2, maxNeighbors: 40, minScore: 0.01 });
      assert.ok(nb.changed.map((c) => c.symbol).includes('connect'), 'changed lines map to the connect symbol');
      const appN = nb.neighbors.find((n) => String(n.node.props.path) === 'src/mypkg/app.py');
      assert.ok(appN, 'app.py in the radius');
      assert.deepEqual(appN!.via.sort(), ['co-change', 'import']);
      assert.ok(
        nb.neighbors.some((n) => String(n.node.props.path) === 'tests/test_app.py'),
        'the test file surfaces THROUGH the transparent __init__ barrel',
      );
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('py-incremental', 'code-graph: a changed .py file is no longer dropped from the incremental delta (ADR-52)', async () => {
  const repo = makePyRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-pyincdb-')), 'g.kuzu');
  try {
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    writeFileSync(join(repo, 'src/mypkg/cache.py'), 'def get(key):\n    return None\n');
    appendFileSync(join(repo, 'src/mypkg/db.py'), 'def disconnect():\n    pass\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mutate');

    const res = await updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    assert.equal(res.incremental, true);
    assert.ok(res.added >= 1 && res.modified >= 1, `py delta present: a=${res.added} m=${res.modified}`);

    const db = new CodeGraphDB(dbDir);
    try {
      assert.deepEqual((await getSymbolsInFile(db, 'src/mypkg/cache.py')).map((s) => s.name), ['get'], 'added .py extracted');
      const dbSyms = (await getSymbolsInFile(db, 'src/mypkg/db.py')).map((s) => s.name);
      assert.ok(dbSyms.includes('disconnect'), `modified .py re-extracted: ${dbSyms.join(',')}`);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

/** A .py plugin whose runtime never loads — the BuildOptions.resolvePlugin degradation seam. */
const failingPyPlugin: LanguagePlugin = {
  id: 'py',
  exts: ['.py'],
  init: () => Promise.reject(new Error('simulated wasm failure')),
  extract: () => {
    throw new Error('unreachable — init always fails');
  },
  resolve: () => ({ imports: [], refs: [] }),
};
const failingPyDispatch = (f: string): LanguagePlugin | undefined =>
  f.endsWith('.py') ? failingPyPlugin : pluginFor(f);

test('py-preflight', 'code-graph: a runtime failing mid-update throws BEFORE the destructive phase — no symbol erasure', async () => {
  const repo = makePyRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-pyprefdb-')), 'g.kuzu');
  try {
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE }); // healthy build
    appendFileSync(join(repo, 'src/mypkg/db.py'), 'def disconnect():\n    pass\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mutate');

    await assert.rejects(
      () => updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE, resolvePlugin: failingPyDispatch }),
      (e: unknown) => e instanceof FullRebuildRequired,
      'a failed runtime preflight must demand the full-rebuild fallback',
    );
    const db = new CodeGraphDB(dbDir);
    try {
      const dbSyms = (await getSymbolsInFile(db, 'src/mypkg/db.py')).map((s) => s.name);
      assert.ok(dbSyms.includes('connect'), `old symbols survive the failed update (erase window closed): ${dbSyms.join(',')}`);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('py-degraded-build', 'code-graph: a degraded full build reports skippedLanguages and withholds the version stamp (self-heal)', async () => {
  const repo = makePyRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-pydegdb-')), 'g.kuzu');
  try {
    const res = await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE, resolvePlugin: failingPyDispatch });
    assert.deepEqual(res.skippedLanguages, ['py'], 'the degraded language is reported');
    assert.equal(res.symbols, 0, 'no symbols extracted for the failed language');
    const db = new CodeGraphDB(dbDir);
    try {
      const version = await getMeta(db, 'graphVersion');
      assert.ok(version == null, `Meta.graphVersion withheld on a degraded build (got ${version}) — the next incremental forces the rebuild retry`);
      assert.equal(await getMeta(db, 'repo'), basename(repo), 'the rest of Meta still stamps');
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('graph-version', 'code-graph: an old graphVersion forces FullRebuildRequired (existing .py files are otherwise invisible)', async () => {
  const repo = makeRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-gvdb-')), 'g.kuzu');
  try {
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    const db = new CodeGraphDB(dbDir);
    try {
      await db.run('MERGE (m:Meta {key:$k}) SET m.val = $v', { k: 'graphVersion', v: '1' }); // simulate a pre-upgrade graph
    } finally {
      await db.close();
    }
    await assert.rejects(
      () => updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE }),
      (e: unknown) => e instanceof FullRebuildRequired,
      'version mismatch must demand a full rebuild',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('py-mixed', 'mixed TS+Python repo: one graph, one deterministic stream (ADR-52)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-mix-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-mixdb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/util.ts'), 'export const u = 1;\n');
    writeFileSync(join(repo, 'src/api.ts'), "import { u } from './util';\nexport function api() {\n  console.log(u);\n}\n");
    writeFileSync(join(repo, 'src/pylib.py'), 'def helper():\n    return 1\n');
    writeFileSync(join(repo, 'src/serve.py'), 'from pylib import helper\n\nclass Server:\n    def run(self):\n        print(helper())\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    const res = await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    assert.equal(res.files, 4);
    const db = new CodeGraphDB(dbDir);
    try {
      assert.ok((await getImportEdges(db, ['src/api.ts'])).some((e) => e.dst === 'src/util.ts'), 'TS import edge');
      assert.ok((await getImportEdges(db, ['src/serve.py'])).some((e) => e.dst === 'src/pylib.py'), 'py import edge');
      const serveSyms = (await getSymbolsInFile(db, 'src/serve.py')).map((s) => s.name);
      assert.ok(serveSyms.includes('Server.run'), `dotted py method beside TS symbols: ${serveSyms.join(',')}`);
    } finally {
      await db.close();
    }

    // One deterministic stream over a mixed diff: both languages' rules fire together (no Kùzu).
    const diff: NormalizedDiff = {
      baseRef: 'HEAD',
      files: [
        { path: 'src/api.ts', status: 'modified', hunks: [] },
        { path: 'src/serve.py', status: 'modified', hunks: [] },
      ],
    };
    const rules = (await runDeterministic(repo, diff)).map((f) => f.tags?.[0]);
    assert.ok(rules.includes('no-console'), `ts rule fired: ${rules.join(',')}`);
    assert.ok(rules.includes('no-print'), `py rule fired: ${rules.join(',')}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('cochange-inc', 'code-graph: incremental co-change merges new commits (ADR-26)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-cci-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-ccidb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'c0'); // couples a,b (cnt 1)
    for (let i = 0; i < 2; i++) {
      appendFileSync(join(repo, 'src/a.ts'), `// ${i}\n`);
      appendFileSync(join(repo, 'src/b.ts'), `// ${i}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `c${i + 1}`); // +1 each → cnt 3, passes minPairCount=2
    }
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    // one more coupling commit, then incremental — should accumulate, not re-crawl history.
    appendFileSync(join(repo, 'src/a.ts'), '// x\n');
    appendFileSync(join(repo, 'src/b.ts'), '// x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'c3');
    await updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    const db = new CodeGraphDB(dbDir);
    try {
      const e = (await getCoChangeEdges(db, ['src/a.ts'])).find((x) => x.dst === 'src/b.ts');
      assert.ok(e, 'a-b co-change present after incremental');
      assert.equal(e!.cnt, 4, `incremental merged the new coupling commit (cnt ${e?.cnt}, expected 3+1)`);
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// Shared setup for the rename scenarios: old.ts + x.ts coupled over 3 commits (cnt 3, passes minPairCount=2).
function makeCoupledRenameRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-ren-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/old.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src/x.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'c0'); // couples old,x (cnt 1)
  for (let i = 0; i < 2; i++) {
    appendFileSync(join(repo, 'src/old.ts'), `// ${i}\n`);
    appendFileSync(join(repo, 'src/x.ts'), `// ${i}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `c${i + 1}`); // cnt 3
  }
  return repo;
}

test('cochange-rename-full', 'code-graph: a full build follows renames (ADR-53 history fold)', async () => {
  const repo = makeCoupledRenameRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-renfdb-')), 'g.kuzu');
  try {
    git(repo, 'mv', 'src/old.ts', 'src/new.ts'); // pure rename (n=1, adds no coupling)
    git(repo, 'commit', '-q', '-m', 'rename old→new');
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    const db = new CodeGraphDB(dbDir);
    try {
      const e = (await getCoChangeEdges(db, ['src/new.ts'])).find((x) => x.dst === 'src/x.ts');
      assert.ok(e, 'renamed file inherits the pre-rename co-change edge');
      assert.equal(e!.cnt, 3, `pre-rename history folded onto new.ts (cnt ${e?.cnt}, expected 3)`);
      assert.equal((await getCoChangeEdges(db, ['src/old.ts'])).length, 0, 'the old path carries no edges');
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('cochange-rename-inc', 'code-graph: incremental migrates co-change across a rename (ADR-53)', async () => {
  const repo = makeCoupledRenameRepo();
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-renidb-')), 'g.kuzu');
  try {
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE }); // stored BEFORE the rename (old↔x cnt 3)
    git(repo, 'mv', 'src/old.ts', 'src/new.ts');
    git(repo, 'commit', '-q', '-m', 'rename old→new');
    await updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });
    const db = new CodeGraphDB(dbDir);
    try {
      const e = (await getCoChangeEdges(db, ['src/new.ts'])).find((x) => x.dst === 'src/x.ts');
      assert.ok(e, 'the old node’s co-change edge migrated onto the renamed node');
      assert.equal(e!.cnt, 3, `migrated edge preserves the accumulated count (cnt ${e?.cnt}, expected 3)`);
      assert.equal((await getCoChangeEdges(db, ['src/old.ts'])).length, 0, 'the old node was removed');
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('rename-anchor-migrate', 'engine: a file rename re-anchors code-path Incidents + symbol-scoped Waivers (ADR-53)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-ranchor-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'Test');
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'reviewer-ranchor-k-'));
  try {
    const config = resolveConfig({ dataDir: '.plex', knowledgeDir });
    // Seed an incident + a waiver both anchored to src/old.ts#fn.
    await knowledgeStore(config).addIncident({
      id: 'inc:src-old-ts:h:1',
      source: 'review',
      file: 'src/old.ts',
      symbol: symbolKey('src/old.ts', 'fn'),
      snippet: 'x',
      ts: new Date().toISOString(),
    });
    await recordVerdict(
      repo,
      { findingId: 'f1', kind: 'waive', scope: 'file', file: 'src/old.ts', symbol: symbolKey('src/old.ts', 'fn') },
      config,
    );

    await migrateRenamedAnchors(repo, config, new Map([['src/old.ts', 'src/new.ts']]));

    const inc = (await knowledgeStore(config).incidents())[0]!;
    assert.equal(inc.file, 'src/new.ts', 'incident file re-anchored to the new path');
    assert.equal(inc.symbol, symbolKey('src/new.ts', 'fn'), 'incident symbol re-anchored');
    assert.equal(inc.id, 'inc:src-old-ts:h:1', 'incident id kept stable (pitfall provenance intact)');
    const v = (await readVerdicts(repo, config)).find((x) => x.findingId === 'f1')!;
    assert.equal(v.file, 'src/new.ts', 'waiver file re-anchored');
    assert.equal(v.symbol, symbolKey('src/new.ts', 'fn'), 'waiver symbol re-anchored — suppression still matches');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(knowledgeDir, { recursive: true, force: true });
  }
});

test('cochange-weak', 'code-graph: incremental never CREATES a singleton pair (ADR-26 weak path)', async () => {
  // The denoising invariant (build.ts weak path): a pair that reaches minPairCount in no
  // single window must stay pruned — incremental accumulates into stored pairs but never
  // creates a new under-threshold one. cochange-inc covers the strong/accumulate side.
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-ccw-'));
  const dbDir = join(mkdtempSync(join(tmpdir(), 'reviewer-ccwdb-')), 'g.kuzu');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    for (const f of ['a', 'b', 'c', 'd']) writeFileSync(join(repo, `src/${f}.ts`), `export const ${f} = 1;\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init'); // couples every pair ONCE (incl. c-d) — all below minPairCount=2
    for (let i = 0; i < 2; i++) {
      appendFileSync(join(repo, 'src/a.ts'), `// ${i}\n`);
      appendFileSync(join(repo, 'src/b.ts'), `// ${i}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `couple ab ${i}`); // a-b reaches count 3
    }
    await buildCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE }); // a-b edge; c-d pruned (cnt 1)

    // One incremental commit couples c-d a SECOND time — but only once in THIS window (cnt 1).
    appendFileSync(join(repo, 'src/c.ts'), '// x\n');
    appendFileSync(join(repo, 'src/d.ts'), '// x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'touch cd');
    await updateCodeGraph({ repoPath: repo, dbDir, coChange: COCHANGE });

    const db = new CodeGraphDB(dbDir);
    try {
      const ab = (await getCoChangeEdges(db, ['src/a.ts'])).find((e) => e.dst === 'src/b.ts');
      assert.ok(ab, 'the strong a-b pair still exists (sanity)');
      const cd = (await getCoChangeEdges(db, ['src/c.ts'])).find((e) => e.dst === 'src/d.ts');
      assert.equal(cd, undefined, 'the under-threshold c-d singleton was NOT created by the incremental');
    } finally {
      await db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('reconcile', 'engine: a pushed fix auto-accepts the addressed finding (ADR-28/30)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-rec-'));
  const config = resolveConfig({ dataDir: '.plex', knowledgeDir: join(repo, 'k'), embedding: { provider: 'fake' } });
  const target = reviewTarget(basename(resolve(repo)), { mode: 'staged' });
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    // Everything in ONE Kùzu brain open (ADR-17 keeps tsx scenarios to ≤2 opens): seed a
    // round + finding, then run the real fix-accept inference (what reconcileOutcomes wraps).
    const brain = await Brain.open(repo, config);
    try {
      await brain.recordRound(target, { target, n: 1, ts: 'now', headSha: sha1, baseRef: 'HEAD' }, []);
      await brain.writeFindings(target, 1, [
        { id: 'agent:0', title: 'alpha beta gamma', body: '', severity: 'bug', confidence: 0.6, source: 'first-principles', location: { repo: 'r', file: 'src/a.ts', startLine: 1, endLine: 1 }, signal: 0.4, agreedSources: ['first-principles'], triage: 'surface' },
        // An AWARENESS flag on the SAME lines whose text also matches the change — must NOT be
        // auto-accepted (ADR-31): only an explicit acknowledge resolves it.
        { id: 'agent:1', title: 'alpha beta gamma note', body: '', severity: 'note', confidence: 0.5, source: 'first-principles', location: { repo: 'r', file: 'src/a.ts', startLine: 1, endLine: 1 }, signal: 0.3, agreedSources: ['first-principles'], triage: 'note' },
      ]);

      // Push a fix whose tokens match the finding (fake embedder is bag-of-tokens).
      writeFileSync(join(repo, 'src/a.ts'), '// alpha beta gamma\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'fix');
      const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

      const state = await brain.loadRoundState(target);
      assert.equal(state.priorFindings.length, 2, 'two open findings before the fix (one bug, one note)');
      const changed = await getChangedFileTexts(repo, sha1, sha2);
      const embedder = createEmbeddingProvider(config.embedding)!;
      const regionTexts = changed.map((c) => c.text);
      const findingTexts = state.priorFindings.map((f) => f.title);
      const vecs = await embedder.embed([...regionTexts, ...findingTexts]);
      const regionEmb = changed.map((_, i) => vecs[i]!);
      const findingEmb = state.priorFindings.map((_, i) => vecs[regionTexts.length + i]!);

      const accepted = await recordFixAccepts(repo, config, target, brain, state.priorFindings, findingEmb, regionEmb, changed);
      assert.equal(accepted.length, 1, `only the bug is auto-accepted; the note finding is skipped (got ${accepted.length})`);
      assert.ok(accepted[0]!.matchedBy === 'semantic' || accepted[0]!.matchedBy === 'locality', 'the accept names which signal matched');
      const remaining = (await brain.loadRoundState(target)).priorFindings;
      assert.equal(remaining.length, 1, 'the note finding stays open for an explicit acknowledge');
      assert.equal(remaining[0]!.severity, 'note', 'and it is the note one that remains');
    } finally {
      await brain.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worktree-seed', 'engine: a secondary worktree COPIES the base graph into its own dir (ADR-32/ADR-39)', async () => {
  // TWO Kùzu opens (ADR-17 budget): buildCodeGraph(base) + the worktree's own updateCodeGraph after
  // the copy. The worktree gets its OWN graph (a copy of the base + its diff applied), opened
  // normally — NOT the base's graph shared read-only (Kùzu's read-only open SIGSEGVs on Linux).
  // `indexIsolated` (the base self-refresh) no-ops under tsx; `pnpm test:worktree` covers that.
  const root = mkdtempSync(join(tmpdir(), 'reviewer-wt-'));
  const base = join(root, 'main');
  const wt = join(root, 'wt');
  const config = resolveConfig({ dataDir: '.plex', embedding: { provider: 'none' } });
  const headSha = (cwd: string): string => {
    const f = join(cwd, '.plex', 'head.sha');
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
  };
  try {
    mkdirSync(base);
    git(base, 'init', '-q');
    git(base, 'config', 'user.email', 't@t.dev');
    git(base, 'config', 'user.name', 'T');
    mkdirSync(join(base, 'src'));
    writeFileSync(join(base, 'src/a.ts'), 'export function a() {\n  return 1;\n}\n');
    writeFileSync(join(base, 'src/b.ts'), "import { a } from './a';\nexport function b() {\n  return a() + 1;\n}\n");
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '-m', 'init');
    git(base, 'worktree', 'add', '-q', '-b', 'feat', wt);
    writeFileSync(join(wt, 'src/c.ts'), 'export function c() {\n  return 2;\n}\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'add c');
    const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base }).toString().trim();

    const ib = await indexRepo(base, config); // open #1 — full build of the base
    assert.equal(ib.seeded, undefined, 'the base itself is a full build, not seeded');
    assert.equal(headSha(base), baseHead, 'base graph stamped at its own HEAD');

    const iw = await indexRepo(wt, config); // copy base graph + apply the worktree's own diff
    assert.equal(iw.seeded, true, 'worktree result is flagged as seeded (copied from base)');

    // The worktree's graphDir is its OWN, under the worktree — a copy, NOT the base's.
    // realpathSync.native dereferences /var → /private/var on macOS so symlink variants compare equal.
    const real = (p: string) => realpathSync.native(p);
    assert.notEqual(real(iw.graphDir), real(ib.graphDir), 'worktree graphDir is its own, not the base’s');
    assert.ok(real(iw.graphDir).startsWith(real(wt)), `graphDir is under the worktree path (${iw.graphDir})`);
    assert.ok(!real(iw.graphDir).startsWith(real(base)), 'graphDir is NOT under the base path');

    // The worktree DOES have its own graph.kuzu (the copy) in-workspace, self-gitignored.
    assert.ok(existsSync(join(wt, '.plex', 'graph.kuzu')), 'worktree has its own graph.kuzu copy');
    assert.ok(existsSync(join(wt, '.plex', '.gitignore')), 'worktree .plex is self-gitignored');

    // Base head.sha is unchanged (worktree indexing does not re-stamp the base).
    assert.equal(headSha(base), baseHead, 'worktree indexing did NOT re-stamp the base');

    // Worktree's data (graph + brain/verdicts) lives in-workspace with a repo-path sidecar.
    assert.ok(existsSync(join(wt, '.plex', 'repo-path')), 'worktree repo-path sidecar written');
    assert.equal(readFileSync(join(wt, '.plex', 'repo-path'), 'utf8').trim(), resolve(wt), 'repo-path contains worktree abs path');
  } finally {
    try { git(base, 'worktree', 'remove', '--force', wt); } catch { /* best-effort */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('semantic-waiver', 'engine: a semantic waiver suppresses the same issue next run (ADR-27)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-sw-'));
  try {
    const config = resolveConfig({ dataDir: '.plex', embedding: { provider: 'fake' } }); // fake = test-only embedder

    // Waive "this kind of issue" repo-wide — the embedding is stored on the verdict.
    await submitVerdict(repo, { findingId: 'f1', kind: 'waive', scope: 'pattern-repo', title: 'venue_opened double-fire' }, config);

    // Next run: the same issue (same text → identical fake vector → cosine 1.0) is suppressed,
    // and an unrelated finding is NOT.
    const { ranked } = await rankReviewFindings(
      repo,
      config,
      [
        { title: 'venue_opened double-fire', severity: 'bug', confidence: 0.6, file: 'src/a.ts', startLine: 1, source: 'first-principles' },
        { title: 'unrelated missing null check', severity: 'bug', confidence: 0.6, file: 'src/a.ts', startLine: 9, source: 'first-principles' },
      ],
      { mode: 'staged', includeDeterministic: false },
    );
    const waived = ranked.find((r) => r.title === 'venue_opened double-fire');
    const other = ranked.find((r) => r.title.includes('null check'));
    assert.equal(waived?.triage, 'suppressed', 'semantic waiver suppressed the same issue');
    assert.notEqual(other?.triage, 'suppressed', 'unrelated finding not suppressed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
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

    const config = resolveConfig({ dataDir: '.plex' });
    const { ranked } = await rankReviewFindings(
      repo,
      config,
      [{ title: 'Possible null deref', severity: 'bug', confidence: 0.7, file: 'src/a.ts', startLine: 3, source: 'first-principles' }],
      { mode: 'staged' },
    );
    assert.ok(ranked.some((r) => r.tags?.includes('no-debugger')), 'deterministic debugger finding merged in');
    assert.ok(ranked.some((r) => r.title === 'Possible null deref'), 'agent finding present');
    assert.equal(ranked[0]!.triage, 'surface');
    assert.equal(ranked[0]!.severity, 'bug');

    // A deterministic finding the agent judges a FALSE POSITIVE: a line-scoped waive suppresses it
    // from the stream — the mechanism the reviewer uses instead of emitting a contradicting nit.
    const det = ranked.find((r) => r.tags?.includes('no-debugger'))!;
    await recordVerdict(repo, { findingId: 'det-fp', kind: 'waive', scope: 'line', file: det.location.file, line: det.location.startLine, title: det.title }, config);
    const { ranked: reranked } = await rankReviewFindings(
      repo,
      config,
      [{ title: 'Possible null deref', severity: 'bug', confidence: 0.7, file: 'src/a.ts', startLine: 3, source: 'first-principles' }],
      { mode: 'staged' },
    );
    assert.equal(reranked.find((r) => r.tags?.includes('no-debugger'))!.triage, 'suppressed', 'a line-scoped waive suppresses the deterministic false positive');
    assert.equal(reranked.find((r) => r.title === 'Possible null deref')!.triage, 'surface', 'the agent finding is unaffected');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('suppress-scope', 'engine: a dismissal anchors to its symbol — suppression is symbol-scoped, not repo-wide (ADR-48)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-supp-'));
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'reviewer-supp-kdir-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    // Three functions, each with a `console.log` → three deterministic `no-console` findings, each
    // anchored to its enclosing symbol (ADR-48 enclosing-symbol resolution). Added as a NEW staged
    // file so every line is "changed" and all findings fire (the changed-ranges filter).
    writeFileSync(
      join(repo, 'src/cli.ts'),
      'export function run() {\n  console.log("a");\n}\nexport function handler() {\n  console.log("b");\n}\nexport function extra() {\n  console.log("c");\n}\n',
    );
    git(repo, 'add', '-A');

    const config = resolveConfig({ dataDir: '.plex', knowledgeDir }); // isolated KB; no embeddings needed
    const target = reviewTargetFor(repo, { mode: 'staged' });

    // Review 1: the deterministic no-console findings carry their enclosing symbol.
    const { ranked } = await rankReviewFindings(repo, config, [], { mode: 'staged' });
    for (const sym of ['run', 'handler', 'extra']) {
      assert.ok(
        ranked.some((r) => r.tags?.includes('no-console') && r.location.symbol === sym),
        `a no-console finding anchored to symbol \`${sym}\``,
      );
    }

    // The brain findings carry the `file#name` symbol so a dismissal can inherit it.
    const brain = await Brain.open(repo, config);
    let runBf, handlerBf;
    try {
      const st = await brain.loadRoundState(target);
      runBf = st.priorFindings.find((f) => f.symbol === symbolKey('src/cli.ts', 'run'));
      handlerBf = st.priorFindings.find((f) => f.symbol === symbolKey('src/cli.ts', 'handler'));
    } finally {
      await brain.close();
    }
    assert.ok(runBf && handlerBf, 'the brain findings carry their file#name symbols');

    // Dismiss `run` and `handler` (two distinct instances → two Wilson votes) — passing each brain
    // finding id so submitVerdict resolves the symbol, and `pattern` so it keys the no-console rule.
    // `extra` is left undismissed.
    for (const bf of [runBf!, handlerBf!]) {
      await submitVerdict(
        repo,
        { findingId: bf.id, kind: 'reject', pattern: 'no-console', file: 'src/cli.ts', title: bf.title },
        config,
        target,
      );
    }

    // The learned suppression is SYMBOL-SCOPED: it knows the dismissed symbols and is NOT repo-wide, so
    // the same rule at the undismissed `extra` is never buried by dismissing `run`/`handler`.
    const decision = (await loadSuppressions(config, basename(resolve(repo)))).find((d) => d.key === 'no-console');
    assert.ok(decision, 'a no-console suppression decision was learned');
    assert.equal(decision!.repoWide, false, 'symbol-scoped, not repo-wide');
    assert.ok(decision!.symbols?.has(symbolKey('src/cli.ts', 'run')), 'scoped to the dismissed `run` symbol');
    assert.ok(decision!.symbols?.has(symbolKey('src/cli.ts', 'handler')), 'scoped to the dismissed `handler` symbol');
    assert.ok(!decision!.symbols?.has(symbolKey('src/cli.ts', 'extra')), 'NOT scoped to the undismissed `extra` symbol');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(knowledgeDir, { recursive: true, force: true });
  }
});

test('knowledge', 'engine: stored pitfall -> review retrieves it -> learn on accept', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-kn-'));
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'reviewer-kdir-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t.dev');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'src'));
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

    const config = resolveConfig({ dataDir: '.plex', knowledgeDir, embedding: { provider: 'fake' } }); // fake = test-only
    // Knowledge is populated by review-history analysis + the learning loop (no markdown seeding).
    // Stand in an analyzed-style pitfall directly so the retrieval + learn-on-accept loop is exercised.
    const title = 'Always validate user input before inserting into the database';
    const [vec] = await createEmbeddingProvider(config.embedding)!.embed([`validation: ${title}`]);
    await knowledgeStore(config).addPitfall({
      id: 'pf:validate-input', title, trigger: title, why: '', category: 'validation',
      tier: 'judgmental', confidence: 0.6, scope: 'global', incidentIds: [], embedding: vec,
    });

    // Code-path memory (ADR-47): anchor a PRIOR FIXED incident to `updateUserInput` (the function
    // appended + staged above, so it's in the review's changed-symbol set) and link it to the pitfall.
    const store = knowledgeStore(config);
    await store.addIncident({
      id: 'inc:cp', source: 'review', repo: 'r', file: 'src/user.ts',
      symbol: symbolKey('src/user.ts', 'updateUserInput'), outcome: 'fixed', ts: '2026-01-01T00:00:00Z',
    });
    await store.replacePitfalls(
      (await store.pitfalls()).map((p) => (p.id === 'pf:validate-input' ? { ...p, incidentIds: ['inc:cp'] } : p)),
    );

    await indexRepo(repo, config);
    const ctx = await assembleReviewContext({ repoPath: repo, config, mode: 'staged' });
    assert.ok(ctx.knowledge.length >= 1, 'retrieved at least one relevant pitfall');
    assert.ok(ctx.knowledge[0]!.pitfall.title.toLowerCase().includes('validate'), 'retrieved the validation pitfall');
    // The diff touches updateUserInput, which has a prior FIXED incident → a regression-sentinel alert.
    assert.ok(ctx.codePathAlerts && ctx.codePathAlerts.length >= 1, 'a code-path alert surfaced');
    assert.ok(
      ctx.codePathAlerts!.some((a) => a.regressionSentinel && a.symbol === 'updateUserInput'),
      'regression sentinel at the touched symbol',
    );

    await submitVerdict(repo, { findingId: 'f1', kind: 'accept', file: 'src/user.ts', title: 'validate input' }, config);
    const incidents = await knowledgeStore(config).incidents();
    assert.ok(incidents.some((i) => i.outcome === 'accepted'), 'accept recorded an incident');
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
