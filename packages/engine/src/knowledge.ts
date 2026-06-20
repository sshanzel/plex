import path from 'node:path';
import {
  safeEmbed,
  cosineSimilarity,
  cosineBackground,
  adaptiveFloor,
  hashId,
  type ReviewerConfig,
  type CodeLocation,
  type Finding,
  type Incident,
  type IncidentOutcome,
  type Pitfall,
} from '@plex/core';
import {
  KnowledgeStore,
  createEmbeddingProvider,
  retrieveRelevant,
  retrieveRelevantLexical,
  lexicalScores,
  recordIncident,
  consolidatePitfalls,
  suppressionTier,
  decayedCounts,
  type Dismissal,
  type RetrievedPitfall,
  type ConsolidateResult,
} from '@plex/knowledge';
import { recordVerdict, readVerdicts, type VerdictInput, type StoredVerdict } from './verdicts';
import { Brain } from './brain';
import { logAudit } from './audit';
import { projectableOutcome } from './guards';

export function knowledgeStore(config: ReviewerConfig): KnowledgeStore {
  return new KnowledgeStore(config.knowledgeDir);
}

export function buildKnowledgeQuery(
  changed: CodeLocation[],
  deterministic: Finding[],
  files: string[],
): string {
  return [...changed.map((c) => c.symbol ?? c.file), ...deterministic.map((d) => d.title), ...files]
    .join(' ')
    .slice(0, 2000);
}

const NO_EMBEDDINGS =
  "No embedding provider — set PLEX_EMBEDDING_PROVIDER (voyage | openai | gemini | ollama) and its API key. ('fake' is test-only.)";

/** Embedding provider or throw — for write paths that must not store noise. */
export function requireEmbeddings(config: ReviewerConfig) {
  const p = createEmbeddingProvider(config.embedding);
  if (!p) throw new Error(NO_EMBEDDINGS);
  return p;
}

/** Is a real embedding provider (with its key) configured? — for `plex doctor`. */
export function embeddingReady(config: ReviewerConfig): boolean {
  return config.embedding.provider !== 'fake' && createEmbeddingProvider(config.embedding) != null;
}

/**
 * Retrieve relevant pitfalls (ADR-01 grounded retrieval), scoped to `repo` (ADR-21). With no embedding
 * provider, falls back to lexical (IDF token-overlap) retrieval — weaker, but a key-less install still
 * gets its pitfalls back.
 */
export async function getRelevantKnowledge(
  config: ReviewerConfig,
  queryText: string,
  topK = 5,
  repo?: string,
  now: Date = new Date(),
): Promise<RetrievedPitfall[]> {
  if (!queryText.trim()) return [];
  const store = knowledgeStore(config);
  const { halfLifeDays, retrievalTiltFloor } = config.decay;
  const provider = createEmbeddingProvider(config.embedding);
  if (!provider) return retrieveRelevantLexical(store, queryText, topK, 0.05, repo, now, halfLifeDays, retrievalTiltFloor);
  return retrieveRelevant(store, provider, queryText, topK, 0.05, repo, now, halfLifeDays, retrievalTiltFloor);
}

// Floors for retroactively linking an accepted finding to a pitfall. Conservative: a wrong link feeds
// one pitfall's confidence with another issue's evidence. Embed floor adapts UPWARD (tuning.md §6).
const INFER_EMBED_FLOOR = 0.7;
const INFER_LEXICAL_FLOOR = 0.45;

/**
 * Best-effort: find the pitfall an accepted finding instantiates so the accept reinforces it (ADR-10) —
 * embedding cosine where vectors exist, else lexical IDF overlap. Returns undefined on any failure
 * (inference is enrichment, never a verdict blocker).
 */
