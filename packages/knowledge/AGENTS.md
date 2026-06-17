# @plex/knowledge — AGENTS.md

The knowledge base: a **JSON-backed Pitfall/Incident store** (ADR-18) plus the pure logic around
it — embedding-based retrieval and outcome-driven confidence consolidation. In the flow: **analysis** (`@plex/distill`) and `add_pitfalls` populate it (knowledge is
learned, never hand-authored markdown — ADR-37 retired plex.md seeding), **reviews** retrieve
from it (`get_review_context` → `retrieveRelevant`), and `record_outcome`/`consolidate_knowledge`
close the loop (an `accept` becomes an Incident; consolidation recomputes confidence from Incidents).
The engine wraps everything in `packages/engine/src/knowledge.ts`. Decision log:
[docs/adr/README.md](../../docs/adr/README.md) (ADR-08/10/18/21/37); math rationale:
[docs/design/tuning.md](../../docs/design/tuning.md) §1.

## Module map

| File | Responsibility |
| --- | --- |
| `src/store.ts` | `KnowledgeStore`: two JSONL append logs (`pitfalls.jsonl`, `incidents.jsonl`) under a dir (default `~/.plex/knowledge`, `config.knowledgeDir`) |
| `src/embeddings.ts` | `EmbeddingProvider` impls (voyage / openai / gemini / ollama / fake) + `createEmbeddingProvider` (returns `null` when unusable) |
| `src/retrieve.ts` | `retrieveRelevant` (hybrid cosine + lexical top-K) and `retrieveRelevantLexical` (no-embeddings path) — `rankAndSlim` applies the ADR-42 **recency tilt** AND the ADR-44 **confidence tilt** (`score *= max(tiltFloor, recencyWeight(…)) * max(tiltFloor, confidence ?? 1)`, undated/un-scored → 1) |
| `src/incidents.ts` | `recordIncident` — a confirmed finding → provenance `Incident` (learning loop, ADR-10) |
| `src/graph.ts` | `buildKnowledgeGraph` — assembles the flat records into an **in-memory graph** (ADR-47): one O(N) pass into adjacency maps + traversal helpers (`historyOf`/`concernsAt`/`concernsInFile`/`pitfallsOf`). The shared join the data is *graph-shaped but flat-stored* (ADR-18) — used by `consolidate`, `matchCodePath`, and the viz symbol↔incident bridge so none hand-roll it. **Reconciles the two-way Pitfall↔Incident link** (forward `incidentIds` ∪ reverse `incident.pitfallId`). |
| `src/reinforce.ts` | `addOrReinforcePitfall` — **semantic** write-time dedup for mined pitfalls: match a candidate to an existing in-scope pitfall (cosine ≥ `adaptiveFloor(0.7,…)`, exact-title then lexical fallback) → REINFORCE (union incidents, recompute confidence inline, bump `lastReinforcedAt`) instead of minting a duplicate. Replaced exact-title `hasPitfallTitled` on both `analyze` write paths |
| `src/promotion.ts` | `consolidatePitfalls(store, decay, now)` — **recency-decayed** Wilson confidence recompute from incident outcomes (all-abstain → keep prior, ADR-44) + sets `lastReinforcedAt` + **prunes** a decayed-stale pitfall (ADR-42; provenance Incidents survive) |
| `src/stats.ts` | Pure primitives: `wilsonLowerBound` + `confidenceFromOutcomes` (one Wilson confidence definition, ADR-44) + `suppressionTier` (Wilson at `Z_95`/`Z_68`); `recencyWeight` + `decayedCounts` (suppression recency-decay, ADR-41) |
| `src/index.ts` | Barrel. Types (`Pitfall`, `Incident`) live in `@plex/core` (`packages/core/src/types.ts`) |

## The algorithms

