import type { ProposalBundle } from "../governance/reader";
import type { Effect } from "../governance/effects";
import type { Receipt, Reconciliation } from "../governance/receipt";
import { formatUnits } from "../chain/token-layout";
import type { SimulationRun } from "../governance/simulate";
import type { Coverage } from "../governance/claims";

export type Dimension = "description_matches_effects" | "execution_eligible" | "simulation_result" | "execution_status" | "policy_result";
export type CheckRow = { check: string; result: string; basis: string; needsReview: boolean };
export type Dimensions = Record<Dimension, string>;

export function dimensions(b: ProposalBundle, effects: Effect[], cov: Coverage[], sims: SimulationRun[], rec: Reconciliation): Dimensions {
  const hasPayload = b.transactions.some((t) => t.instructions.length > 0);
  const contradicted = cov.some((c) => c.status === "contradicted"); const omitted = cov.some((c) => c.status === "omitted-from-claims");
  const executed = b.transactions.some((t) => t.executedAt != null);
  const now = Math.floor(Date.now() / 1000);
  return {
    description_matches_effects: !hasPayload ? "no executable payload: signaling only" : contradicted ? "contradiction: review" : omitted ? "omission: effects not mentioned by captured claims" : cov.some((c) => c.status === "covered" || c.status === "covered-under-assumption") ? "covered (see assumptions)" : "unchecked",
    execution_eligible: !hasPayload ? "not applicable" : executed ? "already executed (historical)" : b.proposal.stateName === "Succeeded" ? `eligible after hold-up ${b.transactions[0]?.holdUpTime ?? "?"} s` : `not eligible: state ${b.proposal.stateName} at ${new Date(now * 1000).toISOString()}`,
    simulation_result: sims.length === 0 ? "not run" : sims.map((s) => `${s.kind}: ${s.success ? "success" : "failed"} (conditional preview @${s.contextSlot})`).join("; "),
    execution_status: rec.status === "matched" ? "observed: receipt matches decoded effect" : rec.status === "not-executed" ? "not executed" : rec.status,
    policy_result: "no policy configured: human review required",
  };
}

export function checks(b: ProposalBundle, effects: Effect[], cov: Coverage[], rec: Reconciliation, receipt: Receipt | null = null): CheckRow[] {
  const rows: CheckRow[] = [];
  const move = effects.find((e) => e.type === "treasuryMovement"); const supply = effects.find((e) => e.type === "supplyChange" || e.type === "mint"); const control = effects.find((e) => e.type === "controlChange"); const unknown = effects.filter((e) => e.type === "unknown");
  const exceedsCapture = move?.flags.includes("exceeds-balance-at-capture") ?? false;
  let movement = "none decoded";
  if (move) {
    const d = move.detail;
    const balance = d.sourceBalanceAtCaptureRaw == null ? "unknown" : typeof d.decimals === "number" ? formatUnits(BigInt(String(d.sourceBalanceAtCaptureRaw)), d.decimals) : `${d.sourceBalanceAtCaptureRaw} raw`;
    const share = d.shareOfSourceBalancePreExecution != null
      ? `${d.shareOfSourceBalancePreExecution} of the source balance at execution (slot ${d.preExecutionSlot}, receipt); today's balance ${balance} at slot ${d.captureSlot}`
      : `${d.shareOfSourceBalanceAtCapture} of source balance at slot ${d.captureSlot}`;
    movement = `${d.amountDisplay} ${String(d.asset).slice(0, 6)}… from ${String(d.source).slice(0, 6)}… (${d.sourceIsGovernanceTreasury ? "governance treasury" : "owner " + String(d.sourceOwner).slice(0, 6) + "…"}) to ${d.destination ?? "burn"}; ${share}${exceedsCapture ? " (historical amount exceeds today's balance)" : ""}`;
  }
  rows.push({ check: "Treasury movement", result: movement, basis: move ? move.basis : "decoded", needsReview: !receipt && exceedsCapture });
  rows.push({ check: "Supply change", result: supply ? `${supply.detail.display} (${supply.detail.shareOfSupplyAtCapture} of supply at slot ${supply.detail.captureSlot})` : "none decoded", basis: supply ? supply.basis : "decoded", needsReview: false });
  rows.push({ check: "Claim coverage", result: cov.length ? cov.map((c) => `${c.claimId ?? "(uncaptured)"}: ${c.status}`).join("; ") : "no claims captured", basis: "claimed vs decoded", needsReview: cov.some((c) => c.status === "contradicted" || c.status === "omitted-from-claims" || c.status === "unchecked") });
  rows.push({ check: "Control change", result: control ? `${control.detail.authorityType} on ${String(control.detail.target).slice(0, 6)}…: ${control.detail.from} → ${control.detail.to}` : "none decoded", basis: "decoded", needsReview: !!control });
  rows.push({ check: "Unknown / unsupported", result: unknown.length ? unknown.map((u) => `${String(u.detail.program).slice(0, 8)}…: ${u.detail.reason}`).join("; ") : "none", basis: "unknown", needsReview: unknown.length > 0 });
  rows.push({ check: "Execution conditions", result: `state ${b.proposal.stateName}; hold-up ${b.transactions[0]?.holdUpTime ?? "n/a"} s; voting ${b.governance.baseVotingTime} s + cool-off ${b.governance.votingCoolOffTime} s; council veto path not evaluated in this slice`, basis: "observed", needsReview: false });
  rows.push({ check: "Observed execution", result: rec.status === "matched" ? `matched: ${rec.observedDeltaRaw} raw on ${String(rec.account).slice(0, 6)}…` : rec.status, basis: "observed", needsReview: rec.status === "mismatch" });
  rows.push({ check: "Economic consequence", result: supply ? "token supply mechanism affected; mSOL backing is a separate relationship and is not affected by an MNDE burn" : move ? "treasury composition changes; downstream dependencies not mapped in this slice" : "none supported", basis: "research assumption", needsReview: true });
  return rows;
}
