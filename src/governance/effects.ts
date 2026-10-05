import { formatUnits } from "../chain/token-layout";
import type { Decoded } from "./decode";
import type { ProposalBundle } from "./reader";

export type Basis = "claimed" | "decoded" | "simulated" | "observed" | "unknown";
export type Effect = { id: string; type: "supplyChange" | "treasuryMovement" | "controlChange" | "mint" | "unknown"; basis: Basis; detail: Record<string, unknown>; flags: string[]; evidenceIds: string[] };

const pct = (num: bigint, den: bigint) => den === 0n ? "n/a" : `${(Number((num * 1_000_000n) / den) / 10_000).toFixed(4)}%`;

export function effectsFromDecoded(decoded: Decoded[], state: Pick<ProposalBundle, "tokenAccounts" | "mints">, ctx: { nativeTreasury: string }): Effect[] {
  const out: Effect[] = [];
  decoded.forEach((d, i) => {
    const id = `fx-${i}`;
    if (d.kind === "unsupported") { out.push({ id, type: "unknown", basis: "unknown", detail: { program: d.program, reason: d.reason, dataHex: d.dataHex }, flags: ["unsupported-instruction"], evidenceIds: [] }); return; }
    if (d.kind === "setAuthority") { out.push({ id, type: "controlChange", basis: "decoded", detail: { target: d.target, authorityType: d.authorityType, from: d.currentAuthority, to: d.newAuthority }, flags: ["control-change"], evidenceIds: [] }); return; }
    const mintAddr = d.kind === "transfer" ? (d.mint ?? state.tokenAccounts[d.source]?.mint ?? null) : d.mint;
    const mint = mintAddr ? state.mints[mintAddr] : undefined;
    const decimals = d.decimals ?? mint?.decimals ?? null;
    const display = decimals == null ? `${d.amountRaw} raw (decimals unknown)` : formatUnits(d.amountRaw, decimals);
    const evidenceIds = [mint?.evidenceId, d.kind === "mintTo" ? undefined : state.tokenAccounts[d.source]?.evidenceId].filter(Boolean) as string[];
    if (d.kind === "burn" || d.kind === "mintTo") {
      const delta = d.kind === "burn" ? -d.amountRaw : d.amountRaw;
      out.push({ id: `${id}-supply`, type: d.kind === "burn" ? "supplyChange" : "mint", basis: "decoded", flags: [], evidenceIds,
        detail: { mint: mintAddr, deltaRaw: delta.toString(), display: decimals == null ? `${delta} raw` : formatUnits(delta, decimals), shareOfSupplyAtCapture: mint ? pct(d.amountRaw, mint.supplyRaw) : "unknown", supplyAtCaptureRaw: mint?.supplyRaw.toString() ?? null, captureSlot: mint?.slot ?? null, note: "share uses the supply captured at the given slot, not the pre-execution supply" } });
    }
    if (d.kind === "burn" || d.kind === "transfer") {
      const src = state.tokenAccounts[d.source];
      const flags: string[] = [];
      if (src && d.amountRaw > src.amountRaw) flags.push("exceeds-current-balance");
      if (d.kind === "transfer" && !state.tokenAccounts[d.destination]) flags.push("destination-not-captured");
      out.push({ id: `${id}-move`, type: "treasuryMovement", basis: "decoded", flags, evidenceIds,
        detail: { asset: mintAddr, amountRaw: d.amountRaw.toString(), amountDisplay: display, source: d.source, destination: d.kind === "transfer" ? d.destination : null, sourceOwner: src?.owner ?? null, sourceIsGovernanceTreasury: src?.owner === ctx.nativeTreasury, sourceBalanceAtCaptureRaw: src?.amountRaw.toString() ?? null, shareOfSourceBalanceAtCapture: src ? pct(d.amountRaw, src.amountRaw) : "unknown", captureSlot: src?.slot ?? null } });
    }
  });
  return out;
}
