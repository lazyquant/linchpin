import { expect, test } from "bun:test";
import { supplyStatement } from "../src/pack/supply";
const mint = { address: "MNDE", supplyRaw: 699997047681352988n, decimals: 9, mintAuthority: null, freezeAuthority: null, slot: 453658037 };
const burn = { amountRaw: "300000000000000000", signature: "3w6j5Pc2yoEuK6BERjKxdZQaBvztk6ZantyhUSqz16qYbNsTWvpUkP38jrAm6bs2a94biXq4G8nBLtuERNnkWZkv", slot: 364780050, source: "MIP-14 receipt" };
test("MNDE supply plus MIP-14 burn is consistent with claimed cap, with exact unexplained difference", () => {
  const s = supplyStatement({ mint, claims: [{ text: "MNDE has a hard cap of 1 billion tokens and minting is permanently disabled.", source: "forum:mip-14-thread-1909" }], burns: [burn] });
  expect(s.capStatus).toBe("consistent");
  expect(s.impliedPreBurnSupplyRaw).toBe("999997047681352988");
  expect(s.knownBurns).toEqual([burn]);
  expect(s.note).toContain("2,952.318647012 tokens unexplained; other burns not enumerated");
  expect(s.note).toContain("no further issuance possible under the current mint state (verified at slot 453658037)");
});
test("a cap smaller than supply is contradicted", () => {
  expect(supplyStatement({ mint, claims: [{ text: "cap of 600,000,000", source: "synthetic" }], burns: [] }).capStatus).toBe("contradicted");
});
test("an unquantified cap is unverifiable and existing mint authority is disclosed", () => {
  const s = supplyStatement({ mint: { ...mint, mintAuthority: "issuer" }, claims: [{ text: "hard cap exists", source: "synthetic" }], burns: [] });
  expect(s.capStatus).toBe("unverifiable");
  expect(s.note).toContain("issuer remains able to issue");
});
