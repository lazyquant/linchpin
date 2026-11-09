// Hand-built models for the html-flowchart tests, written from the html-flowchart spec.
// Ordering, edge ids and hashes follow the spec's Model rules; the hash comes from the
// product's hashFlowchartModel (AC4 wording), and the test file separately checks that it equals
// an independent SHA-256 of JSON.stringify in interface key order.
import { createHash } from "node:crypto";
import {
  hashFlowchartModel,
  type FlowchartBasis,
  type FlowchartEdge,
  type FlowchartModel,
  type FlowchartNode,
  type FlowchartSequence,
  type FlowchartSource,
  type FlowchartStep,
  type FlowchartVerification,
} from "../../../src/flowchart/index";

/** Contains every character class AC3 names, plus markup that would create elements and attributes. */
export const EVIL = `x<y>&amp;"q"'s'</script><!-- c -->\né€ <img src=x onerror="alert(1)"> </style>`;

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function edgeKey(e: Omit<FlowchartEdge, "id">): string[] {
  return [e.from, e.relation, e.to, e.basis ?? "", e.sourceId ?? "", e.evidenceIds.join(",")];
}

export function cmpEdge(a: Omit<FlowchartEdge, "id">, b: Omit<FlowchartEdge, "id">): number {
  const ka = edgeKey(a);
  const kb = edgeKey(b);
  for (let i = 0; i < ka.length; i++) {
    const c = cmpStr(ka[i]!, kb[i]!);
    if (c) return c;
  }
  return 0;
}

/** Independent canonical serialization: keys in the order of the spec's interfaces. */
export function canonicalJson(m: Omit<FlowchartModel, "sha256">): string {
  return JSON.stringify({
    schema: m.schema,
    source: m.source,
    title: m.title,
    nodes: m.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
    edges: m.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      relation: e.relation,
      basis: e.basis,
      verification: e.verification,
      evidenceIds: e.evidenceIds,
      sourceId: e.sourceId,
    })),
    sequence: m.sequence,
    steps: m.steps.map((s) => ({ id: s.id, title: s.title, nodeIds: s.nodeIds, edgeIds: s.edgeIds })),
    notes: m.notes,
  });
}

export function independentHash(m: Omit<FlowchartModel, "sha256">): string {
  return createHash("sha256").update(Buffer.from(canonicalJson(m), "utf8")).digest("hex");
}

export function withoutHash(m: FlowchartModel): Omit<FlowchartModel, "sha256"> {
  const { sha256: _ignored, ...rest } = m;
  return rest;
}

export function rehash(m: FlowchartModel): FlowchartModel {
  m.sha256 = hashFlowchartModel(withoutHash(m));
  return m;
}

export interface EdgeSpec {
  key?: string;
  from: string;
  to: string;
  relation: string;
  basis: FlowchartBasis | null;
  verification?: FlowchartVerification | null;
  evidenceIds?: string[];
  sourceId?: string | null;
}

export interface StepSpec {
  id: string;
  title: string;
  nodeIds: string[];
  edgeKeys: string[];
}

export interface ModelSpec {
  title: string;
  source?: FlowchartSource;
  nodes: FlowchartNode[];
  edges: EdgeSpec[];
  sequence?: FlowchartSequence | null;
  steps?: StepSpec[];
  notes?: string[];
}

/** Builds a model that satisfies the Model rules: sorted nodes, sorted edges, ids e1..eN, hash. */
export function buildModel(spec: ModelSpec): FlowchartModel {
  const nodes = [...spec.nodes].map((n) => ({ id: n.id, kind: n.kind, label: n.label })).sort((a, b) => cmpStr(a.id, b.id));
  const withKeys = spec.edges.map((e) => ({
    key: e.key,
    edge: {
      from: e.from,
      to: e.to,
      relation: e.relation,
      basis: e.basis,
      verification: e.verification ?? null,
      evidenceIds: e.evidenceIds ?? [],
      sourceId: e.sourceId ?? null,
    },
  }));
  withKeys.sort((a, b) => cmpEdge(a.edge, b.edge));
  const idOf = new Map<string, string>();
  const edges: FlowchartEdge[] = withKeys.map((w, i) => {
    const id = `e${i + 1}`;
    if (w.key) idOf.set(w.key, id);
    return { id, ...w.edge };
  });
  const steps: FlowchartStep[] = (spec.steps ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    nodeIds: [...s.nodeIds],
    edgeIds: s.edgeKeys.map((k) => {
      const id = idOf.get(k);
      if (!id) throw new Error(`fixture: unknown edge key ${k}`);
      return id;
    }),
  }));
  const model: FlowchartModel = {
    schema: "linchpin.flowchart/1",
    source: spec.source ?? "evidence-graph",
    title: spec.title,
    nodes,
    edges,
    sequence: steps.length ? (spec.sequence ?? "plan-order") : null,
    steps,
    notes: [...(spec.notes ?? [])],
    sha256: "",
  };
  return rehash(model);
}

