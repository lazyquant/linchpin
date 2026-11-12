import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import type { SubjectEntry } from "../subjects/registry";
import { isNearAccountId, nearSubject, parseNearJson, type SputnikPolicy, type SputnikProposal, type SputnikVotePolicy } from "./types";
export interface MapperContext { snapshotId: string; account: string; entry: SubjectEntry; constructed: boolean }
export type NearMapper = (response: unknown, receipt: EvidenceReceipt, ctx: MapperContext) => Fact[];
export function factId(snapshotId: string, f: Pick<Fact, "subject" | "predicate" | "object" | "basis">): string {
  return `nf:${snapshotId}:${sha256(canonical({ subject: f.subject, predicate: f.predicate, object: f.object, basis: f.basis })).slice(0, 40)}`;
}
function obj(v: unknown): Record<string, any> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected NEAR object"); return v; }
function str(v: unknown): string { if (typeof v !== "string") throw new Error("Expected NEAR string"); return v; }
function arr(v: unknown): unknown[] { if (!Array.isArray(v)) throw new Error("Expected NEAR array"); return v; }
function strings(v: unknown): string[] { return arr(v).map(str); }
function account(v: unknown): string { const s = str(v); if (!isNearAccountId(s)) throw new Error("Invalid NEAR account in response"); return s; }
function accounts(v: unknown): string[] { return arr(v).map(account); }
function decimal(v: unknown): string { const s = typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : str(v); if (!/^\d+$/.test(s)) throw new Error("Expected unsigned decimal"); return s; }
function make(receipt: EvidenceReceipt, ctx: MapperContext) {
  return (predicate: string, object: string, subject = nearSubject(ctx.account), basis: Fact["basis"] = "observed"): Fact => {
    if (!object.length || object.length > 1048576 || /[\u0000-\u001f]/.test(object)) throw new Error(`Invalid NEAR fact object: ${subject} ${predicate} (${object.length} characters)`);
    const f = { subject, predicate, object, basis };
    // An unidentified object or basis is unverified; "none" (read and absent) stays verified.
    const status: Fact["status"] = object === "unknown" || basis === "unknown" ? "unverified" : "verified";
    return { ...f, id: factId(ctx.snapshotId, f), status, privacy: "public", evidenceIds: [receipt.id], path: [], validFrom: ctx.constructed || receipt.observation.historicalState === "constructed" ? receipt.observation.observedAt : null, validTo: null };
  };
}
export function nsToIso(ns: string): string { return new Date(Number(BigInt(decimal(ns)) / 1_000_000n)).toISOString(); }
export function decodeArgs(base64: string): { argsFormat: "json"; args: unknown } | { argsFormat: "base64"; args: string } {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error();
    return { argsFormat: "json", args: parseNearJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"))) };
  } catch { return { argsFormat: "base64", args: base64 }; }
}
export function parseAcl(value: unknown): { superAdmins: string[]; roles: Record<string, { admins: string[]; grantees: string[] }> } {
  const v = obj(value);
  return { superAdmins: accounts(v.super_admins), roles: Object.fromEntries(Object.entries(obj(v.roles)).map(([name, r]) => [name, { admins: accounts(obj(r).admins), grantees: accounts(obj(r).grantees) }])) };
}
function vote(value: unknown): SputnikVotePolicy {
  const v = obj(value);
  if (v.weight_kind !== "RoleWeight" && v.weight_kind !== "TokenWeight") throw new Error("Unknown vote weight");
  let threshold: SputnikVotePolicy["threshold"];
  if (Array.isArray(v.threshold)) {
    if (v.threshold.length !== 2 || !v.threshold.every((n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) || v.threshold[1] === 0) throw new Error("Invalid vote ratio");
    threshold = [v.threshold[0], v.threshold[1]];
  } else { decimal(v.threshold); threshold = v.threshold; }
  return { weight_kind: v.weight_kind, quorum: decimal(v.quorum), threshold };
}
export function parseSputnikPolicy(value: unknown): SputnikPolicy {
  const v = obj(value);
  return { roles: arr(v.roles).map(raw => {
    const r = obj(raw);
    let kind: SputnikPolicy["roles"][number]["kind"];
    if (r.kind === "Everyone") kind = "Everyone";
    else if (Object.hasOwn(obj(r.kind), "Group")) kind = { Group: accounts(r.kind.Group) };
    else if (Object.hasOwn(obj(r.kind), "Member")) kind = { Member: decimal(r.kind.Member) };
    else throw new Error("Unknown Sputnik role kind");
    return { name: str(r.name), kind, permissions: strings(r.permissions), vote_policy: Object.fromEntries(Object.entries(obj(r.vote_policy)).map(([k, p]) => [k, vote(p)])) };
  }), default_vote_policy: vote(v.default_vote_policy), proposal_period: decimal(v.proposal_period), proposal_bond: decimal(v.proposal_bond) };
}
export function parseSputnikProposal(value: unknown): SputnikProposal {
  const v = obj(value);
  if (!Number.isSafeInteger(v.id) || v.id < 0) throw new Error("Invalid proposal id");
  const kind = typeof v.kind === "string" ? v.kind : structuredClone(obj(v.kind));
  if (typeof kind === "object" && kind.FunctionCall) {
    const call = obj(kind.FunctionCall); account(call.receiver_id);
    call.actions = arr(call.actions).map(raw => {
      const action = obj(raw);
      return { method_name: str(action.method_name), ...decodeArgs(str(action.args)), deposit: decimal(action.deposit), gas: decimal(action.gas) };
    });
  }
  return { id: v.id, proposer: account(v.proposer), status: str(v.status), submission_time: decimal(v.submission_time), kind, vote_counts: structuredClone(obj(v.vote_counts)), votes: structuredClone(obj(v.votes)) };
}
export function parseDeployments(value: unknown): Record<string, { hash: string; version: string; deploymentTimeNs: string; upgrades: { timeNs: string; version: string }[] }> {
  return Object.fromEntries(Object.entries(obj(value)).map(([a, raw]) => {
    account(a); const v = obj(raw);
    return [a, { hash: str(v.hash), version: str(v.version), deploymentTimeNs: decimal(v.deployment_time), upgrades: Object.entries(obj(v.upgrade_times)).map(([time, version]) => ({ timeNs: decimal(time), version: str(version) })).sort((a, b) => BigInt(a.timeNs) < BigInt(b.timeNs) ? -1 : 1) }];
  }));
}
export const mapAccount: NearMapper = (v, r, c) => { const hash = str(obj(v).code_hash); return [make(r, c)("has-code-hash", hash === "11111111111111111111111111111111" ? "none" : hash)]; };
export const mapAccessKeys: NearMapper = (v, r, c) => {
  const f = make(r, c); let full = 0;
  const facts = arr(obj(v).keys).map(raw => {
    const key = obj(raw); const pk = str(key.public_key); const permission = obj(key.access_key).permission;
    if (permission === "FullAccess") { full++; return f("has-full-access-key", pk); }
    const p = obj(obj(permission).FunctionCall);
    return f("has-function-call-key", `${pk}|${account(p.receiver_id)}|${strings(p.method_names).join(",") || "*"}|${p.allowance === null ? "unlimited" : decimal(p.allowance)}`);
  });
  if (!full) facts.push(f("has-full-access-key", "none")); return facts;
};
export const mapCodeHash: NearMapper = (v, r, c) => [make(r, c)("has-code-hash", `sha256:${str(obj(v).codeSha256)}`)];
export const mapAcl: NearMapper = (v, r, c) => {
  const acl = parseAcl(v), f = make(r, c), facts = acl.superAdmins.map(a => f("super-admin-of", nearSubject(a)));
  const recipes = c.entry.recipes.filter(x => x.kind === "acl");
  for (const [name, role] of Object.entries(acl.roles)) {
    const node = nearSubject(c.account, "role", name); facts.push(f("holds-role", node));
    facts.push(...(role.grantees.length ? role.grantees.map(nearSubjectAccount) : ["none"]).map(a => f("holds-role", a, node)));
    if (role.admins.length) { const admin = nearSubject(c.account, "role-admin", name); facts.push(f("holds-role", admin), ...role.admins.map(a => f("holds-role", nearSubject(a), admin))); }
    for (const recipe of recipes) for (const a of role.grantees) {
      if (recipe.upgradeRoles?.includes(name)) facts.push(f("upgraded-by", nearSubject(a)));
      if (recipe.rolePredicates?.[name]) facts.push(f(recipe.rolePredicates[name], nearSubject(a)));
    }
  }
  return facts;
};
const nearSubjectAccount = (a: string) => nearSubject(a);
export const mapPause: NearMapper = (v, r, c) => { if (typeof v !== "boolean") throw new Error("Expected pause boolean"); return [make(r, c)("paused", String(v))]; };
export const mapAllPaused: NearMapper = (v, r, c) => v === null ? [] : strings(v).map(k => make(r, c)("paused", k));
export const mapOwner: NearMapper = (v, r, c) => [make(r, c)("owned-by", nearSubject(account(v)))];
export function mapOwnerUnknown(r: EvidenceReceipt, c: MapperContext): Fact[] { return [make(r, c)("owned-by", "unknown", nearSubject(c.account), "unknown")]; }
export const mapGuardians: NearMapper = (v, r, c) => {
  const f = make(r, c), node = nearSubject(c.account, "role", "guardian"), members = accounts(v);
  return [f("holds-role", node), ...(members.length ? members.map(nearSubjectAccount) : ["none"]).map(a => f("holds-role", a, node))];
};
export const mapBurrowConfig: NearMapper = (v, r, c) => {
  const o = obj(v), f = make(r, c), facts = [f("owned-by", nearSubject(account(o.owner_id))), f("pause-operator", o.pause_operator_id == null ? "none" : nearSubject(account(o.pause_operator_id))), f("contract-mode", str(o.contract_mode))];
  for (const [key, flag] of [["oracle_account_id", "enable_price_oracle"], ["pyth_oracle_account_id", "enable_pyth_oracle"]]) {
    if (typeof o[flag] !== "boolean") throw new Error("Missing oracle enable flag");
    facts.push(f(o[flag] ? "priced-by" : "legacy-oracle", nearSubject(account(o[key]))));
  }
  for (const key of ["ref_exchange_id", "dcl_id"]) facts.push(f("routes-through", nearSubject(account(o[key])))); return facts;
};
function threshold(p: SputnikVotePolicy, kind: string): string { return `${Array.isArray(p.threshold) ? p.threshold.join("/") : p.threshold}|${kind}|${p.weight_kind}|quorum:${p.quorum}`; }
export const mapSputnikPolicy: NearMapper = (v, r, c) => {
  const p = parseSputnikPolicy(v), f = make(r, c), facts = [f("vote-threshold", threshold(p.default_vote_policy, "default")), f("proposal-period", p.proposal_period), f("bond", p.proposal_bond)];
  const council = new Set<string>();
  for (const role of p.roles) {
    const node = nearSubject(c.account, "role", role.name); facts.push(f("holds-role", node));
    let members: string[];
    if (role.kind === "Everyone") members = ["everyone"];
    else if ("Group" in role.kind) { role.kind.Group.forEach(a => council.add(a)); members = role.kind.Group.map(nearSubjectAccount); }
    else members = [`token-holder:${role.kind.Member}`];
    facts.push(...(members.length ? members : ["none"]).map(a => f("holds-role", a, node)), ...Object.entries(role.vote_policy).map(([kind, p]) => f("vote-threshold", threshold(p, kind), node)));
  }
  facts.push(...[...council].map(a => f("council-member", nearSubject(a)))); return facts;
};
export const mapSputnikProposals: NearMapper = (v, r, c) => (Array.isArray(v) ? v : [v]).map(raw => {
  const p = parseSputnikProposal(raw); return make(r, c)("proposal", canonical({ ...p, submittedAt: nsToIso(p.submission_time) }), nearSubject(c.account, "proposal", String(p.id)));
});
export const mapDeployments: NearMapper = (v, r, c) => Object.entries(parseDeployments(v)).flatMap(([a, d]) => {
  const f = make(r, c), node = nearSubject(c.account, "deployment", a);
  return [f("has-code-hash", d.hash, node), f("deployed-version", `initial@${nsToIso(d.deploymentTimeNs)}`, node), f("deployed-version", `${d.version}@current`, node), ...d.upgrades.map(u => f("deployed-version", `${u.version}@${nsToIso(u.timeNs)}`, node))];
});
export const mapMpcState: NearMapper = (v, r, c) => {
  const state = obj(v), entries = Object.entries(state);
  if (entries.length !== 1) throw new Error("Expected one MPC state variant");
  const [variant, raw] = entries[0], f = make(r, c), facts = [f("contract-mode", variant)];
  if (variant !== "Running" && variant !== "Resharing") return facts;
  const stateValue = obj(raw), p = obj(variant === "Running" ? stateValue.parameters : obj(stateValue.previous_running_state).parameters);
  facts.push(f("mpc-threshold", decimal(p.threshold)));
  for (const row of arr(obj(p.participants).participants)) { const participant = arr(row); facts.push(f("mpc-participant", nearSubject(account(participant[0])))); } return facts;
};
export const mapMpcImages: NearMapper = (v, r, c) => arr(v).map(raw => {
  if (typeof raw === "string") return make(r, c)("mpc-allowed-image", raw);
  if (!Array.isArray(raw)) { const image = obj(raw); return make(r, c)("mpc-allowed-image", `${str(image.image_hash)}@${image.expiry_timestamp_seconds === null ? "none" : decimal(image.expiry_timestamp_seconds)}`); }
  const pair = arr(raw); if (pair.length !== 2) throw new Error("Invalid MPC image entry");
  return make(r, c)("mpc-allowed-image", `${str(pair[0])}@${pair[1] === null ? "none" : decimal(pair[1])}`);
});
export const mapFtMetadata: NearMapper = (v, r, c) => {
  const m = obj(v); if (!Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 255) throw new Error("Invalid token decimals");
  return [make(r, c)("ft-metadata", canonical({ spec: str(m.spec), name: str(m.name), symbol: str(m.symbol), decimals: m.decimals, reference: m.reference == null ? null : str(m.reference), reference_hash: m.reference_hash == null ? null : str(m.reference_hash), iconSha256: m.icon == null ? null : sha256(str(m.icon)) }))];
};
/** The same dispatch is used during capture validation and deterministic replay. */
export function mapperFor(requestType: string, method?: string): NearMapper | null {
  if (requestType === "view_account") return mapAccount;
  if (requestType === "view_access_key_list") return mapAccessKeys;
  if (requestType === "view_code") return mapCodeHash;
  const methods: Record<string, NearMapper> = { acl_get_permissioned_accounts: mapAcl, pa_is_paused: mapPause, pa_all_paused: mapAllPaused, get_owner: mapOwner, get_guardians: mapGuardians, get_config: mapBurrowConfig, get_policy: mapSputnikPolicy, get_proposals: mapSputnikProposals, get_proposal: mapSputnikProposals, get_deployments: mapDeployments, state: mapMpcState, allowed_docker_image_hashes: mapMpcImages, ft_metadata: mapFtMetadata };
  return methods[method ?? ""] ?? null;
}
