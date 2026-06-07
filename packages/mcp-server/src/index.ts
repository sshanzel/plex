/**
 * reviewer MCP server (stdio).
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
  reviewTarget,
  reconcileOutcomes,
  scanForMining,
  addMinedPitfalls,
  mineRepo,
  type SubmittedFinding,
  type AgentPitfall,
} from '@plex/engine';

const config = loadConfig();
const server = new McpServer({ name: 'plex', version: '0.2.0' });

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (m: string) => ({ content: [{ type: 'text' as const, text: m }], isError: true });
const guard = async (fn: () => Promise<unknown>, label: string) => {
  try {
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
  'Assemble grounded review context: changed symbols, blast radius, deterministic findings, the PR brain (rounds + changed-without-feedback), plex.md, and guidance. Auto-indexes the repo on first use.',
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
        severity: z.enum(['bug', 'improvement', 'nit']),
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
  'Record the user\'s verdict on a finding (accept | reject | waive). For waivers, pass the finding identity (file/line/title/pattern/category) so it suppresses matching findings next run. Pass the same diff source (source/pr/mode/baseRef) you reviewed so the verdict lands on the right PR brain.',
  {
    repoPath: z.string().optional(),
    findingId: z.string(),
    kind: z.enum(['accept', 'reject', 'waive']),
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
        const target = reviewTarget(path.basename(path.resolve(repoPath)), {
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
  'Cheap "did the author fix these?" check (no full review): auto-record `accept` for this target\'s open findings that pushed changes have since addressed (ADR-28). Call after a push / on PR-thread resolution. Pass the same diff source (pr/mode/baseRef) you reviewed.',
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
  'Scan a repo\'s PR review history (incremental — skips already-scanned PRs): denoise, record incidents, and return clusters of similar comments for YOU to distill into pitfalls. Then call add_pitfalls.',
  { repoPath: z.string().optional(), reset: z.boolean().optional(), state: z.enum(['merged', 'all']).optional() },
  (a) => guard(() => scanForMining(a.repoPath ?? process.cwd(), config, { reset: a.reset, state: a.state }), 'mine_scan'),
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
  'One-shot standalone mining: scan + distill (heuristic, or the configured LLM if a key is set) + store. Prefer mine_scan + add_pitfalls to distill with your own reasoning.',
  { repoPath: z.string().optional(), reset: z.boolean().optional(), state: z.enum(['merged', 'all']).optional() },
  (a) => guard(() => mineRepo(a.repoPath ?? process.cwd(), config, { reset: a.reset, state: a.state }), 'mine_history'),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[plex] MCP server running on stdio\n');
