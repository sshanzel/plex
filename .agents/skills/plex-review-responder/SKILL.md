---
name: plex-review-responder
description: Fetch PR review comments, classify them, propose actions, apply fixes or replies, resolve threads — and close the Plex learning loop. Use when working through PR review feedback end-to-end on this repo.
---

# PR Review Responder Skill

Use this when the user wants to work through PR review feedback end-to-end. It pairs with the `plex-reviewer` agent: the agent *finds*, this skill *resolves* and feeds the outcome back to Plex so the next round is smarter.

> When auto-comment is on (ADR-34), Plex posts its review **to the PR itself** — those comments (a review whose body says "Posted by Plex") are just regular PR review comments; triage them like any other, and the "Closing the Plex review loop" section below records the outcomes back to Plex.

## Workflow

1. Detect or receive the PR URL/number.
2. Fetch inline comments, issue comments, and unresolved review threads via `gh`. Ignore automated deploy/status comments. If a low-confidence note was already assessed in a prior run, don't re-list it unless it materially changed.
3. Classify each item as `bug`, `improvement`, `minor`, `stale`, `question`, or `discuss`. Use the `pr-review-documenter` skill for any comment that reveals a reusable convention/invariant worth capturing in `AGENTS.md`, an ADR, or a milestone doc.
4. **Present an assessment table, then stop.** Columns: `Item`, `Feedback`, `Class`, `Proposed action`. Each proposed action is a short sentence on what changes and where — not a one-word `Fix`. End with: *Reply with `go` to apply these as-is — or tweak any row first. I will not change code, reply, resolve threads, commit, push, or request review until you send `go`.* Do nothing else until the user sends `go`.
5. **After `go`, run the review-response loop:**
   - apply fixes;
   - **add or extend a test for every code change where one is applicable** (Plex is a test-first repo — see `AGENTS.md`; a vitest unit for pure logic, a tsx scenario for Kùzu/DB paths per ADR-17), in the same commit as the fix;
   - run the gates: `pnpm typecheck && pnpm test` (and `pnpm build` if shipped code changed);
   - commit per item (or per shared root cause), keeping each item's test with its fix;
   - reply to each thread with the concrete fix/decision and resolve fixed threads (leave genuinely-open discussions unresolved);
   - **close the Plex review loop** (below) — autonomous, no extra prompt;
   - post a formatted PR summary comment mapping each assessed item to its outcome + commit hash + test;
   - re-request review from the relevant reviewer(s).

## Rules
- Don't accept feedback blindly — verify against the code and product direction.
- Treat docs as a contract: a stale/incorrect `AGENTS.md`, ADR, milestone doc, or PR body is a real defect — classify and fix it, don't dismiss as noise.
- Every code change ships a test when applicable; state the reason when it genuinely isn't (docs-only, pure rename, already covered).
- Run `pnpm typecheck && pnpm test` before claiming an item fixed. For Kùzu-touching paths also run the relevant node E2E (`pnpm test:brain` / `pnpm test:worktree`).

## Closing the Plex review loop (if Plex reviewed the PR)

If the `plex` MCP server is **configured** (in `.mcp.json` / `~/.claude.json`) and Plex reviewed this PR, close its learning loop after fixes land — Plex learns from what the team actually *did*, never from a prompt. This runs as part of the post-`go` loop; do **not** ask the user about Plex verdicts.

> **"Plex MCP is disconnected" is NOT a reason to skip.** A stdio MCP server is idle-dropped after a few seconds and **re-spawns on the next tool call** (~400ms) — and Plex is stateless per call (it reads the PR brain from disk), so reconnecting loses nothing. If the tools are configured, **just call `reconcile_outcomes`** — the call itself reconnects the server. If they're deferred behind tool-search, load them with `ToolSearch("mcp__plex__")` first. Only treat Plex as unavailable when the *call itself* errors (then say so and note that the next `plex-reviewer` pass will reconcile from the pushed commits). Skip this section **only** when the `plex` server isn't configured at all.

- **After pushing fixes**, call `mcp__plex__reconcile_outcomes` with `{ source: "pr", pr: <n> }`. Plex compares its open findings for this PR against the commits you just pushed and auto-records `accept` for the ones you addressed — one call covers the whole batch. Nothing to confirm.
- **For an item you dismissed as wrong/noise** (the reviewer was off — replied with rationale, no change), call `mcp__plex__record_outcome` with `kind: "reject"`, `scope: "pattern-repo"`, the same `{ source: "pr", pr: <n> }`, and the finding's `file` / `line` / `title`. This suppresses it AND tells Plex the flag was noise (down-weights it).
- **For an `awareness` flag confirmed *intentional*** (a *good* catch, but deliberate — e.g. "yes, two payment surfaces on purpose"), call `record_outcome` with **`kind: "acknowledge"`** (same identity fields). This stops it re-surfacing **unless the situation materially changes** (e.g. a 3rd site appears) and — unlike `reject` — does **not** penalize the reviewer for a correct catch. Use `acknowledge`, not `reject`, whenever the flag was right but the answer is "intentional."
- Do **not** call `record_outcome accept` by hand for fixed items — `reconcile_outcomes` already infers those from the pushed code. Reserve manual `record_outcome` for the explicit `reject`/`acknowledge` above (silence is never a verdict).

## gh mechanics (get these right or threads get stuck)

- **Reply to a thread (auto-submits, no pending review):** `POST /repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies` with `-f body=…`. Do not open a pending review to reply.
- **Resolve a thread (GraphQL, by thread node id — not comment id):** `resolveReviewThread(input:{threadId})`. Fetch unresolved thread ids first via `reviewThreads(first:50){nodes{id isResolved …}}`.
- **Multiline summary comments:** use `--body-file` with a heredoc (preserve real newlines; literal `\n` renders broken). Keep each Markdown table row on one physical line; escape literal `|` as `\|`.
- **Re-requesting a bot reviewer (e.g. Copilot):** the REST `requested_reviewers` endpoint rejects bots; use GraphQL `requestReviewsByLogin` with `botLogins: ["copilot-pull-request-reviewer"]`. Verify via `reviewRequests` GraphQL (gh hides bot reviewers in `--json reviewRequests`).
