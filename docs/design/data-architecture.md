# Data architecture — what stores what, and what reaches the model

A map of every place Plex keeps data, what each is for, how it's stored, how long it lives, and —
the part that matters most for tuning — **exactly what we hand the reasoning model**. The point is to
compartmentalize: once each box is named, we can optimize one without guessing about the others.

Read alongside the root `AGENTS.md`, ADR-18 (knowledge store = JSONL), ADR-30 (brain = Kùzu),
ADR-32/40 (worktree graph copy), and `docs/design/knowledge-decay.md`.

---

## 1. The compartments

| Store | Holds | Tech | Lifetime / scope | A real graph? Labeled edges? |
|---|---|---|---|---|
| **Code graph** | Files, Symbols; `Imports`/`Refs`/`CoChange`/`Declares` | **Kùzu** (`graph.kuzu`) | per-repo; worktree gets a **disposable copy** | **Yes** — typed REL tables with properties (`CoChange{weight,cnt}`). The one true labeled-edge graph. |
| **PR brain** (lineage layer) | Round, Finding, Verdict, Comment | **JSONL event log** (`lineage/<target>.jsonl`, ADR-46) | **base-keyed, durable** under `~/.plex/repos/<baseId>/` — survives `git worktree remove` | **No** — append-only events folded (`foldLineage`) by FKs (`target`,`round`,`findingId`); edges synthesized at read time. |
| **Knowledge** | Pitfall (rule+confidence+vector), Incident (provenance) | **JSONL** (`pitfalls.jsonl`, `incidents.jsonl`) | **global**, durable (`~/.plex/knowledge`) | **No** — flat append logs; connections are FKs (`incidentIds`, `pitfallId`) assembled in memory. |
| **Verdicts** | accept/reject/waive/acknowledge (+ waiver vector) | JSONL (`verdicts.jsonl`) | per-repo (worktree → dies) | n/a — flat log |
| **Embed cache** | vectors for stable recurring texts (finding titles) | JSON (`embed-cache.json`) | per-repo, rebuildable | n/a — cache |
| **Sidecars** | `head.sha`, `base.sha`, `blast-map.json`, `deleted-neighbors.json`, sweep state | files | per-repo, derived | n/a |

