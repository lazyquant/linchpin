import { buildPack, type PackFile, type PackRegistry, type DocsCapture } from "./pack/build";
import { renderPackHtml, renderJson, coverageLine } from "./pack/packet";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getGovernanceAccounts, getGovernanceProgramVersion, Governance, pubkeyFilter } from "@solana/spl-governance";
import { DEFAULT_RPC_URL, runOptions } from "./config";
import { RecordingRpc, redactedRpcUrl, redactSecrets } from "./chain/rpc";
import { associatedTokenAccount } from "./pack/classify";
import { formatUnits } from "./chain/token-layout";
import { readProposalBundle, type ProposalBundle } from "./governance/reader";
import { decodeInstruction } from "./governance/decode";
import { attachReceiptShares, effectsFromDecoded } from "./governance/effects";
import { findExecutionReceipt, reconcileReceipt, type Receipt, type Reconciliation } from "./governance/receipt";
import { conditionalPreviewRequest, fixtureBurn, fixtureFor, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS, type SimulationRun, type SkippedFixture } from "./governance/simulate";
import { coverage, loadCase, type CaseFile } from "./governance/claims";
import { buildGraph } from "./graph/build";
import { buildPacket, renderHtml } from "./review/packet";

const args = process.argv.slice(2); const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const safeOutput = (text: string) => redactSecrets(text, process.env.LINCHPIN_RPC_URL ?? DEFAULT_RPC_URL);

async function review(casePath: string) {
  const c = loadCase(casePath);
  const opts = runOptions({ offline: flag("offline"), record: flag("record"), refresh: flag("refresh") || undefined, outDir: opt("out", join("out", c.caseId)) });
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
  console.log(safeOutput(`${c.caseId}: ${packet.dimensions.execution_status} · ${sims.map((s) => `${s.kind}=${s.success ? "ok" : "fail"}`).join(" ") || "no simulation"} · ${rpc.evidence.length} evidence → ${join(opts.outDir, "packet.html")} (${evidencePath})`));
  console.error(safeOutput(`Evidence: ${rpc.counts.live} live, ${rpc.counts.replayed} replayed`));
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

async function pack(packPath: string) {
  if (flag("offline") && flag("record")) throw new Error("pack: --record and --offline are mutually exclusive");
  const config: PackFile = JSON.parse(readFileSync(packPath, "utf8"));
  const registry: PackRegistry = JSON.parse(readFileSync(config.registry, "utf8"));
  const docsCapture: DocsCapture = JSON.parse(readFileSync(config.docsCapture, "utf8"));
  if (config.pack !== registry.pack) throw new Error("pack: config and registry pack names differ");
  const opts = runOptions({ offline: flag("offline"), record: flag("record"), refresh: flag("refresh") || undefined, outDir: opt("out", join("out", `pack-${config.pack}`)) });
  const rpc = new RecordingRpc(opts, `${config.pack}-pack`);
  const packet = await buildPack(rpc, registry, { title: config.title, docsCapture, burns: config.burns, ledger: config.ledger });
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "packet.json"), renderJson(packet));
  writeFileSync(join(opts.outDir, "packet.html"), renderPackHtml(packet, registry.governance.realm));
  // A packet has one evidence log: repeat offline runs replace, rather than append.
  writeFileSync(join(opts.outDir, "evidence.jsonl"), rpc.evidence.map(e => JSON.stringify(e)).join("\n") + "\n");
  console.log(safeOutput(coverageLine(packet)));
  if (config.ledger?.enabled) console.log(safeOutput(`Ledger: ${packet.ledger.entries.length} entries · ${packet.ledger.proposalsScanned} proposals scanned${packet.ledger.notes.includes("ledger not recorded yet") ? " · ledger not recorded yet" : ""}`));
  console.log(safeOutput(`${config.pack}: ${packet.evidenceCount} evidence → ${join(opts.outDir, "packet.html")}`));
  console.error(safeOutput(`Evidence: ${rpc.counts.live} live, ${rpc.counts.replayed} replayed`));
}

function doctorConnection(rpcUrl: string, signal: AbortSignal) {
  return new Connection(rpcUrl, {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      signal.throwIfAborted();
      return fetch(input, { ...init, signal });
    }, { preconnect: fetch.preconnect }),
  });
}

