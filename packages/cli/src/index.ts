#!/usr/bin/env node
/**
 * plex CLI. Thin wrapper over @plex/engine for humans; the MCP server is the
 * path for agents. Commands: init, doctor, index, reconcile, eval, blast, verdict,
 * verdicts, consolidate, mine (and an undocumented `review` — see the USAGE note).
 *
 * The shebang above is the first line so esbuild/tsup preserves it in dist/plex.js,
 * making the published `bin` directly executable.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  loadConfig,
  repoPaths,
  indexRepo,
  assembleReviewContext,
  blastRadius,
  reconcileOutcomes,
  rankingQuality,
  submitVerdict,
  readVerdicts,
  consolidateKnowledge,
  embeddingReady,
  reviewContextToHtml,
  mineRepo,
  readHomeConfig,
  writeHomeConfig,
  homeConfigPath,
  type ReviewContext,
} from '@plex/engine';
import type { VerdictKind, WaiverScope } from '@plex/core';
import { parse } from './parse';

type LocalDiffMode = 'working' | 'staged' | 'branch';

/**
 * True when `dir` is inside a git work tree (handles subdirectories + git worktrees, not just a bare
 * `.git` check). This is the validity gate for `index`/`init`: Plex's blast radius is built from git
 * co-change history, so a non-git folder simply can't be indexed — run inside the repo and it's valid.
 */
