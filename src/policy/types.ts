import type { EvidenceReceipt, Fact, QueryReason } from "../engine/contracts";
import type { RuleRegistry } from "./registry";
export type Outcome = "within-policy" | "outside-policy" | "undetermined";
export interface RuleSpec { id: string; kind: string; params: Record<string, unknown> }
export interface Policy { policyId: string; subjects: string[]; rules: RuleSpec[] }
export interface RuleReason { code: string; subject: string | null; ref: string | null }
export type RuleEvidence = Record<string, string | number | boolean | null | string[]>;
export interface RuleEvaluation { outcome: Outcome; reasons: RuleReason[]; factIds: string[]; receiptIds: string[]; evidence: RuleEvidence }
export interface RuleResult extends RuleEvaluation { ruleId: string; kind: string }
export interface PolicyVerdict { policyId: string; outcome: Outcome; evaluatedAt: string; rules: RuleResult[] }
export type PublicRuleResult = Omit<RuleResult, "evidence">;
export interface PublicPolicyVerdict { policyId: string; outcome: Outcome; evaluatedAt: string; rules: PublicRuleResult[] }
export type PredicateRole = "control" | "oracle" | "dependency" | "idle" | "available-liquidity" | "utilization-input" | "price" | "state";
export type ExitRole = "idle" | "available-liquidity" | "withdrawal-constraint" | "utilization";
export interface ExitItem { role: ExitRole; subject: string; name: string; factIds: string[]; receiptIds: string[] }
export interface PositionChain { snapshotId: string; facts: Fact[]; reasons: QueryReason[]; exit: ExitItem[] }
export interface PolicyPosition { positionRef: string; subject: string; quantity: string; unit: string; inScope: boolean; chain: PositionChain | null }
export interface PriceEvidence { value: string; unitOfAccount: string; factIds: string[]; receiptIds: string[] }
export interface PolicyEvidence {
  snapshot(id: string): { id: string; subjects: string[]; constructed: boolean } | undefined;
  receipt(id: string): EvidenceReceipt | undefined;
  factsFrom(snapshotId: string, subject: string): Fact[];
}
export interface PolicyContext {
  evaluatedAt: string; snapshotId: string; registry: RuleRegistry;
  roleOf(predicate: string): PredicateRole | undefined;
  positions: readonly PolicyPosition[];
  price(unit: string): PriceEvidence | null;
}
export interface RuleKind<P = unknown> {
  readonly kind: string;
  parse(params: unknown): P;
  evaluate(params: P, store: PolicyEvidence, context: PolicyContext): RuleEvaluation;
}
export const CORE_REASON_CODES = Object.freeze([
  "share-exceeded", "share-uncertain", "missing-price", "incomparable-units", "no-positions",
  "uncovered-position", "unknown-position", "incomplete-chain", "missing-evidence",
  "observed-after-evaluation", "stale-evidence", "missing-exit-evidence", "utilization-only",
  "missing-fact", "unknown-controller", "conflict", "changed", "missing-snapshot", "rule-error", "missing-coverage",
] as const);
export const GAP_REASON_CODES: readonly string[] = Object.freeze([
  "missing-subject", "missing-coverage", "missing-evidence", "missing-history", "expired",
  "partial-reader", "truncated", "incompatible-snapshots", "stale", "no-facts",
]);
