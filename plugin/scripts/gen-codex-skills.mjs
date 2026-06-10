#!/usr/bin/env node
// Generate the plex Codex skills from the canonical Claude sources.
//
// Codex has no "agent" or "command" type — its only reusable unit is a skill (SKILL.md under
// .agents/skills). So the plex-reviewer AGENT becomes a `plex-review` skill, and the
// plex-parallel-review skill is carried across. The Claude-Code-specific tool-loading guidance
// (deferred tools + ToolSearch) is rewritten to Codex-neutral wording, and /pr-master:<x>
// command references become "the pr-master-<x> skill". Edit the canonical source (agents/ or
// skills/), then re-run: `node scripts/gen-codex-skills.mjs`.
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
    .replace(/`?\/pr-master:([a-z-]+)`?/g, 'the `pr-master-$1` skill')
    // The Claude-side reviewer AGENT is `plex-reviewer`; on Codex it ships as the `plex-review`
    // SKILL (generated above). Without this, the parallel orchestrator points workers at a
    // name that doesn't exist in their world.
    .replace(/`plex-reviewer`/g, '`plex-review`');

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
`;

const banner = (src) =>
  `<!-- GENERATED from ${src} by scripts/gen-codex-skills.mjs — do not edit here; edit the source and re-run. -->\n\n`;

rmSync(OUT, { recursive: true, force: true });
const written = [];

// 1. plex-reviewer AGENT  ->  plex-review SKILL
{
  const name = 'plex-review';
  const description =
    'Run a fresh-context, unbiased Plex code review of the current changes — grounded in the blast-radius code graph, deterministic checks, and accumulated review knowledge via the plex MCP. Use when the user asks to review a diff/branch/PR with Plex, or when a unit of work is complete and ready for review (a finished feature/branch, opening a PR, before a push). On-demand, not after every edit — a full review takes minutes.';
  let body = stripFrontmatter(readFileSync(join(ROOT, 'agents', 'plex-reviewer.md'), 'utf8'));
  // Replace the whole Claude-specific "## 0. Load the Plex tools FIRST …" section up to the next header.
  body = body.replace(/## 0\. Load the Plex tools FIRST[\s\S]*?(?=\n## )/, CODEX_SECTION_0);
  body = adapt(body);
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\n${banner('agents/plex-reviewer.md')}${body.trimEnd()}\n`,
  );
  written.push(name);
}

// 2. plex-parallel-review SKILL  ->  carried across (keep its frontmatter, adapt the body)
{
  const src = readFileSync(join(ROOT, 'skills', 'plex-parallel-review', 'SKILL.md'), 'utf8');
  const fm = src.match(/^---\n[\s\S]*?\n---\n/)[0];
  let body = adapt(stripFrontmatter(src))
    // step 1's deferred-tools / ToolSearch sentence -> Codex-neutral
    .replace(
      /1\. \*\*Load the Plex tools\.\*\*[^\n]*\n[^\n]*/,
      '1. **Use the Plex tools.** Call `mcp__plex__get_review_context` to start (from the plex MCP\n   server this plugin configures via `.mcp.json`). If the Plex tools aren\'t visible, ensure the\n   plex MCP server is enabled in your Codex config — never fall back to a hand review.',
    );
  const dir = join(OUT, 'plex-parallel-review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `${fm}\n${banner('skills/plex-parallel-review/SKILL.md')}${body.trimEnd()}\n`);
  written.push('plex-parallel-review');
}

console.log(`Generated ${written.length} Codex skills in codex/skills/:`);
for (const n of written) console.log(`  - ${n}`);
