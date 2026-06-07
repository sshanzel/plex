---
name: pr-review-documenter
description: Use when handling PR review feedback to decide whether a review comment reveals a reusable engineering pattern, guardrail, decision, or invariant that should be captured in this repo's durable docs (AGENTS.md, an ADR, or a milestone record).
---

# PR Review Documentation Skill

Use while responding to PR reviews when a comment is about a recurring pattern or a real decision — not a one-off defect. Turn durable review lessons into durable docs so the same issue isn't rediscovered next PR. Plex itself learns review *pitfalls* automatically; this skill captures the *human-facing* rules and decisions that belong in prose.

## What counts as worth documenting

Capture review feedback when it teaches or reinforces:
- a repo-wide convention, guardrail, or anti-pattern (e.g. the Kùzu open-limit rule, "severity and confidence are separate axes");
- a package/module invariant or lifecycle rule (e.g. "always close the Kùzu `Connection` before the `Database`");
- a cross-package contract or source-of-truth decision;
- a non-obvious design decision a future contributor would otherwise infer from code or PR discussion.

Do NOT document: typos, naming nits, one-off cleanup, rejected/unresolved feedback, or churny implementation details.

## Where it goes (this repo's doc map)

- **Root `AGENTS.md`** — repo-wide conventions, guidelines, and "must-remember invariants" that affect more than one package. Add to the existing `Conventions & guidelines` or `Must-remember invariants` sections; keep additions tight.
- **A new ADR (`docs/adr/README.md`)** — when the feedback settles a *decision* or deviation (the "why", with the rejected alternatives). This is the decision log; new decisions get an ADR entry.
- **A milestone record (`docs/milestones/MN.md`)** — when the work belongs to a milestone's intent → acceptance → built trail.
- **`docs/architecture.md`** — when it changes how a subsystem fits together.

Prefer the smallest durable home. A guardrail other contributors must follow → `AGENTS.md`. A decision with trade-offs → an ADR.

## Workflow

1. During feedback assessment, flag any comment that looks like a reusable pattern or a decision.
2. Fold the documentation action into the proposed action, e.g. `Fix the seed path AND add the "refresh base in an isolated child" rule to AGENTS.md` or `Record the choice as ADR-NN`.
3. After the user's `go`, update the doc in the same commit as the code fix/reply.
4. In the final PR summary, name the doc update alongside the fixed item.

## Writing guidance
- Write the rule as a forward-looking instruction, not as PR history.
- Include enough context to act on it: what to protect, where it applies, what to avoid.
- Keep edits small; match the surrounding section's voice (AGENTS.md is terse and imperative; ADRs are Context → Decision → Consequences).
- New ADRs are append-only and numbered; reference the ADR number from `AGENTS.md` if a rule cites it.
