/**
 * Pluggable provider interfaces (ADR-13).
 *
 * Embeddings are intentionally abstracted to a single `text -> vector` function so
 * the implementation (Voyage `voyage-code-3`, OpenAI `text-embedding-3-small`, local
 * Ollama, or a deterministic fake for tests) can be swapped without touching callers.
 *
 * NOTE: generative LLMs (Opus/GPT/Gemini-chat) are NOT embedding models — an embedding
 * provider must wrap an actual embedding endpoint.
 */
import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  readonly name: string;
  /** Vector dimensionality this provider returns. */
  readonly dimensions: number;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Generative completion, used ONLY by the offline analysis/distillation pipeline (ADR-02 —
 * the interactive review uses the connected agent, never this). Implementations: a
 * deterministic heuristic (no network), Anthropic, OpenAI.
 */
export interface CompletionProvider {
  readonly name: string;
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}

/** URL/id-safe slug: lowercase, non-alphanumerics → '-', trimmed, capped. */
export function slugify(s: string, maxLen = 48): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

/**
 * Short, stable content hash for disambiguating ids whose slugs would collide or be
 * empty (e.g. two titles sharing a 48-char prefix, or a non-ASCII/emoji-only title that
 * slugs to ''). Distinct input → distinct suffix; same input → same suffix (idempotent).
 */
export function hashId(s: string, len = 8): string {
  return createHash('sha1').update(s).digest('hex').slice(0, len);
}

// Machine-written files that carry zero review signal and plenty of noise/cost: lockfiles
// co-change with everything (distorting the 1/(n−1) commit-size weighting), minified
// bundles and source maps explode token/embedding budgets, snapshots are test output.
const GENERATED_BASENAMES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'bun.lockb', 'bun.lock', 'deno.lock', 'cargo.lock', 'composer.lock',
  'gemfile.lock', 'poetry.lock', 'uv.lock', 'pipfile.lock', 'go.sum',
  'flake.lock', 'packages.lock.json', 'podfile.lock', 'pubspec.lock', 'mix.lock',
]);
const GENERATED_PATTERNS = [/\.min\.(js|mjs|cjs|css)$/, /\.(js|mjs|cjs|css)\.map$/, /\.snap$/];

/**
 * Is this path a machine-generated artifact Plex should never read? Applied at every
 * ingestion edge: diff normalization (the file never reaches the review context),
 * added-text extraction (never embedded), co-change aggregation (never counted toward a
 * commit's size or pairs), graph discovery, and the deterministic runner. Pure;
 * paths are repo-relative POSIX.
 */
export function isGeneratedArtifact(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  return GENERATED_BASENAMES.has(base) || GENERATED_PATTERNS.some((p) => p.test(base));
}

/**
 * Embed `texts` resiliently. Two failure modes the raw `provider.embed` doesn't handle, both of
 * which should DEGRADE a feature (semantic waiver matching, fix inference) rather than fail the
 * whole review/verdict that merely wanted the enrichment:
 *
 *  - **Oversized batch** — one `embed([...])` over every changed region + prior finding + (uncapped)
 *    PR-comment body can blow past a provider's array/token limit (OpenAI 2048 items, Voyage 1000).
 *    So we cap each text to `maxChars` and send in chunks of `chunkSize`, concatenating in order
 *    (result[i] still aligns with texts[i]).
 *  - **Transient error** — a rate-limit/network/bad-key throw returns `null` instead of propagating,
 *    so the caller falls back to its no-embeddings path.
 *
 * Returns `null` if ANY chunk fails (all-or-nothing keeps index alignment simple — a partial result
 * would misalign the callers' `vecs[i]` indexing).
 */
export async function safeEmbed(
  provider: EmbeddingProvider,
  texts: string[],
  opts: { maxChars?: number; chunkSize?: number } = {},
): Promise<number[][] | null> {
  const maxChars = opts.maxChars ?? 8000;
  const chunkSize = opts.chunkSize ?? 128;
  const capped = texts.map((t) => (t.length > maxChars ? t.slice(0, maxChars) : t));
  try {
    const out: number[][] = [];
    for (let i = 0; i < capped.length; i += chunkSize) {
      out.push(...(await provider.embed(capped.slice(i, i + chunkSize))));
    }
    // A provider that returns a different count than it was given (a dropped item, a partial response)
    // would silently MISALIGN every caller's `vecs[i] ↔ texts[i]` indexing — a wrong fix-match / waiver,
    // not a crash. Treat a length mismatch like a thrown error: degrade to null (locality-only), never
    // hand back a misaligned array (m5/#5 silent-failure audit).
    if (out.length !== texts.length) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Mean + std of the pairwise cosines of a vector set — the "background" similarity distribution of
 * a batch. Embedding spaces are anisotropic, so this baseline differs per model; measuring it from
 * the batch is how a threshold can adapt without a stored calibration corpus (tuning.md §6). Samples
 * up to `sampleCap` pairs (deterministic prefix). Returns {mu:0, sigma:0} for <2 usable vectors.
 */
export function cosineBackground(vectors: number[][], sampleCap = 4000): { mu: number; sigma: number } {
  const usable = vectors.filter((v) => v.length > 0);
  const sims: number[] = [];
  outer: for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      sims.push(cosineSimilarity(usable[i]!, usable[j]!));
      if (sims.length >= sampleCap) break outer;
    }
  }
  if (sims.length === 0) return { mu: 0, sigma: 0 };
  const mu = sims.reduce((a, b) => a + b, 0) / sims.length;
  const sigma = Math.sqrt(sims.reduce((a, b) => a + (b - mu) ** 2, 0) / sims.length);
  return { mu, sigma };
}

/**
 * Adapt a fixed cosine threshold UPWARD only — `max(fixed, mu + k·sigma)`. For a *suppression* gate
 * (a waiver, an auto-accept) this is the SAFE direction: on a model whose baseline cosines run high
 * (anisotropy) the threshold rises so the gate fires more conservatively (suppresses LESS, surfaces
 * MORE); it can never drop below `fixed`, so it never hides more than the hand-tuned value would.
 * Pure. (tuning.md §6.)
 */
export function adaptiveFloor(fixed: number, bg: { mu: number; sigma: number }, k = 3): number {
  return Math.max(fixed, bg.mu + k * bg.sigma);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
