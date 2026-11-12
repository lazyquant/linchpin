/** A small layered layout for a graph result. Pure and deterministic: the same result gives the same coordinates. */
import { UiRejected } from "./types";
import type { GraphResult } from "./types";

export const MAX_GRAPH_NODES = 60;

export interface GraphLayout {
  width: number;
  height: number;
  nodes: { id: string; x: number; y: number; width: number; height: number; lines: string[] }[];
  /** `d` is the path data of the edge line; `arrow` the points of its arrowhead polygon. */
  edges: { key: string; d: string; arrow: string }[];
}

const NODE_WIDTH = 208;
const LINE_HEIGHT = 16;
const PAD_Y = 10;
const LINE_CHARS = 24;
const COLUMN_GAP = 88;
const ROW_GAP = 14;
const MARGIN = 16;
const ARROW = 7;
const LOOP_ROOM = 44;

/** Breaks a label into lines of at most `LINE_CHARS` characters, after a separator where one is near. Nothing is cut away. */
export function labelLines(label: string): string[] {
  const lines: string[] = [];
  let rest = label;
  while (rest.length > LINE_CHARS) {
    let cut = LINE_CHARS;
    for (let i = LINE_CHARS - 1; i >= 8; i--) {
      if (":./#|_- ".includes(rest[i])) { cut = i + 1; break; }
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  lines.push(rest);
  return lines;
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function layoutGraph(result: GraphResult): GraphLayout {
  if (result.nodes.length > MAX_GRAPH_NODES) throw new UiRejected("graph-too-large");

  const index = new Map<string, number>();
  const nodes = result.nodes.filter((node) => {
    if (index.has(node.id)) return false;
    index.set(node.id, index.size);
    return true;
  });
  const count = nodes.length;
  const edges = result.edges
    .map((edge) => ({ key: edge.key, from: index.get(edge.from), to: index.get(edge.to) }))
    .filter((edge): edge is { key: string; from: number; to: number } => edge.from !== undefined && edge.to !== undefined);

  // Layering graph: edges in input order, leaving out a self edge and any edge that would close a cycle.
  const next: number[][] = Array.from({ length: count }, () => []);
  const reaches = (start: number, goal: number): boolean => {
    const stack = [start];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (at === goal) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...next[at]);
    }
    return false;
  };
  for (const edge of edges) {
    if (edge.from === edge.to || next[edge.from].includes(edge.to) || reaches(edge.to, edge.from)) continue;
    next[edge.from].push(edge.to);
  }

  // Longest path from the nodes with no incoming edge.
  const incoming = new Array<number>(count).fill(0);
  for (const targets of next) for (const target of targets) incoming[target]++;
  const layer = new Array<number>(count).fill(0);
  const queue: number[] = [];
  for (let i = 0; i < count; i++) if (incoming[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    for (const target of next[at]) {
      layer[target] = Math.max(layer[target], layer[at] + 1);
      if (--incoming[target] === 0) queue.push(target);
    }
  }

  // Columns: one per layer, nodes in input order, each column centred on the tallest.
  const layerCount = count === 0 ? 0 : Math.max(...layer) + 1;
  const lines = nodes.map((node) => labelLines(node.label));
  const heights = lines.map((own) => PAD_Y * 2 + LINE_HEIGHT * own.length);
  const columns: number[][] = Array.from({ length: layerCount }, () => []);
  for (let i = 0; i < count; i++) columns[layer[i]].push(i);
  const columnHeight = columns.map((members) => members.reduce((sum, i) => sum + heights[i], 0) + ROW_GAP * Math.max(0, members.length - 1));
  const tallest = Math.max(0, ...columnHeight);
  const boxes = new Array<{ x: number; y: number; width: number; height: number }>(count);
  columns.forEach((members, column) => {
    let y = MARGIN + Math.round((tallest - columnHeight[column]) / 2);
    for (const i of members) {
      boxes[i] = { x: MARGIN + column * (NODE_WIDTH + COLUMN_GAP), y, width: NODE_WIDTH, height: heights[i] };
      y += heights[i] + ROW_GAP;
    }
  });

  // Ports: each edge end takes a place on a side of its box, ordered by where the other end lies.
  type Side = "left" | "right";
  const sides = edges.map((edge): { from: Side; to: Side } => {
    if (layer[edge.to] > layer[edge.from]) return { from: "right", to: "left" };
    if (layer[edge.to] < layer[edge.from]) return { from: "left", to: "right" };
    return { from: "right", to: "right" };
  });
  const centre = (i: number): number => boxes[i].y + boxes[i].height / 2;
  const ports = new Map<string, { edge: number; end: 0 | 1; other: number }[]>();
  edges.forEach((edge, e) => {
    const add = (node: number, side: Side, end: 0 | 1, other: number): void => {
      const key = `${node}:${side}`;
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key)!.push({ edge: e, end, other });
    };
    add(edge.from, sides[e].from, 0, centre(edge.to));
    add(edge.to, sides[e].to, 1, centre(edge.from));
  });
  const portY: [number, number][] = edges.map(() => [0, 0]);
  for (const [key, list] of ports) {
    const node = Number(key.split(":")[0]);
    list.sort((a, b) => a.other - b.other || a.edge - b.edge || a.end - b.end);
    list.forEach((port, place) => {
      portY[port.edge][port.end] = round(boxes[node].y + (boxes[node].height * (place + 1)) / (list.length + 1));
    });
  }

  let needsLoopRoom = false;
  const outEdges = edges.map((edge, e) => {
    const from = boxes[edge.from];
    const to = boxes[edge.to];
    const [y1, y2] = portY[e];
    let d: string;
    let arrow: string;
    if (sides[e].to === "left") {
      const x1 = from.x + from.width;
      const tip = to.x;
      const x2 = tip - ARROW;
      const pull = round(Math.max(28, (x2 - x1) / 2));
      d = `M${x1} ${y1} C${round(x1 + pull)} ${y1} ${round(x2 - pull)} ${y2} ${x2} ${y2}`;
      arrow = `${tip},${y2} ${x2},${round(y2 - ARROW / 2)} ${x2},${round(y2 + ARROW / 2)}`;
    } else {
      const tip = to.x + to.width;
      const x2 = tip + ARROW;
      const x1 = sides[e].from === "right" ? from.x + from.width : from.x;
      if (sides[e].from === "right") {
        if (layer[edge.from] === layerCount - 1) needsLoopRoom = true;
        const bulge = round(Math.min(LOOP_ROOM - ARROW - 4, 22 + Math.abs(y2 - y1) / 8));
        d = `M${x1} ${y1} C${round(x1 + bulge)} ${y1} ${round(x2 + bulge)} ${y2} ${x2} ${y2}`;
      } else {
        const pull = round(Math.max(28, (x1 - x2) / 2));
        d = `M${x1} ${y1} C${round(x1 - pull)} ${y1} ${round(x2 + pull)} ${y2} ${x2} ${y2}`;
      }
      arrow = `${tip},${y2} ${x2},${round(y2 - ARROW / 2)} ${x2},${round(y2 + ARROW / 2)}`;
    }
    return { key: edge.key, d, arrow };
  });

  const width = count === 0 ? 0 : MARGIN * 2 + layerCount * NODE_WIDTH + (layerCount - 1) * COLUMN_GAP + (needsLoopRoom ? LOOP_ROOM : 0);
  const height = count === 0 ? 0 : MARGIN * 2 + tallest;
  return {
    width,
    height,
    nodes: nodes.map((node, i) => ({ id: node.id, ...boxes[i], lines: lines[i] })),
    edges: outEdges,
  };
}
