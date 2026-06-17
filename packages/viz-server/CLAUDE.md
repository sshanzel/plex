# @plex/viz-server

The **optional local visualization daemon** (ADR-45, M13) — a node `http` server that serves an
interactive Cytoscape UI at `http://127.0.0.1:2288` over a read-only JSON API into the three stores
Plex already owns: the Kùzu **code graph**, the Kùzu **PR brain**, and the JSON **knowledge base**.
It's the FalkorDB-Browser need met without reintroducing a database engine, Docker, or any
external/native service — "no Docker / no external services" still holds; this is one optional local
**node** daemon (read the root `AGENTS.md` first; decision in [docs/adr/README.md](../../docs/adr/README.md) ADR-45).

This package depends only on `@plex/core` + `@plex/code-graph` + `@plex/knowledge` (NOT `@plex/engine`)
— it takes a resolved `ReviewerConfig` and reads stores directly, so it can't pull the review flow
into a long-lived process. The CLI (`plex serve`) is the only caller.

## Module map

| File | Responsibility |
| --- | --- |
| `src/model.ts` | The uniform `{nodes, edges}` shape the UI consumes (`VizNode`/`VizEdge`/`GraphPayload`), `withCounts`, `emptyPayload`. `props` is flat + JSON-safe (collectors strip embeddings/secrets). |
| `src/registry.ts` | Enumerate the machine's indexed repos (dirs under the repos root) + **validate a requested id** (`resolveRepo`) — the path-traversal gate. |
| `src/collect.ts` | Read each store into a `GraphPayload`: `collectCode` / `expandCodeFile` (Kùzu code graph — expand also runs `linkSymbolIncidents`, ADR-47: a Symbol → the incidents anchored at it by `file#name` key (solid) or line-overlap (dashed/`inferred`), so clicking a symbol shows its concern history), `collectBrain` (durable JSONL lineage via `@plex/core` `foldLineage` — ADR-46, no Kùzu), `collectKnowledge` (JSON, optional repo-origin scope; incident nodes carry the `symbol`/`line` anchor), `collectLineage` + pure `linkLineage` (brain ⨝ knowledge). |
| `src/server.ts` | `startServer` — routes `/`, `/healthz`, `/api/repos`, `/api/graph/{code,brain,knowledge}`, `/api/expand`; binds 127.0.0.1; maps `RepoBusyError` → 503. |
| `src/daemon.ts` | Pidfile (`~/.plex/daemon.json`) read/write/clear, `pidAlive`, `probe`, `liveDaemon` (probe-over-pidfile, clears stale), `ensureDaemon` (the opt-in always-on spawn). `DEFAULT_PORT = 2288`. |
| `src/ui.ts` | `renderAppHtml` — the whole single-page Cytoscape app (CDN + SRI-pinned 3.30.2, same hash as the M5 static viz). **Legibility encoding:** node border by `outcome` (green=resolved, red=dismissed), a thick orange ring + ⚠ label + panel banner for a **regression sentinel** (a resolved concern anchored to a symbol); edge labels shown on the relationship graphs (`graph != "code"`) so `became`/`from`/`raised in` read; the detail panel leads with a `summaryFor` one-liner; legend gains the outcome/sentinel key. All client-side, still `textContent`-only (XSS-safe). |

## The two load-bearing invariants

1. **Never hold a Kùzu handle.** Only `collectCode`/`expandCodeFile` touch Kùzu now (the code graph);
   `collectBrain` reads plain JSONL (ADR-46). Kùzu is single-writer — a held handle makes a concurrent
   review's open throw `RepoBusyError` (i.e. the viewer would break reviews). So `collect.ts` opens the
   code graph **per request and closes immediately** (`withGraph`), and the server maps a
   `RepoBusyError` (a review holds the lock *right now*) to a **503** the UI retries. Read-only opens (which would allow
   shared readers) are NOT an option: Kùzu 0.11.3's read-only open SIGSEGVs on Linux (ADR-40).

2. **127.0.0.1 only + validated repo ids = no exposure, no traversal.** The server binds the
   loopback host (never `0.0.0.0`), so there's no remote surface and no auth is needed. Every
   `?repo=` is run through `resolveRepo`, which accepts an id only if it matches `^[A-Za-z0-9._-]+$`
   AND resolves to a direct child of the repos root AND has a graph/brain — so `../../etc` and
   unknown ids 404. The UI builds the detail panel with `textContent`, never `innerHTML` of store
   text; the only interpolated HTML value is our own build `version` (escaped). **The UI is
   read-only** — it never writes a verdict or mutates a store.

