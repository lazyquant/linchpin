import type { EvidenceReceipt, Fact, QueryReason } from "../../engine/contracts";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import type { Policy } from "../../policy/types";
import type { A2uiMessage, AnyResult, SurfaceMeta } from "../../ui/types";
import type { NearLibraries } from "../policy/libraries";
import type { PreflightAction } from "../preflight/action";
import type { ToolContext, TOOLS, callTool } from "../mcp/tools";

export type AskInput = { kind: "control"; subject: string }
  | { kind: "preflight"; action: PreflightAction; policyId: string }
  | { kind: "policy"; policyId: string };
export interface NearAgentContext {
  store: EvidenceStore; snapshotId: string; snapshotIds: readonly string[]; libs: NearLibraries;
  policies: ReadonlyMap<string, Policy>; subjects: ReadonlySet<string>; assets: ReadonlySet<string>;
  policiesDir?: URL; dispatch: typeof callTool;
}
export interface ToolCall { id: string; name: string; input: unknown }
export type ModelMessage = { role: "user"; content: string }
  | { role: "assistant"; calls?: ToolCall[]; content?: string; reasoning?: string }
  | { role: "tool"; id: string; name: string; output: unknown };
export interface PlannerRequest { system: string; tools: typeof TOOLS; messages: ModelMessage[] }
export interface TokenUsage { inputTokens: number | null; outputTokens: number | null }
export interface WireCompletion { requestBytes: Uint8Array; responseBytes: Uint8Array; completionId: string; receivedAt: number }
export interface PlannerReply {
  turn: { kind: "tools"; calls: ToolCall[] } | { kind: "answer"; answer: unknown };
  usage: TokenUsage; reasoning?: string; wire?: WireCompletion;
}
export interface PlannerModel {
  readonly id: string; readonly mode?: "live" | "scripted";
  readonly transport?: typeof fetch;
  configured?(): boolean;
  next(request: PlannerRequest, signal: AbortSignal): Promise<PlannerReply>;
}
export interface AttestationCandidate { signing_address: string; signing_algo: string; request_nonce: string; model_name?: string }
export interface AttestationMeta {
  status: "not-checked" | "unavailable"; code: string | null; source: string | null;
  observedAt: string | null; reportSha256: string | null; nonce: string | null;
  gatewayNonceMatches: boolean | null; modelReportCount: number;
}
export interface AttestationCapture {
  meta: AttestationMeta; fetchedAt: number; model: string;
  gateway: AttestationCandidate | null; candidates: AttestationCandidate[]; rawBytes?: Uint8Array;
}
export type BindingStatus = "valid-under-unverified-key" | "invalid" | "unavailable";
export interface BindingCheck {
  status: BindingStatus; code: string | null; completionId: string | null;
  signatureKind: string | null; requestSha256: string | null; responseSha256: string | null;
  signatureSha256?: string; source?: string; observedAt?: string;
}
export interface ResponseBinding { status: BindingStatus; turns: BindingCheck[] }
export interface AskResponse {
  kind: "answer" | "repaired" | "refusal" | "no-model" | "prepared" | "aborted";
  authoritative: Record<string, unknown> | null; messages: A2uiMessage[];
  model: { id: string | null; mode: "live" | "scripted" | "none"; modelCalls: number; toolCalls: number; label: string | null };
  attestation: AttestationMeta; responseBinding: ResponseBinding; codes: string[]; usage: TokenUsage;
}
export interface AskOptions {
  context: NearAgentContext; model?: PlannerModel | null; signal?: AbortSignal; clock?: () => number;
  fetch?: typeof fetch; nonce?: () => string;
  onWire?(wire: WireCompletion, capture: AttestationCapture, binding: BindingCheck): void;
}
export interface SessionResult {
  id: string; name: string; value: Record<string, unknown>; isError: boolean;
  facts: Fact[]; receipts: EvidenceReceipt[]; reasons: QueryReason[];
  forwarded: unknown; truncated: boolean;
}
export interface SurfaceInput {
  input: AskInput; meta: SurfaceMeta; authoritative: Record<string, unknown> | null;
  sessions: readonly SessionResult[]; results: AnyResult[]; receipts: EvidenceReceipt[];
  attestation: AttestationMeta; binding: ResponseBinding;
}
export type ToolDispatcher = (name: string, input: unknown, context: ToolContext) => ReturnType<typeof callTool>;
