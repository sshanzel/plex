/**
 * plex CLI. Thin wrapper over @plex/engine for humans; the MCP server is the
 * path for agents. Commands: index, review, blast, verdict, verdicts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  loadConfig,
  repoPaths,
  indexRepo,
  installHooks,
  uninstallHooks,
  assembleReviewContext,
  blastRadius,
  reconcileOutcomes,
  submitVerdict,
  readVerdicts,
  seedKnowledge,
  consolidateKnowledge,
  embeddingReady,
  getPromotions,
  reviewContextToHtml,
  mineRepo,
  readHomeConfig,
  writeHomeConfig,
  homeConfigPath,
  dockerAvailable,
  falkorUp,
  falkorDown,
  falkorReachable,
  type ReviewContext,
} from '@plex/engine';
import type { VerdictKind, WaiverScope } from '@plex/core';

type LocalDiffMode = 'working' | 'staged' | 'branch';

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const USAGE = `plex — local-first code review context

Usage:
  plex init [repoPath]                                   # one-command setup: FalkorDB + key + MCP + index
  plex doctor [repoPath]                                 # check FalkorDB / embeddings / graph
  plex up | down                                         # start / stop the FalkorDB container
  plex index [repoPath] [--incremental]                  # --incremental: refresh only changed files (ADR-25)
  plex install-hooks [repoPath]                          # auto-incremental-index on pull/checkout/rebase
  plex uninstall-hooks [repoPath]
  plex review [repoPath] [--staged | --branch <base>] [--pr <n>] [--falkor] [--json] [--html <file>]
  plex reconcile [repoPath] [--pr <n> | --staged | --branch <base>] [--falkor]   # auto-accept findings the push fixed (ADR-28)
  plex blast [repoPath] --files <a.ts,b.ts>
  plex verdict <findingId> <accept|reject|waive> [--scope <s>] [--note <n>] [--repo <p>]
  plex verdicts [repoPath]
  plex seed [repoPath] [--file <markdown>]
  plex mine [repoPath] [--reset] [--all] [--limit <n>]   # mine PR-review history into pitfalls (incremental)

Env: PLEX_DATA_DIR, PLEX_KNOWLEDGE_DIR, PLEX_FALKORDB_URL, PLEX_EMBEDDING_PROVIDER`;

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
  if (ctx.reviewerMd) {
    out.push('');
    out.push('plex.md (project guidance):');
    out.push(ctx.reviewerMd.split('\n').map((l) => `  ${l}`).join('\n'));
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
  if (ctx.ephemeralGraph) {
    out.push('');
    out.push(`FalkorDB brain: ${ctx.ephemeralGraph} (inspect in FalkorDB Browser)`);
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

/** One-command setup (ADR-29): FalkorDB up, prompt provider+key → config, register MCP, index. */
async function runInit(repoPath: string): Promise<number> {
  const out = process.stdout;
  out.write('Plex setup\n\n');

  // 1. FalkorDB (auto-manage via Docker, else prompt for a remote URL).
  let url = process.env.PLEX_FALKORDB_URL ?? readHomeConfig().falkordb?.url ?? 'redis://localhost:56379';
  if (dockerAvailable()) {
    const port = Number((/:(\d+)\b/.exec(url) ?? [])[1] ?? 56379);
    const r = falkorUp(port);
    if (r.ok) { url = r.url; out.write(`✓ FalkorDB ${r.detail} at ${url}\n`); }
    else out.write(`! FalkorDB via Docker failed (${r.detail}).\n`);
  } else {
    out.write('! Docker not found — Plex needs FalkorDB for the review brain.\n');
    const remote = await ask(`  FalkorDB URL (or install Docker and re-run) [${url}]: `);
    if (remote) url = remote;
  }
  out.write((await falkorReachable(url)) ? '✓ FalkorDB reachable\n\n' : `! not reachable at ${url} — continuing\n\n`);

  // 2. Embedding provider + key (stored once in ~/.plex/config.json).
  const provider = (await ask('Embedding provider [voyage/openai/gemini/ollama] (voyage): ')) || 'voyage';
  const apiKey = provider === 'ollama' ? undefined : await ask(`API key for ${provider}: `);
  writeHomeConfig({ falkordb: { url }, embedding: { provider: provider as never, ...(apiKey ? { apiKey } : {}) } });
  out.write(`✓ Saved config to ${homeConfigPath()}\n`);

  // 3. Register the MCP with Claude Code (reads the config file — no secrets in the registration).
  const mcpEntry = path.join(path.dirname(process.argv[1] ?? ''), 'plex-mcp.js');
  if (existsSync(mcpEntry)) {
    spawnSync('claude', ['mcp', 'remove', 'plex'], { stdio: 'ignore' });
    const reg = spawnSync('claude', ['mcp', 'add', 'plex', '--', 'node', mcpEntry], { stdio: 'ignore' });
    out.write(reg.status === 0 ? '✓ Registered Plex MCP with Claude Code\n' : `! Auto-register failed — run: claude mcp add plex -- node ${mcpEntry}\n`);
  } else {
    out.write('! MCP entry not found beside the CLI — register it manually.\n');
  }

  // 4. Index this repo + auto-refresh hooks.
  if ((await ask('\nIndex this repo now? [Y/n]: ')).toLowerCase() !== 'n') {
    await indexRepo(repoPath, loadConfig());
    try { installHooks(repoPath, process.argv[1] ?? 'plex'); } catch { /* not a git repo */ }
    out.write('✓ Indexed + installed auto-index hooks\n');
  }
  out.write('\nDone. Restart Claude Code, then ask it to "review my changes with Plex".\n');
  return 0;
}