export async function inferPitfallId(
  config: ReviewerConfig,
  title: string | undefined,
  repo?: string,
): Promise<string | undefined> {
  if (!title?.trim()) return undefined;
  try {
    const pitfalls = (await knowledgeStore(config).pitfalls()).filter(
      (p) => (p.scope ?? 'global') !== 'repo' || p.repo === repo,
    );
    if (pitfalls.length === 0) return undefined;
    const embedded = pitfalls.filter((p) => p.embedding && p.embedding.length > 0);
    const provider = createEmbeddingProvider(config.embedding);
    let judgedSemantically = false;
    if (provider && embedded.length > 0) {
      const q = (await safeEmbed(provider, [title]))?.[0];
      if (q) {
        judgedSemantically = true;
        const floor = adaptiveFloor(INFER_EMBED_FLOOR, cosineBackground(embedded.map((p) => p.embedding!)));
        let best: { id: string; score: number } | undefined;
        for (const p of embedded) {
          const score = cosineSimilarity(q, p.embedding!);
          if (score >= floor && (best == null || score > best.score)) best = { id: p.id, score };
        }
        if (best) return best.id;
      }
    }
    // Lexical pass over only what the semantic pass could NOT judge — never second-guess a semantic
    // "not similar" with a keyword match.
    const candidates = judgedSemantically ? pitfalls.filter((p) => !p.embedding || p.embedding.length === 0) : pitfalls;
    if (candidates.length === 0) return undefined;
    const lex = lexicalScores(title, candidates);
    let bi = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (lex[i]! >= INFER_LEXICAL_FLOOR && (bi < 0 || lex[i]! > lex[bi]!)) bi = i;
    }
    return bi >= 0 ? candidates[bi]!.id : undefined;
  } catch {
    return undefined;
  }
}

/** Record a confirmed finding as an incident (feedback loop — ADR-10). */
export async function learnIncident(
  config: ReviewerConfig,
  input: { repo?: string; file?: string; line?: number; symbol?: string; snippet?: string; outcome?: IncidentOutcome; pitfallId?: string; note?: string; verb?: 'reject' | 'waive'; findingId?: string; target?: string },
): Promise<string> {
  return recordIncident(knowledgeStore(config), {
    ...input,
    source: 'review',
    ts: new Date().toISOString(),
  });
}

/** Recompute pitfall confidence from incident outcomes (feedback loop — ADR-10), recency-decayed +
 * pruned per `config.decay` (ADR-42). `now` injected for deterministic tests. */
export async function consolidateKnowledge(config: ReviewerConfig, now: Date = new Date()): Promise<ConsolidateResult> {
  return consolidatePitfalls(knowledgeStore(config), config.decay, now);
}

/**
 * The stable identity a dismissal suppresses against: a deterministic rule tag (parsed from the
 * `det:<rule>:<file>:<line>` finding id) or an explicit `pattern`. Returns undefined when there's no
 * stable key — we never learn a repo-wide suppression from a one-off, untagged finding.
 */
