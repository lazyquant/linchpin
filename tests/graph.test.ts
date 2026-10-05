import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { effectsFromDecoded } from "../src/governance/effects";
import { buildGraph, controlPath, mermaid } from "../src/graph/build";

test("MIP-14 graph has the treasury → governance → realm control path", async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1"));
  const indexed = b.transactions.flatMap((t, txIndex) => t.instructions.map((ix, ixIndex) => ({ txIndex, ixIndex, decoded: decodeInstruction(ix) })));
  const decoded = indexed.map((i) => i.decoded);
  const g = buildGraph(b, decoded, effectsFromDecoded(indexed, b, { nativeTreasury: b.governance.nativeTreasury }), [], [], []);
  expect(controlPath(g, "GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi")).toEqual(["ta:GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi", "treasury:B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG", "gov:8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq", "realm:899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo"]);
  expect(g.edges.every((e) => ["claimed", "decoded", "simulated", "observed", "unknown"].includes(e.basis))).toBe(true);
  expect(mermaid(g)).toContain("flowchart LR");
});
