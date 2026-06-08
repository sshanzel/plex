import { describe, it, expect } from 'vitest';
import { resolveConfig } from '@plex/core';
import { buildDoctorReport } from './doctor';

const base = {
  version: '0.2.0',
  config: resolveConfig({ embedding: { provider: 'voyage' }, dataDir: '' }),
  node: 'v22.0.0',
  pid: 1234,
};

describe('buildDoctorReport (the "is this build stale?" signal)', () => {
  it('flags stale when a NEWER build is on disk than the process loaded', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 1000, onDiskBuildMs: 5000 });
    expect(r.stale).toBe(true);
    expect(r.advice).toMatch(/reconnect Plex/i);
  });

  it('is NOT stale when disk == loaded (same build)', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 5000, onDiskBuildMs: 5000 });
    expect(r.stale).toBe(false);
    expect(r.advice).toMatch(/up to date/i);
  });

  it('is NOT stale when the on-disk build is older (e.g. clock jitter / unknown)', () => {
    expect(buildDoctorReport({ ...base, loadedBuildMs: 5000, onDiskBuildMs: 4000 }).stale).toBe(false);
    expect(buildDoctorReport({ ...base, loadedBuildMs: 5000, onDiskBuildMs: 0 }).stale).toBe(false);
  });

  it('surfaces the EFFECTIVE config (embeddings provider + dirs) so a config check is one call', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 1, onDiskBuildMs: 1 });
    expect(r.embeddings).toBe('voyage');
    expect(r.dataDir).toMatch(/centralized/); // dataDir '' renders as the centralized note
    expect(r.knowledgeDir).toContain('.plex');
  });

  it('renders unknown build times instead of an epoch date', () => {
    const r = buildDoctorReport({ ...base, loadedBuildMs: 0, onDiskBuildMs: 0 });
    expect(r.loadedBuild).toBe('unknown');
    expect(r.onDiskBuild).toBe('unknown');
  });
});
