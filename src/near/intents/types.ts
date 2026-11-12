import type { EvidenceReceipt, Fact, ObservationBound, QueryReason, QueryRequest, QueryResult, FactChange } from "../../engine/contracts";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import type { HistoryKind, NearReadIndex } from "../reader";

export type RouteFamily = "poa_bridge" | "hot_bridge" | "omni_bridge" | "near_withdrawal" | "undocumented";
export const ROUTE_FAMILIES: readonly RouteFamily[] = ["poa_bridge", "hot_bridge", "omni_bridge", "near_withdrawal", "undocumented"];

export interface RouteRule {
  id: "nep141-omft" | "nep141-omdep" | "nep141-near" | "nep245-hot" | "nep245-other" | "1cs-v1";
  standard: "nep141" | "nep245" | "1cs_v1";
  match: { accountSuffix?: string; contract?: string } | { any: true };
  family: RouteFamily | null;
  reason: "missing-coverage" | "undetermined" | null;
}
export interface RouteRuleSet {
  version: 1; sdkPackage: "@defuse-protocol/intents-sdk"; sdkVersion: string; sdkCommit: string | null;
  sourceFile: string; readAt: string;
  sourceSha256?: string; sourceHost?: string; tarball?: string;
  migrations?: { token: string; chain: string }[];
  rules: RouteRule[];
}
export type ParsedAssetId =
  | { standard: "nep141"; contract: string }
  | { standard: "nep245"; contract: string; tokenId: string }
  | { standard: "1cs_v1"; chain: string; tokenStandard: string; address: string };
export interface AssetClassification {
  assetId: string;
  parsed: ParsedAssetId | null;
  family: RouteFamily | null;
  rule: RouteRule["id"] | null;
  sdkVersion: string;
  ruleSetSha256: string;
  nearContract: string | null;
  reason: QueryReason | null;
  migrated_from?: "poa";
  routeEvidence?: OmftRouteEvidence;
  sdkMigration?: { listed: boolean; sourceFile: string; sha256: string; conflict: boolean };
}

export interface RouteObservation<T> {
  value: T; receipt: EvidenceReceipt;
  basis: "observed" | "decoded"; status: "verified";
}
export interface OmftRouteEvidence {
  token: string;
  codeHash: RouteObservation<string> | null;
  sourceMetadata: RouteObservation<unknown> | null;
  owner: RouteObservation<string> | null;
  controller: RouteObservation<string> | null;
  withdrawRelayer: RouteObservation<string> | null;
  mapping: RouteObservation<string | null> | null;
  reverseMapping: RouteObservation<string | null> | null;
  reasons: QueryReason[];
  receipts: EvidenceReceipt[];
}

export interface DryQuoteRequest {
  dry: true; swapType: "EXACT_INPUT"; slippageTolerance: 100;
  originAsset: string; destinationAsset: string; amount: string;
  depositType: "ORIGIN_CHAIN"; refundTo: string; refundType: "ORIGIN_CHAIN";
  recipient: string; recipientType: "DESTINATION_CHAIN";
}
export interface QuoteRecord {
  version: 1; requestSha256: string; request: DryQuoteRequest;
  endpointHost: "1click.chaindefuser.com"; authenticated: boolean;
  retrievedAt: string; httpStatus: number; responseSha256: string; response: unknown;
}
/** Retained failed attempt, never a successful quote or a source of quote figures. */
export interface QuoteAttempt {
  version: 1; endpointHost: "1click.chaindefuser.com"; recordedDate: string;
  request: DryQuoteRequest; requestSha256: string; httpStatus: 400;
  responseSha256: string; cause: "deadline-required";
  responseRetention: "hash-and-diagnostic-only"; disposition: "not-sent-by-decision";
}
export interface QuoteNotRecorded {
  status: "not recorded"; reason: string; attempt: QuoteAttempt | null;
}
export type DryQuoteResult =
  | { ok: true; record: QuoteRecord; receipt: EvidenceReceipt; facts: Fact[];
      correlationId: string; timestamp: string; signature: string; reasons: QueryReason[] }
  | { ok: false; record: null; receipt: null; facts: []; reasons: QueryReason[];
      failure?: { httpStatus: number; responseSha256: string; cause: "deadline-required" | "placeholder-rejected" | "http-error" };
      error: "deposit-address-present" | "deadline-present" | "missing-fixture" | "http-error" | "invalid-response" | "already-recorded" };
