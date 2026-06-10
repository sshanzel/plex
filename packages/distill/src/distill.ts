import { slugify, hashId, type Pitfall, type PitfallTier, type CompletionProvider } from '@plex/core';
import type { RawComment } from './types';

export interface ClusterInput {
  comments: RawComment[];
  centroid: number[];
  /** Origin repo — stamped on the resulting pitfall for scope filtering. */
  repo?: string;
}

/** Collision-free pitfall id: optional repo + readable title slug + title hash. */
export function distilledPitfallId(title: string, repo?: string): string {
  return `pf:analyzed:${repo ? slugify(repo) + ':' : ''}${slugify(title, 56) || 'p'}-${hashId(title)}`;
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
  const render = (c: (typeof comments)[number], i: number): string => {
    const head = `${i + 1}. [${c.path ?? '?'}] ${c.body}`;
    if (!c.replies?.length) return head;
    return head + '\n' + c.replies.map((r) => `   ↳ ${r.author ?? 'reply'}: ${r.body}`).join('\n');
  };
  const prompt =
    `These ${comments.length} review comments (with their thread discussion) were flagged on similar code. ` +
    `Decide whether they represent a pitfall a future reviewer should remember. SKIP (respond exactly ` +
    `{"skip": true}) if trivial, not a reusable lesson, OR if the discussion shows the suggestion was ` +
    `dismissed, disagreed with, or deemed intentional/not-needed — that means it was NOT accepted, so do not ` +
    `store it. A lesson specific to THIS project IS worth keeping — mark its scope "repo".\n\n` +
    comments.map(render).join('\n') +
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
    id: distilledPitfallId(title, input.repo),
    title,
    trigger: title,
    why: typeof json.why === 'string' ? json.why : title,
    mitigation: typeof json.mitigation === 'string' ? json.mitigation : undefined,
    category: typeof json.category === 'string' ? json.category : 'general',
    tier,
    confidence,
    scope,
    repo: input.repo,
    incidentIds: comments.map((c) => `inc:analyzed:${c.id}`),
    embedding: input.centroid,
  };
}
