#!/usr/bin/env node
/**
 * reviewer MCP server (stdio). The shebang is preserved by tsup into dist/plex-mcp.js (the spawnable bin).
 * The integration seam (ADR-02): the agent brings the LLM; this server stays model-agnostic and runs in
 * a fresh process, separate from whoever authored the code — which removes self-review bias.
 */
import path from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isSafeGitRef } from '@plex/core';
import {
  loadConfig,
  indexRepo,
  assembleReviewContext,
  blastRadius,
  getDeterministicFindings,
  rankReviewFindings,
  getRelevantKnowledge,
  consolidateKnowledge,
  submitVerdict,
  reviewTargetFor,
  reconcileOutcomes,
  sweepRepo,
  maybeSpawnSweep,
  scanForAnalysis,
  addAnalyzedPitfalls,
  analyzeRepo,
  refreshAnalyzedOutcomes,
  embeddingReady,
  type SubmittedFinding,
  type AgentPitfall,
} from '@plex/engine';
import { ensureDaemon } from '@plex/viz-server';
import { buildDoctorReport } from './doctor';

// Single-sourced from the package.json beside the bundle (dist/ → ../package.json) — never hand-bumped.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// This running file's mtime = the build this process LOADED; doctor compares it to the on-disk mtime to
// detect a newer build (a long-lived stdio process runs its loaded code until reconnected/respawned).
const SELF = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return '';
  }
})();
const buildMtimeMs = (): number => {
  try {
    return SELF ? statSync(SELF).mtimeMs : 0;
  } catch {
    return 0;
  }
};
const LOADED_BUILD_MS = buildMtimeMs();

