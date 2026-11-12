import { canonical } from "../../chain/evidence";
import type { Fact, QueryReason } from "../../engine/contracts";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import { factId } from "./mappers";
import { parseNearSubject } from "./types";
export type HistoryKind = "code-upgrade" | "code-deployed" | "membership" | "policy" | "self-upgrade" | "remote-upgrade" | "acl" | "pause" | "owner" | "guardians";
export interface HistoryEvent { at: string; kind: HistoryKind; source: Fact; fact: Fact }
export interface HistoryResult { subject: string; snapshotId: string; events: HistoryEvent[]; reasons: QueryReason[]; coverage: { dao: string; fromId: number; toId: number; lastId: number }[] }
export function historyFacts(store: EvidenceStore, subject: string, snapshotId: string): HistoryResult {
  const result: HistoryResult = { subject, snapshotId, events: [], reasons: [], coverage: [] };
  const identity = parseNearSubject(subject); if (!identity) throw new Error("Invalid NEAR history subject");
  const snapshot = store.snapshot(snapshotId);
  if (!snapshot || !snapshot.subjects.includes(subject)) { result.reasons.push({ code: "missing-subject", subject, ref: snapshotId }); return result; }
  const facts = snapshot.facts.filter(f => f.evidenceIds.length && f.evidenceIds.every(id => store.receipt(id)));
  const controllers = new Set([subject]);
  for (const f of facts) {
    if (f.subject === subject && ["owned-by", "super-admin-of", "upgraded-by"].includes(f.predicate)) controllers.add(f.object);
    const parsed = parseNearSubject(f.subject);
    if (parsed?.account === identity.account && (parsed.kind === "role" || parsed.kind === "role-admin") && f.predicate === "holds-role") controllers.add(f.object);
  }
  const event = (source: Fact, at: string, kind: HistoryKind) => {
    const fact: Fact = { ...source, subject, object: canonical({ at, kind, ref: source.subject }), basis: "derived", path: [source.id], evidenceIds: [...source.evidenceIds] };
    fact.id = factId(snapshotId, fact); result.events.push({ at, kind, source, fact });
  };
  const proposals = new Map<string, number[]>();
  for (const f of facts) {
    const parsed = parseNearSubject(f.subject);
    if (!parsed) continue;
    if (f.predicate === "deployed-version" && parsed.kind === "deployment" && parsed.key === identity.account) {
      const split = f.object.indexOf("@"), version = f.object.slice(0, split), at = f.object.slice(split + 1);
      if (split >= 0 && at !== "current" && Number.isFinite(Date.parse(at))) event(f, at, version === "initial" ? "code-deployed" : "code-upgrade");
    }
    if (f.predicate !== "proposal" || parsed.kind !== "proposal") continue;
    const p = JSON.parse(f.object), dao = `near:mainnet:${parsed.account}`;
    const ids = proposals.get(dao) ?? []; ids.push(p.id); proposals.set(dao, ids);
    if (p.status !== "Approved") continue;
    const kindName = typeof p.kind === "string" ? p.kind : Object.keys(p.kind)[0], detail = typeof p.kind === "string" ? null : p.kind[kindName];
    const kinds = new Set<HistoryKind>();
    if (controllers.has(dao)) {
      if (["AddMemberToRole", "RemoveMemberFromRole"].includes(kindName)) kinds.add("membership");
      if (kindName.startsWith("ChangePolicy")) kinds.add("policy");
      if (kindName === "UpgradeSelf") kinds.add("self-upgrade");
    }
    if (kindName === "UpgradeRemote" && detail?.receiver_id === identity.account) kinds.add("remote-upgrade");
    if (kindName === "FunctionCall" && detail?.receiver_id === identity.account) for (const action of detail.actions) {
      const method: string = action.method_name;
      if (method.startsWith("acl_")) kinds.add("acl");
      else if (method.startsWith("pa_") || ["pause", "unpause"].includes(method)) kinds.add("pause");
      else if (method === "upgrade") kinds.add("remote-upgrade");
      else if (method === "set_owner") kinds.add("owner");
      else if (["add_guardians", "remove_guardians"].includes(method)) kinds.add("guardians");
    }
    for (const kind of kinds) event(f, p.submittedAt, kind);
  }
  for (const [dao, ids] of [...proposals].sort(([a], [b]) => a.localeCompare(b))) {
    const fromId = Math.min(...ids), toId = Math.max(...ids);
    result.coverage.push({ dao, fromId, toId, lastId: toId + 1 });
    if (fromId > 0) result.reasons.push({ code: "missing-coverage", subject: dao, ref: `${dao}#proposals:${fromId}-${toId}` });
  }
  result.events.sort((a, b) => a.at.localeCompare(b.at) || a.source.id.localeCompare(b.source.id) || a.kind.localeCompare(b.kind));
  return result;
}
