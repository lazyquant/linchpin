import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction, type Decoded } from "../src/governance/decode";
import { attachReceiptShares, effectsFromDecoded } from "../src/governance/effects";
import { findExecutionReceipt, reconcileReceipt } from "../src/governance/receipt";
import { coverage, loadCase } from "../src/governance/claims";
import { reviewBundle } from "../src/cli";
import { buildGraph } from "../src/graph/build";
import { buildPacket, renderHtml } from "../src/review/packet";

test("BonkDAO offline packet distinguishes account creation, movement reconciliation and simulation payloads", async () => {
  const c = loadCase("cases/bonk-bip76.json");
  const rpc = new RecordingRpc(runOptions({ offline: true, rpcUrl: "http://127.0.0.1:1" }), c.caseId);
  const b = await readProposalBundle(rpc, new PublicKey(c.programId), c.programVersion, new PublicKey(c.proposal));
  const p = await reviewBundle(c, rpc, b);
  const html = renderHtml(p);
  const text = html.replace(/<[^>]*>/g, "");
  const longPayload = p.decoded.find((d) => d.kind === "unsupported" && d.dataHex.length === 290);
  expect(longPayload?.kind).toBe("unsupported");
  if (!longPayload || longPayload.kind !== "unsupported") throw new Error("missing long unsupported payload");
  expect(html).toContain(` · data <code>${longPayload.dataHex.slice(0, 16)}…</code><details><summary>full data (145 bytes)</summary><code>${longPayload.dataHex}</code></details>`);
  const inlineHtml = html.replace(/<details>[\s\S]*?<\/details>/g, "");
  expect(inlineHtml).not.toMatch(/<code>[0-9a-f]{290}<\/code>/i);
  expect(p.observed.reconciliations.map((r) => r.status)).toEqual(["not-reconcilable", "not-reconcilable", "not-reconcilable", "matched"]);
  expect(p.dimensions.execution_status).toBe("observed: all token movements match (1/1); 3 executed transactions not reconcilable");
  expect(p.checks.find((r) => r.check === "Observed execution")).toMatchObject({ result: "matched 1/1 token movements, 3 executed transactions without token movements (unsupported or non-token instructions)", needsReview: false });
  expect(html).toContain("Account creation");
  const creation = p.decoded.find((d) => d.kind === "createAccount")!;
  expect(creation.kind).toBe("createAccount");
  if (creation.kind !== "createAccount") throw new Error("missing ATA creation");
  const row = p.checks.find((r) => r.check === "Account creation")!;
  expect(row.needsReview).toBe(true);
  expect(row.result).toBe("acct 28Ayms… (owner 9bxWkN…, mint DezXAZ…) — destination of the treasury transfer in this proposal");
  expect(p.effects.find((e) => e.type === "accountCreation")?.detail).toMatchObject({ account: creation.account, owner: creation.owner, mint: creation.mint });
  expect(text).toContain(`Create token account 28Ayms… for owner 9bxWkN… · mint DezXAZ…${creation.idempotent ? " · idempotent" : ""}`);
  expect(p.graph.nodes.find((n) => n.id === `ta:${creation.account}`)?.type).toBe("TokenAccount");
  const txIndex = p.decoded.indexOf(creation);
  expect(p.graph.edges).toContainEqual({ from: `ix:${b.transactions[txIndex].address}:0`, to: `ta:${creation.account}`, type: "CREATES", basis: "decoded", evidenceIds: [b.transactions[txIndex].evidenceId] });
  expect(p.checks.find((r) => r.check === "Unknown / unsupported")!.result).not.toContain("AToken");
  for (const sim of p.simulated) {
    const label = sim.kind === "fixture"
      ? "fixture tx 4/4: transfer 0.00033 (33 raw) — not the historical payload"
      : `tx ${sim.txIndex! + 1}/4 ${b.transactions[sim.txIndex!].address.slice(0, 6)}… · ${p.decoded[sim.txIndex!].kind === "unsupported" ? p.decoded[sim.txIndex!].program.slice(0, 6) + "…" : p.decoded[sim.txIndex!].kind} payload against current state`;
    expect(sim.label).toBe(label);
    expect(p.dimensions.simulation_result).toContain(`${label}: ${sim.success ? "success" : "failed"}`);
    expect(text).toContain(label);
  }
  expect(p.simulated).toHaveLength(5);
  for (const r of p.observed.receipts) {
    const rec = p.observed.reconciliations[r.txIndex];
    expect(text).toContain(`tx ${r.txIndex + 1}/4 · ${r.signature.slice(0, 6)}… · slot ${r.slot} · +${r.blockTime! - p.proposal.votingCompletedAt!} s after voting completed · ${rec.status}`);
    for (const balance of r.tokenBalances) expect(text).toContain(`${balance.preRaw} → ${balance.postRaw} (Δ ${balance.deltaRaw})`);
  }
  const vote = p.checks.find((r) => r.check === "Vote outcome")!.result;
  expect(vote).toContain("margin 0.0028 pp (2,436,253,307.76147 DezXAZ…)");
  expect(vote).toContain("execution began 38 s after voting completed, last transaction at 49 s");
  expect(vote).not.toContain(p.proposal.governingTokenMint);
  expect(vote).not.toContain("tokens");
});

