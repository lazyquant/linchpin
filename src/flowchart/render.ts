import { FLOWCHART_STYLE_CSS, FLOWCHART_VIEWER_JS } from "./assets";
import type { FlowchartEdge, FlowchartModel, FlowchartNode } from "./types";

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
}

function sha256Base64(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("base64");
}

function sequenceLine(model: FlowchartModel): string {
  if (model.sequence === null) return "No sequence";
  if (model.sequence === "observed-execution") return "Sequence: observed-execution";
  return `Sequence: ${model.sequence} (reading order, not an observed execution)`;
}

type Box = { x: number; y: number; w: number; h: number };

function layout(model: FlowchartModel): { boxes: Map<string, Box>; width: number; height: number } {
  const count = model.nodes.length;
  const index = new Map<string, number>();
  for (let i = 0; i < count; i++) index.set(model.nodes[i].id, i);

  const level = model.nodes.map(() => 0);
  const indeg = model.nodes.map(() => 0);
  for (const edge of model.edges) {
    if (edge.from === edge.to) continue;
    const target = index.get(edge.to);
    if (target !== undefined) indeg[target] += 1;
  }

  const done = model.nodes.map(() => false);
  for (let processed = 0; processed < count; processed++) {
    let pick = -1;
    for (let i = 0; i < count; i++) {
      if (!done[i] && indeg[i] === 0) {
        pick = i;
        break;
      }
    }
    if (pick === -1) {
      for (let i = 0; i < count; i++) {
        if (!done[i]) {
          pick = i;
          break;
        }
      }
    }
    if (pick === -1) break;
    done[pick] = true;
    const from = model.nodes[pick].id;
    for (const edge of model.edges) {
      if (edge.from !== from || edge.to === from) continue;
      const target = index.get(edge.to);
      if (target === undefined || done[target]) continue;
      level[target] = Math.max(level[target], level[pick] + 1);
      indeg[target] -= 1;
    }
  }

  const widths = model.nodes.map((node) => Math.max(120, 24 + 9 * node.label.length));
  const maxW = widths.length > 0 ? Math.max(...widths) : 80;
  const colW = maxW + Math.max(200, ...model.edges.map(edge => 40 + 18 * (edge.relation.length + (edge.basis ?? "not evidence").length + 3)));
  // Reserve routing space only where a pair actually needs extra lanes.
  const pairs = new Map<string, number>();
  const clearance = new Map<string, number>();
  for (const edge of model.edges) {
    const key = `${edge.from}\u0000${edge.to}`;
    const lanes = (pairs.get(key) ?? 0) + 1;
    pairs.set(key, lanes);
    for (const id of [edge.from, edge.to]) {
      clearance.set(id, Math.max(clearance.get(id) ?? 0, lanes * 24));
    }
  }
  const PAD = 32;

  const rowCounts: number[] = [];
  const columnBottoms: number[] = [];
  const boxes = new Map<string, Box>();
  for (let i = 0; i < count; i++) {
    const column = level[i];
    const row = rowCounts[column] ?? 0;
    rowCounts[column] = row + 1;
    const y = columnBottoms[column] ?? PAD;
    boxes.set(model.nodes[i].id, { x: PAD + column * colW, y, w: widths[i], h: 48 });
    columnBottoms[column] = y + 120 + (clearance.get(model.nodes[i].id) ?? 0);
  }

  const cols = Math.max(1, ...level.map((value) => value + 1));
  return { boxes, width: 2 * PAD + cols * colW, height: PAD + Math.max(120, ...columnBottoms) };
}

type Point = { x: number; y: number };

// Visibility grid: only obstacle boundaries and terminal coordinates are needed.
// Breadth-first search deterministically finds a route over adjacent grid points.
function corridor(start: Point, end: Point, obstacles: Box[]): Point[] {
  const xs = [...new Set([16, start.x, end.x, ...obstacles.flatMap(b => [b.x - 8, b.x + b.w + 8])])].sort((a,b) => a-b);
  const ys = [...new Set([16, start.y, end.y, ...obstacles.flatMap(b => [b.y - 8, b.y + b.h + 8])])].sort((a,b) => a-b);
  const clear = (a: Point, b: Point) => !obstacles.some(r => a.x === b.x
    ? a.x > r.x && a.x < r.x+r.w && Math.max(a.y,b.y)>r.y && Math.min(a.y,b.y)<r.y+r.h
    : a.y > r.y && a.y < r.y+r.h && Math.max(a.x,b.x)>r.x && Math.min(a.x,b.x)<r.x+r.w);
  const key = (x: number,y: number) => y*xs.length+x;
  const first=key(xs.indexOf(start.x),ys.indexOf(start.y)), last=key(xs.indexOf(end.x),ys.indexOf(end.y));
  const queue=[first], parent=new Map<number,number>([[first,-1]]);
  for(let head=0;head<queue.length && !parent.has(last);head++) {
    const id=queue[head], x=id%xs.length, y=Math.floor(id/xs.length);
    for(const [dx,dy] of [[1,0],[0,1],[-1,0],[0,-1]]) {
      const nx=x+dx,ny=y+dy;
      if(nx<0||ny<0||nx>=xs.length||ny>=ys.length) continue;
      const next=key(nx,ny);
      if(!parent.has(next)&&clear({x:xs[x],y:ys[y]},{x:xs[nx],y:ys[ny]})) {parent.set(next,id);queue.push(next);}
    }
  }
  if(!parent.has(last)) throw new Error("No obstacle-free flowchart corridor");
  const points: Point[]=[];
  for(let id=last;id!==-1;id=parent.get(id)!) points.push({x:xs[id%xs.length],y:ys[Math.floor(id/xs.length)]});
  return points.reverse();
}

