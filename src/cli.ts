import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getGovernanceProgramVersion } from "@solana/spl-governance";
import { runOptions } from "./config";
import { RecordingRpc } from "./chain/rpc";
import { formatUnits } from "./chain/token-layout";
import { readProposalBundle, type ProposalBundle } from "./governance/reader";
import { decodeInstruction } from "./governance/decode";
import { attachReceiptShares, effectsFromDecoded } from "./governance/effects";
import { findExecutionReceipt, reconcileReceipt, type Receipt, type Reconciliation } from "./governance/receipt";
import { fixtureFor, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS, type SimulationRun, type SkippedFixture } from "./governance/simulate";
import { coverage, loadCase, type CaseFile } from "./governance/claims";
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
  const packet = await reviewBundle(c, rpc, bundle);
  const sims = packet.simulated;
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "packet.json"), JSON.stringify(packet, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  writeFileSync(join(opts.outDir, "packet.html"), renderHtml(packet));
  writeFileSync(join(opts.outDir, "graph.json"), JSON.stringify(packet.graph, null, 1));
  const evidencePath = rpc.flushEvidence(opts.outDir);
  console.log(`${c.caseId}: ${packet.dimensions.execution_status} · ${sims.map((s) => `${s.kind}=${s.success ? "ok" : "fail"}`).join(" ") || "no simulation"} · ${rpc.evidence.length} evidence → ${join(opts.outDir, "packet.html")} (${evidencePath})`);
}

/** Shared CLI pipeline; tests can provide recorded or in-memory RPC responses. */
export async function reviewBundle(c: CaseFile, rpc: RecordingRpc, bundle: ProposalBundle) {
  const indexed = bundle.transactions.flatMap((t, txIndex) => t.instructions.map((ix, ixIndex) => ({ txIndex, ixIndex, decoded: decodeInstruction(ix) })));
  const decoded = indexed.map((i) => i.decoded);
  const effects = effectsFromDecoded(indexed, bundle, { nativeTreasury: bundle.governance.nativeTreasury });
  const receipts: Receipt[] = []; const reconciliations: Reconciliation[] = [];
  const sims: SimulationRun[] = []; const skippedFixtures: SkippedFixture[] = [];
  for (const [txIndex, ptx] of bundle.transactions.entries()) {
    const decodedForThatTx = indexed.filter((i) => i.txIndex === txIndex);
    const receipt = ptx.executedAt != null ? await findExecutionReceipt(rpc, ptx, txIndex) : null;
    if (receipt) receipts.push(receipt);
    reconciliations.push(reconcileReceipt(decodedForThatTx.map((i) => i.decoded), ptx, receipt));
    if (!ptx.instructions.length) continue;
    const treasury = new PublicKey(bundle.governance.nativeTreasury);
    const tokenAccounts = Object.keys(bundle.tokenAccounts).map((k) => new PublicKey(k)); const mints = Object.keys(bundle.mints).map((k) => new PublicKey(k));
    const payloadKinds = decodedForThatTx.map(({ decoded: d }) => d.kind === "unsupported" ? `${d.program.slice(0, 6)}…` : d.kind).join(", ");
    sims.push({ ...await simulateConditionalPreview(rpc, { kind: "historical-payload", label: `tx ${txIndex + 1}/${bundle.transactions.length} ${ptx.address.slice(0, 6)}… · ${payloadKinds} payload against current state`, instructions: ptx.instructions.map(toTransactionInstruction), feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: PREVIEW_ASSUMPTIONS }), txIndex });
    if (!(c.fixture.oneToken ?? c.fixture.burnOneToken)) continue;
    for (const { decoded: d, ixIndex } of decodedForThatTx) {
      if (d.kind !== "burn" && d.kind !== "transfer") continue;
      const source = bundle.tokenAccounts[d.source];
      const mint = d.mint ?? source?.mint;
      const decimals = d.decimals ?? (mint ? bundle.mints[mint]?.decimals : undefined);
      if (!source || decimals == null) {
        skippedFixtures.push({ txIndex, ixIndex, reason: "fixture skipped: source balance or decimals not captured" });
        continue;
      }
      const fixture = fixtureFor(d.kind === "transfer" ? { ...d, mint: mint ?? null } : d, source.amountRaw, decimals);
      if (!fixture) {
        skippedFixtures.push({ txIndex, ixIndex, reason: "fixture skipped: source balance is 0 at capture" });
        continue;
      }
      const amount = fixture.instruction.data.readBigUInt64LE(1);
      sims.push({ ...await simulateConditionalPreview(rpc, { kind: "fixture", label: `fixture tx ${txIndex + 1}/${bundle.transactions.length}: ${d.kind} ${formatUnits(amount, decimals)} (${amount} raw) — not the historical payload`, instructions: [fixture.instruction], feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: [...PREVIEW_ASSUMPTIONS, "amount replaced by at most one whole token, capped at the source balance at capture"] }), txIndex, ixIndex });
    }
  }
  attachReceiptShares(effects, receipts);
  const decimals = bundle.mints[bundle.proposal.governingTokenMint]?.decimals ?? 9;
  const cov = coverage(c.claims, effects, { decimals, claimedPreSupplyRaw: c.claimedPreSupply ? BigInt(c.claimedPreSupply.raw) : null });
  const graph = buildGraph(bundle, decoded, effects, receipts, sims, c.claims);
  return buildPacket({ caseId: c.caseId, title: c.title, offline: rpc.opts.offline, bundle, decoded, effects, sims, skippedFixtures, receipts, reconciliations, claims: c.claims, coverage: cov, graph, evidenceCount: rpc.evidence.length });
}

async function doctor() {
  const opts = runOptions({}); const rpc = new RecordingRpc(opts, "doctor");
  const cases = readdirSync("cases").filter((path) => path.endsWith(".json")).sort().map((path) => loadCase(join("cases", path)));
  const versions = new Map<string, number>();
  for (const c of cases) {
    if (!versions.has(c.programId)) versions.set(c.programId, await getGovernanceProgramVersion(rpc.connection, new PublicKey(c.programId)));
    console.log(JSON.stringify({ caseId: c.caseId, program: c.programId, sdkMetadataVersion: versions.get(c.programId), programVersionPinned: c.programVersion }));
  }
}

if (import.meta.main) {
if (cmd === "review" && args[1]) await review(args[1]);
else if (cmd === "demo") { for (const c of ["cases/mip-14.json", "cases/mip-14-opinion.json", "cases/bonk-bip76.json"]) await review(c); }
else if (cmd === "doctor") await doctor();
else { console.log("usage: linchpin review <case.json> [--offline] [--record] [--out dir] | linchpin demo [--offline] | linchpin doctor"); process.exit(cmd ? 1 : 0); }
}
