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
| `src/retrieve.ts` | `retrieveRelevant` (hybrid cosine + lexical top-K) and `retrieveRelevantLexical` (no-embeddings path) |
| `src/incidents.ts` | `recordIncident` — a confirmed finding → provenance `Incident` (learning loop, ADR-10) |
| `src/promotion.ts` | `consolidatePitfalls` — Beta-Bernoulli confidence recompute from incident outcomes |
| `src/stats.ts` | Pure primitives: `betaPosteriorMean`, `wilsonLowerBound` |
| `src/index.ts` | Barrel. Types (`Pitfall`, `Incident`) live in `@plex/core` (`packages/core/src/types.ts`) |

## The algorithms

**Store (`store.ts`).** Flat JSONL, parsed **per line** — a corrupt/truncated line is skipped, never
discarding the whole store (a full-file `JSON.parse` would have let consolidation rewrite an *empty*
log: silent total loss). `replacePitfalls` (consolidation's writer) is **atomic**: write
`pitfalls.jsonl.tmp-<pid>`, then `rename` over the target. Dedupe primitive: `hasPitfallTitled` —
**exact title equality**; every write path (analyzed, `add_pitfalls`) dedupes through it.

**Retrieval (`retrieve.ts`).** `retrieveRelevant(store, provider, queryText, topK = 5, minScore = 0.05, repo?)`:

1. Filter to pitfalls in scope (ADR-21): `(p.scope ?? 'global') !== 'repo' || p.repo === repo` —
   i.e. `undefined` scope = global (back-compat); repo-scoped pitfalls surface only for their
   origin repo.
2. Embed the query once; `score = cosineSimilarity(q, p.embedding)` — **pure cosine; stored
   `confidence` does not weight the score**. Pitfalls stored WITHOUT a vector (e.g. analyzed key-less)
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
confidence**; consolidation overwrites `incidentIds` (provenance backfill). `reverted` is now just a
confirm (its 1.5 bonus was magic). The **suppress/demote decision** is `suppressionTier(dismissals,
corrections)` — `wilsonLowerBound` at the 95% and 1σ levels vs the 0.5 majority pivot (≈4 consistent
dismissals → suppress; 1–3 → demote), so a lone "not now" can never bury a finding (C1). Note:
analysis's coarse `outcomeFor` never *produces* `fixed`/`reverted`
(see [docs/design/outcome-signals.md](../../docs/design/outcome-signals.md)) — those arrive from
review-driven incidents. `betaPosteriorMean` stays exported (tested) but is now unused by consolidation.

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
