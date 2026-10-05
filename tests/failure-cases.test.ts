import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { coverage, loadCase } from "../src/governance/claims";
import { decodeInstruction } from "../src/governance/decode";
import { effectsFromDecoded } from "../src/governance/effects";
import { readProposalBundle } from "../src/governance/reader";
import { findExecutionReceipt, reconcileReceipt } from "../src/governance/receipt";
import { fixtureBurn, PREVIEW_ASSUMPTIONS, simulateConditionalPreview, toTransactionInstruction, type SimulationRun } from "../src/governance/simulate";
import { buildGraph } from "../src/graph/build";
import { buildPacket } from "../src/review/packet";

async function offlineMip14() {
  const c = loadCase("cases/mip-14.json");
  const rpc = new RecordingRpc(runOptions({ offline: true, rpcUrl: "http://127.0.0.1:1" }), c.caseId);
  const bundle = await readProposalBundle(rpc, new PublicKey(c.programId), c.programVersion, new PublicKey(c.proposal));
  return { c, rpc, bundle };
}

// Mirror the CLI pipeline without importing its command-dispatch side effects.
// Synthetic payloads use only the reader fixtures; real execution replays the
// recorded receipt and both conditional previews through the production modules.
async function packetFor({ c, rpc, bundle }: Awaited<ReturnType<typeof offlineMip14>>, replayExecution = false) {
  const indexed = bundle.transactions.flatMap((t, txIndex) => t.instructions.map((ix, ixIndex) => ({ txIndex, ixIndex, decoded: decodeInstruction(ix) })));
  const decoded = indexed.map((i) => i.decoded);
  const effects = effectsFromDecoded(indexed, bundle, { nativeTreasury: bundle.governance.nativeTreasury });
  const ptx = bundle.transactions[0];
  const receipt = replayExecution ? await findExecutionReceipt(rpc, ptx) : null;
  const reconciliation = reconcileReceipt(decoded, ptx, receipt);
  const sims: SimulationRun[] = [];
  if (replayExecution && ptx.instructions.length) {
    const treasury = new PublicKey(bundle.governance.nativeTreasury);
    const watch = {
      tokenAccounts: Object.keys(bundle.tokenAccounts).map((k) => new PublicKey(k)),
      mints: Object.keys(bundle.mints).map((k) => new PublicKey(k)),
    };
    sims.push(await simulateConditionalPreview(rpc, {
      kind: "historical-payload", label: `${c.caseId} payload against current state`,
      instructions: ptx.instructions.map(toTransactionInstruction), feePayer: treasury,
      watch, assumptions: PREVIEW_ASSUMPTIONS,
    }));
    const d = decoded.find((x) => x.kind === "burn");
    if ((c.fixture.oneToken ?? c.fixture.burnOneToken) && d && d.kind === "burn") {
      sims.push(await simulateConditionalPreview(rpc, {
        kind: "fixture", label: "fixture: burn 1 whole token from the same treasury account (not the historical payload)",
        instructions: [fixtureBurn(new PublicKey(d.source), new PublicKey(d.mint), new PublicKey(d.authority), bundle.mints[d.mint]?.decimals ?? 9)],
        feePayer: treasury, watch,
        assumptions: [...PREVIEW_ASSUMPTIONS, "amount replaced by one whole token so the preview can succeed under current balances"],
      }));
    }
  }
  const decimals = bundle.mints[bundle.proposal.governingTokenMint]?.decimals ?? 9;
  const cov = coverage(c.claims, effects, { decimals, claimedPreSupplyRaw: c.claimedPreSupply ? BigInt(c.claimedPreSupply.raw) : null });
  const graph = buildGraph(bundle, decoded, effects, receipt ? [receipt] : [], sims, c.claims);
  return buildPacket({ caseId: c.caseId, title: c.title, offline: true, bundle, decoded, effects, sims, receipts: receipt ? [receipt] : [], reconciliations: [reconciliation], claims: c.claims, coverage: cov, graph, evidenceCount: rpc.evidence.length });
}

describe("governance failure cases", () => {
  test("case 1: a synthetic bundle without instructions has no executable payload", async () => {
    const context = await offlineMip14();
    context.bundle.transactions[0].instructions = [];
    const packet = await packetFor(context);
    expect(packet.dimensions.description_matches_effects).toBe("no executable payload: signaling only");
    expect(packet.dimensions.execution_eligible).toBe("not applicable");
    expect(packet.effects).toHaveLength(0);
  });

  test("case 4: a synthetic unsupported instruction stays unknown and needs review", async () => {
    const context = await offlineMip14();
    const programId = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
    context.bundle.transactions[0].instructions = [{ programId, accounts: [], dataHex: "00" }];
    const packet = await packetFor(context);
    expect(packet.effects).toContainEqual(expect.objectContaining({ type: "unknown", detail: expect.objectContaining({ program: programId, dataHex: "00" }) }));
    expect(packet.checks.find((row) => row.check === "Unknown / unsupported")).toMatchObject({ needsReview: true });
  });

  test("case 5: changing payload bytes changes the binding for the same proposal", async () => {
    const context = await offlineMip14();
    const original = await packetFor(context);
    context.bundle.transactions[0].instructions[0].dataHex += "00";
    const changed = await packetFor(context);
    expect(changed.proposal.address).toBe(original.proposal.address);
    expect(changed.bindingSha256).not.toBe(original.bindingSha256);
  });

  test("case 6: the historical preview fails while the observed execution matches", async () => {
    const context = await offlineMip14();
    const packet = await packetFor(context, true);
    const historical = packet.simulated.find((s) => s.kind === "historical-payload");
    expect(historical).toMatchObject({ success: false, mode: "conditional-preview", error: { InstructionError: [0, { Custom: 1 }] } });
    expect(historical?.logs.join("\n")).toContain("insufficient funds");
    expect(packet.dimensions.simulation_result).toContain("historical-payload: failed");
    expect(packet.dimensions.execution_status).toBe("observed: all receipts match decoded effects");
    expect(packet.observed.reconciliations[0]).toMatchObject({ status: "matched", observedDeltaRaw: "-300000000000000000" });
    expect(packet.simulated.find((s) => s.kind === "fixture")?.success).toBe(true);
    expect(context.rpc.evidence.every((e) => e.source === "fixture")).toBe(true);
  });
});
