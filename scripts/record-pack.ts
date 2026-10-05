// Maintainer-only network capture: bun run scripts/record-pack.ts
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { runOptions } from "../src/config";
import { RecordingRpc } from "../src/chain/rpc";
import { readProgramAuthority } from "../src/chain/program-authority";
import { associatedTokenAccount, classifyAuthority, listGovernances, readMintState, readTokenAccount } from "../src/pack/classify";

type Registry = {
  programs: { id: string; address: string }[];
  mints: { id: string; address: string }[];
  accounts: { id: string; address: string }[];
  governance: { program: string; realm: string; knownGovernances: { address: string }[] };
};

const registry: Registry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
const rpc = new RecordingRpc(runOptions({ record: true }), "marinade-pack");
const program = new PublicKey(registry.governance.program);
const realm = new PublicKey(registry.governance.realm);
const discovery = await listGovernances(rpc, program, realm);
const ctx = { program, governances: [...new Set([
  ...registry.governance.knownGovernances.map(g => g.address),
  ...discovery.governances.map(g => g.address),
])].map(address => new PublicKey(address)) };
const counts = { programs: 0, upgradeAuthorities: 0, mints: 0, mintAuthorities: 0, registryAccounts: 0, tokenAccounts: 0, skippedAccounts: 0, walletAtas: 0, walletAtasFound: 0, governances: discovery.governances.length };
const programs = [];
for (const entry of registry.programs) {
  const state = await readProgramAuthority(rpc, new PublicKey(entry.address));
  const authority = state.kind === "upgradeable" ? state.upgradeAuthority : null;
  const classification = authority ? await classifyAuthority(rpc, new PublicKey(authority), ctx) : null;
  counts.programs++;
  if (classification) counts.upgradeAuthorities++;
  programs.push({ id: entry.id, address: entry.address, authority, authorityKind: classification?.kind ?? (state.kind === "upgradeable" ? "immutable" : state.kind) });
}
for (const entry of registry.mints) {
  const mint = await readMintState(rpc, new PublicKey(entry.address));
  counts.mints++;
  if (mint.value?.mintAuthority) {
    await classifyAuthority(rpc, new PublicKey(mint.value.mintAuthority), ctx);
    counts.mintAuthorities++;
  }
}
const mnde = registry.mints.find(mint => mint.id === "mnde");
if (!mnde) throw new Error("registry has no MNDE mint");
for (const entry of registry.accounts) {
  const address = new PublicKey(entry.address);
  const classification = await classifyAuthority(rpc, address, ctx);
  counts.registryAccounts++;
  if (classification.kind === "token-account") {
    await readTokenAccount(rpc, address);
    counts.tokenAccounts++;
  } else {
    counts.skippedAccounts++;
  }
  if (classification.kind === "wallet" || classification.kind === "wallet-no-account") {
    const ata = await readTokenAccount(rpc, associatedTokenAccount(address, new PublicKey(mnde.address)));
    counts.walletAtas++;
    if (ata.value) counts.walletAtasFound++;
  }
}
console.log(JSON.stringify({ caseId: rpc.caseId, counts: { ...counts, evidence: rpc.evidence.length }, programs }, null, 2));
