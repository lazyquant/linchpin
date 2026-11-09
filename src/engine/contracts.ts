/** DRAFT public interfaces for specs; no executor, reader or model is implemented here. */
export type Basis = "claimed" | "reported" | "decoded" | "simulated" | "observed" | "derived" | "unknown";
export type EvidenceStatus = "verified" | "unverified" | "conflicting" | "missing";
export type Privacy = "public" | "private";
export interface Observation {
  chain: string;
  network: string;
  blockOrSlot: string | null;
  blockHash: string | null;
  observedAt: string;
  retrievedAt: string;
  historicalState: "pinned" | "current-only" | "constructed" | "unknown";
}
export interface EvidenceReceipt {
  id: string;
  source: string; // redacted source identifier, never credential-bearing URLs
  responseSha256: string;
  observation: Observation;
  privacy: Privacy;
}
export interface Fact {
  id: string;
  subject: string; // chain/network-qualified exact identity, not a display name
  predicate: string;
  object: string;
  basis: Basis;
  status: EvidenceStatus;
  evidenceIds: string[];
  path: string[]; // ordered edge identifiers; empty only for a direct fact
  validFrom: string | null;
  validTo: string | null;
  privacy: Privacy;
}
export type QueryName = "dependencies" | "control" | "changes" | "evidence";
export interface QueryScope { asOf: string; snapshotId: string; maxHops: number; maxResults: number }
export type QueryRequest =
  | { name: "dependencies"; subject: string; relations: string[]; scope: QueryScope }
  | { name: "control"; subject: string; scope: QueryScope }
  | { name: "changes"; subject: string; beforeSnapshotId: string; afterSnapshotId: string; maxResults: number }
  | { name: "evidence"; evidenceIds: string[]; maxResults: number };
export type ReasonCode = "missing-subject" | "missing-history" | "missing-coverage" | "missing-evidence" | "stale" | "expired"
  | "partial-reader" | "conflict" | "unknown-controller" | "truncated" | "incompatible-snapshots" | "no-facts";
export interface QueryReason { code: ReasonCode; subject: string | null; ref: string | null }
export interface ObservationBound {
  snapshotId: string; chain: string; network: string; constructed: boolean;
  observedFrom: string; observedTo: string; fromBlockOrSlot: string | null; toBlockOrSlot: string | null;
  freshUntil: string; asOf: string | null;
}
export interface FactChange { kind: "added" | "removed" | "changed"; key: string; before: Fact | null; after: Fact | null }
export interface QueryResult {
  outcome: "complete" | "partial" | "unknown";
  facts: Fact[];
  receipts: EvidenceReceipt[];
  unknowns: string[];
  conflicts: string[];
  truncated: boolean;
  snapshotIds: string[];
  reasons: QueryReason[];
  observations: ObservationBound[];
  changes: FactChange[];
}
export type HandlerName = QueryName | "render-review";
export interface ToolContract {
  name: HandlerName;
  version: string;
  readOnly: true;
  inputSchema: unknown; // reviewed runtime schema required by context-engine AC2
  outputSchema: unknown;
  maxCalls: number;
  timeoutMs: number;
  reliability: { kind: "unmeasured" } | { kind: "measured"; evaluationId: string; passed: number; total: number };
}
export type InputValue = { literal: unknown } | { ref: string };
export interface EngineNode {
  id: string;
  agent: QueryName | "render-review";
  domain: "protocol-review";
  input: Record<string, InputValue>;
  dependsOn: string[];
}
export interface EnginePlan { version: 1; nodes: EngineNode[]; outputNodeId: string }
/** maxTokens counts model output tokens; slice 2 requires 0. */
export interface RunLimits { maxNodes: number; maxDepth: number; maxToolCalls: number; maxTokens: number; timeoutMs: number }
export interface ReviewClaim {
  text: string; factIds: string[]; evidenceIds: string[];
  kind: "fact" | "interpretation" | "unknown";
  template: "fact" | "change" | "unchanged" | "unknown";
  source: { nodeId: string; field: "facts" | "changes" | "reasons" | "result"; index: number | null };
}
export interface Review {
  claims: ReviewClaim[];
  unknowns: string[];
  snapshotIds: string[];
  observations: ObservationBound[];
  policy: "meets-configured-checks" | "violates-policy" | "insufficient-evidence" | "not-evaluated";
  privacy: Privacy;
}
export interface ModelRequest { blueprintId: string; publicFacts: Fact[]; unknowns: string[]; maxOutputTokens: number }
export interface ModelResponse { claims: ReviewClaim[]; inputTokens: number; outputTokens: number; modelId: string }
export interface ModelAdapter { generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> }
export interface EngineTraceEvent {
  runId: string;
  sequence: number;
  nodeId: string;
  phase: "prepared" | "succeeded" | "failed" | "cancelled" | "run-succeeded" | "run-failed";
  inputSha256: string;
  outputSha256?: string;
  registrySha256: string;
  blueprintSha256: string;
  modelId: string | null;
  actualTokens: number | null;
  acceptedEvidenceIds: string[];
  rejectedSourceIds: string[];
  reason?: string;
}
export interface PrivatePosition {
  id: string;
  subject: string;
  quantity: string; // exact decimal, not floating point
  unit: string;
  snapshotId: string;
  source: "manual" | "reader";
  fixtureKind: "real-private" | "synthetic";
}

export type PlanRejectCode = "schema" | "duplicate-id" | "unknown-agent" | "bad-domain" | "output-node"
  | "query-input-invalid" | "ref-in-query" | "dangling-ref" | "literal-in-render" | "dependency-mismatch"
  | "unreachable" | "limit-invalid" | "limit-exceeded" | "blueprint-unknown" | "blueprint-mismatch";
export type RunFailCode = "aborted" | "handler-timeout" | "run-timeout" | "handler-rejected"
  | "output-invalid" | "budget-exhausted" | "trace-failed";
export interface RunAccounting { planned: RunLimits | null; queryCalls: number; renderCalls: number; modelTokens: number | null }
export interface RenderReviewEntry { nodeId: string; request: QueryRequest; result: QueryResult; resultSha256: string }
export type RenderReviewInput = Record<string, RenderReviewEntry>;
export interface ReviewEnvelope {
  runId: string; blueprintId: string; blueprintSha256: string; registrySha256: string; planSha256: string;
  results: (RenderReviewEntry & { key: string })[];
  review: Review;
}
export type EngineRunOutcome =
  | { status: "succeeded"; runId: string; envelope: ReviewEnvelope; lastSequence: number; accounting: RunAccounting }
  | { status: "rejected"; runId: string; code: PlanRejectCode; nodeId: string | null; dispatched: 0; accounting: RunAccounting }
  | { status: "failed"; runId: string; code: RunFailCode; nodeId: string | null; lastDurableSequence: number; skipped: string[]; accounting: RunAccounting };
export interface TraceSink { append(event: EngineTraceEvent): Promise<void> }
export interface ReplayCaptureEntry { nodeId: string; inputSha256: string; resultSha256: string; result: QueryResult }
export interface ReplayCapture {
  version: 1; planSha256: string; registrySha256: string; blueprintSha256: string;
  rendererVersion: string; handlerVersions: Record<HandlerName, string>; entries: ReplayCaptureEntry[];
}
export interface CertificateCheck { name: string; required: boolean; passed: boolean; detail: string }
export interface Certificate { checks: CertificateCheck[]; passed: boolean }
export interface ModelProjection { request: ModelRequest; dropped: { facts: number; unknowns: number } }
