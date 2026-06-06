import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ReviewNeighborhood } from '@plex/core';

export interface FalkorOptions {
  url: string;
  timeoutMs?: number;
}

/** One Cypher statement for the isolated executor. */
export interface FalkorStatement {
  cypher: string;
  params?: Record<string, unknown>;
}

export interface FalkorRunResult {
  ok: boolean;
  /** results[i] = rows returned by statements[i] (empty for writes). */
  results?: unknown[][];
  /** Reason when not ok (unreachable, timeout, isolated-crash). */
  reason?: string;
}

export interface PublishResult {
  published: boolean;
  reason?: string;
}

/**
 * Run Cypher statements against a FalkorDB graph from an ISOLATED child process.
 *
 * IMPORTANT (ADR-16): the Kùzu native addon and the FalkorDB/node-redis stack SIGSEGV
 * when used in the same process. ALL FalkorDB I/O — reads and writes — therefore goes
 * through `falkor-worker.mjs` (plain JS, never loads Kùzu). The child can never take
 * down the server; callers decide whether an unreachable FalkorDB is fatal (M6 review
 * flow: yes, via requireFalkor) or best-effort (standalone viz).
 */
export function runFalkor(
  graphName: string,
  statements: FalkorStatement[],
  opts: FalkorOptions,
): Promise<FalkorRunResult> {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'falkor-worker.mjs');
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise<FalkorRunResult>((resolve) => {
    let settled = false;
    const done = (r: FalkorRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      done({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (err += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, reason: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim() || '{}') as FalkorRunResult;
        done(parsed.ok ? parsed : { ok: false, reason: parsed.reason ?? err.trim() ?? 'unknown' });
      } catch {
        done({ ok: false, reason: err.trim() || 'no worker output' });
      }
    });

    child.stdin?.write(JSON.stringify({ url: opts.url, graphName, statements }));
    child.stdin?.end();
  });
}

const base = (p: string): string => p.split('/').pop() || p;

/**
 * Mirror a review neighborhood into a FalkorDB graph for live visual debugging
 * (standalone / `blast` path). Wipes the graph and rebuilds the structural view; the
 * persistent PR brain (M6) accumulates via the engine instead of this.
 */
export async function publishNeighborhood(
  graphName: string,
  nb: ReviewNeighborhood,
  opts: FalkorOptions,
): Promise<PublishResult> {
  const statements: FalkorStatement[] = [
    { cypher: 'MATCH (n) DETACH DELETE n' },
    { cypher: 'CREATE (:ChangeSet {name:$n, repo:$r})', params: { n: graphName, r: nb.repo } },
  ];
  for (const c of nb.changed) {
    statements.push({
      cypher:
        'MATCH (h:ChangeSet {name:$n}) MERGE (f:File {path:$p}) ' +
        'SET f.name = $nm, f.changed = true, f.score = 1, f.distance = 0 ' +
        'MERGE (h)-[:CHANGED]->(f)',
      params: { n: graphName, p: c.file, nm: base(c.file) },
    });
  }
  for (const nbr of nb.neighbors) {
    const p = String(nbr.node.props.path);
    statements.push({
      cypher:
        'MATCH (h:ChangeSet {name:$n}) MERGE (f:File {path:$p}) ' +
        'SET f.name = $nm, f.score = $s, f.distance = $d, f.via = $v ' +
        'MERGE (h)-[:BLAST {score:$s, via:$v}]->(f)',
      params: { n: graphName, p, nm: base(p), s: nbr.score, d: nbr.distance, v: (nbr.via || []).join(',') },
    });
  }

  const res = await runFalkor(graphName, statements, opts);
  return res.ok ? { published: true } : { published: false, reason: res.reason };
}
