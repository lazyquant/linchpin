/**
 * Draws an explorer model: one SVG, then the same nodes, groups and edges as text lists. It decides where things
 * sit and nothing about what is there; a different drawing layer can take its place without a change to the model.
 */
import { CONTROL_LAYER, DEFAULT_LAYER } from "./explorer-model";
import type { ExplorerGroup, ExplorerModel, ExplorerNode } from "./explorer-model";
import { CHIP_LIMIT, CLASSES, SELECT_ATTR, SELECT_ID_ATTR, STRINGS } from "./strings";
import type { GraphEdge, UiNode } from "./types";

const BOX_WIDTH = 208;
const COLUMN_GAP = 92;
const ROW_GAP = 12;
const PAD = 24;
const HEAD = 26;
const BAND_GAP = 28;
const LINE = 15;
const LABEL_CHARS = 27;

function el(tag: string, className: string, text?: string, children: UiNode[] = [], attrs: Record<string, string> = {}): UiNode {
  const node: UiNode = { tag, attrs: className ? { class: className, ...attrs } : { ...attrs }, children };
  if (text !== undefined) node.text = text;
  return node;
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (value: number): string => String(Math.round(value * 10) / 10);
/** The class part of a layer: its letters in lower case. */
export const layerSlug = (layer: string): string => layer.toLowerCase().replace(/[^a-z]/g, "") || "structure";
const layerOf = (edge: GraphEdge): string => (typeof edge.layer === "string" && edge.layer !== "" ? edge.layer : DEFAULT_LAYER);
const selectable = (kind: string, id: string): Record<string, string> => ({ [SELECT_ATTR]: kind, [SELECT_ID_ATTR]: id });

/** A label on several lines: broken between words where it has them, else at any character. Nothing is cut. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    let rest = word;
    if (line !== "" && line.length + 1 + rest.length <= LABEL_CHARS) {
      line += ` ${rest}`;
      continue;
    }
    if (line !== "") lines.push(line);
    while (rest.length > LABEL_CHARS) {
      lines.push(rest.slice(0, LABEL_CHARS));
      rest = rest.slice(LABEL_CHARS);
    }
    line = rest;
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

interface Box {
  key: string;
  type: "node" | "group" | "gap";
  band: "control" | "main";
  column: number;
  sort: string;
  lines: string[];
  head: string;
  node?: ExplorerNode;
  group?: ExplorerGroup;
  gap?: "none" | "unknown";
  count?: number;
  x: number; y: number; height: number;
}

/** Stage of each node in whole mode: the longest way to it from a node nothing points at. */
function stages(model: ExplorerModel): Map<string, number> {
  const stage = new Map(model.nodes.map((node) => [node.id, 0]));
  for (let round = 0; round < model.nodes.length; round++) {
    let moved = false;
    for (const edge of model.edges) {
      const next = (stage.get(edge.from) ?? 0) + 1;
      if (edge.from !== edge.to && next > (stage.get(edge.to) ?? 0) && next < model.nodes.length) {
        stage.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return stage;
}

function layout(model: ExplorerModel): { boxes: Box[]; width: number; height: number; heads: { text: string; x: number; y: number }[]; boxOf: (id: string) => Box | undefined } {
  const boxes: Box[] = [];
  const whole = model.focus === null;
  const stage = whole ? stages(model) : new Map<string, number>();
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const columnOf = (node: ExplorerNode): number => (whole ? stage.get(node.id) ?? 0 : node.lane === "rested-on-by" ? -node.step : node.step);
  const bandOf = (node: ExplorerNode): "control" | "main" => (node.lane === "control" ? "control" : "main");
  for (const node of model.nodes) {
    if (node.foldedInto !== null) continue;
    const lines = wrap(node.name ?? node.label);
    boxes.push({ key: `n:${node.id}`, type: "node", band: bandOf(node), column: columnOf(node), sort: `0${node.name ?? node.label}\u0000${node.id}`, lines, head: node.kind ?? STRINGS.kindNotRecorded, node, x: 0, y: 0, height: 0 });
  }
  for (const group of model.groups) {
    const folded = group.memberIds.map((id) => nodeById.get(id)).filter((node): node is ExplorerNode => node !== undefined && node.foldedInto === group.id);
    if (group.expanded || folded.length === 0) continue;
    const count = model.nodes.filter((node) => node.foldedInto === group.id).length;
    boxes.push({ key: `g:${group.id}`, type: "group", band: bandOf(folded[0]), column: columnOf(folded[0]), sort: `1${group.relation}\u0000${group.id}`, lines: [STRINGS.more(count)], head: group.relation, group, count, x: 0, y: 0, height: 0 });
  }
  for (const end of model.gapEnds) {
    const from = nodeById.get(end.from);
    if (!from || from.foldedInto !== null) continue;
    const edge = model.gapEdges.find((candidate) => candidate.key === end.edgeKey);
    const control = edge !== undefined && layerOf(edge) === CONTROL_LAYER && !whole;
    const column = columnOf(from) + (from.lane === "rested-on-by" && !control ? -1 : 1);
    boxes.push({ key: `e:${end.edgeKey}`, type: "gap", band: control ? "control" : bandOf(from), column: control && from.lane !== "control" ? Math.max(1, from.step + 1) : column, sort: `2${end.edgeKey}`, lines: [end.end === "unknown" ? STRINGS.unknown : STRINGS.none], head: edge?.relation ?? "", gap: end.end, x: 0, y: 0, height: 0 });
  }
  // Columns in use, side by side: an empty column between two used ones takes no room.
  const used = [...new Set([0, ...boxes.map((box) => box.column)])].sort((a, b) => a - b);
  for (const box of boxes) box.column = used.indexOf(box.column) - used.indexOf(0);
  const columns = boxes.map((box) => box.column);
  const minColumn = Math.min(0, ...columns);
  const maxColumn = Math.max(0, ...columns);
  const bandHeight = (band: "control" | "main"): number => {
    let tallest = 0;
    for (let column = minColumn; column <= maxColumn; column++) {
      const stack = boxes.filter((box) => box.band === band && box.column === column).sort((a, b) => cmp(a.sort, b.sort));
      let y = 0;
      for (const box of stack) {
        box.height = (box.head === "" ? 16 : 30) + LINE * box.lines.length;
        box.x = PAD + (column - minColumn) * (BOX_WIDTH + COLUMN_GAP);
        box.y = y;
        y += box.height + ROW_GAP;
      }
      tallest = Math.max(tallest, y - ROW_GAP);
    }
    return Math.max(0, tallest);
  };
  const controlHeight = bandHeight("control");
  const mainHeight = bandHeight("main");
  const hasControl = boxes.some((box) => box.band === "control");
  const controlTop = PAD + HEAD;
  const mainTop = hasControl ? controlTop + controlHeight + BAND_GAP + HEAD : PAD + (whole ? 0 : HEAD);
  for (const box of boxes) box.y += box.band === "control" ? controlTop : mainTop;
  const heads: { text: string; x: number; y: number }[] = [];
  const xOf = (column: number): number => PAD + (column - minColumn) * (BOX_WIDTH + COLUMN_GAP);
  if (!whole) {
    if (hasControl) heads.push({ text: STRINGS.laneControl, x: xOf(1), y: controlTop - 10 });
    if (boxes.some((box) => box.band === "main" && box.column > 0)) heads.push({ text: STRINGS.laneRestsOn, x: xOf(1), y: mainTop - 10 });
    if (boxes.some((box) => box.band === "main" && box.column < 0)) heads.push({ text: STRINGS.laneRestedOnBy, x: xOf(minColumn), y: mainTop - 10 });
  }
  const byKey = new Map(boxes.map((box) => [box.key, box]));
  const boxOf = (id: string): Box | undefined => {
    const node = nodeById.get(id);
    if (!node) return undefined;
    return node.foldedInto === null ? byKey.get(`n:${id}`) : byKey.get(`g:${node.foldedInto}`);
  };
  return {
    boxes, heads, boxOf,
    width: PAD * 2 + (maxColumn - minColumn + 1) * BOX_WIDTH + (maxColumn - minColumn) * COLUMN_GAP + 44,
    height: mainTop + mainHeight + PAD,
  };
}

/** Diagonal lines inside a box, each cut to the box: the mark of an end that is unknown. */
function hatch(box: Box): UiNode[] {
  const lines: UiNode[] = [];
  for (let k = -box.height; k < BOX_WIDTH; k += 9) {
    const x0 = Math.max(k, 0);
    const x1 = Math.min(k + box.height, BOX_WIDTH);
    if (x0 >= x1) continue;
    lines.push(el("line", "lk-explorer-hatch", undefined, [], { x1: num(box.x + x0), y1: num(box.y + box.height - (x0 - k)), x2: num(box.x + x1), y2: num(box.y + box.height - (x1 - k)) }));
  }
  return lines;
}

function boxNode(box: Box, focus: string | null, select: boolean): UiNode {
  const x = num(box.x + 12);
  const text = (className: string, lines: string[], y: number): UiNode =>
    el("text", className, undefined, lines.map((line, at) => el("tspan", "", line, [], at === 0 ? { x } : { x, dy: String(LINE) })), { x, y: num(y) });
  const rect = el("rect", "lk-explorer-box", undefined, [], { x: num(box.x), y: num(box.y), width: String(BOX_WIDTH), height: num(box.height), rx: "2" });
  const head = box.head === "" ? el("g", "") : text("lk-explorer-kind", [box.head], box.y + 17);
  const body = text("lk-explorer-label", box.lines, box.y + (box.head === "" ? 20 : 34));
  if (box.type === "node") {
    const node = box.node!;
    const isFocus = node.id === focus;
    return el("g", isFocus ? `${CLASSES.explorerNode} ${CLASSES.focus}` : node.kind === null ? `${CLASSES.explorerNode} lk-kind-gap` : CLASSES.explorerNode, undefined,
      [el("title", "", node.id), rect, head, body], select ? selectable("node", node.id) : {});
  }
  if (box.type === "group") {
    return el("g", CLASSES.explorerGroup, undefined, [el("title", "", `${box.group!.relation}: ${STRINGS.more(box.count ?? 0)}`), rect, head, body], select ? selectable("group", box.group!.id) : {});
  }
  if (box.gap === "unknown") return el("g", `lk-explorer-gap ${CLASSES.unknown}`, undefined, [rect, ...hatch(box), head, body]);
  return el("g", `lk-explorer-gap ${CLASSES.none}`, undefined, [
    rect, head, el("circle", "lk-explorer-ring", undefined, [], { cx: num(box.x + 18), cy: num(box.y + 30), r: "5" }),
    el("text", "lk-explorer-label", box.lines[0], [], { x: num(box.x + 30), y: num(box.y + 34) }),
  ]);
}

/** One line from box to box, with its arrow. Boxes of one column are joined by a loop at their right. */
function edgeShape(from: Box, to: Box, offset: number): { d: string; arrow: string } {
  const loop = from === to ? from.height / 4 : 0;
  const fy = from.y + from.height / 2 + offset - loop;
  const ty = to.y + to.height / 2 + offset + loop;
  const tip = (x: number, y: number, direction: 1 | -1): string => `${num(x)},${num(y)} ${num(x - 7 * direction)},${num(y - 3.5)} ${num(x - 7 * direction)},${num(y + 3.5)}`;
  if (from.column === to.column) {
    const x = from.x + BOX_WIDTH;
    const reach = 26 + Math.min(18, Math.abs(ty - fy) / 12);
    return { d: `M${num(x)} ${num(fy)} C${num(x + reach)} ${num(fy)} ${num(x + reach)} ${num(ty)} ${num(x + 7)} ${num(ty)}`, arrow: tip(x, ty, -1) };
  }
  const right = to.column > from.column;
  const sx = right ? from.x + BOX_WIDTH : from.x;
  const tx = right ? to.x : to.x + BOX_WIDTH;
  const bend = Math.abs(tx - sx) / 2;
  const sign = right ? 1 : -1;
  return {
    d: `M${num(sx)} ${num(fy)} C${num(sx + bend * sign)} ${num(fy)} ${num(tx - bend * sign)} ${num(ty)} ${num(tx - 7 * sign)} ${num(ty)}`,
    arrow: tip(tx, ty, right ? 1 : -1),
  };
}

/** The drawing alone, or `null` when the model holds no node. `select` marks nodes, groups and edges as selectable. */
export function explorerSvg(model: ExplorerModel, opts: { select: boolean; label: string }): UiNode | null {
  if (model.nodes.length === 0) return null;
  const placed = layout(model);
  const drawing: UiNode[] = [];
  for (const head of placed.heads) drawing.push(el("text", "lk-explorer-lane", head.text, [], { x: num(head.x), y: num(head.y) }));
  type Line = { edge: GraphEdge; from: Box; to: Box; group: string | null };
  const lines: Line[] = [];
  const seen = new Set<string>();
  const line = (edge: GraphEdge, from: Box, to: Box, standsForGroup: string | null): void => {
    // Only a visibly folded bundle may stand for several edges. Ordinary edges
    // retain their own identity even when their endpoints and layer coincide.
    const key = standsForGroup === null ? `edge:${edge.key}` : JSON.stringify([from.key, to.key, layerOf(edge)]);
    if ((from === to && from.type === "group") || seen.has(key)) return;
    seen.add(key);
    lines.push({ edge, from, to, group: standsForGroup });
  };
  const boxByKey = new Map(placed.boxes.map((box) => [box.key, box]));
  for (const edge of model.edges) {
    const from = placed.boxOf(edge.from);
    const to = placed.boxOf(edge.to);
    if (!from || !to) continue;
    const group = from.type === "group" ? from.group!.id : to.type === "group" ? to.group!.id : null;
    line(edge, from, to, group);
  }
  for (const edge of model.gapEdges) {
    const from = placed.boxOf(edge.from);
    const to = boxByKey.get(`e:${edge.key}`);
    if (from && to && from.type === "node") line(edge, from, to, null);
  }
  const routes = new Map<string, Line[]>();
  for (const item of lines) {
    const key = JSON.stringify([item.from.key, item.to.key]);
    const siblings = routes.get(key) ?? [];
    siblings.push(item);
    routes.set(key, siblings);
  }
  const offsets = new Map<Line, number>();
  for (const siblings of routes.values()) {
    siblings.sort((a, b) => cmp(a.edge.key, b.edge.key));
    const { from, to } = siblings[0];
    const room = Math.max(0, (from === to ? from.height / 2 : Math.min(from.height, to.height)) - 16);
    const spacing = Math.min(16, room / Math.max(1, siblings.length - 1));
    siblings.forEach((item, at) => offsets.set(item, (at - (siblings.length - 1) / 2) * spacing));
  }
  for (const item of lines) {
    const { edge, from, to, group } = item;
    const shape = edgeShape(from, to, offsets.get(item) ?? 0);
    const unknown = edge.bases.includes(STRINGS.unknown) || edge.to === STRINGS.unknown ? " lk-edge-unknown" : "";
    const bundle = group !== null ? " lk-edge-bundle" : "";
    const attrs = !opts.select ? {} : group !== null ? selectable("group", group) : selectable("edge", edge.key);
    drawing.push(el("g", `${CLASSES.explorerEdge} lk-layer-${layerSlug(layerOf(edge))}${unknown}${bundle}`, undefined, [
      el("title", "", group !== null ? edge.relation : `${edge.relation}: ${edge.bases.join(", ")}`),
      el("path", "lk-explorer-hit", undefined, [], { d: shape.d }),
      el("path", "lk-explorer-line", undefined, [], { d: shape.d }),
      el("path", "lk-explorer-line-inner", undefined, [], { d: shape.d }),
      el("polygon", "lk-explorer-arrow", undefined, [], { points: shape.arrow }),
    ], attrs));
  }
  for (const box of placed.boxes) drawing.push(boxNode(box, model.focus, opts.select));
  return el("div", "lk-explorer-frame", undefined, [
    el("svg", "lk-explorer-svg", undefined, drawing, {
      viewBox: `0 0 ${num(placed.width)} ${num(placed.height)}`, width: num(placed.width), height: num(placed.height), role: "img", "aria-label": opts.label,
    }),
  ]);
}

function chip(evidenceIds: string[]): UiNode {
  if (evidenceIds.length === 0) return el("span", CLASSES.noEvidence, STRINGS.noEvidence);
  const drawn = evidenceIds.slice(0, CHIP_LIMIT);
  return el("details", CLASSES.chip, undefined, [
    el("summary", "lk-chip-summary", STRINGS.evidence, [el("span", CLASSES.count, String(evidenceIds.length))]),
    ...drawn.map((id) => el("code", CLASSES.evidenceId, id)),
    ...(evidenceIds.length > drawn.length ? [el("p", "lk-chip-cut", STRINGS.chipCut(evidenceIds.length - drawn.length))] : []),
  ]);
}

function edgeItem(edge: GraphEdge): UiNode {
  const gap = edge.to === STRINGS.unknown ? CLASSES.unknown : edge.to === STRINGS.none ? CLASSES.none : "";
  const observation = edge.blockOrSlot !== null && edge.blockOrSlot !== undefined
    ? [el("span", "lk-obs-label", STRINGS.blockOrSlot), el("span", `${CLASSES.observation} lk-mono`, String(edge.blockOrSlot))]
    : typeof edge.asOf === "string"
      ? [el("span", "lk-obs-label", STRINGS.asOf), el("span", `${CLASSES.observation} lk-mono`, edge.asOf)]
      : [el("span", "lk-obs-label", STRINGS.blockOrSlot), el("span", `${CLASSES.observation} lk-gap`, STRINGS.notRecorded)];
  return el("li", edge.bases.includes(STRINGS.unknown) || gap === CLASSES.unknown ? `${CLASSES.row} ${CLASSES.unknown}` : CLASSES.row, undefined, [
    el("div", "lk-edge", undefined, [
      el("span", "lk-id", edge.from), el("span", "lk-relation", edge.relation),
      el("span", gap ? `lk-value ${gap}` : "lk-id", edge.to),
      el("span", "lk-pair", undefined, [el("span", "lk-pair-label", STRINGS.layer), el("span", "lk-value", layerOf(edge))]),
    ]),
    el("div", "lk-prov", undefined, [
      el("span", "lk-bases", undefined, [el("span", "lk-obs-label", STRINGS.basis), ...edge.bases.map((basis) => el("span", basis === STRINGS.unknown ? `${CLASSES.basis} ${CLASSES.unknown}` : CLASSES.basis, basis))]),
      el("span", "lk-obs-group", undefined, observation),
      chip(edge.evidenceIds),
    ]),
  ], selectable("edge", edge.key));
}

/** The explorer: the drawing, then the nodes, the groups and the edges as text. Draws only what the model holds. */
export function drawExplorer(model: ExplorerModel): UiNode {
  const children: UiNode[] = [];
  const svg = explorerSvg(model, { select: true, label: STRINGS.explorerLabel });
  if (svg) children.push(svg);
  else children.push(el("p", "lk-empty", STRINGS.noNodes));
  children.push(el("p", "lk-list-label", STRINGS.graphNodes, [el("span", CLASSES.count, String(model.nodes.length))]));
  children.push(el("ul", "lk-explorer-nodes", undefined, model.nodes.map((node) => el("li", node.id === model.focus ? CLASSES.focus : "", undefined, [
    el("span", "lk-id", node.id),
    ...(node.name !== null ? [el("span", "lk-node-label", node.name)] : node.label !== node.id ? [el("span", "lk-node-label", node.label)] : []),
    node.kind !== null
      ? el("span", "lk-pair", undefined, [el("span", "lk-pair-label", STRINGS.kind), el("span", "lk-kind", node.kind), ...(node.kindBasis !== null ? [el("span", CLASSES.basis, node.kindBasis)] : [])])
      : el("span", "lk-gap", STRINGS.kindNotRecorded),
    ...(node.foldedInto !== null ? [el("span", "lk-isolated", STRINGS.inGroup)] : []),
  ], selectable("node", node.id)))));
  if (model.groups.length > 0) {
    children.push(el("p", "lk-list-label", STRINGS.explorerGroups, [el("span", CLASSES.count, String(model.groups.length))]));
    children.push(el("ul", "lk-explorer-groups", undefined, model.groups.map((group) => el("li", "", undefined, [
      el("span", "lk-pair", undefined, [el("span", "lk-pair-label", STRINGS.groupOf), el("span", "lk-relation", group.relation)]),
      el("span", "lk-id", group.anchor),
      el("span", "lk-value", group.expanded ? STRINGS.expandedGroup : STRINGS.more(group.memberIds.length)),
      el("span", "lk-group-members", undefined, group.memberIds.map((id) => el("span", "lk-id", id))),
    ], selectable("group", group.id)))));
  }
  const all = [...model.edges, ...model.gapEdges];
  children.push(el("p", "lk-list-label", STRINGS.graphEdges, [el("span", CLASSES.count, String(all.length))]));
  if (all.length === 0) children.push(el("p", "lk-empty", STRINGS.noEdges));
  children.push(el("ul", "lk-explorer-edges", undefined, all.map(edgeItem)));
  return el("figure", CLASSES.explorer, undefined, children);
}
