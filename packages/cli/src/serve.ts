import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewerConfig } from '@plex/core';
import {
  startServer,
  liveDaemon,
  readDaemon,
  writeDaemon,
  clearDaemon,
  probe,
  DEFAULT_PORT,
  HOST,
} from '@plex/viz-server';

export interface ServeFlags {
  foreground?: boolean;
  stop?: boolean;
  status?: boolean;
  open?: boolean;
  port?: number;
}

/** Resolve the UI port: explicit `--port` flag wins, else the configured port (`config.ui.port`,
 *  which already folds in `PLEX_UI_PORT` / home config / the 2288 default via `loadConfig`). */
export function resolvePort(flagPort: number | undefined, configPort = DEFAULT_PORT): number {
  if (flagPort && Number.isFinite(flagPort)) return flagPort;
  return Number.isFinite(configPort) && configPort > 0 ? configPort : DEFAULT_PORT;
}

/** Best-effort build version for the UI header — read the package.json nearest the running script. */
function readVersion(): string {
  for (const dir of [path.dirname(process.argv[1] ?? ''), path.resolve(path.dirname(process.argv[1] ?? ''), '..')]) {
    try {
      return String(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? '');
    } catch {
      /* try the next candidate */
    }
  }
  return '';
}

/** Open `url` in the default browser, best-effort (never throws — the URL is printed regardless). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless / no opener — fine */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The `plex serve` command. Modes:
 *  - `--foreground` — BE the daemon: bind, write the pidfile, run until signalled. Returns a
 *    never-resolving promise so the CLI's `main().then(process.exit)` doesn't tear it down.
 *  - `--stop` / `--status` — manage an existing daemon via the pidfile + health probe.
 *  - (default) — idempotent: if a daemon is already live, just open it; else spawn one **detached**
 *    (survives this shell), wait for it to answer, print the URL and open the browser.
 */
export async function runServe(config: ReviewerConfig, flags: ServeFlags): Promise<number> {
  const out = process.stdout;
  const version = readVersion();

  if (flags.stop) {
    const info = readDaemon();
    const live = await liveDaemon();
    if (live ?? info) {
      const pid = (live ?? info)!.pid;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
      clearDaemon();
      out.write(`Stopped Plex UI daemon (pid ${pid}).\n`);
    } else {
      out.write('No Plex UI daemon is running.\n');
    }
    return 0;
  }

  if (flags.status) {
    const live = await liveDaemon();
    if (live) out.write(`Plex UI is running at http://${HOST}:${live.port} (pid ${live.pid}${live.version ? `, v${live.version}` : ''}).\n`);
    else out.write('Plex UI is not running. Start it with `plex serve`.\n');
    return 0;
  }

  if (flags.foreground) {
    const running = await startServer({ config, port: resolvePort(flags.port, config.ui.port), version });
    writeDaemon(running.info);
    const shutdown = (): void => {
      clearDaemon();
      running.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    out.write(`Plex UI serving at ${running.url} (pid ${process.pid}). Ctrl-C to stop.\n`);
    return new Promise<number>(() => {}); // never resolves — keep the daemon alive
  }

  // Default: ensure a detached daemon is up, then open it.
  const existing = await liveDaemon();
  if (existing) {
    const url = `http://${HOST}:${existing.port}`;
    out.write(`Plex UI already running at ${url}. Opening…\n`);
    openBrowser(url);
    return 0;
  }

  const port = resolvePort(flags.port, config.ui.port);
  const script = process.argv[1];
  if (!script) {
    out.write('Cannot resolve the plex executable to spawn the daemon. Run `plex serve --foreground` instead.\n');
    return 1;
  }
  const child = spawn(process.execPath, [script, 'serve', '--foreground', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for the detached child to bind + write its pidfile (it may fall back to port+N if taken).
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    const live = await liveDaemon();
    if (live) {
      const url = `http://${HOST}:${live.port}`;
      out.write(`Plex UI started at ${url} (pid ${live.pid}). Opening…\n`);
      out.write('Stop it with `plex serve --stop`.\n');
      openBrowser(url);
      return 0;
    }
  }
  // It might still be coming up; probe the requested port one last time for a clearer message.
  const last = await probe(port);
  out.write(
    last
      ? `Plex UI is starting at http://${HOST}:${last.port}.\n`
      : 'Timed out waiting for the Plex UI daemon to start. Try `plex serve --foreground` to see the error.\n',
  );
  return last ? 0 : 1;
}