## Lineage view (Tier 1)

The **Lineage** tab unifies a repo's brain and its origin-scoped knowledge into one
comment → finding → verdict → incident → pitfall chain. The brain-internal edges
(comment→finding by locality, finding→round, verdict→finding) and the knowledge provenance
(incident→pitfall) are **real**. The **finding→incident** hop is **recorded** when an `Incident`
carries `findingId` (ADR-46 increment 1 — captured at accept-time in `submitVerdict`; drawn solid,
label `became`); for findings without one yet it falls back to an **inferred same-file bridge**
(`linkLineage`, flagged `inferred` → dashed). The dashed set shrinks as new accepts carry provenance.
**Tier 2** (the rest — a durable, global, append-only *lineage layer*
written eagerly at review time — `docs/adr/` follow-up) replaces those dashed bridges with exact,
recorded edges AND fixes the real durability hole: a worktree's brain dies with the worktree (ADR-40)
and the sweeper (its only loop-closer) reads the *transient* brain, so autonomous/local-only reviews
can lose their tail before consolidation. The journal becomes the durable source the sweeper and this
view read — the brain demoted to a rebuildable working index. (Tier 2 is a separate PR.)

## Brain edges are synthesized

The brain (ADR-46) is a JSONL event log with **no stored edges** — `Round`/`Finding`/`Verdict`/`Comment`
relate by `target` / `round` / `findingId`. `collectBrain` folds each per-target file (`foldLineage`)
and rebuilds the graph from those keys: a hub
per `target`, `Round → hub`, `Finding → its round` (matched by `target#round.n`, fallback hub),
`Verdict → its Finding` (by `findingId`), `Comment → hub`.

## Lifecycle (`plex serve`, in `@plex/cli/src/serve.ts`)

Default mode is **idempotent**: `liveDaemon()` (probe + pidfile) → if up, just open the browser;
else spawn a **detached** `node <plex.js> serve --foreground --port N` (`unref`'d, survives the
shell), poll `liveDaemon()` until it answers, print the URL, open the browser. `--foreground` IS the
daemon (binds, writes the pidfile, returns a never-resolving promise so the CLI's
`main().then(process.exit)` doesn't tear it down; SIGINT/SIGTERM → clear pidfile + close). `--stop` /
`--status` manage it. Port: `--port` > `PLEX_UI_PORT` > 2288, with EADDRINUSE fallback to the next
ports (the pidfile records the actual one, which is why the parent polls `liveDaemon` not a fixed port).

**Lifecycle: on-demand by default, opt-in always-on** (ADR-45). The daemon is a *viewer*, not a
capturer — nothing is missed by it being off — so it does **not** run unless asked. You launch it with
`plex serve` (`serve.ts`), which spawns it detached and opens the browser. Setting **`ui.autoStart`**
(or `PLEX_UI_AUTOSTART=1`) restores always-on: the **MCP server on startup** calls `ensureDaemon({execPath,
scriptPath, port})` (probe-first → detached-spawn `node plex.js serve --foreground` when down), so it
comes up for any client (Claude/Codex/bare MCP) with no CLI install and no client-specific hook.
`ensureDaemon` is **stdout-safe** (writes nothing to stdout — the MCP's stdio protocol channel — and
swallows every error) and no-ops when `scriptPath` doesn't exist (dev/tsx).

## Limitations (v1, accepted — ADR-45)

- Only **centralized** repos appear (the in-repo `PLEX_DATA_DIR=.plex` opt-in and a linked
  worktree's `<wt>/.plex` have no central registry — `reposRoot` returns null for a relative dataDir).
- The daemon is **per-machine**; concurrent SessionStart hooks racing a cold start can briefly spawn
  two daemons (the second falls back a port); a busy repo shows a transient 503 retry.

## Testing

Pure/file-based vitest units only (`pnpm test:unit`) — **none open Kùzu** (ADR-17): `registry.test.ts`
(listing + traversal rejection), `collect.test.ts` (knowledge shaping via a tmp `KnowledgeStore` +
embedding-strip), `daemon.test.ts` (pidfile round-trip under a redirected `$HOME`, `pidAlive`,
stale-pidfile clear), `ui.test.ts` (SRI present + version escaped). The Kùzu-backed `collectCode`/
`collectBrain` and the live server are exercised by the manual M13 E2E (`plex serve` + `curl`), not a
`.test.ts` (a Kùzu-opening test crashes vitest teardown).
