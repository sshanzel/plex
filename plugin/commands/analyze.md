---
description: Seed Plex's knowledge base from your PR review history (distill recurring review comments into reusable pitfalls).
argument-hint: "[--oldest] [--limit <n>] [--reset] [--all]"
---

Seed **Plex** from this repo's **PR review history** — distill recurring review comments into reusable
pitfalls anchored to your code, so the reviewer is sharp from day one instead of learning from scratch.

- Runs on the **current repo** (the one your terminal is in).
- Delegate to the **`plex-analyzer`** agent — it calls `analyze_scan` (Plex fetches via `gh`, denoises,
  clusters), distills each cluster with your judgment (keep vs skip), then `add_pitfalls` + `consolidate_knowledge`.
- **Incremental + bounded:** each run distills up to ~30 fresh PRs by default (a per-session cost guard);
  re-run to keep going. `--oldest` goes chronologically from PR #1, `--limit <n>` overrides the cap for a
  run, `--reset` starts over.
- Needs the GitHub CLI (`gh`) authenticated and an embedding key set (`npx @sshanzel/plex init`).

Present the summary (lessons learned, scope split, PRs scanned), then stop.

$ARGUMENTS
