import type { KaminoReport, NamedQuantity, ClaimView } from "../../adapters/kamino/index";
import type { Fact } from "../../engine/index";
import { sortedUnique, type ExitItem } from "../../policy/index";
export interface EconomicsView {
  yieldSource: { kind: "lending-reserve-allocation"; allocations: NamedQuantity[]; rewards: NamedQuantity[] };
  rates: NamedQuantity[]; idle: NamedQuantity[]; liquidity: NamedQuantity[]; withdrawalConstraints: NamedQuantity[];
  utilization: { label: "utilization: borrowed share of reserve supply; not exit liquidity"; items: NamedQuantity[] };
  queue: { status: "not-captured" }; missing: string[]; notComputed: string[]; claims: ClaimView[];
  valuation: { value: null; reason: "missing-price" };
}
export function economicsFor(report: KaminoReport | undefined | null, subject: string): EconomicsView | null {
  if (!report || report.vault !== subject) return null;
  const quantities = structuredClone(report.quantities);
  const named = (...names: string[]) => quantities.filter(q => names.includes(q.name));
  const reserves = (suffix: string) => quantities.filter(q => q.name.startsWith("reserve.") && q.name.endsWith(`.${suffix}`));
  return {
    yieldSource: { kind: "lending-reserve-allocation", allocations: reserves("vaultAllocationPpm"), rewards: named("vault.reported.apyFarmRewards") },
    rates: quantities.filter(q => q.name.startsWith("vault.reported.") || ["vault.performanceFeeBps", "vault.managementFeeBps"].includes(q.name)),
    idle: named("vault.tokenAvailable", "vault.idleSharePpm"), liquidity: reserves("available"),
    withdrawalConstraints: [...reserves("withdrawalCapCapacity"), ...named("vault.minWithdrawAmount", "vault.withdrawalPenaltyBps", "vault.withdrawalPenaltyLamports")],
    utilization: { label: "utilization: borrowed share of reserve supply; not exit liquidity", items: reserves("utilizationPpm") },
    queue: { status: "not-captured" }, missing: sortedUnique([...report.missing, ...report.notCaptured, "withdrawal-queue"]),
    notComputed: [...report.notComputed], claims: structuredClone(report.claims), valuation: { value: null, reason: "missing-price" },
  };
}
export function economicsQuantities(view: EconomicsView): NamedQuantity[] {
  return [...view.yieldSource.allocations, ...view.yieldSource.rewards, ...view.rates, ...view.idle, ...view.liquidity, ...view.withdrawalConstraints, ...view.utilization.items];
}
export function economicsReceiptIds(view: EconomicsView): string[] {
  return sortedUnique([...economicsQuantities(view).flatMap(q => q.evidenceIds),
    ...view.claims.flatMap(c => [...c.claimEvidenceIds, ...c.observationEvidenceIds])]);
}
export function exitItemsFor(economics: EconomicsView | null, stateFacts: Fact[]): ExitItem[] {
  if (!economics) return [];
  const items = (quantities: NamedQuantity[], role: ExitItem["role"], predicate?: string): ExitItem[] => quantities.map(q => ({
    role, subject: q.subject, name: q.name,
    factIds: predicate ? stateFacts.filter(f => f.subject === q.subject && f.predicate === predicate && f.object === `amount:${q.value}`).map(f => f.id).sort() : [],
    receiptIds: sortedUnique(q.evidenceIds),
  }));
  return [...items(economics.idle.filter(q => q.name === "vault.tokenAvailable"), "idle", "IDLE_RAW"),
    ...items(economics.liquidity, "available-liquidity", "AVAILABLE_LIQUIDITY_RAW"),
    ...items(economics.withdrawalConstraints, "withdrawal-constraint"), ...items(economics.utilization.items, "utilization")];
}
