#!/usr/bin/env node
// Generate the plex Codex skills from the canonical Claude sources.
//
// Codex has no "agent" or "command" type — its only reusable unit is a skill (SKILL.md under
// .agents/skills). So the plex-reviewer AGENT becomes a `plex-review` skill. The
// Claude-Code-specific tool-loading guidance (deferred tools + ToolSearch) is rewritten to
// Codex-neutral wording, and /pr-master:<x> command references become "the pr-master-<x> skill".
// Edit the canonical source (agents/ or skills/), then re-run: `node scripts/gen-codex-skills.mjs`.
//
// These live in codex/skills/ (not the plugin's top-level skills/) so the Claude plugin keeps
// exposing the real agent + command, and only the Codex manifest reads this set.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'codex', 'skills');

const stripFrontmatter = (s) => {
  const m = s.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? s.slice(m[0].length).replace(/^\n+/, '') : s;
};

// Shared rewrites for any body going to Codex.
const adapt = (body) =>
  body
    // /pr-master:respond -> the `pr-master-respond` skill (consume optional surrounding backticks)
    .replace(/`?\/pr-master:([a-z-]+)`?/g, 'the `pr-master-$1` skill');

// Codex-neutral replacement for the agent's Claude-specific "Section 0" (deferred tools + ToolSearch).
const CODEX_SECTION_0 = `## 0. Use the Plex tools (don't fall back to a hand review)

The \`mcp__plex__*\` tools are your spine — they come from the **plex** MCP server this plugin
configures (its \`.mcp.json\` launches \`@sshanzel/plex\` via \`npx\`). Plex grounds your review with
facts; you provide the reasoning.

- Start by calling \`mcp__plex__get_review_context\`. If the Plex tools aren't visible, make sure
  the plex MCP server is enabled in your Codex config — **do not** conclude they're "unavailable"
  and review the diff by hand. A manual git review is slower and ungrounded: it throws away the
  blast radius, deterministic checks, accumulated pitfalls, and the round-aware signals that are
  the entire point. If a Plex call genuinely errors, report the exact error and stop; never
  silently substitute a manual review.

**Intense mode:** If the user passes the \`--intense\` flag (or asks in natural language for an
intense / thorough / critical review), follow the standard procedure through step 2 to collect the
grounding context, then enter the **Intense mode** section below instead of step 3. In Codex,
intense mode runs sequentially through each concern rather than fanning out sub-agents.
`;

// Codex-neutral replacement for the "## 6. Intense mode" section — no Agent tool in Codex,
// so it becomes a sequential structured sweep through each concern in order.
const CODEX_INTENSE_SECTION = `## 6. Intense mode (Codex: sequential concern sweep)

Enter this section when the user passes the \`--intense\` flag (or asks in natural language for an
intense / thorough / critical review). You have already called \`get_review_context\` in step 2 — do NOT call it again.

Since Codex does not support parallel sub-agents, run each concern sweep **in order**,
collecting findings as you go. Use the \`Read\` tool to inspect actual file contents at every
step. Apply the full Plex context (blast radius, changed symbols, knowledge pitfalls,
\`unexplainedChanges\`, \`deterministic\`) through the lens of each concern.

Check \`reviewPlan.surface\`. If surface < 30, skip the dedicated Test Coverage sweep and fold
it into the Correctness sweep.

### Sweep 1 — Security

Hunt for: injection (SQL, command, path traversal, template), auth/authz gaps, hardcoded
secrets, trust boundary violations (untrusted data flowing to privileged operations), unsafe
deserialization, CORS/CSP relaxations. Use blast radius to trace where changed data flows into
security-relevant coupled files.

### Sweep 2 — Correctness

Hunt for: null/undefined mishandling (missing guards, hidden non-null assertions), missing
\`await\`, unhandled promise rejections, races between concurrent mutations, empty \`catch\`
blocks swallowing errors, unsafe \`as\` casts, off-by-ones, inverted conditions, edge cases
(empty collections, boundary values, zero/negative). Use blast radius to check whether changed
exports/signatures break coupled-file consumers.

### Sweep 3 — Test Coverage

Hunt for: new code paths with no test update, missing edge-case tests (null, empty, error and
async failure paths), changed behavior with stale tests that still pass, tests made vacuous by
the change, async paths covered only by synchronous tests. Use blast radius to find test files.

### Sweep 4 — Line-by-Line

Read every changed hunk carefully in ±20-line context AND blast-radius coupling points. Flag
anything the previous sweeps may have missed at a micro level: subtly wrong variable name,
condition almost right but inverted in one edge case, comment contradicting the code, changed
default that silently breaks callers. Cross-reference \`unexplainedChanges\` against the hunk.

---

After all four sweeps, **deduplicate** (same file + overlapping line range ±5 + similar title →
keep higher-confidence version), waive false-positive deterministic findings, then call
\`mcp__plex__submit_findings\` ONCE with the merged array. Display using the standard ranked
table. Add a one-line note that this was an intense review and list the four concerns covered.
`;

