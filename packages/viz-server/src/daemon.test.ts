import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDaemon, writeDaemon, clearDaemon, pidAlive, probe, liveDaemon, DEFAULT_PORT } from './daemon';

describe('daemon helpers', () => {
  let home: string;
  let origHome: string | undefined;
  beforeEach(() => {
    // Redirect HOME so the pidfile (`~/.plex/daemon.json`) lands in a temp dir — never the real one.
    origHome = process.env.HOME;
    home = mkdtempSync(path.join(os.tmpdir(), 'plex-home-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('DEFAULT_PORT is 2288 (ADR-45)', () => {
    expect(DEFAULT_PORT).toBe(2288);
  });

  it('write → read → clear round-trips the pidfile', () => {
    expect(readDaemon()).toBeNull();
    writeDaemon({ pid: 4242, port: 2288, version: '1.2.3', startedAt: 'now' });
    expect(readDaemon()).toEqual({ pid: 4242, port: 2288, version: '1.2.3', startedAt: 'now' });
    clearDaemon();
    expect(readDaemon()).toBeNull();
  });

  it('pidAlive is true for this process and false for an unused pid', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2_000_000_000)).toBe(false);
  });

  it('probe resolves null on a port nothing is listening on', async () => {
    expect(await probe(59_999, 200)).toBeNull();
  });

  it('liveDaemon clears a stale pidfile whose process is dead', async () => {
    writeDaemon({ pid: 2_000_000_000, port: 59_999, version: '', startedAt: '' });
    expect(await liveDaemon()).toBeNull();
    expect(readDaemon()).toBeNull(); // cleared because pid is dead and port is silent
  });
});
