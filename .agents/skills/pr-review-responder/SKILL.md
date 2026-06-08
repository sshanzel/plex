---
name: pr-review-responder
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

If a `plex` MCP server is configured and reviewed this PR, close its learning loop after fixes land — autonomously, as part of the post-`go` loop; do **not** prompt the user about Plex verdicts. The Plex tools document their own *how* (when to call, identity fields, that `accept` is inferred — read their descriptions); this skill only triggers them:

- **After pushing fixes** → `mcp__plex__reconcile_outcomes` (auto-accepts what your commits addressed).
- **For an explicit dismissal** (you replied "wrong/noise" and changed nothing) → `mcp__plex__record_outcome` `kind: "reject"`.
- **For an `awareness` flag confirmed intentional** ("good catch, but deliberate") → `record_outcome` `kind: "acknowledge"` (not `reject`).

Don't hand-record `accept` for fixed items — `reconcile_outcomes` infers those. Skip this section **only** when no `plex` server is configured (a *disconnected* one is fine — the call reconnects it).

## gh mechanics (get these right or threads get stuck)

- **Reply to a thread (auto-submits, no pending review):** `POST /repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies` with `-f body=…`. Do not open a pending review to reply.
- **Resolve a thread (GraphQL, by thread node id — not comment id):** `resolveReviewThread(input:{threadId})`. Fetch unresolved thread ids first via `reviewThreads(first:50){nodes{id isResolved …}}`.
- **Multiline summary comments:** use `--body-file` with a heredoc (preserve real newlines; literal `\n` renders broken). Keep each Markdown table row on one physical line; escape literal `|` as `\|`.
- **Re-requesting a bot reviewer (e.g. Copilot):** the REST `requested_reviewers` endpoint rejects bots; use GraphQL `requestReviewsByLogin` with `botLogins: ["copilot-pull-request-reviewer"]`. Verify via `reviewRequests` GraphQL (gh hides bot reviewers in `--json reviewRequests`).
