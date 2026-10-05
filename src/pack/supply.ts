import { formatUnits, type MintState } from "../chain/token-layout";

export type SupplyClaim = { text: string; source: string; capRaw?: string };
export type KnownBurn = { amountRaw: string; signature: string; slot: number; source: string };
export type SupplyStatement = {
  mint: string; supplyRaw: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null;
  capClaim: { text: string; source: string } | null; capStatus: "consistent" | "contradicted" | "unverifiable";
  knownBurns: KnownBurn[]; impliedPreBurnSupplyRaw: string; note: string;
};

/** Parse only explicit numeric cap claims; an unknown wording is never guessed. */
function capRaw(claim: SupplyClaim, decimals: number): bigint | null {
  if (claim.capRaw != null) return BigInt(claim.capRaw);
  const match = claim.text.match(/(?:hard\s+cap|cap)(?:\s+of)?\s+([\d,]+)(?:\s+(billion|million))?/i);
  if (!match) return null;
  return BigInt(match[1].replaceAll(",", "")) * (match[2]?.toLowerCase() === "billion" ? 1_000_000_000n : match[2]?.toLowerCase() === "million" ? 1_000_000n : 1n) * 10n ** BigInt(decimals);
}

export function supplyStatement({ mint, claims, burns }: {
  mint: MintState & { address: string; slot: number | null }; claims: SupplyClaim[]; burns: KnownBurn[];
}): SupplyStatement {
  const claim = claims.find(c => c.capRaw != null || /\bcap\b/i.test(c.text));
  const cap = claim ? capRaw(claim, mint.decimals) : null;
  const implied = mint.supplyRaw + burns.reduce((sum, burn) => sum + BigInt(burn.amountRaw), 0n);
  const capStatus = cap == null ? "unverifiable" : implied > cap ? "contradicted" : "consistent";
  const difference = cap == null ? "cap amount unavailable" : implied > cap
    ? `implied pre-burn supply exceeds the claimed cap by ${formatUnits(implied - cap, mint.decimals)} tokens`
    : `difference ${formatUnits(cap - implied, mint.decimals)} tokens unexplained; other burns not enumerated`;
  const issuance = mint.mintAuthority == null
    ? `no further issuance possible under the current mint state (verified at slot ${mint.slot ?? "unknown"})`
    : `mint authority ${mint.mintAuthority} remains able to issue tokens`;
  return { mint: mint.address, supplyRaw: mint.supplyRaw.toString(), decimals: mint.decimals,
    mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority,
    capClaim: claim ? { text: claim.text, source: claim.source } : null, capStatus, knownBurns: burns,
    impliedPreBurnSupplyRaw: implied.toString(),
    note: `Supply ${formatUnits(mint.supplyRaw, mint.decimals)}; known burns ${formatUnits(implied - mint.supplyRaw, mint.decimals)}; implied pre-burn supply ${formatUnits(implied, mint.decimals)}. Cap claim ${capStatus}: ${difference}. ${issuance}. The historical cap remains a claim; consistency does not verify it.` };
}
