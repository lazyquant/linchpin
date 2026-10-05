import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";

const MIP14 = new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");

describe("readProposalBundle (offline fixtures)", () => {
  test("MIP-14: one burn instruction, treasury owned by the governance's native treasury", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, MIP14);
    expect(b.proposal.name).toBe("MIP-14: Burn 30% of MNDE Total Supply");
    expect(b.proposal.maxVoteWeightRaw).toBe("999998206916761061");
    expect(b.proposal.abstainVoteWeightRaw).toBeNull();
    expect(b.proposal.voteThreshold).toEqual({ type: 0, value: 2 });
    expect(b.proposal.executionDelaySeconds).toBe(194);
    expect(b.proposal.stateName).toBe("Completed");
    expect(b.realm.name).toBe("Marinade DAO");
    expect(b.governance.nativeTreasury).toBe("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
    expect(b.transactions).toHaveLength(1);
    const ix = b.transactions[0].instructions[0];
    expect(ix.programId).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(ix.dataHex).toBe("0800009e1869d02904");
    expect(b.tokenAccounts["GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi"].owner).toBe(b.governance.nativeTreasury);
    expect(b.mints["MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"].decimals).toBe(9);
  });
});
