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
  vulnerable transitive deps force-patched via pnpm `overrides`; **Dependabot** enabled.
- **Publishing protected by npm 2FA with a passkey.**

**Residual risk (named honestly):** the allowlist stops install/build execution for *non*-allowlisted
deps, but not (a) a compromised version of an **allowlisted** dep (`esbuild` / `kuzu`) — those *do*
run install logic on your machine — nor (b) malice in any dependency's **runtime** code, which runs
when our bundle imports it. The release-age cooldown (below) is the main mitigation for both; keep the
allowlist minimal and treat updates to `esbuild`/`kuzu` with extra care.

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
- **Release-age cooldown**: enable pnpm `minimumReleaseAge` (e.g. 3 days) so a freshly-published
  (possibly malicious) dependency version isn't pulled into a build before the ecosystem detects
  and yanks it — the cooldown is the main defense against the allowlisted-dep and runtime-code
  residual risks above.
- **First publish is manual** (creates the package, with 2FA); the workflow takes over for
  `0.1.1+`.
