import os from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

/** The default UI port (ADR-45). Configurable via `PLEX_UI_PORT`; the daemon falls back if it's taken. */
export const DEFAULT_PORT = 2108;
export const HOST = '127.0.0.1';

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

/** `~/.plex/daemon.json` — the single source of truth for "is the UI up, and where". */
export function daemonFile(): string {
  return path.join(os.homedir(), '.plex', 'daemon.json');
}

export function readDaemon(): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(daemonFile(), 'utf8')) as Partial<DaemonInfo>;
    if (typeof raw.pid === 'number' && typeof raw.port === 'number') {
      return { pid: raw.pid, port: raw.port, version: String(raw.version ?? ''), startedAt: String(raw.startedAt ?? '') };
    }
  } catch {
    /* no/invalid pidfile */
  }
  return null;
}

export function writeDaemon(info: DaemonInfo): void {
  mkdirSync(path.dirname(daemonFile()), { recursive: true });
  writeFileSync(daemonFile(), JSON.stringify(info, null, 2), 'utf8');
}

export function clearDaemon(): void {
  try {
    unlinkSync(daemonFile());
  } catch {
    /* already gone */
  }
}

/** Is a process with this pid alive? `kill(pid, 0)` tests existence without signalling. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours (still "alive").
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Probe the health endpoint — the authoritative "the daemon is actually serving" check. */
export function probe(port: number, timeoutMs = 800): Promise<DaemonInfo | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body) as Partial<DaemonInfo> & { ok?: boolean };
          resolve(j.ok ? { pid: Number(j.pid) || 0, port, version: String(j.version ?? ''), startedAt: String(j.startedAt ?? '') } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

export interface EnsureOptions {
  /** Node executable to launch the daemon with (typically `process.execPath`). */
  execPath: string;
  /** Path to the built `plex.js` CLI whose `serve --foreground` becomes the daemon. */
  scriptPath: string;
  port?: number;
}

/**
 * Best-effort "make sure the UI is up" — the **universal auto-start** the MCP server calls on
 * startup so EVERY Plex user (Claude plugin, Codex plugin, or a bare MCP registration) gets the UI
 * without a CLI install or a client-specific hook (ADR-45). Probes first (cheap no-op when already
 * up), else detached-spawns `node plex.js serve --foreground` and returns immediately.
 *
 * **STDOUT-SAFE and non-throwing** by contract: the MCP server's stdout IS its protocol channel, so
 * this writes nothing to stdout, spawns the child with `stdio: 'ignore'` + `unref()`, and swallows
 * every error. Returns the live daemon if one was already running, else null (it was just spawned
 * and may still be binding). No-ops silently when `scriptPath` doesn't exist (dev/tsx: no built CLI).
 */
export async function ensureDaemon(opts: EnsureOptions): Promise<DaemonInfo | null> {
  try {
    const live = await liveDaemon();
    if (live) return live;
    if (!opts.scriptPath || !existsSync(opts.scriptPath)) return null; // no built CLI to spawn (dev/tsx)
    const args = [opts.scriptPath, 'serve', '--foreground'];
    if (opts.port) args.push('--port', String(opts.port));
    spawn(opts.execPath, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* best-effort — never break the caller (MCP startup) */
  }
  return null;
}

/**
 * Resolve the live daemon: trust the health probe over the pidfile (a probe confirms it's serving;
 * a stale pidfile after a crash would otherwise read as "running"). If the pidfile points at a port
 * nothing answers AND the pid is dead, clear it so the next `serve` starts cleanly.
 */
export async function liveDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemon();
  if (!info) return null;
  const ok = await probe(info.port);
  if (ok) return { ...info, pid: ok.pid || info.pid };
  if (!pidAlive(info.pid)) clearDaemon();
  return null;
}
