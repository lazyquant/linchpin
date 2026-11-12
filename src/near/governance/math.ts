import type { EvidenceReceipt } from "../../engine/contracts";
import { nsToIso } from "../reader/mappers";
import type { SputnikPolicy, SputnikProposal, SputnikVotePolicy } from "../reader/types";
import { KIND_LABELS } from "./decode";
import type { ExecutionMath, Expiry, RoleMath } from "./types";
const integer = (v: unknown): number | null => { if (!(typeof v === "number" || typeof v === "string" && /^\d+$/.test(v))) return null; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
// Sputnik policy.rs, WeightOrRatio::to_weight and Policy::proposal_status,
// near-daos/sputnik-dao-contract commit 5434a59dec23ee0c49df8c8c4350c208a7e75b0b.
// Quorum is a lower bound on each outcome count, not on turnout.
export function votesNeeded(threshold: SputnikVotePolicy["threshold"], quorum: string, total: number): number {
  if (integer(total) === null || !/^\d+$/.test(quorum)) throw new TypeError("Invalid vote inputs");
  const t = BigInt(total); let weight: bigint;
  if (Array.isArray(threshold)) {
    if (threshold.length !== 2 || threshold.some(n => integer(n) === null) || threshold[1] === 0) throw new TypeError("Invalid ratio");
    weight = BigInt(threshold[0]) * t / BigInt(threshold[1]) + 1n;
  } else { if (!/^\d+$/.test(String(threshold)) || typeof threshold === "number" && integer(threshold) === null) throw new TypeError("Invalid weight"); weight = BigInt(threshold); }
  weight = weight > t ? t : weight; const q = BigInt(quorum), result = q > weight ? q : weight;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Vote count exceeds exact numeric range");
  return Number(result);
}
export function emptyMath(label: string | null = null): ExecutionMath { return { label, role: null, kindPermission: null, totalMembers: null, needed: null, approved: null, rejected: null, removed: null, remainingMembers: [], executesOn: null, roles: [], flags: [], reason: "missing-coverage" }; }
export function executionMath(policy: SputnikPolicy, proposal: Pick<SputnikProposal, "kind" | "vote_counts" | "votes">): ExecutionMath {
  const name = typeof proposal.kind === "string" ? proposal.kind : Object.keys(proposal.kind ?? {})[0];
  const label = Object.hasOwn(KIND_LABELS, name) ? KIND_LABELS[name] : null, result = emptyMath(label); if (!label) return result;
  for (const role of policy.roles) {
    const permission = [`${label}:VoteApprove`, `${label}:*`, "*:VoteApprove", "*:*"].find(p => role.permissions.includes(p));
    if (!permission) continue;
    const v = role.vote_policy[label] ?? policy.default_vote_policy;
    const group = typeof role.kind === "object" && "Group" in role.kind ? role.kind.Group : null;
    const everyone = role.kind === "Everyone", token = v.weight_kind === "TokenWeight" || typeof role.kind === "object" && "Member" in role.kind;
    let needed: number | null = null;
    if (!everyone && !token && group) { try { needed = votesNeeded(v.threshold, v.quorum, group.length); } catch { /* Unrepresentable counts stay unknown. */ } }
    const counts = proposal.vote_counts[role.name] ?? [0,0,0];
    const r: RoleMath = { role: role.name, kindPermission: permission, policySource: Object.hasOwn(role.vote_policy, label) ? "role" : "default", weightKind: v.weight_kind, threshold: Array.isArray(v.threshold) ? { ratio: [...v.threshold] } : { weight: String(v.threshold) }, quorum: v.quorum, totalMembers: group?.length ?? null, needed, approved: Array.isArray(counts) ? integer(counts[0]) : null, rejected: Array.isArray(counts) ? integer(counts[1]) : null, removed: Array.isArray(counts) ? integer(counts[2]) : null, voted: group ? group.filter(m => Object.hasOwn(proposal.votes,m)).sort() : [], remainingMembers: group ? group.filter(m => !Object.hasOwn(proposal.votes,m)).sort() : [], flags: [...(everyone ? ["everyone-role" as const] : []), ...(token ? ["token-weight" as const] : [])] };
    result.roles.push(r);
    if (!everyone && result.role === null) { for (const k of ["role","kindPermission","totalMembers","needed","approved","rejected","removed","remainingMembers"] as const) Object.assign(result, { [k]: r[k] }); result.reason = needed === null ? "missing-coverage" : null; }
    if (result.executesOn === null && needed !== null) {
      if (r.approved !== null && r.approved >= needed) result.executesOn = "approve";
      else if (r.rejected !== null && r.rejected >= needed) result.executesOn = "reject";
      else if (r.removed !== null && r.removed >= needed) result.executesOn = "remove";
    }
  }
  result.flags = [...new Set(result.roles.flatMap(r => r.flags))]; return result;
}
export function proposalExpiry(p: Pick<SputnikProposal,"status" | "submission_time">, policy: SputnikPolicy, proposalReceipt: EvidenceReceipt, policyReceipt: EvidenceReceipt): Expiry {
  const expires = BigInt(p.submission_time) + BigInt(policy.proposal_period), readAt = proposalReceipt.observation.observedAt;
  return { submittedAt: nsToIso(p.submission_time), proposalPeriodNs: policy.proposal_period, expiresAt: nsToIso(String(expires)), readAt, readBlock: proposalReceipt.observation.blockOrSlot, proposalReceiptId: proposalReceipt.id, policyReceiptId: policyReceipt.id, state: p.status !== "InProgress" ? "closed" : expires < BigInt(Date.parse(readAt))*1000000n ? "expired-unexecuted" : "open", constructed: proposalReceipt.observation.historicalState === "constructed" };
}
