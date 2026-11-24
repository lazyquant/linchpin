import { canonical } from "../../chain/evidence";
import type { FactChange, QueryReason, QueryRequest, QueryResult } from "../../engine/contracts";
import { runQuery } from "../../engine/queries/run";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import { parseNearSubject, requestSha256 } from "./types";
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
/** Receipt id of a final call_function read with JSON args, as capture records it. */
export function nearCallReceiptId(snapshotId: string, account: string, method: string, args: unknown = {}): string {
  return `nr:${snapshotId}:${requestSha256({ method: "query", params: { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(canonical(args)).toString("base64"), finality: "final" } }).slice(0, 40)}`;
}
/**
 * An upgraded-by fact read from get_factory_info has no counterpart in a snapshot that never read
 * get_factory_info (every snapshot before 2026-11-14). The difference is a coverage gap, not a change.
 */
export function factoryInfoCoverageGap(store: EvidenceStore, change: FactChange, beforeSnapshotId: string, afterSnapshotId: string): boolean {
  if (change.kind === "changed") return false;
  const [fact, source, missing] = change.kind === "added" ? [change.after, afterSnapshotId, beforeSnapshotId] : [change.before, beforeSnapshotId, afterSnapshotId];
  const account = fact?.predicate === "upgraded-by" ? parseNearSubject(fact.subject)?.account : undefined;
  if (!fact || !account) return false;
  return fact.evidenceIds.includes(nearCallReceiptId(source, account, "get_factory_info")) && !store.receipt(nearCallReceiptId(missing, account, "get_factory_info"));
}
type ChangesRequest = Extract<QueryRequest, { name: "changes" }>;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/**
 * Splits a changes answer into the changes it may report and the get_factory_info coverage gaps it may not:
 * an added (removed) upgraded-by edge whose earlier (later) capture never read get_factory_info is reported
 * as missing-coverage get_factory_info:<that capture>, never as an added (removed) authority.
 */
export function factoryCoverageSplit(store: EvidenceStore, request: Pick<ChangesRequest, "subject" | "beforeSnapshotId" | "afterSnapshotId">, changes: FactChange[]): { changes: FactChange[]; reasons: QueryReason[] } {
  const kept: FactChange[] = [], reasons: QueryReason[] = [];
  for (const c of changes) {
    if (factoryInfoCoverageGap(store, c, request.beforeSnapshotId, request.afterSnapshotId)) reasons.push({ code: "missing-coverage", subject: request.subject, ref: `get_factory_info:${c.kind === "added" ? request.beforeSnapshotId : request.afterSnapshotId}` });
    else kept.push(c);
  }
  return { changes: kept, reasons };
}
/** The NEAR changes answer: the engine's changes query with the get_factory_info coverage rule applied. Every NEAR consumer of a snapshot comparison reads this. */
export function withFactoryCoverage(store: EvidenceStore, request: ChangesRequest, result: QueryResult): QueryResult {
  const split = factoryCoverageSplit(store, request, result.changes);
  if (!split.reasons.length) return result;
  const reasons = [...new Map([...result.reasons, ...split.reasons].map(r => [canonical(r), r])).values()].sort((a, b) => order(a.code, b.code) || order(a.subject ?? "", b.subject ?? "") || order(a.ref ?? "", b.ref ?? ""));
  return { ...result, changes: split.changes, reasons, unknowns: [...new Set([...result.unknowns, request.subject])].sort(order), outcome: result.outcome === "complete" ? "partial" : result.outcome };
}
export function nearChanges(store: EvidenceStore, request: ChangesRequest): QueryResult {
  return withFactoryCoverage(store, request, runQuery(store, request));
}
