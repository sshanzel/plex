import type { Incident, Pitfall } from '@plex/core';

/**
 * The knowledge base **is** a graph (Pitfall ← Incident → Symbol/Finding); we just store it flat
 * (ADR-18) and assemble the graph **in memory** on demand. This module is that assembly: one O(N)
 * pass over the flat records into adjacency maps, plus traversal helpers — so callers stop
 * hand-rolling the same joins (`matchCodePath`, the viz symbol↔incident bridge, consolidation's
 * incident grouping each built their own). No engine, no I/O, no second store — the flat JSONL stays
 * the single source of truth; this is a derived view, rebuilt cheaply (microseconds at our scale).
 * Graduating to a real graph DB is the ADR-46/47 escape hatch only if traversals get deep or N
 * outgrows memory — neither is true today.
 *
 * **It reconciles the two-way link.** A `Pitfall→Incident` edge can be recorded from EITHER side:
 * forward (`pitfall.incidentIds`, how analyzed/distilled pitfalls link) or reverse
 * (`incident.pitfallId`, how live-review accept incidents link). Historically these diverged — e.g.
 * `consolidatePitfalls` only read the reverse side, so analyzed pitfalls' incidents were invisible to
 * it. The builder unions both directions, so every consumer sees the complete edge set.
 */
export interface KnowledgeGraph {
  pitfalls: Map<string, Pitfall>;
  incidents: Map<string, Incident>;
  /** pitfallId → its incident ids (forward `incidentIds` ∪ reverse `pitfallId`, deduped). */
  incidentsOfPitfall: Map<string, Set<string>>;
  /** incidentId → the pitfall ids it belongs to (reverse of the above). */
  pitfallsOfIncident: Map<string, Set<string>>;
  /** `symbolKey(file,name)` → incident ids anchored there (code-path memory, ADR-47). */
  incidentsAtSymbol: Map<string, string[]>;
  /** file → incident ids in it (the coarse fallback + co-change propagation lookup). */
  incidentsInFile: Map<string, string[]>;
  /** brain `findingId` → incident ids confirmed from it (ADR-46 provenance). */
  incidentsOfFinding: Map<string, string[]>;
}

const pushArr = <K>(m: Map<K, string[]>, k: K, v: string): void => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};
const addSet = <K>(m: Map<K, Set<string>>, k: K, v: string): void => {
  const s = m.get(k);
  if (s) s.add(v);
  else m.set(k, new Set([v]));
};

/** Assemble the in-memory knowledge graph from flat records. Pure; O(pitfalls + incidents). */
export function buildKnowledgeGraph(pitfalls: Pitfall[], incidents: Incident[]): KnowledgeGraph {
  const g: KnowledgeGraph = {
    pitfalls: new Map(),
    incidents: new Map(),
    incidentsOfPitfall: new Map(),
    pitfallsOfIncident: new Map(),
    incidentsAtSymbol: new Map(),
    incidentsInFile: new Map(),
    incidentsOfFinding: new Map(),
  };
  for (const i of incidents) {
    g.incidents.set(i.id, i);
    if (i.symbol) pushArr(g.incidentsAtSymbol, i.symbol, i.id);
    if (i.file) pushArr(g.incidentsInFile, i.file, i.id);
    if (i.findingId) pushArr(g.incidentsOfFinding, i.findingId, i.id);
    if (i.pitfallId) {
      addSet(g.incidentsOfPitfall, i.pitfallId, i.id); // reverse link
      addSet(g.pitfallsOfIncident, i.id, i.pitfallId);
    }
  }
  for (const p of pitfalls) {
    g.pitfalls.set(p.id, p);
    for (const id of p.incidentIds ?? []) {
      if (!g.incidents.has(id)) continue; // skip a dangling incidentId (never invent a phantom edge)
      addSet(g.incidentsOfPitfall, p.id, id); // forward link, unioned with the reverse above
      addSet(g.pitfallsOfIncident, id, p.id);
    }
  }
  return g;
}

const resolve = (g: KnowledgeGraph, ids: Iterable<string> | undefined): Incident[] => {
  if (!ids) return [];
  const out: Incident[] = [];
  for (const id of ids) {
    const i = g.incidents.get(id);
    if (i) out.push(i);
  }
  return out;
};

/** All incidents linked to a pitfall (both link directions) — its full history / provenance. */
export const historyOf = (g: KnowledgeGraph, pitfallId: string): Incident[] => resolve(g, g.incidentsOfPitfall.get(pitfallId));

/** Incidents anchored at a symbol (`symbolKey(file, name)`) — "what's been flagged here". */
export const concernsAt = (g: KnowledgeGraph, symbolKey: string): Incident[] => resolve(g, g.incidentsAtSymbol.get(symbolKey));

/** Incidents recorded anywhere in a file — the coarse fallback + the co-change-neighbour lookup. */
export const concernsInFile = (g: KnowledgeGraph, file: string): Incident[] => resolve(g, g.incidentsInFile.get(file));

/** The pitfalls an incident belongs to (reverse of `historyOf`). */
export const pitfallsOf = (g: KnowledgeGraph, incidentId: string): Pitfall[] => {
  const ids = g.pitfallsOfIncident.get(incidentId);
  if (!ids) return [];
  const out: Pitfall[] = [];
  for (const id of ids) {
    const p = g.pitfalls.get(id);
    if (p) out.push(p);
  }
  return out;
};
