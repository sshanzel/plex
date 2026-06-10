#!/usr/bin/env node
/**
 * Release automation — the two-bump dance in one command (see AGENTS.md "Distribution").
 *
 * The engine (npm `@sshanzel/plex`) and the plugin (`plugin/.mcp.json`'s exact pin) ship in
 * LOCKSTEP, so a plugin update always delivers the matching engine and an exact spec dodges npx's
 * stale-`latest` cache. This bumps BOTH to the same version, gates on green, publishes, tags, pushes,
 * and cuts the GitHub release.
 *
 *   pnpm release <patch|minor|major|X.Y.Z> [--skip-tests] [--dry-run]
 *
 * `npm publish` needs your npm auth (and an OTP under 2FA), so run this LOCALLY, never in CI.
 * Steps: preflight (clean tree, on main, tag free, pin present) → gates (typecheck, test, e2e) →
 * bump package.json + plugin/.mcp.json → commit + tag → npm publish (prepack rebuilds) →
 * push (commit + tag) → gh release create --generate-notes.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // repo root (trailing slash)
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
const cap = (cmd) => execSync(cmd, { cwd: ROOT }).toString().trim();
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipTests = args.includes('--skip-tests');
const bumpArg = args.find((a) => !a.startsWith('--'));
if (!bumpArg) die('usage: pnpm release <patch|minor|major|X.Y.Z> [--skip-tests] [--dry-run]');

// --- compute the next version ---
const pkgPath = `${ROOT}package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) die(`current version "${cur}" is not X.Y.Z`);
const [maj, min, pat] = m.slice(1).map(Number);
const next =
  bumpArg === 'patch' ? `${maj}.${min}.${pat + 1}`
  : bumpArg === 'minor' ? `${maj}.${min + 1}.0`
  : bumpArg === 'major' ? `${maj + 1}.0.0`
  : /^\d+\.\d+\.\d+$/.test(bumpArg) ? bumpArg
  : die(`invalid bump "${bumpArg}" (expected patch|minor|major|X.Y.Z)`);
const tag = `v${next}`;
const mcpPath = `${ROOT}plugin/.mcp.json`;
const pinRe = /@sshanzel\/plex@[\d.]+/g;

console.log(`\n▶ Release ${pkg.name}  ${cur} → ${next}  (tag ${tag})${dryRun ? '  [DRY RUN]' : ''}\n`);

// --- preflight (all the cheap refusals up front) ---
if (cap('git rev-parse --abbrev-ref HEAD') !== 'main') die('must release from main');
if (cap('git status --porcelain')) die('working tree not clean — commit or stash first');
if (next === cur) die(`version unchanged (${cur})`);
let tagExists = false;
try { cap(`git rev-parse -q --verify refs/tags/${tag}`); tagExists = true; } catch { /* absent = good */ }
if (tagExists) die(`tag ${tag} already exists`);
if (!pinRe.test(readFileSync(mcpPath, 'utf8'))) die(`no @sshanzel/plex@<version> pin found in plugin/.mcp.json`);

// --- gates (what CI runs) ---
if (skipTests) console.log('⚠ --skip-tests: skipping typecheck/test/e2e\n');
else { sh('pnpm typecheck'); sh('pnpm test'); sh('pnpm test:e2e'); }

if (dryRun) {
  console.log(`\n✓ DRY RUN ok — would bump to ${next}, commit, tag ${tag}, npm publish, push, gh release.\n`);
  process.exit(0);
}

// --- bump BOTH in lockstep ---
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(mcpPath, readFileSync(mcpPath, 'utf8').replace(pinRe, `@sshanzel/plex@${next}`));
console.log(`\n✓ bumped package.json + plugin/.mcp.json pin → ${next}\n`);

// --- commit + tag (local) ---
sh('git add package.json plugin/.mcp.json');
sh(`git commit -m "chore(release): ${tag}"`);
sh(`git tag -a ${tag} -m "${tag}"`);

// --- publish (prepack rebuilds the bundle; prompts for OTP under 2FA) ---
try {
  sh('npm publish');
} catch {
  die(
    `npm publish failed (auth/OTP?). The bump is committed + tagged LOCALLY but NOT pushed.\n` +
      `  Finish manually:\n` +
      `    npm publish\n` +
      `    git push origin main --follow-tags\n` +
      `    gh release create ${tag} --title ${tag} --generate-notes --latest`,
  );
}

// --- push + GitHub release ---
sh('git push origin main --follow-tags');
sh(`gh release create ${tag} --title ${tag} --generate-notes --latest`);
console.log(`\n✓ Released ${tag}: https://github.com/sshanzel/plex/releases/tag/${tag}\n`);
