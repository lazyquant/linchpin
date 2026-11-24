/**
 * What a graph explorer draws, decided without drawing it: the nodes within a number of steps of a focus, their
 * lanes, the groups that fold large sets of neighbours, and the edges that end at no node. Pure: the same input
 * gives a deep-equal model. A drawing layer reads this model and nothing else.
 */
import { UiRejected } from "./types";
import type { GraphEdge, GraphResult } from "./types";

/** The layer whose edges, followed from the controlled node to its controller, form the control lane. */
export const CONTROL_LAYER = "Control";
/** The layer of an edge that names none. */
export const DEFAULT_LAYER = "Structure";
/** More neighbours by one relation than this are folded. */
export const FOLD_OVER = 6;
/** How many of them stay drawn, the first by name. */
export const FOLD_KEEP = 4;
/** The most nodes a model draws. */
export const MAX_EXPLORER_NODES = 60;

export type ExplorerLane = "focus" | "control" | "rests-on" | "rested-on-by" | "whole";
export interface ExplorerNode { id: string; label: string; name: string | null; kind: string | null; kindBasis: string | null; lane: ExplorerLane; step: number; foldedInto: string | null }
export interface ExplorerGroup { id: string; anchor: string; relation: string; side: "out" | "in"; memberIds: string[]; expanded: boolean }
export interface ExplorerGapEnd { edgeKey: string; from: string; end: "none" | "unknown" }
export interface ExplorerModel {
  focus: string | null;
  steps: number;
  layers: string[];
  nodes: ExplorerNode[];
  /** Every active edge between two kept nodes, each the input edge unchanged. */
  edges: GraphEdge[];
  /** Active edges that end at the literal `none` or `unknown` and no node. */
  gapEdges: GraphEdge[];
  gapEnds: ExplorerGapEnd[];
  groups: ExplorerGroup[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const layerOf = (edge: GraphEdge): string => (typeof edge.layer === "string" && edge.layer !== "" ? edge.layer : DEFAULT_LAYER);

/** The id of the group that folds the neighbours of `anchor` by `relation` on one side. */
export function groupId(anchor: string, relation: string, side: "out" | "in"): string {
  return `${anchor}|${relation}|${side}`;
}

export function explorerModel(result: GraphResult, opts: { focus?: string; steps?: number; layers?: string[]; expanded?: string[] } = {}): ExplorerModel {
  const steps = opts.steps ?? 2;
  if (steps !== 1 && steps !== 2 && steps !== 3) throw new UiRejected("bad-steps");
  const order = new Map<string, number>();
  result.nodes.forEach((node, at) => {
    if (!order.has(node.id)) order.set(node.id, at);
  });
  if (opts.focus !== undefined && !order.has(opts.focus)) throw new UiRejected("unknown-node");

  const present: string[] = [];
  for (const edge of result.edges) if (!present.includes(layerOf(edge))) present.push(layerOf(edge));
  const layers = opts.layers ? [...opts.layers] : present;
  const active = result.edges.filter((edge) => layers.includes(layerOf(edge)));
  const isGap = (edge: GraphEdge): boolean => (edge.to === "none" || edge.to === "unknown") && !order.has(edge.to);
  const real = active.filter((edge) => !isGap(edge) && order.has(edge.from) && order.has(edge.to));
  const gaps = active.filter((edge) => isGap(edge) && order.has(edge.from));
  const gapEndsOf = (kept: Set<string>): { gapEdges: GraphEdge[]; gapEnds: ExplorerGapEnd[] } => {
    const gapEdges = gaps.filter((edge) => kept.has(edge.from));
    return { gapEdges, gapEnds: gapEdges.map((edge) => ({ edgeKey: edge.key, from: edge.from, end: edge.to as "none" | "unknown" })) };
  };
  const describe = (id: string, lane: ExplorerLane, step: number): ExplorerNode => {
    const node = result.nodes[order.get(id)!];
    return {
      id, label: node.label, name: typeof node.name === "string" && node.name !== "" ? node.name : null,
      kind: typeof node.kind === "string" && node.kind !== "" ? node.kind : null,
      kindBasis: typeof node.kindBasis === "string" && node.kindBasis !== "" ? node.kindBasis : null,
      lane, step, foldedInto: null,
    };
  };

  // Whole mode: every node, every active edge, nothing folded.
  if (opts.focus === undefined) {
    const ids = [...order.keys()];
    if (ids.length > MAX_EXPLORER_NODES) throw new UiRejected("graph-too-large");
    return { focus: null, steps, layers, nodes: ids.map((id) => describe(id, "whole", 0)), edges: real, ...gapEndsOf(new Set(ids)), groups: [] };
  }

  const focus = opts.focus;
  const out = new Map<string, GraphEdge[]>();
  const into = new Map<string, GraphEdge[]>();
  for (const edge of real) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from)!.push(edge);
    if (!into.has(edge.to)) into.set(edge.to, []);
    into.get(edge.to)!.push(edge);
  }
  const byInput = (a: string, b: string): number => order.get(a)! - order.get(b)!;

