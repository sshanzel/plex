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
 * Retrieve relevant pitfalls (ADR-01 grounded retrieval), scoped to `repo` (ADR-21).
 * Degrades gracefully: with no embedding provider configured, falls back to lexical
 * (IDF-weighted token overlap) retrieval — weaker ranking, but a key-less install still
 * gets its accumulated pitfalls back instead of nothing.
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

// Floors for retroactively linking an accepted finding to a pitfall. Conservative on purpose:
// a wrong link feeds one pitfall's confidence with another issue's evidence, which is worse
// than learning nothing. The embed floor adapts UPWARD on anisotropic models (tuning.md §6);
// lexical scores run lower than cosine, hence the lower bar.
const INFER_EMBED_FLOOR = 0.7;
const INFER_LEXICAL_FLOOR = 0.45;

/**
 * Best-effort: find the pitfall an accepted finding instantiates, so the accept reinforces it
 * (ADR-10). Most agent findings are first-principles and carry no pitfallId — without this, an
 * explicit "this is a real issue" verdict taught the knowledge base nothing. Embedding cosine
 * where vectors exist; lexical IDF overlap for vectorless pitfalls (and key-less installs).
 * Returns undefined on any failure — inference is enrichment, never a verdict blocker.
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
    // Lexical pass over what the semantic pass could NOT judge (vectorless pitfalls; everything
    // when no provider) — never second-guess a semantic "not similar" with a keyword match.
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
 * The stable identity a dismissal suppresses against (docs/design/negative-knowledge.md): a
 * deterministic rule tag (parsed from the `det:<rule>:<file>:<line>` finding id) or an explicit
 * `pattern`. Returns undefined when there's no stable key — we never learn a repo-wide suppression
 * from a one-off, untagged first-principles finding (its identity is just a line of code).
 */
export function suppressionKeyFor(input: { findingId?: string; pattern?: string }): string | undefined {
  const m = input.findingId?.match(/^det:([^:]+):/);
  if (m) return m[1];
  return input.pattern || undefined;
}

// Extension → coarse language tag, so global promotion can stay language-AWARE (C2): a TS rule must
// never apply to a Python repo. Undefined = unknown/agnostic.
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
}

/**
 * Generalize a per-repo suppression to all repos of its language once the SAME rule has independently
 * earned `suppress` in at least this many distinct repos (C2). A POLICY floor, not a statistical one
 * (Wilson governs whether a single repo suppresses; "how many independent projects before we
 * generalize" is a risk choice) — kept small but ≥2 so one repo can never self-promote.
 */
const PROMOTE_MIN_REPOS = 2;

