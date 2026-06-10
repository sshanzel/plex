/**
 * Core domain types shared across the reviewer.
 *
 * Design note (ADR-04): **severity and confidence are independent axes.**
 * A "potential bug" is severity `bug` + lower `confidence` — not its own severity.
 */

// ---------------------------------------------------------------------------
// Diffs (normalized — see ADR-14: local and PR inputs both reduce to this)
// ---------------------------------------------------------------------------

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** A contiguous range of changed lines on the new side of a file (1-based, inclusive). */
export interface LineRange {
  start: number;
  end: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Added/changed line ranges on the new side — used to map hunks to symbols. */
  newRanges: LineRange[];
}

export interface DiffFile {
  /** Path on the new side (or old path for deletions). */
  path: string;
  /** Previous path, present for renames. */
  oldPath?: string;
  status: DiffFileStatus;
  hunks: DiffHunk[];
}

export interface NormalizedDiff {
  /** What the diff is measured against (a ref, or a synthetic label like "HEAD (working)"). */
  baseRef: string;
  headRef?: string;
  files: DiffFile[];
  /**
   * Machine-generated files (lockfiles, bundles — `isGeneratedArtifact`) the diff touched
   * but normalization DROPPED from `files`. Kept as a fact so a lockfile-only change is
   * still visible as a supply-chain signal, just never read line-by-line.
   */
  generatedPaths?: string[];
}

/**
 * The *stated motivation* behind a change — PR title/description or commit messages.
 * Lets the reviewer check the code AGAINST its claimed intent (e.g. flag overclaims, or
 * behavior that contradicts the description).
 */
export interface ChangeContext {
  title?: string;
  description?: string;
  /** Commit subjects in the diff range (for branch reviews). */
  commits?: string[];
  url?: string;
}

// ---------------------------------------------------------------------------
// Code graph (durable, per-repo) — unioned edge sources by provenance (ADR-06)
// ---------------------------------------------------------------------------

export type EdgeProvenance = 'import' | 'co-change' | 'precise-call' | 'precise-ref';

export interface GraphNode {
  /** Stable id, e.g. `repo:path#symbol` or `repo:path`. */
  id: string;
  label: 'File' | 'Symbol';
  props: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  provenance: EdgeProvenance;
  /** 0..1 — co-change edges carry a fuzzy weight; structural edges default to 1. */
  weight: number;
}

