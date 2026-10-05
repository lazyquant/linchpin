import { describe, expect, test } from "bun:test";
import { coverage } from "../src/governance/claims";
const burn = { id: "fx-0-supply", type: "supplyChange" as const, basis: "decoded" as const, flags: [], evidenceIds: [], detail: { mint: "MNDE", deltaRaw: "-300000000000000000", display: "-300,000,000", shareOfSupplyAtCapture: "42.8573%" } };
describe("coverage", () => {
  test("a 30% claim is covered by a 300M burn only under the claimed 1B pre-burn supply, and that is said", () => {
    const c = coverage([{ id: "c1", text: "Burn 30% of MNDE Total Supply", source: "on-chain proposal name", sourceRef: "x", retrievedAt: "2026-10-05", kind: "percentOfSupply", percent: 30 }], [burn], { decimals: 9, claimedPreSupplyRaw: 1000000000000000000n });
    expect(c[0]).toMatchObject({ claimId: "c1", status: "covered-under-assumption" });
    expect(c[0].note).toContain("1,000,000,000");
  });
  test("no effects → claim unmatched, not contradicted", () => {
    const c = coverage([{ id: "c2", text: "Burn 0–50%", source: "s", sourceRef: "x", retrievedAt: "2026-10-05", kind: "range" }], [], { decimals: 9, claimedPreSupplyRaw: null });
    expect(c[0].status).toBe("no-executable-effect");
  });
  test("an effect nobody claimed is an omission", () => {
    const c = coverage([], [burn], { decimals: 9, claimedPreSupplyRaw: null });
    expect(c.find((x) => x.claimId === null)?.status).toBe("omitted-from-claims");
  });
});
