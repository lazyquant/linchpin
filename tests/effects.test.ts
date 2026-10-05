import { describe, expect, test } from "bun:test";
import type { Receipt } from "../src/governance/receipt";
import { attachReceiptShares, effectsFromDecoded } from "../src/governance/effects";
import type { IndexedDecoded } from "../src/governance/effects";
import { checks } from "../src/review/checks";
import { offlineMip14 } from "./helpers";

test("account creation flags transfer destinations across proposal transactions", async () => {
  const { bundle } = await offlineMip14();
  const creation: IndexedDecoded = { txIndex: 0, ixIndex: 0, decoded: { kind: "createAccount", program: "ATA", account: "destination", owner: "recipient", mint: "mint", payer: "payer", idempotent: true, decoderVersion: "v" } };
  const transfer: IndexedDecoded = { txIndex: 3, ixIndex: 0, decoded: { kind: "transfer", program: "Token", source: "source", destination: "destination", mint: "mint", authority: "treasury", amountRaw: 1n, decimals: 0, decoderVersion: "v" } };
  const effects = effectsFromDecoded([creation, transfer], bundle, { nativeTreasury: "treasury" });
  expect(effects[0]).toEqual({ id: "fx-0-0", type: "accountCreation", basis: "decoded", detail: { account: "destination", owner: "recipient", mint: "mint", payer: "payer", idempotent: true }, flags: ["creates-transfer-destination"], evidenceIds: [] });
  const row = checks(bundle, effects, [], []).find((r) => r.check === "Account creation")!;
  expect(row.needsReview).toBe(true);
  expect(row.result).toBe("acct destin… (owner recipi…, mint mint…) — destination of the treasury transfer in this proposal");
  const isolated = effectsFromDecoded([creation], bundle, { nativeTreasury: "treasury" });
  expect(isolated[0].flags).toEqual([]);
  expect(checks(bundle, isolated, [], []).find((r) => r.check === "Account creation")!.needsReview).toBe(false);
});

describe("effectsFromDecoded", () => {
  const state = { tokenAccounts: { GR: { mint: "MNDE", owner: "B56", amountRaw: 153600023536334850n, slot: 453651973, evidenceId: "e-ta" } }, mints: { MNDE: { supplyRaw: 699997047681352988n, decimals: 9, mintAuthority: null, freezeAuthority: null, slot: 453651973, evidenceId: "e-mint" } } };
  test("burn → supply change and treasury movement with exact units and dated shares", () => {
    const fx = effectsFromDecoded([{ txIndex: 0, ixIndex: 0, decoded: { kind: "burn", program: "Tok", amountRaw: 300000000000000000n, decimals: null, source: "GR", mint: "MNDE", authority: "B56", decoderVersion: "v" } }], state, { nativeTreasury: "B56" });
    const supply = fx.find((e) => e.type === "supplyChange")!; const move = fx.find((e) => e.type === "treasuryMovement")!;
    expect(supply.basis).toBe("decoded");
    expect(supply.detail).toMatchObject({ mint: "MNDE", deltaRaw: "-300000000000000000", display: "-300,000,000", shareOfSupplyAtCapture: "42.8573%" });
    expect(move.detail).toMatchObject({ asset: "MNDE", amountDisplay: "300,000,000", source: "GR", destination: null, sourceOwner: "B56", sourceIsGovernanceTreasury: true, shareOfSourceBalanceAtCapture: "195.3124%" });
    expect(move.flags).toContain("exceeds-balance-at-capture");
  });
  test("attachReceiptShares adds an exact execution share without replacing the capture share", () => {
    const fx = effectsFromDecoded([{ txIndex: 0, ixIndex: 0, decoded: { kind: "burn", program: "Tok", amountRaw: 300000000000000000n, decimals: null, source: "GR", mint: "MNDE", authority: "B56", decoderVersion: "v" } }], state, { nativeTreasury: "B56" });
    const receipt: Receipt = { txIndex: 0, proposalTransaction: "ptx", signature: "synthetic", slot: 123, blockTime: null, success: true, programsInvoked: [], innerPrograms: [], governanceExecuteLogged: true, logs: [], evidenceIds: [], tokenBalances: [{ account: "GR", mint: "MNDE", owner: "B56", preRaw: "438930393329018999", postRaw: "138930393329018999", deltaRaw: "-300000000000000000" }] };
    const original = structuredClone(fx);
    attachReceiptShares(fx, []);
    attachReceiptShares(fx, [{ ...receipt, tokenBalances: [{ ...receipt.tokenBalances[0], account: "other" }] }]);
    expect(fx).toEqual(original);
    attachReceiptShares(fx, [receipt]);
    const move = fx.find((e) => e.type === "treasuryMovement")!;
    const share = String(move.detail.shareOfSourceBalancePreExecution);
    expect(parseFloat(share)).toBeGreaterThan(68.3);
    expect(parseFloat(share)).toBeLessThan(68.4);
    expect(share).toBe("68.3479%");
    expect(move.detail).toMatchObject({ sourceBalancePreExecutionRaw: "438930393329018999", preExecutionSlot: 123, shareOfSourceBalanceAtCapture: "195.3124%" });
    expect(fx[0]).toEqual(original[0]);
    attachReceiptShares(fx, [{ ...receipt, tokenBalances: [{ ...receipt.tokenBalances[0], preRaw: "0" }] }]);
    expect(move.detail.shareOfSourceBalancePreExecution).toBe("n/a");
  });
  test("unsupported stays an explicit unknown effect", () => {
    const fx = effectsFromDecoded([{ txIndex: 0, ixIndex: 0, decoded: { kind: "unsupported", program: "X", reason: "r", dataHex: "00", decoderVersion: "v" } }], state, { nativeTreasury: "B56" });
    expect(fx[0]).toMatchObject({ type: "unknown", basis: "unknown" });
  });
});
