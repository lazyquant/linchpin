import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { findExecutionReceipt } from "../src/governance/receipt";
import { fixtureBurn, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS } from "../src/governance/simulate";
const [caseId, proposal] = process.argv.slice(2);
const rpc = new RecordingRpc(runOptions({ record: true }), caseId);
const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
const out: Record<string, unknown> = { name: b.proposal.name, transactions: b.transactions.length };
const ptx = b.transactions[0];
if (ptx) {
  const receipt = await findExecutionReceipt(rpc, ptx);
  out.receipt = receipt ? { signature: receipt.signature, slot: receipt.slot, success: receipt.success } : null;
  const decoded = ptx.instructions.map(decodeInstruction);
  const treasury = new PublicKey(b.governance.nativeTreasury);
  const tokenAccounts = Object.keys(b.tokenAccounts).map((k) => new PublicKey(k));
  const mints = Object.keys(b.mints).map((k) => new PublicKey(k));
  const hist = await simulateConditionalPreview(rpc, { kind: "historical-payload", label: `${caseId} payload against current state`, instructions: ptx.instructions.map(toTransactionInstruction), feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: PREVIEW_ASSUMPTIONS });
  out.historical = { success: hist.success, error: hist.error };
  const d = decoded.find((x) => x.kind === "burn");
  if (d && d.kind === "burn") {
    const fx = await simulateConditionalPreview(rpc, { kind: "fixture", label: "fixture: burn 1 whole token from the same treasury account (not the historical payload)", instructions: [fixtureBurn(new PublicKey(d.source), new PublicKey(d.mint), new PublicKey(d.authority), b.mints[d.mint]?.decimals ?? 9)], feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: [...PREVIEW_ASSUMPTIONS, "amount replaced by one whole token so the preview can succeed under current balances"] });
    out.fixture = { success: fx.success, unitsConsumed: fx.unitsConsumed };
  }
}
out.evidence = rpc.evidence.length;
console.log(JSON.stringify(out, null, 1));
