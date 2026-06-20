import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isGeneratedArtifact, type CoChangeConfig } from '@plex/core';
import { CodeGraphDB } from './db';
import { initSchema } from './schema';
import { extractFromSource, isSupportedSource, resolveRelativeImport } from './extract-ts';
import { aggregateCoChange, readCommits, headSha, changedSourceFilesSince, listWorktreeFiles } from './co-change';
import { resolvePreciseImports, type PreciseImportInput } from './precise';
import { getMeta, getCoChangeEdges, getImportEdges, getRefEdges, getCoChangeDegrees } from './query';

// Fallback skip-list for a NON-git directory (a git repo respects .gitignore instead — see discoverFiles).
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.plex',
]);

/**
 * Collision-safe `Symbol.id` (`file#name#startLine`): a minified bundle can pack many declarations on
 * one line (same name+line) — appending a stable `#<n>` on collision keeps a duplicate PK from aborting
 * the ENTIRE Kùzu index. Deterministic extraction order ⇒ stable suffix across re-indexes.
 */
function uniqueSymbolId(base: string, seen: Set<string>): string {
  let id = base;
  for (let n = 2; seen.has(id); n++) id = `${base}#${n}`;
  seen.add(id);
  return id;
}

export interface BuildOptions {
  repoPath: string;
  dbDir: string;
  coChange: CoChangeConfig;
  repoName?: string;
  /** Full rebuild (default true): wipes the DB dir first. */
  fresh?: boolean;
  /** Add precise (tsconfig-alias-aware) reference edges (default true). */
  precise?: boolean;
}

export interface BuildResult {
  files: number;
  symbols: number;
  imports: number;
  refs: number;
  coChangePairs: number;
  commits: number;
}

/** Raw graph edges of files an update DELETED, captured before their nodes were removed. Raw on
 *  purpose: weighting lives upstream in @plex/neighborhood, which this package cannot depend on. */
export interface DeletedFileEdges {
  deletedPaths: string[];
  co: { src: string; dst: string; weight: number }[];
  imports: { src: string; dst: string }[];
  refs: { src: string; dst: string }[];
  coDegrees: Record<string, number>;
}

/** Outcome of an incremental update — file counts reflect only what changed (ADR-25). */
export interface UpdateResult extends BuildResult {
  incremental: true;
  added: number;
  modified: number;
  deleted: number;
  /** Present when the update deleted files (captured BEFORE their DETACH DELETE). */
  deletedEdges?: DeletedFileEdges;
}

/** Reason an incremental update couldn't run and a full rebuild is required. */
export class FullRebuildRequired extends Error {}

const indexable = (relOrName: string): boolean =>
  isSupportedSource(relOrName) && !relOrName.endsWith('.d.ts') && !isGeneratedArtifact(relOrName);

/**
 * Source files to index, ABSOLUTE paths, `indexable`-filtered (supported ext, not `.d.ts`, not generated).
 * Git repo: `listWorktreeFiles` = working tree minus `.gitignore`d (so build output/`.plex` is skipped
 * while a brand-new uncommitted source file IS still indexed). Non-git: filesystem walk (SKIP_DIRS + dot-dirs).
 */
