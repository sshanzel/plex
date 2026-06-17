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
  #panel .summary { margin:0 0 10px; font-size:13px; color:var(--fg); }
  #panel .sentinel { margin:0 0 10px; padding:6px 8px; font-size:12px; color:#ffd8a8; background:rgba(255,146,43,.12); border:1px solid #ff922b; border-radius:6px; }
  #legend .sep { width:1px; align-self:stretch; background:var(--line); margin:0 2px; }
  #legend .ring { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:middle; background:transparent; border:2px solid #ff922b; }
  #panel dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:4px 10px; }
  #panel dt { color:var(--muted); white-space:nowrap; }
  #panel dd { margin:0; word-break:break-word; }
  #panel .hint { color:var(--muted); }
  #legend { position:absolute; left:10px; bottom:10px; background:rgba(23,26,33,.92); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:12px; display:flex; gap:12px; flex-wrap:wrap; max-width:70%; }
  /* Centered empty-state — what a cold-start (no knowledge / no repo selected) user sees instead of a black void. */
  #empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; text-align:center; padding:0 24px; pointer-events:none; }
  #empty .ttl { font-size:15px; color:var(--fg); max-width:560px; }
  #empty .cta { font-size:13px; color:var(--muted); max-width:560px; }
  #empty code { background:rgba(255,255,255,.07); padding:1px 5px; border-radius:4px; }
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
      <button class="tab" data-graph="knowledge">Knowledge</button>
      <button class="tab" data-graph="lineage">Review history</button>
    </div>
    <input type="search" id="search" placeholder="Search nodes…" />
    <div class="filters" id="filters"></div>
    <button class="ghost" id="relayout">Re-layout</button>
    <span id="status" class="hint" style="margin-left:auto;color:var(--muted);font-size:12px"></span>
  </header>
  <main>
    <div id="cy"></div>
    <div id="empty" hidden><div class="ttl"></div><div class="cta"></div></div>
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
    // No 'declares'/'coupled' here on purpose: those are expand-only edges (File→Symbol, File→neighbor)
    // that arrive on double-click. They render unfiltered (always shown) rather than cluttering the
    // base-view filter row with toggles for edge types the initial graph doesn't contain.
    code: ['import','ref','co-change'],
    brain: ['round of','raised in','verdict on','comment','comment on'],
    knowledge: ['from','about'],
    lineage: ['round of','raised in','verdict on','comment','comment on','from','about','likely became']
  };
  var state = { graph:'code', repo:null, cy:null, hidden:{}, raw:{nodes:[],edges:[]} };

  var $ = function (id) { return document.getElementById(id); };
  function setStatus(msg, cls) { var s = $('status'); s.textContent = msg || ''; s.className = cls || 'hint'; }

  function styleFor(graph) {
    var rules = [
      { selector:'node', style:{ 'label':'data(label)','font-size':8,'color':'#e6e8ee','text-wrap':'ellipsis','text-max-width':110,
        'background-color':function(n){ return TYPE_COLORS[n.data('type')] || '#adb5bd'; },
        'text-valign':'bottom','text-margin-y':3,'width':18,'height':18 } },
      // Compound container (a Pitfall/Suppression holding its Incidents, knowledge graph): a labelled
      // tinted box in the lesson's type colour, label pinned top — turns the two-row hairball into
      // "N lessons, each with its history". Children keep their own colour + outcome/sentinel borders.
      { selector:':parent', style:{ 'shape':'round-rectangle','background-opacity':0.10,
        'border-width':1.5,'border-opacity':0.55,'border-color':function(n){ return TYPE_COLORS[n.data('type')] || '#adb5bd'; },
        'padding':14,'text-valign':'top','text-margin-y':-3,'font-size':9,'text-max-width':180 } },
      { selector:'node[type="Target"]', style:{ 'shape':'round-rectangle','width':34,'height':22,'font-size':10 } },
      { selector:'node[type="File"]', style:{ 'width':'mapData(symbols,0,40,14,40)','height':'mapData(symbols,0,40,14,40)' } },
      // Outcome encoding: a finding/incident that was acted on (resolved) vs dismissed — read at a glance.
      { selector:'node[outcomeClass="resolved"]', style:{ 'border-width':3,'border-color':'#69db7c' } },
      { selector:'node[outcomeClass="dismissed"]', style:{ 'border-width':2,'border-color':'#ff6b6b','opacity':0.7 } },
      // Regression sentinel: a prior fix anchored to a code path — the "don't re-break this" money-shot.
      { selector:'node[?sentinel]', style:{ 'border-width':5,'border-color':'#ff922b' } },
      { selector:'node:selected', style:{ 'border-width':3,'border-color':'#fff' } },
      { selector:'.faded', style:{ 'opacity':0.12 } },
      { selector:'.match', style:{ 'border-width':3,'border-color':'#ffd43b' } },
      { selector:'edge', style:{ 'label':'data(label)','font-size':6,'color':'#6b7280','curve-style':'bezier',
        'width':1,'line-color':'#3a4150','target-arrow-color':'#3a4150','target-arrow-shape':'triangle','arrow-scale':0.7,
        'text-rotation':'autorotate','text-opacity':0 } },
      // The relationship graphs (brain/knowledge/lineage) are small — show their edge labels so the
      // story reads (became / from / raised in / verdict on); the dense code graph keeps them on hover.
      { selector:'edge[graph != "code"]', style:{ 'text-opacity':0.85 } },
      { selector:'edge[label="concerns"]', style:{ 'text-opacity':0.85 } },
      { selector:'edge[?inferred]', style:{ 'line-style':'dashed','line-color':'#f783ac','target-arrow-color':'#f783ac','text-opacity':1,'color':'#f783ac' } },
      { selector:'edge:selected', style:{ 'line-color':'#fff','target-arrow-color':'#fff','text-opacity':1 } }
    ];
    // Incident dots are "history" packed inside a lesson box — their file-path labels collide there, and
    // the box title + outcome ring carry the meaning, so hide the label (shown on select). KNOWLEDGE
    // VIEW ONLY: the same Incident node type also appears in the code-graph symbol↔incident expand and
    // in Lineage (it always carries graph:'knowledge', so this can't be node-scoped) — those views want
    // the label, so gate on the CURRENT graph, not the node.
    if (graph === 'knowledge') {
      rules.push({ selector:'node[type="Incident"]', style:{ 'text-opacity':0 } });
      rules.push({ selector:'node[type="Incident"]:selected', style:{ 'text-opacity':1 } });
    }
    return rules;
  }
  function layoutFor(graph) {
    if (graph === 'code') return { name:'cose', animate:false, nodeRepulsion:6000, idealEdgeLength:70, padding:30 };
    // Knowledge is handled by knowledgeGrid (deterministic compound grid) via runLayout, not here.
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
    // Outcome / sentinel key — explains the node border encoding (only where outcomes appear).
    if (state.graph !== 'code') {
      el.appendChild(Object.assign(document.createElement('span'), { className: 'sep' }));
      [['#69db7c', 'resolved'], ['#ff6b6b', 'dismissed']].forEach(function (o) {
        var span = document.createElement('span');
        var ring = document.createElement('span'); ring.className = 'dot'; ring.style.cssText = 'background:transparent;border:2px solid ' + o[0];
        span.appendChild(ring); span.appendChild(document.createTextNode(o[1]));
        el.appendChild(span);
      });
      var sent = document.createElement('span');
      var sring = document.createElement('span'); sring.className = 'ring';
      sent.appendChild(sring); sent.appendChild(document.createTextNode('⚠ prior fix (regression risk)'));
      el.appendChild(sent);
    }
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

  // A one-line, human summary per node type — so clicking a node reads as a sentence, not a prop dump.
  function summaryFor(type, p) {
    switch (type) {
      case 'File': return (p.lang || 'file') + ' · ' + (p.symbols || 0) + ' symbol(s)';
      case 'Symbol': return (p.kind || 'symbol') + (p.startLine ? ' · lines ' + p.startLine + '–' + p.endLine : '') + (p.exported ? ' · exported' : '');
      case 'Finding': return (p.severity || 'finding') + ' · ' + (p.outcome || 'open') + (p.file ? ' · ' + p.file + (p.line > 0 ? ':' + p.line : '') : '');
      case 'Incident': return (p.outcome || 'recorded') + ' concern' + (p.symbol ? ' at ' + p.symbol : (p.file ? ' in ' + p.file : ''));
      case 'Pitfall': return (p.category || 'lesson') + (p.confidence != null && p.confidence !== '' ? ' · confidence ' + p.confidence : '') + (p.incidents ? ' · ' + p.incidents + ' incident(s)' : '');
      case 'Suppression': return 'suppression' + (p.category ? ' · ' + p.category : '');
      case 'Comment': return 'comment' + (p.author ? ' by ' + p.author : '') + (p.file ? ' · ' + p.file : '');
      case 'Round': return 'round ' + (p.n || '?') + (p.headSha ? ' · ' + p.headSha : '');
      case 'Verdict': return (p.kind || 'verdict') + ' verdict' + (p.scope ? ' · ' + p.scope : '');
      case 'Target': return 'review target';
      default: return '';
    }
  }

  // Build the detail panel with textContent only — never innerHTML of store data (XSS-safe).
  function showDetail(node) {
    var panel = $('panel'); panel.innerHTML = '';
    var h = document.createElement('h3'); h.textContent = node.data('label'); panel.appendChild(h);
    var t = document.createElement('span'); t.className = 'type'; t.textContent = node.data('type'); panel.appendChild(t);
    var props = node.data('props') || {};
    var summary = summaryFor(node.data('type'), props);
    if (summary) { var sm = document.createElement('p'); sm.className = 'summary'; sm.textContent = summary; panel.appendChild(sm); }
    if (node.data('sentinel')) { var wn = document.createElement('p'); wn.className = 'sentinel'; wn.textContent = '⚠ Previously resolved at this code path — verify you are not regressing it.'; panel.appendChild(wn); }
    var dl = document.createElement('dl');
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

  var RESOLVED = { fixed:1, accepted:1, reverted:1 };
  // Lift outcome/sentinel onto element data so the stylesheet can encode them at a glance (the raw
  // props stay for the detail panel). A sentinel = a resolved concern anchored to a symbol — i.e.
  // "this code path was fixed before", the regression-risk signal.
  function nodeEl(n) {
    var p = n.props || {};
    var oc = p.outcome ? (RESOLVED[p.outcome] ? 'resolved' : (p.outcome === 'rejected' ? 'dismissed' : '')) : '';
    var sentinel = oc === 'resolved' && !!p.symbol;
    var d = { id:n.id, label:(sentinel ? '⚠ ' : '') + n.label, type:n.type, props:p, symbols:p.symbols||0,
      outcome:p.outcome||'', outcomeClass:oc, sentinel:sentinel, severity:p.severity||'' };
    if (n.parent) d.parent = n.parent; // Cytoscape compound nesting (knowledge: incident inside its pitfall)
    return { data:d };
  }
  function edgeEl(e) { return { data:{ id:e.id, source:e.source, target:e.target, label:e.label, inferred:!!e.inferred, graph:e.graph||'' } }; }
  function toElements(data) { return data.nodes.map(nodeEl).concat(data.edges.map(edgeEl)); }

  // Knowledge clusters are mostly edge-less compound boxes (a Pitfall/Suppression + its Incidents),
  // which force layouts (cose) jam into an overlapping band. Place each lesson-box in a deterministic
  // grid and pack its incidents in a mini-grid inside — a clean "N lessons, each with its history"
  // wall, no extra layout dependency. Compound parents auto-bound their children (no position set).
  function knowledgeGrid(cy) {
    var cells = [];
    cy.nodes().forEach(function (n) {
      if (n.isParent()) cells.push(n.children());                       // a lesson box + its incidents
      else if (n.parent().length === 0) cells.push(cy.collection(n));   // a childless pitfall / orphan incident
    });
    var cols = Math.max(1, Math.ceil(Math.sqrt(cells.length)));
    // Size the uniform cell from the LARGEST box (+ title/padding) so a high-incident pitfall packs its
    // mini-grid without spilling into the row below and overlapping a neighbour (positions are fixed).
    var GAP = 34, maxKids = cells.reduce(function (m, k) { return Math.max(m, k.length); }, 1);
    var maxSide = Math.ceil(Math.sqrt(maxKids)) * GAP;
    var CELL_W = Math.max(360, maxSide + 90), CELL_H = Math.max(250, maxSide + 100), pos = {};
    cells.forEach(function (kids, idx) {
      var cx = (idx % cols) * CELL_W, cy0 = Math.floor(idx / cols) * CELL_H;
      var kc = Math.max(1, Math.ceil(Math.sqrt(kids.length)));
      kids.forEach(function (k, j) { pos[k.id()] = { x: cx + (j % kc) * GAP, y: cy0 + Math.floor(j / kc) * GAP }; });
    });
    return { name:'preset', positions: pos, fit:true, padding:40, animate:false };
  }
  function runLayout() {
    if (!state.cy) return;
    state.cy.layout(state.graph === 'knowledge' ? knowledgeGrid(state.cy) : layoutFor(state.graph)).run();
  }

  function draw(data) {
    state.raw = data;
    if (state.cy) { state.cy.destroy(); state.cy = null; }
    state.cy = cytoscape({ container:$('cy'), elements:toElements(data), style:styleFor(state.graph), layout:{ name:'preset' }, wheelSensitivity:0.2 });
    runLayout();
    state.cy.on('tap', 'node', function (evt) { showDetail(evt.target); });
    state.cy.on('dbltap', 'node[type="File"]', function (evt) { expandFile(evt.target); });
    renderLegend(data.counts || {});
    renderFilters(state.graph);
    applyEdgeFilter();
    var note = data.note ? (data.note) : (data.nodes.length + ' nodes · ' + data.edges.length + ' edges');
    setStatus(note, data.note ? 'note' : 'hint');
    showEmptyState(data);
  }

  // Cold-start / empty graph: a centered message + call-to-action instead of a black void, so a
  // brand-new user (no learned knowledge yet) sees what to do, not a blank screen. textContent only.
  function showEmptyState(data) {
    var el = $('empty');
    if (data.nodes.length > 0) { el.hidden = true; return; }
    el.querySelector('.ttl').textContent = data.note || 'Nothing to show here yet.';
    var cta = '';
    if (state.graph === 'knowledge') cta = 'Seed lessons from your merged PR history with \`plex analyze\`, or just review — Plex learns from every finding you accept.';
    else if (state.graph === 'lineage') cta = 'Run a review on this repo and the comment → finding → verdict history will appear here.';
    else if (state.graph === 'code') cta = 'Index a repo (\`plex index\`) or pick one above to explore its files and coupling.';
    el.querySelector('.cta').textContent = cta;
    el.hidden = false;
  }

  function api(path) {
    return fetch(path).then(function (r) {
      if (r.status === 503) { setStatus('Repo busy (a review is using it) — retrying…', 'note'); return null; }
      return r.json();
    });
  }

  function load() {
    if (state.graph !== 'knowledge' && !state.repo) { setStatus('Select a repo for this graph (Knowledge can show "All repos (global)").', 'note'); return; }
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
      data.nodes.forEach(function (n) { if (state.cy.getElementById(n.id).empty()) added.push(nodeEl(n)); });
      data.edges.forEach(function (e) { if (state.cy.getElementById(e.id).empty()) added.push(edgeEl(e)); });
      if (added.length) { state.cy.add(added); state.cy.layout(layoutFor(state.graph)).run(); applyEdgeFilter(); }
      setStatus('Expanded ' + node.data('label') + ' (+' + added.length + ')', 'hint');
    });
  }

  function highlightMatches(q) {
    state.cy.batch(function () {
      state.cy.nodes().forEach(function (n) {
        var hit = q && n.data('label').toLowerCase().indexOf(q) !== -1;
        n.toggleClass('match', !!hit);
        n.toggleClass('faded', !!q && !hit);
      });
    });
  }
  var searchTimer = null;
  function doSearch(q) {
    if (!state.cy) return;
    q = (q || '').toLowerCase();
    highlightMatches(q); // instant: highlight/fade the LOADED nodes
    // Code graph lands on the hub files only, so a wanted file may not be loaded — fetch it (debounced)
    // and add it to the graph so search reaches the WHOLE repo, not just the landing set.
    clearTimeout(searchTimer);
    if (state.graph === 'code' && state.repo && q.length >= 2) {
      searchTimer = setTimeout(function () { fetchSearch(q); }, 250);
    }
  }
  function fetchSearch(q) {
    api('/api/search?repo=' + encodeURIComponent(state.repo) + '&q=' + encodeURIComponent(q)).then(function (data) {
      if (!data || !data.nodes || !state.cy) return;
      var added = data.nodes.filter(function (n) { return state.cy.getElementById(n.id).empty(); }).map(nodeEl);
      if (added.length) { state.cy.add(added); state.cy.layout(layoutFor('code')).run(); applyEdgeFilter(); }
      highlightMatches(q); // re-highlight incl. any newly loaded files
    }).catch(function () { /* search is best-effort; the loaded-node highlight already ran */ });
  }

  function setGraph(g) {
    state.graph = g;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.dataset.graph === g); });
    load();
  }

  // The code graph and Review history are per-repo; in "All repos (global)" mode they have no repo to
  // show, so hide them and keep only Knowledge. Restores them when a real repo is selected.
  function syncTabsToRepo() {
    var global = !state.repo;
    ['code', 'lineage'].forEach(function (g) {
      var btn = document.querySelector('.tab[data-graph="' + g + '"]');
      if (btn) btn.style.display = global ? 'none' : '';
    });
    if (global && state.graph !== 'knowledge') { // jumped to global while on a now-hidden tab → fall to Knowledge
      state.graph = 'knowledge';
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.dataset.graph === 'knowledge'); });
    }
  }

  function init() {
    api('/api/repos').then(function (d) {
      var sel = $('repo'); sel.innerHTML = '';
      // "All repos (global)" (value '') shows the whole knowledge base — pitfalls scoped to ANY repo,
      // incl. global ones the per-repo view hides. For code/lineage it prompts to pick a repo.
      var g = document.createElement('option'); g.value = ''; g.textContent = 'All repos (global)'; sel.appendChild(g);
      (d.repos || []).forEach(function (r) {
        var o = document.createElement('option'); o.value = r.id; o.textContent = r.name; sel.appendChild(o);
      });
      // Default to the first real repo (so the code graph loads); fall back to global when none indexed.
      if (d.repos && d.repos.length) { state.repo = d.repos[0].id; sel.value = state.repo; }
      else { state.repo = ''; sel.value = ''; }
      sel.addEventListener('change', function () { state.repo = sel.value; syncTabsToRepo(); load(); });
      syncTabsToRepo();
      load();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.addEventListener('click', function () { setGraph(b.dataset.graph); }); });
    $('search').addEventListener('input', function (e) { doSearch(e.target.value); });
    $('relayout').addEventListener('click', runLayout);
  }
  init();
})();
`;
