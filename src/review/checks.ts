import type { ProposalBundle } from "../governance/reader";
import type { Effect } from "../governance/effects";
import type { Receipt, Reconciliation } from "../governance/receipt";
import { formatUnits } from "../chain/token-layout";
import type { SimulationRun } from "../governance/simulate";
import type { Coverage } from "../governance/claims";

export type Dimension = "description_matches_effects" | "execution_eligible" | "simulation_result" | "execution_status" | "policy_result";
export type CheckRow = { check: string; result: string; basis: string; needsReview: boolean; flags?: string[] };
export type Dimensions = Record<Dimension, string>;

const short = (address: unknown) => `${String(address).slice(0, 6)}…`;
function reconciliationCounts(reconciliations: Reconciliation[]) {
  return {
    matched: reconciliations.filter((r) => r.status === "matched").length,
    total: reconciliations.filter((r) => r.status !== "not-reconcilable").length,
    notReconcilable: reconciliations.filter((r) => r.status === "not-reconcilable").length,
  };
}

export function dimensions(b: ProposalBundle, effects: Effect[], cov: Coverage[], sims: SimulationRun[], reconciliations: Reconciliation[]): Dimensions {
  const hasPayload = b.transactions.some((t) => t.instructions.length > 0);
  const contradicted = cov.some((c) => c.status === "contradicted"); const omitted = cov.some((c) => c.status === "omitted-from-claims");
  const executed = b.transactions.some((t) => t.executedAt != null);
  const { matched, total, notReconcilable } = reconciliationCounts(reconciliations);
  const observed = reconciliations.some((r) => r.status === "matched" || r.status === "mismatch" || r.status === "not-reconcilable");
  const now = Math.floor(Date.now() / 1000);
  return {
    description_matches_effects: !hasPayload ? "no executable payload: signaling only" : contradicted ? "contradiction: review" : omitted ? "omission: effects not mentioned by captured claims" : cov.some((c) => c.status === "covered" || c.status === "covered-under-assumption") ? "covered (see assumptions)" : "unchecked",
    execution_eligible: !hasPayload ? "not applicable" : executed ? "already executed (historical)" : b.proposal.stateName === "Succeeded" ? `eligible after hold-up ${b.transactions[0]?.holdUpTime ?? "?"} s` : `not eligible: state ${b.proposal.stateName} at ${new Date(now * 1000).toISOString()}`,
    simulation_result: sims.length === 0 ? "not run" : sims.map((s) => `${s.label}: ${s.success ? "success" : "failed"} (conditional preview @${s.contextSlot})`).join("; "),
    execution_status: observed ? (matched === total ? `observed: all token movements match (${matched}/${total})${notReconcilable ? `; ${notReconcilable} executed transactions not reconcilable` : ""}` : `observed: ${matched} of ${total} token movements matched`) : !executed ? "not executed" : "receipt-not-found",
    policy_result: "no policy configured: human review required",
  };
}