function edgeGeometry(model: FlowchartModel, boxes: Map<string, Box>): Map<string, { d: string; lx: number; ly: number }> {
  const geometry = new Map<string, { d: string; lx: number; ly: number }>();
  const obstacles=[...boxes.values()];
  const reserved: Box[]=[];
  for (const edge of model.edges) {
    const from=boxes.get(edge.from)!, to=boxes.get(edge.to)!;
    const w=9*(edge.relation.length+basisWord(edge).length+3)+16;
    // Pack labels in the outgoing column corridor, growing locally downwards.
    const label: Box={x:from.x+from.w+24,y:from.y+60,w,h:24};
    while([...obstacles,...reserved].some(r=>label.x<r.x+r.w+8&&label.x+label.w+8>r.x&&label.y<r.y+r.h+8&&label.y+label.h+8>r.y)) label.y+=32;
    const start={x:from.x+from.w,y:from.y+24};
    const end={x:to.x,y:to.y+24};
    const left={x:label.x-8,y:label.y+label.h+6};
    const right={x:label.x+label.w+8,y:left.y};
    const blocked=[...obstacles,...reserved,label];
    const points=[start,...corridor({x:start.x+8,y:start.y},left,blocked),right,
      ...corridor(right,{x:end.x-8,y:end.y},blocked),end];
    const d=points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' ')+` M ${end.x} ${end.y} L ${end.x-8} ${end.y-4} L ${end.x-8} ${end.y+4} Z`;
    geometry.set(edge.id,{d,lx:label.x+8,ly:label.y+18});
    reserved.push(label);
  }
  return geometry;
}

function basisWord(edge: FlowchartEdge): string {
  return edge.basis === null ? "not evidence" : edge.basis;
}

function verificationWord(edge: FlowchartEdge): string {
  return edge.verification === null ? "not stated" : edge.verification;
}

