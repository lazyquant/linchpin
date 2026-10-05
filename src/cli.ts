import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getGovernanceProgramVersion } from "@solana/spl-governance";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "./config";
import { RecordingRpc } from "./chain/rpc";
import { readProposalBundle } from "./governance/reader";
import { decodeInstruction } from "./governance/decode";
import { attachReceiptShares, effectsFromDecoded } from "./governance/effects";
import { findExecutionReceipt, reconcileReceipt } from "./governance/receipt";
import { fixtureBurn, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS } from "./governance/simulate";
import { coverage, loadCase } from "./governance/claims";
import { buildGraph } from "./graph/build";
import { buildPacket, renderHtml } from "./review/packet";

const args = process.argv.slice(2); const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

async function review(casePath: string) {
  const c = loadCase(casePath);
  const opts = runOptions({ offline: flag("offline"), record: flag("record"), outDir: opt("out", join("out", c.caseId)) });
  const rpc = new RecordingRpc(opts, c.caseId);
  const programId = new PublicKey(c.programId);
  const bundle = await readProposalBundle(rpc, programId, c.programVersion, new PublicKey(c.proposal));
  const decoded = bundle.transactions.flatMap((t) => t.instructions.map(decodeInstruction));
  const ptx = bundle.transactions[0] ?? null;
  const receipt = ptx ? await findExecutionReceipt(rpc, ptx) : null;
  const effects = effectsFromDecoded(decoded, bundle, { nativeTreasury: bundle.governance.nativeTreasury });
  attachReceiptShares(effects, receipt);
  const reconciliation = ptx ? reconcileReceipt(decoded, ptx, receipt) : { status: "not-executed" as const, expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no proposal transactions"] };
  const sims = [];
  if (ptx && ptx.instructions.length) {
    const treasury = new PublicKey(bundle.governance.nativeTreasury);
    const tokenAccounts = Object.keys(bundle.tokenAccounts).map((k) => new PublicKey(k)); const mints = Object.keys(bundle.mints).map((k) => new PublicKey(k));
    sims.push(await simulateConditionalPreview(rpc, { kind: "historical-payload", label: `${c.caseId} payload against current state`, instructions: ptx.instructions.map(toTransactionInstruction), feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: PREVIEW_ASSUMPTIONS }));
    const d = decoded.find((x) => x.kind === "burn");
    if (c.fixture.burnOneToken && d && d.kind === "burn") sims.push(await simulateConditionalPreview(rpc, { kind: "fixture", label: "fixture: burn 1 whole token from the same treasury account (not the historical payload)", instructions: [fixtureBurn(new PublicKey(d.source), new PublicKey(d.mint), new PublicKey(d.authority), bundle.mints[d.mint]?.decimals ?? 9)], feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: [...PREVIEW_ASSUMPTIONS, "amount replaced by one whole token so the preview can succeed under current balances"] }));
  }
  const decimals = bundle.mints[bundle.proposal.governingTokenMint]?.decimals ?? 9;
  const cov = coverage(c.claims, effects, { decimals, claimedPreSupplyRaw: c.claimedPreSupply ? BigInt(c.claimedPreSupply.raw) : null });
  const graph = buildGraph(bundle, decoded, effects, receipt, sims, c.claims);
  const packet = buildPacket({ caseId: c.caseId, title: c.title, offline: opts.offline, bundle, decoded, effects, sims, receipt, reconciliation, claims: c.claims, coverage: cov, graph, evidenceCount: rpc.evidence.length });
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "packet.json"), JSON.stringify(packet, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  writeFileSync(join(opts.outDir, "packet.html"), renderHtml(packet));
  writeFileSync(join(opts.outDir, "graph.json"), JSON.stringify(graph, null, 1));
  const evidencePath = rpc.flushEvidence(opts.outDir);
  console.log(`${c.caseId}: ${packet.dimensions.execution_status} · ${sims.map((s) => `${s.kind}=${s.success ? "ok" : "fail"}`).join(" ") || "no simulation"} · ${rpc.evidence.length} evidence → ${join(opts.outDir, "packet.html")} (${evidencePath})`);
}

async function doctor() {
  const opts = runOptions({}); const rpc = new RecordingRpc(opts, "doctor");
  const v = await getGovernanceProgramVersion(rpc.connection, MARINADE_GOVERNANCE_PROGRAM);
  console.log(JSON.stringify({ rpcUrl: opts.rpcUrl, program: MARINADE_GOVERNANCE_PROGRAM.toBase58(), programVersionLive: v, programVersionPinned: MARINADE_PROGRAM_VERSION, ok: v === MARINADE_PROGRAM_VERSION }));
}

if (cmd === "review" && args[1]) await review(args[1]);
else if (cmd === "demo") { for (const c of ["cases/mip-14.json", "cases/mip-14-opinion.json"]) await review(c); }
else if (cmd === "doctor") await doctor();
else { console.log("usage: linchpin review <case.json> [--offline] [--record] [--out dir] | linchpin demo [--offline] | linchpin doctor"); process.exit(cmd ? 1 : 0); }
