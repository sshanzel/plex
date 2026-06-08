---
description: Run a fresh, unbiased Plex review of the current change (or a named branch/PR).
---

Run a **Plex** code review of the current change — an unbiased, fresh-context review grounded
in the blast-radius code graph + accumulated review knowledge.

- Default to the **staged** changes. If the user named a branch or PR (`$ARGUMENTS`), review that
  instead (`--branch <base>` / `--pr <n>`).
- Delegate to the **`plex-reviewer`** agent. If Plex's `reviewPlan` says the change is large and
  splits into independent coupled clusters, use the **`plex-parallel-review`** skill to fan out and
  consolidate.
- Present the ranked findings, then stop. Do **not** apply fixes — review only. (To work through
  the feedback, **`/pr-master:respond`** is the next step.)

$ARGUMENTS
