// Hand-built models for the presentation tests: zero, one and three playback items, with model
// steps and with the node-order fallback. Built with the legacy fixture builder (sorted nodes,
// edge ids e1..eN, product hash) so every model satisfies the original Model rules.
import type { FlowchartModel, FlowchartSequence } from "../../../src/flowchart/index";
import { buildModel } from "../html-flowchart/models";

export function emptyModel(): FlowchartModel {
  return buildModel({ title: "Empty presentation", nodes: [], edges: [] });
}

export function oneNode(): FlowchartModel {
  return buildModel({ title: "One node", nodes: [{ id: "solo", kind: "Thing", label: "Solo node" }], edges: [] });
}

/** Three nodes, no steps: playback walks n1, n2, n3 in model (id) order. Includes a self-loop. */
export function threeNodes(): FlowchartModel {
  return buildModel({
    title: "Three nodes",
    nodes: [
      { id: "n3", kind: "K", label: "Third node" },
      { id: "n1", kind: "K", label: "First node" },
      { id: "n2", kind: "K", label: "Second node" },
    ],
    edges: [
      { key: "a", from: "n1", to: "n2", relation: "FEEDS", basis: "claimed", evidenceIds: ["ev-1"] },
      { key: "b", from: "n2", to: "n2", relation: "LOOPS", basis: "unknown", verification: "unresolved" },
    ],
  });
}

/** One step over two nodes. */
export function oneStep(sequence: FlowchartSequence = "explanation"): FlowchartModel {
  return buildModel({
    title: "One step",
    nodes: [
      { id: "p", kind: "K", label: "Node P" },
      { id: "q", kind: "K", label: "Node Q" },
    ],
    edges: [{ key: "pq", from: "p", to: "q", relation: "PQ", basis: "decoded", evidenceIds: ["x"] }],
    sequence,
    steps: [{ id: "only", title: "The only step", nodeIds: ["p", "q"], edgeKeys: ["pq"] }],
  });
}

/**
 * Five nodes and three steps: N must be 3 (steps), never 5 (nodes). Isolated node z, self-loop d.
 */
export function threeSteps(sequence: FlowchartSequence = "plan-order"): FlowchartModel {
  return buildModel({
    title: "Three steps",
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
    sequence,
    steps: [
      { id: "s1", title: "First step", nodeIds: ["a"], edgeKeys: [] },
      { id: "s2", title: "Second step", nodeIds: ["a", "b"], edgeKeys: ["ab"] },
      { id: "s3", title: "Third step", nodeIds: ["b", "c"], edgeKeys: ["bc"] },
    ],
  });
}

/** Labels long enough that a shrink-to-fit or truncating layout is detectable. */
export function longLabels(): FlowchartModel {
  const long = "Governance proposal execution authority with a deliberately very long human readable label";
  return buildModel({
    title: "Long labels",
    nodes: [
      { id: "l1", kind: "K", label: long },
      { id: "l2", kind: "K", label: `${long} number two` },
      { id: "l3", kind: "K", label: "Short" },
      { id: "l4", kind: "K", label: "W".repeat(70) },
    ],
    edges: [
      { key: "a", from: "l1", to: "l2", relation: "A_RATHER_LONG_RELATION_NAME_FOR_WIDTH", basis: "reported" },
      { key: "b", from: "l2", to: "l1", relation: "BACK", basis: "derived" },
      { key: "c", from: "l1", to: "l2", relation: "PARALLEL", basis: "simulated" },
      { key: "d", from: "l4", to: "l4", relation: "SELF_LOOP_WITH_LONG_NAME", basis: null },
      { key: "e", from: "l3", to: "l1", relation: "X", basis: "observed" },
    ],
  });
}

/**
 * Model hashes and counts of the three recorded cases, saved by the coordinator before the build
 * (plan R12) as the recorded baseline, copied here because that record is private and is not
 * published.
 */
export const RECORDED_BASELINE = [
  { case: "mip-14", sha256: "7e879ab69c2ea31ca55414b3dd005753dd46e019167992b1da14eac140a245ac", nodes: 19, edges: 23 },
  { case: "mip-14-opinion", sha256: "736376202fd48a3ad84600c5e1413275cd916d55860daf8c2a252a367ad28c95", nodes: 6, edges: 4 },
  { case: "bonk-bip76", sha256: "d2cb216b44d7f711d953c1a88692e1a700d24cf89667012d6fc1a3cd27fb8529", nodes: 42, edges: 43 },
] as const;