function isGitRepo(dir: string): boolean {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

const USAGE = `plex, local-first code review context

Run inside your repo. Commands default to the current git repo (an explicit [repoPath] still works).

Usage:
  plex init                                              # setup (run in your repo): embedding key + offer to index
  plex doctor [repoPath]                                 # check embeddings + graph
  plex index [--incremental]                             # index the current git repo (--incremental: only changed files, ADR-25)
  plex reconcile [repoPath] [--pr <n> | --staged | --branch <base>]   # auto-accept findings the push fixed (ADR-28)
  plex eval [repoPath]                                   # offline: how well does ranking match outcomes (nDCG)? measurement only
  plex blast [repoPath] --files <a.ts,b.ts>
  plex verdict <findingId> <accept|reject|waive|acknowledge> [--scope <s>] [--note <n>] [--repo <p>]
  plex verdicts [repoPath]
  plex consolidate [repoPath]                            # recompute pitfall confidence from recorded outcomes
  plex mine [repoPath] [--reset] [--all] [--oldest] [--limit <n>] [--threshold <0..1>] [--min-cluster <n>]  # mine PR history (--oldest = chronological)

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

/**
 * Run a slow step with a live spinner + elapsed time so the terminal never looks frozen
 * (indexing a large repo walks git history — it CAN take a minute). On a non-TTY (CI / piped)
 * it degrades to a single line, no escape codes. Pure-stdout, no dependency.
 */
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
    out.write('\r\x1b[K'); // clear the spinner line so the caller's summary starts clean
  }
}

/** One-command setup: optional embedding key (saved to config), then offer to index. The MCP is
 *  provided by the Plex plugin, so init does NOT register one — that avoids a duplicate `plex`
 *  server now that the plugin is the install path. */
async function runInit(repoPath: string): Promise<number> {
  const out = process.stdout;
  out.write('Plex setup (embedded: no Docker, no services).\n\n');

  // 1. Embedding key (optional). Saved to ~/.plex/config.json; the MCP server reads it at review time.
  out.write('An embedding key powers knowledge retrieval and the semantic review signals (optional).\n');
  const provider = (await ask('Embedding provider [voyage/openai/gemini/ollama/none] (voyage): ')) || 'voyage';
  if (provider !== 'none') {
    const apiKey = provider === 'ollama' ? undefined : await ask(`API key for ${provider} (Enter to skip): `);
    writeHomeConfig({ embedding: { provider: provider as never, ...(apiKey ? { apiKey } : {}) } });
    out.write(`Saved config to ${homeConfigPath()}\n`);
  }

  // 2. Index this repo, only inside a git repo (Plex needs git history for co-change). Reviews also
  //    auto-index on first use and refresh on drift, so this step is optional.
  if (!isGitRepo(repoPath)) {
    out.write('\nNot a git repo here, so skipping the index. Run `plex index` inside a repo later, or just review it (the first review auto-indexes).\n');
  } else if ((await ask('\nIndex this repo now? [Y/n]: ')).toLowerCase() !== 'n') {
    const res = await withSpinner(
      `Indexing ${path.basename(path.resolve(repoPath))} (the first index walks git history, so large repos take a moment)`,
      () => indexRepo(repoPath, loadConfig()),
    );
    out.write(`Indexed ${res.files} files, ${res.symbols} symbols, ${res.coChangePairs} co-change pairs.\n`);
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
    case 'doctor': {
      const repoPath = positionals[1] ?? process.cwd();
      const emb = embeddingReady(config);
      const graphed = existsSync(repoPaths(repoPath, config.dataDir).graphDir);
      const line = (ok: boolean, label: string, detail: string) =>
        process.stdout.write(`  ${ok ? '✓' : '○'} ${label.padEnd(12)} ${detail}\n`);
      process.stdout.write('plex doctor (embedded, no services)\n');
      line(emb, 'embeddings', emb ? `provider: ${config.embedding.provider}` : 'not configured (optional). run `plex init`');
      line(graphed, 'graph', graphed ? 'indexed' : 'not indexed. run `plex index` (reviews also auto-index)');
      return 0;
    }
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
    // `review` is intentionally OMITTED from USAGE. The CLI can only ASSEMBLE the review context
    // (assembleReviewContext) — it has no LLM, so it can't produce the first-principles findings a
    // real review needs, and a review MUST run in the isolated reviewer agent (anti-bias), not here.
    // The handler stays for the --html graph viz, --json context piping, and the brain E2E
    // (scripts/brain-check.mjs). Document it as a true headless `review` only once an API-key path
    // lets the CLI run the reasoning itself.
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
      if (typeof flags.html === 'string') {
        writeFileSync(flags.html, reviewContextToHtml(ctx));
        process.stdout.write(`Wrote neighborhood visualization to ${flags.html}\n`);
      }
      if (flags.json) process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
      else printReview(ctx);
      return 0;
    }
    case 'reconcile': {
      const repoPath = positionals[1] ?? process.cwd();
      const res = await reconcileOutcomes(repoPath, config, {
        source: flags.pr ? 'pr' : 'local',
        mode: flags.staged ? 'staged' : flags.branch ? 'branch' : undefined,
        baseRef: typeof flags.branch === 'string' ? flags.branch : undefined,
        pr: typeof flags.pr === 'string' ? flags.pr : undefined,
      });
      process.stdout.write(`Reconciled ${res.target}: ${res.accepted}/${res.checked} open finding(s) auto-accepted as fixed.\n`);
      process.stdout.write(`  ${res.reason}\n`); // always explain the outcome — esp. why accepted is 0
      // The audit trail: WHAT was accepted and WHICH signal matched — a locality false-accept
      // should be visible here, not a silent disappearance from the stream.
      for (const a of res.acceptedFindings ?? []) {
        process.stdout.write(`  ✓ ${a.title} (${a.file ?? '?'}:${a.line ?? '?'} — ${a.matchedBy})\n`);
      }
      return 0;
    }
    case 'eval': {
      const repoPath = positionals[1] ?? process.cwd();
      const q = await rankingQuality(repoPath, config);
      const verdictLabel = { 'not-yet': 'NOT YET', 'defaults-win': 'DEFAULTS ALREADY WIN', ready: 'READY' }[q.verdict];
      process.stdout.write(
        'plex ranking eval (offline — measurement only, no weights change)\n' +
          `  labeled findings: ${q.labeledFindings}  (${q.positives} positive / ${q.negatives} negative)\n` +
          `  evaluable rounds: ${q.evaluableRounds}\n` +
          `  mean nDCG:        ${q.meanNdcg == null ? 'n/a' : q.meanNdcg.toFixed(3)}\n` +
          `\n  re-weight (deferred #1): ${verdictLabel}\n` +
          `  ${q.note}\n`,
      );
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
    case 'verdict': {
      const findingId = positionals[1];
      const kind = positionals[2] as VerdictKind | undefined;
      if (!findingId || !kind || !['accept', 'reject', 'waive', 'acknowledge'].includes(kind)) {
        process.stderr.write('Usage: plex verdict <findingId> <accept|reject|waive|acknowledge> [--scope <s>]\n');
        return 1;
      }
      const repoPath = typeof flags.repo === 'string' ? flags.repo : process.cwd();
      const stored = await submitVerdict(
        repoPath,
        {
          findingId,
          kind,
          scope: typeof flags.scope === 'string' ? (flags.scope as WaiverScope) : undefined,
          note: typeof flags.note === 'string' ? flags.note : undefined,
          file: typeof flags.file === 'string' ? flags.file : undefined,
          line: typeof flags.line === 'string' ? Number(flags.line) : undefined,
          title: typeof flags.title === 'string' ? flags.title : undefined,
          pattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
          category: typeof flags.category === 'string' ? flags.category : undefined,
        },
        config,
      );
      process.stdout.write(`Recorded: ${JSON.stringify(stored)}\n`);
      return 0;
    }
    case 'verdicts': {
      const repoPath = positionals[1] ?? process.cwd();
      const list = await readVerdicts(repoPath, config);
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
      return 0;
    }
    case 'mine': {
      const repoPath = positionals[1] ?? process.cwd();
      const oldest = Boolean(flags.oldest);
      // `--oldest` needs the full PR list to find the chronological start, not just the
      // recent `maxPrs` window — raise the fetch ceiling so the oldest PRs are in view.
      if (oldest) config.mining.maxPrs = Math.max(config.mining.maxPrs, 1000);
      if (typeof flags.threshold === 'string') config.mining.clusterThreshold = Number(flags.threshold);
      if (typeof flags['min-cluster'] === 'string') config.mining.minClusterSize = Number(flags['min-cluster']);
      const res = await mineRepo(repoPath, config, {
        reset: Boolean(flags.reset),
        state: flags.all ? 'all' : 'merged',
        order: oldest ? 'oldest' : undefined,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
      });
      process.stdout.write(
        `Mined ${res.prsScanned} new PR(s) (total scanned: ${res.totalScanned}). ` +
          `${res.comments} comments → ${res.substantive} substantive → ${res.clusters} clusters → ` +
          `+${res.pitfalls} pitfalls, +${res.incidents} incidents. Distiller: ${res.distiller}.\n`,
      );
      return 0;
    }
    case 'consolidate': {
      const c = await consolidateKnowledge(config);
      process.stdout.write(`Consolidated ${c.reinforced}/${c.pitfalls} pitfall(s) from incident outcomes.\n`);
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
