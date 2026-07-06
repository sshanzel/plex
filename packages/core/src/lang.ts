import path from 'node:path';

/**
 * The language-plugin seam (ADR-15/52): per-language extraction + import resolution plug in behind
 * these shapes. Types only — implementations live in @plex/code-graph (TS) and @plex/lang-python.
 */

/** One extracted declaration — what a language extractor reports per symbol. */
export interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const';
  /** 1-based, inclusive; spans include decorators. */
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ExtractedFile {
  /** Raw module specifiers in the language's own canonical text (TS: string-literal specifiers;
   *  Python: dotted paths, leading dots preserved for relative imports). Deduped. */
  imports: string[];
  symbols: ExtractedSymbol[];
}

/** A file queued for batch import resolution. */
export interface SourceUnit {
  /** Repo-relative POSIX path. */
  rel: string;
  abs: string;
  imports: string[];
}

export interface ImportEdge {
  from: string;
  to: string;
}

export interface ResolvedImports {
  /** Base structural layer → `Imports` edges (ADR-06). */
  imports: ImportEdge[];
  /** Config-aware enrichment → `Refs` edges; empty for languages without a precise layer. */
  refs: ImportEdge[];
}

export interface ResolveOptions {
  /** Compute the precise/Refs layer (default true). */
  refs?: boolean;
  /** Extra module roots (repo-relative POSIX) beyond the heuristic ones. */
  extraRoots?: readonly string[];
}

export interface LanguagePlugin {
  /** Stable plugin id (`ts` | `py`). */
  id: string;
  /** Extensions (with dot) this plugin owns; the union across plugins is the indexable-file allowlist. */
  exts: readonly string[];
  /** One-time async setup (e.g. a wasm load). Idempotent; awaited lazily on the first matching file. */
  init?(): Promise<void>;
  /** Pure; sync after `init`. */
  extract(fileName: string, text: string): ExtractedFile;
  /** Batch resolution over this plugin's files against the discovered fileSet — batch-level because
   *  some languages (Python) need a whole-fileSet module index before any single import can resolve. */
  resolve(
    repoPath: string,
    units: SourceUnit[],
    fileSet: ReadonlySet<string>,
    opts?: ResolveOptions,
  ): ResolvedImports;
}

// Extension → coarse language tag, so global promotion stays language-AWARE (C2): a TS rule must never
// apply to a Python repo. Undefined = unknown/agnostic.
const EXT_LANG: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.go': 'go', '.rb': 'rb', '.rs': 'rs', '.java': 'java', '.kt': 'kt', '.cs': 'cs',
  '.php': 'php', '.swift': 'swift', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
};

export function languageOf(file?: string): string | undefined {
  if (!file) return undefined;
  return EXT_LANG[path.extname(file).toLowerCase()];
}
