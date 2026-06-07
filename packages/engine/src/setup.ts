import { spawnSync } from 'node:child_process';
import { runFalkor } from '@plex/neighborhood';

/**
 * Setup primitives for `plex init` / `doctor` (ADR-29): manage the FalkorDB container so
 * the user never has to think about the service, and probe reachability. All Docker work
 * is shelled out (no docker SDK dependency); FalkorDB reachability goes through the
 * isolated worker (ADR-16), so this never loads the redis stack in-process.
 */
export const FALKOR_IMAGE = 'falkordb/falkordb:v4.18.9';
const CONTAINER = 'plex-falkordb';

export function dockerAvailable(): boolean {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export interface FalkorUpResult {
  ok: boolean;
  url: string;
  /** What happened: started fresh, reused a running/stopped container, or a failure reason. */
  detail: string;
}

/** Ensure the pinned FalkorDB container is running (AOF on). Idempotent. */
export function falkorUp(port = 56379, browserPort = 53000): FalkorUpResult {
  const url = `redis://localhost:${port}`;
  if (!dockerAvailable()) return { ok: false, url, detail: 'docker not available' };

  const running = spawnSync('docker', ['ps', '-q', '-f', `name=^${CONTAINER}$`], { encoding: 'utf8' });
  if (running.stdout?.trim()) return { ok: true, url, detail: 'already running' };

  const exists = spawnSync('docker', ['ps', '-aq', '-f', `name=^${CONTAINER}$`], { encoding: 'utf8' });
  if (exists.stdout?.trim()) {
    const r = spawnSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
    return r.status === 0 ? { ok: true, url, detail: 'started existing container' } : { ok: false, url, detail: 'failed to start container' };
  }

  const r = spawnSync(
    'docker',
    [
      'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
      '-p', `${port}:6379`, '-p', `${browserPort}:3000`,
      '-v', 'plex-falkordb-data:/data',
      FALKOR_IMAGE, '--appendonly', 'yes',
    ],
    { stdio: 'ignore' },
  );
  return r.status === 0 ? { ok: true, url, detail: 'created container' } : { ok: false, url, detail: 'docker run failed' };
}

export function falkorDown(): boolean {
  return spawnSync('docker', ['stop', CONTAINER], { stdio: 'ignore' }).status === 0;
}

/** Is FalkorDB reachable at `url`? Probes via the isolated worker (ADR-16). */
export async function falkorReachable(url: string): Promise<boolean> {
  const res = await runFalkor('__plex_probe__', [{ cypher: 'RETURN 1 AS ok' }], { url });
  return res.ok;
}
