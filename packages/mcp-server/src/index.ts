#!/usr/bin/env node
/**
 * reviewer MCP server (stdio). The shebang (first line) is preserved by esbuild/tsup into
 * dist/plex-mcp.js so the published `plex-mcp` bin is directly spawnable by an MCP client.
 *
 * The integration seam (ADR-02): any coding agent connects here and calls tools to
 * *get* review context and *record* findings/verdicts. The agent brings the LLM; this
 * server stays model-agnostic and runs in a fresh process, separate from whoever
 * authored the code — which removes self-review bias.
 *
 * Implemented: index_repo, get_review_context (blast radius + deterministic findings +
 * plex.md), get_blast_radius, get_deterministic_findings, submit_findings (merged &
 * ranked stream), record_outcome (scoped verdicts). get_relevant_knowledge lands in M3.
 */
import path from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  loadConfig,
  indexRepo,
  assembleReviewContext,
  blastRadius,
  getDeterministicFindings,
  rankReviewFindings,
  getRelevantKnowledge,
  seedKnowledge,
  consolidateKnowledge,
  getPromotions,
  submitVerdict,
  reviewTargetFor,
  reconcileOutcomes,
  scanForMining,
  addMinedPitfalls,
  mineRepo,
  type SubmittedFinding,
  type AgentPitfall,
} from '@plex/engine';
import { buildDoctorReport } from './doctor';

// Single-sourced from the package.json that ships beside the bundle (dist/ → ../package.json),
// so `doctor` and the MCP handshake never report a stale hand-bumped number.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// This running file's mtime = the build this process LOADED. Comparing it to the file's mtime
// *now* tells `doctor` whether a newer build is sitting on disk unused (a long-lived stdio
// process keeps running its loaded code until the client reconnects/respawns it).
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

