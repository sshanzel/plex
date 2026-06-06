// Isolated FalkorDB publisher (ADR-16). Plain JS so it runs under bare `node` with no
// TS runtime, and — critically — in a process that never loads the Kùzu native addon
// (the two SIGSEGV together). Reads a JSON job from stdin, writes a JSON result to stdout.
//
// Job:    { graphName: string, url: string, nb: ReviewNeighborhood }
// Result: { published: boolean, reason?: string }
import { FalkorDB } from 'falkordb';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let client;
  try {
    const { graphName, url, nb } = JSON.parse(input);
    client = await FalkorDB.connect({ url });
    const g = client.selectGraph(graphName);
    const base = (p) => String(p).split('/').pop() || String(p); // basename for the node caption

    await g.query('MATCH (n) DETACH DELETE n');
    // `name` is what FalkorDB Browser shows as the node caption by default.
    await g.query('CREATE (:ChangeSet {name:$n, repo:$r})', {
      params: { n: graphName, r: nb.repo },
    });

    for (const c of nb.changed) {
      await g.query(
        'MATCH (h:ChangeSet {name:$n}) MERGE (f:File {path:$p}) ' +
          'SET f.name = $nm, f.changed = true, f.score = 1, f.distance = 0 ' +
          'MERGE (h)-[:CHANGED]->(f)',
        { params: { n: graphName, p: c.file, nm: base(c.file) } },
      );
    }
    for (const nbr of nb.neighbors) {
      const p = String(nbr.node.props.path);
      await g.query(
        'MATCH (h:ChangeSet {name:$n}) MERGE (f:File {path:$p}) ' +
          'SET f.name = $nm, f.score = $s, f.distance = $d, f.via = $v ' +
          'MERGE (h)-[:BLAST {score:$s, via:$v}]->(f)',
        { params: { n: graphName, p, nm: base(p), s: nbr.score, d: nbr.distance, v: (nbr.via || []).join(',') } },
      );
    }
    process.stdout.write(JSON.stringify({ published: true }));
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ published: false, reason: e instanceof Error ? e.message : String(e) }),
    );
  } finally {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
});
