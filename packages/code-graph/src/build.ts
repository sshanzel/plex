import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CoChangeConfig } from '@plex/core';
import { CodeGraphDB } from './db';
import { initSchema } from './schema';
import { extractFromSource, isSupportedSource, resolveRelativeImport } from './extract-ts';
import { aggregateCoChange, readCommits, headSha, changedSourceFilesSince } from './co-change';
import { resolvePreciseImports, type PreciseImportInput } from './precise';
import { getMeta } from './query';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.plex',
]);

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

/** Outcome of an incremental update — file counts reflect only what changed (ADR-25). */
export interface UpdateResult extends BuildResult {
  incremental: true;
  added: number;
  modified: number;
  deleted: number;
}

/** Reason an incremental update couldn't run and a full rebuild is required. */
export class FullRebuildRequired extends Error {}

async function discoverFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && isSupportedSource(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Build (full rebuild) a per-repo code graph: File/Symbol nodes, Declares/Imports
 * edges (TS compiler — ADR-15), and CoChange edges (git history — ADR-06). Co-change
 * is best-effort: a non-git directory simply has no co-change layer.
 */
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
        const id = `${rel}#${s.name}#${s.startLine}`;
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

    // Precise (tsconfig-alias-aware) reference edges that the relative resolver missed.
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
      // not a git repo / no history — co-change layer is simply absent
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
 * Incrementally refresh an existing graph (ADR-25): re-extract only the files changed
 * since the graph's stored `headSha`, drop deleted ones, and recompute co-change. Pays
 * O(changed files) instead of re-parsing the whole repo.
 *
 * Edge correctness: a **modified** file keeps its File node so its *incoming* edges (from
 * unchanged importers) survive — only its Symbols + *outgoing* Imports/Refs are replaced.
 * A **deleted** file is `DETACH DELETE`d (removing its incoming edges too).
 *
 * Throws `FullRebuildRequired` when there's no stored sha or the diff can't be computed
 * (history rewritten) — callers should fall back to `buildCodeGraph`.
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

    // 1. Deleted (and rename-from): remove the File node + its Symbols (and dangling edges).
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

    // 3. Ensure File nodes for added/modified files that still exist on disk.
    const upserts = [...new Set([...delta.added, ...delta.modified])].filter((rel) => fileSet.has(rel));
    await db.insertMany(
      'MERGE (f:File {id:$id}) SET f.path=$path, f.repo=$repo, f.lang=$lang',
      upserts.map((rel) => ({ id: rel, path: rel, repo: repoName, lang: path.extname(rel).slice(1) })),
    );

    // 4. Re-extract symbols/imports/precise refs for the upserted files only.
    let symbolCount = 0;
    const symbolRows: Record<string, unknown>[] = [];
    const declareRows: Record<string, unknown>[] = [];
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
        const id = `${rel}#${s.name}#${s.startLine}`;
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

    // 5. Co-change: merge ONLY the commits since the last index (ADR-26) — accumulate onto
    //    stored pairs; create only new pairs reaching minPairCount within this window.
    //    Deleted files' edges were already removed (step 1); new pairs are fileSet-filtered.
    //    Decay re-baselines on a full build; here new commits land at full recency (the
    //    `Math.max(0, …)` clamp in aggregateCoChange), so no epoch bookkeeping is needed.
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
      // weak: a CoChange singleton is never created from one window (ADR-06 denoising), but
      // sub-threshold evidence is no longer FORGOTTEN between windows either. Pairs that
      // already have a stored CoChange edge accumulate into it; the rest are STAGED in
      // CoChangePending (a lane read queries never traverse) and PROMOTE to a real edge
      // when their cross-window total reaches minPairCount — without this, a coupling that
      // lands one commit per window (e.g. a review-triggered refresh after every commit)
      // stayed invisible until the next full rebuild. Pending resets on a full rebuild.
      const weakStored: typeof weak = [];
      const weakNew: typeof weak = [];
      for (const p of weak) {
        const hit = await db.run('MATCH (a:File {id:$a})-[c:CoChange]->(b:File {id:$b}) RETURN c.cnt AS cnt', { a: p.a, b: p.b });
        (hit.length > 0 ? weakStored : weakNew).push(p);
      }
      await db.insertMany(
        'MATCH (a:File {id:$a})-[c:CoChange]->(b:File {id:$b}) SET c.weight = c.weight + $weight, c.cnt = c.cnt + $cnt',
        weakStored.map((p) => ({ a: p.a, b: p.b, weight: p.weight, cnt: p.count })),
      );
      await db.insertMany(
        'MATCH (a:File {id:$a}), (b:File {id:$b}) MERGE (a)-[p:CoChangePending]->(b) ' +
          'ON CREATE SET p.weight = $weight, p.cnt = $cnt ' +
          'ON MATCH SET p.weight = p.weight + $weight, p.cnt = p.cnt + $cnt',
        weakNew.map((p) => ({ a: p.a, b: p.b, weight: p.weight, cnt: p.count })),
      );
      // Promote: staged pairs that crossed the threshold, plus any pending residue for a
      // pair that has since gained a real edge (its evidence belongs on the edge now).
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
      coChangePairs = strong.length + promotable.length;
    } catch {
      // not a git repo / no history
    }

    // 6. Re-stamp the indexed head.
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
    };
  } finally {
    await db.close();
  }
}
