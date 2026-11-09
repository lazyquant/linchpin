import { FlowchartError } from "./types";
import type { FlowchartBasis, FlowchartEdge, FlowchartInput, FlowchartModel, FlowchartNode, FlowchartProblem } from "./types";

const BASIS_VALUES: ReadonlySet<string> = new Set(["claimed", "reported", "decoded", "simulated", "observed", "derived", "unknown"]);

export function hashFlowchartModel(model: Omit<FlowchartModel, "sha256">): string {
  const canon = {
    schema: model.schema,
    source: model.source,
    title: model.title,
    nodes: model.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
    edges: model.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, relation: e.relation, basis: e.basis, verification: e.verification, evidenceIds: e.evidenceIds, sourceId: e.sourceId })),
    sequence: model.sequence,
    steps: model.steps.map((s) => ({ id: s.id, title: s.title, nodeIds: s.nodeIds, edgeIds: s.edgeIds })),
    notes: model.notes,
  };
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canon)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function toFlowchartModel(input: FlowchartInput, title: string): FlowchartModel {
  const source = isRecord(input) ? input.source : undefined;
  if (!isRecord(input) || source !== "evidence-graph") {
    throw new FlowchartError([{ code: "source-invalid", detail: `input: unsupported source ${describeValue(source)}` }]);
  }
  if (typeof title !== "string") {
    throw new FlowchartError([{ code: "source-invalid", detail: "title: not a string" }]);
  }
  const graph = (input as Record<string, unknown>).graph;
  if (!isRecord(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new FlowchartError([{ code: "source-invalid", detail: "graph: not an object with nodes and edges arrays" }]);
  }

  const problems: FlowchartProblem[] = [];
  const add = (detail: string): void => {
    if (problems.length < 200) problems.push({ code: "source-invalid", detail });
  };

  const nodeIds = new Set<string>();
  const nodes: FlowchartNode[] = [];
  const rawNodes = graph.nodes as unknown[];
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i];
    if (!isRecord(raw)) {
      add(`nodes[${i}]: id is missing or not a string`);
      continue;
    }
    const id = raw.id;
    if (typeof id !== "string") {
      add(`nodes[${i}]: id is missing or not a string`);
      continue;
    }
    if (typeof raw.type !== "string") add(`node ${id}: type is missing or not a string`);
    if (typeof raw.label !== "string") add(`node ${id}: label is missing or not a string`);
    if (nodeIds.has(id)) add(`node ${id}: duplicate id`);
    else nodeIds.add(id);
    if (typeof raw.type === "string" && typeof raw.label === "string") {
      nodes.push({ id, kind: raw.type, label: raw.label });
    }
  }

  const drafts: Array<{ from: string; to: string; relation: string; basis: FlowchartBasis; evidenceIds: string[] }> = [];
  const rawEdges = graph.edges as unknown[];
  for (let i = 0; i < rawEdges.length; i++) {
    const raw = rawEdges[i];
    if (!isRecord(raw)) {
      add(`edges[${i}]: not an object`);
      continue;
    }
    const from = raw.from;
    const to = raw.to;
    const label = `edges[${i}] (${typeof from === "string" ? from : "?"} -> ${typeof to === "string" ? to : "?"})`;
    const basisOk = typeof raw.basis === "string" && BASIS_VALUES.has(raw.basis);
    const evidenceOk = Array.isArray(raw.evidenceIds) && raw.evidenceIds.every((value) => typeof value === "string");
    if (typeof from !== "string") add(`${label}: from is missing or not a string`);
    if (typeof to !== "string") add(`${label}: to is missing or not a string`);
    if (typeof raw.type !== "string") add(`${label}: type is missing or not a string`);
    if (!basisOk) add(`${label}: basis is missing or not one of the seven basis words`);
    if (!evidenceOk) add(`${label}: evidenceIds is missing or not an array of strings`);
    if (typeof from === "string" && !nodeIds.has(from)) add(`edges[${i}]: from "${from}" is not a node id`);
    if (typeof to === "string" && !nodeIds.has(to)) add(`edges[${i}]: to "${to}" is not a node id`);
    if (typeof from === "string" && typeof to === "string" && typeof raw.type === "string" && basisOk && evidenceOk) {
      drafts.push({ from, to, relation: raw.type, basis: raw.basis as FlowchartBasis, evidenceIds: (raw.evidenceIds as string[]).slice() });
    }
  }

  if (problems.length > 0) throw new FlowchartError(problems);

  nodes.sort((a, b) => cmp(a.id, b.id));
  drafts.sort((a, b) => {
    const tuples: Array<[string, string]> = [
      [a.from, b.from],
      [a.relation, b.relation],
      [a.to, b.to],
      [a.basis, b.basis],
      ["", ""],
      [a.evidenceIds.join(","), b.evidenceIds.join(",")],
    ];
    for (const [left, right] of tuples) {
      const order = cmp(left, right);
      if (order !== 0) return order;
    }
    return 0;
  });

  const edges: FlowchartEdge[] = drafts.map((draft, index) => ({
    id: `e${index + 1}`,
    from: draft.from,
    to: draft.to,
    relation: draft.relation,
    basis: draft.basis,
    verification: null,
    evidenceIds: draft.evidenceIds,
    sourceId: null,
  }));

  const base = {
    schema: "linchpin.flowchart/1" as const,
    source: "evidence-graph" as const,
    title,
    nodes,
    edges,
    sequence: null,
    steps: [],
    notes: [],
  };
  return { ...base, sha256: hashFlowchartModel(base) };
}
