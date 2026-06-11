# @plex/findings

The **pure scoring core** of the review pipeline: merge / dedup / rank / triage of findings, waiver
matching (scoped + semantic), the round-delta classifiers used by reconcile, the coupling-cluster
plan (metadata for angle-based sub-agent orchestration), and the ranking-quality measuring stick. **No I/O, no Kùzu, no embedding calls** — every
function takes plain data (embeddings are computed at the boundary by `packages/engine`) and is
unit-tested with literal values. Depends only on `@plex/core`.

Where it sits: `submit_findings` → `engine/src/findings.ts#rankReviewFindings` builds agent
`Finding[]`, appends deterministic findings (`@plex/deterministic`), loads waivers, embeds
best-effort → calls **`rankFindings`** here → one ranked, triaged stream (persisted to the brain,
optionally posted to the PR). `reconcile_outcomes` / the next review call **`findingAddressedAt`**
via `engine/src/reconcile.ts`. Decision log: [`docs/adr/README.md`](../../docs/adr/README.md)
(ADR-03/04/05/10/23/27/28/31).

## Module map

| File | Responsibility |
|---|---|
| `src/dedupe.ts` | Cross-source merge: `dedupeKey` identity, noisy-OR confidence, `agreedSources` |
| `src/signal.ts` | `computeSignal` — the ranking formula and `defaultWeights` |
| `src/rank.ts` | `rankFindings` — dedupe → signal → waivers → triage → sorted stream |
| `src/waivers.ts` | `waiverMatches`/`isWaived` — scope matching + semantic match (ADR-27) |
| `src/rounds.ts` | `classifyChanges` (feedback-driven vs unexplained, ADR-23); `findingAddressed[At]` / `findingAddressMatch` (ADR-28 fix matching for reconcile/auto-accept, with the matched-signal audit trail) |
| `src/review-plan.ts` | `partitionByCoupling` (union-find) + `reviewPlan` — coupling-cluster partition + surface score (metadata for angle-based orchestration) |
| `src/eval.ts` | nDCG ranking quality vs outcome labels + `READINESS`/`rankingReadiness` re-weight gates |
| `src/index.ts` | Barrel |

## The algorithm

**Dedup (ADR-03, `dedupe.ts`).** Identity is `dedupeKey = file:startLine:normalizeTitle(title)`
(`normalizeTitle`: lowercase, strip non-`[a-z0-9 ]`, collapse whitespace). On a key collision the
merged finding takes the **highest severity** (`SEVERITY_RANK`: bug 3 > improvement 2 > nit 1 >
awareness 0), **noisy-OR confidence** `1 − (1−a)(1−b)` (independent sources agreeing raise it),
**max blastRadius**, first prevalence/pitfallId, concatenated evidence, and records each
`agreedSources` entry — corroboration feeds the ranking.

**Signal (ADR-04/05, `signal.ts`).** `signal = base × blast × deviation × agreement`:

- `base = severityWeight × clamp01(confidence)` — `defaultWeights` are bug **1**, improvement
  **0.5**, nit **0.2**; `awareness` is hardcoded **0.3** (it ranks only within its own triage bucket).
- `blast = 0.5 + 0.5·clamp01(blastRadius ?? 0)` — a no-blast finding is *dampened, not zeroed*.
- `deviation = 1` for bugs, else `1 − 0.8·clamp01(prevalence)` — prevalence demotes
  style/nits/improvements, **never bugs** (a common bug is systemic; handled by triage, ADR-05).
- `agreement = 1 + 0.15·(agreedSourceCount − 1)`.

Severity and confidence are **separate axes** (ADR-04) — they multiply; never collapse "potential
bug" into a lower severity.

**Prevalence** (`Finding.prevalence`, 0..1 "how common in the repo") is *supplied*, not computed
here — the agent passes it on `submit_findings` for its own findings, and `@plex/deterministic`
stamps a **measured** per-rule prevalence on codified findings. It's read twice, **by severity** (ADR-05):
continuously in `deviation` (non-bugs only) and discretely in triage at
`prevalenceThreshold` (default **0.5**, `rank.ts`): common + `bug` → **`systemic-migration`**
(escalated), common + non-bug → **`convention`** (demoted). Suppression must never silence
widespread real bugs.

**Triage + ordering (`rank.ts`).** waived/acknowledged → `suppressed`; severity `awareness` →
`awareness` (its own bucket — surfaced, never a nit, ADR-31); prevalent → as above; else
`surface`. Sort by `TRIAGE_PRIORITY` (surface 0, systemic-migration 1, awareness 2, convention 3,
suppressed 4), then signal descending. `rankFindings` also **strips the transient `embedding`**
from the returned stream — it exists only so `isWaived` can match semantically; shipping a
1024-float vector per finding floods the agent's context.