// Config is RE-READ per tool call (see `guard`), so edits to ~/.plex/config.json — an embedding
// key, autoComment, thresholds — take effect WITHOUT restarting the server. `let`, not `const`,
// because `guard` reassigns it and every handler's thunk reads it at call time.
let config = loadConfig();
const server = new McpServer(
  { name: 'plex', version: VERSION },
  {
    // Surfaced to the client so tool-search can discover Plex even when MCP tools are
    // deferred behind search in a crowded multi-server session (keywords: review, PR,
    // blast radius, findings). With `.mcp.json` "alwaysLoad": true these load eagerly.
    instructions:
      'Plex — code-review orchestration for a diff or GitHub PR. Flow: index_repo (once) → ' +
      'get_review_context (blast radius + deterministic checks + relevant pitfalls + the PR brain + plex.md) → ' +
      'reason → submit_findings (one ranked, triaged stream; optionally posts the review to the PR) → ' +
      'record_outcome (accept | reject | waive | acknowledge). reconcile_outcomes checks whether pushed commits ' +
      'addressed findings. Knowledge mining: mine_scan / add_pitfalls / mine_history / seed_knowledge / ' +
      'consolidate_knowledge / propose_promotions. `doctor` reports version + whether a newer build is on ' +
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
    config = loadConfig(); // refresh per call so config edits apply without a server restart
    return json(await fn());
  } catch (e) {
    return fail(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const diffSourceShape = {
  source: z.enum(['local', 'pr']).optional(),
  mode: z.enum(['working', 'staged', 'branch']).optional(),
  baseRef: z.string().optional(),
  pr: z.union([z.string(), z.number()]).optional(),
};

server.tool(
  'index_repo',
  'Build the code graph for a repo (TS symbols/imports + git co-change). Full rebuild by default; pass incremental:true to refresh only files changed since the last index (falls back to full when needed).',
  { repoPath: z.string().optional(), incremental: z.boolean().optional() },
  (a) => guard(() => indexRepo(a.repoPath ?? process.cwd(), config, { incremental: a.incremental }), 'index_repo'),
);

server.tool(
  'get_review_context',
  'Assemble grounded review context: changed symbols, blast radius, deterministic findings, the PR brain (rounds + changed-without-feedback), plex.md, a reviewPlan (single vs parallel fan-out, decided from the coupling graph — drive it with the plex-parallel-review skill), and guidance. Auto-indexes the repo on first use.',
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
  'Codified (Semgrep/ast-grep-style) findings on the changed lines of a diff.',
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
        severity: z.enum(['bug', 'improvement', 'nit', 'awareness']),
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
      async () => ({
        ranked: await rankReviewFindings(a.repoPath ?? process.cwd(), config, a.findings as SubmittedFinding[], {
          source: a.source,
          mode: a.mode,
          baseRef: a.baseRef,
          pr: a.pr,
          includeDeterministic: a.includeDeterministic,
        }),
      }),
      'submit_findings',
    ),
);

server.tool(
  'record_outcome',
  'Record the user\'s verdict on a finding (accept | reject | waive | acknowledge). `acknowledge` is for an `awareness` flag confirmed intentional — it stops re-surfacing UNLESS the situation materially changes, without down-weighting the reviewer (use this, not reject, for "good catch, intentional"). For waive/acknowledge pass the finding identity (file/line/title/pattern/category). Pass the same diff source (source/pr/mode/baseRef) you reviewed so it lands on the right PR brain.',
  {
    repoPath: z.string().optional(),
    findingId: z.string(),
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
    guard(
      () => reconcileOutcomes(a.repoPath ?? process.cwd(), config, { source: a.source, mode: a.mode, baseRef: a.baseRef, pr: a.pr }),
      'reconcile_outcomes',
    ),
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
  'seed_knowledge',
  'Seed the knowledge base from markdown guidance (## headings = categories, bullets = pitfalls). Cold start.',
  { markdown: z.string() },
  (a) => guard(async () => ({ added: await seedKnowledge(config, a.markdown) }), 'seed_knowledge'),
);

server.tool(
  'consolidate_knowledge',
  'Recompute pitfall confidence from accumulated incident outcomes (the feedback loop).',
  {},
  () => guard(() => consolidateKnowledge(config), 'consolidate_knowledge'),
);

server.tool(
  'propose_promotions',
  'Propose graph→markdown (plex.md) and graph→rule (ast-grep) promotions for high-confidence / codifiable pitfalls.',
  { existingMarkdown: z.string().optional() },
  (a) => guard(() => getPromotions(config, a.existingMarkdown ?? ''), 'propose_promotions'),
);

// --- Mining: agent-driven (rides your subscription). mine_scan → you distill → add_pitfalls.
server.tool(
  'mine_scan',
  'Scan a repo\'s PR review history (incremental — skips already-scanned PRs): denoise, record incidents, and return clusters of similar comments for YOU to distill into pitfalls. Then call add_pitfalls. `order: "oldest"` scans chronologically (PR #1 up); `limit` bounds fresh PRs this run (the cursor advances; the next call continues).',
  {
    repoPath: z.string().optional(),
    reset: z.boolean().optional(),
    state: z.enum(['merged', 'all']).optional(),
    order: z.enum(['newest', 'oldest']).optional(),
    limit: z.number().int().positive().optional(),
  },
  (a) => guard(() => scanForMining(a.repoPath ?? process.cwd(), config, { reset: a.reset, state: a.state, order: a.order, limit: a.limit }), 'mine_scan'),
);

server.tool(
  'add_pitfalls',
  'Store pitfalls you distilled from mine_scan clusters (embedding computed server-side, deduped by title). Pass incidentIds for provenance; scope "repo" (default) keeps project-specific pitfalls scoped to repoPath, "global" applies everywhere.',
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
      () => addMinedPitfalls(config, a.pitfalls as AgentPitfall[], path.basename(path.resolve(a.repoPath ?? process.cwd()))),
      'add_pitfalls',
    ),
);

server.tool(
  'mine_history',
  'One-shot standalone mining: scan + LLM-distill (local `claude` CLI by default, or the configured provider — errors with no LLM available) + store. Prefer mine_scan + add_pitfalls to distill with your own reasoning. Takes the same order/limit as mine_scan.',
  {
    repoPath: z.string().optional(),
    reset: z.boolean().optional(),
    state: z.enum(['merged', 'all']).optional(),
    order: z.enum(['newest', 'oldest']).optional(),
    limit: z.number().int().positive().optional(),
  },
  (a) => guard(() => mineRepo(a.repoPath ?? process.cwd(), config, { reset: a.reset, state: a.state, order: a.order, limit: a.limit }), 'mine_history'),
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
        }),
      'doctor',
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `[plex] MCP server v${VERSION} (build ${LOADED_BUILD_MS ? new Date(LOADED_BUILD_MS).toISOString() : 'unknown'}) running on stdio\n`,
);