export interface CodeLocation {
  repo: string;
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

// ---------------------------------------------------------------------------
// Review neighborhood (ephemeral, per-PR) — the materialized blast radius
// ---------------------------------------------------------------------------

export interface NeighborEntry {
  node: GraphNode;
  /** Aggregate coupling to the change set, 0..1. */
  score: number;
  /** Which edge sources contributed (transparency for the reviewer). */
  via: EdgeProvenance[];
  /** Shortest hop distance from a changed node. */
  distance: number;
}

export interface ReviewNeighborhood {
  repo: string;
  /** Symbols/files directly touched by the diff. */
  changed: CodeLocation[];
  /** Coupled nodes pulled in by blast-radius expansion, ranked by score. */
  neighbors: NeighborEntry[];
}

// ---------------------------------------------------------------------------
// Findings (one ranked stream from three sources — ADR-03)
// ---------------------------------------------------------------------------

/**
 * `bug`/`improvement`/`nit` are the "fix this" axis (ordered by how bad). `awareness` is
 * a different intent (ADR-31): "noticed, worth confirming" — surfacing it IS the value
 * even when nothing needs changing (e.g. two emit sites for the same event). It is never
 * a nit and is surfaced in its own bucket, not buried in the defect ranking.
 */
export type Severity = 'bug' | 'improvement' | 'nit' | 'awareness';
export type FindingSource = 'first-principles' | 'knowledge' | 'deterministic';

export interface Finding {
  id: string;
  title: string;
  body: string;
  severity: Severity;
  /** 0..1. Low confidence + `bug` severity == a "potential bug". */
  confidence: number;
  source: FindingSource;
  location: CodeLocation;
  /** Link to a knowledge-graph Pitfall when knowledge-grounded. */
  pitfallId?: string;
  /** Supporting references / provenance (incident ids, rule ids, reasoning anchors). */
  evidence?: string[];
  /** 0..1 blast-radius weight at the finding's location. */
  blastRadius?: number;
  /** 0..1 how common this pattern is in the repo (drives prevalence-by-severity). */
  prevalence?: number;
  tags?: string[];
  /** Retrieval vector of title+body, set at rank time for semantic waiver matching (ADR-27). */
  embedding?: number[];
}

/** A finding after merge/dedup/ranking, with its computed signal and triage. */
export interface RankedFinding extends Finding {
  /** signal = severityWeight × confidence × blast × deviation × agreement (ADR-04/05 — the formula lives in @plex/findings signal.ts; waived findings are triaged `suppressed`, not subtracted). */
  signal: number;
  /** Sources that independently agreed on this finding (cross-source confidence boost). */
  agreedSources: FindingSource[];
  /** How it should surface. `awareness` = a flag worth confirming (ADR-31), its own bucket. */
  triage: 'surface' | 'systemic-migration' | 'convention' | 'awareness' | 'suppressed';
}

// ---------------------------------------------------------------------------
// Feedback loop (ADR-10) — verdicts reweight knowledge; scope matters
// ---------------------------------------------------------------------------

/**
 * `accept`/`reject`/`waive` are the defect verdicts. `acknowledge` (ADR-31) confirms an
 * `awareness` flag was a *good* catch but intentional this time: it suppresses the same
 * flag going forward (like a semantic waiver) WITHOUT down-weighting the knowledge that
 * raised it — so a *materially changed* instance (e.g. a 3rd site) re-surfaces.
 */
export type VerdictKind = 'accept' | 'reject' | 'waive' | 'acknowledge';

/** Where a waiver applies. Broader scope suppresses more aggressively. */
export type WaiverScope =
  | 'line'
  | 'file'
  | 'pattern-repo'
  | 'category-repo'
  | 'category-global';

export interface Verdict {
  findingId: string;
  kind: VerdictKind;
  scope?: WaiverScope;
  note?: string;
  /**
   * True when this verdict was INFERRED by fix matching (ADR-28 auto-accepts) rather than
   * recorded explicitly. Inferred accepts skip retroactive pitfall inference — a ±5-line
   * locality match feeding a title-similarity match would compound two inferences into
   * knowledge confidence; explicit verdicts (or an explicit `pattern` link) are the only
   * paths that move a pitfall.
   */
  inferred?: boolean;
}

/**
 * A self-contained suppression rule derived from a `waive` verdict. Because finding ids
 * are per-run, a waiver carries the identity fields needed to re-match future findings
 * at its scope (ADR-10).
 */
export interface Waiver {
  scope: WaiverScope;
  file?: string;
  line?: number;
  /** Finding title at waive time (used for pattern-scope fuzzy match). */
  title?: string;
  /** Pitfall id / rule id / tag for pattern-scope match. */
  pattern?: string;
  /** Category tag for category-scope match. */
  category?: string;
  /**
   * Embedding of the waived finding (set when a provider is configured). Lets pattern/
   * category-scoped waivers suppress the *same issue* across rounds by meaning, surviving
   * line drift and wording changes — not just exact title/line identity (ADR-27).
   */
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// Knowledge base (ADR-08) — curated, provenance-backed, retrieved at review time
// ---------------------------------------------------------------------------

/** codifiable → can become a deterministic rule; judgmental → needs the model. */
export type PitfallTier = 'codifiable' | 'judgmental';

export interface Pitfall {
  id: string;
  title: string;
  /** What code shape triggers it — the retrieval text. */
  trigger: string;
  why: string;
  mitigation?: string;
  category: string;
  tier: PitfallTier;
  /** 0..1, grows with corroborating incidents and accepted outcomes. */
  confidence: number;
  /**
   * `global` applies to every repo; `repo` is specific to its origin project but still
   * stored (it helps whenever working on that project). Undefined = global (back-compat).
   */
  scope?: 'global' | 'repo';
  /** Origin repo — set for repo-scoped / analyzed pitfalls; used to filter retrieval. */
  repo?: string;
  /** Provenance: ids of the incidents this pitfall was distilled from. */
  incidentIds: string[];
  /** Retrieval vector (set when the pitfall is written). */
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// Review brain (M6/M11) — per-PR working memory, persisted in the embedded Kùzu brain (ADR-30)
// ---------------------------------------------------------------------------

/** A review invocation on a target at a distinct head — rounds accumulate (ADR-23). */
export interface ReviewRound {
  /** Stable target id (`<repo>__pr_<n>` / `<repo>__<mode>`). */
  target: string;
  /** 1-based round number. */
  n: number;
  ts: string;
  /** Head commit reviewed this round (PR head / local HEAD) — keys "what changed since". */
  headSha?: string;
  baseRef: string;
}

/** A PR-thread review comment, ingested per round as a *fact* (never chain-of-thought). */
export interface PrComment {
  id: string;
  file?: string;
  line?: number;
  body: string;
  author?: string;
  createdAt?: string;
}

/** A contiguous changed region on the new side of a file (used for round deltas). */
export interface ChangedRegion {
  file: string;
  start: number;
  end: number;
}

export type ChangeAttribution = 'feedback-driven' | 'unexplained';

/**
 * A region changed since the previous round, classified by whether a prior finding or
 * PR comment explains it (ADR-23). `unexplained` = changed with nothing driving it →
 * the highest-value signal for the fresh reviewer to scrutinize.
 */
export interface AttributedChange extends ChangedRegion {
  attribution: ChangeAttribution;
  /** What explains a feedback-driven change (a comment/finding reference). */
  reason?: string;
}

export type IncidentSource = 'review' | 'analyzed';
export type IncidentOutcome = 'fixed' | 'accepted' | 'rejected' | 'reverted';

export interface Incident {
  id: string;
  pitfallId?: string;
  source: IncidentSource;
  repo?: string;
  file?: string;
  snippet?: string;
  outcome?: IncidentOutcome;
  ts: string;
}
