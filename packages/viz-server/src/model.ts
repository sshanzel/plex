/**
 * The uniform graph shape the UI consumes, regardless of which store it came from. A `VizNode`'s
 * `props` is a flat, JSON-safe record shown verbatim in the detail panel — collectors must strip
 * heavy/secret fields (e.g. a pitfall's embedding vector) before they land here.
 */
export type GraphKind = 'code' | 'brain' | 'knowledge' | 'lineage';

export interface VizNode {
  id: string;
  label: string;
  /** Node type within its graph — drives colour/shape and the panel header (e.g. File, Finding, Pitfall). */
  type: string;
  graph: GraphKind;
  props: Record<string, string | number | boolean>;
}

export interface VizEdge {
  id: string;
  source: string;
  target: string;
  /** Relationship label — provenance for code edges (import/ref/co-change), role for brain/knowledge. */
  label: string;
  graph: GraphKind;
  /**
   * True for a **heuristic correlation** edge, not a recorded link — drawn dashed in the UI. The
   * lineage view bridges the brain and knowledge stores by locality (same file) because, in Tier 1,
   * an Incident carries no hard back-reference to the Finding it came from. Tier 2 (the durable
   * lineage journal) replaces these with exact, recorded edges.
   */
  inferred?: boolean;
}

export interface GraphPayload {
  graph: GraphKind;
  nodes: VizNode[];
  edges: VizEdge[];
  /** True when a node cap was hit — surfaced in the UI so a partial graph never reads as complete. */
  truncated: boolean;
  /** Per-type node counts (after the cap) — drives the legend. */
  counts: Record<string, number>;
  /** Human note when a store is absent ("not indexed") or capped. */
  note?: string;
}

export const emptyPayload = (graph: GraphKind, note?: string): GraphPayload => ({
  graph,
  nodes: [],
  edges: [],
  truncated: false,
  counts: {},
  note,
});

/** Tally `counts` from the collected nodes — single place so every collector reports consistently. */
export function withCounts(payload: GraphPayload): GraphPayload {
  const counts: Record<string, number> = {};
  for (const n of payload.nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  payload.counts = counts;
  return payload;
}