export function suppressionKeyFor(input: { findingId?: string; pattern?: string }): string | undefined {
  const m = input.findingId?.match(/^det:([^:]+):/);
  if (m) return m[1];
  return input.pattern || undefined;
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

/** A learned-suppression decision with the evidence that justifies it — the provenance the audit log
 * records so "why is this rule demoted/suppressed?" is answerable. */
export interface SuppressionDecision {
  /** Match identity: a deterministic rule tag, or the pitfall id for a first-principles (semantic) one. */
  key: string;
  tier: 'suppress' | 'demote';
  dismissals: number;
  corrections: number;
  pitfallId: string;
  /** Present for FIRST-PRINCIPLES suppressions (ADR-41) — match findings SEMANTICALLY (cosine), not by tag. */
  embedding?: number[];
  /**
   * Location scope (ADR-48). `true` ⇒ applies REPO-WIDE (explicit `pattern-repo`/`category-*`, ANY
   * symbol-less contributing incident — fail-open, or cross-repo/first-principles). `false` ⇒ matches
   * only a finding whose `file#name` symbol is in `symbols`, so dismissing one instance never silences
   * the rule at another symbol.
   */
  repoWide: boolean;
  /** The `file#name` symbol keys this rule was dismissed at (symbol-scoped decisions). */
  symbols?: Set<string>;
}

/**
 * Generalize a per-repo suppression to all repos of its language once the SAME rule earned `suppress`
 * in ≥ this many distinct repos (C2). A policy floor; ≥2 so one repo can never self-promote.
 */
const PROMOTE_MIN_REPOS = 2;

/**
 * The learned suppression decisions effective for a repo (docs/design/negative-knowledge.md). Computed
 * LIVE from negative pitfalls' incident counts via Wilson `suppressionTier`, so a dismissal takes effect
 * next review WITHOUT waiting for `consolidate`. Two sources, deduped by key (stronger tier wins): this
 * repo's own negatives, and cross-repo language-gated promotion (C2 — a TS rule never merges with Python).
 */
export async function loadSuppressions(
  config: ReviewerConfig,
  repoName: string,
  now: Date = new Date(),
): Promise<SuppressionDecision[]> {
  const store = knowledgeStore(config);
  const [pitfalls, incidents] = await Promise.all([store.pitfalls(), store.incidents()]);
  // Include both deterministic (keyed) and first-principles (embedding-keyed) negatives (ADR-41).
  const negatives = pitfalls.filter((p) => p.polarity === 'negative' && (p.suppressKey || p.embedding?.length));
  if (negatives.length === 0) return [];

  const byPitfall = new Map<string, Incident[]>();
  for (const i of incidents) {
    if (!i.pitfallId) continue;
    (byPitfall.get(i.pitfallId) ?? byPitfall.set(i.pitfallId, []).get(i.pitfallId)!).push(i);
  }
  const hl = { rejectDays: config.suppression.rejectHalfLifeDays, waiveDays: config.suppression.waiveHalfLifeDays };
  const nowMs = now.getTime();
  // Recency-decay the evidence (ADR-41): each dismissal contributes `recencyWeight` by its verb's
  // half-life (reject fades, waive persists); corrections are durable — so a suppression ages back to
  // surface on its own.
  const countsOf = (p: Pitfall): { dismissals: number; corrections: number } => {
    const inc = byPitfall.get(p.id) ?? [];
    // ONE dismissal vote per (file, SYMBOL) (drift-stability, ADR-48), strongest verb wins: a `waive`
    // over a prior `reject` (ADR-41) upgrades the half-life, not double-counts. Distinct symbols in the
    // same file each count; a symbol-less incident keys identically to the old per-file grouping.
    const byInstance = new Map<string, Incident[]>();
    for (const i of inc) {
      if (i.outcome !== 'rejected') continue;
      const k = `${i.file ?? ''} ${i.symbol ?? ''}`;
      (byInstance.get(k) ?? byInstance.set(k, []).get(k)!).push(i);
    }
    const dismissals: Dismissal[] = [];
    for (const group of byInstance.values()) {
      const chosen = group.find((i) => (i.verb ?? 'reject') === 'waive') ?? group[0]!; // strongest verb wins
      const t = Date.parse(chosen.ts);
      const ageDays = Number.isNaN(t) ? 0 : (nowMs - t) / 86_400_000; // unparseable ts → full weight
      dismissals.push({ verb: chosen.verb ?? 'reject', ageDays }); // verb authoritative; default reject (conservative)
    }
    const corrections = inc.filter((i) => i.outcome === 'accepted' || i.outcome === 'fixed' || i.outcome === 'reverted').length;
    return decayedCounts(dismissals, corrections, hl);
  };

  // Location scope (ADR-48): the symbols this rule was dismissed at. ANY symbol-less dismissal incident
  // ⇒ REPO-WIDE (fail-open). Otherwise symbol-scoped, so dismissing one instance never silences elsewhere.
  const scopeOf = (p: Pitfall): { repoWide: boolean; symbols?: Set<string> } => {
    const dismissals = (byPitfall.get(p.id) ?? []).filter((i) => i.outcome === 'rejected');
    const symbols = new Set<string>();
    let anySymbolless = false;
    for (const i of dismissals) {
      if (i.symbol) symbols.add(i.symbol);
      else anySymbolless = true;
    }
    if (anySymbolless || symbols.size === 0) return { repoWide: true };
    return { repoWide: false, symbols };
  };

  const rank = { none: 0, demote: 1, suppress: 2 } as const;
  const best = new Map<string, SuppressionDecision>();
  const consider = (d: SuppressionDecision): void => {
    const prev = best.get(d.key);
    if (!prev || rank[d.tier] > rank[prev.tier]) best.set(d.key, d);
  };

  // 1) This repo's own negatives (and any already-global one).
  for (const p of negatives) {
    if (p.scope === 'repo' && p.repo !== repoName) continue;
    const { dismissals, corrections } = countsOf(p);
    const tier = suppressionTier(dismissals, corrections);
    if (tier !== 'none') {
      // First-principles negatives key on the pitfall id + carry the `embedding` to match SEMANTICALLY
      // (ADR-41); REPO-WIDE in v1 (their identity is a title embedding, not a symbol — ADR-48). Keyed
      // negatives carry the symbol scope from their dismissal incidents.
      consider(
        p.suppressKey
          ? { key: p.suppressKey, tier, dismissals, corrections, pitfallId: p.id, ...scopeOf(p) }
          : { key: p.id, tier, dismissals, corrections, pitfallId: p.id, embedding: p.embedding, repoWide: true },
      );
    }
  }

  // 2) Cross-repo promotion, grouped by (key, language) so languages never merge.
  const groups = new Map<string, Pitfall[]>();
  for (const p of negatives) {
    if (p.scope !== 'repo' || !p.suppressKey) continue; // cross-repo promotion is deterministic-only
    const g = `${p.suppressKey} ${p.language ?? ''}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(p);
  }
  for (const group of groups.values()) {
    const suppressingRepos = new Set<string>();
    let dismissals = 0;
    let corrections = 0;
    for (const p of group) {
      const c = countsOf(p);
      dismissals += c.dismissals;
      corrections += c.corrections;
      if (suppressionTier(c.dismissals, c.corrections) === 'suppress' && p.repo) suppressingRepos.add(p.repo);
    }
    if (suppressingRepos.size >= PROMOTE_MIN_REPOS) {
      const k = group[0]!.suppressKey!;
      // Cross-repo promotion stays REPO-WIDE in v1 (ADR-48): symbols don't generalize across repos.
      consider({ key: k, tier: 'suppress', dismissals, corrections, pitfallId: `global@${group[0]!.language ?? ''}:${k}`, repoWide: true });
    }
  }

  return [...best.values()];
}

/**
 * Negative-knowledge producer (docs/design/negative-knowledge.md): a dismissal/correction feeds the
 * SAME incident → consolidate loop as positive pitfalls (reject/waive confirms, accept/fix refutes).
 * The accumulated counts become a Wilson-derived `suppressionTier` — WEIGHTED, never a one-click kill
 * (C1). `firstOfKind` dedups an agent/responder retry so the same disposition can't double-count.
 */
export async function learnSuppression(
  config: ReviewerConfig,
  repoName: string,
  input: {
    kind: VerdictInput['kind']; findingId?: string; pattern?: string; file?: string; title?: string;
    note?: string; scope?: VerdictInput['scope']; symbol?: string; line?: number;
  },
  firstOfKind: boolean,
): Promise<void> {
  if (!firstOfKind) return;
  const dismissal = input.kind === 'reject' || input.kind === 'waive';
  const corrective = input.kind === 'accept';
  if (!dismissal && !corrective) return;

  const store = knowledgeStore(config);
  const key = suppressionKeyFor(input);

  // Location scope (ADR-48): by DEFAULT a dismissal anchors to the `file#name` symbol it concerned, so
  // it suppresses only THAT instance. An EXPLICIT repo-wide scope (`pattern-repo`/`category-*`) records
  // symbol-less; no symbol resolved ⇒ symbol-less ⇒ repo-wide too (fail-open).
  const explicitRepoWide =
    input.scope === 'pattern-repo' || input.scope === 'category-repo' || input.scope === 'category-global';
  const anchorSymbol = explicitRepoWide ? undefined : input.symbol;

  // Resolve the negative pitfall this incident attaches to. Two identities: DETERMINISTIC (a stable
  // `suppressKey` → keyed pitfall) or FIRST-PRINCIPLES (no key, ADR-41 — the finding's title embedding,
  // match-or-mint by cosine ~0.82; embedding-gated, else degrade to deterministic-only). `reason` is the
  // dismisser's note, captured as readable provenance.
  const reason = (input.note ?? '').trim();
  let id: string;
  let existing: Pitfall | undefined;
  let toMint: Pitfall | undefined;

  if (key) {
    id = `neg:${repoName}:${key}`;
    existing = (await store.pitfalls()).find((p) => p.id === id);
    if (!existing && corrective) return; // nothing to refute
    if (!existing) {
      toMint = {
        id, polarity: 'negative', suppressKey: key, title: `suppress:${key}@${repoName}`, trigger: key,
        why: reason ? `Suppressed \`${key}\` in ${repoName} — ${reason}` : `Learned suppression — the \`${key}\` rule was dismissed in ${repoName}.`,
        category: 'suppression', tier: 'codifiable', confidence: 0, scope: 'repo', repo: repoName,
        language: languageOf(input.file), incidentIds: [],
      };
    }
  } else {
    const provider = createEmbeddingProvider(config.embedding);
    const title = input.title?.trim();
    if (!provider || !title) return; // no stable key without embeddings → deterministic-only degradation
    const vec = (await safeEmbed(provider, [title]))?.[0];
    if (!vec) return; // transient embed failure → skip (best-effort, never fail the verdict)
    const negs = (await store.pitfalls()).filter(
      (p) => p.polarity === 'negative' && p.embedding?.length && (p.scope !== 'repo' || p.repo === repoName),
    );
    const matched = bestEmbeddingMatch(vec, negs);
    if (matched) {
      id = matched.id;
      existing = matched;
    } else {
      if (corrective) return; // nothing to refute
      id = `neg:${repoName}:fp:${hashId(title)}`;
      existing = (await store.pitfalls()).find((p) => p.id === id); // id-collision guard (same title)
      if (!existing) {
        toMint = {
          id, polarity: 'negative', title: `suppress(fp):${title.slice(0, 60)}@${repoName}`, trigger: title,
          why: reason ? `Suppressed in ${repoName} — ${reason}` : `Learned suppression — a first-principles finding ("${title.slice(0, 80)}") was dismissed in ${repoName}.`,
          category: 'suppression', tier: 'judgmental', confidence: 0, scope: 'repo', repo: repoName,
          language: languageOf(input.file), embedding: vec, incidentIds: [],
        };
      }
    }
  }

  // Drift-stable dedup (ADR-39/48): count at most ONE dismissal/correction per (pitfall, file, SYMBOL)
  // so a line-rekeyed or reworded finding can't double-count; distinct symbols each count, symbol-less
  // collapses as before. VERB UPGRADE (ADR-41): a `waive` over only prior `reject`(s) IS allowed through
  // (escalates the half-life, monotone — never downgrades); a `reject` after any dismissal, or `waive`
  // after `waive`, is dropped.
  if (existing) {
    const incs = await store.incidents();
    const sameAnchor = (i: Incident): boolean => i.pitfallId === id && i.file === input.file && (i.symbol ?? '') === (anchorSymbol ?? '');
    if (dismissal) {
      const prior = incs.filter((i) => sameAnchor(i) && i.outcome === 'rejected');
      const blocked = input.kind === 'waive' ? prior.some((i) => (i.verb ?? 'reject') === 'waive') : prior.length > 0;
      if (blocked) return;
    } else if (incs.some((i) => sameAnchor(i) && (i.outcome === 'accepted' || i.outcome === 'fixed' || i.outcome === 'reverted'))) {
      return;
    }
  }
  if (toMint) await store.addPitfall(toMint);
  await learnIncident(config, {
    repo: repoName,
    file: input.file,
    // Code-path anchor (ADR-48) so `loadSuppressions` can scope the suppression. `anchorSymbol`
    // undefined (explicit repo-wide / unresolved) → symbol-less → read as repo-wide.
    symbol: anchorSymbol,
    line: input.line,
    snippet: key ?? id,
    pitfallId: id,
    outcome: dismissal ? 'rejected' : 'accepted',
    // The verb sets the recency-decay half-life (ADR-41): reject fades, waive persists. Only dismissals carry it.
    verb: dismissal ? (input.kind === 'waive' ? 'waive' : 'reject') : undefined,
    note: `${input.kind}${input.findingId ? ` ${input.findingId}` : ''}${reason ? ` — ${reason}` : ''}`,
  });
}

/** First-principles match (ADR-41): the embedding-keyed negative pitfall most similar to `vec` if cosine
 *  clears `adaptiveFloor(0.82, …)` — conservative, biased toward minting over polluting. undefined if none. */
function bestEmbeddingMatch(vec: number[], negatives: Pitfall[]): Pitfall | undefined {
  if (negatives.length === 0) return undefined;
  const floor = adaptiveFloor(FP_EMBED_FLOOR, cosineBackground(negatives.map((p) => p.embedding!)));
  let best: { p: Pitfall; score: number } | undefined;
  for (const p of negatives) {
    const score = cosineSimilarity(vec, p.embedding!);
    if (score >= floor && (best == null || score > best.score)) best = { p, score };
  }
  return best?.p;
}

const FP_EMBED_FLOOR = 0.82; // ≈ WAIVER_SEMANTIC_THRESHOLD; conservative, bias toward minting


/**
 * Record a verdict and close the feedback loop: an `accept` becomes a knowledge incident (ADR-10) and
 * the verdict is projected into the PR brain + audit log (ADR-22/24). `target` keys which PR the verdict
 * lands in. Used by both MCP and CLI.
 */
export async function submitVerdict(
  repoPath: string,
  input: VerdictInput,
  config: ReviewerConfig,
  target?: string,
  sharedBrain?: Brain,
): Promise<StoredVerdict> {
  const repoName = path.basename(path.resolve(repoPath));
  // Resolve the code-path anchor (line + `file#name` symbol) from the brain finding FIRST (ADR-47),
  // hoisted above `recordVerdict`/`learnSuppression` (ADR-48) because three consumers want it: the
  // waive/acknowledge waiver scope, the dismissal incident scope, and the accept incident below. No
  // target (CLI verdict) → symbol-less → today's repo/file scope.
  const brain = target ? (sharedBrain ?? (await Brain.open(repoPath, config))) : undefined;
  let lastN = 0;
  let acceptLine = input.line;
  let acceptSymbol: string | undefined;
  if (brain && target) {
    try {
      const st = await brain.loadRoundState(target);
      lastN = st.lastN;
      const bf = input.findingId ? st.priorFindings.find((f) => f.id === input.findingId) : undefined;
      if (bf) {
        acceptLine = input.line ?? bf.line;
        acceptSymbol = bf.symbol;
      }
    } catch {
      /* best-effort: a brain read fault degrades the incident to file+line, round to 1 */
    }
  }

  // For waivers AND acknowledgments, embed the title for semantic re-matching next round (ADR-27/31)
  // and attach the resolved `symbol` (ADR-48) so the waiver suppresses only the SAME symbol, not every
  // finding in the file. Best-effort.
  let enriched = input;
  if (input.kind === 'waive' || input.kind === 'acknowledge') {
    const patch: Partial<VerdictInput> = {};
    if (acceptSymbol && input.symbol == null) patch.symbol = acceptSymbol;
    if (input.embedding == null) {
      const text = [input.title, input.note].filter(Boolean).join(' — ').trim();
      if (text) {
        const provider = createEmbeddingProvider(config.embedding);
        if (provider) {
          // safeEmbed: a transient failure stores the waiver WITHOUT a vector (still suppresses by
          // identity; only semantic re-matching is lost) rather than failing the verdict.
          const vecs = await safeEmbed(provider, [text]);
          if (vecs?.[0]) patch.embedding = vecs[0];
        }
      }
    }
    if (Object.keys(patch).length) enriched = { ...input, ...patch };
  }
  // Learning-side idempotency: a re-disposition of the same finding with the same verdict must NOT
  // create a second incident (duplicated evidence skews the Wilson confidence). Checked BEFORE the
  // append so the new verdict can't match itself. A finding with no id can't be deduped → always counts.
  const firstOfKind =
    input.findingId == null ||
    !(await readVerdicts(repoPath, config)).some((v) => v.kind === input.kind && v.findingId === input.findingId);
  const alreadyAccepted = input.kind === 'accept' && !firstOfKind;
  const stored = await recordVerdict(repoPath, enriched, config);
  // Negative-knowledge producer (C1): reject/waive confirms a suppression, accept refutes it. The
  // resolved `symbol`/`line` (ADR-48) anchor the dismissal incident; `input.scope` still routes an
  // explicit pattern/category dismissal to a repo-wide record.
  await learnSuppression(config, repoName, { ...input, symbol: acceptSymbol, line: acceptLine }, firstOfKind);

  if (input.kind === 'accept' && !alreadyAccepted) {
    // Link the accept to the pitfall it confirms (explicit `pattern`, else infer by similarity) so
    // first-principles accepts reinforce knowledge. An INFERRED accept never links a positive pitfall —
    // even with `pattern` set (reconcile passes it only to REFUTE a negative suppression above) — to
    // avoid stacking two inferences into the Beta posterior; it still records its incident for provenance.
    const pitfallId = input.inferred ? undefined : (input.pattern ?? (await inferPitfallId(config, input.title, repoName)));
    await learnIncident(config, {
      repo: repoName,
      file: input.file,
      // Code-path anchor (ADR-47): the `file#name` symbol + line, inherited from the brain finding so a
      // later review can match it. Anchored for INFERRED accepts too — the symbol comes from the FINDING
      // (accurate), and an inferred accept stays unlinked from any positive pitfall, so it never feeds a
      // `codePathAlert`, only the viz concern-history.
      line: acceptLine,
      symbol: acceptSymbol,
      snippet: input.title,
      pitfallId,
      outcome: 'accepted',
      // Provenance (ADR-46): which finding + target this confirmed, so the graph draws a real
      // finding→incident→pitfall edge. `target` undefined for a CLI verdict — fine, it's optional.
      findingId: input.findingId,
      target,
    });
  }

  if (target && brain) {
    const round = lastN || 1;
    try {
      await brain.writeVerdict(target, {
        findingId: input.findingId, kind: input.kind, scope: input.scope,
        title: input.title, file: input.file, line: input.line, ts: stored.ts,
      });
      // Project the disposition onto the brain Finding so it leaves `priorFindings` — else later fix
      // inference re-accepts it, double-counting its evidence. `projectableOutcome` returns null for an
      // unknown kind OR an empty findingId (a silent no-op MATCH that leaves it open to re-accept, #4).
      const projected = projectableOutcome(input.kind, input.findingId);
      if (projected) await brain.markFindingOutcome(input.findingId, projected);
    } finally {
      if (!sharedBrain) await brain.close();
    }
    await logAudit(repoPath, config, {
      type: 'outcome_recorded',
      repo: path.basename(path.resolve(repoPath)),
      target,
      round,
      ts: stored.ts,
      findingId: input.findingId,
      kind: input.kind,
      scope: input.scope,
    });
  }
  return stored;
}
