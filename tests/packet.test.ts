import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { effectsFromDecoded } from "../src/governance/effects";
import { reconcileReceipt } from "../src/governance/receipt";
import { coverage } from "../src/governance/claims";
import { buildGraph } from "../src/graph/build";
import { buildPacket, renderHtml } from "../src/review/packet";

async function packetFor(caseId: string, proposal: string) {
  const rpc = new RecordingRpc(runOptions({ offline: true }), caseId);
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
  const decoded = b.transactions.flatMap((t) => t.instructions.map(decodeInstruction));
  const effects = effectsFromDecoded(decoded, b, { nativeTreasury: b.governance.nativeTreasury });
  const rec = b.transactions[0] ? reconcileReceipt(decoded, b.transactions[0], null) : { status: "not-executed" as const, expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transactions"] };
  const cov = coverage([], effects, { decimals: 9, claimedPreSupplyRaw: null });
  return buildPacket({ caseId, title: caseId, offline: true, bundle: b, decoded, effects, sims: [], receipt: null, reconciliation: rec, claims: [], coverage: cov, graph: buildGraph(b, decoded, effects, null, [], []), evidenceCount: rpc.evidence.length });
}

describe("packet", () => {
  test("MIP-14 packet renders all four bases and a binding hash", async () => {
    const p = await packetFor("mip-14", "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");
    const html = renderHtml(p);
    for (const s of ["Claimed", "Decoded", "Simulated", "Observed", "Control path", p.bindingSha256.slice(0, 16)]) expect(html).toContain(s);
    expect(p.controlPath).toHaveLength(4);
  });
  test("the opinion proposal is a clean no-payload control", async () => {
    const p = await packetFor("mip-14-opinion", "Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp");
    expect(p.dimensions.description_matches_effects).toContain("no executable payload");
    expect(p.dimensions.execution_eligible).toBe("not applicable");
    expect(renderHtml(p)).toContain("signaling only");
  });
});
