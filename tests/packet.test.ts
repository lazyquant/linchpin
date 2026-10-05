import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction, type Decoded } from "../src/governance/decode";
import { attachReceiptShares, effectsFromDecoded } from "../src/governance/effects";
import { findExecutionReceipt, reconcileReceipt } from "../src/governance/receipt";
import { coverage } from "../src/governance/claims";
import { buildGraph } from "../src/graph/build";
import { buildPacket, renderHtml } from "../src/review/packet";

async function packetFor(caseId: string, proposal: string, withReceipt = false, omitBalances = false) {
  const rpc = new RecordingRpc(runOptions({ offline: true }), caseId);
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
  const decoded = b.transactions.flatMap((t) => t.instructions.map(decodeInstruction));
  const receipt = withReceipt ? await findExecutionReceipt(rpc, b.transactions[0]) : null;
  if (receipt && omitBalances) receipt.tokenBalances = [];
  const effects = effectsFromDecoded(decoded, b, { nativeTreasury: b.governance.nativeTreasury });
  attachReceiptShares(effects, receipt);
  const rec = b.transactions[0] ? reconcileReceipt(decoded, b.transactions[0], receipt) : { status: "not-executed" as const, expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transactions"] };
  const cov = coverage([], effects, { decimals: 9, claimedPreSupplyRaw: null });
  return buildPacket({ caseId, title: caseId, offline: true, bundle: b, decoded, effects, sims: [], receipt, reconciliation: rec, claims: [], coverage: cov, graph: buildGraph(b, decoded, effects, null, [], []), evidenceCount: rpc.evidence.length });
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

test("treasury checks distinguish the receipt balance from today's captured balance", async () => {
  const proposal = "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1";
  const without = await packetFor("mip-14", proposal);
  const captured = without.checks.find((r) => r.check === "Treasury movement")!;
  expect(captured.needsReview).toBe(true);
  expect(captured.result).toContain("195.3124% of source balance at slot 453658036");
  expect(captured.result).toEndWith("(historical amount exceeds today's balance)");
  const withReceipt = await packetFor("mip-14", proposal, true);
  const row = withReceipt.checks.find((r) => r.check === "Treasury movement")!;
  expect(row.needsReview).toBe(false);
  expect(row.result).toContain(`68.3479% of the source balance at execution (slot ${withReceipt.observed.receipt!.slot}, receipt); today's balance 153,600,023.53633485 at slot 453658036`);
  expect(row.result).toEndWith("(historical amount exceeds today's balance)");
  const missingRow = await packetFor("mip-14", proposal, true, true);
  expect(missingRow.checks.find((r) => r.check === "Treasury movement")).toMatchObject({ result: captured.result, needsReview: false });
});

test("decoded sentences cover every instruction, units, address titles, and escaping", async () => {
  const p = await packetFor("mip-14", "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");
  const text = (html: string) => html.replace(/<[^>]*>/g, "");
  expect(text(renderHtml(p))).toContain("Burn 300,000,000 MNDEFz… from GR1LBT…");
  p.decoded = [
    { kind: "burn", program: "Program123", amountRaw: 12345n, decimals: null, mint: "Mint12345", source: "Source123", authority: "Authority123", decoderVersion: "v" },
    { kind: "transfer", program: "Program123", amountRaw: 12345n, decimals: 2, mint: "Mint12345", source: "Source123", destination: "Destination123", authority: "Authority123", decoderVersion: "v" },
    { kind: "transfer", program: "Program123", amountRaw: 12345n, decimals: null, mint: null, source: "Source123", destination: "Destination123", authority: "Authority123", decoderVersion: "v" },
    { kind: "mintTo", program: "Program123", amountRaw: 12345n, decimals: 2, mint: "Mint12345", destination: "Destination123", authority: "Authority123", decoderVersion: "v" },
    { kind: "setAuthority", program: "Program123", authorityType: "mintTokens", target: "Target123", currentAuthority: "Authority123", newAuthority: null, decoderVersion: "v" },
    { kind: "setAuthority", program: "Program123", authorityType: "accountOwner", target: "Target123", currentAuthority: "Authority123", newAuthority: "NextOwner123", decoderVersion: "v" },
    { kind: "unsupported", program: 'Bad"<program>', reason: "unknown <tag>", dataHex: "00ab", decoderVersion: "v" },
  ] satisfies Decoded[];
  p.effects = [];
  const html = renderHtml(p);
  const sentences = text(html);
  for (const line of [
    "Burn 12345 raw Mint12… from Source… · authority Author… · program Progra…",
    "Transfer 123.45 Mint12… from Source… to Destin… · authority Author…",
    "Transfer 12345 raw tokens from Source… to Destin… · authority Author…",
    "Mint 123.45 to Destin… · authority Author…",
    "Set mintTokens authority of Target…: Author… → none",
    "Set accountOwner authority of Target…: Author… → NextOw…",
  ]) expect(sentences).toContain(line);
  expect(html).toContain('<span title="Destination123">Destin…</span>');
  expect(html).toContain('Unsupported instruction · program <span title="Bad&quot;&lt;program&gt;">');
  expect(html).toContain('unknown &lt;tag&gt; <code>00ab</code>');
  p.effects = [{ id: "fx-0-supply", type: "supplyChange", basis: "decoded", detail: { decimals: 2, display: "-123.45" }, flags: [], evidenceIds: [] }];
  expect(text(renderHtml(p))).toContain("Burn 123.45 Mint12…");
  expect(renderHtml(p)).toContain("supplyChange: -123.45");
});

test("light theme follows system preference or an explicit URL override", async () => {
  const p = await packetFor("mip-14", "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");
  const html = renderHtml(p);
  const colors = "--bg:#ffffff;--fg:#111;--mut:#666;--border:#ddd;--review:#fff6d6";
  expect(html).toContain(`@media (prefers-color-scheme: light){:root{${colors}}}`);
  expect(html).toContain(`:root[data-theme="light"]{${colors}}`);
  const script = html.match(/<script>(.*?)<\/script>/)![1]!;
  for (const [search, expected] of [["?theme=light", "light"], ["?x=1&theme=light", "light"], ["", undefined], ["?theme=dark", undefined]] as const) {
    const document = { documentElement: { dataset: {} as Record<string, string | undefined> } };
    runInNewContext(script, { URLSearchParams, location: { search }, document });
    expect(document.documentElement.dataset.theme).toBe(expected);
  }
  expect(html).toContain('s.src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";s.onload=()=>mermaid.initialize({startOnLoad:true,theme:"dark"});');
});
