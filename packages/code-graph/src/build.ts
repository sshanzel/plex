import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isGeneratedArtifact, type CoChangeConfig, type LanguagePlugin, type SourceUnit } from '@plex/core';
import { CodeGraphDB } from './db';
import { initSchema } from './schema';
import { pluginFor, isSupportedSource } from './languages';
import { aggregateCoChange, readCommits, headSha, changedSourceFilesSince, listWorktreeFiles } from './co-change';
import { getMeta, getCoChangeEdges, getImportEdges, getRefEdges, getCoChangeDegrees } from './query';

// Fallback skip-list for a NON-git directory (a git repo respects .gitignore instead — see discoverFiles).
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.plex',
  'venv',
  '__pycache__',
  'site-packages',
]);

/**
 * Bumped when the extractor/graph shape changes in a way an incremental update can't reproduce —
 * e.g. adding a language, whose existing (unchanged) files an incremental pass would never index.
 * A mismatch throws `FullRebuildRequired`, so the first post-upgrade review full-rebuilds.
 * '3': co-change now FOLLOWS renames across history (readCommits `foldRenames`); existing graphs must
 * rebuild once so pre-rename coupling folds onto current paths rather than staying dropped.
 */
export const GRAPH_VERSION = '3';

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
  /** TEST SEAM: plugin-dispatch override so degradation paths (a runtime failing to load) are
   *  pinnable without breaking a real wasm. Production always uses the default `pluginFor`. */
  resolvePlugin?: (file: string) => LanguagePlugin | undefined;
}

export interface BuildResult {
  files: number;
  symbols: number;
  imports: number;
  refs: number;
  coChangePairs: number;
  commits: number;
  /** Present when a language runtime failed to load and its files were skipped (degraded build). */
  skippedLanguages?: string[];
}

/** Raw graph edges of files an update DELETED, captured before their nodes were removed. Raw on
 *  purpose: weighting lives upstream in @plex/neighborhood, which this package cannot depend on. */
export interface DeletedFileEdges {
  deletedPaths: string[];
  co: { src: string; dst: string; weight: number; cnt: number }[];
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

export interface ExtractBatch {
  symbolRows: Record<string, unknown>[];
  declareRows: Record<string, unknown>[];
  importRows: { from: string; to: string }[];
  refRows: { from: string; to: string }[];
  /** Plugin ids whose runtime failed to load — their files were skipped, and the build must NOT be
   *  stamped as version-current (the sidecar/version gate then retries until the language heals). */
  skippedLanguages: string[];
}

/**
 * Extraction + import resolution shared by the full build and the incremental update: per-file
 * plugin dispatch in the given order (deterministic order keeps `uniqueSymbolId` suffixes stable
 * across re-indexes), then ONE batch `resolve` per plugin (Python needs a whole-fileSet module
 * index before any single import can resolve). Exported for unit tests (`resolvePlugin` injectable);
 * production callers are the two build paths below.
 */
export async function extractAndResolve(
  repoPath: string,
  rels: readonly string[],
  absByRel: ReadonlyMap<string, string>,
  fileSet: ReadonlySet<string>,
  precise: boolean,
  resolvePlugin: (file: string) => LanguagePlugin | undefined = pluginFor,
): Promise<ExtractBatch> {
  const symbolRows: Record<string, unknown>[] = [];
  const declareRows: Record<string, unknown>[] = [];
  const seenSymbolIds = new Set<string>();
  const unitsByPlugin = new Map<LanguagePlugin, SourceUnit[]>();
  const failedPlugins = new Set<LanguagePlugin>();

  for (const rel of rels) {
    const plugin = resolvePlugin(rel);
    if (!plugin || failedPlugins.has(plugin)) continue;
    try {
      await plugin.init?.();
    } catch {
      // Degrade, never fail: a broken language runtime (e.g. the wasm load) skips THAT language's
      // files for this run instead of killing the whole index of a mixed repo.
      failedPlugins.add(plugin);
      continue;
    }
    let extracted;
    try {
      const text = await fs.readFile(absByRel.get(rel)!, 'utf8');
      extracted = plugin.extract(rel, text);
    } catch {
      // Per-file guard, same spirit as uniqueSymbolId: ONE pathological file (unreadable, or an
      // extractor throw on wasm memory exhaustion etc.) must never abort the whole index.
      continue;
    }
    const { symbols, imports } = extracted;
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
    }
    let units = unitsByPlugin.get(plugin);
    if (!units) unitsByPlugin.set(plugin, (units = []));
    units.push({ rel, abs: absByRel.get(rel)!, imports });
  }

