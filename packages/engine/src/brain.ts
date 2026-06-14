import {
  type ReviewerConfig,
  type ReviewRound,
  type PrComment,
  type RankedFinding,
  type VerdictKind,
  type WaiverScope,
  type LineageEvent,
  type LineageView,
  foldLineage,
  parseLineageEvents,
} from '@plex/core';
import { mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { normalizeTitle } from '@plex/findings';
import { lineagePaths } from './paths';

/**
 * The per-PR "brain" — the **lineage layer** of the knowledge graph (ADR-46). Replaces the ephemeral,
 * per-worktree Kùzu DB (ADR-30/M11) with a **durable, base-keyed, append-only JSONL event log**:
 * round/finding/verdict/comment events under the BASE repo's centralized data dir
 * (`~/.plex/repos/<baseId>/lineage/<target>.jsonl`, via `lineagePaths`), folded into current state by
 * the pure `foldLineage` (`@plex/core`). So a worktree review's history **survives `git worktree
 * remove`**, the sweeper reads the same durable file the worktree wrote, and — because the target is
 * base-derived — the brain can no longer split across worktree names (`healSplitTarget` retired).
 *
 * The public method surface is unchanged from the Kùzu brain, so callers (review/findings/knowledge/
 * reconcile/sweep) are untouched. `close()` is a no-op (no handle to release). Idempotent reads: the
 * log is append-only, but `foldLineage` is last-write-wins per id, so a re-recorded round/finding/
 * comment collapses; outcome is tracked orthogonally so a re-raised finding never resets a `fixed`
 * disposition (ADR-28).
 */

const excerpt = (s: string, n = 60): string => (s.length > n ? s.slice(0, n) + '…' : s);

export interface RoundSummary {
  n: number;
  ts: string;
  headSha?: string;
}

/** A prior finding/comment whose text the engine embeds for semantic change attribution. */
export interface BrainSignal {
  text: string;
  label: string;
  file?: string;
}

/** A prior-round finding with identity, for autonomous outcome inference (ADR-28). */
export interface BrainFinding {
  id: string;
  file?: string;
  line?: number;
  title: string;
  severity?: string;
  /** Deterministic rule tag — lets an inferred accept refute a learned suppression (ADR-39). */
  rule?: string;
}

/** One finding's ranking `signal` + features + resolved outcome — the offline ranking-eval row. */
export interface RankingSample {
  target: string;
  round: number;
  id: string;
  signal: number;
  outcome: string;
  severity: string;
  confidence: number;
  blast: number;
  prevalence: number;
  agreement: number;
}

export interface RoundState {
  lastN: number;
  lastHeadSha?: string;
  rounds: RoundSummary[];
  signals: BrainSignal[];
  priorFindings: BrainFinding[];
}

export class Brain {
  private readonly lineageDir: string;
  private readonly fileFor: (target: string) => string;

  private constructor(p: { lineageDir: string; fileFor: (target: string) => string }) {
    this.lineageDir = p.lineageDir;
    this.fileFor = p.fileFor;
  }

  /** Open the base repo's durable lineage store (creates the dir). No DB handle — `close()` is a no-op. */
  static async open(repoPath: string, config: ReviewerConfig): Promise<Brain> {
    const lp = lineagePaths(repoPath, config.dataDir);
    mkdirSync(lp.lineageDir, { recursive: true });
    return new Brain(lp);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async close(): Promise<void> {
    /* no handle to release — the lineage log is plain files */
  }

  private append(target: string, event: LineageEvent): void {
    // One JSON object per line; a single small `write` is atomic enough for concurrent appends, and
    // per-target files keep two worktrees reviewing different PRs off each other's file.
    appendFileSync(this.fileFor(target), JSON.stringify(event) + '\n', 'utf8');
  }

  private view(target: string): LineageView {
    try {
      return foldLineage(parseLineageEvents(readFileSync(this.fileFor(target), 'utf8')));
    } catch {
      return foldLineage([]); // no file yet → empty view
    }
  }

  /** Every target's view (one file = one target) — for the cross-target reads. */
  private allViews(): Array<{ target: string; view: LineageView }> {
    let files: string[];
    try {
      files = readdirSync(this.lineageDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out: Array<{ target: string; view: LineageView }> = [];
    for (const f of files) {
      try {
        const events = parseLineageEvents(readFileSync(path.join(this.lineageDir, f), 'utf8'));
        if (events.length === 0) continue;
        out.push({ target: events[0]!.target, view: foldLineage(events) });
      } catch {
        /* skip an unreadable file */
      }
    }
    return out;
  }

  /** Load prior rounds + the signals/findings used for change attribution & fix inference. */
  async loadRoundState(target: string): Promise<RoundState> {
    const v = this.view(target);
    const rounds: RoundSummary[] = v.rounds.map((r) => ({ n: r.n, ts: r.ts, headSha: r.headSha || undefined }));
    const last = rounds[rounds.length - 1];
    const signals: BrainSignal[] = [
      ...v.findings.map((f) => ({ text: f.title, file: f.file || undefined, label: `finding: ${excerpt(f.title)}` })).filter((s) => s.text),
      ...v.comments.map((c) => ({ text: c.body, file: c.file || undefined, label: `comment: ${excerpt(c.body)}` })).filter((s) => s.text),
    ];
    const priorFindings: BrainFinding[] = v.findings
      .filter((f) => !v.outcomeOf(f.id)) // un-outcomed
      .map((f) => ({ id: f.id, file: f.file || undefined, line: f.line < 0 ? undefined : f.line, title: f.title, severity: f.severity || undefined, rule: f.rule || undefined }))
      .filter((f) => f.id && f.title);
    return { lastN: last?.n ?? 0, lastHeadSha: last?.headSha, rounds, signals, priorFindings };
  }

  /**
   * Targets with ≥1 OPEN (un-outcomed, non-`awareness`) finding AND a recorded round — the sweep's
   * work list (ADR-43). Now durable + base-keyed, so the sweep sees a worktree's open findings even
   * after the worktree is gone. `awareness` is excluded (never auto-accepted, ADR-31).
   */
  async openTargets(): Promise<Array<{ target: string; lastHeadSha?: string; baseRef?: string }>> {
    const out: Array<{ target: string; lastHeadSha?: string; baseRef?: string }> = [];
    for (const { target, view } of this.allViews()) {
      if (!target) continue;
      const hasOpen = view.findings.some((f) => !view.outcomeOf(f.id) && f.severity !== 'awareness');
      if (!hasOpen) continue;
      const last = view.rounds[view.rounds.length - 1];
      if (!last) continue; // no round → no head cursor → can't diff; skip
      out.push({ target, lastHeadSha: last.headSha || undefined, baseRef: last.baseRef || undefined });
    }
    return out;
  }

  /**
   * Every finding's ranking `signal` paired with its resolved outcome — the offline ranking-quality
   * eval (tuning.md §5). Outcome is the explicit Verdict kind if one exists, else the inferred
   * `outcome` event. Across all targets in this base's lineage.
   */
  async rankingSamples(): Promise<RankingSample[]> {
    const samples: RankingSample[] = [];
    for (const { target, view } of this.allViews()) {
      const kindByFinding = new Map(view.verdicts.map((vd) => [vd.findingId, vd.kind]));
      for (const f of view.findings) {
        samples.push({
          target,
          round: f.round || 0,
          id: f.id,
          signal: f.signal || 0,
          outcome: kindByFinding.get(f.id) || view.outcomeOf(f.id) || '',
          severity: f.severity,
          confidence: f.confidence || 0,
          blast: f.blast || 0,
          prevalence: f.prevalence || 0,
          agreement: f.agreement || 0,
        });
      }
    }
    return samples;
  }

  async recordRound(target: string, round: ReviewRound, comments: PrComment[]): Promise<void> {
    this.append(target, { k: 'round', target, n: round.n, ts: round.ts, headSha: round.headSha ?? '', baseRef: round.baseRef });
    for (const c of comments) {
      this.append(target, { k: 'comment', target, id: `${target}#${c.id}`, body: c.body, author: c.author ?? '', file: c.file ?? '', line: c.line ?? -1 });
    }
  }

  /** Persist the agent's ranked findings. Id is keyed by target+file:line+title — NOT round (ADR-28),
   *  so a re-raised finding is the SAME node and its accrued outcome (a separate `outcome` event) is
   *  never reset. */
  async writeFindings(target: string, roundN: number, findings: RankedFinding[]): Promise<void> {
    for (const f of findings) {
      this.append(target, {
        k: 'finding',
        target,
        id: `${target}#${f.location.file}:${f.location.startLine}#${normalizeTitle(f.title)}`,
        title: f.title,
        severity: f.severity,
        confidence: f.confidence,
        signal: f.signal,
        source: f.source,
        file: f.location.file,
        line: f.location.startLine,
        triage: f.triage,
        round: roundN,
        // Raw ranking features (tuning.md §"feature persistence"). agreement = #independent sources (min 1).
        blast: f.blastRadius ?? 0,
        prevalence: f.prevalence ?? 0,
        agreement: f.agreedSources?.length ?? 1,
        rule: f.tags?.[0] ?? '', // the deterministic rule tag — lets an inferred accept refute a suppression (ADR-39)
      });
    }
  }

  async writeVerdict(
    target: string,
    verdict: { findingId: string; kind: VerdictKind; scope?: WaiverScope; title?: string; file?: string; line?: number; ts: string },
  ): Promise<void> {
    this.append(target, {
      k: 'verdict',
      target,
      findingId: verdict.findingId ?? '',
      kind: verdict.kind,
      scope: verdict.scope ?? '',
      ts: verdict.ts,
      title: verdict.title ?? '',
      file: verdict.file ?? '',
      line: verdict.line ?? -1,
    });
  }

  /** Mark a finding with an inferred outcome so it isn't re-evaluated (ADR-28). The target is the id's
   *  prefix (`<target>#…`), so no separate target arg is needed; an empty id is a no-op (#4 guard). */
  async markFindingOutcome(findingId: string, outcome: string): Promise<void> {
    if (!findingId) return;
    const hash = findingId.indexOf('#');
    const target = hash > 0 ? findingId.slice(0, hash) : '';
    if (!target) return;
    this.append(target, { k: 'outcome', target, findingId, outcome });
  }
}
