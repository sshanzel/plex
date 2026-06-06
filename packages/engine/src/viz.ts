import type { ReviewContext } from './review';

interface CyElement {
  data: Record<string, unknown>;
}

/** Build Cytoscape elements: a ChangeSet hub → changed files and blast-radius neighbors. */
function elementsFor(ctx: ReviewContext): CyElement[] {
  const els: CyElement[] = [{ data: { id: 'hub', label: `Δ ${ctx.repo}`, group: 'hub' } }];
  const changedFiles = [...new Set(ctx.changed.map((c) => c.file))];
  for (const file of changedFiles) {
    els.push({ data: { id: `c:${file}`, label: file, group: 'changed' } });
    els.push({ data: { id: `e:c:${file}`, source: 'hub', target: `c:${file}`, label: 'changed' } });
  }
  for (const n of ctx.blastRadius) {
    const path = String(n.node.props.path);
    els.push({ data: { id: `n:${path}`, label: `${path}\n${n.score.toFixed(2)}`, group: 'neighbor', score: n.score } });
    els.push({ data: { id: `e:n:${path}`, source: 'hub', target: `n:${path}`, label: n.via.join(',') } });
  }
  return els;
}

/**
 * Render a self-contained HTML visualization of the review neighborhood (M5 product
 * viz). Same data the ephemeral FalkorDB graph holds; Cytoscape loaded from a CDN.
 */
export function reviewContextToHtml(ctx: ReviewContext): string {
  const elements = JSON.stringify(elementsFor(ctx));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>reviewer — ${ctx.repo} (${ctx.baseRef})</title>
<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,sans-serif}
  #cy{width:100%;height:88vh}
  header{padding:8px 14px;background:#111;color:#eee}
  header small{color:#9aa}
</style>
</head>
<body>
<header><strong>reviewer</strong> &nbsp; ${ctx.repo} &nbsp; <small>base ${ctx.baseRef} · ${ctx.changed.length} changed · ${ctx.blastRadius.length} coupled</small></header>
<div id="cy"></div>
<script>
  const elements = ${elements};
  cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: [
      { selector: 'node', style: { 'label': 'data(label)', 'text-wrap': 'wrap', 'font-size': 9, 'text-valign': 'center', 'color': '#fff', 'text-outline-width': 2, 'text-outline-color': '#333' } },
      { selector: 'node[group="hub"]', style: { 'background-color': '#111', 'shape': 'round-rectangle', 'width': 80, 'height': 36 } },
      { selector: 'node[group="changed"]', style: { 'background-color': '#d6336c' } },
      { selector: 'node[group="neighbor"]', style: { 'background-color': 'mapData(score, 0, 1, #9ec5fe, #1864ab)' } },
      { selector: 'edge', style: { 'label': 'data(label)', 'font-size': 7, 'color': '#666', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#bbb', 'target-arrow-color': '#bbb', 'width': 1 } }
    ],
    layout: { name: 'concentric', concentric: (n) => (n.data('group') === 'hub' ? 3 : n.data('group') === 'changed' ? 2 : 1), minNodeSpacing: 40 }
  });
</script>
</body>
</html>`;
}
