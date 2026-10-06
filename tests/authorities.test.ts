import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { runOptions } from "../src/config";
import { RecordingRpc } from "../src/chain/rpc";
import { readAuthorities, authorityInputs, resolveController, controllerDerivations, transactionInstructions, SERUM_LAYOUT, SQUADS_LAYOUT, SQUADS_V4, MSOL_UPGRADE_AUTHORITY, type ObservedInstruction } from "../src/contracts/authorities";
import { idlAddress, type LegacyIdl } from "../src/contracts/idl";
import { readContractsLayer, type ContractsInput } from "../src/contracts/marinade";
import type { ContractsLayer } from "../src/contracts/participation";
import type { PackRegistry } from "../src/pack/build";
import { key, accountBytes, hasFixture } from "./helpers/contracts";

const registry: PackRegistry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
const contracts: ContractsInput = JSON.parse(readFileSync(new URL("../packs/marinade/contracts.json", import.meta.url), "utf8"));
const program = new PublicKey(key(30)), candidate = new PublicKey(key(31)), realm = new PublicKey(key(32));
const context = { program, governances: [] };
const ix = (program: string, accounts: string[]): ObservedInstruction => ({ index: 0, program, accounts, dataHex: "" });
const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, executable: false, lamports: 1, rentEpoch: 0 });
const emptyLayer = { programs: [], authorities: [], registrar: { realmAuthority: { classification: null }, votingMints: [] }, parameterControl: { links: [] }, evidence: [] } as unknown as ContractsLayer;
function recorder(infos: Map<string, AccountInfo<Buffer>> = new Map()) {
  const rpc = new RecordingRpc(runOptions({ record: false, offline: false, minIntervalMs: 0, rpcUrl: "http://127.0.0.1:1" }), "synthetic-authorities");
  rpc.connection.getAccountInfoAndContext = async k => ({ context: { slot: 42 }, value: infos.get(k.toBase58()) ?? null });
  rpc.connection.getProgramAccounts = (async () => ({ context: { slot: 42 }, value: [] })) as any;
  return rpc;
}
async function putIdl(infos: Map<string, AccountInfo<Buffer>>, program: PublicKey, idl: LegacyIdl) {
  const json = deflateSync(Buffer.from(JSON.stringify(idl))), header = Buffer.alloc(44); header.writeUInt32LE(json.length, 40);
  infos.set((await idlAddress(program)).toBase58(), info(program, Buffer.concat([header, json])));
}
function governanceInfos() {
  // SPL Governance V1 ordered fields (SDK schema), independent of Anchor layouts.
  const g = Buffer.alloc(100); g[0] = 3; realm.toBuffer().copy(g, 1); candidate.toBuffer().copy(g, 33);
  const name = Buffer.from("Synthetic realm"), r = Buffer.alloc(72 + name.length); r[0] = 1; new PublicKey(key(33)).toBuffer().copy(r, 1); r.writeUInt32LE(name.length, 68); name.copy(r, 72);
  return new Map([[candidate.toBase58(), info(program, g)], [realm.toBase58(), info(program, r)]]);
}
function rawTx(programId: string, accounts: string[], authority: string, innerUpgrade = false) {
  const keys = [key(2), programId, ...accounts, authority, "BPFLoaderUpgradeab1e11111111111111111111111", key(11), key(12)];
  return { slot: 555, blockTime: 123456, transaction: { signatures: ["sig"], message: { header: { numRequiredSignatures: 1 }, accountKeys: keys,
    instructions: [{ programIdIndex: 1, accounts: accounts.map((_, i) => 2 + i), data: "" }] } }, meta: { err: null, innerInstructions: [{ index: 0, instructions: [
      { programIdIndex: 1, accounts: [2 + accounts.length], data: "" },
      ...(innerUpgrade ? [{ programIdIndex: keys.length - 3, accounts: [keys.length - 2, keys.length - 1], data: bs58.encode(Buffer.from([3, 0, 0, 0])) }] : []),
    ] }] } };
}
function observed(rpc: RecordingRpc, authority: string, transaction: any) {
  rpc.connection.getSignaturesForAddress = async (_k, opts) => { expect(opts?.limit).toBe(50); return [{ signature: "sig", slot: 555, blockTime: 123456, err: null, memo: null }]; };
  rpc.connection.getTransaction = async () => transaction;
  return readAuthorities(rpc, registry, emptyLayer, [authority]);
}