export function checks(b: ProposalBundle, effects: Effect[], cov: Coverage[], reconciliations: Reconciliation[], receipts: Receipt[] = []): CheckRow[] {
  const rows: CheckRow[] = [];
  const moves = effects.filter((e) => e.type === "treasuryMovement"); const move = moves[0]; const supply = effects.find((e) => e.type === "supplyChange" || e.type === "mint"); const control = effects.find((e) => e.type === "controlChange"); const unknown = effects.filter((e) => e.type === "unknown");
  const movement = moves.map((move) => {
    const exceedsCapture = move.flags.includes("exceeds-balance-at-capture");
    const d = move.detail;
    const balance = d.sourceBalanceAtCaptureRaw == null ? "unknown" : typeof d.decimals === "number" ? formatUnits(BigInt(String(d.sourceBalanceAtCaptureRaw)), d.decimals) : `${d.sourceBalanceAtCaptureRaw} raw`;
    const share = d.shareOfSourceBalancePreExecution != null
      ? `${d.shareOfSourceBalancePreExecution} of the source balance at execution (slot ${d.preExecutionSlot}, receipt); today's balance ${balance} at slot ${d.captureSlot}`
      : `${d.shareOfSourceBalanceAtCapture} of source balance at slot ${d.captureSlot}`;
    return `${d.amountDisplay} ${String(d.asset).slice(0, 6)}… from ${String(d.source).slice(0, 6)}… (${d.sourceIsGovernanceTreasury ? "governance treasury" : "owner " + String(d.sourceOwner).slice(0, 6) + "…"}) to ${d.destination ?? "burn"}; ${share}${exceedsCapture ? " (historical amount exceeds today's balance)" : ""}${move.flags.includes("destination-empty-before") ? "; destination held 0 before execution" : ""}`;
  }).join("; ") || "none decoded";
  rows.push({ check: "Treasury movement", result: movement, basis: move ? move.basis : "decoded", needsReview: moves.some((m) => m.flags.includes("destination-empty-before") || (m.flags.includes("exceeds-balance-at-capture") && !receipts.some((r) => m.id.startsWith(`fx-${r.txIndex}-`)))) });
  rows.push({ check: "Supply change", result: supply ? `${supply.detail.display} (${supply.detail.shareOfSupplyAtCapture} of supply at slot ${supply.detail.captureSlot})` : "none decoded", basis: supply ? supply.basis : "decoded", needsReview: false });
  rows.push({ check: "Claim coverage", result: cov.length ? cov.map((c) => `${c.claimId ?? "(uncaptured)"}: ${c.status}`).join("; ") : "no claims captured", basis: "claimed vs decoded", needsReview: cov.some((c) => c.status === "contradicted" || c.status === "omitted-from-claims" || c.status === "unchecked") });
  rows.push({ check: "Control change", result: control ? `${control.detail.authorityType} on ${String(control.detail.target).slice(0, 6)}…: ${control.detail.from} → ${control.detail.to}` : "none decoded", basis: "decoded", needsReview: !!control });
  const creations = effects.filter((e) => e.type === "accountCreation");
  rows.push({ check: "Account creation", result: creations.length ? creations.map((e) => `acct ${short(e.detail.account)} (owner ${short(e.detail.owner)}, mint ${short(e.detail.mint)}) [account ${e.detail.account}; owner ${e.detail.owner}; mint ${e.detail.mint}]${e.flags.includes("creates-transfer-destination") ? " — destination of the treasury transfer in this proposal" : ""}`).join("; ") : "none decoded", basis: "decoded", needsReview: creations.some((e) => e.flags.includes("creates-transfer-destination")) });
  rows.push({ check: "Unknown / unsupported", result: unknown.length ? unknown.map((u) => `${String(u.detail.program).slice(0, 8)}…: ${u.detail.reason}`).join("; ") : "none", basis: "unknown", needsReview: unknown.length > 0 });
  rows.push({ check: "Execution conditions", result: `state ${b.proposal.stateName}; hold-up ${b.transactions[0]?.holdUpTime ?? "n/a"} s; voting ${b.governance.baseVotingTime} s + cool-off ${b.governance.votingCoolOffTime} s; council veto path not evaluated in this slice`, basis: "observed", needsReview: false });
  rows.push(voteOutcome(b, effects));
  const { matched, total, notReconcilable } = reconciliationCounts(reconciliations);
  const problems = reconciliations.filter((r) => r.status === "mismatch" || r.status === "receipt-not-found");
  rows.push({ check: "Observed execution", result: `matched ${matched}/${total} token movements${notReconcilable ? `, ${notReconcilable} executed transactions without token movements (unsupported or non-token instructions)` : ""}` + problems.map((r) => `; ${r.proposalTransaction ?? "transaction"}: ${r.status}`).join("") + (!reconciliations.length || reconciliations.every((r) => r.status === "not-executed") ? "; not executed" : ""), basis: "observed", needsReview: problems.length > 0 });
  rows.push({ check: "Economic consequence", result: supply ? "token supply mechanism affected; mSOL backing is a separate relationship and is not affected by an MNDE burn" : move ? "treasury composition changes; downstream dependencies not mapped in this slice" : "none supported", basis: "research assumption", needsReview: true });
  return rows;
}