**Waivers (ADR-10/27, `waivers.ts`).** Scope matching:
- `line`: same `file` AND `line === startLine`. `file`: same `file`.
- `pattern-repo`: semantic match, OR `pattern === pitfallId` / `pattern ∈ tags`, OR
  `normalizeTitle(w.title) === normalizeTitle(f.title)`.
- `category-repo` / `category-global`: semantic match, OR `category ∈ tags`.

*Semantic* = both waiver and finding carry an `embedding` and `cosine ≥ semanticThreshold` —
suppresses the same issue after wording/line drift. The default threshold is **1.01**, i.e.
**semantic matching is OFF unless the caller passes a threshold**; without an embedding provider
findings have no embeddings, so only identity matching (line/file/pattern/category fields) applies
— waivers still work, just literally. The engine passes
`adaptiveFloor(WAIVER_SEMANTIC_THRESHOLD = 0.82, cosineBackground(vecs))` (`engine/src/findings.ts`)
— adapted **upward only** (`max(0.82, μ + 3σ)`) so an anisotropic embedding model suppresses *less*,
never more.

**Round matching (ADR-28, `rounds.ts`) — what reconcile runs.** `findingAddressMatch` says a prior
finding was fixed — and by WHICH signal (`'semantic' | 'locality'`, the auto-accept audit trail
surfaced as reconcile's `acceptedFindings` / the review context's `inferredAccepts`);
`findingAddressedAt` is its boolean wrapper. A finding counts as addressed when EITHER:
1. **Semantic** — some changed region's content has `cosine ≥ semanticThreshold` (default **0.6**;
   engine adapts upward via `adaptiveFloor`) to the finding title. Catches relocated/cross-file fixes.
2. **Locality** — the finding's own file changed and its line falls in
   `[region.start − lineWindow, region.end + lineWindow]`, `lineWindow` default **5**. This is
   drift tolerance, NOT a search radius: **±30 was far too loose** — in a churning file nearly any
   edit landed within 30 lines of a prior finding, silently auto-accepting (and burying) live bugs.
   A false accept marks a still-live bug `fixed` and it never re-surfaces, so keep this tight.

Without embeddings the vectors are empty → semantic never fires → **locality still reconciles**
(ADR-36: a standalone install closes the accept-loop on re-review). The human-readable `reason`
("accepted M of N…", "no prior round recorded…") lives on the engine's `ReconcileResult`
(`engine/src/reconcile.ts`), which also skips `awareness` findings — never auto-accepted (ADR-31).
`classifyChanges` (default cosine threshold **0.55**) tags inter-round regions `feedback-driven`
vs `unexplained` — embedding-based, not line-proximity (ADR-13).

**Review plan (`review-plan.ts`).** Pure fan-out guardrail: `single` unless ≥ `minFiles` (6)
changed files AND `surface ≥ minSurface` (150) AND union-find over coupling edges yields ≥2
clusters of ≥ `minClusterFiles` (2); tiny clusters fold in; units merge down to `maxAgents` (5).
Conservative by design — fanning out a tightly-coupled change severs cross-file reasoning.

**Eval (`eval.ts`).** `relevanceOfOutcome`: accepted/fixed → 2, acknowledged → 1, else 0.
`dcg = Σ relᵢ/log₂(i+2)`, `ndcg = dcg/dcg(ideal)` (1 for all-zero lists). `READINESS` gates the
ranking re-weight: ≥25 evaluable rounds, ≥50 positives (EPV ≈10×5 features), ≥10 negatives with
≥0.2 minority share, headroom only below nDCG 0.85.

## Invariants & gotchas

- **ADR-04:** severity ≠ confidence. **ADR-05:** prevalence is read by severity; bugs get
  `deviation = 1` *and* escalate to `systemic-migration` — never demoted/silenced by being common.
- **Deterministic findings flow through the same `rankFindings` stream** — dedupe corroborates an
  agent finding at the same file:line:title (noisy-OR bumps confidence, `agreedSources` grows).
- The locality window is a hard-won **±5** — a deliberate KEEP (revisited): the residual
  clustered-findings false-accept risk is mitigated by the surfaced `matchedBy` audit trail,
  not by tightening (tighter re-opens the missed-fix class). See the `rounds.ts` comment.
- Keep this package **pure** (root "pure core, impure edges" convention): embedding/git/Kùzu happen
  in `packages/engine`; new logic here must be testable with literal vectors.
- Default `semanticThreshold` of 1.01 in `waiverMatches` is intentional — it disables semantic
  matching unless a caller opts in with real embeddings.

## Testing

All tests are **vitest units**, colocated `src/*.test.ts` (`pnpm test:unit`) — the package is pure,
so nothing here needs the tsx-isolated integration lane (no Kùzu opens, ADR-17). Semantic paths are
tested with hand-written literal vectors (`rounds.test.ts`, `waivers.test.ts`); the end-to-end
review/reconcile behavior is covered by the engine's node E2E (`pnpm test:brain`).
