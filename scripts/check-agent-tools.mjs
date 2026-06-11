#!/usr/bin/env node
// Static check: verify that every mcp__plex__* tool referenced in plugin agent/skill files
// actually exists in the MCP server, and that every tool used in a prompt body is also listed
// in the agent's tools: frontmatter (otherwise the runtime would block it).
//
// Run: node scripts/check-agent-tools.mjs
// No build required — reads source files directly.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 1. Extract registered tool names from the MCP server source ───────────────
const serverSrc = readFileSync(join(ROOT, 'packages/mcp-server/src/index.ts'), 'utf8');
const registeredTools = new Set(
  [...serverSrc.matchAll(/server\.tool\(\s*\n?\s*'([^']+)'/g)].map((m) => m[1]),
);

if (registeredTools.size === 0) {
  console.error('check-agent-tools: could not parse any tool registrations from MCP server — check the regex');
  process.exit(1);
}

// ── 2. Collect all markdown files under plugin/ to check ─────────────────────
const pluginDir = join(ROOT, 'plugin');
const mdFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.md')) mdFiles.push(full);
  }
};
walk(pluginDir);

// ── 3. Parse a markdown file's tools: frontmatter line ───────────────────────
const parseFrontmatterTools = (src) => {
  const m = src.match(/^---\n[\s\S]*?^tools:\s*(.+)$/m);
  if (!m) return null; // no tools: line — not an agent file
  return m[1].split(',').map((t) => t.trim());
};

const stripMcpPrefix = (name) => {
  if (name.startsWith('mcp__plugin_plex_plex__')) return name.slice('mcp__plugin_plex_plex__'.length);
  if (name.startsWith('mcp__plex__')) return name.slice('mcp__plex__'.length);
  return null; // not a plex MCP tool
};

// ── 4. Scan a file's body for mcp__plex__* references ────────────────────────
const bodyToolRefs = (body) =>
  new Set([...body.matchAll(/mcp__(?:plugin_plex_plex|plex)__([a-z_]+)/g)].map((m) => m[1]));

// ── 5. Run checks ─────────────────────────────────────────────────────────────
const errors = [];
const warnings = [];

for (const file of mdFiles) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');

  // Strip frontmatter for body analysis
  const frontmatterEnd = src.match(/^---\n[\s\S]*?\n---\n/);
  const body = frontmatterEnd ? src.slice(frontmatterEnd[0].length) : src;

  const frontmatterTools = parseFrontmatterTools(src);
  const bodyRefs = bodyToolRefs(body);

  // a) All mcp__plex__* refs in the body must exist in the MCP server
  for (const tool of bodyRefs) {
    if (!registeredTools.has(tool)) {
      errors.push(`${rel}: body references 'mcp__plex__${tool}' — not registered in MCP server`);
    }
  }

  // b) For agent files (have tools: frontmatter): cross-check frontmatter vs body
  if (frontmatterTools) {
    const frontmatterMcp = new Set(
      frontmatterTools.map(stripMcpPrefix).filter(Boolean),
    );

    // All mcp__plex__* in frontmatter must exist in the MCP server
    for (const tool of frontmatterMcp) {
      if (!registeredTools.has(tool)) {
        errors.push(`${rel}: tools: frontmatter lists 'mcp__plex__${tool}' — not registered in MCP server`);
      }
    }

    // Every mcp__plex__* used in the body should be in the frontmatter
    // (body includes sub-agent prompt templates — those won't be blocked, but it's good hygiene)
    for (const tool of bodyRefs) {
      if (registeredTools.has(tool) && !frontmatterMcp.has(tool)) {
        warnings.push(`${rel}: body uses 'mcp__plex__${tool}' but it's not in the tools: frontmatter`);
      }
    }
  }
}

// ── 6. Report ──────────────────────────────────────────────────────────────────
if (warnings.length > 0) {
  console.warn('check-agent-tools: WARNINGS');
  for (const w of warnings) console.warn('  ⚠', w);
}

if (errors.length > 0) {
  console.error('check-agent-tools: FAILED');
  for (const e of errors) console.error('  ✗', e);
  process.exit(1);
}

const toolList = [...registeredTools].sort().join(', ');
console.log(
  `check-agent-tools: OK — ${registeredTools.size} registered tools (${toolList}), checked ${mdFiles.length} plugin markdown files`,
);
