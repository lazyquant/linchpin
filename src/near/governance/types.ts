import type { EvidenceReceipt, Fact, FactChange, ObservationBound, QueryReason } from "../../engine/contracts";
import type { SputnikPolicy, SputnikProposal } from "../reader/types";
import type { SubjectEntry } from "../subjects/registry";
import type { HistoryEvent } from "../reader/history";

export const GOVERNANCE_VERSION = "near-governance/1" as const;
export type EffectClass = "control" | "code" | "funds" | "parameter" | "text" | "other";
export const EFFECT_PRECEDENCE: readonly EffectClass[] = ["control", "code", "funds", "parameter", "text", "other"];
export type ReachPredicate = "touches-control-of" | "touches-code-of" | "moves-funds-from" | "moves-funds-to" | "changes-parameter-of";
export const REACH_PREDICATES: readonly ReachPredicate[] = ["touches-control-of", "touches-code-of", "moves-funds-from", "moves-funds-to", "changes-parameter-of"]; // in the order above
/** The eight reader relations used for a --for traversal. */
export const FOR_RELATIONS: readonly string[] = ["owned-by","upgraded-by","super-admin-of","holds-role","priced-by","legacy-oracle","routes-through","deployed-by"]; // ["owned-by","upgraded-by","super-admin-of","holds-role","priced-by","legacy-oracle","routes-through","deployed-by"]

export interface DecodedAction { method_name: string; argsFormat: "json" | "base64"; args: unknown; deposit: string; gas: string }
export interface PolicyFieldDiff { field: string; current: string | null; proposed: string | null } // canonical JSON strings; null = absent; "unknown" = not read
export type DecodedKind =
  | { kind: "FunctionCall"; receiver_id: string; actions: DecodedAction[] }
  | { kind: "Transfer"; token_id: string; receiver_id: string; amount: string; unit: "yoctoNEAR" | "raw"; msg: string | null }
  | { kind: "AddMemberToRole" | "RemoveMemberFromRole"; member_id: string; role: string }
  | { kind: "ChangeConfig"; config: unknown }
  | { kind: "ChangePolicy"; policy: unknown; diff: PolicyFieldDiff[] }
  | { kind: "ChangePolicyAddOrUpdateRole"; role: unknown; diff: PolicyFieldDiff[] }
  | { kind: "ChangePolicyRemoveRole"; role: string; diff: PolicyFieldDiff[] }
  | { kind: "ChangePolicyUpdateDefaultVotePolicy"; vote_policy: unknown; diff: PolicyFieldDiff[] }
  | { kind: "ChangePolicyUpdateParameters"; parameters: Record<string, unknown>; diff: PolicyFieldDiff[] }
  | { kind: "UpgradeSelf"; hash: string }
  | { kind: "UpgradeRemote"; receiver_id: string; method_name: string; hash: string }
  | { kind: "SetStakingContract"; staking_id: string }
  | { kind: "FactoryInfoUpdate"; factory_info: unknown }
  | { kind: "AddBounty"; bounty: unknown }
  | { kind: "BountyDone"; bounty_id: string; receiver_id: string }
  | { kind: "Vote" }
  | { kind: "unknown-kind"; name: string; reason: "unknown" | "malformed"; raw: unknown };

export interface DecodedProposal {
  dao: string; daoSubject: string; proposalSubject: string;   // account; near:mainnet:<dao>; near:mainnet:<dao>#proposal:<id>
  id: number; proposer: string; status: string;                // status verbatim: InProgress | Approved | Rejected | Removed | Expired | Moved | Failed
  submissionTimeNs: string; submittedAt: string;
  policyLabel: string | null;                                  // Sputnik policy label of the kind; null for unknown-kind
  decoded: DecodedKind;
  argAccounts: string[];                                       // registry accounts named anywhere in decoded JSON args, minus the receiver; sorted, unique
  proposal: SputnikProposal;                                   // the reader-parsed proposal from the fact object
  factId: string; evidenceIds: string[];                       // the source `proposal` fact
  policyComparedWith: { receiptId: string; block: string | null } | null; // set for ChangePolicy* diffs
}

export interface ActionClass { index: number; method_name: string; effectClass: EffectClass; ruleId: string }
export interface EffectResult { effectClass: EffectClass; ruleId: string; actions: ActionClass[] }
export interface EffectRule { id: string; scope: "kind" | "action"; match: string; effectClass: EffectClass; note: string }

export type MathFlag = "token-weight" | "everyone-role";
export interface RoleMath {
  role: string; kindPermission: string; policySource: "role" | "default";
  weightKind: "RoleWeight" | "TokenWeight"; threshold: { ratio: [number, number] } | { weight: string }; quorum: string;
  totalMembers: number | null; needed: number | null;
  approved: number | null; rejected: number | null; removed: number | null;   // null when not a exact integer
  voted: string[]; remainingMembers: string[]; flags: MathFlag[];
}
export interface ExecutionMath {
  label: string | null;
  role: string | null; kindPermission: string | null; totalMembers: number | null; needed: number | null;
  approved: number | null; rejected: number | null; removed: number | null; remainingMembers: string[];
  executesOn: "approve" | "reject" | "remove" | null;
  roles: RoleMath[]; flags: MathFlag[]; reason: "missing-coverage" | null;
}
export interface Expiry {
  submittedAt: string; proposalPeriodNs: string; expiresAt: string;
  readAt: string; readBlock: string | null; proposalReceiptId: string; policyReceiptId: string;
  state: "open" | "expired-unexecuted" | "closed"; constructed: boolean;
}
export interface ReachHop { hop: number; subject: string; predicate: ReachPredicate; reachFactId: string; chainFactIds: string[] }
export interface ForIntersection { forSubject: string; snapshotId: string; reachable: number; truncated: boolean; hops: ReachHop[]; reasons: QueryReason[] }
export type SentenceTemplate = "control" | "funds" | "code" | "parameter";
export interface ReviewSentence { template: SentenceTemplate; text: string; factIds: string[] }

export interface ProposalReview {
  decoded: DecodedProposal; effect: EffectResult; math: ExecutionMath; expiry: Expiry | null;
  reach: Fact[]; daoControls: Fact[];          // facts whose object is the DAO subject (what this DAO controls, as read)
  intersection: ForIntersection | null; sentences: ReviewSentence[]; reasons: QueryReason[];
}
export interface GovernanceChanges {
  dao: string; beforeSnapshotId: string | null; afterSnapshotId: string | null;
  changes: FactChange[]; summary: { field: "council-size" | "vote-threshold" | "proposal-period" | "bond"; before: string | null; after: string | null }[];
  history: HistoryEvent[];                     // historyFacts(...) events of kind "membership" | "policy"
  reasons: QueryReason[];
}
export interface GovernanceReport {
  version: typeof GOVERNANCE_VERSION; mode: "proposal" | "open";
  dao: string; snapshotId: string; governanceSnapshotId: string; constructed: boolean;
  observation: ObservationBound; forSubject: string | null;
  proposals: ProposalReview[]; governance: GovernanceChanges;
  receipts: EvidenceReceipt[]; reasons: QueryReason[];
  supportingFacts?: Fact[]; // source edges and policy fields cited by hops, summaries and reasons
}
export interface GovernanceContext { snapshotId: string; root?: string; registry?: readonly SubjectEntry[] }
export interface ProposalSummary { dao: string; id: number; proposalSubject: string; status: string; state: Expiry["state"] | null; effectClass: EffectClass; constructed: boolean; factIds: string[] }
export interface TouchingProposal extends ProposalSummary { hops: ReachHop[] }
