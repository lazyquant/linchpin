import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { coverage, loadCase } from "../src/governance/claims";
const burn = { id: "fx-0-0-supply", type: "supplyChange" as const, basis: "decoded" as const, flags: [], evidenceIds: [], detail: { mint: "MNDE", deltaRaw: "-300000000000000000", display: "-300,000,000", shareOfSupplyAtCapture: "42.8573%" } };
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
  test("claiming one burn effect covers both effects of the same instruction", () => {
    const move = { id: "fx-0-0-move", type: "treasuryMovement" as const, basis: "decoded" as const, flags: [], evidenceIds: [], detail: { amountRaw: "300000000000000000" } };
    const c = coverage([{ id: "c1", text: "Burn 30% of MNDE Total Supply", source: "on-chain proposal name", sourceRef: "x", retrievedAt: "2026-10-05", kind: "percentOfSupply", percent: 30 }], [burn, move], { decimals: 9, claimedPreSupplyRaw: 1000000000000000000n });
    expect(c[0]).toMatchObject({ claimId: "c1", effectId: "fx-0-0-supply", status: "covered-under-assumption" });
    expect(c.some((x) => x.status === "omitted-from-claims")).toBe(false);
  });
});

test("instruction coverage keeps distinct transactions separate", () => {
  const other = { ...burn, id: "fx-1-0-supply" };
  const c = coverage([{ id: "c1", text: "Burn 30%", source: "s", sourceRef: "x", retrievedAt: "2026-10-05", kind: "percentOfSupply", percent: 30 }], [burn, other], { decimals: 9, claimedPreSupplyRaw: 1000000000000000000n });
  expect(c.find((x) => x.effectId === other.id)?.status).toBe("omitted-from-claims");
});

test("BonkDAO case preserves all source sentences and matches the stated transfer amount", () => {
  const c = loadCase("cases/bonk-bip76.json");
  const source = JSON.parse(readFileSync("cases/sources/bonk-bip76-reports.json", "utf8"));
  expect(c.programVersion).toBe(3);
  expect(c.fixture.oneToken).toBe(true);
  expect(c.claimedPreSupply).toBeUndefined();
  expect(c.claims.map((claim) => claim.id)).toEqual(Array.from({ length: 11 }, (_, i) => `c${i + 1}`));
  const reports = source.reports.flatMap((r: { id: string; url: string; sentences: string[] }) => r.sentences.map((text: string) => ({ text, source: `${r.id} report`, sourceRef: r.url, retrievedAt: source.retrievedAt, kind: "text" })));
  c.claims.slice(3).forEach((claim, i) => expect(claim).toMatchObject(reports[i]));
  const move = { id: "fx-3-0-move", type: "treasuryMovement" as const, basis: "decoded" as const, flags: [], evidenceIds: [], detail: { amountRaw: "442610445030596600" } };
  expect(coverage(c.claims, [move], { decimals: 5, claimedPreSupplyRaw: null }).find((x) => x.claimId === "c2")?.status).toBe("covered");
});
