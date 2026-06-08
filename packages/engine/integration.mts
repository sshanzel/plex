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
import { join, basename, resolve } from 'node:path';
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
import { computeNeighborhood } from '@plex/neighborhood';
import { getChangedFileTexts } from '@plex/ingest';
import { createEmbeddingProvider } from '@plex/knowledge';
import {
  indexRepo,
  assembleReviewContext,
  recordVerdict,
  readVerdicts,
  rankReviewFindings,
  seedKnowledge,
  submitVerdict,
  knowledgeStore,
  recordFixAccepts,
  rankingQuality,
  reviewTarget,
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

test('brain-heal', 'engine: a worktree-split brain self-heals (orphaned rounds adopt the findings\' target)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'reviewer-heal-'));
  const config = resolveConfig({ dataDir: '.plex' });
  const baseName = 'playright__pr_79'; // where an OLD build put ROUNDS (graph-meta name a worktree copied)
  const canonical = 'work__pr_79'; // where it put FINDINGS (dir basename) = reviewTargetFor today
  try {
    const brain = await Brain.open(repo, config);
    try {
      // Reproduce the split: rounds under the base name, findings under the canonical (basename) name.
      await brain.recordRound(baseName, { target: baseName, n: 1, ts: 't1', headSha: 'sha1', baseRef: 'main' }, []);
      await brain.recordRound(baseName, { target: baseName, n: 2, ts: 't2', headSha: 'sha2', baseRef: 'main' }, []);
      await brain.writeFindings(canonical, 1, [
        { id: 'x', title: 'leak', body: '', severity: 'bug', confidence: 0.6, source: 'first-principles', location: { repo: 'r', file: 'a.ts', startLine: 5, endLine: 5 }, signal: 0.4, agreedSources: ['first-principles'], triage: 'surface' },
      ]);

      // Pre-heal: canonical has findings but no rounds → lastHeadSha missing (reconcile would bail 0).
      let st = await brain.loadRoundState(canonical);
      assert.equal(st.priorFindings.length, 1, 'findings present under canonical');
      assert.equal(st.lastN, 0, 'no rounds under canonical (split)');

      const healed = await brain.healSplitTarget(canonical);
      assert.ok(healed, 'heal fired');
      assert.equal(healed!.from, baseName, 'adopted the sibling with the same __pr_79 suffix');
      assert.equal(healed!.rounds, 2);

      // Post-heal: the rounds now belong to canonical → reconcile can diff + match.
      st = await brain.loadRoundState(canonical);
      assert.equal(st.lastN, 2, 'rounds adopted');
      assert.equal(st.lastHeadSha, 'sha2', 'lastHeadSha is the latest adopted round');
      assert.equal(st.priorFindings.length, 1, 'findings still present');

      assert.equal(await brain.healSplitTarget(canonical), null, 'idempotent: a second heal is a no-op');
    } finally {
      await brain.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('brain', 'engine: Kùzu PR brain — rounds, findings, comments, outcome (ADR-30)', async () => {
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
  const mk = (title: string, signal: number, file: string, line: number) =>
    ({ id: title, title, body: '', severity: 'bug' as const, confidence: 0.6, source: 'first-principles' as const, location: { repo: 'r', file, startLine: line, endLine: line }, signal, agreedSources: ['first-principles' as const], triage: 'surface' as const });
  try {
    const brain = await Brain.open(repo, config);
    try {
      // Round 1 — ranking MATCHES outcomes: high-signal accepted, low-signal rejected → nDCG 1.
      await brain.recordRound(target, { target, n: 1, ts: 'now', headSha: 's1', baseRef: 'main' }, []);
      await brain.writeFindings(target, 1, [mk('a-good', 0.9, 'a.ts', 1), mk('b-noise', 0.1, 'a.ts', 2)]);
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
    assert.equal(q.evaluableRounds, 2, 'both rounds are evaluable (≥2 findings + a positive)');
    assert.ok(q.meanNdcg !== null, 'a score was produced');
    // round1 nDCG=1, round2 nDCG=0.63 ⇒ mean ≈ 0.815 — strictly between the inverted round and perfect.
    assert.ok(q.meanNdcg! > 0.6 && q.meanNdcg! < 1, `mean nDCG should reflect one good + one inverted round (got ${q.meanNdcg})`);
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
        { id: 'agent:1', title: 'alpha beta gamma awareness', body: '', severity: 'awareness', confidence: 0.5, source: 'first-principles', location: { repo: 'r', file: 'src/a.ts', startLine: 1, endLine: 1 }, signal: 0.3, agreedSources: ['first-principles'], triage: 'awareness' },
      ]);

      // Push a fix whose tokens match the finding (fake embedder is bag-of-tokens).
      writeFileSync(join(repo, 'src/a.ts'), '// alpha beta gamma\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'fix');
      const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

      const state = await brain.loadRoundState(target);
      assert.equal(state.priorFindings.length, 2, 'two open findings before the fix (one bug, one awareness)');
      const changed = await getChangedFileTexts(repo, sha1, sha2);
      const embedder = createEmbeddingProvider(config.embedding)!;
      const regionTexts = changed.map((c) => c.text);
      const findingTexts = state.priorFindings.map((f) => f.title);
      const vecs = await embedder.embed([...regionTexts, ...findingTexts]);
      const regionEmb = changed.map((_, i) => vecs[i]!);
      const findingEmb = state.priorFindings.map((_, i) => vecs[regionTexts.length + i]!);

      const accepted = await recordFixAccepts(repo, config, target, brain, state.priorFindings, findingEmb, regionEmb, changed);
      assert.equal(accepted, 1, `only the bug is auto-accepted; the awareness flag is skipped (got ${accepted})`);
      const remaining = (await brain.loadRoundState(target)).priorFindings;
      assert.equal(remaining.length, 1, 'the awareness flag stays open for an explicit acknowledge');
      assert.equal(remaining[0]!.severity, 'awareness', 'and it is the awareness one that remains');
    } finally {
      await brain.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worktree-seed', 'engine: a secondary worktree seeds its graph from the base + stays isolated (ADR-32)', async () => {
  // Exactly TWO Kùzu opens (ADR-17 budget): buildCodeGraph(base) + updateCodeGraph(copy).
  // `indexIsolated` no-ops under tsx (no built CLI beside argv[1]) so the base self-refresh
  // is NOT exercised here — that needs the shipped runtime (`pnpm test:worktree`). What this
  // pins is the seed MECHANIC: a separate graph at the worktree path, only the branch diff
  // applied, and the base left untouched.
  const root = mkdtempSync(join(tmpdir(), 'reviewer-wt-'));
  const base = join(root, 'main');
  const wt = join(root, 'wt');
  const config = resolveConfig({ dataDir: '.plex', embedding: { provider: 'none' } });
  const headSha = (cwd: string): string =>
    readFileSync(join(cwd, '.plex', 'head.sha'), 'utf8').trim();
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
    const featHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt }).toString().trim();

    const ib = await indexRepo(base, config); // open #1 — full build of the base
    assert.equal(ib.seeded, undefined, 'the base itself is a full build, not seeded');
    assert.equal(headSha(base), baseHead, 'base graph stamped at its own HEAD');

    const iw = await indexRepo(wt, config); // open #2 — seed: cpSync(base) + updateCodeGraph(copy)
    assert.equal(iw.seeded, true, 'the worktree graph is seeded from the base, not full-built');
    assert.equal(iw.added, 1, 'only the worktree-added file (c.ts) is applied (+1)');
    assert.equal(iw.deleted, 0, 'nothing deleted relative to base');
    assert.equal(iw.modified ?? 0, 0, 'nothing modified relative to base');

    // Isolation: separate graph dir at the worktree path; the base is left untouched.
    assert.ok(iw.graphDir.startsWith(resolve(wt)), `worktree graph at the worktree (${iw.graphDir})`);
    assert.ok(!iw.graphDir.startsWith(resolve(base)), 'worktree graph is NOT under the base path');
    assert.notEqual(iw.graphDir, ib.graphDir, 'base and worktree have distinct graphs');
    assert.equal(headSha(base), baseHead, 'seeding the worktree did NOT re-stamp the base');
    assert.equal(headSha(wt), featHead, 'worktree graph stamped at the feat HEAD');
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
    const ranked = await rankReviewFindings(
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

    // A deterministic finding the agent judges a FALSE POSITIVE: a line-scoped waive suppresses it
    // from the stream — the mechanism the reviewer uses instead of emitting a contradicting nit.
    const det = ranked.find((r) => r.tags?.includes('no-debugger'))!;
    await recordVerdict(repo, { findingId: 'det-fp', kind: 'waive', scope: 'line', file: det.location.file, line: det.location.startLine, title: det.title }, config);
    const reranked = await rankReviewFindings(
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

    const config = resolveConfig({ dataDir: '.plex', knowledgeDir, embedding: { provider: 'fake' } }); // fake = test-only
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
