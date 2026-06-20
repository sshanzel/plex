import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pitfall, Incident } from '@plex/core';

/** JSON-backed knowledge store (ADR-18): a flat append log of pitfalls + incidents. */
export class KnowledgeStore {
  constructor(private readonly dir: string) {}

  private get pitfallsFile(): string {
    return path.join(this.dir, 'pitfalls.jsonl');
  }
  private get incidentsFile(): string {
    return path.join(this.dir, 'incidents.jsonl');
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return [];
    }
    // Parse PER LINE — a single corrupt record must not discard the whole store (consolidation would
    // then rewrite an EMPTY log: silent, total data loss).
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip the corrupt line, keep the rest */
      }
    }
    return out;
  }
  private async append(file: string, record: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  }

  pitfalls(): Promise<Pitfall[]> {
    return this.readJsonl<Pitfall>(this.pitfallsFile);
  }
  incidents(): Promise<Incident[]> {
    return this.readJsonl<Incident>(this.incidentsFile);
  }
  addPitfall(p: Pitfall): Promise<void> {
    return this.append(this.pitfallsFile, p);
  }
  async replacePitfalls(pitfalls: Pitfall[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const body = pitfalls.length ? pitfalls.map((p) => JSON.stringify(p)).join('\n') + '\n' : '';
    // ATOMIC rewrite: write a temp sibling, then `rename` over the target (atomic on POSIX, same FS) —
    // a crash mid-`writeFile` would otherwise truncate the live log and silently lose knowledge.
    const tmp = `${this.pitfallsFile}.tmp-${process.pid}`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.pitfallsFile);
  }
  addIncident(i: Incident): Promise<void> {
    return this.append(this.incidentsFile, i);
  }
  /**
   * Atomically rewrite the whole incident log — the outcome-backfill writer (ADR-50; atomic temp+rename
   * like `replacePitfalls`). INVARIANT: callers MUST pass the FULL set read via `incidents()` — a
   * filter-then-replace would silently drop the rest, including non-re-derivable live `accept`s.
   */
  async replaceIncidents(incidents: Incident[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const body = incidents.length ? incidents.map((i) => JSON.stringify(i)).join('\n') + '\n' : '';
    const tmp = `${this.incidentsFile}.tmp-${process.pid}`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.incidentsFile);
  }
  async hasPitfallTitled(title: string): Promise<boolean> {
    return (await this.pitfalls()).some((p) => p.title === title);
  }
}
