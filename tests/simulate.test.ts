import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { fixtureBurn, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS } from "../src/governance/simulate";

const GR = new PublicKey("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi"), MNDE = new PublicKey("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"), B56 = new PublicKey("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
const payload = { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "0800009e1869d02904", accounts: [{ pubkey: GR.toBase58(), isSigner: false, isWritable: true }, { pubkey: MNDE.toBase58(), isSigner: false, isWritable: true }, { pubkey: B56.toBase58(), isSigner: true, isWritable: false }] };

describe("conditional preview (offline fixtures)", () => {
  test("historical payload fails today with insufficient funds and says so", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const run = await simulateConditionalPreview(rpc, { kind: "historical-payload", label: "MIP-14 payload against current state", instructions: [toTransactionInstruction(payload)], feePayer: B56, watch: { tokenAccounts: [GR], mints: [MNDE] }, assumptions: PREVIEW_ASSUMPTIONS });
    expect(run.success).toBe(false);
    expect(JSON.stringify(run.error)).toContain("Custom");
    expect(run.logs.join("\n")).toContain("insufficient funds");
  });
  test("labelled fixture burn of 1 MNDE succeeds and reports post state", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const run = await simulateConditionalPreview(rpc, { kind: "fixture", label: "fixture: burn 1 MNDE from the same treasury account", instructions: [fixtureBurn(GR, MNDE, B56, 9)], feePayer: B56, watch: { tokenAccounts: [GR], mints: [MNDE] }, assumptions: PREVIEW_ASSUMPTIONS });
    expect(run.success).toBe(true);
    expect(BigInt(run.postState.tokenAccounts[GR.toBase58()])).toBeGreaterThan(0n);
    expect(run.kind).toBe("fixture");
  });
});
