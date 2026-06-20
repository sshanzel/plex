import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { safeEmbed, type EmbeddingProvider } from '@plex/core';

/**
 * A content-addressed embedding cache (per-repo JSON sidecar) for STABLE, recurring texts (prior-finding
 * titles) so an N-round PR embeds each title once, not once per round. Per-round CONTENT must NOT be
 * routed here (it differs each round — caching only bloats the file). Also serves as local proof
 * embeddings fired: a config-only provider with no key never writes here.
 */

type Cache = Record<string, number[]>;

/** Cap the cache so a long-lived repo can't grow it unbounded; past the cap keep only the working set. */
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
 * Embed `texts`, reusing cached vectors and embedding only misses, merging new vectors back into `file`.
 * Returns vectors aligned to `texts`; `null` only when there ARE misses and the embed call fails (caller
 * then degrades exactly as for `safeEmbed` null). With zero misses it never calls the provider.
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
