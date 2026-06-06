// Isolated FalkorDB executor (ADR-16). Plain JS so it runs under bare `node` with no
// TS runtime, and — critically — in a process that never loads the Kùzu native addon
// (the two SIGSEGV together). Reads a JSON job from stdin, writes a JSON result to stdout.
//
// As of M6 (ADR-22) the worker is a generic Cypher executor for BOTH reads and writes —
// the parent (falkor.ts / engine brain) builds the statements; this stays a dumb runner.
//
// Job:    { url: string, graphName: string, statements: [{ cypher, params? }] }
// Result: { ok: true, results: any[][] } | { ok: false, reason: string }
//   results[i] = the rows returned by statements[i] (empty array for writes).
import { FalkorDB } from 'falkordb';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let client;
  try {
    const { url, graphName, statements } = JSON.parse(input);
    client = await FalkorDB.connect({ url });
    const g = client.selectGraph(graphName);
    const results = [];
    for (const st of statements || []) {
      const res = await g.query(st.cypher, st.params ? { params: st.params } : undefined);
      results.push(res?.data ?? []);
    }
    process.stdout.write(JSON.stringify({ ok: true, results }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
  } finally {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
});