async function discoverFiles(root: string): Promise<string[]> {
  const tracked = await listWorktreeFiles(root);
  if (tracked) return tracked.filter(indexable).map((rel) => path.join(root, rel));

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && indexable(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/** Full rebuild of a per-repo code graph: File/Symbol nodes, Declares/Imports edges (ADR-15), CoChange edges (ADR-06). */
export async function buildCodeGraph(opts: BuildOptions): Promise<BuildResult> {
  const repoPath = path.resolve(opts.repoPath);
  const repoName = opts.repoName ?? path.basename(repoPath);

  if (opts.fresh !== false) await fs.rm(opts.dbDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(path.resolve(opts.dbDir)), { recursive: true });

  const db = new CodeGraphDB(opts.dbDir);
  try {
    await initSchema(db);

    const absFiles = await discoverFiles(repoPath);
    const relFiles = absFiles.map((f) => path.relative(repoPath, f).split(path.sep).join('/'));
    const fileSet = new Set(relFiles);

    await db.insertMany(
      'CREATE (:File {id:$id, path:$path, repo:$repo, lang:$lang})',
      relFiles.map((rel) => ({
        id: rel,
        path: rel,
        repo: repoName,
        lang: path.extname(rel).slice(1),
      })),
    );

    let symbolCount = 0;
    const symbolRows: Record<string, unknown>[] = [];
    const declareRows: Record<string, unknown>[] = [];
    const seenSymbolIds = new Set<string>();
    const importEdges = new Set<string>();
    const fileSpecifiers: PreciseImportInput[] = [];

    for (let i = 0; i < absFiles.length; i++) {
      const rel = relFiles[i]!;
      let text: string;
      try {
        text = await fs.readFile(absFiles[i]!, 'utf8');
      } catch {
        continue;
      }
      const { symbols, imports } = extractFromSource(rel, text);
      for (const s of symbols) {
        const id = uniqueSymbolId(`${rel}#${s.name}#${s.startLine}`, seenSymbolIds);
        symbolRows.push({
          id,
          name: s.name,
          kind: s.kind,
          file: rel,
          startLine: s.startLine,
          endLine: s.endLine,
          exported: s.exported,
        });
        declareRows.push({ f: rel, s: id });
        symbolCount++;
      }
      for (const spec of imports) {
        const target = resolveRelativeImport(rel, spec, fileSet);
        if (target && target !== rel) importEdges.add(`${rel}\t${target}`);
      }
      fileSpecifiers.push({ rel, abs: absFiles[i]!, specifiers: imports });
    }

    await db.insertMany(
      'CREATE (:Symbol {id:$id, name:$name, kind:$kind, file:$file, startLine:$startLine, endLine:$endLine, exported:$exported})',
      symbolRows,
    );
    await db.insertMany(
      'MATCH (f:File {id:$f}), (s:Symbol {id:$s}) CREATE (f)-[:Declares]->(s)',
      declareRows,
    );
    const importRows = [...importEdges].map((e) => {
      const [from, to] = e.split('\t');
      return { from, to };
    });
    await db.insertMany(
      'MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Imports]->(b)',
      importRows,
    );

    let refCount = 0;
    if (opts.precise !== false) {
      const precise = resolvePreciseImports(repoPath, fileSpecifiers, fileSet).filter(
        (e) => !importEdges.has(`${e.from}\t${e.to}`),
      );
      await db.insertMany(
        'MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Refs]->(b)',
        precise.map((e) => ({ from: e.from, to: e.to })),
      );
      refCount = precise.length;
    }

    let coChangePairs = 0;
    let commits = 0;
    try {
      const cs = await readCommits(repoPath, opts.coChange.maxCommits);
      commits = cs.length;
      const pairs = aggregateCoChange(cs, opts.coChange).filter(
        (p) => fileSet.has(p.a) && fileSet.has(p.b),
      );
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) CREATE (a)-[:CoChange {weight:$weight, cnt:$cnt}]->(b)',
        pairs.map((p) => ({ a: p.a, b: p.b, weight: p.weight, cnt: p.count })),
      );
      coChangePairs = pairs.length;
    } catch {
      // not a git repo / no history — co-change layer absent
    }

    const sha = await headSha(repoPath);
    await db.run('MERGE (m:Meta {key:$k}) SET m.val = $v', { k: 'headSha', v: sha });
    await db.run('MERGE (m:Meta {key:$k}) SET m.val = $v', { k: 'repo', v: repoName });

    return {
      files: relFiles.length,
      symbols: symbolCount,
      imports: importRows.length,
      refs: refCount,
      coChangePairs,
      commits,
    };
  } finally {
    await db.close();
  }
}

/**
 * Incrementally refresh an existing graph (ADR-25): re-extract only files changed since the stored
 * `headSha`. Edge correctness: a **modified** file keeps its File node so its *incoming* edges survive
 * (only Symbols + *outgoing* Imports/Refs are replaced); a **deleted** file is `DETACH DELETE`d.
 * Throws `FullRebuildRequired` (no stored sha / undiffable history) — callers fall back to `buildCodeGraph`.
 */