/** The AC3 model: one hostile string in every text position; `s` is the string. */
export function hostileModel(s: string): FlowchartModel {
  return buildModel({
    title: `${s} title`,
    nodes: [
      { id: `${s}1`, kind: `${s} kind`, label: `${s} label 1` },
      { id: `${s}2`, kind: "Plain", label: `${s} label 2` },
      { id: `${s}3`, kind: `${s} kind 3`, label: `${s} label 3` },
    ],
    edges: [
      { key: "a", from: `${s}1`, to: `${s}2`, relation: `${s} rel`, basis: "claimed", evidenceIds: [`${s} ev`, "ev-plain"], sourceId: `${s} src` },
      { key: "b", from: `${s}2`, to: `${s}3`, relation: "PLAIN", basis: null, verification: "unresolved", evidenceIds: [], sourceId: null },
      { key: "c", from: `${s}3`, to: `${s}3`, relation: `${s} loop`, basis: "unknown", verification: "verified", evidenceIds: [`${s}`], sourceId: `${s}` },
    ],
    sequence: "explanation",
    steps: [
      { id: `${s} step`, title: `${s} step title`, nodeIds: [`${s}1`, `${s}2`], edgeKeys: ["a"] },
      { id: "step-2", title: `${s} second`, nodeIds: [`${s}3`], edgeKeys: ["b", "c"] },
    ],
    notes: [`${s} note`, "plain note"],
  });
}

/** AC5: every basis and null, every verification and null, empty and two-id evidence, a source id. */
export function evidenceModel(): FlowchartModel {
  const nodes = ["n1", "n2", "n3", "n4"].map((id) => ({ id, kind: "Thing", label: `Label ${id}` }));
  const bases: (FlowchartBasis | null)[] = ["claimed", "reported", "decoded", "simulated", "observed", "derived", "unknown", null];
  const verifications: (FlowchartVerification | null)[] = ["verified", "unverified", "conflicting", "unresolved", null, null, null, null];
  const edges: EdgeSpec[] = bases.map((basis, i) => ({
    key: `k${i}`,
    from: "n1",
    to: `n${(i % 3) + 2}`,
    relation: `REL_${i}`,
    basis,
    verification: verifications[i]!,
    evidenceIds: i % 2 === 0 ? [] : [`ev-${i}a`, `ev-${i}b`],
    sourceId: i === 3 ? "source-3" : null,
  }));
  return buildModel({ title: "Evidence words", nodes, edges });
}

/** AC10: nodes a, b, c, d, z; edges e1 a->b, e2 b->c, e3 d->d; three steps. */
export function viewerModel(withSteps = true): FlowchartModel {
  return buildModel({
    title: "Viewer model",
    nodes: [
      { id: "a", kind: "KindA", label: "Label A" },
      { id: "b", kind: "KindB", label: "Label B" },
      { id: "c", kind: "KindC", label: "Label C" },
      { id: "d", kind: "KindD", label: "Label D" },
      { id: "z", kind: "KindZ", label: "Label Z" },
    ],
    edges: [
      { key: "ab", from: "a", to: "b", relation: "AB", basis: "observed", verification: "verified", evidenceIds: ["x1", "x2"], sourceId: "src-ab" },
      { key: "bc", from: "b", to: "c", relation: "BC", basis: null, evidenceIds: [] },
      { key: "dd", from: "d", to: "d", relation: "DD", basis: "simulated", evidenceIds: ["x3"] },
    ],
    sequence: "plan-order",
    steps: withSteps
      ? [
          { id: "s1", title: "First step", nodeIds: ["a"], edgeKeys: [] },
          { id: "s2", title: "Second step", nodeIds: ["a", "b"], edgeKeys: ["ab"] },
          { id: "s3", title: "Third step", nodeIds: ["b", "c"], edgeKeys: ["bc"] },
        ]
      : [],
  });
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
