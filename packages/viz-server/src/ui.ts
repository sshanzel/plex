/**
 * The interactive UI, served as one self-contained HTML document (ADR-45). Cytoscape is loaded from
 * a CDN with the SAME SRI-pinned hash as the M5 static viz (engine/viz.ts). The page renders nothing
 * server-side from store data — it fetches the JSON API and builds the DOM with `textContent` (never
 * `innerHTML` of store text), so a malicious file path / finding title can't inject script. `version`
 * is the only interpolated value and is our own build string.
 */
const CYTOSCAPE_CDN = 'https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js';
const CYTOSCAPE_SRI = 'sha384-IWROdLKRsN1UuJywMlWl7/blXQ8GEooN2n7dzTxfEPd7ybYIKCUJ2Ol/1Gpf3YV4';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderAppHtml(version: string): string {
  const v = escapeHtml(version);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Plex — data explorer</title>
<script src="${CYTOSCAPE_CDN}" integrity="${CYTOSCAPE_SRI}" crossorigin="anonymous"></script>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#e6e8ee; --muted:#9aa3b2; --accent:#4dabf7; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; font-family: ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); }
  #app { display:grid; grid-template-rows:auto 1fr; height:100%; }
  header { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:10px 14px; background:var(--panel); border-bottom:1px solid var(--line); }
  header .brand { font-weight:700; letter-spacing:.5px; }
  header .brand small { color:var(--muted); font-weight:400; margin-left:6px; }
  .tabs { display:flex; gap:4px; }
  .tab { padding:5px 12px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); cursor:pointer; font-size:13px; }
  .tab.active { background:var(--accent); border-color:var(--accent); color:#06121f; font-weight:600; }
  select, input[type=search] { background:#0c0e12; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; font-size:13px; }
  input[type=search] { min-width:180px; }
  .filters { display:flex; gap:10px; align-items:center; color:var(--muted); font-size:12px; }
  .filters label { display:flex; gap:4px; align-items:center; cursor:pointer; }
  main { position:relative; display:grid; grid-template-columns:1fr 320px; min-height:0; }
  #cy { width:100%; height:100%; }
  #panel { border-left:1px solid var(--line); background:var(--panel); overflow:auto; padding:14px; font-size:13px; }
  #panel h3 { margin:0 0 4px; font-size:15px; word-break:break-word; }
  #panel .type { display:inline-block; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; margin-bottom:10px; }
  #panel dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:4px 10px; }
  #panel dt { color:var(--muted); white-space:nowrap; }
  #panel dd { margin:0; word-break:break-word; }
  #panel .hint { color:var(--muted); }
  #legend { position:absolute; left:10px; bottom:10px; background:rgba(23,26,33,.92); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:12px; display:flex; gap:12px; flex-wrap:wrap; max-width:70%; }
  #legend .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:middle; }
  .note { color:#ffd43b; font-size:12px; }
  .err { color:#ff8787; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--muted); border-radius:6px; padding:4px 8px; cursor:pointer; font-size:12px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="brand">PLEX<small>explorer ${v}</small></span>
    <select id="repo" title="Indexed repository"></select>
    <div class="tabs" id="tabs">
      <button class="tab active" data-graph="code">Code graph</button>
      <button class="tab" data-graph="brain">PR brain</button>
      <button class="tab" data-graph="knowledge">Knowledge</button>
    </div>
    <input type="search" id="search" placeholder="Search nodes…" />
    <div class="filters" id="filters"></div>
    <button class="ghost" id="relayout">Re-layout</button>
    <span id="status" class="hint" style="margin-left:auto;color:var(--muted);font-size:12px"></span>
  </header>
  <main>
    <div id="cy"></div>
    <div id="legend"></div>
    <aside id="panel"><p class="hint">Pick a node to inspect it. Double-click a file to expand its symbols and neighbors.</p></aside>
  </main>
</div>
<script>
${CLIENT_JS}
</script>
</body>
</html>`;
}

/** Client logic — kept in a template string so the whole UI ships in one file (no asset serving). */
const CLIENT_JS = String.raw`
(function () {
  var TYPE_COLORS = {
    File:'#4dabf7', Symbol:'#9775fa',
    Target:'#f783ac', Round:'#74c0fc', Finding:'#ff922b', Verdict:'#69db7c', Comment:'#ffd43b',
    Pitfall:'#63e6be', Suppression:'#ff6b6b', Incident:'#868e96'
  };
  var EDGE_TYPES = {
    code: ['import','ref','co-change','declares','coupled'],
    brain: ['round of','raised in','verdict on','comment'],
    knowledge: ['from','about']
  };
  var state = { graph:'code', repo:null, cy:null, hidden:{}, raw:{nodes:[],edges:[]} };

  var $ = function (id) { return document.getElementById(id); };
  function setStatus(msg, cls) { var s = $('status'); s.textContent = msg || ''; s.className = cls || 'hint'; }

  function styleFor() {
    return [
      { selector:'node', style:{ 'label':'data(label)','font-size':8,'color':'#e6e8ee','text-wrap':'ellipsis','text-max-width':110,
        'background-color':function(n){ return TYPE_COLORS[n.data('type')] || '#adb5bd'; },
        'text-valign':'bottom','text-margin-y':3,'width':18,'height':18 } },
      { selector:'node[type="Target"]', style:{ 'shape':'round-rectangle','width':34,'height':22,'font-size':10 } },
      { selector:'node[type="File"]', style:{ 'width':'mapData(symbols,0,40,14,40)','height':'mapData(symbols,0,40,14,40)' } },
      { selector:'node:selected', style:{ 'border-width':3,'border-color':'#fff' } },
      { selector:'.faded', style:{ 'opacity':0.12 } },
      { selector:'.match', style:{ 'border-width':3,'border-color':'#ffd43b' } },
      { selector:'edge', style:{ 'label':'data(label)','font-size':6,'color':'#6b7280','curve-style':'bezier',
        'width':1,'line-color':'#3a4150','target-arrow-color':'#3a4150','target-arrow-shape':'triangle','arrow-scale':0.7,
        'text-rotation':'autorotate','text-opacity':0 } },
      { selector:'edge:selected', style:{ 'line-color':'#fff','target-arrow-color':'#fff','text-opacity':1 } }
    ];
  }
  function layoutFor(graph) {
    if (graph === 'code') return { name:'cose', animate:false, nodeRepulsion:6000, idealEdgeLength:70, padding:30 };
    return { name:'breadthfirst', directed:true, padding:30, spacingFactor:1.1 };
  }

  function renderLegend(counts) {
    var el = $('legend'); el.innerHTML = '';
    Object.keys(counts).forEach(function (t) {
      var span = document.createElement('span');
      var dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = TYPE_COLORS[t] || '#adb5bd';
      span.appendChild(dot); span.appendChild(document.createTextNode(t + ' (' + counts[t] + ')'));
      el.appendChild(span);
    });
  }
  function renderFilters(graph) {
    var el = $('filters'); el.innerHTML = '';
    (EDGE_TYPES[graph] || []).forEach(function (t) {
      var key = graph + ':' + t;
      var label = document.createElement('label');
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !state.hidden[key];
      cb.addEventListener('change', function () { state.hidden[key] = !cb.checked; applyEdgeFilter(); });
      label.appendChild(cb); label.appendChild(document.createTextNode(t));
      el.appendChild(label);
    });
  }
  function applyEdgeFilter() {
    if (!state.cy) return;
    state.cy.edges().forEach(function (e) {
      var key = state.graph + ':' + e.data('label');
      e.style('display', state.hidden[key] ? 'none' : 'element');
    });
  }

  // Build the detail panel with textContent only — never innerHTML of store data (XSS-safe).
  function showDetail(node) {
    var panel = $('panel'); panel.innerHTML = '';
    var h = document.createElement('h3'); h.textContent = node.data('label'); panel.appendChild(h);
    var t = document.createElement('span'); t.className = 'type'; t.textContent = node.data('type'); panel.appendChild(t);
    var dl = document.createElement('dl');
    var props = node.data('props') || {};
    Object.keys(props).forEach(function (k) {
      var val = props[k];
      if (val === '' || val === null || val === undefined) return;
      var dt = document.createElement('dt'); dt.textContent = k;
      var dd = document.createElement('dd'); dd.textContent = String(val);
      dl.appendChild(dt); dl.appendChild(dd);
    });
    panel.appendChild(dl);
    if (node.data('type') === 'File') {
      var hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Double-click to expand symbols & neighbors.';
      panel.appendChild(hint);
    }
  }

  function toElements(data) {
    var els = [];
    data.nodes.forEach(function (n) { els.push({ data:{ id:n.id, label:n.label, type:n.type, props:n.props, symbols:(n.props&&n.props.symbols)||0 } }); });
    data.edges.forEach(function (e) { els.push({ data:{ id:e.id, source:e.source, target:e.target, label:e.label } }); });
    return els;
  }

  function draw(data) {
    state.raw = data;
    if (state.cy) { state.cy.destroy(); state.cy = null; }
    state.cy = cytoscape({ container:$('cy'), elements:toElements(data), style:styleFor(), layout:layoutFor(state.graph), wheelSensitivity:0.2 });
    state.cy.on('tap', 'node', function (evt) { showDetail(evt.target); });
    state.cy.on('dbltap', 'node[type="File"]', function (evt) { expandFile(evt.target); });
    renderLegend(data.counts || {});
    renderFilters(state.graph);
    applyEdgeFilter();
    var note = data.note ? (data.note) : (data.nodes.length + ' nodes · ' + data.edges.length + ' edges');
    setStatus(note, data.note ? 'note' : 'hint');
  }

  function api(path) {
    return fetch(path).then(function (r) {
      if (r.status === 503) { setStatus('Repo busy (a review is using it) — retrying…', 'note'); return null; }
      return r.json();
    });
  }

  function load() {
    if (state.graph !== 'knowledge' && !state.repo) { setStatus('No indexed repo selected.', 'note'); return; }
    setStatus('Loading…');
    var url = '/api/graph/' + state.graph + (state.repo ? '?repo=' + encodeURIComponent(state.repo) : '');
    api(url).then(function (data) {
      if (!data) { setTimeout(load, 1200); return; } // 503 backoff
      if (data.error) { setStatus(data.error, 'err'); return; }
      draw(data);
    }).catch(function (e) { setStatus(String(e), 'err'); });
  }

  function expandFile(node) {
    var url = '/api/expand?repo=' + encodeURIComponent(state.repo) + '&node=' + encodeURIComponent(node.id());
    api(url).then(function (data) {
      if (!data || !data.nodes) return;
      var added = [];
      data.nodes.forEach(function (n) { if (state.cy.getElementById(n.id).empty()) added.push({ data:{ id:n.id, label:n.label, type:n.type, props:n.props, symbols:(n.props&&n.props.symbols)||0 } }); });
      data.edges.forEach(function (e) { if (state.cy.getElementById(e.id).empty()) added.push({ data:{ id:e.id, source:e.source, target:e.target, label:e.label } }); });
      if (added.length) { state.cy.add(added); state.cy.layout(layoutFor(state.graph)).run(); applyEdgeFilter(); }
      setStatus('Expanded ' + node.data('label') + ' (+' + added.length + ')', 'hint');
    });
  }

  function doSearch(q) {
    if (!state.cy) return;
    q = (q || '').toLowerCase();
    state.cy.batch(function () {
      state.cy.nodes().forEach(function (n) {
        var hit = q && n.data('label').toLowerCase().indexOf(q) !== -1;
        n.toggleClass('match', !!hit);
        n.toggleClass('faded', !!q && !hit);
      });
    });
  }

  function setGraph(g) {
    state.graph = g;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.dataset.graph === g); });
    load();
  }

  function init() {
    api('/api/repos').then(function (d) {
      var sel = $('repo'); sel.innerHTML = '';
      (d.repos || []).forEach(function (r) {
        var o = document.createElement('option'); o.value = r.id; o.textContent = r.name; sel.appendChild(o);
      });
      if (d.repos && d.repos.length) { state.repo = d.repos[0].id; sel.value = state.repo; }
      else { var o = document.createElement('option'); o.textContent = '(no indexed repos)'; sel.appendChild(o); }
      sel.addEventListener('change', function () { state.repo = sel.value; load(); });
      load();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.addEventListener('click', function () { setGraph(b.dataset.graph); }); });
    $('search').addEventListener('input', function (e) { doSearch(e.target.value); });
    $('relayout').addEventListener('click', function () { if (state.cy) state.cy.layout(layoutFor(state.graph)).run(); });
  }
  init();
})();
`;
