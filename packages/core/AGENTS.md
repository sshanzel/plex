# @plex/core

The dependency-free base of the workspace: shared domain types, the config schema + defaults, and
the pluggable provider interfaces. Every other package imports from here; this package imports
from none (only `node:` builtins). Decisions: [`docs/adr/README.md`](../../docs/adr/README.md).

## Module map

- `src/types.ts` — domain types: `NormalizedDiff`/`DiffFile`/`DiffHunk` (ADR-14), graph
  nodes/edges with mandatory `provenance` + `weight` (ADR-06), `Finding`/`RankedFinding`
  (severity and confidence are **separate axes**, ADR-04; `awareness` is its own intent, ADR-31),
  `Verdict`/`Waiver` (ADR-10/27), `Pitfall`/`Incident` (ADR-08), brain primitives
  (`ReviewRound`, `PrComment`, `AttributedChange`).
- `src/config.ts` — `ReviewerConfig` + `defaultConfig` + `resolveConfig(overrides)` (deep-merges
  each section). Notable defaults: `dataDir: ''` (centralized), `embedding.provider: 'none'`,
  `llm.provider: 'claude-cli'`, `analyze.clusterThreshold: 0.8`, `autoComment: false`,
  `reviewPlan: { minFiles: 6, minSurface: 150, maxAgents: 5, minClusterFiles: 2 }`,
  `suppression: { rejectHalfLifeDays: 30, waiveHalfLifeDays: 365 }` (ADR-41),
  `decay: { halfLifeDays: 365, retrievalTiltFloor: 0.5, pruneFloor: 0.1, pruneMinAgeDays: 365 }` (positive-pitfall decay, ADR-42).
- `src/spawn-retry.ts` — `isTransientSpawnError` + `retryTransientSpawn`: the shared child-process
  retry policy (retry a never-forked SPAWN failure under fork-storm, never a non-zero EXIT). Lives here
  so `@plex/ingest` (`runGit`) and `@plex/code-graph` (`headSha`) can't drift apart — the audit found
  code-graph's `headSha` was an un-retried twin of the one ingest had hardened.
- `src/providers.ts` — `EmbeddingProvider` (text → vector; ADR-13) and `CompletionProvider`
  (offline analysis only, ADR-02/20) interfaces, plus pure helpers: `safeEmbed` (cap + chunk +
  **result-length check** + null-on-failure so callers degrade instead of failing — a provider that
  returns a different count than its input would silently misalign every `vecs[i]`), `cosineSimilarity`,
  `isGeneratedArtifact` (lockfiles/minified bundles/source maps/snapshots — the
  ignore-list every ingestion edge applies), `cosineBackground`/`adaptiveFloor` (anisotropy-aware thresholds,
  [`docs/design/tuning.md`](../../docs/design/tuning.md) §6), `slugify`, `hashId`.
- `src/errors.ts` — `RepoBusyError` + `isLockError`: translate Kùzu's single-writer file-lock
  IOException into an actionable message.
- `src/lineage-fold.ts` — pure event-sourcing fold for the durable lineage layer (ADR-46):
  `LineageEvent` types + `foldLineage` (round/finding/verdict/comment/outcome events → current state,
  last-write-wins per id, outcome tracked orthogonally so a re-raised finding never resets a `fixed`
  outcome) + `parseLineageEvents`. Shared by the engine `Brain` and the viz-server so both agree.
- `src/index.ts` — barrel.

## How config is actually resolved

This package only defines defaults and the merge (`resolveConfig`). The full precedence —
**env > `~/.plex/config.json` > defaults** — is implemented in `@plex/engine/src/config-load.ts`
(`loadConfig`), and the MCP server re-runs it **per tool call**, so config edits are live without
a restart (code changes are not — see the root `AGENTS.md` "config is live, code is not").

Data-dir resolution also lives in the engine (`@plex/engine/src/paths.ts`), driven by
`config.dataDir`: empty → `~/.plex/repos/<basename>-<sha1(path)[:8]>` (never writes in the user's
tree); absolute → that path as the repos root; relative (`PLEX_DATA_DIR=.plex`) → in-repo opt-in,
made self-ignoring by `ensureDataDir` (a `.gitignore` of `*` inside).

## Gotchas

- `embedding.provider: 'none'` means knowledge/semantic features are **off, not broken** —
  consumers must degrade (and do; `'fake'` is the deterministic test-only embedder, never a
  default).
- `EmbeddingConfig.apiKeyEnv` is preferred over `apiKey` (keeps secrets out of serialized config);
  `apiKey` exists for the `~/.plex/config.json` flow (ADR-29).
- Generative LLMs are not embedding models — `LlmConfig` is for the analysis distiller only.
- Keep this package pure (no I/O, no deps): the scoring/threshold helpers here are unit-testable
  precisely because of that.

## Testing

`config.test.ts`, `providers.test.ts`, `errors.test.ts`, `spawn-retry.test.ts` — all pure vitest units
(`pnpm test:unit`). Nothing here touches Kùzu or the network.
