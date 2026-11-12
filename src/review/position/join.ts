import type { PrivatePosition } from "../../engine/index";
import { addDecimals, cmp } from "../../policy/index";
import type { PositionEvidence } from "./evidence";
import type { ChainReview } from "./chain";
import { economicsFor, type EconomicsView } from "./economics";
import { PositionRejected } from "./book";
export interface JoinedPosition {
  position: PrivatePosition; inScope: boolean; coverage: "covered" | "unknown";
  coverageReason: null | "chain-not-supported" | "subject-not-in-snapshot";
  chain: ChainReview | null; economics: EconomicsView | null; economicsReason: null | "no-economics-source";
}
export interface PositionTotals {
  positions: number; covered: number; unknownCoverage: number;
  byUnit: { unit: string; total: string; covered: string; unknownCoverage: string }[];
}
export function joinPositions(positions: readonly PrivatePosition[], evidence: PositionEvidence, snapshotId: string, chains: Map<string, ChainReview>): { positions: JoinedPosition[]; totals: PositionTotals } {
  const snapshot = evidence.store.snapshot(snapshotId);
  if (!snapshot) throw new PositionRejected("snapshot-not-found");
  const joined: JoinedPosition[] = positions.map(position => {
    const covered = snapshot.subjects.includes(position.subject);
    const economics = covered ? economicsFor(evidence.reports.get(snapshotId), position.subject) : null;
    return { position: structuredClone(position), inScope: true, coverage: covered ? "covered" : "unknown",
      coverageReason: covered ? null : position.subject.startsWith(`${snapshot.chain}:`) ? "subject-not-in-snapshot" : "chain-not-supported",
      chain: covered ? chains.get(position.subject) ?? null : null, economics, economicsReason: economics ? null : "no-economics-source" };
  });
  const units = new Map<string, PositionTotals["byUnit"][number]>();
  for (const p of joined) {
    const row = units.get(p.position.unit) ?? { unit: p.position.unit, total: "0", covered: "0", unknownCoverage: "0" };
    row.total = addDecimals(row.total, p.position.quantity);
    const key = p.coverage === "covered" ? "covered" : "unknownCoverage";
    row[key] = addDecimals(row[key], p.position.quantity); units.set(row.unit, row);
  }
  const covered = joined.filter(p => p.coverage === "covered").length;
  return { positions: joined, totals: { positions: joined.length, covered, unknownCoverage: joined.length - covered, byUnit: [...units.values()].sort((a, b) => cmp(a.unit, b.unit)) } };
}