export function renderFlowchartHtml(model: FlowchartModel): string {
  const labels = new Map<string, string>();
  for (const node of model.nodes) labels.set(node.id, node.label);
  const labelOf = (id: string): string => labels.get(id) ?? id;

  const { boxes, width: initialWidth, height: initialHeight } = layout(model);
  const geometry = edgeGeometry(model, boxes);
  let width=initialWidth, height=initialHeight;
  for(const shape of geometry.values()) {
    const coordinates=shape.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    for(let i=0;i<coordinates.length;i+=2) {width=Math.max(width,coordinates[i]+32);height=Math.max(height,coordinates[i+1]+32);}
  }

  const edgeGroups = model.edges
    .map((edge) => {
      const shape = geometry.get(edge.id)!;
      return `<g data-edge-id="${esc(edge.id)}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" data-relation="${esc(edge.relation)}" data-basis="${esc(edge.basis ?? "none")}" data-verification="${esc(edge.verification ?? "none")}" data-evidence-count="${edge.evidenceIds.length}" tabindex="0" aria-label="${esc(labelOf(edge.from))} ${esc(edge.relation)} ${esc(labelOf(edge.to))}"><path d="${shape.d}"></path><text x="${shape.lx}" y="${shape.ly}">${esc(edge.relation)} (${esc(basisWord(edge))})</text></g>`;
    })
    .join("");

  const nodeGroups = model.nodes
    .map((node) => {
      const box = boxes.get(node.id)!;
      return `<g data-node-id="${esc(node.id)}" data-kind="${esc(node.kind)}" tabindex="0" aria-label="${esc(node.label)}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="48" rx="4"></rect><text x="${box.x + 12}" y="${box.y + 30}">${esc(node.label)}</text></g>`;
    })
    .join("");

  const emptyText = model.nodes.length === 0 ? `<text x="24" y="40">No nodes</text>` : "";

  const nodeRows = model.nodes
    .map((node) => `<tr data-node-row="${esc(node.id)}"><td>${esc(node.id)}</td><td>${esc(node.kind)}</td><td>${esc(node.label)}</td></tr>`)
    .join("");

  const edgeRows = model.edges
    .map((edge) => {
      const evidence = edge.evidenceIds.length > 0 ? edge.evidenceIds.join(", ") : "no evidence";
      return `<tr data-edge-row="${esc(edge.id)}"><td>${esc(edge.id)}</td><td>${esc(labelOf(edge.from))}</td><td>${esc(edge.relation)}</td><td>${esc(labelOf(edge.to))}</td><td>${esc(basisWord(edge))}</td><td>${esc(verificationWord(edge))}</td><td>${esc(evidence)}</td><td>${esc(edge.sourceId ?? "none")}</td></tr>`;
    })
    .join("");

  const stepItems = model.steps
    .map((step) => {
      const suffix = step.nodeIds.length > 0 ? `: ${step.nodeIds.map((id) => esc(labelOf(id))).join(", ")}` : "";
      return `<li data-step-id="${esc(step.id)}">${esc(step.title)}${suffix}</li>`;
    })
    .join("");

  const noteItems = model.notes.map((note) => `<li data-note>${esc(note)}</li>`).join("");

  const count = model.steps.length || model.nodes.length;
  const disabled = count === 0 ? " disabled" : "";
  const unit = model.steps.length ? "step" : "item";
  const mode = model.steps.length ? `Model steps — sequence ${model.sequence === null ? "not stated" : "shown above"}` : "Guided walkthrough — reading order, not observed execution";

  const policy = `default-src 'none'; script-src 'sha256-${sha256Base64(FLOWCHART_VIEWER_JS)}'; style-src 'sha256-${sha256Base64(FLOWCHART_STYLE_CSS)}'; base-uri 'none'; form-action 'none'`;

  const canonical = {
    schema: model.schema,
    source: model.source,
    title: model.title,
    nodes: model.nodes.map((node) => ({ id: node.id, kind: node.kind, label: node.label })),
    edges: model.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, relation: edge.relation, basis: edge.basis, verification: edge.verification, evidenceIds: edge.evidenceIds, sourceId: edge.sourceId })),
    sequence: model.sequence,
    steps: model.steps.map((step) => ({ id: step.id, title: step.title, nodeIds: step.nodeIds, edgeIds: step.edgeIds })),
    notes: model.notes,
    sha256: model.sha256,
  };
  const modelJson = JSON.stringify(canonical).replace(/</g, "\\u003c");

  const svg = `<svg id="linchpin-flowchart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${edgeGroups}${nodeGroups}${emptyText}</svg>`;

  const lines = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${esc(policy)}">`,
    `<title>${esc(model.title)}</title>`,
    `<style>${FLOWCHART_STYLE_CSS}</style>`,
    "</head>",
    "<body>",
    `<h1>${esc(model.title)}</h1>`,
    `<p id="linchpin-flowchart-source">${esc(model.source)}</p>`,
    `<p id="linchpin-flowchart-sequence">${esc(sequenceLine(model))}</p>`,
    `<div id="linchpin-flowchart-controls"><button type="button" id="linchpin-flowchart-play"${disabled}>Play</button><button type="button" id="linchpin-flowchart-stop" disabled>Stop</button><button type="button" id="linchpin-flowchart-replay"${disabled}>Replay</button><button type="button" id="linchpin-flowchart-prev"${disabled}>Previous ${unit}</button><button type="button" id="linchpin-flowchart-next"${disabled}>Next ${unit}</button></div>`,
    `<p id="linchpin-flowchart-playback-status" role="status" aria-live="polite" aria-atomic="true">Stopped — item 0 of ${count}${count ? "" : ". No items to play."}</p>`,
    `<p id="linchpin-flowchart-playback-mode">${mode}</p>`,
    '<p id="linchpin-flowchart-playback-help">Playback needs JavaScript</p>',
    `<div class="flowchart-workspace"><div id="linchpin-flowchart-canvas" tabindex="0" aria-label="Scrollable flowchart"><div id="linchpin-flowchart-chart">${svg}</div></div><aside id="linchpin-flowchart-inspector" aria-live="polite">Select a node or an edge</aside></div>`,
    "<h2>Steps</h2>",
    `<ol id="linchpin-flowchart-steps">${stepItems}</ol>`,
    "<h2>Notes</h2>",
    `<ul id="linchpin-flowchart-notes">${noteItems}</ul>`,
    "<h2>Nodes</h2>",
    `<table id="linchpin-flowchart-nodes"><thead><tr><th>id</th><th>kind</th><th>label</th></tr></thead><tbody>${nodeRows}</tbody></table>`,
    "<h2>Edges</h2>",
    `<table id="linchpin-flowchart-edges"><thead><tr><th>edge</th><th>from</th><th>relation</th><th>to</th><th>basis</th><th>verification</th><th>evidence</th><th>source id</th></tr></thead><tbody>${edgeRows}</tbody></table>`,
    `<script type="application/json" id="linchpin-flowchart-model">${modelJson}</script>`,
    `<script id="linchpin-flowchart-viewer">${FLOWCHART_VIEWER_JS}</script>`,
    "</body>",
    "</html>",
  ];
  return lines.join("\n") + "\n";
}