  // Distance from the focus, direction ignored. A node's parent is the node it was first reached from.
  const step = new Map<string, number>([[focus, 0]]);
  const parent = new Map<string, { id: string; side: "out" | "in" }>();
  let frontier = [focus];
  for (let depth = 1; depth <= steps && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const at of frontier) {
      const reached: { id: string; side: "out" | "in" }[] = [
        ...(out.get(at) ?? []).map((edge) => ({ id: edge.to, side: "out" as const })),
        ...(into.get(at) ?? []).map((edge) => ({ id: edge.from, side: "in" as const })),
      ];
      for (const neighbour of reached) {
        if (step.has(neighbour.id)) continue;
        step.set(neighbour.id, depth);
        parent.set(neighbour.id, { id: at, side: neighbour.side });
        next.push(neighbour.id);
      }
    }
    frontier = next.sort(byInput);
  }

  // The control lane: reached from the focus along control edges, controlled to controller, in as many steps.
  const controlStep = new Map<string, number>([[focus, 0]]);
  let controlFrontier = [focus];
  for (let depth = 1; depth <= steps && controlFrontier.length > 0; depth++) {
    const next: string[] = [];
    for (const at of controlFrontier) {
      for (const edge of out.get(at) ?? []) {
        if (layerOf(edge) !== CONTROL_LAYER || controlStep.has(edge.to)) continue;
        controlStep.set(edge.to, depth);
        next.push(edge.to);
      }
    }
    controlFrontier = next;
  }

  const neighboursOf = (id: string): string[] => [...(out.get(id) ?? []).map((edge) => edge.to), ...(into.get(id) ?? []).map((edge) => edge.from)];
  const kept = [...step.keys()].sort(byInput);
  const lanes = new Map<string, ExplorerLane>([[focus, "focus"]]);
  const laneOf = (id: string): ExplorerLane => {
    const known = lanes.get(id);
    if (known) return known;
    let lane: ExplorerLane;
    if (controlStep.get(id) === step.get(id)) lane = "control";
    else {
      // The side of the node it was reached from. Where that node is in the control lane, the side of another
      // neighbour one step nearer the focus, if one has a side; else the direction of the edge that reached it.
      const from = parent.get(id)!;
      const nearer = [from.id, ...neighboursOf(id).filter((other) => step.get(other) === step.get(id)! - 1).sort(byInput)];
      const sided = nearer.map((other) => laneOf(other)).find((above) => above === "rests-on" || above === "rested-on-by");
      lane = sided ?? (from.side === "out" ? "rests-on" : "rested-on-by");
    }
    lanes.set(id, lane);
    return lane;
  };
  // A node the focus both rests on and is rested on by reads as what the focus rests on.
  for (const edge of out.get(focus) ?? []) {
    if (step.get(edge.to) === 1 && controlStep.get(edge.to) !== 1) lanes.set(edge.to, "rests-on");
  }
  const nodes = kept.map((id) => describe(id, laneOf(id), step.get(id)!));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const keptSet = new Set(kept);
  const edges = real.filter((edge) => keptSet.has(edge.from) && keptSet.has(edge.to));

  // Folding: by anchor, relation and side, among the nodes one step further out.
  const sortName = (id: string): string => nodeById.get(id)!.name ?? nodeById.get(id)!.label;
  const candidates: ExplorerGroup[] = [];
  for (const anchor of nodes) {
    const sets = new Map<string, { relation: string; side: "out" | "in"; ids: string[] }>();
    const add = (relation: string, side: "out" | "in", other: string): void => {
      if (step.get(other) !== anchor.step + 1) return;
      const key = groupId(anchor.id, relation, side);
      if (!sets.has(key)) sets.set(key, { relation, side, ids: [] });
      if (!sets.get(key)!.ids.includes(other)) sets.get(key)!.ids.push(other);
    };
    for (const edge of edges) {
      if (edge.from === anchor.id) add(edge.relation, "out", edge.to);
      if (edge.to === anchor.id) add(edge.relation, "in", edge.from);
    }
    for (const [id, set] of sets) {
      if (set.ids.length <= FOLD_OVER) continue;
      const ordered = [...set.ids].sort((a, b) => cmp(sortName(a), sortName(b)) || cmp(a, b));
      candidates.push({ id, anchor: anchor.id, relation: set.relation, side: set.side, memberIds: ordered.slice(FOLD_KEEP).sort(cmp), expanded: false });
    }
  }
  const expanded = new Set(opts.expanded ?? []);
  for (const group of candidates) group.expanded = expanded.has(group.id);

  const fold = (): number => {
    for (const node of nodes) node.foldedInto = null;
    for (const group of candidates) {
      if (group.expanded) continue;
      for (const id of group.memberIds) {
        const member = nodeById.get(id)!;
        if (member.foldedInto === null) member.foldedInto = group.id;
      }
    }
    // What is reached only through a folded node is folded with it.
    for (const node of [...nodes].sort((a, b) => a.step - b.step)) {
      if (node.foldedInto !== null || node.id === focus) continue;
      const above = nodeById.get(parent.get(node.id)!.id)!;
      if (above.foldedInto !== null) node.foldedInto = above.foldedInto;
    }
    return nodes.filter((node) => node.foldedInto === null).length;
  };
  let drawn = fold();
  if (drawn > MAX_EXPLORER_NODES) {
    const open = candidates.filter((group) => group.expanded).sort((a, b) => b.memberIds.length - a.memberIds.length || cmp(a.id, b.id));
    if (open.length > 0) {
      open[0].expanded = false;
      drawn = fold();
    }
    if (drawn > MAX_EXPLORER_NODES) throw new UiRejected("graph-too-large");
  }

  return { focus, steps, layers, nodes, edges, ...gapEndsOf(keptSet), groups: candidates };
}
