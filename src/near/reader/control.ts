import { canonical } from "../../chain/evidence";
import type { QueryReason, QueryResult } from "../../engine/contracts";
import { runQuery } from "../../engine/queries/run";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import { parseNearSubject } from "./types";
export interface NearControlSurface {
  subject: string; snapshotId: string; results: QueryResult[];
  fullAccessKeys: string[]; functionCallKeys: number; superAdmins: string[]; upgradedBy: string[];
  roles: Record<string, string[]>; councilMembers: string[]; voteThresholds: string[]; paused: string[]; pauseOperator: string | null; contractMode: string | null;
  factIds: string[]; receiptIds: string[]; reasons: QueryReason[];
}
export function controlSurface(store: EvidenceStore, snapshotId: string, subject: string, asOf: string, maxResults = 500): NearControlSurface {
  const scope = { asOf, snapshotId, maxHops: 1, maxResults };
  const root = runQuery(store, { name: "control", subject, scope });
  const nodes = [...new Set(root.facts.filter(f => f.predicate === "holds-role" && ["role", "role-admin"].includes(parseNearSubject(f.object)?.kind ?? "")).map(f => f.object))].sort();
  const results = [root, ...nodes.map(node => runQuery(store, { name: "control", subject: node, scope }))];
  const facts = results.flatMap(r => r.facts);
  const unique = (values: string[]) => [...new Set(values)].sort();
  const values = (predicate: string, all = false) => unique((all ? facts : root.facts).filter(f => f.predicate === predicate).map(f => f.object));
  const roles: Record<string, string[]> = {};
  for (const node of nodes) {
    const parsed = parseNearSubject(node)!;
    const name = parsed.kind === "role-admin" ? `role-admin:${parsed.key}` : parsed.key!;
    roles[name] = unique(facts.filter(f => f.subject === node && f.predicate === "holds-role" && f.object !== "none").map(f => f.object));
  }
  return { subject, snapshotId, results, fullAccessKeys: values("has-full-access-key").filter(v => v !== "none"), functionCallKeys: values("has-function-call-key").length,
    superAdmins: values("super-admin-of"), upgradedBy: values("upgraded-by"), roles, councilMembers: values("council-member"), voteThresholds: values("vote-threshold", true), paused: values("paused"), pauseOperator: values("pause-operator")[0] ?? null, contractMode: values("contract-mode")[0] ?? null,
    factIds: unique(facts.map(f => f.id)), receiptIds: unique(results.flatMap(r => r.receipts.map(e => e.id))), reasons: [...new Map(results.flatMap(r => r.reasons).map(r => [canonical(r), r])).values()] };
}
