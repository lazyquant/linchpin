export const FLOWCHART_VIEWER_JS: string = String.raw`"use strict";
function linchpinFlowchartPut(target, key, value) {
  Object.defineProperty(target, key, { value: value, enumerable: true, writable: true, configurable: true });
}
function linchpinFlowchartOwn(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}
function linchpinFlowchartFind(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function linchpinFlowchartLabel(model, id) {
  var node = linchpinFlowchartFind(model.nodes, id);
  return node ? node.label : id;
}
function linchpinFlowchartReduce(model, state, action) {
  var kept = { selected: state.selected ? { type: state.selected.type, id: state.selected.id } : null, step: state.step };
  if (action.type === "clear") return { selected: null, step: null };
  if (action.type === "select") {
    var t = action.target;
    var list = t && t.type === "node" ? model.nodes : t && t.type === "edge" ? model.edges : null;
    if (!list || !linchpinFlowchartFind(list, t.id)) return kept;
    if (state.selected && state.selected.type === t.type && state.selected.id === t.id) return { selected: null, step: null };
    return { selected: { type: t.type, id: t.id }, step: null };
  }
  if (action.type === "step") {
    var n = model.steps.length;
    if (n === 0) return kept;
    var next;
    if (state.step === null) {
      if (action.delta !== 1) return kept;
      next = 0;
    } else {
      next = Math.min(n - 1, Math.max(0, state.step + action.delta));
    }
    if (next === state.step) return kept;
    return { selected: null, step: next };
  }
  return kept;
}
function linchpinFlowchartPresent(model, state) {
  var nodes = {}, edges = {}, i, e;
  var sel = state.selected;
  var node = sel && sel.type === "node" ? linchpinFlowchartFind(model.nodes, sel.id) : null;
  var edge = sel && sel.type === "edge" ? linchpinFlowchartFind(model.edges, sel.id) : null;
  var step = !node && !edge && typeof state.step === "number" && state.step >= 0 && state.step < model.steps.length ? model.steps[state.step] : null;
  var base = node || edge || step ? "dimmed" : "normal";
  for (i = 0; i < model.nodes.length; i++) linchpinFlowchartPut(nodes, model.nodes[i].id, base);
  for (i = 0; i < model.edges.length; i++) linchpinFlowchartPut(edges, model.edges[i].id, base);
  if (node) {
    var incoming = 0, outgoing = 0;
    for (i = 0; i < model.edges.length; i++) {
      e = model.edges[i];
      if (e.to === node.id) incoming++;
      if (e.from === node.id) outgoing++;
      if (e.from === node.id || e.to === node.id) {
        linchpinFlowchartPut(edges, e.id, "related");
        if (linchpinFlowchartOwn(nodes, e.from)) linchpinFlowchartPut(nodes, e.from, "related");
        if (linchpinFlowchartOwn(nodes, e.to)) linchpinFlowchartPut(nodes, e.to, "related");
      }
    }
    linchpinFlowchartPut(nodes, node.id, "selected");
    return { nodes: nodes, edges: edges, stepId: null, inspector: { heading: node.label, rows: [["id", node.id], ["kind", node.kind], ["incoming", String(incoming)], ["outgoing", String(outgoing)]] } };
  }
  if (edge) {
    if (linchpinFlowchartOwn(nodes, edge.from)) linchpinFlowchartPut(nodes, edge.from, "related");
    if (linchpinFlowchartOwn(nodes, edge.to)) linchpinFlowchartPut(nodes, edge.to, "related");
    linchpinFlowchartPut(edges, edge.id, "selected");
    return { nodes: nodes, edges: edges, stepId: null, inspector: { heading: edge.relation, rows: [["id", edge.id], ["from", linchpinFlowchartLabel(model, edge.from)], ["to", linchpinFlowchartLabel(model, edge.to)], ["basis", edge.basis === null ? "not evidence" : edge.basis], ["verification", edge.verification === null ? "not stated" : edge.verification], ["evidence", edge.evidenceIds.length ? edge.evidenceIds.join(", ") : "no evidence"], ["source id", edge.sourceId === null ? "none" : edge.sourceId]] } };
  }
  if (step) {
    for (i = 0; i < step.nodeIds.length; i++) if (linchpinFlowchartOwn(nodes, step.nodeIds[i])) linchpinFlowchartPut(nodes, step.nodeIds[i], "related");
    for (i = 0; i < step.edgeIds.length; i++) if (linchpinFlowchartOwn(edges, step.edgeIds[i])) linchpinFlowchartPut(edges, step.edgeIds[i], "related");
    return { nodes: nodes, edges: edges, stepId: step.id, inspector: { heading: step.title, rows: [["sequence", String(model.sequence)], ["step", String(state.step + 1) + " of " + String(model.steps.length)]] } };
  }
  return { nodes: nodes, edges: edges, stepId: null, inspector: null };
}

function linchpinFlowchartReducePlayback(model, state, action) {
  var n = model.steps.length || model.nodes.length;
  if (!n || action.type === "clear") return { index: null, status: "stopped" };
  var index = state.index, status = state.status;
  if (action.type === "stop") return { index: index, status: status === "playing" ? "stopped" : status };
  if (action.type === "previous" || action.type === "next") {
    index = index === null ? (action.type === "next" ? 0 : null) : Math.max(0, Math.min(n - 1, index + (action.type === "next" ? 1 : -1)));
    return { index: index, status: "stopped" };
  }
  if (action.type === "play" && status === "playing") return { index: index, status: status };
  if (action.type === "play" || action.type === "replay") {
    if (action.type === "replay" || index === null || index === n - 1 || status === "completed") index = 0;
    status = index === n - 1 ? "completed" : "playing";
  } else if (action.type === "tick" && status === "playing") {
    index = Math.min(n - 1, index + 1);
    if (index === n - 1) status = "completed";
  }
  return { index: index, status: status };
}
function linchpinFlowchartPresentPlayback(model, state, selection) {
  var selected = selection || null, step = null;
  if (!selected && state.index !== null) {
    if (model.steps.length) step = state.index;
    else if (model.nodes[state.index]) selected = { type: "node", id: model.nodes[state.index].id };
  }
  return linchpinFlowchartPresent(model, { selected: selected, step: step });
}
// DOM layer
if (typeof document !== "undefined") {
  (function () {
    var model = JSON.parse(document.getElementById("linchpin-flowchart-model").textContent);
    var state = { selected: null, step: null };
    var playback = { index: null, status: "stopped" }, timer = null, generation = 0;
    function cancel() { generation++; if (timer !== null) clearTimeout(timer); timer = null; }
    function schedule() {
      cancel();
      if (playback.status !== "playing") return;
      var token = generation;
      timer = setTimeout(function () {
        if (token !== generation || playback.status !== "playing") return;
        timer = null;
        playback = linchpinFlowchartReducePlayback(model, playback, { type: "tick" });
        apply(); schedule();
      }, 2000);
    }
    function dispatch(type) {
      if ((type === "play" || type === "replay") && document.hidden) return;
      if (type === "play" && playback.status === "playing") return;
      cancel();
      playback = linchpinFlowchartReducePlayback(model, playback, { type: type });
      if (type !== "stop") state = { selected: null, step: null };
      apply(); schedule();
    }
    document.addEventListener("visibilitychange", function () { if (document.hidden) dispatch("stop"); });
    function mark(map, id) {
      return linchpinFlowchartOwn(map, id) ? map[id] : "normal";
    }
    function apply() {
      var view = linchpinFlowchartPresentPlayback(model, playback, state.selected);
      var count = model.steps.length || model.nodes.length;
      document.getElementById("linchpin-flowchart-playback-status").textContent = playback.status.charAt(0).toUpperCase() + playback.status.slice(1) + " \u2014 item " + (playback.index === null ? 0 : playback.index + 1) + " of " + count + (count ? "" : ". No items to play.");
      document.getElementById("linchpin-flowchart-play").disabled = !count || playback.status === "playing";
      document.getElementById("linchpin-flowchart-stop").disabled = playback.status !== "playing";
      document.getElementById("linchpin-flowchart-replay").disabled = !count;
      document.getElementById("linchpin-flowchart-prev").disabled = !count;
      document.getElementById("linchpin-flowchart-next").disabled = !count;
      var i;
      var found = document.querySelectorAll("[data-node-id]");
      for (i = 0; i < found.length; i++) found[i].setAttribute("data-mark", mark(view.nodes, found[i].getAttribute("data-node-id")));
      found = document.querySelectorAll("[data-edge-id]");
      for (i = 0; i < found.length; i++) found[i].setAttribute("data-mark", mark(view.edges, found[i].getAttribute("data-edge-id")));
      found = document.querySelectorAll("[data-node-row]");
      for (i = 0; i < found.length; i++) found[i].setAttribute("data-mark", mark(view.nodes, found[i].getAttribute("data-node-row")));
      found = document.querySelectorAll("[data-edge-row]");
      for (i = 0; i < found.length; i++) found[i].setAttribute("data-mark", mark(view.edges, found[i].getAttribute("data-edge-row")));
      var items = document.querySelectorAll("[data-step-id]");
      for (i = 0; i < items.length; i++) items[i].setAttribute("data-mark", items[i].getAttribute("data-step-id") === view.stepId ? "selected" : "normal");
      var box = document.getElementById("linchpin-flowchart-inspector");
      if (!box) return;
      box.textContent = "";
      if (!view.inspector) {
        box.textContent = "Select a node or an edge";
        return;
      }
      var heading = document.createElement("h2");
      box.appendChild(heading);
      heading.textContent = view.inspector.heading;
      var list = document.createElement("dl");
      box.appendChild(list);
      for (i = 0; i < view.inspector.rows.length; i++) {
        var term = document.createElement("dt");
        list.appendChild(term);
        term.textContent = view.inspector.rows[i][0];
        var value = document.createElement("dd");
        list.appendChild(value);
        value.textContent = view.inspector.rows[i][1];
      }
    }
    function choose(type, id) {
      cancel(); playback = linchpinFlowchartReducePlayback(model, playback, { type: "stop" });
      state = linchpinFlowchartReduce(model, state, { type: "select", target: { type: type, id: id } });
      apply();
    }
    document.addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest("[data-node-id],[data-edge-id],[data-node-row],[data-edge-row]") : null;
      if (!el) return;
      var id = el.getAttribute("data-node-id");
      if (id !== null) { choose("node", id); return; }
      id = el.getAttribute("data-edge-id");
      if (id !== null) { choose("edge", id); return; }
      id = el.getAttribute("data-node-row");
      if (id !== null) { choose("node", id); return; }
      id = el.getAttribute("data-edge-row");
      if (id !== null) choose("edge", id);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        cancel(); playback = linchpinFlowchartReducePlayback(model, playback, { type: "stop" });
        state = linchpinFlowchartReduce(model, state, { type: "clear" });
        apply();
        return;
      }
      if (ev.target === document.getElementById("linchpin-flowchart-canvas")) return;
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        dispatch("previous");
        return;
      }
      if (ev.key === "ArrowRight") {
        ev.preventDefault();
        dispatch("next");
        return;
      }
      if (ev.key === "Enter" || ev.key === " ") {
        var group = ev.target && ev.target.closest ? ev.target.closest("g[data-node-id], g[data-edge-id]") : null;
        if (!group) return;
        ev.preventDefault();
        var nodeId = group.getAttribute("data-node-id");
        if (nodeId !== null) choose("node", nodeId);
        else choose("edge", group.getAttribute("data-edge-id"));
      }
    });
    ["play", "stop", "replay"].forEach(function (name) {
      document.getElementById("linchpin-flowchart-" + name).addEventListener("click", function () { dispatch(name); });
    });
    var prevButton = document.getElementById("linchpin-flowchart-prev");
    var nextButton = document.getElementById("linchpin-flowchart-next");
    if (prevButton) prevButton.addEventListener("click", function () { dispatch("previous"); });
    if (nextButton) nextButton.addEventListener("click", function () { dispatch("next"); });
    apply();
  })();
}`;