async function packetFor(caseId: string, proposal: string, withReceipt = false, omitBalances = false) {
  const rpc = new RecordingRpc(runOptions({ offline: true }), caseId);
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
  const indexed = b.transactions.flatMap((t, txIndex) => t.instructions.map((ix, ixIndex) => ({ txIndex, ixIndex, decoded: decodeInstruction(ix) })));
  const decoded = indexed.map((i) => i.decoded);
  const receipt = withReceipt ? await findExecutionReceipt(rpc, b.transactions[0]) : null;
  if (receipt && omitBalances) receipt.tokenBalances = [];
  const effects = effectsFromDecoded(indexed, b, { nativeTreasury: b.governance.nativeTreasury });
  attachReceiptShares(effects, receipt ? [receipt] : []);
  const rec = b.transactions[0] ? reconcileReceipt(decoded, b.transactions[0], receipt) : { status: "not-executed" as const, expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transactions"] };
  const cov = coverage([], effects, { decimals: 9, claimedPreSupplyRaw: null });
  return buildPacket({ caseId, title: caseId, offline: true, bundle: b, decoded, effects, sims: [], receipts: receipt ? [receipt] : [], reconciliations: b.transactions.length ? [rec] : [], claims: [], coverage: cov, graph: buildGraph(b, decoded, effects, [], [], []), evidenceCount: rpc.evidence.length });
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
  expect(row.result).toContain(`68.3479% of the source balance at execution (slot ${withReceipt.observed.receipts[0].slot}, receipt); today's balance 153,600,023.53633485 at slot 453658036`);
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
    { kind: "createAccount", program: "ATA", account: "Account123", owner: "Owner123", mint: "Mint123", payer: "Payer123", idempotent: true, decoderVersion: "v" },
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
    "Create token account Accoun… for owner Owner1… · mint Mint12… · idempotent",
  ]) expect(sentences).toContain(line);
  expect(html).toContain('<span title="Destination123">Destin…</span>');
  expect(html).toContain('Unsupported instruction · program <span title="Bad&quot;&lt;program&gt;">');
  expect(html).toContain('unknown &lt;tag&gt; · data <code>00ab</code></li>');
  p.effects = [{ id: "fx-0-0-supply", type: "supplyChange", basis: "decoded", detail: { decimals: 2, display: "-123.45" }, flags: [], evidenceIds: [] }];
  expect(text(renderHtml(p))).toContain("Burn 123.45 Mint12…");
  expect(renderHtml(p)).toContain("supplyChange: -123.45");
});

test("unsupported payloads stay inline through 16 hex characters and expand beyond that", async () => {
  const p = await packetFor("mip-14", "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");
  for (const dataHex of ["", "00ab", "0123456789abcdef", "0123456789abcdefab"]) {
    p.decoded = [{ kind: "unsupported", program: "Program123", reason: "unknown instruction", dataHex, decoderVersion: "v" }];
    const html = renderHtml(p);
    const prefix = 'Unsupported instruction · program <span title="Program123">Progra…</span> · unknown instruction · data ';
    if (dataHex.length <= 16) {
      expect(html).toContain(`${prefix}<code>${dataHex}</code></li>`);
      expect(html).not.toContain("<summary>full data (");
    } else {
      expect(html).toContain(`${prefix}<code>0123456789abcdef…</code><details><summary>full data (9 bytes)</summary><code>${dataHex}</code></details></li>`);
    }
  }
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