async function main(): Promise<number> {
  const { positionals, flags } = parse(process.argv.slice(2));
  const command = positionals[0];
  const config = loadConfig();

  switch (command) {
    case 'init':
      return runInit(positionals[1] ?? process.cwd());
    case 'up': {
      const r = falkorUp();
      process.stdout.write(r.ok ? `✓ FalkorDB ${r.detail} at ${r.url}\n` : `! FalkorDB: ${r.detail}\n`);
      return r.ok ? 0 : 1;
    }
    case 'down': {
      process.stdout.write(falkorDown() ? '✓ FalkorDB stopped\n' : '! could not stop FalkorDB (not running?)\n');
      return 0;
    }
    case 'doctor': {
      const repoPath = positionals[1] ?? process.cwd();
      const reachable = await falkorReachable(config.falkordb.url);
      const emb = embeddingReady(config);
      const graphed = existsSync(repoPaths(repoPath, config.dataDir).graphDir);
      const line = (ok: boolean, label: string, detail: string) =>
        process.stdout.write(`  ${ok ? '✓' : '✗'} ${label.padEnd(12)} ${detail}\n`);
      process.stdout.write('plex doctor\n');
      line(dockerAvailable(), 'docker', dockerAvailable() ? 'available' : 'not found (needed to auto-manage FalkorDB)');
      line(reachable, 'falkordb', reachable ? config.falkordb.url : `unreachable at ${config.falkordb.url} — run \`plex up\``);
      line(emb, 'embeddings', emb ? `provider: ${config.embedding.provider}` : 'not configured — run `plex init`');
      line(graphed, 'graph', graphed ? 'indexed' : 'not indexed — run `plex index`');
      return reachable && emb && graphed ? 0 : 1;
    }
    case 'index': {
      const repoPath = positionals[1] ?? process.cwd();
      const res = await indexRepo(repoPath, config, { incremental: Boolean(flags.incremental) });
      if (res.incremental) {
        process.stdout.write(
          `Incrementally updated ${res.files} file(s) (+${res.added ?? 0} ~${res.modified ?? 0} -${res.deleted ?? 0}): ` +
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
    case 'install-hooks': {
      const repoPath = positionals[1] ?? process.cwd();
      const cliPath = process.argv[1] ?? path.resolve('dist/plex.js');
      const res = installHooks(repoPath, cliPath);
      process.stdout.write(
        `Installed auto-index git hooks (${res.hooks.join(', ')}) in ${res.hooksDir}.\n` +
          `The graph now refreshes incrementally on pull / checkout / rebase.\n`,
      );
      return 0;
    }
    case 'uninstall-hooks': {
      const repoPath = positionals[1] ?? process.cwd();
      const res = uninstallHooks(repoPath);
      process.stdout.write(
        res.hooks.length
          ? `Removed plex auto-index from hooks: ${res.hooks.join(', ')}.\n`
          : `No plex auto-index hooks found.\n`,
      );
      return 0;
    }
    case 'review': {
      const repoPath = positionals[1] ?? process.cwd();
      const mode: LocalDiffMode | undefined = flags.staged
        ? 'staged'
        : flags.branch
          ? 'branch'
          : undefined;
      const useFalkor = Boolean(flags.falkor);
      if (useFalkor) config.falkordb.enabled = true;
      const ctx = await assembleReviewContext({
        repoPath,
        config,
        source: flags.pr ? 'pr' : 'local',
        mode,
        baseRef: typeof flags.branch === 'string' ? flags.branch : undefined,
        pr: typeof flags.pr === 'string' ? flags.pr : undefined,
        publishFalkor: useFalkor,
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
      if (flags.falkor) config.falkordb.enabled = true;
      const res = await reconcileOutcomes(repoPath, config, {
        source: flags.pr ? 'pr' : 'local',
        mode: flags.staged ? 'staged' : flags.branch ? 'branch' : undefined,
        baseRef: typeof flags.branch === 'string' ? flags.branch : undefined,
        pr: typeof flags.pr === 'string' ? flags.pr : undefined,
      });
      process.stdout.write(`Reconciled ${res.target}: ${res.accepted}/${res.checked} open finding(s) auto-accepted as fixed.\n`);
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
      if (!findingId || !kind || !['accept', 'reject', 'waive'].includes(kind)) {
        process.stderr.write('Usage: plex verdict <findingId> <accept|reject|waive> [--scope <s>]\n');
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
      if (typeof flags.limit === 'string') config.mining.maxPrs = Number(flags.limit);
      const res = await mineRepo(repoPath, config, {
        reset: Boolean(flags.reset),
        state: flags.all ? 'all' : 'merged',
      });
      process.stdout.write(
        `Mined ${res.prsScanned} new PR(s) (total scanned: ${res.totalScanned}). ` +
          `${res.comments} comments → ${res.substantive} substantive → ${res.clusters} clusters → ` +
          `+${res.pitfalls} pitfalls, +${res.incidents} incidents. Distiller: ${res.distiller}.\n`,
      );
      return 0;
    }
    case 'seed': {
      const repoPath = positionals[1] ?? process.cwd();
      const file = typeof flags.file === 'string' ? flags.file : path.join(repoPath, 'plex.md');
      if (!existsSync(file)) {
        process.stderr.write(`No markdown to seed from (${file}). Pass --file <path>.\n`);
        return 1;
      }
      const added = await seedKnowledge(config, readFileSync(file, 'utf8'));
      process.stdout.write(`Seeded ${added} pitfall(s) from ${file} into ${config.knowledgeDir}\n`);
      return 0;
    }
    case 'promote': {
      const repoPath = positionals[1] ?? process.cwd();
      const c = await consolidateKnowledge(config);
      const mdFile = path.join(repoPath, 'plex.md');
      const existing = existsSync(mdFile) ? readFileSync(mdFile, 'utf8') : '';
      const promo = await getPromotions(config, existing);
      const out: string[] = [`Consolidated ${c.reinforced}/${c.pitfalls} pitfall(s) from incident outcomes.`];
      if (promo.markdown.length) {
        out.push('', 'Suggested plex.md additions:', ...promo.markdown.map((l) => `  ${l}`));
      }
      if (promo.rules.length) {
        out.push('', 'Suggested ast-grep rule stubs:', ...promo.rules.map((r) => r.split('\n').map((l) => `  ${l}`).join('\n')));
      }
      if (!promo.markdown.length && !promo.rules.length) out.push('No promotions suggested yet.');
      process.stdout.write(out.join('\n') + '\n');
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