**The key observation you had:** only the **code graph** is actually a graph with labeled relations
(like FalkorDB's typed edges). The **brain** and **knowledge** are *node/record stores* — the graph
you see in the explorer is **assembled in memory** from foreign keys, not stored as edges. So we're
partly projecting a graph shape onto stores that don't natively have one.

---

## 2. System map

```
        CODE (structure)                  LEARNING (judgement)
   ┌───────────────────────┐        ┌──────────────────────────────────┐
   │  Code graph (Kùzu)     │        │  Knowledge (JSONL, global)        │
   │  File─Imports→File     │        │   Pitfall ──(incidentIds)→ Incident│
   │  File─CoChange{w}→File │        └──────────────▲────────────────────┘
   │  File─Declares→Symbol  │                       │ distilled-from
   └──────────┬────────────┘                        │
              │ blast radius                  ┌──────┴───────────────────┐
              │                               │  PR brain (Kùzu, transient)│
              ▼                               │  Comment Finding Verdict   │
   ┌─────────────────────────────────────────┴────────────┐ Round         │
   │  assembleReviewContext  → THE MODEL                    └───────────────┘
   └───────────────────────────────────────────────────────┘
```

Two pipelines feed one assembly step. Code → blast radius. History → distilled pitfalls. They merge
only at review time (and, today, only loosely — the brain↔knowledge link is inferred, see §5/§6).

---

## 3. What we actually send the reasoning model

**We do NOT dump the whole knowledge base.** This is RAG (ADR-01): retrieval-gated, top-K. The
`get_review_context` payload (`ReviewContext`, `assembleReviewContext`) is:

| Field | Source | Size / gating |
|---|---|---|
| `changed[]` | the diff | the changed regions/symbols |
| `blastRadius[]` | code graph | coupled files, scored, with `via` provenance + hop distance |
| `deterministic[]` | TS-AST checks | findings on changed lines, **minus waived** |
| `knowledge[]` | knowledge store | **top 5 pitfalls** (`getRelevantKnowledge(cfg, query, 5, repo)`): cosine ≥ `minScore` 0.05, scope-filtered (ADR-21), recency+confidence tilts, **embedding stripped** |
| `priorRounds` / `openComments` / `unexplainedChanges` | brain | facts only (ADR-02), not reasoning |
| `reviewPlan` | pure (`@plex/findings`) | fan-out hint |
| `notes[]` | engine | agent guidance |

So the answer to "do we feed it all the pitfalls?" — **no.** A query is built from changed symbols +
deterministic titles + files, embedded once, and matched against stored pitfall vectors; the **top 5**
that clear the floor and scope are sent, minus their vectors. Knobs that change what the model sees:
**`topK`** (5), **`minScore`** (0.05), the **scope filter** (global + this repo), and the **recency +
confidence tilts** (`docs/design/knowledge-decay.md`, ADR-42/44). Each pitfall carries
title/trigger/why/mitigation/category/confidence — but **no provenance today** (that's the §6 gap).

---

## 4. The flows

- **Index** (`indexRepo`): walk repo → Files/Symbols/Imports/Refs + git co-change → `graph.kuzu`. A
  worktree **copies** the base graph + applies its diff (ADR-32/40; copy because Kùzu read-only open
  SIGSEGVs on Linux). Disposable.
- **Review** (`assembleReviewContext`): diff → blast radius (code graph) → deterministic → **retrieve
  top-K knowledge** → brain round-delta → assemble §3 → hand to the model → `submit_findings` ranks +
  persists findings to the brain.
- **Learn**: an **accept** (`record_outcome`, or inferred by reconcile/sweep) → **Incident** in the
  global knowledge store → many incidents distil (`plex analyze` / consolidation) into a **Pitfall**
  with Wilson confidence. Rejects/waives → negative pitfalls (suppression).
- **Retrieve**: §3 — the only path knowledge re-enters a review.

---

## 5. Is the knowledge store a graph? Query implications & alternatives

**Today: no.** ADR-18 chose flat JSONL deliberately — the base is small and retrieval is pure cosine,
so a log + brute-force vector scan is enough, and it avoids another Kùzu open (ADR-17). "Connections"
exist only as foreign keys (`Pitfall.incidentIds`, `Incident.pitfallId`) assembled into a graph **in
memory** (exactly what the explorer's `linkLineage` does). There are **no labeled relationships** and
**no traversal queries** — you can't ask "every pitfall conceived from a comment by author X across
PRs" without loading everything and walking it yourself.

ADR-18 explicitly named the upgrade trigger: *"Graduate to Kùzu if multi-hop graph queries become
necessary."* Wanting to traverse pitfall → incident → finding → comment **is** that trigger.

| Option | Labeled edges? | Multi-hop queries | Cost | Verdict |
|---|---|---|---|---|
| **Flat JSONL + FKs, assemble in memory** (today) | no (derived) | in app code, load-all | lowest; ADR-18 | fine while the base is small |
| **Kùzu graph for knowledge+lineage** | **yes** (typed REL tables + properties — the FalkorDB-label equivalent) | native Cypher-ish traversal | one more Kùzu DB; open-limit care | the natural graduation if traversal/labels matter |
| **Property-graph server** (FalkorDB/Neo4j) | yes, richest | yes | a **service + Docker** | rejected (ADR-30/33) — reverses the embedded pitch |

**On the FalkorDB-labels question:** you're not wrong that we lack them *in knowledge* — we do. But we
already have exactly that capability in the **code graph** (Kùzu typed REL tables with properties,
e.g. `CoChange{weight,cnt}`). So adopting labeled relations for knowledge isn't new infra — it's using
Kùzu's rel tables the way the code graph already does. Kùzu is an **embedded** property-graph-ish
engine, so we get FalkorDB-style labeled edges **without** FalkorDB-style services.

---

## 6. Target — the knowledge graph *subsumes* lineage (ADR-46 — BUILT)

> **Status: built.** The brain is now a durable, base-keyed JSONL lineage log (not Kùzu); it survives
> worktree deletion, the finding→incident edge is recorded (not inferred), `reviewTargetFor`/verdicts
> are base-keyed, and `healSplitTarget` is retired. The §1–§5 prose below describes the *prior* state
> and the reasoning that led here; the storage map in this section is what shipped.


From the design thread: lineage has no standalone value; its worth is as the **provenance layer
underneath knowledge**. So the target is **one connected graph**, two layers:

```
 distilled   Pitfall ─(confidence, vector)→ [retrieval reads here]
                ▲ distilled-from
 evidence    Incident
                ▲ confirmed / became
 lineage     Comment → Finding → Verdict     (tagged repo + PR/round)
```

Consequences (all from this thread): the **brain dissolves** into "the lineage layer filtered by PR"
(a derived in-memory view, not a per-worktree Kùzu file); the worktree holds **only** the disposable
code-graph copy; the explorer's **dashed inferred bridge becomes a real recorded edge** (we connect
finding→incident→pitfall at write time); and retrieval can return a pitfall **with its grounding**
(the finding/comment/PR it came from) — better context for the reasoning model than a bare assertion.

**The one open decision** (clean slate — no migration, no re-keying): back this connected graph with
**(a) flat records + FKs assembled in memory** (simplest, ADR-18-consistent) or **(b) a Kùzu
knowledge+lineage graph with labeled REL tables** (native traversal + labeled edges, the FalkorDB
capability, one more embedded DB). Recommendation: (a) now, (b) when traversal/label queries earn it —
captured for the architecture ADR.