// Codex-neutral replacement for the plex-analyzer's Claude-specific "Section 0" (deferred tools + ToolSearch).
const CODEX_ANALYZE_SECTION_0 = `## 0. Use the Plex tools (don't hand-distill)

The \`mcp__plex__*\` tools are your spine — they come from the **plex** MCP server this plugin
configures (its \`.mcp.json\` launches \`@sshanzel/plex\` via \`npx\`). Plex does the mechanical half
(fetch via \`gh\`, denoise, embed, cluster); you provide the judgment.

- Start by calling \`mcp__plex__analyze_scan\`. If the Plex tools aren't visible, make sure the plex
  MCP server is enabled in your Codex config — **do not** read PRs by hand with \`gh\`/\`git\` and
  distill them yourself; that throws away Plex's clustering, provenance, incremental cursor, and
  semantic dedup. If a Plex call genuinely errors, report the exact error and stop.

**Requirements** (surface these if a call fails for one of these reasons, then stop):
- **\`gh\` must be authenticated** — \`analyze_scan\` pulls review comments through the GitHub CLI.
- **An embedding key is strongly recommended** — clustering and \`add_pitfalls\` embed server-side;
  without a provider \`analyze_scan\` errors (clustering needs vectors). Point the user to \`npx @sshanzel/plex init\`.
`;

const banner = (src) =>
  `<!-- GENERATED from ${src} by scripts/gen-codex-skills.mjs — do not edit here; edit the source and re-run. -->\n\n`;

rmSync(OUT, { recursive: true, force: true });
const written = [];

// plex-reviewer AGENT  ->  plex-review SKILL
{
  const name = 'plex-review';
  const description =
    'Run a fresh-context, unbiased Plex code review of the current changes — grounded in the blast-radius code graph, deterministic checks, and accumulated review knowledge via the plex MCP. Use when the user asks to review a diff/branch/PR with Plex, or when a unit of work is complete and ready for review (a finished feature/branch, opening a PR, before a push). On-demand, not after every edit — a full review takes minutes. Pass the `--intense` flag (or ask for an intense/thorough review) to run a sequential concern sweep (Security → Correctness → Test Coverage → Line-by-Line) for high-stakes or large changes.';
  let body = stripFrontmatter(readFileSync(join(ROOT, 'agents', 'plex-reviewer.md'), 'utf8'));
  // Replace the whole Claude-specific "## 0. Load the Plex tools FIRST …" section up to the next header.
  body = body.replace(/## 0\. Load the Plex tools FIRST[\s\S]*?(?=\n## )/, CODEX_SECTION_0);
  // Replace the "## 6. Intense mode" section (sub-agent version) with the sequential Codex version.
  body = body.replace(/## 6\. Intense mode[\s\S]*?(?=\n## |$)/, CODEX_INTENSE_SECTION);
  body = adapt(body);
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${banner('agents/plex-reviewer.md')}${body.trimEnd()}\n`,
  );
  written.push(name);
}

// plex-analyzer AGENT  ->  plex-analyze SKILL
{
  const name = 'plex-analyze';
  const description =
    "Seed Plex's knowledge base from this repo's PR review history — pull merged-PR review comments via `gh`, cluster recurring themes, and distill each into a reusable pitfall stored in Plex via the plex MCP. Use when the user asks to analyze/seed/bootstrap Plex from past reviews, or after installing Plex to give it a head start. Incremental — re-run to keep working through history. Needs `gh` authenticated and an embedding key.";
  let body = stripFrontmatter(readFileSync(join(ROOT, 'agents', 'plex-analyzer.md'), 'utf8'));
  // Replace the whole Claude-specific "## 0. Load the Plex tools FIRST …" section up to the next header.
  body = body.replace(/## 0\. Load the Plex tools FIRST[\s\S]*?(?=\n## )/, CODEX_ANALYZE_SECTION_0);
  body = adapt(body);
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${banner('agents/plex-analyzer.md')}${body.trimEnd()}\n`,
  );
  written.push(name);
}

console.log(`Generated ${written.length} Codex skill(s) in codex/skills/:`);
for (const n of written) console.log(`  - ${n}`);
