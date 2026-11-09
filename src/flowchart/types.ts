export type FlowchartBasis = "claimed" | "reported" | "decoded" | "simulated" | "observed" | "derived" | "unknown";
export type FlowchartVerification = "verified" | "unverified" | "conflicting" | "unresolved";
export type FlowchartSource = "evidence-graph" | "execution-plan" | "protocol-view";
export type FlowchartSequence = "plan-order" | "explanation" | "decoded-transaction" | "observed-execution" | "simulation" | "constructed-example";
export interface FlowchartNode { id: string; kind: string; label: string }
export interface FlowchartEdge { id: string; from: string; to: string; relation: string; basis: FlowchartBasis | null; verification: FlowchartVerification | null; evidenceIds: string[]; sourceId: string | null }
export interface FlowchartStep { id: string; title: string; nodeIds: string[]; edgeIds: string[] }
export interface FlowchartModel { schema: "linchpin.flowchart/1"; source: FlowchartSource; title: string; nodes: FlowchartNode[]; edges: FlowchartEdge[]; sequence: FlowchartSequence | null; steps: FlowchartStep[]; notes: string[]; sha256: string }

export type FlowchartInput = { source: "evidence-graph"; graph: unknown };
export type FlowchartProblemCode = "document" | "active-content" | "model-missing" | "model-schema" | "model-hash" | "model-dangling" | "render-mismatch" | "source-invalid" | "source-mismatch";
export interface FlowchartProblem { code: FlowchartProblemCode; detail: string }

export interface FlowchartSelection { type: "node" | "edge"; id: string }
export interface FlowchartViewState { selected: FlowchartSelection | null; step: number | null }
export type FlowchartViewAction = { type: "select"; target: FlowchartSelection } | { type: "clear" } | { type: "step"; delta: 1 | -1 };
export type FlowchartMark = "normal" | "selected" | "related" | "dimmed";
export interface FlowchartPresentation { nodes: Record<string, FlowchartMark>; edges: Record<string, FlowchartMark>; stepId: string | null; inspector: { heading: string; rows: [string, string][] } | null }
export interface FlowchartViewerCore {
  reduce(model: FlowchartModel, state: FlowchartViewState, action: FlowchartViewAction): FlowchartViewState;
  present(model: FlowchartModel, state: FlowchartViewState): FlowchartPresentation;
}

export class FlowchartError extends Error {
  problems: FlowchartProblem[];

  constructor(problems: FlowchartProblem[]) {
    super(problems.map((problem) => `${problem.code}: ${problem.detail}`).join("; "));
    this.name = "FlowchartError";
    this.problems = problems;
    Object.setPrototypeOf(this, FlowchartError.prototype);
  }
}

export interface FlowchartPlaybackState { index: number | null; status: "stopped" | "playing" | "completed" }
export type FlowchartPlaybackAction = { type: "play" | "stop" | "replay" | "tick" | "previous" | "next" | "clear" };
export interface FlowchartPlaybackCore {
  reducePlayback(model: FlowchartModel, state: FlowchartPlaybackState, action: FlowchartPlaybackAction): FlowchartPlaybackState;
  presentPlayback(model: FlowchartModel, state: FlowchartPlaybackState, selection: FlowchartSelection | null): FlowchartPresentation;
}