  const importSeen = new Set<string>();
  const importRows: { from: string; to: string }[] = [];
  const refRows: { from: string; to: string }[] = [];
  for (const [plugin, units] of unitsByPlugin) {
    const resolved = plugin.resolve(repoPath, units, fileSet, { refs: precise });
    for (const e of resolved.imports) {
      const key = `${e.from}\t${e.to}`;
      if (importSeen.has(key)) continue;
      importSeen.add(key);
      importRows.push(e);
    }
    refRows.push(...resolved.refs);
  }
  return { symbolRows, declareRows, importRows, refRows, skippedLanguages: [...failedPlugins].map((p) => p.id) };
}

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
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') || e.name.endsWith('.egg-info')) continue;
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

    const absByRel = new Map(relFiles.map((rel, i) => [rel, absFiles[i]!]));
    const batch = await extractAndResolve(repoPath, relFiles, absByRel, fileSet, opts.precise !== false, opts.resolvePlugin);

    await db.insertMany(
      'CREATE (:Symbol {id:$id, name:$name, kind:$kind, file:$file, startLine:$startLine, endLine:$endLine, exported:$exported})',
      batch.symbolRows,
    );
    await db.insertMany(
      'MATCH (f:File {id:$f}), (s:Symbol {id:$s}) CREATE (f)-[:Declares]->(s)',
      batch.declareRows,
    );
    await db.insertMany(
      'MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Imports]->(b)',
      batch.importRows,
    );
    await db.insertMany(
      'MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Refs]->(b)',
      batch.refRows,
    );

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
    // A DEGRADED build (a language runtime failed to load, its files skipped) is never stamped
    // version-current: the absent stamp makes the next incremental throw FullRebuildRequired, so
    // the graph self-heals the moment the runtime loads again instead of staying silently partial.
    if (batch.skippedLanguages.length === 0) {
      await db.run('MERGE (m:Meta {key:$k}) SET m.val = $v', { k: 'graphVersion', v: GRAPH_VERSION });
    }

    return {
      files: relFiles.length,
      symbols: batch.symbolRows.length,
      imports: batch.importRows.length,
      refs: batch.refRows.length,
      coChangePairs,
      commits,
      ...(batch.skippedLanguages.length > 0 ? { skippedLanguages: batch.skippedLanguages } : {}),
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
    const storedVersion = await getMeta(db, 'graphVersion');
    if (storedVersion !== GRAPH_VERSION) {
      // An older graph predates the current extractors (e.g. no Python symbols at all); incremental
      // only touches CHANGED files, so it could never backfill — force the one-time full rebuild.
      throw new FullRebuildRequired(
        `graph version ${storedVersion ?? '(none)'} != ${GRAPH_VERSION}; extractors changed — full re-index required`,
      );
    }
    const delta = await changedSourceFilesSince(repoPath, storedSha);
    if (!delta) throw new FullRebuildRequired('cannot diff stored sha against HEAD (history rewritten?); run a full index');

    const absFiles = await discoverFiles(repoPath);
    const relFiles = absFiles.map((f) => path.relative(repoPath, f).split(path.sep).join('/'));
    const fileSet = new Set(relFiles);
    const absByRel = new Map(relFiles.map((rel, i) => [rel, absFiles[i]!]));

    // Preflight the language runtimes BEFORE any destructive step: the modified files' symbols are
    // DETACH-DELETEd below, so a runtime that fails to load mid-update would ERASE them while
    // headSha still advances. Failing over to the full rebuild keeps the graph consistent (the full
    // build degrades by skipping the language and withholds the version stamp — see buildCodeGraph).
    const resolvePlugin = opts.resolvePlugin ?? pluginFor;
    const preflight = new Set<LanguagePlugin>();
    for (const rel of [...delta.added, ...delta.modified]) {
      const plugin = resolvePlugin(rel);
      if (plugin) preflight.add(plugin);
    }
    for (const plugin of preflight) {
      try {
        await plugin.init?.();
      } catch {
        throw new FullRebuildRequired(`the '${plugin.id}' language runtime failed to load; falling back to a full rebuild`);
      }
    }

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

    const batch = await extractAndResolve(repoPath, upserts, absByRel, fileSet, opts.precise !== false, opts.resolvePlugin);
    await db.insertMany(
      'CREATE (:Symbol {id:$id, name:$name, kind:$kind, file:$file, startLine:$startLine, endLine:$endLine, exported:$exported})',
      batch.symbolRows,
    );
    await db.insertMany('MATCH (f:File {id:$f}), (s:Symbol {id:$s}) CREATE (f)-[:Declares]->(s)', batch.declareRows);
    await db.insertMany('MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Imports]->(b)', batch.importRows);
    await db.insertMany('MATCH (a:File {id:$from}), (b:File {id:$to}) CREATE (a)-[:Refs]->(b)', batch.refRows);

    // 4b. Rename migration (ADR-53): a renamed file's old node was DETACH DELETEd above, so its
    //     accumulated CoChange edges — captured in `deletedEdges.co` BEFORE that deletion — must
    //     re-anchor onto the new-path node, else a rename resets the file's blast radius. The window's
    //     OWN commits already fold onto the new path via readCommits `foldRenames`; this carries the
    //     PRE-window coupling (a disjoint commit set, so the accumulate below is correct). Direction is
    //     canonicalized (a<b) to match how CoChange is stored; a both-endpoints-renamed edge — which
    //     getCoChangeEdges lists from each end — is deduped so one physical edge migrates once.
    if (delta.renamed.length > 0 && deletedEdges) {
      const renameMap = new Map(delta.renamed.map((r) => [r.from, r.to]));
      const seen = new Set<string>();
      const migrated: { a: string; b: string; weight: number; cnt: number }[] = [];
      for (const e of deletedEdges.co) {
        const src = renameMap.get(e.src) ?? e.src;
        const dst = renameMap.get(e.dst) ?? e.dst;
        if (src === e.src && dst === e.dst) continue; // neither endpoint renamed (a plain delete)
        if (src === dst) continue; // self-loop after mapping
        if (!fileSet.has(src) || !fileSet.has(dst)) continue; // an endpoint is gone from the tree
        const [a, b] = src < dst ? [src, dst] : [dst, src];
        const key = `${a}\t${b}`;
        if (seen.has(key)) continue; // the bidirectional listing of one edge
        seen.add(key);
        migrated.push({ a, b, weight: e.weight, cnt: e.cnt });
      }
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) MERGE (a)-[c:CoChange]->(b) ' +
          'ON CREATE SET c.weight = $weight, c.cnt = $cnt ' +
          'ON MATCH SET c.weight = c.weight + $weight, c.cnt = c.cnt + $cnt',
        migrated,
      );
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
      symbols: batch.symbolRows.length,
      imports: batch.importRows.length,
      refs: batch.refRows.length,
      coChangePairs,
      commits,
      deletedEdges,
      ...(batch.skippedLanguages.length > 0 ? { skippedLanguages: batch.skippedLanguages } : {}),
    };
  } finally {
    await db.close();
  }
}
