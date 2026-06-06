import type { Pitfall, PitfallTier, CompletionProvider } from '@plex/core';
import type { RawComment } from './types';

export interface ClusterInput {
  comments: RawComment[];
  centroid: number[];
  /** Origin repo — stamped on the resulting pitfall for scope filtering. */
  repo?: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SYSTEM =
  'You distill code-review comments into review knowledge. You decide what is worth remembering: SKIP only if a cluster is trivial or not a real, reusable lesson. Project-specific lessons are NOT skipped — keep them and mark scope "repo" (they help whenever working on that project); mark broadly-applicable lessons scope "global". Output ONLY JSON.';

/**
 * Distill a cluster of similar review comments into ONE pitfall using the LLM's judgment
 * (ADR-20). The model itself decides whether the cluster is worth storing — returns
 * `null` to SKIP. Throws if the LLM call itself fails (so a broken provider surfaces
 * loudly rather than silently dropping everything). Confidence/provenance/embedding are
 * computed mechanically; the LLM supplies the semantic content + the keep/skip decision.
 */
export async function llmDistill(input: ClusterInput, llm: CompletionProvider): Promise<Pitfall | null> {
  const comments = input.comments;
  const prompt =
    `These ${comments.length} review comments were flagged on similar code. Decide whether they represent a ` +
    `pitfall a future reviewer should remember. SKIP (respond exactly {"skip": true}) ONLY if trivial or not a ` +
    `real, reusable lesson. A lesson specific to THIS project is still worth keeping — mark its scope "repo".\n\n` +
    comments.map((c, i) => `${i + 1}. [${c.path ?? '?'}] ${c.body}`).join('\n') +
    `\n\nReturn JSON: {"skip": false, "title": short imperative, "why": "1-2 sentences", ` +
    `"mitigation": "how to avoid", "category": "security|performance|error-handling|concurrency|testing|types|api-design|style|general", ` +
    `"tier": "codifiable if a linter could catch it, else judgmental", ` +
    `"scope": "global if broadly applicable, repo if specific to this codebase"}`;

  // Let LLM/transport errors propagate — a broken distiller must not silently skip everything.
  const raw = await llm.complete(prompt, { system: SYSTEM, maxTokens: 512 });
  const json = extractJson(raw);
  if (!json || json.skip === true || typeof json.title !== 'string' || !json.title) return null;

  const accepted = comments.filter((c) => c.prMerged).length;
  const confidence = Math.min(0.9, 0.3 + 0.1 * comments.length + 0.1 * (accepted / Math.max(1, comments.length)));
  const tier: PitfallTier = json.tier === 'codifiable' ? 'codifiable' : 'judgmental';
  const scope: 'global' | 'repo' = json.scope === 'global' ? 'global' : 'repo';
  const title = json.title;
  return {
    id: `pf:mined:${input.repo ? slug(input.repo) + ':' : ''}${slug(title)}`,
    title,
    trigger: title,
    why: typeof json.why === 'string' ? json.why : title,
    mitigation: typeof json.mitigation === 'string' ? json.mitigation : undefined,
    category: typeof json.category === 'string' ? json.category : 'general',
    tier,
    confidence,
    scope,
    repo: input.repo,
    incidentIds: comments.map((c) => `inc:mined:${c.id}`),
    embedding: input.centroid,
  };
}
