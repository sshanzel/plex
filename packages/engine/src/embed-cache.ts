import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { safeEmbed, type EmbeddingProvider } from '@plex/core';

/**
 * A content-addressed embedding cache (per-repo JSON sidecar) for STABLE, recurring texts —
 * principally prior-finding titles, which the brain's change-attribution batch re-embeds every
 * round (the same titles, over and over). Caching them turns an N-round PR's title embeds from
 * O(findings × rounds) into O(distinct findings): the dominant repeat-cost on an active PR.
 *
 * Per-round CONTENT (changed-region text) is intentionally NOT routed through here — it differs
 * each round, so caching it only bloats the file. Use this only for texts that recur.
 *
 * The file also serves as **local proof embeddings actually fired**: if it exists with entries,
 * the provider resolved and was called (a config-only "voyage" with no key never writes here).
 */

type Cache = Record<string, number[]>;

/** Cap the cache so a long-lived repo can't grow it without bound. Finding titles are short and
 * few (hundreds), but be defensive: past the cap we keep only the current working set, which the
 * next call re-populates cheaply. */
const MAX_ENTRIES = 4000;

function keyFor(provider: EmbeddingProvider, text: string): string {
  // Provider name + dimensions guard against mixing vectors from different models/dims in one file.
  return createHash('sha1').update(`${provider.name}:${provider.dimensions}:${text}`).digest('hex');
}

export function loadEmbedCache(file: string): Cache {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Cache) : {};
  } catch {
    return {}; // missing/corrupt → empty (best-effort, never throws into a review)
  }
}

/**
 * Embed `texts`, reusing cached vectors for ones seen before and embedding only the misses, then
 * merging the new vectors back into `file`. Returns vectors aligned to `texts` (a never-resolvable
 * miss yields `[]` at that index). Returns `null` only when there ARE misses and the embed call
 * fails (transient/no-key) — the caller then degrades exactly as it would for `safeEmbed` null
 * (locality-only). With zero misses it never calls the provider (the whole point) and returns the
 * cached vectors.
 */
export async function cachedEmbed(
  provider: EmbeddingProvider,
  file: string,
  texts: string[],
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const cache = loadEmbedCache(file);
  const missTexts: string[] = [];
  for (const t of texts) {
    if (!(keyFor(provider, t) in cache)) missTexts.push(t);
  }

  if (missTexts.length > 0) {
    const vecs = await safeEmbed(provider, missTexts);
    if (!vecs) return null; // transient failure → caller falls back to its no-embeddings path
    missTexts.forEach((t, i) => {
      cache[keyFor(provider, t)] = vecs[i]!;
    });
    let toWrite = cache;
    if (Object.keys(cache).length > MAX_ENTRIES) {
      // Over budget — retain only the current working set so the file stays bounded.
      toWrite = {};
      for (const t of texts) toWrite[keyFor(provider, t)] = cache[keyFor(provider, t)]!;
    }
    try {
      writeFileSync(file, JSON.stringify(toWrite));
    } catch {
      /* best-effort: a write failure just means next round re-embeds the misses */
    }
  }

  return texts.map((t) => cache[keyFor(provider, t)] ?? []);
}
