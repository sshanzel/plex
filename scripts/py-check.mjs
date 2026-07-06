// Python-support packaging check (ADR-52) under the SHIPPED runtime: plain `node` driving the
// built CLI. Pins the ONE risk no vitest/tsx lane can: that `dist/plex.js` — with web-tree-sitter
// and tree-sitter-python left external — still resolves the grammar wasm from node_modules and
// indexes a real src-layout Python repo end to end (graph + blast radius through an __init__
// barrel), and that `plex review` surfaces a Python deterministic finding.
//
//   pnpm build && node scripts/py-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/plex.js');
if (!existsSync(CLI)) {
  console.error('py-check: dist/plex.js not found — run `pnpm build` first.');
  process.exit(2);
}

const env = { ...process.env, PLEX_DATA_DIR: '.plex' }; // in-repo data dir; no embeddings needed
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

const repo = mkdtempSync(join(tmpdir(), 'plex-py-'));
try {
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.dev');
  git(repo, 'config', 'user.name', 'T');
  mkdirSync(join(repo, 'src/mypkg'), { recursive: true });
  writeFileSync(join(repo, 'src/mypkg/__init__.py'), 'from .app import create_app\nfrom .db import connect\n');
  writeFileSync(join(repo, 'src/mypkg/db.py'), 'def connect(url=None):\n    return url\n');
  writeFileSync(
    join(repo, 'src/mypkg/app.py'),
    'from .db import connect\n\nclass App:\n    def run(self):\n        pass\n\ndef create_app():\n    return App()\n',
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  const idx = cli(['index', repo], repo);
  const m = idx.match(/Indexed (\d+) files, (\d+) symbols, (\d+) imports/);
  assert(m, `index reported counts (${idx.trim().split('\n')[1] ?? idx.trim()})`);
  assert(Number(m[1]) === 3 && Number(m[2]) === 4 && Number(m[3]) === 3,
    `wasm-parsed the repo from the bundle: 3 files, 4 symbols, 3 imports (got ${m[1]}/${m[2]}/${m[3]})`);

  const blast = JSON.parse(cli(['blast', repo, '--files', 'src/mypkg/db.py'], repo));
  assert(
    blast.neighbors.some((n) => n.node.id === 'src/mypkg/app.py'),
    'blast radius of db.py reaches app.py through the Python import graph',
  );

  // A working-tree change carrying a Python sin → the deterministic layer flags it via `plex review`.
  writeFileSync(
    join(repo, 'src/mypkg/db.py'),
    'def connect(url=None, opts=[]):\n    print("connecting")\n    return url\n',
  );
  const review = JSON.parse(cli(['review', repo, '--json'], repo));
  const rules = (review.deterministic ?? []).map((f) => f.tags?.[0]);
  assert(rules.includes('no-print') && rules.includes('mutable-default-arg'),
    `python deterministic findings surfaced in a review (got: ${rules.join(',') || 'none'})`);

  // Post-upgrade rollout gate (ADR-52): a stale graph.version sidecar at an UNCHANGED head must
  // still trigger the refresh — sha-drift alone must not be the only trigger.
  writeFileSync(join(repo, '.plex/graph.version'), '1');
  cli(['review', repo, '--json'], repo);
  const restored = readFileSync(join(repo, '.plex/graph.version'), 'utf8').trim();
  assert(restored !== '1', `the version gate refreshed a stale graph at behind=0 (sidecar now '${restored}')`);
} finally {
  rmSync(repo, { recursive: true, force: true });
}
console.log('✓ py-check: Python support works end to end under the shipped runtime.');
