import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pitfall } from '@plex/core';
import { KnowledgeStore } from './store';
import { FakeEmbeddingProvider } from './embeddings';
import { retrieveRelevant, retrieveRelevantLexical } from './retrieve';

/**
 * RETRIEVAL QUALITY FLOOR — a fixed, labeled benchmark (docs/design/evals.md).
 *
 * A small pitfall corpus + queries shaped like the real retrieval query
 * (`buildKnowledgeQuery`: changed symbols + deterministic titles + file paths), each labeled
 * with the pitfall it SHOULD retrieve. recall@3 must clear a floor on both paths:
 * lexical (key-less installs) and hybrid-with-embeddings (FakeEmbeddingProvider — a
 * deterministic bag-of-words stand-in; real-model quality is measured live, not here).
 * A tokenizer/scoring change that quietly stops surfacing relevant pitfalls fails HERE.
 */

const P = (id: string, title: string, why: string, category: string): Pitfall => ({
  id, title, trigger: title, why, category,
  tier: 'judgmental', confidence: 0.6, incidentIds: [],
});

const CORPUS: Pitfall[] = [
  P('pf-tenant', 'always filter database queries by tenant id', 'cross-tenant data leaks', 'security'),
  P('pf-retry', 'unbounded retry loops need backoff and a cap', 'retry storms take down dependencies', 'reliability'),
  P('pf-tz', 'parse dates as UTC, never the server local timezone', 'reports drift across regions', 'correctness'),
  P('pf-await', 'avoid awaiting promises sequentially inside loops', 'serialized IO is a hidden perf cliff', 'performance'),
  P('pf-secrets', 'never log request headers — they carry auth tokens', 'tokens end up in log aggregators', 'security'),
  P('pf-migration', 'schema migrations must be backwards compatible one release', 'old pods crash on new columns', 'database'),
  P('pf-cache', 'invalidate the user cache on permission changes', 'stale permissions outlive revocation', 'security'),
  P('pf-stream', 'close file streams in finally blocks', 'descriptor leaks under load', 'reliability'),
  P('pf-float', 'never compare currency amounts with floating point equality', 'rounding drift loses cents', 'correctness'),
  P('pf-batch', 'cap batch sizes when embedding or bulk-inserting', 'oversized batches hit provider limits', 'reliability'),
  P('pf-lock', 'acquire locks in a fixed global order', 'lock inversion deadlocks the worker pool', 'concurrency'),
  P('pf-input', 'validate webhook payloads against the schema before use', 'malformed payloads reach business logic', 'security'),
];

// PARAPHRASED queries shaped like buildKnowledgeQuery output (symbols + finding titles +
// files) that do NOT simply reuse the pitfall's title words — the realistic, harder case.
const QUERIES: { query: string; expect: string }[] = [
  { query: 'listUsers getTenantQuery src/db/users.ts missing tenant filter on the users query', expect: 'pf-tenant' },
  { query: 'retryFetch withBackoff src/net/client.ts retries forever when the upstream is down', expect: 'pf-retry' },
  { query: 'parseReportDate src/reports/daily.ts date parsed in local timezone breaks UTC reports', expect: 'pf-tz' },
  { query: 'exportRows uploadChunk src/export/run.ts await inside the export loop serializes uploads', expect: 'pf-await' },
  { query: 'logRequest middleware src/http/log.ts request headers logged including authorization', expect: 'pf-secrets' },
  { query: 'addColumn migration 0042 src/db/migrations/0042.ts drops a column old releases still read', expect: 'pf-migration' },
  { query: 'comparePrice checkout src/billing/total.ts currency compared with === on floats', expect: 'pf-float' },
  { query: 'handleWebhook src/hooks/stripe.ts payload used without schema validation', expect: 'pf-input' },
];

// WORD-OVERLAPPING queries (title vocabulary + symbol/file noise) — achievable by a
// bag-of-words embedder. The hybrid bench runs on these because FakeEmbeddingProvider has
// no semantics: it guards the retrieval PLUMBING (scores flow, topK, scope, ranking),
// while real-model semantic quality is a LIVE measurement (docs/design/evals.md §live).
const EASY_QUERIES: { query: string; expect: string }[] = [
  { query: 'src/db/users.ts listUsers filter database queries by tenant id', expect: 'pf-tenant' },
  { query: 'src/net/client.ts retryFetch unbounded retry loops without backoff or a cap', expect: 'pf-retry' },
  { query: 'src/reports/daily.ts parse dates as UTC not the server local timezone', expect: 'pf-tz' },
  { query: 'src/export/run.ts awaiting promises sequentially inside loops exportRows', expect: 'pf-await' },
  { query: 'src/http/log.ts logging request headers that carry auth tokens', expect: 'pf-secrets' },
  { query: 'src/db/migrations/0042.ts schema migrations backwards compatible one release', expect: 'pf-migration' },
  { query: 'src/billing/total.ts compare currency amounts floating point equality', expect: 'pf-float' },
  { query: 'src/hooks/stripe.ts validate webhook payloads against the schema', expect: 'pf-input' },
];

const K = 3;
const LEXICAL_RECALL_FLOOR = 7 / 8;
const HYBRID_RECALL_FLOOR = 7 / 8;

let dir: string;
let store: KnowledgeStore;
const provider = new FakeEmbeddingProvider();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kq-'));
  store = new KnowledgeStore(dir);
  for (const p of CORPUS) {
    const [embedding] = await provider.embed([`${p.category}: ${p.title}\n${p.why}`]);
    await store.addPitfall({ ...p, embedding });
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const recallAtK = async (
  queries: { query: string; expect: string }[],
  retrieve: (q: string) => Promise<{ pitfall: { id: string } }[]>,
): Promise<number> => {
  let hits = 0;
  for (const q of queries) {
    const got = await retrieve(q.query);
    if (got.slice(0, K).some((r) => r.pitfall.id === q.expect)) hits++;
  }
  return hits / queries.length;
};

describe('retrieval quality floor (fixed labeled corpus)', () => {
  it(`lexical path on PARAPHRASED queries (key-less installs): recall@${K} ≥ ${LEXICAL_RECALL_FLOOR}`, async () => {
    // strip embeddings so this measures the pure lexical path
    const lexDir = mkdtempSync(join(tmpdir(), 'kq-lex-'));
    try {
      const lexStore = new KnowledgeStore(lexDir);
      for (const p of CORPUS) await lexStore.addPitfall(p);
      const recall = await recallAtK(QUERIES, (q) => retrieveRelevantLexical(lexStore, q, K));
      expect(recall).toBeGreaterThanOrEqual(LEXICAL_RECALL_FLOOR);
    } finally {
      rmSync(lexDir, { recursive: true, force: true });
    }
  });

  it(`hybrid path plumbing on word-overlap queries: recall@${K} ≥ ${HYBRID_RECALL_FLOOR}`, async () => {
    const recall = await recallAtK(EASY_QUERIES, (q) => retrieveRelevant(store, provider, q, K, 0.01));
    expect(recall).toBeGreaterThanOrEqual(HYBRID_RECALL_FLOOR);
  });
});
