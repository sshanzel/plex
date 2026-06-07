import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

/**
 * Git hooks that keep the code graph fresh automatically (ADR-25): on pull / checkout /
 * rebase, run an incremental index. Opt-in (`plex install-hooks`). The block is fenced so
 * we can update or remove it without clobbering the user's own hook scripts.
 */
const HOOKS = ['post-merge', 'post-checkout', 'post-rewrite'] as const;
const BEGIN = '# >>> plex auto-index >>>';
const END = '# <<< plex auto-index <<<';
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockRe = new RegExp(`\\n?${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`);

export interface HookResult {
  hooksDir: string;
  hooks: string[];
  /** Hooks left untouched because their interpreter isn't a POSIX shell (install only). */
  skipped?: string[];
}

function blockFor(cliPath: string, repoPath: string): string {
  return [BEGIN, `node "${cliPath}" index "${repoPath}" --incremental >/dev/null 2>&1 || true`, END].join('\n');
}

/**
 * Our auto-index block is `sh` syntax. A pre-existing hook with a NON-shell shebang
 * (Husky-with-node, a Python pre-commit hook, …) would execute that line in the wrong
 * interpreter and break on every `git merge`. Only touch hooks that are sh-compatible:
 * no shebang (we prepend `#!/bin/sh`) or a shell shebang.
 */
function isShCompatible(content: string): boolean {
  const first = content.split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) return true;
  return /\b(sh|bash|dash|zsh|ksh)\b/.test(first);
}

/** Install/refresh the plex auto-index block in this repo's git hooks. */
export function installHooks(repoPath: string, cliPath: string): HookResult {
  const repo = path.resolve(repoPath);
  if (!existsSync(path.join(repo, '.git'))) {
    throw new Error(`${repo} is not a git repository (no .git directory).`);
  }
  const hooksDir = path.join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const block = blockFor(path.resolve(cliPath), repo);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (existing !== null && !existing.includes(BEGIN) && !isShCompatible(existing)) {
      skipped.push(hook); // a non-shell user hook — don't corrupt it
      continue;
    }
    let content = existing ?? '#!/bin/sh\n';
    if (!content.startsWith('#!')) content = '#!/bin/sh\n' + content;
    content = content.includes(BEGIN)
      ? content.replace(blockRe, '\n' + block + '\n')
      : content.replace(/\n*$/, '\n') + block + '\n';
    writeFileSync(file, content, 'utf8');
    chmodSync(file, 0o755);
    installed.push(hook);
  }
  return { hooksDir, hooks: installed, ...(skipped.length ? { skipped } : {}) };
}

/** Remove the plex auto-index block from this repo's git hooks (leaves other content). */
export function uninstallHooks(repoPath: string): HookResult {
  const hooksDir = path.join(path.resolve(repoPath), '.git', 'hooks');
  const removed: string[] = [];
  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    if (!content.includes(BEGIN)) continue;
    writeFileSync(file, content.replace(blockRe, '\n'), 'utf8');
    removed.push(hook);
  }
  return { hooksDir, hooks: removed };
}
