import http from 'node:http';
import { AddressInfo } from 'node:net';
import type { ReviewerConfig } from '@plex/core';
import { RepoBusyError } from '@plex/core';
import { listRepos, resolveRepo } from './registry';
import { collectCode, collectBrain, collectKnowledge, collectLineage, expandCodeFile } from './collect';
import { renderAppHtml } from './ui';
import { DEFAULT_PORT, HOST, type DaemonInfo } from './daemon';

export interface ServeOptions {
  port?: number;
  version?: string;
  /** Already-resolved config (CLI passes `loadConfig()`); read once at startup, like the MCP server. */
  config: ReviewerConfig;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  url: string;
  info: DaemonInfo;
  close: () => Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

/**
 * Handle one request. All store reads open Kùzu per-request and close immediately (collect.ts), so
 * the daemon never holds the single-writer lock; a `RepoBusyError` (a review holds it right now)
 * becomes a 503 the UI retries (ADR-45).
 */
async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: ServeOptions): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const p = url.pathname;
  const config = opts.config;

  if (p === '/healthz') {
    return json(res, 200, { ok: true, pid: process.pid, version: opts.version ?? '', startedAt: STARTED_AT });
  }
  if (p === '/' || p === '/index.html') {
    const html = renderAppHtml(opts.version ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(html);
  }
  if (p === '/api/repos') {
    const repos = listRepos(config).map((r) => ({ id: r.id, name: r.name, path: r.repoPath ?? '', hasGraph: r.hasGraph, hasBrain: r.hasBrain }));
    return json(res, 200, { repos });
  }

  // Every /api/graph and /api/expand request carries a validated repo id (path-traversal gate).
  if (p.startsWith('/api/graph/') || p === '/api/expand') {
    const repoId = url.searchParams.get('repo') ?? '';

    // Knowledge is machine-global, but optionally scoped to the selected repo (by name).
    if (p === '/api/graph/knowledge') {
      if (!repoId) return json(res, 200, await collectKnowledge(config.knowledgeDir));
      const scoped = resolveRepo(config, repoId);
      if (!scoped) return json(res, 404, { error: 'unknown repo', repo: repoId });
      return json(res, 200, await collectKnowledge(config.knowledgeDir, { repo: scoped.name }));
    }

    // The remaining graphs require a valid repo.
    const repo = repoId ? resolveRepo(config, repoId) : null;
    if (!repo) return json(res, 404, { error: 'unknown repo', repo: repoId });

    if (p === '/api/graph/code') return json(res, 200, await collectCode(repo));
    if (p === '/api/graph/brain') return json(res, 200, await collectBrain(repo));
    if (p === '/api/graph/lineage') return json(res, 200, await collectLineage(repo, config.knowledgeDir));
    if (p === '/api/expand') {
      const node = url.searchParams.get('node') ?? '';
      // Only File nodes expand (their symbols + neighbors). `node` is prefixed `f:<fileId>`.
      if (node.startsWith('f:')) return json(res, 200, await expandCodeFile(repo, node.slice(2)));
      return json(res, 200, { nodes: [], edges: [] });
    }
  }

  return json(res, 404, { error: 'not found', path: p });
}

/** Process start time — stamped once at module load (a normal long-lived server, not a replayable workflow). */
const STARTED_AT = new Date().toISOString();

/**
 * Start the HTTP server, binding **127.0.0.1 only** (never 0.0.0.0 — no remote exposure, ADR-45).
 * If `port` is taken, try the next few ports so a stale listener never blocks startup outright.
 */
export function startServer(opts: ServeOptions): Promise<RunningServer> {
  const first = opts.port ?? DEFAULT_PORT;
  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch((err) => {
      if (err instanceof RepoBusyError) return json(res, 503, { error: 'repo busy — a review is using it; retry', retry: true });
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port: number): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
          attempt += 1;
          tryListen(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, HOST, () => {
        const actual = (server.address() as AddressInfo).port;
        const info: DaemonInfo = { pid: process.pid, port: actual, version: opts.version ?? '', startedAt: STARTED_AT };
        resolve({
          server,
          port: actual,
          url: `http://${HOST}:${actual}`,
          info,
          close: () => new Promise<void>((res2) => server.close(() => res2())),
        });
      });
    };
    tryListen(first);
  });
}
