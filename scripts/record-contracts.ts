// Maintainer capture/replay. Runtime IDLs always come through RecordingRpc, never test vectors.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOptions } from "../src/config";
import { RecordingRpc, redactSecrets } from "../src/chain/rpc";
import type { PackRegistry } from "../src/pack/build";
import { readContractsLayer, type ContractsInput } from "../src/contracts/marinade";
import { readParticipation } from "../src/contracts/participation";
import { readAuthorities } from "../src/contracts/authorities";
import { readHolders, validateLabels } from "../src/contracts/holders";
import { readFlows } from "../src/contracts/flows";
import type { TreasuryLedger } from "../src/pack/ledger";
import { toPlain } from "../src/contracts/decode";

const args = process.argv.slice(2);
if (args.some(a => !["--record", "--offline", "--refresh"].includes(a)) || (args.includes("--record") && args.includes("--offline"))) {
  console.error("Usage: bun run scripts/record-contracts.ts [--record|--offline] [--refresh]");
  process.exit(1);
}
const offline = args.includes("--offline") || (!args.includes("--record") && process.env.LINCHPIN_OFFLINE === "1");
const opts = runOptions({ record: !offline, offline, ...(args.includes("--refresh") ? { refresh: true } : {}) });
const rpc = new RecordingRpc(opts, "marinade-contracts");
try {
  const registry: PackRegistry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
  const contracts: ContractsInput = JSON.parse(readFileSync(new URL("../packs/marinade/contracts.json", import.meta.url), "utf8"));
  const layer = await readContractsLayer(rpc, registry, contracts);
  const participation = await readParticipation(rpc, registry, contracts, layer);
  const authorities = await readAuthorities(rpc, registry, layer);
  const docsCapture = JSON.parse(readFileSync(new URL("../packs/marinade/sources/marinade-docs-capture-2026-10-05.json", import.meta.url), "utf8"));
  // B.1 is a prior recorded artifact, not silently re-recorded as part of this layer.
  const ledgerPath = [join(opts.outDir, "marinade/packet.json"), join(opts.outDir, "web/marinade/packet.json")].find(existsSync);
  const packet = ledgerPath ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null;
  const ledger: (TreasuryLedger & { asOf?: string }) | undefined = packet?.ledger ? { ...packet.ledger, asOf: packet.generatedAt } : undefined;
  const labelsDir = new URL("../packs/marinade/sources/labels/", import.meta.url);
  const labels = existsSync(labelsDir) ? readdirSync(labelsDir).filter(name => name.endsWith(".json")).sort()
    .map(name => validateLabels(JSON.parse(readFileSync(new URL(name, labelsDir), "utf8")))) : [];
  const holders = await readHolders(rpc, registry, layer, participation, authorities, labels);
  const flows = await readFlows(rpc, registry, layer, participation, holders, docsCapture, ledger);
  const outDir = join(opts.outDir, "contracts-marinade");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "contracts.json"), JSON.stringify(toPlain(layer), null, 2) + "\n");
  writeFileSync(join(outDir, "participation.json"), JSON.stringify(toPlain(participation), null, 2) + "\n");
  writeFileSync(join(outDir, "authorities.json"), JSON.stringify(toPlain(authorities), null, 2) + "\n");
  writeFileSync(join(outDir, "flows.json"), JSON.stringify(toPlain(flows), null, 2) + "\n");
  writeFileSync(join(outDir, "holders.json"), JSON.stringify(toPlain(holders), null, 2) + "\n");
  rpc.flushEvidence(outDir);
  const classified = [
    ...layer.authorities.map(a => a.classification),
    ...layer.programs.flatMap(p => p.upgradeAuthority.classification ? [p.upgradeAuthority.classification] : []),
    layer.registrar.realmAuthority.classification,
    ...layer.registrar.votingMints.map(m => m.grantAuthority.classification),
    ...layer.parameterControl.links.flatMap(l => l.signers.flatMap(s => s.classification ? [s.classification] : [])),
  ];
  console.log(JSON.stringify({ output: join(outDir, "contracts.json"), programsWithIdl: layer.programs.filter(p => p.idl.kind === "idl").length,
    decodedSingletons: layer.singletons.map(s => s.id), enumerationCounts: layer.enumerations.map(e => ({ program: e.program, account: e.account, mode: e.mode, count: e.count })),
    participation: { lockedMnde: participation.vsr.timeLocked.display, lockedShareOfSupply: participation.vsr.timeLockedShareOfSupply.value,
      depositedMnde: participation.vsr.totalDeposited.display, shareOfSupply: participation.vsr.shareOfSupply.value,
      top10VoterShare: participation.vsr.top10ShareOfDeposits.value,
      reconciliation: { matched: participation.vsr.reconciliation.matched.value, mismatched: participation.vsr.reconciliation.mismatched.value,
        missing: participation.vsr.reconciliation.missing.value, depositsRaw: participation.vsr.reconciliation.deposits.raw, vaultBalancesRaw: participation.vsr.reconciliation.vaultBalances.raw },
      dormantPrograms: participation.activity.filter(p => p.dormant.value).map(p => p.program),
      directedStakeTotal: participation.directedStake.total.value, referralPartners: participation.referral.partners.map(p => p.name), ticketCheck: participation.delayedUnstake.countsAgree.value },
    holders: { mndeNonzeroOwners: holders.mnde.distinctNonZeroOwners.value, mndeSupplyDifferenceRaw: holders.mnde.differenceFromSupplyRaw.value,
      msolSupplyDifferenceRaw: holders.msol.differenceFromSupplyRaw.value, floatVerifiedOnlyRaw: holders.float.verifiedOnly.raw, floatIncludingClaimedRaw: holders.float.includingClaimed.raw },
    flows: { treasuryTransactions: flows.treasury.transactionsRead.value, buybackTransactions: flows.buybacks.transactions.length,
      claims: flows.claims.map(c => ({ id: c.id, status: c.status, chainResult: c.chainResult })) },
    authorityResolution: { resolved: authorities.resolved.value, unresolved: authorities.unresolved.value },
    parameters: layer.parameters.length, classifiedAuthorities: new Set(classified.map(a => a.address)).size, claimV1: layer.claims[0], reads: rpc.counts,
    failedChecks: layer.checks.filter(c => c.status !== "verified"), priceSanity: layer.parameters.find(p => p.field === "msolPrice")?.scaling?.sanityCheck }, null, 2));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error), opts.rpcUrl));
  process.exitCode = 1;
}
