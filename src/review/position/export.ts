import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Fact } from "../../engine/index";
import { projectVerdict, cmp } from "../../policy/index";
import { insidePath, nearestRepository, PositionRejected, resolvedLocalPath } from "./book";
import { uniqueById, type RunRecord } from "./chain";
import { PRIVATE_EXPORT_LABEL, type PositionReport } from "./review";
import type { WatchReport, DependencyChanged } from "./watch";
export function publicRuns(runs: readonly RunRecord[]) {
  return runs.map(r => ({ round: r.round, planSha256: r.planSha256, blueprintId: r.blueprintId,
    blueprintSha256: r.blueprintSha256, registrySha256: r.registrySha256, claims: structuredClone(r.claims) }));
}
export function toPublicReview(report: PositionReport) {
  const covered = report.positions.filter(p => p.coverage === "covered" && p.chain !== null);
  const subjects = [...new Map(covered.map(p => [p.position.subject, p])).values()].sort((a, b) => cmp(a.position.subject, b.position.subject)).map(p => {
    const chain = p.chain!;
    const economics = p.economics === null ? null : (({ valuation: _valuation, ...view }) => view)(p.economics);
    // A private receipt, a private fact and a fact resting on a private receipt all stay out of the public export.
    const receipts = uniqueById([...chain.receipts, ...report.economicsReceipts]);
    const hidden = new Set(receipts.filter(r => r.privacy !== "public").map(r => r.id));
    const open = (facts: readonly Fact[]) => facts.filter(f => f.privacy === "public" && !f.evidenceIds.some(id => hidden.has(id)));
    return { subject: p.position.subject, dependencyFacts: open(chain.dependencyFacts), controlFacts: open(chain.controlFacts), stateFacts: open(chain.stateFacts),
      reasons: chain.reasons.filter(r => r.subject === null || report.publicSubjects.includes(r.subject)),
      receipts: receipts.filter(r => !hidden.has(r.id)),
      queries: chain.entries.map(e => ({ request: e.request, resultSha256: e.resultSha256 })), economics };
  });
  return structuredClone({ version: 1 as const, privacy: "public" as const,
    label: "public export: no position quantities, units, identifiers or private subjects",
    snapshot: report.snapshot, asOf: report.asOf, subjects,
    verdict: report.verdict === null ? null : projectVerdict(report.verdict, report.publicSubjects), runs: publicRuns(report.runs) });
}
export type PublicPositionReport = ReturnType<typeof toPublicReview>;
export function toPublicWatch(watch: WatchReport) {
  const events = [...new Map(watch.events.filter((e): e is DependencyChanged => e.kind === "dependency-changed").map(e => [e.subject, e])).values()]
    .sort((a, b) => cmp(a.subject, b.subject)).map(({ positionId: _positionId, ...event }) => event);
  return structuredClone({ version: 1 as const, privacy: "public" as const, label: "public dependency changes", events, runs: publicRuns(watch.runs) });
}
export type PublicWatchReport = ReturnType<typeof toPublicWatch>;
export function checkPrivateExportPath(path: string): string {
  const destination = resolvedLocalPath(path), root = nearestRepository(destination);
  if (root && !insidePath(destination, join(root, ".private"))) throw new PositionRejected("private-export-in-repository");
  return destination;
}
/** Run identifiers are execution metadata, not part of either export format. */
export function exportJson(value: unknown): string {
  return JSON.stringify(value, (key, value) => key === "runId" ? undefined : value, 2) + "\n";
}
export function writePrivateExport(path: string, value: object): void {
  const destination = checkPrivateExportPath(path);
  const json = exportJson({ ...value, privacy: "private", label: PRIVATE_EXPORT_LABEL });
  try {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, json, { mode: 0o600 });
    chmodSync(destination, 0o600);
  } catch { throw new PositionRejected("private-export-write-failed"); }
}