export async function doctor() {
  const opts = runOptions({});
  const errorText = (error: unknown) => redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error), opts.rpcUrl).slice(0, 200);
  const cases = readdirSync("cases").filter((path) => path.endsWith(".json")).sort().map((path) => loadCase(join("cases", path)));
  const versions = new Map<string, { sdkMetadataVersion: number | null; error?: string }>();
  for (const c of cases) {
    if (!versions.has(c.programId)) {
      // The SDK logs caught errors itself. Keep only our scrubbed, per-case JSON lines.
      const log = console.log;
      console.log = () => {};
      try {
        const connection = doctorConnection(opts.rpcUrl, AbortSignal.timeout(15000));
        versions.set(c.programId, { sdkMetadataVersion: await getGovernanceProgramVersion(connection, new PublicKey(c.programId)) });
      } catch (error) { versions.set(c.programId, { sdkMetadataVersion: null, error: errorText(error) }); }
      finally { console.log = log; }
    }
    console.log(JSON.stringify({ caseId: c.caseId, program: c.programId, ...versions.get(c.programId), programVersionPinned: c.programVersion }));
  }

  // The case identifies the proposal; its source account and receipt are in the committed evidence.
  // Resolve them offline so provider failures cannot prevent unrelated probes from running.
  const c = loadCase("cases/mip-14.json");
  const recorded = new RecordingRpc({ ...opts, offline: true, record: false }, c.caseId);
  const bundle = await readProposalBundle(recorded, new PublicKey(c.programId), c.programVersion, new PublicKey(c.proposal));
  const burn = bundle.transactions.flatMap(t => t.instructions.map(decodeInstruction)).find(d => d.kind === "burn");
  if (!burn || burn.kind !== "burn") throw new Error("doctor: MIP-14 burn missing from recorded proposal");
  const registry: PackRegistry = JSON.parse(readFileSync("packs/marinade/registry.json", "utf8"));
  const buyback = registry.accounts.find(a => a.id === "buyback-accumulation");
  const mnde = registry.mints.find(m => m.id === "mnde");
  if (!buyback || !mnde) throw new Error("doctor: buyback wallet or MNDE mint missing from registry");
  let ok = 0; let failed = 0;
  type Details = { slot?: number; count?: number; result?: "succeeded" | "failed" };
  const probe = async (name: string, call: (connection: Connection) => Promise<Details>) => {
    const start = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { const error = new Error("RPC probe timed out after 15000 ms"); controller.abort(error); reject(error); }, 15000);
      });
      const details = await Promise.race([call(doctorConnection(opts.rpcUrl, controller.signal)), timeout]);
      ok++;
      console.log(JSON.stringify({ probe: name, ok: true, ms: Math.round(performance.now() - start), ...details }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ probe: name, ok: false, ms: Math.round(performance.now() - start), error: errorText(error) }));
    } finally { clearTimeout(timer); }
  };
  await probe("getSlot", async connection => ({ slot: await connection.getSlot() }));
  await probe("getAccountInfo", async connection => {
    const response = await connection.getAccountInfoAndContext(new PublicKey(burn.source));
    return { slot: response.context.slot };
  });
  await probe("getProgramAccounts", async connection => {
    // Same SDK path and realm filter as src/pack/classify.ts:listGovernances.
    const accounts = await getGovernanceAccounts(connection, new PublicKey(registry.governance.program), Governance, [pubkeyFilter(1, new PublicKey(registry.governance.realm))!]);
    return { count: accounts.length };
  });
  await probe("getTransaction", async connection => {
    const ptx = bundle.transactions.find(t => t.executedAt != null);
    const receipt = ptx && await findExecutionReceipt(recorded, ptx);
    if (!receipt) throw new Error("doctor: MIP-14 execution receipt missing from recorded evidence");
    const tx = await connection.getTransaction(receipt.signature, { maxSupportedTransactionVersion: 0 });
    return tx ? { slot: tx.slot } : {};
  });
  await probe("simulateTransaction", async connection => {
    const source = new PublicKey(burn.source); const mint = new PublicKey(burn.mint); const treasury = new PublicKey(bundle.governance.nativeTreasury);
    const { tx, config } = conditionalPreviewRequest({ kind: "fixture", label: "fixture: burn 1 MNDE from the same treasury account", instructions: [fixtureBurn(source, mint, new PublicKey(burn.authority), bundle.mints[burn.mint].decimals)], feePayer: treasury, watch: { tokenAccounts: [source], mints: [mint] }, assumptions: PREVIEW_ASSUMPTIONS });
    const response = await connection.simulateTransaction(tx, config);
    return { slot: response.context.slot, result: response.value.err == null ? "succeeded" : "failed" };
  });
  await probe("getSignaturesForAddress", async connection => {
    const account = associatedTokenAccount(new PublicKey(buyback.address), new PublicKey(mnde.address));
    return { count: (await connection.getSignaturesForAddress(account, { limit: 5 })).length };
  });
  console.log(JSON.stringify({ host: redactedRpcUrl(opts.rpcUrl), ok, failed }));
}

if (import.meta.main) {
try {
if (cmd === "review" && args[1]) await review(args[1]);
else if (cmd === "pack" && args[1]) await pack(args[1]);
else if (cmd === "demo") { for (const c of ["cases/mip-14.json", "cases/mip-14-opinion.json", "cases/bonk-bip76.json"]) await review(c); }
else if (cmd === "doctor") await doctor();
else { console.log(safeOutput("usage: linchpin review <case.json> [--offline|--record [--refresh]] [--out dir] | linchpin pack <pack.json> [--offline|--record [--refresh]] [--out dir] | linchpin demo [--offline] | linchpin doctor; modes: --offline (fixtures only), --record (fill missing fixtures), --record --refresh (re-fetch all)")); process.exit(cmd ? 1 : 0); }
} catch (error) {
  console.error(safeOutput(error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
  process.exitCode = 1;
}
}
