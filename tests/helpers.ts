import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { loadCase } from "../src/governance/claims";
import { readProposalBundle } from "../src/governance/reader";

export async function offlineMip14() {
  const c = loadCase("cases/mip-14.json");
  const rpc = new RecordingRpc(runOptions({ offline: true, rpcUrl: "http://127.0.0.1:1" }), c.caseId);
  const bundle = await readProposalBundle(rpc, new PublicKey(c.programId), c.programVersion, new PublicKey(c.proposal));
  return { c, rpc, bundle };
}
