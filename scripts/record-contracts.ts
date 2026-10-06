// Maintainer capture/replay. Runtime IDLs always come through RecordingRpc, never test vectors.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOptions } from "../src/config";
import { RecordingRpc, redactSecrets } from "../src/chain/rpc";
import type { PackRegistry } from "../src/pack/build";
import { readContractsLayer, type ContractsInput } from "../src/contracts/marinade";
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
  const outDir = join(opts.outDir, "contracts-marinade");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "contracts.json"), JSON.stringify(toPlain(layer), null, 2) + "\n");
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
    parameters: layer.parameters.length, classifiedAuthorities: new Set(classified.map(a => a.address)).size, claimV1: layer.claims[0], reads: rpc.counts,
    failedChecks: layer.checks.filter(c => c.status !== "verified"), priceSanity: layer.parameters.find(p => p.field === "msolPrice")?.scaling?.sanityCheck }, null, 2));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error), opts.rpcUrl));
  process.exitCode = 1;
}
