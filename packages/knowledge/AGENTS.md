# @plex/knowledge — AGENTS.md

The knowledge base: a **JSON-backed Pitfall/Incident store** (ADR-18) plus the pure logic around
it — embedding-based retrieval, markdown seeding, outcome-driven confidence consolidation, and
promotion proposals. In the flow: **mining** (`@plex/mining`) and `add_pitfalls` populate it,
**reviews** retrieve from it (`get_review_context` → `retrieveRelevant`), and
`record_outcome`/`consolidate_knowledge` close the loop (an `accept` becomes an Incident; consolidation
recomputes confidence from Incidents). The engine wraps everything in
`packages/engine/src/knowledge.ts`. Decision log: [docs/adr/README.md](../../docs/adr/README.md)
(ADR-08/09/10/18/21); math rationale: [docs/design/tuning.md](../../docs/design/tuning.md) §1.

## Module map

| File | Responsibility |
| --- | --- |
| `src/store.ts` | `KnowledgeStore`: two JSONL append logs (`pitfalls.jsonl`, `incidents.jsonl`) under a dir (default `~/.plex/knowledge`, `config.knowledgeDir`) |
| `src/embeddings.ts` | `EmbeddingProvider` impls (voyage / openai / gemini / ollama / fake) + `createEmbeddingProvider` (returns `null` when unusable) |
| `src/retrieve.ts` | `retrieveRelevant` (hybrid cosine + lexical top-K) and `retrieveRelevantLexical` (no-embeddings path) |
| `src/seed.ts` | `parseMarkdownPitfalls` + `seedFromMarkdown` (plex.md cold start, ADR-09); `recordIncident` |
| `src/promotion.ts` | `consolidatePitfalls` (Beta-Bernoulli confidence) + `proposePromotions` (graph→markdown, graph→ast-grep stubs) |
| `src/stats.ts` | Pure primitives: `betaPosteriorMean`, `wilsonLowerBound` |
| `src/index.ts` | Barrel. Types (`Pitfall`, `Incident`) live in `@plex/core` (`packages/core/src/types.ts`) |

## The algorithms

