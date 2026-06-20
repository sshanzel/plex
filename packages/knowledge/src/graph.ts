import type { Incident, Pitfall } from '@plex/core';

/**
 * In-memory assembly of the flat-stored (ADR-18) knowledge graph (Pitfall ← Incident → Symbol/Finding):
 * one O(N) pass into adjacency maps + traversal helpers, so callers stop hand-rolling the same joins.
 * INVARIANT: reconciles the two-way `Pitfall→Incident` link — forward (`pitfall.incidentIds`, analyzed/
 * distilled) ∪ reverse (`incident.pitfallId`, live accepts) — so every consumer sees the complete edge set.
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
      addSet(g.incidentsOfPitfall, i.pitfallId, i.id);
      addSet(g.pitfallsOfIncident, i.id, i.pitfallId);
    }
  }
  for (const p of pitfalls) {
    g.pitfalls.set(p.id, p);
    for (const id of p.incidentIds ?? []) {
      if (!g.incidents.has(id)) continue; // skip a dangling incidentId (never invent a phantom edge)
      addSet(g.incidentsOfPitfall, p.id, id);
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
