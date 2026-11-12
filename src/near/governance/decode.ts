import { canonical } from "../../chain/evidence";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { nsToIso, parseSputnikPolicy } from "../reader/mappers";
import { parseNearSubject, type SputnikPolicy, type SputnikProposal } from "../reader/types";
import { NEAR_REGISTRY, type SubjectEntry } from "../subjects/registry";
import type { DecodedKind, DecodedProposal, PolicyFieldDiff } from "./types";

export const KIND_LABELS: Readonly<Record<string, string>> = {
  AddMemberToRole: "add_member_to_role", RemoveMemberFromRole: "remove_member_from_role", FunctionCall: "call",
  UpgradeSelf: "upgrade_self", UpgradeRemote: "upgrade_remote", Transfer: "transfer", SetStakingContract: "set_vote_token",
  AddBounty: "add_bounty", BountyDone: "bounty_done", Vote: "vote", FactoryInfoUpdate: "factory_info_update", ChangeConfig: "config",
  ChangePolicy: "policy", ChangePolicyAddOrUpdateRole: "policy_add_or_update_role", ChangePolicyRemoveRole: "policy_remove_role",
  ChangePolicyUpdateDefaultVotePolicy: "policy_update_default_vote_policy", ChangePolicyUpdateParameters: "policy_update_parameters",
};
function obj(x: unknown): Record<string, any> { if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Expected object"); return x; }
function str(x: unknown): string { if (typeof x !== "string") throw new Error("Expected string"); return x; }
function decimal(x: unknown): string { const s = typeof x === "number" && Number.isSafeInteger(x) ? String(x) : str(x); if (!/^\d+$/.test(s)) throw new Error("Expected decimal"); return s; }
function list(x: unknown): unknown[] { if (!Array.isArray(x)) throw new Error("Expected array"); return x; }
function role(x: unknown): Record<string, any> {
  const r = obj(x); str(r.name); list(r.permissions).forEach(str); obj(r.vote_policy);
  if (r.kind !== "Everyone") { const k = obj(r.kind); if (Object.hasOwn(k, "Group")) list(k.Group).forEach(str); else decimal(k.Member); }
  return r;
}
function fields(policy: SputnikPolicy | Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of ["proposal_period", "proposal_bond", "default_vote_policy"]) if (Object.hasOwn(policy, k)) result[k] = policy[k as keyof typeof policy];
  for (const r of policy.roles ?? []) for (const k of ["kind", "permissions", "vote_policy"]) result[`role:${r.name}.${k}`] = k === "permissions" ? [...r.permissions].sort() : r[k as keyof typeof r];
  return result;
}
function policyDiff(name: string, d: Record<string, any>, policy: SputnikPolicy | null): PolicyFieldDiff[] {
  const current = policy ? fields(policy) : {}, proposed: Record<string, unknown> = {};
  let keys: string[];
  if (name === "ChangePolicy") {
    if (Array.isArray(d.policy)) return [{ field: "default-policy-council", current: policy ? canonical(policy.roles.flatMap(r => r.name === "council" && typeof r.kind === "object" && "Group" in r.kind ? r.kind.Group : [])) : "unknown", proposed: canonical(d.policy) }].filter(x => x.current !== x.proposed);
    Object.assign(proposed, fields(d.policy)); keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])];
  } else if (name === "ChangePolicyAddOrUpdateRole" || name === "ChangePolicyRemoveRole") {
    const n = name === "ChangePolicyRemoveRole" ? d.role : d.role.name;
    keys = ["kind", "permissions", "vote_policy"].map(k => `role:${n}.${k}`);
    if (name === "ChangePolicyAddOrUpdateRole") Object.assign(proposed, fields({ roles: [d.role] }));
  } else if (name === "ChangePolicyUpdateDefaultVotePolicy") { keys = ["default_vote_policy"]; proposed.default_vote_policy = d.vote_policy; }
  else { keys = Object.keys(d.parameters).filter(k => d.parameters[k] !== null); for (const k of keys) proposed[k] = d.parameters[k]; }
  return keys.sort().map(field => ({ field, current: !policy || ["bounty_bond", "bounty_forgiveness_period"].includes(field) ? "unknown" : Object.hasOwn(current, field) ? canonical(current[field]) : null, proposed: Object.hasOwn(proposed, field) ? canonical(proposed[field]) : null })).filter(x => x.current !== x.proposed);
}
function decodeKind(raw: unknown, policy: SputnikPolicy | null): DecodedKind {
  const name = typeof raw === "string" ? raw : raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw)[0] ?? "unknown" : "unknown";
  const unknown = (reason: "unknown" | "malformed"): DecodedKind => ({ kind: "unknown-kind", name, reason, raw });
  if (typeof raw !== "string" && (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1)) return unknown("malformed");
  if (!Object.hasOwn(KIND_LABELS, name)) return unknown("unknown");
  try {
    if (name === "Vote") { if (raw !== "Vote" && (Object.keys(obj(raw)).length !== 1 || (obj(raw).Vote !== null && Object.keys(obj(obj(raw).Vote)).length))) throw new Error(); return { kind: "Vote" }; }
    const outer = obj(raw); if (Object.keys(outer).length !== 1) throw new Error(); const d = obj(outer[name]);
    switch (name) {
      case "FunctionCall": return { kind: name, receiver_id: str(d.receiver_id), actions: list(d.actions).map(a => {
        const v = obj(a); if (v.argsFormat !== "json" && v.argsFormat !== "base64" || !Object.hasOwn(v, "args")) throw new Error();
        if (v.argsFormat === "base64") str(v.args);
        return { method_name: str(v.method_name), argsFormat: v.argsFormat, args: v.args, deposit: decimal(v.deposit), gas: decimal(v.gas) };
      }) };
      case "Transfer": return { kind: name, token_id: str(d.token_id), receiver_id: str(d.receiver_id), amount: decimal(d.amount), unit: d.token_id === "" ? "yoctoNEAR" : "raw", msg: d.msg == null ? null : str(d.msg) };
      case "AddMemberToRole": case "RemoveMemberFromRole": return { kind: name, member_id: str(d.member_id), role: str(d.role) };
      case "ChangeConfig": { const c=obj(d.config); str(c.name); str(c.purpose); str(c.metadata); } return { kind: name, config: d.config };
      case "ChangePolicy": if (Array.isArray(d.policy)) d.policy.forEach(str); else parseSputnikPolicy(d.policy); return { kind: name, policy: d.policy, diff: policyDiff(name, d, policy) };
      case "ChangePolicyAddOrUpdateRole": role(d.role); return { kind: name, role: d.role, diff: policyDiff(name, d, policy) };
      case "ChangePolicyRemoveRole": str(d.role); return { kind: name, role: d.role, diff: policyDiff(name, d, policy) };
      case "ChangePolicyUpdateDefaultVotePolicy": parseSputnikPolicy({ roles: [], default_vote_policy: d.vote_policy, proposal_period: "0", proposal_bond: "0" }); return { kind: name, vote_policy: d.vote_policy, diff: policyDiff(name, d, policy) };
      case "ChangePolicyUpdateParameters": obj(d.parameters); for (const v of Object.values(d.parameters)) if (v !== null) decimal(v); return { kind: name, parameters: d.parameters, diff: policyDiff(name, d, policy) };
      case "UpgradeSelf": return { kind: name, hash: str(d.hash) };
      case "UpgradeRemote": return { kind: name, receiver_id: str(d.receiver_id), method_name: str(d.method_name), hash: str(d.hash) };
      case "SetStakingContract": return { kind: name, staking_id: str(d.staking_id) };
      case "FactoryInfoUpdate": { const f = obj(d.factory_info); str(f.factory_id); if (typeof f.auto_update !== "boolean") throw new Error(); return { kind: name, factory_info: f }; }
      case "AddBounty": { const b = obj(d.bounty); str(b.description); str(b.token); decimal(b.amount); decimal(b.times); decimal(b.max_deadline); return { kind: name, bounty: b }; }
      case "BountyDone": return { kind: name, bounty_id: decimal(d.bounty_id), receiver_id: str(d.receiver_id) };
      default: return unknown("unknown");
    }
  } catch { return unknown("malformed"); }
}
export function decodeProposal(fact: Fact, policy: SputnikPolicy | null = null, policyReceipt: EvidenceReceipt | null = null, registry: readonly SubjectEntry[] = NEAR_REGISTRY): DecodedProposal {
  const identity = parseNearSubject(fact.subject);
  if (fact.predicate !== "proposal" || identity?.kind !== "proposal" || !/^(0|[1-9]\d*)$/.test(identity.key ?? "") || !Number.isSafeInteger(Number(identity.key))) throw new TypeError("Expected proposal fact and numeric proposal subject");
  const fallback: SputnikProposal = { id: Number(identity.key), proposer: "", status: "unknown", submission_time: "0", kind: {}, votes: {}, vote_counts: {} };
  let raw: unknown = fact.object, proposal = fallback, decoded: DecodedKind, submittedAt = "unknown";
  try {
    raw = JSON.parse(fact.object); const p = obj(raw);
    if (p.id !== fallback.id || !Number.isSafeInteger(p.id)) throw new Error();
    proposal = { id: p.id, proposer: str(p.proposer), status: str(p.status), submission_time: decimal(p.submission_time), kind: p.kind, votes: obj(p.votes), vote_counts: obj(p.vote_counts) };
    submittedAt = nsToIso(proposal.submission_time); decoded = decodeKind(p.kind, policy);
  } catch { decoded = { kind: "unknown-kind", name: "unknown", reason: "malformed", raw }; }
  const accounts = new Set<string>(), known = new Set(registry.map(r => r.account));
  const walk = (root: unknown): void => { const pending: unknown[] = [root]; while (pending.length) { const v=pending.pop(); if (typeof v === "string" && known.has(v)) accounts.add(v); else if (Array.isArray(v)) for(const child of v) pending.push(child); else if (v && typeof v === "object") for(const child of Object.values(v)) pending.push(child); } };
  if (decoded.kind === "FunctionCall") { for (const a of decoded.actions) if (a.argsFormat === "json") walk(a.args); accounts.delete(decoded.receiver_id); }
  return { dao: identity.account, daoSubject: `near:mainnet:${identity.account}`, proposalSubject: fact.subject, id: fallback.id, proposer: proposal.proposer, status: proposal.status, submissionTimeNs: proposal.submission_time, submittedAt, policyLabel: KIND_LABELS[decoded.kind] ?? null, decoded, argAccounts: [...accounts].sort(), proposal, factId: fact.id, evidenceIds: [...fact.evidenceIds], policyComparedWith: decoded.kind.startsWith("ChangePolicy") && policyReceipt ? { receiptId: policyReceipt.id, block: policyReceipt.observation.blockOrSlot } : null };
}