/** Vote weights are token weights, not voter counts. Keep arithmetic in raw integers. */
export function voteOutcome(b: ProposalBundle, effects: Effect[]): CheckRow {
  const p = b.proposal;
  const winner = p.options.filter((o) => o.voteResult === 1).sort((a, b) => BigInt(a.voteWeightRaw) > BigInt(b.voteWeightRaw) ? -1 : 1)[0];
  const max = p.maxVoteWeightRaw == null ? null : BigInt(p.maxVoteWeightRaw);
  const weight = winner ? BigInt(winner.voteWeightRaw) : null;
  const threshold = p.voteThreshold;
  const decimals = b.mints[p.governingTokenMint]?.decimals;
  const units = (raw: bigint) => decimals == null ? `${raw} raw` : `${formatUnits(raw, decimals)} ${short(p.governingTokenMint)}`;
  const flags: string[] = [];
  const holdUp = b.transactions[0]?.holdUpTime;
  if (holdUp === 0 && effects.some((e) => e.type === "treasuryMovement")) flags.push("no-hold-up");
  let result: string;
  if (threshold?.type === 0 && threshold.value != null && max != null && max > 0n && weight != null) {
    // Round percentages to four places without converting large token weights to Number.
    const fixed4 = (numerator: bigint, denominator: bigint) => {
      const negative = numerator < 0n;
      const abs = negative ? -numerator : numerator;
      const rounded = (abs * 10000n + denominator / 2n) / denominator;
      return `${negative ? "-" : ""}${rounded / 10000n}.${(rounded % 10000n).toString().padStart(4, "0")}`;
    };
    const marginNumerator = weight * 100n - max * BigInt(threshold.value);
    if (marginNumerator * 2n < max) flags.unshift("thin-margin");
    // Show the integer raw-token margin; threshold fractions smaller than one raw unit are truncated.
    const marginRaw = marginNumerator / 100n;
    result = `approve share ${fixed4(weight * 100n, max)}%; threshold ${threshold.value} %; margin ${fixed4(marginNumerator, max)} pp (${units(marginRaw)}); approve ${units(weight)}; max vote weight ${units(max)}`;
  } else {
    result = `winner weight ${weight ?? "unknown"} raw; option weights ${p.options.map((o) => `${o.label}: ${o.voteWeightRaw}`).join(", ")}; max vote weight ${p.maxVoteWeightRaw ?? "unknown"} raw; threshold type ${threshold?.type ?? "unknown"}, value ${threshold?.value ?? "unknown"}; ${threshold?.type !== 0 ? "threshold type not supported" : "vote outcome unavailable (missing winner, maximum or threshold)"}`;
  }
  result += `; deny ${p.denyVoteWeightRaw == null ? "unknown" : units(BigInt(p.denyVoteWeightRaw))}; execution delay ${p.executionDelaySeconds ?? "unknown"} s; hold-up ${holdUp ?? "n/a"} s`;
  const executionOffsets = p.votingCompletedAt == null ? [] : b.transactions.flatMap((t) => t.executedAt == null ? [] : [t.executedAt - p.votingCompletedAt!]);
  if (executionOffsets.length) result += `; execution began ${Math.min(...executionOffsets)} s after voting completed, last transaction at ${Math.max(...executionOffsets)} s`;
  if (flags.length) result += `; ${flags.join(", ")}`;
  result += "; voter count and concentration not analysed (vote records not read)";
  return { check: "Vote outcome", result, basis: "observed", needsReview: flags.length > 0, flags };
}
