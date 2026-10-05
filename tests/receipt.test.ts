import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { findExecutionReceipt, reconcileReceipt } from "../src/governance/receipt";

describe("MIP-14 receipt (offline fixtures)", () => {
  test("finds the ExecuteTransaction receipt and reconciles exactly -300,000,000 MNDE", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1"));
    const ptx = b.transactions[0];
    const receipt = await findExecutionReceipt(rpc, ptx);
    expect(receipt?.signature).toBe("3w6j5Pc2yoEuK6BERjKxdZQaBvztk6ZantyhUSqz16qYbNsTWvpUkP38jrAm6bs2a94biXq4G8nBLtuERNnkWZkv");
    expect(receipt?.slot).toBe(364780050);
    expect(receipt?.innerPrograms).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const rec = reconcileReceipt(ptx.instructions.map(decodeInstruction), ptx, receipt);
    expect(rec.status).toBe("matched");
    expect(rec.observedDeltaRaw).toBe("-300000000000000000");
    expect(rec.notes.join(" ")).toContain("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  });
});

test("receipt captures destination accounts first appearing in post balances", async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1"));
  const original = rpc.getTransaction.bind(rpc);
  rpc.getTransaction = async (signature) => {
    const result = await original(signature);
    const value = structuredClone(result.value)!;
    const pre = value.meta!.preTokenBalances![0];
    const post = value.meta!.postTokenBalances![0];
    // The existing account is the stand-in for a newly created destination.
    value.meta!.preTokenBalances = [];
    value.meta!.postTokenBalances = [{ ...post, accountIndex: pre.accountIndex, uiTokenAmount: { ...post.uiTokenAmount, amount: "40" } }];
    return { ...result, value };
  };
  const r = await findExecutionReceipt(rpc, b.transactions[0], 3);
  expect(r).toMatchObject({ txIndex: 3, proposalTransaction: b.transactions[0].address });
  expect(r!.tokenBalances[0]).toMatchObject({ preRaw: "0", postRaw: "40", deltaRaw: "40" });
});
