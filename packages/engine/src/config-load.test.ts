import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config-load';
import { writeHomeConfig } from './home-config';

// loadConfig merges defaults < ~/.plex/config.json < env < overrides. It reads the user's
// REAL home config via os.homedir(), so every test sandboxes $HOME to a temp dir (verified:
// os.homedir() honors $HOME here) and clears PLEX_* env — otherwise results leak from the
// dev machine. No Kùzu → vitest-safe.
const ENV = ['PLEX_DATA_DIR', 'PLEX_KNOWLEDGE_DIR', 'PLEX_EMBEDDING_PROVIDER', 'PLEX_LLM_PROVIDER', 'PLEX_LLM_MODEL'];
let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plex-home-'));
  saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home; // windows fallback
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadConfig precedence', () => {
  it('with an empty home and no env → pure defaults (no machine leakage)', () => {
    const c = loadConfig();
    expect(c.dataDir).toBe('');
    expect(c.embedding.provider).toBe('none');
    expect(c.llm.provider).toBe('claude-cli');
  });

  it('surfaces an embedding provider + key written to ~/.plex/config.json', () => {
    writeHomeConfig({ embedding: { provider: 'voyage', apiKey: 'k' } });
    const c = loadConfig();
    expect(c.embedding.provider).toBe('voyage');
    expect(c.embedding.apiKey).toBe('k');
  });

  it('env provider overrides home but RETAINS the home key (the subtle merge)', () => {
    writeHomeConfig({ embedding: { provider: 'voyage', apiKey: 'k' } });
    process.env.PLEX_EMBEDDING_PROVIDER = 'openai';
    const c = loadConfig();
    expect(c.embedding.provider).toBe('openai');
    expect(c.embedding.apiKey).toBe('k'); // not dropped by the env override
  });

  it('PLEX_LLM_MODEL alone keeps the home llm provider', () => {
    writeHomeConfig({ llm: { provider: 'anthropic' } });
    process.env.PLEX_LLM_MODEL = 'claude-x';
    const c = loadConfig();
    expect(c.llm.provider).toBe('anthropic');
    expect(c.llm.model).toBe('claude-x');
  });

  it('env scalars apply (PLEX_DATA_DIR), and explicit overrides beat env', () => {
    process.env.PLEX_DATA_DIR = 'Y';
    expect(loadConfig().dataDir).toBe('Y');
    expect(loadConfig({ dataDir: 'X' }).dataDir).toBe('X'); // override wins
  });
});