// Config is RE-READ per tool call (in `guard`), so config.json edits apply without a restart. `let`,
// not `const`: `guard` reassigns it and every handler's thunk reads it at call time.
let config = loadConfig();
const server = new McpServer(
  { name: 'plex', version: VERSION },
  {
    // Surfaced to the client so tool-search can discover Plex when MCP tools are deferred (pair with
    // `.mcp.json` "alwaysLoad": true to load eagerly).
    instructions:
      'Plex — code-review orchestration for a diff or GitHub PR. Flow: index_repo (once) → ' +
      'get_review_context (blast radius + deterministic checks + relevant pitfalls + the PR brain) → ' +
      'reason → submit_findings (one ranked, triaged stream; optionally posts the review to the PR) → ' +
      'record_outcome (accept | reject | waive | acknowledge). reconcile_outcomes checks whether pushed commits ' +
      'addressed findings. Review-history analysis (distill recurring review comments into pitfalls): ' +
      'analyze_scan / add_pitfalls / analyze_history / consolidate_knowledge. `doctor` reports version + whether a newer build is on ' +
      'disk (reconnect to load it). NOTE: this stdio server idle-drops after a few seconds and re-spawns on ' +
      'the next call (~400ms), and is stateless per call (reads the brain/graph from disk) — so a ' +
      '"disconnected" status is NEVER a reason to skip a step; just call the tool (the call reconnects), or ' +
      'ToolSearch("mcp__plex__") first if the tools are deferred. record_outcome and reconcile_outcomes are ' +
      'INTERNAL learning-loop bookkeeping — call them silently and best-effort; never report their ' +
      'success/failure to the user, and never ask the user to reconnect Plex for them (if a call truly ' +
      "can't complete, drop it — the next review reconciles by locality). Prefer these tools over reviewing a diff by hand.",
  },
);

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (m: string) => ({ content: [{ type: 'text' as const, text: m }], isError: true });
const guard = async (fn: () => Promise<unknown>, label: string) => {
  try {
    config = loadConfig(); // refresh per call so config edits apply without a restart
    return json(await fn());
  } catch (e) {
    return fail(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// The diff-source axes, shared by every review-flow tool. One review MUST use the SAME source params
// across context → findings → outcomes → reconcile — they key the brain target (reviewTargetFor).
const diffSourceShape = {
  source: z.enum(['local', 'pr']).optional().describe('"local" (default) or "pr" (requires `pr`).'),
  mode: z
    .enum(['working', 'staged', 'branch'])
    .optional()
    .describe('Local diffs only: working (default) | staged | branch (diff vs baseRef). Ignored when source is "pr".'),
  baseRef: z
    .string()
    .refine(isSafeGitRef, 'baseRef must be a valid git ref (no leading "-")')
    .optional()
    .describe('Base ref for mode "branch" (default "main").'),
  pr: z
    .union([z.string().regex(/^\d+$/, 'pr must be a positive integer'), z.number().int().positive()])
    .optional()
    .describe('GitHub PR number — required with source "pr".'),
};

server.tool(
  'index_repo',
  'Build the code graph for a repo (TS symbols/imports + git co-change). Full rebuild by default; pass incremental:true to refresh only files changed since the last index (falls back to full when needed).',
  { repoPath: z.string().optional(), incremental: z.boolean().optional() },
  (a) => guard(() => indexRepo(a.repoPath ?? process.cwd(), config, { incremental: a.incremental }), 'index_repo'),
);

server.tool(
  'get_review_context',
  'Assemble grounded review context: changed symbols, blast radius, deterministic findings, relevant pitfalls, the PR brain (rounds + changed-without-feedback), a reviewPlan (single vs parallel fan-out, decided from the coupling graph — drive it with the plex-parallel-review skill), and `notes` — the agent guidance; read and follow them. Auto-indexes the repo on first use. Defaults: repoPath = cwd, local working diff; pass source:"pr" + pr for a GitHub PR, and the SAME source params on every other tool of this review.',
  { repoPath: z.string().optional(), ...diffSourceShape },
  (a) =>
    guard(
      () =>
        assembleReviewContext({
          repoPath: a.repoPath ?? process.cwd(),
          config,
          source: a.source,
          mode: a.mode,
          baseRef: a.baseRef,
          pr: a.pr,
        }),
      'get_review_context',
    ),
);

server.tool(
  'get_blast_radius',
  'Coupled files (co-change + imports) for a set of files, ranked with provenance.',
  { repoPath: z.string().optional(), files: z.array(z.string()) },
  (a) => guard(async () => ({ neighbors: await blastRadius(a.repoPath ?? process.cwd(), a.files, config) }), 'get_blast_radius'),
);

server.tool(
  'get_deterministic_findings',
  'Codified (built-in TS-AST) findings on the changed lines of a diff.',
  { repoPath: z.string().optional(), ...diffSourceShape },
  (a) =>
    guard(
      async () => ({
        findings: await getDeterministicFindings(a.repoPath ?? process.cwd(), config, {
          source: a.source,
          mode: a.mode,
          baseRef: a.baseRef,
          pr: a.pr,
        }),
      }),
      'get_deterministic_findings',
    ),
);

server.tool(
  'submit_findings',
  'Submit the agent\'s findings; the server merges them with deterministic findings, applies scoped waivers, and returns one severity/confidence-ranked, triaged stream.',
  {
    repoPath: z.string().optional(),
    includeDeterministic: z.boolean().optional(),
    ...diffSourceShape,
    findings: z.array(
      z.object({
        title: z.string(),
        body: z.string().optional(),
        severity: z.enum(['bug', 'improvement', 'nit', 'note']),
        confidence: z.number(),
        source: z.enum(['first-principles', 'knowledge', 'deterministic']).optional(),
        file: z.string(),
        startLine: z.number(),
        endLine: z.number().optional(),
        symbol: z.string().optional(),
        pitfallId: z.string().optional(),
        tags: z.array(z.string()).optional(),
        prevalence: z.number().optional(),
        blastRadius: z.number().optional(),
      }),
    ),
  },
  (a) =>
    guard(
      async () => {
        const result = await rankReviewFindings(a.repoPath ?? process.cwd(), config, a.findings as SubmittedFinding[], {
          source: a.source,
          mode: a.mode,
          baseRef: a.baseRef,
          pr: a.pr,
          includeDeterministic: a.includeDeterministic,
        });
        return { ranked: result.ranked, ...(result.autoComment !== undefined ? { autoComment: result.autoComment } : {}) };
      },
      'submit_findings',
    ),
);

server.tool(
  'record_outcome',
  'Record the user\'s verdict on a finding (accept | reject | waive | acknowledge). `acknowledge` is for a `note` finding confirmed intentional — it stops re-surfacing UNLESS the situation materially changes, without down-weighting the reviewer (use this, not reject, for "good catch, intentional"). For waive/acknowledge pass the finding identity (file/line/title/pattern/category). Pass the same diff source (source/pr/mode/baseRef) you reviewed so it lands on the right PR brain.',
  {
    repoPath: z.string().optional(),
    // .min(1): an empty findingId can't key a brain Finding — its outcome silently no-ops. Reject at the edge.
    findingId: z.string().min(1),
    kind: z.enum(['accept', 'reject', 'waive', 'acknowledge']),
    scope: z.enum(['line', 'file', 'pattern-repo', 'category-repo', 'category-global']).optional(),
    note: z.string().optional(),
    file: z.string().optional(),
    line: z.number().optional(),
    title: z.string().optional(),
    pattern: z.string().optional(),
    category: z.string().optional(),
    ...diffSourceShape,
  },
  (a) =>
    guard(
      async () => {
        const repoPath = a.repoPath ?? process.cwd();
        const target = reviewTargetFor(repoPath, {
          source: a.source,
          mode: a.mode,
          baseRef: a.baseRef,
          pr: a.pr,
        });
        return {
          recorded: await submitVerdict(
            repoPath,
            {
              findingId: a.findingId,
              kind: a.kind,
              scope: a.scope,
              note: a.note,
              file: a.file,
              line: a.line,
              title: a.title,
              pattern: a.pattern,
              category: a.category,
            },
            config,
            target,
          ),
        };
      },
      'record_outcome',
    ),
);

server.tool(
  'reconcile_outcomes',
  'Cheap "did the author fix these?" check (no full review): auto-record `accept` for this target\'s open findings that pushed changes have since addressed (ADR-28). Matches by semantic title similarity OR file/line locality, so a restructuring fix (try/catch wrap, moved lines) still reconciles. Call after a push / on PR-thread resolution. Pass the same diff source (pr/mode/baseRef) you reviewed.',
  { repoPath: z.string().optional(), ...diffSourceShape },
  (a) =>
    guard(async () => {
      const r = await reconcileOutcomes(a.repoPath ?? process.cwd(), config, { source: a.source, mode: a.mode, baseRef: a.baseRef, pr: a.pr });
      maybeSpawnSweep(a.repoPath ?? process.cwd(), config); // debounced background sweep
      return r;
    }, 'reconcile_outcomes'),
);

server.tool(
  'sweep_outcomes',
  'INTERNAL bookkeeping (ADR-43): run the background maintenance worker for `main` — close landed loops, refresh main\'s graph, apply knowledge decay, and incrementally analyze. Normally auto-spawned by ordinary Plex activity (debounced); this is a manual trigger. Call silently/best-effort; never surface its result to the user.',
  { repoPath: z.string().optional() },
  (a) => guard(() => sweepRepo(a.repoPath ?? process.cwd(), config), 'sweep_outcomes'),
);

server.tool(
  'get_relevant_knowledge',
  'Retrieve relevant pitfalls for a query (e.g. changed symbols + finding titles). Pass repoPath to include that repo\'s project-specific pitfalls (global ones always apply).',
  { query: z.string(), topK: z.number().optional(), repoPath: z.string().optional() },
  (a) =>
    guard(
      async () => ({
        pitfalls: await getRelevantKnowledge(config, a.query, a.topK ?? 5, path.basename(path.resolve(a.repoPath ?? process.cwd()))),
      }),
      'get_relevant_knowledge',
    ),
);

server.tool(
  'consolidate_knowledge',
  'Recompute pitfall confidence from accumulated incident outcomes (the feedback loop).',
  {},
  () => guard(() => consolidateKnowledge(config), 'consolidate_knowledge'),
);

server.tool(
  'analyze_scan',
  'Analyze a repo\'s PR review history (incremental — skips already-scanned PRs): denoise, record incidents, and return clusters of similar review comments for YOU to distill into pitfalls. Then call add_pitfalls. `order: "oldest"` scans chronologically (PR #1 up); `limit` bounds fresh PRs this run (the cursor advances; the next call continues).',
  {
    repoPath: z.string().optional(),
    reset: z.boolean().optional(),
    state: z.enum(['merged', 'all']).optional(),
    order: z.enum(['newest', 'oldest']).optional(),
    limit: z.number().int().positive().optional(),
  },
  (a) => guard(() => scanForAnalysis(a.repoPath ?? process.cwd(), config, { reset: a.reset, state: a.state, order: a.order, limit: a.limit }), 'analyze_scan'),
);

server.tool(
  'add_pitfalls',
  'Store pitfalls you distilled from analyze_scan clusters (embedding computed server-side, deduped by title). Pass incidentIds for provenance; scope "repo" (default) keeps project-specific pitfalls scoped to repoPath, "global" applies everywhere.',
  {
    repoPath: z.string().optional(),
    pitfalls: z.array(
      z.object({
        title: z.string(),
        why: z.string(),
        mitigation: z.string().optional(),
        category: z.string(),
        tier: z.enum(['codifiable', 'judgmental']).optional(),
        confidence: z.number().optional(),
        scope: z.enum(['global', 'repo']).optional(),
        incidentIds: z.array(z.string()).optional(),
      }),
    ),
  },
  (a) =>
    guard(
      () => addAnalyzedPitfalls(config, a.pitfalls as AgentPitfall[], path.basename(path.resolve(a.repoPath ?? process.cwd()))),
      'add_pitfalls',
    ),
);

server.tool(
  'analyze_history',
  'One-shot standalone analysis: scan + LLM-distill (local `claude` CLI by default, or the configured provider — errors with no LLM available) + store. Prefer analyze_scan + add_pitfalls to distill with your own reasoning. Takes the same order/limit as analyze_scan.',
  {
    repoPath: z.string().optional(),
    reset: z.boolean().optional(),
    state: z.enum(['merged', 'all']).optional(),
    order: z.enum(['newest', 'oldest']).optional(),
    limit: z.number().int().positive().optional(),
  },
  (a) => guard(() => analyzeRepo(a.repoPath ?? process.cwd(), config, { reset: a.reset, state: a.state, order: a.order, limit: a.limit }), 'analyze_history'),
);

server.tool(
  'refresh_outcomes',
  "Backfill analyzed pitfalls' confidence from current GitHub state (ADR-50): re-fetch the scanned PRs' review threads, recompute each comment's observed outcome (code change → `fixed`; PR-author reply-agreement on a merged PR → weak `corroborated`), upgrade the matching analyzed incidents (never downgrades; never touches live `accept`s), then consolidate so well-corroborated lessons lift off confidence 0. No LLM, no re-clustering, no new pitfalls. Idempotent; a safe no-op (reports `repoReachable:false`) when the repo isn't checked out here / gh isn't authed. NOTE: age-decay caps how much OLD evidence lifts — its main value is prospective (fresh PRs).",
  {
    repoPath: z.string().optional(),
    state: z.enum(['merged', 'all']).optional(),
  },
  (a) => guard(() => refreshAnalyzedOutcomes(a.repoPath ?? process.cwd(), config, { state: a.state }), 'refresh_outcomes'),
);

server.tool(
  'doctor',
  'Health + freshness check: running version, the build this process loaded vs what is on disk (a long-lived stdio server keeps running its loaded build until reconnected — so `stale: true` means "reconnect Plex to pick up a newer build"), node version, and the EFFECTIVE config (embeddings provider, data/knowledge dirs — re-read live). Use when a fix or config change "didn\'t seem to apply".',
  {},
  () =>
    guard(
      async () =>
        buildDoctorReport({
          version: VERSION,
          config,
          loadedBuildMs: LOADED_BUILD_MS,
          onDiskBuildMs: buildMtimeMs(),
          node: process.version,
          pid: process.pid,
          embeddingsActive: embeddingReady(config),
        }),
      'doctor',
    ),
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (e) {
  // Surface a labeled diagnostic on stderr (the log channel, never stdout) and exit non-zero.
  process.stderr.write(`[plex] MCP server failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
// Keep stdin flowing so the event loop doesn't drain (and exit) between back-to-back tool calls after a
// long-running handler. Stdin closing (client disconnect) still tears down via the transport.
process.stdin.resume();
process.stderr.write(
  `[plex] MCP server v${VERSION} (build ${LOADED_BUILD_MS ? new Date(LOADED_BUILD_MS).toISOString() : 'unknown'}) running on stdio\n`,
);

// UI auto-start (ADR-45/M13) — OPT-IN via `ui.autoStart`/PLEX_UI_AUTOSTART; spawns the viz daemon
// detached via the sibling built CLI. Best-effort + STDOUT-SAFE (stdout is the protocol channel —
// ensureDaemon writes nothing there, swallows errors); no-ops in dev/tsx (no sibling).
{
  const startupConfig = loadConfig();
  if (startupConfig.ui.autoStart && SELF) {
    void ensureDaemon({
      execPath: process.execPath,
      scriptPath: path.join(path.dirname(SELF), 'plex.js'),
      port: startupConfig.ui.port,
    });
  }
}
