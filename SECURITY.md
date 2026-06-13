# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — email **sshanzel@yahoo.com** or open a
[GitHub Security Advisory](https://github.com/sshanzel/plex/security/advisories/new). Don't open a
public issue for an undisclosed vulnerability. We'll acknowledge and work a fix before disclosure.

## What Plex sends where

Plex is **local-first**. A review runs on your machine against your git repo; it sends nothing to
third parties beyond (a) the embedding provider you optionally configure and (b) the LLM your own
coding agent already uses. Per-repo data lives under `~/.plex/`. There is no Plex backend.

## Supply-chain posture

The npm ecosystem is under active, evolving worm attack — **Shai-Hulud** (Sept 2025) kicked off a
class of self-replicating malware that steals a maintainer's credentials and auto-republishes
trojanized packages, and 2026 has brought variants (**IronWorm**, the **Miasma / "Phantom Gyp"**
campaign that on **June 5 2026** reached Microsoft's Azure GitHub org via a compromised contributor
account). The newest twist: instead of `pre/postinstall` scripts that scanners watch, *Phantom Gyp*
hides execution in a tiny `binding.gyp` consumed during `npm install`, bypassing install-script
checks. The defenses below are chosen against these **mechanisms**, not against any one worm's name.

**In place today:**

- **Our published package runs no code on install.** The tarball is a `files`-whitelisted `dist/`
  + `LICENSE` + `README` — no `pre/postinstall`, no `binding.gyp`. Installing `@sshanzel/plex`
  executes none of our scripts.
- **Dependency build/install scripts are default-denied.** pnpm's `onlyBuiltDependencies` allows
  build steps for **`esbuild` and `kuzu` only**; every other (incl. transitive) dependency's install
  scripts — *and its `node-gyp`/`binding.gyp` native build* — are not run. This blocks both the
  classic `postinstall` worm vector **and** the Phantom-Gyp bypass for any non-allowlisted dep.
- **Exact, hash-verified deps** via the committed `pnpm-lock.yaml` (SRI integrity, 325 entries);
  vulnerable transitive deps force-patched via pnpm `overrides`; **Dependabot** enabled via the
  committed [`.github/dependabot.yml`](.github/dependabot.yml) (npm + SHA-pinned GitHub Actions, weekly).
- **Publishing protected by npm 2FA with a passkey.**
- **Release-age cooldown**: pnpm `minimumReleaseAge: 4320` (**3 days**) in `pnpm-workspace.yaml` —
  no dependency version (incl. transitive) is installed until 3 days after publication, skipping the
  post-publish window the worms exploit (malicious releases are typically yanked within the hour).
  `minimumReleaseAgeExclude` can exempt specific trusted packages for an urgent patch.

**Residual risk (named honestly):** the allowlist stops install/build execution for *non*-allowlisted
deps, but not (a) a compromised version of an **allowlisted** dep (`esbuild` / `kuzu`) — those *do*
run install logic on your machine — nor (b) malice in any dependency's **runtime** code, which runs
when our bundle imports it. The release-age cooldown (above) is the main mitigation for both; keep the
allowlist minimal and treat updates to `esbuild`/`kuzu` with extra care.

## Known limitations

- **Review-history analysis trusts the comments it distills.** `analyze` / `analyze_scan`
  (`packages/distill/src/distill.ts`) feed untrusted PR-comment bodies to the distilling LLM with
  no data-delimiter, and let the model self-elect a pitfall's `scope` (`global` vs `repo`). A
  crafted comment in a PR you point analysis at could, in principle, be distilled into a pitfall
  (worst case a `global` one) that surfaces in later reviews — **prompt-injection → knowledge
  poisoning**. This is **accepted as low-risk for the local-first, single-operator model**: the
  knowledge base is your own, on your machine, and only you consume the result, so you bear (and
  can see/prune) any poisoned pitfall. The interactive *review* path is not affected — it frames PR
  title/body as "stated intent, not ground truth" (ADR-02), never as instructions. A future
  **team-shared knowledge base** would change this calculus (one user's poisoned pitfall would
  reach teammates) and must revisit it: delimit/sandbox the untrusted comment text and gate
  `global` scope behind corroboration rather than LLM self-election.

## Hardening roadmap (deferred — single-maintainer today)

CI is intentionally **not enabled yet** (one maintainer, no external users). The pieces are written
and **dormant** in [`.github/workflows/`](.github/workflows) so they switch on cleanly when there
are users:

- **CI gate** (`ci.yml`, manual `workflow_dispatch`): `pnpm install --frozen-lockfile` →
  `pnpm audit --audit-level=high` → typecheck → test → build. Enable real CI by uncommenting the
  `push` / `pull_request` triggers.
- **Tokenless release** (`release.yml`, fires on a `v*` tag): npm **OIDC Trusted Publishing** — no
  long-lived token stored anywhere for a worm to steal — plus **provenance** attestation
  (`npm publish --provenance`, verifiable with `npm audit signatures`). One-time: after the first
  manual publish, register the Trusted Publisher on the npm package (repo + `release.yml`).
- **Actions pinned to commit SHAs** (done in both workflows) — a `@v6` tag can be silently
  re-pointed; an Action is itself a supply-chain dependency. The Azure incident spread through a
  **compromised contributor account**, so this + branch protection + least-privilege
  `permissions:` matter.
- **npm 2FA level → "authorization and writes"** so a passkey is required on every *publish*, not
  just login.
- **First publish is manual** (creates the package, with 2FA); the workflow takes over for
  `0.1.1+`.
