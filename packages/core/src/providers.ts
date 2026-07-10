/**
 * Pluggable provider interfaces (ADR-13). The embedding provider must wrap an actual embedding endpoint.
 */
import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  readonly name: string;
  /** Vector dimensionality this provider returns. */
  readonly dimensions: number;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

/** URL/id-safe slug: lowercase, non-alphanumerics → '-', trimmed, capped. */
export function slugify(s: string, maxLen = 48): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

/** Short, stable content hash for disambiguating ids whose slugs would collide or be empty (idempotent). */
export function hashId(s: string, len = 8): string {
  return createHash('sha1').update(s).digest('hex').slice(0, len);
}

// Machine-written files with zero review signal: lockfiles distort co-change weighting; bundles/maps blow token budgets.
const GENERATED_BASENAMES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'bun.lockb', 'bun.lock', 'deno.lock', 'cargo.lock', 'composer.lock',
  'gemfile.lock', 'poetry.lock', 'uv.lock', 'pipfile.lock', 'go.sum',
  'flake.lock', 'packages.lock.json', 'podfile.lock', 'pubspec.lock', 'mix.lock',
]);
const GENERATED_PATTERNS = [/\.min\.(js|mjs|cjs|css)$/, /\.(js|mjs|cjs|css)\.map$/, /\.snap$/, /\.pyc$/, /_pb2(_grpc)?\.py$/];

/** Is this path a machine-generated artifact Plex should never read? Applied at every ingestion edge. Pure; repo-relative POSIX. */
export function isGeneratedArtifact(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  return GENERATED_BASENAMES.has(base) || GENERATED_PATTERNS.some((p) => p.test(base));
}

/**
 * Embed `texts` resiliently: cap to `maxChars` + chunk by `chunkSize` (provider batch limits), and
 * return `null` on any failure so callers DEGRADE rather than fail. All-or-nothing: a partial result
 * would misalign every caller's `vecs[i] ↔ texts[i]` indexing.
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
    // A different count than input would silently MISALIGN every caller's `vecs[i] ↔ texts[i]` — degrade to null.
    if (out.length !== texts.length) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Mean + std of pairwise cosines of a vector set — the anisotropy-aware per-model background baseline
 * (tuning.md §6). Samples up to `sampleCap` pairs; returns {mu:0, sigma:0} for <2 usable vectors.
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
 * Adapt a fixed cosine threshold UPWARD only — `max(fixed, mu + k·sigma)`. The SAFE direction for a
 * suppression gate: it raises the bar (suppresses LESS) and never drops below `fixed`. Pure (tuning.md §6).
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