/**
 * Read the learned suppression decisions effective for a repo (docs/design/negative-knowledge.md).
 * Computed LIVE from the negative pitfalls' incident counts via Wilson `suppressionTier`, so it's
 * fresh on every review WITHOUT waiting for `consolidate` (a dismissal takes effect next review).
 *
 * Two sources, deduped by key (stronger tier wins):
 *  1. This repo's OWN negative pitfalls.
 *  2. **Cross-repo, language-gated promotion (C2):** a key that earned `suppress` in ≥
 *     `PROMOTE_MIN_REPOS` distinct repos OF THE SAME LANGUAGE generalizes. Grouping by language means
 *     a TS rule never merges with a Python one, and — because a deterministic rule tag is itself
 *     language-bound — a promoted `global@ts` decision can only ever match TS findings. There is NO
 *     language-agnostic auto-promotion (that stays certified-only).
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
  // half-life (reject fades fast, waive persists); corrections are durable. The decayed (fractional)
  // counts feed `suppressionTier` unchanged — so a suppression ages back to demote/surface on its own.
  const countsOf = (p: Pitfall): { dismissals: number; corrections: number } => {
    const inc = byPitfall.get(p.id) ?? [];
    // ONE dismissal vote per FILE (drift-stability), taking the STRONGEST verb recorded for that file:
    // a `waive` escalation over a prior `reject` (ADR-41) upgrades to the persistent half-life rather
    // than double-counting. Belt-and-suspenders: this enforces the one-vote-per-file invariant on the
    // read side too, so even a stray duplicate dismissal can't inflate the Wilson bar.
    const byFile = new Map<string, Incident[]>();
    for (const i of inc) {
      if (i.outcome !== 'rejected') continue;
      const f = i.file ?? '';
      (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(i);
    }
    const dismissals: Dismissal[] = [];
    for (const group of byFile.values()) {
      const chosen = group.find((i) => (i.verb ?? 'reject') === 'waive') ?? group[0]!; // strongest verb wins
      const t = Date.parse(chosen.ts);
      const ageDays = Number.isNaN(t) ? 0 : (nowMs - t) / 86_400_000; // unparseable ts → full weight
      dismissals.push({ verb: chosen.verb ?? 'reject', ageDays }); // verb authoritative; default reject (conservative)
    }
    const corrections = inc.filter((i) => i.outcome === 'accepted' || i.outcome === 'fixed' || i.outcome === 'reverted').length;
    return decayedCounts(dismissals, corrections, hl);
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
      // First-principles (embedding-keyed) negatives use the pitfall id as `key` and carry the
      // `embedding` so ranking matches findings SEMANTICALLY rather than by tag (ADR-41).
      consider(
        p.suppressKey
          ? { key: p.suppressKey, tier, dismissals, corrections, pitfallId: p.id }
          : { key: p.id, tier, dismissals, corrections, pitfallId: p.id, embedding: p.embedding },
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
      consider({ key: k, tier: 'suppress', dismissals, corrections, pitfallId: `global@${group[0]!.language ?? ''}:${k}` });
    }
  }

  return [...best.values()];
}

/**
 * Negative-knowledge producer (docs/design/negative-knowledge.md): a dismissal/correction of a
 * finding with a stable suppression key feeds the SAME incident → consolidate loop as positive
 * pitfalls. A `reject`/`waive` records a CONFIRMING incident on a repo-scoped negative pitfall; an
 * `accept`/fix records a REFUTING one (the user acted on it after all). Consolidation later turns the
 * accumulated counts into a Wilson-derived `suppressionTier` — WEIGHTED, never a one-click kill (C1).
 * `firstOfKind` (computed from the verdict log before the new verdict is appended) dedups an
 * agent/responder retry so the same disposition of the same finding can't double-count.
 */
