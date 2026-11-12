import type { EvidenceReceipt, PrivatePosition } from "../../engine/index";
import { projectVerdict, sortedUnique, type Policy } from "../../policy/index";
import { engineAccess, uniqueById, type EngineOptions } from "./chain";
import { loadKaminoEvidence } from "./evidence";
import { toPublicReview, toPublicWatch } from "./export";
import { reviewPositions, snapshotObservation, type SnapshotObservation } from "./review";
import { watchPositions } from "./watch";
const VAULT = "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
const FIRST_CAPTURE = "solana-mainnet-beta.kamino.sentora-pyusd-20261109T163416Z";
export const DEMO_BOOK: PrivatePosition[] = [{ id: "demo-sentora-pyusd-1", subject: VAULT, quantity: "1250.000000",
  unit: "solana:mainnet-beta:DCqyVY1SFCwq8unnexv9pjujVAC7jsmjfoUWBrNLvbY", snapshotId: "demo-book-1", source: "manual", fixtureKind: "synthetic" }];
export const DEMO_POLICY: Policy = { policyId: "demo-solana-v1", subjects: [VAULT], rules: [
  { id: "one-oracle-cap", kind: "max-share-behind", params: { kind: "oracle-source", maxPercent: 50, basis: "count" } },
  { id: "value-cap", kind: "max-share-behind", params: { kind: "controller", maxPercent: 50, basis: "value" } },
  { id: "exit-evidence", kind: "min-exit-evidence", params: { maxAgeDays: 7 } },
  { id: "fresh-evidence", kind: "max-evidence-age", params: { days: 7 } },
  { id: "vault-admin-resolved", kind: "controller-resolved", params: { account: VAULT } },
  { id: "admin-controller-resolved", kind: "controller-resolved", params: { account: "solana:mainnet-beta:7fLxEftpppneavpueYgP2s7HhSGbWpj2jTCmAEwwqonY" } },
  { id: "admin-unchanged", kind: "unchanged-since", params: { snapshotId: FIRST_CAPTURE, factKeys: [`${VAULT}|VAULT_ADMIN`] } },
] };
export async function runDemo(root = "fixtures/kamino", options: EngineOptions = {}) {
  const evidence = loadKaminoEvidence(root), before = evidence.snapshots[0], after = evidence.snapshots.at(-1);
  if (!before || !after) throw new Error("demo-evidence-missing");
  const access = engineAccess(evidence.store, options), engine = { execute: access.execute, trace: access.trace };
  const review = await reviewPositions({ evidence, book: DEMO_BOOK, bookSnapshotId: "demo-book-1", snapshotId: after.id, asOf: after.observedTo, policy: DEMO_POLICY, engine });
  const dependencyChange = await watchPositions({ evidence, book: DEMO_BOOK, bookBefore: "demo-book-1", bookAfter: "demo-book-1", before: before.id, after: after.id, engine });
  const unchanged = await watchPositions({ evidence, book: DEMO_BOOK, bookBefore: "demo-book-1", bookAfter: "demo-book-1", before: after.id, after: after.id, engine });
  const projected = projectVerdict(review.verdict!, review.publicSubjects);
  const missingData = { constructed: after.constructed, observations: [snapshotObservation(after)], runs: [],
    rules: projected.rules.filter(r => r.outcome === "undetermined"),
    unknownControllers: sortedUnique(review.positions.flatMap(p => p.chain?.reasons.filter(r => r.code === "unknown-controller").flatMap(r => r.subject === null ? [] : [r.subject]) ?? [])),
    missing: sortedUnique(review.positions.flatMap(p => p.economics?.missing ?? [])), valuation: { value: null, reason: "missing-price", label: "unknown (missing price)" } };
  const observations: SnapshotObservation[] = [snapshotObservation(before), snapshotObservation(after)];
  const receipts: EvidenceReceipt[] = uniqueById(evidence.snapshots.flatMap(s => s.receipts));
  return { review, dependencyChange, unchanged, missingData, observations, receipts };
}
export type DemoReport = Awaited<ReturnType<typeof runDemo>>;
export function toPublicDemo(demo: DemoReport) {
  const after = demo.review.snapshot;
  return { version: 1 as const, privacy: "public" as const, label: "synthetic one-position demonstration with recorded public evidence",
    scenarios: [
      { name: "review", constructed: after.constructed, observations: [after], ...toPublicReview(demo.review) },
      { name: "dependency-change", constructed: demo.observations.some(s => s.constructed), observations: demo.observations, ...toPublicWatch(demo.dependencyChange) },
      { name: "unchanged", constructed: after.constructed, observations: [after], ...toPublicWatch(demo.unchanged) },
      { name: "missing-data", ...demo.missingData },
    ], receipts: demo.receipts };
}