describe("controller derivation and decoded state", () => {
  test("custom governance native treasury resolves to governance and named realm", async () => {
    const authority = PublicKey.findProgramAddressSync([Buffer.from("native-treasury"), candidate.toBuffer()], program)[0].toBase58();
    const rpc = recorder(governanceInfos()), result = await observed(rpc, authority, rawTx(program.toBase58(), [candidate.toBase58()], authority));
    const row = result.authorities[0], r = row.resolutions[0] as any;
    expect(row.status).toBe("resolved"); expect(r.basis).toBe("derived"); expect(r.realmName).toBe("Synthetic realm"); expect(r.realm).toBe(realm.toBase58());
    expect(row.observations[0].transactionSigner).toBe(false); expect(row.observations[0].cpiAppearances[0].basis).toBe("observed");
    expect(row.observations[0].controllerInstructions[0].accounts).toEqual([candidate.toBase58()]);
    expect(row.programs[0].transactions).toBe(1); expect(row.programs[0].oldestBlockTime).toBe(123456);
    expect(r.evidenceIds.length).toBeGreaterThanOrEqual(4); expect(() => JSON.stringify(result)).not.toThrow();
  });
  test.each([false, true])("Serum-style multisig derives from observed program, on-chain IDL=%s", async onChain => {
    const [authority, bump] = PublicKey.findProgramAddressSync([candidate.toBuffer()], program);
    const infos = new Map([[candidate.toBase58(), info(program, accountBytes(SERUM_LAYOUT, "Multisig", { owners: [key(1), key(2), key(3)], threshold: 2, nonce: bump, ownerSetSeqno: 7 }))]]);
    if (onChain) await putIdl(infos, program, SERUM_LAYOUT);
    const result = await observed(recorder(infos), authority.toBase58(), rawTx(program.toBase58(), [candidate.toBase58()], authority.toBase58()));
    const r = result.authorities[0].resolutions[0] as any;
    expect(result.authorities[0].status).toBe("resolved"); expect(r.threshold).toBe("2"); expect(r.ownerSetSequenceNumber).toBe("7");
    expect(r.owners).toHaveLength(3); expect(r.owners.every((o: any) => o.classification.address === o.address)).toBe(true);
    expect(r.layoutBasis).toBe(onChain ? "declared" : "claimed"); expect(r.basis).toBe("derived");
  });
  test.each([false, true])("Squads vault index 3 resolves members and permissions, on-chain IDL=%s", async onChain => {
    const squads = new PublicKey(SQUADS_V4), authority = PublicKey.findProgramAddressSync([Buffer.from("multisig"), candidate.toBuffer(), Buffer.from("vault"), Buffer.from([3])], squads)[0];
    const infos = new Map([[candidate.toBase58(), info(squads, accountBytes(SQUADS_LAYOUT, "Multisig", { threshold: 1, members: [{ key: key(1), permissions: 7 }, { key: key(2), permissions: 2 }] }))]]);
    if (onChain) await putIdl(infos, squads, SQUADS_LAYOUT);
    const result = await observed(recorder(infos), authority.toBase58(), rawTx(SQUADS_V4, [candidate.toBase58()], authority.toBase58()));
    const r = result.authorities[0].resolutions[0] as any;
    expect(r.status).toBe("resolved"); expect(r.derivation.vaultIndex).toBe(3); expect(r.threshold).toBe("1"); expect(r.members[0].permissions).toBe(7);
  });
  test("CPI appearance without PDA match stays unresolved", async () => {
    const result = await observed(recorder(), key(90), rawTx(program.toBase58(), [candidate.toBase58()], key(90)));
    expect(result.authorities[0].status).toBe("unresolved"); expect(result.authorities[0].resolutions).toHaveLength(0);
    expect(result.authorities[0].observations[0].cpiAppearances).toHaveLength(1);
  });
  test("matching PDA with wrong owner, invalid account type or invalid nonce stays unresolved", async () => {
    const authority = PublicKey.findProgramAddressSync([Buffer.from("native-treasury"), candidate.toBuffer()], program)[0].toBase58();
    const match = controllerDerivations(authority, ix(program.toBase58(), [candidate.toBase58()]))[0];
    expect((await resolveController(recorder(new Map([[candidate.toBase58(), info(SystemProgram.programId, Buffer.alloc(100))]])), match, context)).status).toBe("unresolved");
    expect((await resolveController(recorder(new Map([[candidate.toBase58(), info(program, Buffer.alloc(100))]])), match, context)).status).toBe("unresolved");
    const [serum, bump] = PublicKey.findProgramAddressSync([candidate.toBuffer()], program), serumMatch = controllerDerivations(serum.toBase58(), ix(program.toBase58(), [candidate.toBase58()]))[0];
    const infos = new Map([[candidate.toBase58(), info(program, accountBytes(SERUM_LAYOUT, "Multisig", { owners: [key(1)], threshold: 1, nonce: (bump + 1) % 256 }))]]);
    expect((await resolveController(recorder(infos), serumMatch, context)).status).toBe("unresolved");
  });
  test("inputs deduplicate every eligible G1 classification and exclude other classes", () => {
    const layer = { ...emptyLayer,
      authorities: [{ classification: { kind: "wallet", address: key(60) } }, { classification: { kind: "program-owned", address: key(61) } }],
      programs: [{ upgradeAuthority: { classification: { kind: "native-treasury-pda", address: key(62) } } }],
      registrar: { realmAuthority: { classification: { kind: "pda-system", address: key(63) } }, votingMints: [{ grantAuthority: { classification: { kind: "pda-no-account", address: key(64) } } }] },
      parameterControl: { links: [{ signers: [{ classification: { kind: "wallet", address: key(60) } }, { classification: { kind: "wallet", address: key(65) } }] }] },
    } as unknown as ContractsLayer;
    const inputs = authorityInputs(registry, layer);
    for (const n of [60, 62, 63, 64, 65]) expect(inputs).toContain(key(n));
    expect(inputs).not.toContain(key(61)); expect(inputs.filter(k => k === key(60))).toHaveLength(1);
  });
  test("scope includes all requested Slice A addresses", () => {
    const addresses = authorityInputs(registry, emptyLayer);
    expect(addresses).toContain(MSOL_UPGRADE_AUTHORITY);
    for (const a of registry.accounts.filter(a => /^native-(staker-authority|exit-authority)/.test(a.id))) expect(addresses).toContain(a.address);
  });
});

