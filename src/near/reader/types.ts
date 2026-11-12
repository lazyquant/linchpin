import type { EvidenceReceipt, QueryReason } from "../../engine/contracts";
import { canonical, sha256 } from "../../chain/evidence";
export const NEAR_NETWORK = "mainnet" as const;
/** Preserve integer lexemes beyond IEEE-754 precision in contract JSON. */
export function parseNearJson(text: string): unknown {
  return JSON.parse(text, ((_: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source && /^-?[0-9]+$/.test(context.source) ? context.source : value) as Parameters<typeof JSON.parse>[1]);
}
export function isNearAccountId(value: string): boolean {
  return typeof value === "string" && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value);
}
export function encodeSubjectKey(raw: string): string {
  return [...Buffer.from(raw, "utf8")].map(b => /[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `~${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}
export function decodeSubjectKey(key: string): string {
  if (!/^(?:[A-Za-z0-9._-]|~[0-9A-F]{2})+$/.test(key)) throw new Error("Invalid NEAR subject key");
  const bytes = key.match(/~[0-9A-F]{2}|./g)!.map(x => x.startsWith("~") ? parseInt(x.slice(1), 16) : x.charCodeAt(0));
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  if (encodeSubjectKey(raw) !== key) throw new Error("Noncanonical NEAR subject key");
  return raw;
}
export function nearSubject(account: string, kind?: string, key?: string): string {
  if (!isNearAccountId(account)) throw new Error("Invalid NEAR account");
  if (kind === undefined && key === undefined) return `near:mainnet:${account}`;
  if (!kind || !/^[a-z][a-z-]{0,31}$/.test(kind) || !key) throw new Error("Invalid NEAR subject kind or key");
  const encoded = encodeSubjectKey(key);
  if (encoded.length > 128) throw new Error("NEAR subject key too long");
  return `near:mainnet:${account}#${kind}:${encoded}`;
}
export function parseNearSubject(subject: string): { account: string; kind: string | null; key: string | null } | null {
  const m = /^near:mainnet:([^#]+)(?:#([a-z][a-z-]{0,31}):([A-Za-z0-9._~-]{1,128}))?$/.exec(subject);
  if (!m || !isNearAccountId(m[1])) return null;
  try { return { account: m[1], kind: m[2] ?? null, key: m[3] ? decodeSubjectKey(m[3]) : null }; } catch { return null; }
}
export type BlockRef = { finality: "final" } | { blockId: string };
export type FinalityOrBlock = { finality: "final" } | { block_id: number };
export type NearRequest =
  | { method: "query"; params: { request_type: "view_account" | "view_access_key_list" | "view_code"; account_id: string } & FinalityOrBlock }
  | { method: "query"; params: { request_type: "call_function"; account_id: string; method_name: string; args_base64: string } & FinalityOrBlock }
  | { method: "block"; params: FinalityOrBlock }
  | { method: "status"; params: [] };
export function requestSha256(request: NearRequest): string { return sha256(canonical(request)); }
export interface NearRecord {
  version: 1; requestSha256: string; request: NearRequest; endpointHost: string; retrievedAt: string; httpStatus: number;
  outcome: "result" | "call-error" | "rpc-error" | "not-attempted";
  blockHeight: string | null; blockHash: string | null; responseSha256: string; response: unknown;
  resultText?: string; codeSha256?: string;
  archival?: { requestedBlockId: string; attempted: false; reason: "archival-unconfigured" }
    | { requestedBlockId: string; attempted: true; host: string; errorName: string | null; errorBodySha256: string | null };
  fallbackRequestSha256?: string;
}
export type NearReadError = { kind: "missing-fixture" | "call-error" | "rpc-error" | "unknown-block" | "transport"; name: string | null; bodySha256: string | null };
export type NearRead<T> =
  | { ok: true; value: T; receipt: EvidenceReceipt; record: NearRecord; reasons: QueryReason[]; historyReceipt: EvidenceReceipt | null }
  | { ok: false; error: NearReadError; receipt: EvidenceReceipt | null; record: NearRecord | null; reasons: QueryReason[] };
export interface NearAccountView { amount: string; locked: string; code_hash: string; storage_usage: number; [key: string]: unknown }
export interface NearAccessKeyList { keys: { public_key: string; access_key: { nonce: number; permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } } } }[] }
export interface NearClientOptions {
  mode: "record" | "offline"; snapshotId: string; snapshotDir: string; endpointHost: string;
  endpointUrl?: string; archivalUrl?: string | null; fetch?: typeof fetch; now?: () => Date;
  minIntervalMs?: number; timeoutMs?: number; retries?: number;
}
export interface NearClient {
  viewAccount(account: string, at?: BlockRef): Promise<NearRead<NearAccountView>>;
  viewAccessKeys(account: string, at?: BlockRef): Promise<NearRead<NearAccessKeyList>>;
  viewCodeHash(account: string, at?: BlockRef): Promise<NearRead<{ codeSha256: string; rpcCodeHash: string }>>;
  callFunction(account: string, method: string, argsJson: unknown, at?: BlockRef): Promise<NearRead<unknown>>;
  block(at?: BlockRef): Promise<NearRead<{ height: string; hash: string; timestampNs: string; protocolVersion: number }>>;
  readonly records: readonly NearRecord[];
}
export interface SputnikVotePolicy { weight_kind: "RoleWeight" | "TokenWeight"; quorum: string; threshold: string | number | [number, number] }
export interface SputnikPolicy {
  roles: { name: string; kind: "Everyone" | { Group: string[] } | { Member: string }; permissions: string[]; vote_policy: Record<string, SputnikVotePolicy> }[];
  default_vote_policy: SputnikVotePolicy; proposal_period: string; proposal_bond: string;
}
export interface SputnikProposal { id: number; proposer: string; status: string; submission_time: string; kind: Record<string, unknown> | string; vote_counts: Record<string, unknown>; votes: Record<string, unknown> }
export type { SubjectEntry, Recipe, NearChain, RelationName } from "../subjects/registry";
export type { NearSnapshotManifest, LoadOptions, NearReadIndex } from "./load";
export type { MapperContext, NearMapper } from "./mappers";
export type { CaptureOptions } from "./capture";
