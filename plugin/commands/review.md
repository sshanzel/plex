---
description: Run a fresh, unbiased Plex review of the current change (or a named branch/PR).
argument-hint: "[--pr <n> | --branch <base> | intense]"
---

Run a **Plex** code review of the current change — an unbiased, fresh-context review grounded
in the blast-radius code graph + accumulated review knowledge.

- Default to the **staged** changes. If the user named a branch or PR (`$ARGUMENTS`), review that
  instead (`--branch <base>` / `--pr <n>`).
- Delegate to the **`plex-reviewer`** agent.
- Present the ranked findings, then stop. Do **not** apply fixes — review only. (To work through
  the feedback, **`/pr-master:respond`** is the next step.)

**Intense mode:** Include `intense` in the command (e.g. `/plex:review intense` or
`/plex:review intense --pr 42`) to fan out 4 parallel sub-agents — Security, Correctness,
Test Coverage, and Line-by-Line — each focused on a single concern, then consolidated into one
ranked stream. Best for PRs with significant surface area or high-stakes changes.

$ARGUMENTS
