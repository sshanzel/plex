# Evals — how Plex knows it isn't degrading

Four layers, from cheapest/most-deterministic to most-faithful. Each answers a different
question; none substitutes for another.

| Layer | Question | Runs | Where |
|---|---|---|---|
| 1. Correctness tests | "does the machinery behave as specified?" | every `pnpm test` | 300+ vitest units, 18 tsx integration scenarios, 3 node E2Es |
| 2. **Quality floors** | "did a tweak quietly degrade ranking/retrieval quality?" | every `pnpm test` | `ranking-quality.test.ts`, `retrieval-quality.test.ts` |
| 3. Live measurement | "does the ranking match THIS repo's real outcomes?" | on demand | `plex eval` (nDCG over the brain) + `READINESS` gates |
| 4. LLM-in-the-loop | "does the full reviewer actually catch bugs?" | per release / big change | the planted-bug protocol + dogfood reviews |

## Layer 1 — correctness (already there)

The unit/integration suite pins *behavior*: formulas compute what the docs say, waiver
scopes match what they should, reconcile accepts what it should. Several integration
scenarios are really micro-benchmarks pinning *properties* (`blast-hub`: a hub's importers
rank below a direct coupling; `cochange-hub`: promiscuous co-change is damped;
`cochange-weak`/`test:cochange`: denoising vs cross-window accumulation). Behavior tests
can all pass while overall quality regresses — that's what layer 2 exists for.

## Layer 2 — fixed quality floors (the regression gate)

Small, labeled, frozen corpora run through the REAL pipeline; an aggregate quality score
must clear a floor. Deterministic, no network, no LLM — they run in `pnpm test:unit` and
fail CI on structural regressions that behavior tests can't see.

- **Ranking** (`packages/findings/src/ranking-quality.test.ts`): ~13 findings with
  ground-truth verdicts (accepted/fixed vs rejected vs acknowledged) ranked by
  `rankFindings`; `rankingNdcg` must be ≥ **0.9** (measured 0.968 when frozen). Plus
  property floors: every real surface finding outranks every rejected one; a common bug
  escalates (never silenced); prevalent style demotes.
- **Retrieval** (`packages/knowledge/src/retrieval-quality.test.ts`): a 12-pitfall corpus.
  The **lexical** path (what key-less installs get) must reach recall@3 ≥ **7/8** on
  *paraphrased* queries shaped like `buildKnowledgeQuery` output. The **hybrid** path is
  benched on word-overlap queries only — `FakeEmbeddingProvider` is bag-of-words, so this
  floor guards the retrieval *plumbing* (scoring, topK, scope, vectorless fallback), not
  real-model semantics (that's layers 3/4).

**Floor policy:** floors sit ~0.05–0.1 below the measured value at freeze time — they
absorb small intentional re-weights and catch structural breakage. If a change *improves*
a score, ratchet the floor up in the same commit. If a change trips a floor, that is a
finding about the change, not about the floor — don't lower a floor to make CI pass
without writing down why the trade is right.

**Corpus policy:** corpora are frozen test data. Extending them (new categories, harder
cases) is encouraged; *relabeling* existing entries to make a score pass is not.

## Layer 3 — live measurement (your repo, your outcomes)

`plex eval` (`rankingQuality`, `engine/src/ranking-eval.ts`) computes nDCG of the ranking
signal against the *actual recorded outcomes* in the repo's brain — the ground truth that
accumulates from `record_outcome`/reconcile. `READINESS` (`findings/src/eval.ts`) gates
any re-weighting of the ranking formula behind sample-size thresholds (≥25 evaluable
rounds, ≥50 positives, ≥10 negatives, headroom below nDCG 0.85) so nobody tunes on noise.
This is the only layer that measures *real* embedding models and *real* review history.

## Layer 4 — LLM-in-the-loop (the planted-bug protocol)

The only layer that answers "does the reviewer catch bugs?" — costs tokens, mildly
non-deterministic, so it's a per-release ritual, not CI:

1. **Plant**: branch off a real repo; introduce N defects across categories (logic bug,
   race, swallowed error, security, off-by-one, a cross-file breakage reachable only via
   the blast radius) and M innocuous changes (false-positive bait: intentional sequential
   awaits, deliberate `== null`, a justified `any`). Keep a private answer key.
2. **Review**: run the `plex-reviewer` agent on the branch (or open a PR and review with
   `source: 'pr'`). Do not hint at the answer key.
3. **Score**: recall = planted defects found / N (count a hit when file+root cause match);
   precision = findings that are real / total submitted; bait-resistance = bait items NOT
   flagged as defects (a `note` on bait counts as resistant). Record the three
   numbers + date + model in the PR or a `docs/design/eval-runs.md` log so drift is visible
   release over release.
4. **Dogfooding counts**: every Plex-on-Plex review of a real PR is an uncontrolled run of
   this layer — when it misses something a human later catches, that miss is a candidate
   for a new layer-2 corpus entry or a deterministic rule.

## What is deliberately NOT here

- A public benchmark suite (SWE-bench-style): the reviewer's quality is dominated by the
  connected agent's model, which Plex doesn't control. Plex's own value-add — grounding,
  ranking, retrieval, learning — is exactly what layers 2/3 isolate.
- Token/latency budgets: worth adding to layer 2 later (e.g. context size per review), but
  only once there's a baseline worth defending.