**Store (`store.ts`).** Flat JSONL, parsed **per line** — a corrupt/truncated line is skipped, never
discarding the whole store (a full-file `JSON.parse` would have let consolidation rewrite an *empty*
log: silent total loss). `replacePitfalls` (consolidation's writer) is **atomic**: write
`pitfalls.jsonl.tmp-<pid>`, then `rename` over the target. Write-time dedup is **semantic**
(`reinforce.ts` `addOrReinforcePitfall`): both `analyze` write paths match a candidate to an existing
in-scope pitfall by embedding cosine (exact-title + lexical fallbacks) and **reinforce** it rather
than mint a near-duplicate. The legacy `hasPitfallTitled` (exact-title equality) remains as the
strict-subset fallback inside that matcher.

**Retrieval (`retrieve.ts`).** `retrieveRelevant(store, provider, queryText, topK = 5, minScore = 0.05, repo?)`:

1. Filter to pitfalls in scope (ADR-21): `(p.scope ?? 'global') !== 'repo' || p.repo === repo` —
   i.e. `undefined` scope = global (back-compat); repo-scoped pitfalls surface only for their
   origin repo.
2. Embed the query once; `score = cosineSimilarity(q, p.embedding)`, then `rankAndSlim` applies **two
   bounded tilts** before the `minScore` cut: the ADR-42 recency tilt AND (ADR-44) a **confidence
   tilt** `× max(tiltFloor, confidence ?? 1)` — so among similarly-relevant pitfalls the better-evidenced
   one ranks higher, a missing confidence is neutral (1). The two tilts are independent axes that
   **compound** (each floored at `tiltFloor`), so a *stale-AND-weak* pitfall loses up to `tiltFloor²`
   (0.25) — intended; the floor bounds each axis not the product, so neither tilt zeroes a hit but a
   low-cosine stale weak pitfall CAN drop below `minScore`. Pitfalls stored WITHOUT a vector (e.g. analyzed key-less)
   are scored **lexically** in the same pass instead of being invisible; if the query embed
   throws (provider outage) the whole batch degrades to lexical rather than failing the review.
3. Keep `score >= minScore` (0.05), sort desc, slice `topK`, and **strip `embedding` from each
   result** (a voyage-code-3 vector is ~16KB serialized; topK of them would bloat every review context).

No provider configured → the engine wrapper (`getRelevantKnowledge`) uses
**`retrieveRelevantLexical`**: cosine over IDF-weighted token sets (`lexicalTokens`: camelCase
split, lowercase, ≥3-char tokens, stopworded; IDF over the pitfall corpus) on `title + trigger +
why + category`. Weaker ranking than embeddings, far better than nothing — a key-less install
still gets its accumulated pitfalls back. Same `topK`/`minScore` semantics.

**Consolidation (`promotion.ts` — the feedback loop's teeth, ADR-10).** `confidence =
wilsonLowerBound(confirms, confirms + refutes)` — the **Wilson score lower bound** of the confirm
rate (Wilson 1927; `stats.ts`). **One estimator, no hand-tuned constants** — this replaced the old
Beta posterior mean + `PRIOR_ALPHA/BETA` + `REJECT_COST = 1.5` + `outcomeWeight` 1.5s (all magic).
The claim flips with **polarity** (`confirmsAndRefutes`):
- **positive** pitfall ("real issue") — confirm = accept/fix/revert, refute = reject.
- **negative** pitfall ("suppress this", docs/design/negative-knowledge.md) — confirm = a dismissal
  (`reject`/`waive`, logged `rejected`), refute = the user acting on it (accept/fix/revert).

The lower bound is conservative by construction: a thin record stays low and tightens toward the raw
rate only as evidence accrues — an *honest floor*, not an over-confident point estimate, and a pure
function of the counts → **idempotent**. A pitfall with **zero linked incidents keeps its prior
confidence** — and so does one whose incidents **ALL abstain** (`confirms+refutes === 0`, ADR-44): no
informative evidence must keep the prior, not collapse to `wilsonLowerBound(0,0) = 0` (a confident-wrong
floor). Consolidation overwrites `incidentIds` (provenance backfill). `reverted` is now just a
confirm (its 1.5 bonus was magic). The **same Wilson estimator** sets a pitfall's *initial* confidence
at distill time via `confidenceFromOutcomes` (ADR-44) — one definition of confidence across
distill → `add_pitfalls` → consolidate. The **suppress/demote decision** is `suppressionTier(dismissals,
corrections)` — `wilsonLowerBound` at the 95% and 1σ levels vs the 0.5 majority pivot (≈4 consistent
dismissals → suppress; 1–3 → demote), so a lone "not now" can never bury a finding (C1). Note:
analysis's `outcomeFor` produces only `fixed` (observed) or abstains — never a `rejected`
(see [docs/design/outcome-signals.md](../../docs/design/outcome-signals.md)); refutes arrive from
review-driven incidents. A negative pitfall's stored `confidence` is **informational only** — `engine`'s `loadSuppressions` recomputes the tier live from raw counts and never reads it (so a dismissal takes effect without a `consolidate` run). **Decay (ADR-41):** `loadSuppressions` weights each dismissal by `recencyWeight = 0.5^(ageDays/halfLife)` (verb-specific — reject fades, waive persists; corrections durable) and feeds the decayed *fractional* counts into `suppressionTier` (Wilson takes plain numbers) — so an aged suppression slides back `suppress→demote→surface` on its own (the re-surface mechanism). A **first-principles** negative pitfall has no `suppressKey` — its identity is the title `embedding` (match-or-mint by cosine ≥ `0.82`); ranking matches it via synthetic semantic `pattern-repo` waivers.

The whole **promotion** surface (graph → `plex.md` lines *and* graph → ast-grep rule stubs) was
retired in ADR-37: the markdown half died with `plex.md`, and the rule half emitted
`pattern: TODO` scaffolds for an external runner that was never wired (a human had to author the
rule anyway). User-authored deterministic rules return — as committed `plex.json` config that
*defers* to the linter you already run — when `plex.json` lands (backlog). The `tier` field stays
on `Pitfall` (the analysis pipeline still sets it) but is now inert metadata: nothing reads it.

**Incidents (`incidents.ts`).** `recordIncident` builds collision-safe ids
`inc:<file-slug>:<hashId(snippet)>:<ts>` and is the learning loop's write path (an accepted finding
→ a provenance Incident; consolidation later recomputes pitfall confidence from these).

## Invariants & gotchas

- **Provenance is mandatory**: every Pitfall carries `incidentIds`; consolidation keeps them in sync.
  Don't add a write path that stores a pitfall without (at least an empty) provenance link.
- **Embeddings are optional, asymmetrically**: *reads* degrade to hybrid/lexical retrieval (see
  above); the **analysis** write paths still error via the engine's `requireEmbeddings`
  (`NO_EMBEDDINGS`) — clustering genuinely needs vectors. `fake` is the deterministic test-only
  embedder (FNV-1a bag-of-words, L2-normalized) and is **never** the default (`provider: 'none'` is).
- **Key resolution** (`createEmbeddingProvider`): env var (`cfg.apiKeyEnv` override or the provider
  default, e.g. `VOYAGE_API_KEY`) wins, else `cfg.apiKey` from `~/.plex/config.json` (ADR-29).
  Ollama needs no key; missing key for a paid provider → `null`, not an error.
- **Severity/confidence are separate axes** (ADR-04) — this package only ever touches confidence.
- The store is intentionally **not Kùzu** (ADR-18): small data, embedding retrieval, and it avoids
  compounding the tsx Kùzu open-limit (ADR-17). Graduate only if multi-hop queries appear.

## Testing

- **Units (vitest, colocated `*.test.ts`)** — `pnpm test:unit`. All pure/file-based: tmp-dir stores +
  `FakeEmbeddingProvider`, no network, no Kùzu. `store.test.ts` (corruption/atomicity),
  `retrieve.test.ts` (add→retrieve + ADR-21 scoping), `promotion.test.ts` (Beta math, idempotence,
  exact-line dedupe), `stats.test.ts`, `embeddings.test.ts` (provider/key resolution).
- **Integration**: the `knowledge` scenario in `packages/engine/integration.mts`
  (`pnpm test:integration`) exercises the full stored-pitfall → review-retrieves → learn-on-accept loop
  through the engine.
