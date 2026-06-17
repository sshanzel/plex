// Integration-scenario runner with the SAME transient-SIGSEGV retry the node check scripts use
// (brain-check.mjs etc., ADR-17). Each scenario runs as its own fresh `tsx` process (the Kùzu
// native addon tolerates only a few Database opens per process, so one scenario per process) on
// throwaway temp dirs — so a native crash (exit 139 / signal SIGSEGV) is safe to RETRY rather than
// fail the whole build. The old `pnpm test:integration` chained ~18 scenarios with `&&` and NO
// retry, so a single Linux native crash anywhere reds the run; on Linux the per-open crash rate is
// high enough that the chain flaked regularly. Only a native crash retries — a REAL failure
// (assertion → non-zero, non-139 exit) rethrows immediately and is never masked.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Same order as the legacy chain. `build` first (it primes the shared fixtures the others read).
const SCENARIOS = [
  'gitignore-robust',
  'build',
  'ranking-eval',
  'incremental',
  'cochange-inc',
  'cochange-weak',
  'semantic-waiver',
  'reconcile',
  'worktree-seed',
  'neighborhood',
  'blast-hub',
  'blast-barrel',
  'cochange-hub',
  'precise',
  'engine',
  'review-plan',
  'ranking',
  'suppress-scope',
  'knowledge',
  'brain',
];

const ENTRY = resolve('packages/engine/integration.mts');
// pnpm hoists bins to the workspace-root node_modules/.bin; fall back to PATH resolution if absent.
const tsxBin = resolve('node_modules/.bin/tsx');
const TSX = existsSync(tsxBin) ? tsxBin : 'tsx';
const MAX_RETRIES = 8;

// A Kùzu-native crash surfaces either as a signal (child killed by SIGSEGV) or as exit code 139
// (128 + 11, when an intermediate process reports the signal as a status). Retry both; nothing else.
const isNativeCrash = (e) => e.signal === 'SIGSEGV' || e.status === 139;

for (const scenario of SCENARIOS) {
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync(TSX, [ENTRY, scenario], { stdio: 'inherit' });
      break; // scenario passed (it prints its own ✓ line)
    } catch (e) {
      if (isNativeCrash(e) && attempt < MAX_RETRIES) {
        console.error(`↻ run-integration: '${scenario}' hit a transient Kùzu native crash (ADR-17) — retry ${attempt + 1}/${MAX_RETRIES}`);
        continue;
      }
      console.error(`✗ run-integration: '${scenario}' failed (${e.signal ?? `exit ${e.status}`}).`);
      process.exit(typeof e.status === 'number' ? e.status : 1);
    }
  }
}

console.log(`✓ run-integration: all ${SCENARIOS.length} scenario(s) passed.`);
