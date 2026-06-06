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
    try {
      const text = await fs.readFile(file, 'utf8');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
    } catch {
      return [];
    }
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
    const body = pitfalls.map((p) => JSON.stringify(p)).join('\n');
    await fs.writeFile(this.pitfallsFile, pitfalls.length ? body + '\n' : '', 'utf8');
  }
  addIncident(i: Incident): Promise<void> {
    return this.append(this.incidentsFile, i);
  }
  async hasPitfallTitled(title: string): Promise<boolean> {
    return (await this.pitfalls()).some((p) => p.title === title);
  }
}
