// Committed-deletion blast radius check under the SHIPPED runtime (node / built CLI).
// The dogfood reviews caught this twice: round 1 — a committed deletion's node is
// DETACH-DELETEd by the graph refresh before the neighborhood is computed (empty radius);
// round 2 — the first fix only covered the round that triggered the refresh. The durable
// fix captures a deleted file's direct dependents into the deleted-neighbors.json sidecar
// at update time; this asserts the dependents surface on the refresh round AND on a later
// round (graph long since refreshed past the deletion).
//
//   pnpm build && node scripts/deleted-radius-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('deleted-radius-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

const env = { ...process.env, PLEX_DATA_DIR: '.plex' }; // in-repo data; no embeddings needed
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
// Retry the transient Kùzu-native SIGSEGV (ADR-17): a native crash, not a logic failure, and `index`
// is idempotent — a fresh child recovers. Only SIGSEGV retries; a real failure rethrows immediately.
const cli = (args, cwd) => {
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    } catch (e) {
      if (e.signal === 'SIGSEGV' && i < 8) continue;
      throw e;
    }
  }
};
const assert = (c, m) => {
  if (!c) {
    console.error(`✗ ${m}`);
    process.exit(1);
  }
  console.log(`✓ ${m}`);
};

const repo = mkdtempSync(join(tmpdir(), 'plex-delrad-'));
try {
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/util.ts'), 'export const util = 1;\n');
  writeFileSync(join(repo, 'src/a.ts'), "import { util } from './util';\nexport const a = util;\n");
  writeFileSync(join(repo, 'src/b.ts'), "import { util } from './util';\nexport const b = util;\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  cli(['index', repo], repo);

  // Commit the deletion on a branch, then refresh incrementally — the update captures the
  // dependents into the sidecar BEFORE removing util.ts's node.
  git(repo, 'checkout', '-q', '-b', 'feat');
  git(repo, 'rm', '-q', 'src/util.ts');
  git(repo, 'commit', '-q', '-m', 'drop util');
  cli(['index', repo, '--incremental'], repo);

  const radiusOf = (ctx) => ctx.blastRadius.map((n) => String(n.node.props.path));
  const round1 = JSON.parse(cli(['review', repo, '--branch', 'main', '--json'], repo));
  assert(
    radiusOf(round1).includes('src/a.ts') && radiusOf(round1).includes('src/b.ts'),
    'round 1: a committed deletion surfaces its dependents (sidecar)',
  );
  assert(
    round1.changed.some((c) => c.file === 'src/util.ts'),
    'round 1: the deleted file is recorded as changed',
  );

  // Round 2: the graph refreshed past the deletion long ago — the in-graph node is gone,
  // so only the sidecar can supply the dependents (the round-2 dogfood gap).
  const round2 = JSON.parse(cli(['review', repo, '--branch', 'main', '--json'], repo));
  assert(
    radiusOf(round2).includes('src/a.ts') && radiusOf(round2).includes('src/b.ts'),
    'round 2: the radius survives later rounds (graph long refreshed)',
  );

  console.log('deleted-radius-check: all assertions passed.');
} finally {
  rmSync(repo, { recursive: true, force: true });
}
