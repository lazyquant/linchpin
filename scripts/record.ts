// scripts/record.ts
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
const [caseId, proposal] = process.argv.slice(2);
const rpc = new RecordingRpc(runOptions({ record: true }), caseId);
const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
console.log(JSON.stringify({ name: b.proposal.name, transactions: b.transactions.length, evidence: rpc.evidence.length }, null, 1));
