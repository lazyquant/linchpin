import { describe, expect, test } from "bun:test";
import { effectsFromDecoded } from "../src/governance/effects";

describe("effectsFromDecoded", () => {
  const state = { tokenAccounts: { GR: { mint: "MNDE", owner: "B56", amountRaw: 153600023536334850n, slot: 453651973, evidenceId: "e-ta" } }, mints: { MNDE: { supplyRaw: 699997047681352988n, decimals: 9, mintAuthority: null, freezeAuthority: null, slot: 453651973, evidenceId: "e-mint" } } };
  test("burn → supply change and treasury movement with exact units and dated shares", () => {
    const fx = effectsFromDecoded([{ kind: "burn", program: "Tok", amountRaw: 300000000000000000n, decimals: null, source: "GR", mint: "MNDE", authority: "B56", decoderVersion: "v" }], state, { nativeTreasury: "B56" });
    const supply = fx.find((e) => e.type === "supplyChange")!; const move = fx.find((e) => e.type === "treasuryMovement")!;
    expect(supply.basis).toBe("decoded");
    expect(supply.detail).toMatchObject({ mint: "MNDE", deltaRaw: "-300000000000000000", display: "-300,000,000", shareOfSupplyAtCapture: "42.8573%" });
    expect(move.detail).toMatchObject({ asset: "MNDE", amountDisplay: "300,000,000", source: "GR", destination: null, sourceOwner: "B56", sourceIsGovernanceTreasury: true, shareOfSourceBalanceAtCapture: "195.3124%" });
    expect(move.flags).toContain("exceeds-current-balance");
  });
  test("unsupported stays an explicit unknown effect", () => {
    const fx = effectsFromDecoded([{ kind: "unsupported", program: "X", reason: "r", dataHex: "00", decoderVersion: "v" }], state, { nativeTreasury: "B56" });
    expect(fx[0]).toMatchObject({ type: "unknown", basis: "unknown" });
  });
});
