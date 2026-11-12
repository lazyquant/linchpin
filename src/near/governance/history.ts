import { runQuery } from "../../engine/queries/run";
import type { EvidenceSnapshot } from "../../engine/queries/snapshot";
import { historyFacts } from "../reader/history";
import { liveSnapshotIds, loadNearSnapshot, loadNearSnapshots } from "../reader/load";
import { nearSubject, parseNearSubject } from "../reader/types";
import type { GovernanceChanges, GovernanceContext } from "./types";
export function governanceChanges(ctx: GovernanceContext, dao: string, compareSnapshotId?: string | null): GovernanceChanges {
  const subject = nearSubject(dao), history = historyFacts(loadNearSnapshot(ctx.snapshotId,{root:ctx.root}),subject,ctx.snapshotId);
  const result: GovernanceChanges = {dao,beforeSnapshotId:null,afterSnapshotId:null,changes:[],summary:[],history:history.events.filter(e => e.kind === "membership" || e.kind === "policy"),reasons:[...history.reasons]};
  const live = liveSnapshotIds(ctx.root), pair = compareSnapshotId ? [ctx.snapshotId,compareSnapshotId] : live.length >= 2 ? live.slice(-2) : null;
  if (!pair) { result.reasons.push({code:"missing-coverage",subject,ref:`one-live-snapshot:${ctx.snapshotId}`}); return result; }
  const [before,after] = pair, store = loadNearSnapshots([...new Set(pair)],{root:ctx.root}), a = store.snapshot(before)!, b = store.snapshot(after)!;
  result.beforeSnapshotId=before; result.afterSnapshotId=after;
  const isRole = (s: string) => { const p=parseNearSubject(s); return p?.account === dao && p.kind === "role"; };
  const subjects = [...new Set([subject,...a.subjects.filter(isRole),...b.subjects.filter(isRole)])].sort();
  const predicates = new Set(["council-member","vote-threshold","proposal-period","bond","holds-role"]);
  for (const s of subjects) {
    const q = runQuery(store,{name:"changes",subject:s,beforeSnapshotId:before,afterSnapshotId:after,maxResults:500});
    result.changes.push(...q.changes.filter(c => predicates.has((c.after ?? c.before)!.predicate))); result.reasons.push(...q.reasons);
  }
  const value = (snapshot: EvidenceSnapshot, field: GovernanceChanges["summary"][number]["field"]): string | null => {
    const facts = snapshot.facts.filter(f => f.subject === subject || isRole(f.subject));
    if (field === "council-size") return String(facts.filter(f => f.predicate === "council-member").length);
    const values = facts.filter(f => f.predicate === field).map(f => f.object).sort(); return values.length ? values.join("; ") : null;
  };
  for (const field of ["council-size","vote-threshold","proposal-period","bond"] as const) result.summary.push({field,before:value(a,field),after:value(b,field)});
  return result;
}
