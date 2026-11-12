import { isTime, type EvidenceReceipt, type EvidenceSnapshot, type PrivatePosition } from "../../engine/index";
import { createGenericRegistry, evaluatePolicy, parsePolicy, sortedUnique, sortReasons, type Policy, type PolicyVerdict } from "../../policy/index";
import { parseBook, PositionRejected, selectBook } from "./book";
import { queryChains, chainFacts, engineAccess, solanaRoleOf, uniqueById, type EngineOptions, type RunRecord } from "./chain";
import { economicsReceiptIds, exitItemsFor } from "./economics";
import type { PositionEvidence } from "./evidence";
import { joinPositions, type JoinedPosition, type PositionTotals } from "./join";
export const PRIVATE_EXPORT_LABEL = "PRIVATE LOCAL EXPORT: contains position data; keep local, do not commit or publish";
export type SnapshotObservation = Pick<EvidenceSnapshot, "id" | "constructed" | "observedFrom" | "observedTo" | "fromBlockOrSlot" | "toBlockOrSlot">;
export function snapshotObservation(snapshot: EvidenceSnapshot): SnapshotObservation {
  const { id, constructed, observedFrom, observedTo, fromBlockOrSlot, toBlockOrSlot } = snapshot;
  return { id, constructed, observedFrom, observedTo, fromBlockOrSlot, toBlockOrSlot };
}
export interface PositionReport {
  version: 1; privacy: "private"; label: string; snapshot: SnapshotObservation; asOf: string;
  positions: JoinedPosition[]; totals: PositionTotals; verdict: PolicyVerdict | null;
  publicSubjects: string[]; runs: RunRecord[]; economicsReceipts: EvidenceReceipt[];
}
export interface ReviewPositionsInput {
  evidence: PositionEvidence; book: readonly PrivatePosition[]; bookSnapshotId?: string; snapshotId?: string; asOf?: string;
  policy: Policy | null; engine?: EngineOptions;
}
export async function reviewPositions(input: ReviewPositionsInput): Promise<PositionReport> {
  const { evidence } = input;
  const snapshot = evidence.store.snapshot(input.snapshotId ?? evidence.snapshots.at(-1)?.id ?? "");
  if (!snapshot) throw new PositionRejected("snapshot-not-found");
  const asOf = input.asOf ?? new Date().toISOString();
  if (!isTime(asOf)) throw new PositionRejected("malformed-time", 0, "asOf");
  const book = selectBook(parseBook(input.book), input.bookSnapshotId);
  const registry = createGenericRegistry(), policy = input.policy === null ? null : parsePolicy(input.policy, registry);
  const roots = sortedUnique(book.filter(p => snapshot.subjects.includes(p.subject)).map(p => p.subject));
  const engine = engineAccess(evidence.store, input.engine);
  const { chains, runs } = await queryChains(engine, roots, snapshot.id, asOf);
  // Private values are first joined after every public executor run has returned.
  const joined = joinPositions(book, evidence, snapshot.id, chains);
  const economicsReceipts: EvidenceReceipt[] = [];
  for (const p of joined.positions) {
    p.inScope = policy === null || policy.subjects.includes(p.position.subject);
    if (!p.economics || !p.chain) continue;
    for (const id of economicsReceiptIds(p.economics)) {
      const receipt = evidence.store.receipt(id);
      if (receipt) economicsReceipts.push(receipt);
      else p.chain.reasons = sortReasons([...p.chain.reasons, { code: "missing-evidence", subject: p.position.subject, ref: id }]);
    }
  }
  const verdict = policy === null ? null : evaluatePolicy(policy, evidence.store, {
    evaluatedAt: asOf, snapshotId: snapshot.id, registry, roleOf: solanaRoleOf, price: () => null,
    positions: joined.positions.map(p => ({ positionRef: p.position.id, subject: p.position.subject, quantity: p.position.quantity,
      unit: p.position.unit, inScope: p.inScope, chain: p.chain ? { snapshotId: snapshot.id, facts: chainFacts(p.chain), reasons: p.chain.reasons,
        exit: exitItemsFor(p.economics, p.chain.stateFacts) } : null })),
  });
  return { version: 1, privacy: "private", label: PRIVATE_EXPORT_LABEL, snapshot: snapshotObservation(snapshot), asOf,
    ...joined, verdict, publicSubjects: sortedUnique(evidence.snapshots.flatMap(s => s.subjects)), runs, economicsReceipts: uniqueById(economicsReceipts) };
}