export const FLOWCHART_STYLE_CSS: string = String.raw`svg{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
svg text{fill:#111}
g[data-node-id] rect{fill:#f4f4f4;stroke:#333333;stroke-width:1}
g[data-node-id] text{fill:#111111}
g[data-edge-id] path{fill:none;stroke:#666666;stroke-width:1.5}
g[data-edge-id] text{fill:#444444}
g[data-edge-id][data-basis="claimed"] path{stroke:#b26a00}
g[data-edge-id][data-basis="reported"] path{stroke:#7a5c00}
g[data-edge-id][data-basis="decoded"] path{stroke:#0b6e4f}
g[data-edge-id][data-basis="simulated"] path{stroke:#155e9c}
g[data-edge-id][data-basis="observed"] path{stroke:#1a7f37}
g[data-edge-id][data-basis="derived"] path{stroke:#5b3fa0}
g[data-edge-id][data-basis="unknown"] path{stroke:#888888;stroke-dasharray:4 3}
g[data-edge-id][data-basis="unknown"] text{fill:#666666}
[data-mark="selected"] rect{stroke:#111111;stroke-width:2.5}
[data-mark="selected"] path{stroke:#111111;stroke-width:2.5}
[data-mark="related"] rect{stroke:#333333}
[data-mark="dimmed"] rect{fill-opacity:0.4;stroke-opacity:0.4}
[data-mark="dimmed"] path{stroke-opacity:0.4}
g[tabindex]:focus rect{stroke:#155e9c;stroke-width:2.5}
table{border-collapse:collapse}
td,th{border:1px solid #cccccc;padding:10px 12px;text-align:left}
*{box-sizing:border-box}
body{margin:0;padding:32px;color:#182536;background:#f6f8fa;font:16px/1.5 system-ui,sans-serif;min-width:0}
h1{font-size:28px;line-height:1.2;margin:0 0 12px}
h2{font-size:18px;margin-top:32px}
p{margin:8px 0;overflow-wrap:anywhere}
#linchpin-flowchart-controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}
button{font:inherit;min-height:44px;padding:8px 16px;border:1px solid #64748b;border-radius:6px;background:white;color:#182536;cursor:pointer;transition:background 120ms}
button:hover{background:#e6efff}
button:disabled{color:#596574;background:#e8edf2;cursor:default}
:focus-visible{outline:3px solid #1d4ed8;outline-offset:3px}
.flowchart-workspace{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;margin-top:20px;border-top:1px solid #c5ced8;padding-top:20px}
.flowchart-workspace>*{min-width:0}
#linchpin-flowchart-canvas{overflow:auto;max-height:65vh;min-height:240px;background:white;border:1px solid #c5ced8}
svg{display:block;max-width:none}
#linchpin-flowchart-inspector{overflow-wrap:anywhere;padding:16px;border-left:2px solid #c5ced8}
dd{margin:0 0 12px}dt{font-weight:600}
table{display:block;overflow:auto;max-width:100%;background:white}
td{overflow-wrap:anywhere;min-width:130px}
g rect,g path{transition:stroke 120ms}
g:hover rect,g:hover path{stroke:#1d4ed8;stroke-width:2.5}
g:focus-visible path{stroke:#1d4ed8;stroke-width:3}
@media(max-width:800px){body{padding:16px}.flowchart-workspace{grid-template-columns:minmax(0,1fr)}#linchpin-flowchart-inspector{border-left:0;border-top:1px solid #c5ced8}}
@media(prefers-reduced-motion:reduce){button,g rect,g path{transition:none}}`;
