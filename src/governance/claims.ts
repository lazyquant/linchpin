import { readFileSync } from "node:fs";
import { formatUnits } from "../chain/token-layout";
import type { Effect } from "./effects";

export type Claim = { id: string; text: string; source: string; sourceRef: string; retrievedAt: string; kind: "percentOfSupply" | "amount" | "range" | "text"; percent?: number; amountDisplay?: string };
export type CaseFile = { caseId: string; title: string; programId: string; programVersion: number; proposal: string; relatedProposals?: { role: string; address: string }[]; claims: Claim[]; fixture: { oneToken?: boolean; burnOneToken?: boolean }; notes?: string[]; claimedPreSupply?: { display: string; raw: string; sourceClaimId: string } };
export type Coverage = { claimId: string | null; effectId: string | null; status: "covered" | "covered-under-assumption" | "contradicted" | "no-executable-effect" | "omitted-from-claims" | "unchecked"; note: string };

export const loadCase = (path: string): CaseFile => JSON.parse(readFileSync(path, "utf8"));

export function coverage(claims: Claim[], effects: Effect[], ctx: { decimals: number; claimedPreSupplyRaw: bigint | null }): Coverage[] {
  const out: Coverage[] = [];
  const movements = effects.filter((e) => e.type === "supplyChange" || e.type === "treasuryMovement" || e.type === "mint");
  for (const c of claims) {
    if (movements.length === 0) { out.push({ claimId: c.id, effectId: null, status: "no-executable-effect", note: "the proposal carries no decoded token effect; the claim is signaling only" }); continue; }
    const e = movements[0]; const amount = BigInt(String(e.detail.deltaRaw ?? e.detail.amountRaw)); const abs = amount < 0n ? -amount : amount;
    if (c.kind === "percentOfSupply" && c.percent != null) {
      if (ctx.claimedPreSupplyRaw) {
        const impliedPct = Number((abs * 1_000_000n) / ctx.claimedPreSupplyRaw) / 10_000;
        const ok = Math.abs(impliedPct - c.percent) < 0.01;
        out.push({ claimId: c.id, effectId: e.id, status: ok ? "covered-under-assumption" : "contradicted", note: `${formatUnits(abs, ctx.decimals)} is ${impliedPct.toFixed(2)}% of the claimed pre-burn supply ${formatUnits(ctx.claimedPreSupplyRaw, ctx.decimals)} (supply claim unverified); on-chain pre-execution supply not captured` });
      } else out.push({ claimId: c.id, effectId: e.id, status: "unchecked", note: "percentage claims need a pre-execution supply; none captured or claimed" });
      continue;
    }
    if (c.kind === "amount" && c.amountDisplay) {
      const digits = c.amountDisplay.replace(/[^0-9]/g, "");
      const ok = digits.length > 0 && formatUnits(abs, ctx.decimals).replace(/[^0-9]/g, "").startsWith(digits);
      out.push({ claimId: c.id, effectId: e.id, status: ok ? "covered" : "contradicted", note: ok ? `decoded amount ${formatUnits(abs, ctx.decimals)} matches the stated amount` : `decoded amount ${formatUnits(abs, ctx.decimals)} differs from the stated ${c.amountDisplay}` });
      continue;
    }
    out.push({ claimId: c.id, effectId: e.id, status: "unchecked", note: "free-text or range claim; shown for the reviewer, not machine-checked" });
  }
  const instructionKey = (id: string) => id.replace(/-(supply|move)$/, "");
  const claimedEffectIds = new Set(out.flatMap((o) => o.effectId ? [instructionKey(o.effectId)] : []));
  for (const e of movements) if (!claimedEffectIds.has(instructionKey(e.id))) out.push({ claimId: null, effectId: e.id, status: "omitted-from-claims", note: "decoded effect not mentioned by any captured claim; review, do not assume intent" });
  return out;
}
