import { expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { reviewBundle } from "../src/cli";
import { decodeInstruction } from "../src/governance/decode";
import { attachReceiptShares, effectsFromDecoded } from "../src/governance/effects";
import { reconcileReceipt, type Receipt } from "../src/governance/receipt";
import { dimensions, checks } from "../src/review/checks";
import { buildGraph } from "../src/graph/build";
import { buildPacket, renderHtml } from "../src/review/packet";
import { offlineMip14 } from "./helpers";

const transfer = { kind: "transfer" as const, program: "Token", amountRaw: 40n, decimals: 0, source: "source", destination: "destination", mint: "mint", authority: "treasury", decoderVersion: "v" };
function receipt(txIndex = 0): Receipt {
  return { txIndex, proposalTransaction: `ptx-${txIndex}`, signature: `sig-${txIndex}`, slot: 100 + txIndex, blockTime: 123, success: true, programsInvoked: [], innerPrograms: ["Token"], governanceExecuteLogged: true, logs: [], evidenceIds: [], tokenBalances: [
    { account: "source", mint: "mint", owner: "treasury", preRaw: "100", postRaw: "60", deltaRaw: "-40" },
    { account: "destination", mint: "mint", owner: "recipient", preRaw: "0", postRaw: "40", deltaRaw: "40" },
  ] };
}

test("every source movement reconciles, including multiple debits from one source and net credits", async () => {
  const { bundle } = await offlineMip14();
  const ptx = bundle.transactions[0];
  const second = { ...transfer, source: "second", destination: "source", amountRaw: 10n };
  const r = receipt();
  r.tokenBalances[0].deltaRaw = "-70"; // Two debits of 40 and one credit of 10.
  r.tokenBalances.push({ account: "second", mint: "mint", owner: "treasury", preRaw: "10", postRaw: "0", deltaRaw: "-10" });
  let rec = reconcileReceipt([transfer, transfer, second], ptx, r);
  expect(rec.status).toBe("matched");
  expect(rec.accounts).toEqual([
    { account: "source", expectedDeltaRaw: "-70", observedDeltaRaw: "-70", matched: true },
    { account: "second", expectedDeltaRaw: "-10", observedDeltaRaw: "-10", matched: true },
  ]);
  r.tokenBalances[2].deltaRaw = "-9";
  expect(reconcileReceipt([transfer, transfer, second], ptx, r).status).toBe("mismatch");
  r.tokenBalances.pop();
  expect(reconcileReceipt([transfer, transfer, second], ptx, r).accounts![1].observedDeltaRaw).toBeNull();
  r.tokenBalances[0].deltaRaw = "-40";
  r.innerPrograms = [];
  expect(reconcileReceipt([transfer], ptx, r).status).toBe("mismatch");
});

test("receipt shares and destination history stay scoped to the exact transaction", async () => {
  const { bundle } = await offlineMip14();
  const effects = effectsFromDecoded([0, 1].map((txIndex) => ({ txIndex, ixIndex: 2, decoded: transfer })), { tokenAccounts: {}, mints: {} }, { nativeTreasury: "treasury" });
  const a = receipt(0); const b = receipt(1);
  b.tokenBalances[0].preRaw = "40";
  b.tokenBalances[1].preRaw = "12";
  b.tokenBalances[1].postRaw = "52";
  attachReceiptShares(effects, [b, a]);
  expect(effects.map((e) => e.id)).toEqual(["fx-0-2-move", "fx-1-2-move"]);
  expect(effects[0].detail).toMatchObject({ shareOfSourceBalancePreExecution: "40.0000%", destinationPreBalanceRaw: "0", destinationPostBalanceRaw: "40", preExecutionSlot: 100 });
  expect(effects[1].detail).toMatchObject({ shareOfSourceBalancePreExecution: "100.0000%", destinationPreBalanceRaw: "12", destinationPostBalanceRaw: "52", preExecutionSlot: 101 });
  expect(effects[0].flags).toContain("destination-empty-before");
  expect(effects[1].flags).not.toContain("destination-empty-before");
  const row = checks(bundle, effects, [], [], [a, b]).find((c) => c.check === "Treasury movement")!;
  expect(row.result).toContain("destination held 0 before execution");
  expect(row.needsReview).toBe(true);
});

test("graph maps effects to exact instructions and control path starts at a debited account", async () => {
  const { bundle } = await offlineMip14();
  const burn = bundle.transactions[0].instructions[0];
  const unsupported = { programId: PublicKey.default.toBase58(), accounts: [], dataHex: "00" };
  bundle.transactions = [
    { ...bundle.transactions[0], address: "tx-a", instructions: [unsupported, burn] },
    { ...bundle.transactions[0], address: "tx-b", instructions: [burn, unsupported] },
  ];
  const source = burn.accounts[0].pubkey;
  bundle.tokenAccounts = { unrelated: { ...bundle.tokenAccounts[source], owner: "unrelatedOwner" }, ...bundle.tokenAccounts };
  const indexed = bundle.transactions.flatMap((t, txIndex) => t.instructions.map((ix, ixIndex) => ({ txIndex, ixIndex, decoded: decodeInstruction(ix) })));
  const decoded = indexed.map((i) => i.decoded);
  const effects = effectsFromDecoded(indexed, bundle, { nativeTreasury: bundle.governance.nativeTreasury });
  const graph = buildGraph(bundle, decoded, effects, [], [], []);
  expect(graph.edges.filter((e) => e.type === "PRODUCES").map((e) => [e.from, e.to])).toEqual([
    ["ix:tx-a:0", "effect:fx-0-0"], ["ix:tx-a:1", "effect:fx-0-1-supply"], ["ix:tx-a:1", "effect:fx-0-1-move"],
    ["ix:tx-b:0", "effect:fx-1-0-supply"], ["ix:tx-b:0", "effect:fx-1-0-move"], ["ix:tx-b:1", "effect:fx-1-1"],
  ]);
  expect(graph.nodes.find((n) => n.id === "ix:tx-b:0")!.label).toBe("burn");
  const packet = buildPacket({ caseId: "synthetic", title: "synthetic", offline: true, bundle, decoded, effects, graph, sims: [], claims: [], coverage: [], receipts: [], reconciliations: [], evidenceCount: 0 });
  expect(packet.controlPath[0]).toBe(`ta:${source}`);
  expect(renderHtml(packet).match(/Burn 300,000,000/g)).toHaveLength(2);
});

test("CLI pipeline visits every transaction, leaves unknowns unreconciled, and labels skipped fixtures", async () => {
  const { c, rpc, bundle } = await offlineMip14();
  const original = bundle.transactions[0];
  bundle.transactions.push({ ...original, address: PublicKey.default.toBase58(), instructions: [{ programId: PublicKey.default.toBase58(), accounts: [], dataHex: "00" }] });
  const source = original.instructions[0].accounts[0].pubkey;
  bundle.tokenAccounts[source].amountRaw = 0n;
  const signatureReads: string[] = [];
  const originalSignatures = rpc.getSignaturesForAddress.bind(rpc);
  rpc.getSignaturesForAddress = async (address) => {
    signatureReads.push(address.toBase58());
    return originalSignatures(new PublicKey(original.address));
  };
  let previews = 0;
  rpc.simulate = async () => {
    previews++;
    return { value: { err: null, logs: [], accounts: [], unitsConsumed: 0 }, evidence: rpc.evidence[0] };
  };
  const packet = await reviewBundle(c, rpc, bundle);
  expect(signatureReads).toEqual(bundle.transactions.map((t) => t.address));
  expect(previews).toBe(2); // Only the historical payload for each transaction.
  expect(packet.simulated.map((s) => s.txIndex)).toEqual([0, 1]);
  expect(packet.observed.receipts.map((r) => r.txIndex)).toEqual([0, 1]);
  expect(packet.observed.reconciliations.map((r) => r.status)).toEqual(["matched", "mismatch"]);
  expect(packet.dimensions.execution_status).toBe("observed: 1 of 2 matched");
  expect(packet.checks.find((c) => c.check === "Observed execution")!.result).toStartWith("matched 1/2");
  expect(packet.graph.edges.some((e) => e.type === "CONFIRMS" && e.to === "effect:fx-1-0")).toBe(false);
  const html = renderHtml(packet);
  expect(html).toContain("fixture skipped: source balance is 0 at capture");
  for (const r of packet.observed.receipts) expect(html).toContain(r.proposalTransaction);
  bundle.transactions[1].executedAt = null;
  const partial = await reviewBundle({ ...c, fixture: { burnOneToken: false } }, rpc, bundle);
  expect(partial.observed.receipts).toHaveLength(1);
  expect(partial.observed.reconciliations[1].status).toBe("not-executed");
  bundle.tokenAccounts[source].amountRaw = 2000000000n;
  const legacy = await reviewBundle({ ...c, fixture: { burnOneToken: true } }, rpc, bundle);
  expect(legacy.simulated.filter((s) => s.kind === "fixture")).toHaveLength(1);
  expect(legacy.simulated.find((s) => s.kind === "fixture")).toMatchObject({ txIndex: 0, ixIndex: 0 });
});

test("execution dimensions distinguish all matched, partially matched, missing and unexecuted receipts", async () => {
  const { bundle } = await offlineMip14();
  const base = { account: null, expectedDeltaRaw: null, observedDeltaRaw: null, notes: [] };
  const status = (statuses: ("matched" | "mismatch" | "receipt-not-found" | "not-executed")[]) => dimensions(bundle, [], [], [], statuses.map((status) => ({ ...base, status }))).execution_status;
  expect(status(["matched", "matched"])).toBe("observed: all receipts match decoded effects");
  expect(status(["matched", "receipt-not-found"])).toBe("observed: 1 of 2 matched");
  expect(status(["mismatch", "mismatch"])).toBe("observed: 0 of 2 matched");
  expect(status(["receipt-not-found"])).toBe("receipt-not-found");
  bundle.transactions[0].executedAt = null;
  expect(status(["not-executed"])).toBe("not executed");
  bundle.transactions = [];
  expect(status([])).toBe("not executed");
});