export async function learnSuppression(
  config: ReviewerConfig,
  repoName: string,
  input: { kind: VerdictInput['kind']; findingId?: string; pattern?: string; file?: string; title?: string; note?: string },
  firstOfKind: boolean,
): Promise<void> {
  if (!firstOfKind) return;
  const dismissal = input.kind === 'reject' || input.kind === 'waive';
  const corrective = input.kind === 'accept';
  if (!dismissal && !corrective) return;

  const store = knowledgeStore(config);
  const key = suppressionKeyFor(input);

  // Resolve the negative pitfall this incident attaches to. Two identities:
  //  - DETERMINISTIC: a stable `suppressKey` (rule tag / explicit pattern) → keyed pitfall.
  //  - FIRST-PRINCIPLES (no key, ADR-41): the finding's TITLE EMBEDDING. Match-or-mint against
  //    existing embedding-keyed negatives by cosine (conservative ~0.82 — a wrong merge pollutes
  //    another suppression's evidence). Embedding-gated: no provider/title → no learning (degrade to
  //    deterministic-only). Both paths then share the dedup + incident record below.
  // The dismisser's reasoning ("console is intentional here — it's the CLI logger"), if supplied on
  // the verdict. Captured as readable provenance (the `why` + the incident note) — not just folded
  // into the re-match embedding — so a suppression explains ITSELF instead of a boilerplate template.
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

  // Drift-stable dedup (ADR-39): count at most ONE dismissal (and one correction) per (pitfall, file)
  // — a line-rekeyed deterministic finding, or a reworded first-principles one that still matched the
  // same negative, must not double-count toward the Wilson bar. `firstOfKind` covers same-line retries.
  // VERB UPGRADE (ADR-41): a dismissal isn't a flat dup — a `waive` ("this is wrong") is STRONGER than
  // a `reject` ("not now"). So a `waive` recorded over only prior `reject`(s) is allowed through (it
  // escalates the half-life from 30d to 365d); the read side (`countsOf`) then collapses the pair back
  // to one vote with the strongest verb. A `reject` after any dismissal, or a `waive` after a `waive`,
  // carries no new information and is still dropped — so the upgrade is strictly monotone (never downgrades).
  if (existing) {
    const incs = await store.incidents();
    if (dismissal) {
      const prior = incs.filter((i) => i.pitfallId === id && i.file === input.file && i.outcome === 'rejected');
      const blocked = input.kind === 'waive' ? prior.some((i) => (i.verb ?? 'reject') === 'waive') : prior.length > 0;
      if (blocked) return;
    } else if (incs.some((i) => i.pitfallId === id && i.file === input.file && (i.outcome === 'accepted' || i.outcome === 'fixed' || i.outcome === 'reverted'))) {
      return;
    }
  }
  if (toMint) await store.addPitfall(toMint);
  await learnIncident(config, {
    repo: repoName,
    file: input.file,
    snippet: key ?? id,
    pitfallId: id,
    outcome: dismissal ? 'rejected' : 'accepted',
    // The verb sets the recency-decay half-life (ADR-41): reject fades, waive persists. Authoritative
    // (outcome:'rejected' flattens the two); only dismissals carry it.
    verb: dismissal ? (input.kind === 'waive' ? 'waive' : 'reject') : undefined,
    note: `${input.kind}${input.findingId ? ` ${input.findingId}` : ''}${reason ? ` — ${reason}` : ''}`,
  });
}