export async function updateCodeGraph(opts: BuildOptions): Promise<UpdateResult> {
  const repoPath = path.resolve(opts.repoPath);
  const repoName = opts.repoName ?? path.basename(repoPath);

  const db = new CodeGraphDB(opts.dbDir);
  try {
    const storedSha = await getMeta(db, 'headSha');
    if (!storedSha) throw new FullRebuildRequired('graph has no stored headSha; run a full index first');
    const delta = await changedSourceFilesSince(repoPath, storedSha);
    if (!delta) throw new FullRebuildRequired('cannot diff stored sha against HEAD (history rewritten?); run a full index');

    const absFiles = await discoverFiles(repoPath);
    const relFiles = absFiles.map((f) => path.relative(repoPath, f).split(path.sep).join('/'));
    const fileSet = new Set(relFiles);
    const absByRel = new Map(relFiles.map((rel, i) => [rel, absFiles[i]!]));

    // 1. Deleted (and rename-from): capture each file's edges FIRST within THIS open (re-opening the
    //    same Kùzu dir later in one process SIGSEGVs — ADR-17), THEN remove the File node + its Symbols.
    let deletedEdges: DeletedFileEdges | undefined;
    if (delta.deleted.length > 0) {
      const [co, imports, refs] = await Promise.all([
        getCoChangeEdges(db, delta.deleted),
        getImportEdges(db, delta.deleted),
        getRefEdges(db, delta.deleted),
      ]);
      const deg = await getCoChangeDegrees(db, [...new Set(co.flatMap((e) => [e.src, e.dst]))]);
      deletedEdges = { deletedPaths: delta.deleted, co, imports, refs, coDegrees: Object.fromEntries(deg) };
    }
    for (const rel of delta.deleted) {
      await db.run('MATCH (f:File {id:$id})-[:Declares]->(s:Symbol) DETACH DELETE s', { id: rel });
      await db.run('MATCH (f:File {id:$id}) DETACH DELETE f', { id: rel });
    }
    // 2. Modified: keep the File node (preserve incoming edges); clear Symbols + outgoing edges.
    for (const rel of delta.modified) {
      await db.run('MATCH (f:File {id:$id})-[:Declares]->(s:Symbol) DETACH DELETE s', { id: rel });
      await db.run('MATCH (:File {id:$id})-[r:Imports]->() DELETE r', { id: rel });
      await db.run('MATCH (:File {id:$id})-[r:Refs]->() DELETE r', { id: rel });
    }

    const upserts = [...new Set([...delta.added, ...delta.modified])].filter((rel) => fileSet.has(rel));
    await db.insertMany(
      'MERGE (f:File {id:$id}) SET f.path=$path, f.repo=$repo, f.lang=$lang',
      upserts.map((rel) => ({ id: rel, path: rel, repo: repoName, lang: path.extname(rel).slice(1) })),
    );

    let symbolCount = 0;
    const symbolRows: Record<string, unknown>[] = [];
    const declareRows: Record<string, unknown>[] = [];
    const seenSymbolIds = new Set<string>();
    const importEdges = new Set<string>();
    const fileSpecifiers: PreciseImportInput[] = [];
    for (const rel of upserts) {
      let text: string;
      try {
        text = await fs.readFile(absByRel.get(rel)!, 'utf8');
      } catch {
        continue;
      }
      const { symbols, imports } = extractFromSource(rel, text);
      for (const s of symbols) {
        const id = uniqueSymbolId(`${rel}#${s.name}#${s.startLine}`, seenSymbolIds);
        symbolRows.push({ id, name: s.name, kind: s.kind, file: rel, startLine: s.startLine, endLine: s.endLine, exported: s.exported });
        declareRows.push({ f: rel, s: id });
        symbolCount++;
      }
      for (const spec of imports) {
        const target = resolveRelativeImport(rel, spec, fileSet);
        if (target && target !== rel) importEdges.add(`${rel}\t${target}`);
      }
      fileSpecifiers.push({ rel, abs: absByRel.get(rel)!, specifiers: imports });
    }
    await db.insertMany(
      'CREATE (:Symbol {id:$id, name:$name, kind:$kind, file:$file, startLine:$startLine, endLine:$endLine, exported:$exported})',
      symbolRows,
    );
    await db.insertMany('MATCH (f:File {id:$f}), (s:Symbol {id:$s}) CREATE (f)-[:Declares]->(s)', declareRows);
    const importRows = [...importEdges].map((e) => {
      const [from, to] = e.split('\t');
      return { from, to };
    });
    await db.insertMany('MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Imports]->(b)', importRows);

    let refCount = 0;
    if (opts.precise !== false) {
      const precise = resolvePreciseImports(repoPath, fileSpecifiers, fileSet).filter((e) => !importEdges.has(`${e.from}\t${e.to}`));
      await db.insertMany('MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Refs]->(b)', precise.map((e) => ({ from: e.from, to: e.to })));
      refCount = precise.length;
    }

    // 5. Co-change: merge ONLY the commits since the last index (ADR-26) — accumulate onto stored
    //    pairs; new commits land at full recency (no epoch bookkeeping; decay re-baselines on a full build).
    let coChangePairs = 0;
    let commits = 0;
    try {
      const cs = await readCommits(repoPath, opts.coChange.maxCommits, storedSha);
      commits = cs.length;
      const inc = aggregateCoChange(cs, { ...opts.coChange, minPairCount: 1 }).filter((p) => fileSet.has(p.a) && fileSet.has(p.b));
      const strong = inc.filter((p) => p.count >= opts.coChange.minPairCount);
      const weak = inc.filter((p) => p.count < opts.coChange.minPairCount);
      // strong: create-or-accumulate (reaches the threshold within this window).
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) MERGE (a)-[c:CoChange]->(b) ' +
          'ON CREATE SET c.weight = $weight, c.cnt = $cnt ' +
          'ON MATCH SET c.weight = c.weight + $weight, c.cnt = c.cnt + $cnt',
        strong.map((p) => ({ a: p.a, b: p.b, weight: p.weight, cnt: p.count })),
      );
      // weak: a CoChange singleton is never created from one window (ADR-06 denoising); sub-threshold
      // evidence is STAGED in CoChangePending (a lane reads never traverse) and promoted once its
      // cross-window total reaches minPairCount — so a coupling landing one commit per window isn't forgotten.
      // Evict stale staged pairs FIRST (ts refreshed below): bounds the lane so never-promoted singletons
      // age out instead of accumulating (the N² noise ADR-06 prunes) and can't promote at full undecayed
      // weight a half-life later.
      const nowSec = Date.now() / 1000;
      if (opts.coChange.halfLifeDays > 0) {
        await db.run(
          'MATCH (a:File)-[p:CoChangePending]->(b:File) WHERE p.ts IS NULL OR p.ts < $cutoff DELETE p',
          { cutoff: nowSec - opts.coChange.halfLifeDays * 86400 },
        );
      }
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) MERGE (a)-[p:CoChangePending]->(b) ' +
          'ON CREATE SET p.weight = $weight, p.cnt = $cnt, p.ts = $ts ' +
          'ON MATCH SET p.weight = p.weight + $weight, p.cnt = p.cnt + $cnt, p.ts = $ts',
        weak.map((p) => ({ a: p.a, b: p.b, weight: p.weight, cnt: p.count, ts: nowSec })),
      );
      // Promote: staged pairs that crossed the threshold, plus pending residue for a pair that has
      // since gained a real edge (its evidence belongs on the edge now).
      const crossed = await db.run(
        'MATCH (a:File)-[p:CoChangePending]->(b:File) WHERE p.cnt >= $min RETURN a.id AS a, b.id AS b, p.weight AS weight, p.cnt AS cnt',
        { min: opts.coChange.minPairCount },
      );
      const nowStored = await db.run(
        'MATCH (a:File)-[p:CoChangePending]->(b:File), (a)-[c:CoChange]->(b) RETURN a.id AS a, b.id AS b, p.weight AS weight, p.cnt AS cnt',
      );
      const promotable = [...new Map([...crossed, ...nowStored].map((r) => [`${r.a}\t${r.b}`, r])).values()];
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) MERGE (a)-[c:CoChange]->(b) ' +
          'ON CREATE SET c.weight = $weight, c.cnt = $cnt ' +
          'ON MATCH SET c.weight = c.weight + $weight, c.cnt = c.cnt + $cnt',
        promotable.map((r) => ({ a: String(r.a), b: String(r.b), weight: Number(r.weight), cnt: Number(r.cnt) })),
      );
      await db.insertMany(
        'MATCH (a:File {id:$a})-[p:CoChangePending]->(b:File {id:$b}) DELETE p',
        promotable.map((r) => ({ a: String(r.a), b: String(r.b) })),
      );
      // Count UNIQUE pairs: a pair in both `strong` and `promotable` must not double-count.
      coChangePairs = new Set([...strong.map((p) => `${p.a}\t${p.b}`), ...promotable.map((r) => `${r.a}\t${r.b}`)]).size;
    } catch {
      // not a git repo / no history
    }

    const sha = await headSha(repoPath);
    await db.run('MERGE (m:Meta {key:$k}) SET m.val = $v', { k: 'headSha', v: sha });

    return {
      incremental: true,
      files: upserts.length,
      added: delta.added.length,
      modified: delta.modified.length,
      deleted: delta.deleted.length,
      symbols: symbolCount,
      imports: importRows.length,
      refs: refCount,
      coChangePairs,
      commits,
      deletedEdges,
    };
  } finally {
    await db.close();
  }
}