export interface DryQuoteOptions {
  mode: "record" | "offline"; root?: string /* default "fixtures/near/oneclick" */;
  fetch?: typeof fetch; now?: () => Date; apiKey?: string | null /* default process.env.LINCHPIN_ONECLICK_API_KEY ?? null */;
  tokens?: TokenListEntry[];
}
export interface TokenListEntry { assetId: string; decimals: number; blockchain: string; symbol: string; contractAddress?: string }

export type HopRole = "asset" | "verifier" | "controller" | "dao" | "factory" | "relay"
  | "bridge" | "bridge-dao" | "bridge-ops" | "mpc" | "depositer" | "hot" | "origin-artefact" | "offchain";
export interface IntentHop {
  index: number; role: HopRole; family: RouteFamily | "common";
  subject: string | null; label: string;
  via: { kind: "fact"; factId: string } | { kind: "recipe"; recipe: string };
  factIds: string[]; receiptIds: string[]; reasons: QueryReason[];
}
export type ControlPower = "upgrade" | "pause" | "freeze" | "grant-roles" | "sign-withdrawals" | "execution-delay";
export interface ControlRow {
  subject: string; power: ControlPower; holders: string[]; count: number | null;
  detail: string; kind: "fact" | "interpretation";
  factIds: string[]; receiptIds: string[]; reasons: QueryReason[];
}
export interface IntentLeg { side: "origin" | "destination" | "asset"; classification: AssetClassification; token: TokenListEntry | null }
export interface OffchainController {
  id: "solver-class" | "message-bus" | "shield" | "operator-terms" | "incident-2026-09-29";
  subject: string; title: string; url: string; sha256: string; retrievedAt: string;
  summary: string;
  factId: string; receiptId: string;
}
export interface ChangeSection {
  pair: { before: string; after: string; constructed: boolean } | null;
  subjects: string[];
  changes: (FactChange & { subject: string })[];
  history: { subject: string; events: { at: string; kind: HistoryKind; factId: string; sourceFactId: string; receiptIds: string[] }[] }[];
  versions: { version: string; at: string; factId: string; receiptIds: string[] }[];
  mpc: { participants: number; threshold: string | null; factIds: string[]; receiptIds: string[] };
}
export interface OriginSection {
  text: string;
  has: { label: string; factIds: string[]; receiptIds: string[] }[];
  lacks: QueryReason[];
}
export interface IntentReview {
  version: 1; reviewer: "near-intent-review/1";
  input: { kind: "quote"; originAsset: string; destinationAsset: string; amount: string; requestSha256: string }
       | { kind: "asset"; assetId: string };
  legs: IntentLeg[]; families: RouteFamily[];
  quote: { requestSha256: string; correlationId: string; timestamp: string; signature: string; signatureVerified: false;
           factIds: string[]; receiptId: string } | null;
  quoteNotRecorded: QuoteNotRecorded | null;
  chain: IntentHop[]; control: ControlRow[]; changes: ChangeSection;
  origin: OriginSection; offchain: OffchainController[];
  unknowns: QueryReason[];
  outcome: "complete" | "partial" | "unknown";
  asOf: string; snapshotIds: string[]; observations: ObservationBound[];
  queries: { request: QueryRequest; outcome: QueryResult["outcome"]; resultSha256: string }[];
  facts: Fact[]; receipts: EvidenceReceipt[];
}
export type IntentInput =
  | { kind: "quote"; quote: Extract<DryQuoteResult, { ok: true }> }
  | { kind: "asset"; assetId: string };
export interface IntentContext {
  store: EvidenceStore;
  baseSnapshotId: string;
  snapshotId: string;
  asOf: string;
  change: { before: string; after: string; constructed: boolean } | null;
  reads: NearReadIndex;
  rules: RouteRuleSet; tokens: TokenListEntry[];
  offchain: OffchainController[];
  routeEvidence?: Record<string, OmftRouteEvidence>;
  quoteNotRecorded?: QuoteNotRecorded;
}