/** First-principles match (ADR-41): the embedding-keyed negative pitfall most similar to `vec`,
 * if cosine clears `adaptiveFloor(0.82, …)` — conservative, biased toward minting a fresh suppression
 * over polluting an existing one's evidence (mirrors `inferPitfallId`). undefined if none. */
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
 * Record a verdict and close the feedback loop: an `accept` becomes a knowledge incident
 * (the reviewer learns from confirmed findings — ADR-10), and the verdict is projected
 * into the PR brain + audit log (ADR-22/24). `target` (from the caller's diff source)
 * keys which PR graph the verdict lands in. Used by both MCP and CLI.
 */
export async function submitVerdict(
  repoPath: string,
  input: VerdictInput,
  config: ReviewerConfig,
  target?: string,
  sharedBrain?: Brain,
): Promise<StoredVerdict> {
  // For waivers AND acknowledgments, embed the finding's title so it can be re-matched
  // semantically next round (ADR-27/31) — best-effort: only when a real provider is configured.
  let enriched = input;
  if ((input.kind === 'waive' || input.kind === 'acknowledge') && input.embedding == null) {
    const text = [input.title, input.note].filter(Boolean).join(' — ').trim();
    if (text) {
      const provider = createEmbeddingProvider(config.embedding);
      if (provider) {
        // safeEmbed: a transient embedding failure stores the waiver WITHOUT a vector (it still
        // suppresses by identity; only semantic re-matching is lost) rather than failing the verdict.
        const vecs = await safeEmbed(provider, [text]);
        if (vecs?.[0]) enriched = { ...input, embedding: vecs[0] };
      }
    }
  }
  // Learning-side idempotency: a re-disposition of the same finding with the same verdict (an agent
  // retry, or reconcile re-matching a finding someone record_outcome'd by hand) must NOT create a
  // second incident — duplicated evidence skews the Wilson confidence. Checked BEFORE the append
  // below so the new verdict can't match itself; the verdict line itself is still recorded (the log
  // is append-only bookkeeping). A finding with no id can't be deduped, so it always counts.
  const repoName = path.basename(path.resolve(repoPath));
  const firstOfKind =
    input.findingId == null ||
    !(await readVerdicts(repoPath, config)).some((v) => v.kind === input.kind && v.findingId === input.findingId);
  const alreadyAccepted = input.kind === 'accept' && !firstOfKind;
  const stored = await recordVerdict(repoPath, enriched, config);
  // Negative-knowledge producer: a reject/waive confirms a repo-scoped suppression, an accept refutes
  // it — the same incident→consolidate loop as positives (docs/design/negative-knowledge.md, C1).
  await learnSuppression(config, repoName, input, firstOfKind);
  // Resolve the code-path anchor (line + `file#name` symbol key) for an accept incident from the brain
  // finding — the finding carried them when written (code-path memory); an accept inherits them so the
  // incident knows WHICH symbol the concern was at, for the next review's location match. Open the
  // brain once here (best-effort) and reuse it for the verdict projection below. No target (a CLI
  // verdict) → file+line only.
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
      /* best-effort: a brain read fault degrades the accept incident to file+line, round to 1 */
    }
  }

  if (input.kind === 'accept' && !alreadyAccepted) {
    // Link the accept to the pitfall it confirms: explicit `pattern` wins, else infer by
    // similarity — so first-principles accepts (the common case) reinforce knowledge too.
    // EXCEPT for inferred (auto) accepts: a locality fix-match feeding a title-similarity
    // pitfall match would stack two inferences into the Beta posterior — a false locality
    // accept silently inflating a pitfall is worse than learning nothing. Inferred accepts
    // still record their incident (provenance), but only an explicit `pattern` links them.
    // An INFERRED accept never links a positive pitfall (avoids stacking two inferences into the
    // posterior) — even when `pattern` is set, because reconcile now passes `pattern` as the rule tag
    // purely to REFUTE a negative suppression (handled by `learnSuppression` above), not to link a
    // positive one. An explicit accept still links by `pattern`, else infers by similarity.
    const pitfallId = input.inferred ? undefined : (input.pattern ?? (await inferPitfallId(config, input.title, repoName)));
    await learnIncident(config, {
      repo: repoName,
      file: input.file,
      // Code-path anchor (code-path memory): the `file#name` symbol key + line this concern lives at,
      // inherited from the brain finding so a later review can match it to the symbols a diff touches.
      // Anchored for INFERRED (locality) accepts too — by design: the symbol comes from the FINDING
      // (which was about that symbol), not the fuzzy locality match, so it's accurate provenance; and an
      // inferred accept stays unlinked from any positive pitfall (pitfallId undefined above), so its
      // incident never feeds a `codePathAlert` (matchCodePath only traverses pitfall-linked incidents) —
      // it only enriches the viz "concern history at this symbol".
      line: acceptLine,
      symbol: acceptSymbol,
      snippet: input.title,
      pitfallId,
      outcome: 'accepted',
      // Provenance (ADR-46 increment 1): record which finding + review target this confirmed, so the
      // knowledge graph draws a real finding→incident→pitfall edge. `target` is undefined for a
      // CLI/no-target verdict — fine, it's optional.
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
      // Project the disposition onto the brain Finding so it leaves `priorFindings`: an
      // explicitly dispositioned finding must not be re-matched by later fix inference
      // (reconcile / the next review), which would re-accept it and learn the same evidence
      // twice. recordFixAccepts overwrites accept→'fixed' right after — same family, finer term.
      // `projectableOutcome` returns null for an unknown kind OR an empty findingId — the latter would
      // make `markFindingOutcome` a silent no-op MATCH, leaving the finding open to re-accept (#4).
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
