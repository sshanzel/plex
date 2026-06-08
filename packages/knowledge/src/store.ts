import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pitfall, Incident } from '@plex/core';

/**
 * JSON-backed knowledge store (ADR-18). The knowledge base is small and retrieval is
 * embedding-based, so a flat append log of pitfalls + incidents is sufficient and avoids
 * compounding the Kùzu/tsx open-limit (ADR-17). Graduate to Kùzu if multi-hop graph
 * queries become necessary.
 */
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
      return []; // no file yet
    }
    // Parse PER LINE — a single corrupt record (e.g. a truncated final line from an
    // interrupted append) must not discard the whole store. Dropping all pitfalls here
    // would make consolidation rewrite an EMPTY log: silent, total data loss.
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
  /** Rewrite the whole pitfalls log (used by consolidation). */
  async replacePitfalls(pitfalls: Pitfall[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const body = pitfalls.length ? pitfalls.map((p) => JSON.stringify(p)).join('\n') + '\n' : '';
    // ATOMIC rewrite: write a temp sibling, then rename over the target. consolidation rewrites the
    // WHOLE log, so a crash mid-`writeFile` would truncate the live pitfalls.jsonl and silently lose
    // knowledge. `rename` within the same dir (same filesystem) is atomic on POSIX.
    const tmp = `${this.pitfallsFile}.tmp-${process.pid}`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.pitfallsFile);
  }
  addIncident(i: Incident): Promise<void> {
    return this.append(this.incidentsFile, i);
  }
  async hasPitfallTitled(title: string): Promise<boolean> {
    return (await this.pitfalls()).some((p) => p.title === title);
  }
}
