#!/usr/bin/env node
/** plex CLI — setup + maintenance for humans; the reviewer itself runs in your coding agent (the Plex plugin). */
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  loadConfig,
  indexRepo,
  assembleReviewContext,
  blastRadius,
  sweepRepo,
  embeddingReady,
  writeHomeConfig,
  homeConfigPath,
  type ReviewContext,
} from '@plex/engine';
import { parse, finiteFlag } from './parse';
import { runServe } from './serve';

type LocalDiffMode = 'working' | 'staged' | 'branch';

/** True when `dir` is inside a git work tree (handles subdirectories + git worktrees). */
function isGitRepo(dir: string): boolean {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

const USAGE = `plex — local-first code review

The reviewer runs in your coding agent (the Plex plugin): run /plex:review (or "review my changes
with Plex"), and /plex:analyze to seed knowledge from your PR review history. This CLI is just setup
+ maintenance.

Run inside your repo. Commands default to the current git repo (an explicit [repoPath] still works).

Usage:
  plex init                                   # setup: embedding key + offer to index the repo
  plex index [--incremental]                  # index the current git repo (--incremental: only changed files, ADR-25)
  plex serve [--port <n>] [--stop] [--status] # local web UI: code graph, PR brain & knowledge (http://127.0.0.1:2288)
  plex sweep [repoPath]                       # background maintenance: close loops + refresh main's graph + consolidate (ADR-43)

Env: PLEX_DATA_DIR, PLEX_KNOWLEDGE_DIR, PLEX_EMBEDDING_PROVIDER`;

function printReview(ctx: ReviewContext): void {
  const out: string[] = [];
  out.push(`repo: ${ctx.repo}   base: ${ctx.baseRef}`);
  if (ctx.graphStale?.refreshed) {
    out.push(`↻ graph was ${ctx.graphStale.behind} commit(s) behind HEAD — auto-refreshed (incremental) before review.`);
  } else if (ctx.graphStale) {
    const b = ctx.graphStale.behind;
    out.push(
      `⚠ graph ${b > 0 ? `${b} commit(s) behind` : 'out of sync with'} HEAD — blast radius may be incomplete. Run \`plex index --incremental\`.`,
    );
  }
  const cc = ctx.changeContext;
  if (cc && (cc.title || cc.description || cc.commits?.length)) {
    out.push('');
    out.push('Stated intent (check the code against this):');
    if (cc.title) out.push(`  title: ${cc.title}`);
    if (cc.url) out.push(`  url:   ${cc.url}`);
    if (cc.description) {
      out.push('  description:');
      out.push(cc.description.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    if (cc.commits?.length) {
      out.push('  commits:');
      for (const c of cc.commits) out.push(`    - ${c}`);
    }
  }
  out.push('');
  out.push(`Changed (${ctx.changed.length}):`);
  for (const c of ctx.changed) {
    out.push(`  ${c.file}:${c.startLine}-${c.endLine}${c.symbol ? `  ${c.symbol}` : ''}`);
  }
  out.push('');
  out.push(`Blast radius — coupled files (${ctx.blastRadius.length}):`);
  for (const n of ctx.blastRadius) {
    out.push(
      `  ${n.score.toFixed(3)}  ${String(n.node.props.path)}  [${n.via.join(', ')}]  (hop ${n.distance})`,
    );
  }
  out.push('');
  out.push(`Deterministic findings (${ctx.deterministic.length}):`);
  for (const f of ctx.deterministic) {
    out.push(`  [${f.severity}] ${f.location.file}:${f.location.startLine}  ${f.title}`);
  }
  out.push('');
  out.push(`Relevant knowledge / pitfalls (${ctx.knowledge.length}):`);
  for (const k of ctx.knowledge) {
    out.push(`  ${k.score.toFixed(3)}  [${k.pitfall.category}] ${k.pitfall.title}`);
  }
  if (ctx.round != null) {
    out.push('');
    out.push(`PR brain — round ${ctx.round}${ctx.priorRounds && ctx.priorRounds.length > 1 ? ` (of ${ctx.priorRounds.length})` : ''}, target ${ctx.target}`);
    if (ctx.openComments && ctx.openComments.length) {
      out.push(`  PR comments this round: ${ctx.openComments.length}`);
    }
    if (ctx.unexplainedChanges && ctx.unexplainedChanges.length) {
      out.push(`  Changed WITHOUT feedback (scrutinize — ${ctx.unexplainedChanges.length}):`);
      for (const u of ctx.unexplainedChanges) out.push(`    ${u.file}:${u.start}-${u.end}`);
    } else if (ctx.priorRounds && ctx.priorRounds.length > 1) {
      out.push('  No unexplained changes since last round.');
    }
  }
  out.push('');
  out.push('Notes for the reviewing agent:');
  for (const note of ctx.notes) out.push(`  • ${note}`);
  process.stdout.write(out.join('\n') + '\n');
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

/** Like `ask`, but does not echo the typed answer — for secrets. Falls back to `ask` on a non-TTY. */
function askSecret(question: string): Promise<string> {
  const out = process.stdout;
  if (!process.stdin.isTTY) return ask(question);
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  let muted = false;
  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = rlAny._writeToOutput.bind(rl);
  rlAny._writeToOutput = (s: string) => { if (!muted) orig(s); };
  return new Promise((res) => {
    rl.question(question, (a) => { rl.close(); out.write('\n'); res(a.trim()); });
    muted = true; // prompt already written; suppress the echo of the secret itself
  });
}

/** Run a slow step with a live spinner + elapsed time; degrades to a single line on a non-TTY. */
async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const out = process.stdout;
  if (!out.isTTY) {
    out.write(`${label}…\n`);
    return fn();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const start = Date.now();
  let i = 0;
  const render = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    out.write(`\r${frames[i++ % frames.length]} ${label}… ${s}s`);
  };
  render();
  const timer = setInterval(render, 80);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    out.write('\r\x1b[K');
  }
}

/** One-command setup: optional embedding key, then offer to index. The MCP is provided by the Plex
 *  plugin, so init does NOT register one (avoids a duplicate `plex` server). */
async function runInit(repoPath: string): Promise<number> {
  const out = process.stdout;
  out.write('Plex setup (embedded: no Docker, no services).\n\n');

  out.write('An embedding key powers knowledge retrieval and the semantic review signals (optional).\n');
  const provider = (await ask('Embedding provider [voyage/openai/gemini/ollama/none] (voyage): ')) || 'voyage';
  if (provider !== 'none') {
    const apiKey = provider === 'ollama' ? undefined : await askSecret(`API key for ${provider} (Enter to skip): `);
    writeHomeConfig({ embedding: { provider: provider as never, ...(apiKey ? { apiKey } : {}) } });
    out.write(`Saved config to ${homeConfigPath()}\n`);
  }

  if (!isGitRepo(repoPath)) {
    out.write('\nNot a git repo here, so skipping the index. Run `plex index` inside a repo later, or just review it (the first review auto-indexes).\n');
  } else if ((await ask('\nIndex this repo now? [Y/n]: ')).toLowerCase() !== 'n') {
    const res = await withSpinner(
      `Indexing ${path.basename(path.resolve(repoPath))} (the first index walks git history, so large repos take a moment)`,
      () => indexRepo(repoPath, loadConfig()),
    );
    out.write(`Indexed ${res.files} files, ${res.symbols} symbols, ${res.coChangePairs} co-change pairs.\n`);
  }

  if (isGitRepo(repoPath)) {
    out.write(
      '\nTip: run `/plex:analyze` in your agent to seed Plex from your merged PR history — it distills past\n' +
        'review comments into lessons anchored to your code, so the reviewer is sharp from day one.\n' +
        (embeddingReady(loadConfig()) ? '' : 'Add an embedding key first (re-run `plex init`) so the lessons are stored semantically.\n'),
    );
  }

  out.write('\nDone. Install the Plex plugin if you have not, then run `/plex:review` in your agent (or say "review my changes with Plex").\n');
  return 0;
}

async function main(): Promise<number> {
  const { positionals, flags } = parse(process.argv.slice(2));
  const command = positionals[0];
  const config = loadConfig();

  switch (command) {
    case 'init':
      return runInit(positionals[1] ?? process.cwd());
    case 'index': {
      const repoPath = positionals[1] ?? process.cwd();
      if (!isGitRepo(repoPath)) {
        process.stderr.write(
          `Not a git repository: ${path.resolve(repoPath)}\n` +
            'Run `plex index` from inside a git repo — Plex builds its blast radius from git co-change history.\n',
        );
        return 1;
      }
      const res = await withSpinner(
        `${flags.incremental ? 'Refreshing' : 'Indexing'} ${path.basename(path.resolve(repoPath))}`,
        () => indexRepo(repoPath, config, { incremental: Boolean(flags.incremental) }),
      );
      if (res.incremental) {
        process.stdout.write(
          `${res.seeded ? 'Seeded from base worktree + applied' : 'Incrementally updated'} ${res.files} file(s) ` +
            `(+${res.added ?? 0} ~${res.modified ?? 0} -${res.deleted ?? 0}): ` +
            `${res.symbols} symbols re-extracted, co-change recomputed (${res.coChangePairs} pairs).\n` +
            `Graph: ${res.graphDir}\n`,
        );
      } else {
        process.stdout.write(
          `Indexed ${res.files} files, ${res.symbols} symbols, ${res.imports} imports, ` +
            `${res.coChangePairs} co-change pairs from ${res.commits} commits.\n` +
            `Graph: ${res.graphDir}\n`,
        );
      }
      return 0;
    }
    // INTERNAL (omitted from USAGE): `review --json` and `blast` exist to drive the engine through the
    // BUILT CLI in the node-only E2E harness (ADR-17 needs child-process isolation per Kùzu open). The
    // CLI has no LLM, so it only ASSEMBLES context — a real review runs in the isolated agent (ADR-02).
    case 'review': {
      const repoPath = positionals[1] ?? process.cwd();
      const mode: LocalDiffMode | undefined = flags.staged
        ? 'staged'
        : flags.branch
          ? 'branch'
          : undefined;
      const ctx = await assembleReviewContext({
        repoPath,
        config,
        source: flags.pr ? 'pr' : 'local',
        mode,
        baseRef: typeof flags.branch === 'string' ? flags.branch : undefined,
        pr: typeof flags.pr === 'string' ? flags.pr : undefined,
      });
      if (flags.json) process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
      else printReview(ctx);
      return 0;
    }
    case 'blast': {
      const repoPath = positionals[1] ?? process.cwd();
      const files = typeof flags.files === 'string' ? flags.files.split(',').map((s) => s.trim()) : [];
      if (files.length === 0) {
        process.stderr.write('blast requires --files <a.ts,b.ts>\n');
        return 1;
      }
      const neighbors = await blastRadius(repoPath, files, config);
      process.stdout.write(JSON.stringify({ neighbors }, null, 2) + '\n');
      return 0;
    }
    case 'serve': {
      // The optional local visualization daemon (ADR-45); opens Kùzu per-request, never blocks a review.
      return runServe(config, {
        foreground: Boolean(flags.foreground),
        stop: Boolean(flags.stop),
        status: Boolean(flags.status),
        port: typeof flags.port === 'string' ? finiteFlag(flags.port, 'port') : undefined,
      });
    }
    case 'sweep': {
      // The background maintenance worker (ADR-43) — also the entry the detached spawner runs.
      const repoPath = positionals[1] ?? process.cwd();
      const res = await sweepRepo(repoPath, config);
      if (res.locked) {
        process.stdout.write('Sweep skipped — another sweep is already running for this repo.\n');
        return 0;
      }
      process.stdout.write(`Swept ${res.repo} (main: ${res.mainRepoPath})${res.busy ? ' — some work deferred (repo busy)' : ''}:\n`);
      for (const j of res.jobs) process.stdout.write(`  ${j.ran ? '✓' : '·'} ${j.name}: ${j.detail}\n`);
      return 0;
    }
    default:
      process.stdout.write(USAGE + '\n');
      return command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
