import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CoChangeConfig } from '@plex/core';
import { CodeGraphDB } from './db';
import { initSchema } from './schema';
import { extractFromSource, isSupportedSource, resolveRelativeImport } from './extract-ts';
import { aggregateCoChange, readCommits, headSha } from './co-change';
import { resolvePreciseImports, type PreciseImportInput } from './precise';

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
