import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ReviewNeighborhood } from '@plex/core';

export interface PublishOptions {
  url: string;
  timeoutMs?: number;
}

export interface PublishResult {
  published: boolean;
  /** Reason when not published (unreachable, timeout, isolated-crash) — informational. */
  reason?: string;
}

/**
 * Mirror a review neighborhood into an ephemeral FalkorDB graph `pr_<id>` for live
 * visual debugging in FalkorDB Browser (ADR-07).
 *
 * IMPORTANT (ADR-16): the Kùzu native addon and the FalkorDB/node-redis stack SIGSEGV
 * when used in the same process. Since this layer is optional, we publish from an
 * isolated child process (`falkor-worker.mjs`, plain JS so it needs no TS runtime).
 * The child can never take down the server; if FalkorDB is unreachable we degrade
 * silently and the in-process neighborhood remains authoritative.
 */
export function publishNeighborhood(
  graphName: string,
  nb: ReviewNeighborhood,
  opts: PublishOptions,
): Promise<PublishResult> {
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'falkor-worker.mjs');
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise<PublishResult>((resolve) => {
    let settled = false;
    const done = (r: PublishResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      done({ published: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ published: false, reason: 'timeout' });
    }, timeoutMs);

    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (err += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ published: false, reason: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim() || '{}') as PublishResult;
        done(parsed.published ? parsed : { published: false, reason: parsed.reason ?? err ?? 'unknown' });
      } catch {
        done({ published: false, reason: err.trim() || 'no worker output' });
      }
    });

    child.stdin?.write(JSON.stringify({ graphName, url: opts.url, nb }));
    child.stdin?.end();
  });
}
