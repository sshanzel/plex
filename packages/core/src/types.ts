/**
 * Core domain types. INVARIANT (ADR-04): severity and confidence are independent axes — a "potential
 * bug" is severity `bug` + lower `confidence`, not its own severity.
 */

// Diffs (normalized — ADR-14: local and PR inputs both reduce to this)

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
  /** Generated files the diff touched but normalization DROPPED from `files` — kept as a supply-chain signal. */
  generatedPaths?: string[];
}

/** The stated motivation behind a change (PR title/description, commits) — for checking code against claimed intent. */
export interface ChangeContext {
  title?: string;
  description?: string;
  /** Commit subjects in the diff range (for branch reviews). */
  commits?: string[];
  url?: string;
}

// Code graph (durable, per-repo) — unioned edge sources by provenance (ADR-06)

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

// Review neighborhood (ephemeral, per-PR) — the materialized blast radius

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

// Findings (one ranked stream from three sources — ADR-03)

/**
 * `bug`/`improvement`/`nit` are the "fix this" axis. `note` is a different intent (ADR-31): "noticed,
 * worth confirming" — never a nit, surfaced in its OWN bucket, not buried in the defect ranking.
 */
export type Severity = 'bug' | 'improvement' | 'nit' | 'note';
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
  /** How it should surface. `note` = a point worth confirming (ADR-31), its own bucket. */
  triage: 'surface' | 'systemic-migration' | 'convention' | 'note' | 'demoted' | 'suppressed';
}

// Feedback loop (ADR-10) — verdicts reweight knowledge; scope matters

/**
 * `accept`/`reject`/`waive` are the defect verdicts. `acknowledge` (ADR-31): a `note` was a good catch
 * but intentional — suppresses it going forward WITHOUT down-weighting the knowledge that raised it.
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
   * INFERRED by fix matching (ADR-28 auto-accept) vs recorded explicitly. Inferred accepts skip
   * retroactive pitfall inference — compounding two inferences would corrupt knowledge confidence.
   */
  inferred?: boolean;
}

/** A self-contained suppression rule from a `waive` verdict — carries identity fields to re-match future findings (ADR-10). */
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
   * `file#name` symbol key the waived finding was anchored to (ADR-48). When set, a `file`/`line` waiver
   * matches ONLY a finding at the SAME symbol. Absent ⇒ pure file/line matching (back-compat).
   */
  symbol?: string;
  /** Embedding of the waived finding — lets pattern/category waivers suppress the same issue by meaning across drift (ADR-27). */
  embedding?: number[];
}

// Knowledge base (ADR-08) — curated, provenance-backed, retrieved at review time

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
  /** `global` applies everywhere; `repo` is origin-specific but still stored. Undefined = global (back-compat). */
  scope?: 'global' | 'repo';
  /** Origin repo — set for repo-scoped / analyzed pitfalls; used to filter retrieval. */
  repo?: string;
  /**
   * `negative` = SUPPRESS this (a learned dismissal); `positive`/undefined = surface. A negative
   * pitfall's `confidence` drives a weighted demote→suppress, never a one-click kill (C1, negative-knowledge.md).
   */
  polarity?: 'positive' | 'negative';
  /** Stable identity a NEGATIVE pitfall suppresses against (a rule tag/pattern); matched when a finding's tag equals it. */
  suppressKey?: string;
  /** Language scope (`ts`/`py`/…); undefined = agnostic. Promotion is language-AWARE (C2): a TS rule never reaches a Python repo. */
  language?: string;
  /** Provenance: ids of the incidents this pitfall was distilled from. */
  incidentIds: string[];
  /** ISO ts of the most recent folded incident — the single field retrieval recency-tilt reads (ADR-42). Undefined ⇒ full weight. */
  lastReinforcedAt?: string;
  /** Retrieval vector (set when the pitfall is written). */
  embedding?: number[];
}

// Review brain (M6/M11) — per-PR working memory (ADR-30)

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

/** A region changed since the previous round (ADR-23). `unexplained` (nothing drove it) = the highest-value signal to scrutinize. */
export interface AttributedChange extends ChangedRegion {
  attribution: ChangeAttribution;
  /** What explains a feedback-driven change (a comment/finding reference). */
  reason?: string;
}

export type IncidentSource = 'review' | 'analyzed';
/**
 * Observed disposition of a flagged issue (ADR-50):
 *  - `fixed`/`accepted`/`reverted` — STRONG confirm (weight 1): observed change, live accept, or revert.
 *  - `corroborated` — WEAK confirm (fractional, `CORROBORATED_WEIGHT`): PR-author reply-agreement, no observed diff.
 *  - `rejected` — a refute (live-review only; analysis never emits this).
 */
export type IncidentOutcome = 'fixed' | 'accepted' | 'rejected' | 'reverted' | 'corroborated';

export interface Incident {
  id: string;
  pitfallId?: string;
  source: IncidentSource;
  repo?: string;
  file?: string;
  /**
   * Code-path anchor (ADR-47): WHERE this concern was raised. `line` 1-based; `symbol` the drift-tolerant
   * `file#name`. Feed `matchCodePath` ("fixed HERE before"). Optional/best-effort; never affects confidence math.
   */
  line?: number;
  symbol?: string;
  snippet?: string;
  outcome?: IncidentOutcome;
  /** Provenance note — free text WHY this incident exists (e.g. a dismissal's verb + round, which `outcome` alone loses). */
  note?: string;
  /**
   * Dismissal verb for a learned-suppression incident — the authoritative source for recency-decay
   * half-life selection (ADR-41; `outcome:'rejected'` alone flattens reject vs waive). Absent ⇒ defaults to `reject`.
   */
  verb?: 'reject' | 'waive';
  /**
   * Provenance back to the review event (ADR-46): the brain `Finding.id` confirmed from + the review
   * `target` — a recorded finding→incident→pitfall edge. Optional/best-effort; never affects confidence math.
   */
  findingId?: string;
  target?: string;
  ts: string;
}