describe("transaction observations", () => {
  test("legacy JSON and v0 lookup keys, byte encodings and account indexes", () => {
    const legacy = rawTx(program.toBase58(), [candidate.toBase58()], key(90));
    const tx = structuredClone(legacy) as any;
    tx.transaction.message.staticAccountKeys = [new PublicKey(key(2)), program]; delete tx.transaction.message.accountKeys;
    tx.transaction.message.compiledInstructions = [{ programIdIndex: 1, accountKeyIndexes: new Uint8Array([2]), data: new Uint8Array([3, 0, 0, 0]) }]; delete tx.transaction.message.instructions;
    tx.meta.innerInstructions = []; tx.meta.loadedAddresses = { writable: [candidate], readonly: [] };
    const live = transactionInstructions(tx); expect(live.top[0].accounts).toEqual([candidate.toBase58()]); expect(live.top[0].dataHex).toBe("03000000");
    const serialized = JSON.parse(JSON.stringify(tx));
    // web3 accountKeyIndexes is a number[]; normalize this synthetic Uint8Array to its web3 shape.
    serialized.transaction.message.compiledInstructions[0].accountKeyIndexes = [2];
    expect(transactionInstructions(serialized)).toEqual(live);
    expect(transactionInstructions(legacy).inner).toHaveLength(1);
  });
  test.each(["inner", "top-level"])("mSOL authority upgrade history includes %s loader Upgrade", async location => {
    const tx = rawTx(program.toBase58(), [candidate.toBase58()], MSOL_UPGRADE_AUTHORITY, true);
    if (location === "top-level") tx.transaction.message.instructions.push(tx.meta.innerInstructions[0].instructions.pop()!);
    const result = await observed(recorder(), MSOL_UPGRADE_AUTHORITY, tx);
    expect(result.authorities[0].upgrades).toHaveLength(1);
    expect(result.authorities[0].upgrades[0]).toMatchObject({ programUpgraded: key(12), slot: 555, blockTime: 123456, signature: "sig", succeeded: true, basis: "observed" });
  });
  test("pruned transactions stay visible and unresolved", async () => {
    const result = await observed(recorder(), key(90), null);
    expect(result.authorities[0].observations[0].unavailable).toBe(true); expect(result.authorities[0].status).toBe("unresolved");
  });
});
const recorded = hasFixture("getSignaturesForAddress", { pubkey: MSOL_UPGRADE_AUTHORITY, limit: 50 });
test.skipIf(!recorded)("mainnet controller derivations and evidence (skipped until Claude records G2b keys)", async () => {
  const rpc = new RecordingRpc(runOptions({ record: false, offline: true }), "marinade-contracts");
  const result = await readAuthorities(rpc, registry, await readContractsLayer(rpc, registry, contracts));
  const ids = new Set(result.evidence.map(e => e.id));
  for (const authority of result.authorities) {
    expect(authority.evidenceIds.every(id => ids.has(id))).toBe(true);
    for (const resolution of authority.resolutions.filter(r => r.status === "resolved")) {
      expect(resolution.basis).toBe("derived");
      const d = resolution.derivation, matches = controllerDerivations(authority.address, ix(d.program, [d.candidate]));
      expect(matches).toContainEqual(d);
    }
  }
}, 120000);
