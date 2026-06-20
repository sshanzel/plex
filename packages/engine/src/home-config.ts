import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import type { EmbeddingProviderName, LlmProviderName } from '@plex/core';

/** Persistent global config at `~/.plex/config.json` (chmod 600 — it can hold an API key). Env vars override it. */
export interface HomeConfig {
  embedding?: { provider?: EmbeddingProviderName; apiKey?: string; model?: string };
  llm?: { provider?: LlmProviderName; model?: string };
  /** Learned-suppression recency-decay half-lives (ADR-41). */
  suppression?: { rejectHalfLifeDays?: number; waiveHalfLifeDays?: number };
  /** Positive-pitfall recency-decay knobs (ADR-42). */
  decay?: { halfLifeDays?: number; retrievalTiltFloor?: number; pruneFloor?: number; pruneMinAgeDays?: number };
  /** Viz daemon (ADR-45): `autoStart: true` restores always-on; default off (on-demand). */
  ui?: { autoStart?: boolean; port?: number };
}

export const homeConfigPath = (): string => path.join(os.homedir(), '.plex', 'config.json');

export function readHomeConfig(): HomeConfig {
  try {
    const f = homeConfigPath();
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as HomeConfig) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into `~/.plex/config.json` (chmod 600). Returns the merged config. */
export function writeHomeConfig(patch: HomeConfig): HomeConfig {
  const current = readHomeConfig();
  const merged: HomeConfig = {
    ...current,
    ...patch,
    embedding: { ...current.embedding, ...patch.embedding },
    llm: { ...current.llm, ...patch.llm },
    suppression: { ...current.suppression, ...patch.suppression },
    decay: { ...current.decay, ...patch.decay },
    ui: { ...current.ui, ...patch.ui },
  };
  const f = homeConfigPath();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(f, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  return merged;
}
