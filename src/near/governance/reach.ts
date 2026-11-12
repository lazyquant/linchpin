import type { Fact } from "../../engine/contracts";
import { runQuery } from "../../engine/queries/run";
import { openStore, type EvidenceSnapshot, type EvidenceStore } from "../../engine/queries/snapshot";
import { buildNearSnapshot, extendSnapshot } from "../reader/load";
import { factId } from "../reader/mappers";
import { isNearAccountId, nearSubject } from "../reader/types";
import { NEAR_REGISTRY, type SubjectEntry } from "../subjects/registry";
import { classify } from "./effect";
import { FOR_RELATIONS, type DecodedProposal, type ForIntersection, type GovernanceContext, type ReachPredicate } from "./types";
export const governanceSnapshotId = (id: string): string => `${id}.governance`;
export function reach(p: DecodedProposal, store: EvidenceStore, snapshotId: string, registry: readonly SubjectEntry[] = NEAR_REGISTRY): Fact[] {
  const snapshot = store.snapshot(snapshotId); if (!snapshot) throw new Error("Unknown snapshot");
  const policy = snapshot.facts.find(f => f.subject === p.daoSubject && f.predicate === "bond");
  if (!policy) return [];
  const evidenceIds = [...new Set([...p.evidenceIds, ...policy.evidenceIds])].sort();
  if (evidenceIds.length < 2 || evidenceIds.some(id => !store.receipt(id))) return [];
  const result = new Map<string, Fact>();
  const add = (predicate: ReachPredicate, account: unknown) => {
    if (typeof account !== "string" || !isNearAccountId(account)) return;
    const f: Fact = { id: "", subject: p.proposalSubject, predicate, object: nearSubject(account), basis: "derived", status: "verified", privacy: "public", path: [p.factId], evidenceIds, validFrom: snapshot.constructed ? evidenceIds.map(id => store.receipt(id)!.observation.observedAt).sort().at(-1)! : null, validTo: null };
    f.id = factId(governanceSnapshotId(snapshotId), f); result.set(f.id, f);
  };
  const d = p.decoded, effect = classify(p,registry);
  if (d.kind === "FunctionCall") for (const a of effect.actions) {
    const action = d.actions[a.index];
    if (a.effectClass === "control") add("touches-control-of",d.receiver_id);
    else if (a.effectClass === "code") add("touches-code-of",d.receiver_id);
    else if (a.effectClass === "parameter") add("changes-parameter-of",d.receiver_id);
    else if (a.ruleId === "A07") { add("moves-funds-from",p.dao); if (action.argsFormat === "json" && action.args && typeof action.args === "object") add("moves-funds-to",(action.args as Record<string,unknown>).receiver_id); }
    else if (a.effectClass === "funds") { add("moves-funds-from",d.receiver_id); add("moves-funds-to",p.dao); }
  } else if (effect.effectClass === "control") add("touches-control-of",p.dao);
  else if (d.kind === "UpgradeSelf") add("touches-code-of",p.dao);
  else if (d.kind === "UpgradeRemote") add("touches-code-of",d.receiver_id);
  else if (d.kind === "Transfer") { add("moves-funds-from",p.dao); add("moves-funds-to",d.receiver_id); }
  return [...result.values()].sort((a,b) => a.id.localeCompare(b.id));
}
export function governanceStore(ctx: GovernanceContext, proposals: DecodedProposal[]): { store: EvidenceStore; snapshotId: string; base: EvidenceSnapshot; reach: Map<string, Fact[]> } {
  const base = buildNearSnapshot(ctx.snapshotId,{root:ctx.root}), baseStore = openStore([base]), byProposal = new Map(proposals.map(p => [p.proposalSubject,reach(p,baseStore,base.id,ctx.registry)]));
  const snapshotId = governanceSnapshotId(base.id);
  return { store: openStore([extendSnapshot(base,{id:snapshotId,facts:[...byProposal.values()].flat()})]), snapshotId, base, reach: byProposal };
}
export function intersectFor(store: EvidenceStore, snapshotId: string, facts: Fact[], forSubject: string): ForIntersection {
  const snapshot = store.snapshot(snapshotId); if (!snapshot) throw new Error("Unknown snapshot");
  const q = runQuery(store,{name:"dependencies",subject:forSubject,relations:[...FOR_RELATIONS],scope:{asOf:snapshot.observedTo,snapshotId,maxHops:8,maxResults:500}});
  const chain = new Map<string,{hop:number; chainFactIds:string[]}>([[forSubject,{hop:0,chainFactIds:[]}]]);
  for (const f of q.facts) { const hop = Math.max(1,f.path.length), old = chain.get(f.object); if (!old || old.hop > hop) chain.set(f.object,{hop,chainFactIds:hop === 1 ? [f.id] : [...f.path]}); }
  return {forSubject,snapshotId,reachable:chain.size,truncated:q.truncated,hops:facts.flatMap(f => { const h=chain.get(f.object); return h ? [{...h,subject:f.object,predicate:f.predicate as ReachPredicate,reachFactId:f.id}] : []; }).sort((a,b) => a.hop-b.hop || a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate)),reasons:q.reasons};
}
export function daoControls(snapshot: EvidenceSnapshot, daoSubject: string): Fact[] { return snapshot.facts.filter(f => f.object === daoSubject && ["owned-by","super-admin-of","upgraded-by","holds-role","pause-operator"].includes(f.predicate)).sort((a,b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id)); }
