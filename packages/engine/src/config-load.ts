import {
  resolveConfig,
  defaultConfig,
  type ReviewerConfig,
  type EmbeddingProviderName,
} from '@plex/core';
import { readHomeConfig } from './home-config';

/** Parse a numeric env var; undefined/empty/non-finite → undefined (ignored, not 0). */
const numEnv = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Build a config in increasing precedence: defaults < `~/.plex/config.json` < env vars < explicit overrides. */
export function loadConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  const home = readHomeConfig();
  const env = process.env;
  const o: Partial<ReviewerConfig> = {};

  if (home.embedding?.provider) {
    o.embedding = {
      provider: home.embedding.provider,
      ...(home.embedding.apiKey ? { apiKey: home.embedding.apiKey } : {}),
      ...(home.embedding.model ? { model: home.embedding.model } : {}),
    };
  }
  // Suppression half-lives (ADR-41). Collect home values; env may override below.
  const supp: { rejectHalfLifeDays?: number; waiveHalfLifeDays?: number } = {};
  if (typeof home.suppression?.rejectHalfLifeDays === 'number') supp.rejectHalfLifeDays = home.suppression.rejectHalfLifeDays;
  if (typeof home.suppression?.waiveHalfLifeDays === 'number') supp.waiveHalfLifeDays = home.suppression.waiveHalfLifeDays;
  // Positive-pitfall decay knobs (ADR-42).
  const dec: { halfLifeDays?: number; retrievalTiltFloor?: number; pruneFloor?: number; pruneMinAgeDays?: number } = {};
  if (typeof home.decay?.halfLifeDays === 'number') dec.halfLifeDays = home.decay.halfLifeDays;
  if (typeof home.decay?.retrievalTiltFloor === 'number') dec.retrievalTiltFloor = home.decay.retrievalTiltFloor;
  if (typeof home.decay?.pruneFloor === 'number') dec.pruneFloor = home.decay.pruneFloor;
  if (typeof home.decay?.pruneMinAgeDays === 'number') dec.pruneMinAgeDays = home.decay.pruneMinAgeDays;

  if (env.PLEX_DATA_DIR) o.dataDir = env.PLEX_DATA_DIR;
  if (env.PLEX_KNOWLEDGE_DIR) o.knowledgeDir = env.PLEX_KNOWLEDGE_DIR;
  if (env.PLEX_AUTO_COMMENT) o.autoComment = /^(1|true|yes)$/i.test(env.PLEX_AUTO_COMMENT);
  if (env.PLEX_AUTO_COMMENT_SKIP_NITS) o.autoCommentSkipNits = /^(1|true|yes)$/i.test(env.PLEX_AUTO_COMMENT_SKIP_NITS);
  if (env.PLEX_EMBEDDING_PROVIDER) {
    o.embedding = { ...(o.embedding ?? {}), provider: env.PLEX_EMBEDDING_PROVIDER as EmbeddingProviderName };
  }
  const reEnv = numEnv(env.PLEX_SUPPRESSION_REJECT_HALFLIFE_DAYS);
  const waEnv = numEnv(env.PLEX_SUPPRESSION_WAIVE_HALFLIFE_DAYS);
  if (reEnv != null) supp.rejectHalfLifeDays = reEnv;
  if (waEnv != null) supp.waiveHalfLifeDays = waEnv;
  // Only set when a value was supplied; a partial fills the rest from defaults via `resolveConfig`.
  if (supp.rejectHalfLifeDays != null || supp.waiveHalfLifeDays != null) {
    o.suppression = { ...defaultConfig.suppression, ...supp };
  }
  const decHl = numEnv(env.PLEX_DECAY_HALFLIFE_DAYS);
  const decTilt = numEnv(env.PLEX_DECAY_RETRIEVAL_TILT_FLOOR);
  const decPruneFloor = numEnv(env.PLEX_DECAY_PRUNE_FLOOR);
  const decPruneAge = numEnv(env.PLEX_DECAY_PRUNE_MIN_AGE_DAYS);
  if (decHl != null) dec.halfLifeDays = decHl;
  if (decTilt != null) dec.retrievalTiltFloor = decTilt;
  if (decPruneFloor != null) dec.pruneFloor = decPruneFloor;
  if (decPruneAge != null) dec.pruneMinAgeDays = decPruneAge;
  if (dec.halfLifeDays != null || dec.retrievalTiltFloor != null || dec.pruneFloor != null || dec.pruneMinAgeDays != null) {
    o.decay = { ...defaultConfig.decay, ...dec };
  }
  // Viz daemon (ADR-45) — on-demand by default; opt into always-on via home config or env.
  const ui: { autoStart?: boolean; port?: number } = {};
  if (typeof home.ui?.autoStart === 'boolean') ui.autoStart = home.ui.autoStart;
  if (typeof home.ui?.port === 'number') ui.port = home.ui.port;
  if (env.PLEX_UI_AUTOSTART) ui.autoStart = /^(1|true|yes)$/i.test(env.PLEX_UI_AUTOSTART);
  const uiPortEnv = numEnv(env.PLEX_UI_PORT);
  if (uiPortEnv != null) ui.port = uiPortEnv;
  if (ui.autoStart != null || ui.port != null) o.ui = { ...defaultConfig.ui, ...ui };

  return resolveConfig({ ...o, ...overrides });
}