**Store (`store.ts`).** Flat JSONL, parsed **per line** — a corrupt/truncated line is skipped, never
discarding the whole store (a full-file `JSON.parse` would have let consolidation rewrite an *empty*
log: silent total loss). `replacePitfalls` (consolidation's writer) is **atomic**: write
`pitfalls.jsonl.tmp-<pid>`, then `rename` over the target. Dedupe primitive: `hasPitfallTitled` —
**exact title equality**; every write path (seed, mined, `add_pitfalls`) dedupes through it.

**Retrieval (`retrieve.ts`).** `retrieveRelevant(store, provider, queryText, topK = 5, minScore = 0.05, repo?)`:

1. Filter to pitfalls in scope (ADR-21): `(p.scope ?? 'global') !== 'repo' || p.repo === repo` —
   i.e. `undefined` scope = global (back-compat); repo-scoped pitfalls surface only for their
   origin repo.
2. Embed the query once; `score = cosineSimilarity(q, p.embedding)` — **pure cosine; stored
   `confidence` does not weight the score**. Pitfalls stored WITHOUT a vector (seeded key-less)
   are scored **lexically** in the same pass instead of being invisible; if the query embed
   throws (provider outage) the whole batch degrades to lexical rather than failing the review.
3. Keep `score >= minScore` (0.05), sort desc, slice `topK`, and **strip `embedding` from each
   result** (a voyage-code-3 vector is ~16KB serialized; topK of them would bloat every review context).

No provider configured → the engine wrapper (`getRelevantKnowledge`) uses
**`retrieveRelevantLexical`**: cosine over IDF-weighted token sets (`lexicalTokens`: camelCase
split, lowercase, ≥3-char tokens, stopworded; IDF over the pitfall corpus) on `title + trigger +
why + category`. Weaker ranking than embeddings, far better than nothing — a key-less install
still gets its plex.md guidance and accumulated pitfalls back. Same `topK`/`minScore` semantics.

**Consolidation (`promotion.ts` — the feedback loop's teeth, ADR-10).** Beta-Bernoulli posterior
mean with constants `PRIOR_ALPHA = 1`, `PRIOR_BETA = 1`, `REJECT_COST = 1.5`. For each pitfall,
over its linked incidents (`incident.pitfallId === pitfall.id`): `s` = **outcome-weighted**
positive evidence `Σ outcomeWeight(outcome)` (`@plex/core`, ADR-11: accepted/fixed = 1,
reverted = **1.5** — the warned-against change shipped and was later reverted, the strongest
confirmation), `f` = `rejected` count, and

```
confidence = betaPosteriorMean(1 + s, 1 + 1.5·f)  =  (1 + s) / (2 + s + 1.5·f)
```

A pitfall with **zero linked incidents keeps its mined/seeded prior confidence**. The formula is a
pure function of the counts → **idempotent** (re-running never drifts, unlike the old additive
`+0.1/−0.15` rule). Consolidation also overwrites `incidentIds` with the linked incidents' ids
(provenance backfill). Note: mining's coarse `outcomeFor` never *produces* `fixed`/`reverted`
(see [docs/design/outcome-signals.md](../../docs/design/outcome-signals.md)) — those arrive from
review-driven incidents. Known gap: `wilsonLowerBound` (`stats.ts`, `z = 1.96`) is exported "for
small-sample ranking" (tuning.md §1) but currently has **no consumer** outside its own tests.

**Promotions (`promotion.ts`, ADR-09).** `proposePromotions(store, existingMarkdown = '', threshold = 0.7)`:
`confidence >= 0.7` and not already documented → suggest `- <title>` for plex.md; `tier ===
'codifiable'` (regardless of confidence) → an ast-grep stub with `pattern: TODO` (a human fills the
pattern). "Already documented" = the title appears as its **own trimmed line** (bare or `- ` prefixed)
in the existing markdown — an earlier substring match wrongly suppressed titles embedded in unrelated lines.

**Seeding (`seed.ts`).** `##` headings set the (slugified) category; `-`/`*` bullets longer than 3
chars become pitfalls. Seeded pitfalls get `confidence: 0.4`, `tier: 'judgmental'`,
`scope: 'global'`, `incidentIds: []`, embedding of `` `${category}: ${title}` `` (or none when
seeding key-less — the lexical path keeps them retrievable), id
`pf:<slug>-<hashId(title)>`. `recordIncident` builds collision-safe ids:
`inc:<file-slug>:<hashId(snippet)>:<ts>`.

## Invariants & gotchas

- **Provenance is mandatory**: every Pitfall carries `incidentIds`; consolidation keeps them in sync.
  Don't add a write path that stores a pitfall without (at least an empty) provenance link.
- **Embeddings are optional, asymmetrically**: *reads* degrade to hybrid/lexical retrieval (see
  above); **seeding** works key-less (vectorless pitfalls stay lexically searchable); the
  **mining** write paths still error via the engine's `requireEmbeddings` (`NO_EMBEDDINGS`) —
  clustering genuinely needs vectors. `fake` is the deterministic test-only embedder (FNV-1a
  bag-of-words, L2-normalized) and is **never** the default (`provider: 'none'` is).
- **Key resolution** (`createEmbeddingProvider`): env var (`cfg.apiKeyEnv` override or the provider
  default, e.g. `VOYAGE_API_KEY`) wins, else `cfg.apiKey` from `~/.plex/config.json` (ADR-29).
  Ollama needs no key; missing key for a paid provider → `null`, not an error.
- **Severity/confidence are separate axes** (ADR-04) — this package only ever touches confidence.
- The store is intentionally **not Kùzu** (ADR-18): small data, embedding retrieval, and it avoids
  compounding the tsx Kùzu open-limit (ADR-17). Graduate only if multi-hop queries appear.

## Testing

- **Units (vitest, colocated `*.test.ts`)** — `pnpm test:unit`. All pure/file-based: tmp-dir stores +
  `FakeEmbeddingProvider`, no network, no Kùzu. `store.test.ts` (corruption/atomicity),
  `retrieve.test.ts` (seed→retrieve + ADR-21 scoping), `promotion.test.ts` (Beta math, idempotence,
  exact-line dedupe), `stats.test.ts`, `embeddings.test.ts` (provider/key resolution).
- **Integration**: the `knowledge` scenario in `packages/engine/integration.mts`
  (`pnpm test:integration`) exercises the full seed → review-retrieves → learn-on-accept loop
  through the engine.
