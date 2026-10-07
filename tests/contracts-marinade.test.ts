import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { RecordingRpc } from "../src/chain/rpc";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { runOptions } from "../src/config";
import type { PackRegistry } from "../src/pack/build";
import { readContractsLayer, type ContractsInput } from "../src/contracts/marinade";
import { idlAddress, type IdlType, type LegacyIdl } from "../src/contracts/idl";
import { accountDiscriminator, toPlain } from "../src/contracts/decode";

const registry: PackRegistry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
const contracts: ContractsInput = JSON.parse(readFileSync(new URL("../packs/marinade/contracts.json", import.meta.url), "utf8"));
type Layer = Awaited<ReturnType<typeof readContractsLayer>>;
const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();

// Synthetic account writer for these captured schemas. Overrides are explicit field paths;
// this is only test data and is never used to manufacture production evidence.
function accountBytes(idl: LegacyIdl, name: string, overrides: Record<string, string | number | boolean> = {}) {
  function encode(type: IdlType, path: string): Buffer {
    const value = overrides[path];
    if (typeof type === "object") {
      if ("defined" in type) {
        const def = [...(idl.types ?? []), ...(idl.accounts ?? [])].find(t => t.name === type.defined)!.type;
        if (def.kind === "enum") {
          const fields = def.variants[0].fields ?? [];
          return Buffer.concat([Buffer.from([0]), ...fields.map((f, i) => typeof f === "object" && "name" in f
            ? encode(f.type, `${path}.${f.name}`) : encode(f as IdlType, `${path}.${i}`))]);
        }
        return Buffer.concat(def.fields.map(f => encode(f.type, path ? `${path}.${f.name}` : f.name)));
      }
      if ("array" in type) return Buffer.concat(Array.from({ length: type.array[1] }, (_, i) => encode(type.array[0], `${path}.${i}`)));
      if ("option" in type) return Buffer.from([0]);
      if ("vec" in type || "coption" in type) return Buffer.alloc(4);
    }
    if (type === "publicKey") return new PublicKey(typeof value === "string" ? value : key(31)).toBuffer();
    if (type === "bool") return Buffer.from([value ? 1 : 0]);
    if (type === "bytes" || type === "string") return Buffer.alloc(4);
    if (typeof type === "string" && /^[ui](8|16|32|64|128)$/.test(type)) {
      const bytes = Number(type.slice(1)) / 8;
      let n = BigInt.asUintN(bytes * 8, BigInt(value ?? 0));
      const b = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i++) { b[i] = Number(n & 255n); n >>= 8n; }
      return b;
    }
    throw new Error(`test writer: unsupported ${JSON.stringify(type)} at ${path}`);
  }
  return Buffer.concat([accountDiscriminator(name), encode({ defined: name }, ""), Buffer.alloc(5)]);
}

async function syntheticLayer(rewardFee = 75, price = "6442450944") {
  const rpc = new RecordingRpc(runOptions({ offline: false, record: false, minIntervalMs: 0, rpcUrl: "http://127.0.0.1:1" }), "synthetic-contracts");
  const infos = new Map<string, AccountInfo<Buffer>>();
  const idls = new Map<string, LegacyIdl>();
  const put = (address: string, owner: PublicKey, data: Buffer) => infos.set(address, { owner, data, executable: false, lamports: 1, rentEpoch: 0 });
  for (const p of registry.programs.filter(p => p.id !== "governance-program")) {
    const json = readFileSync(new URL(`./vectors/idl/${p.id}.json`, import.meta.url));
    const idl: LegacyIdl = JSON.parse(json.toString());
    idls.set(p.id, idl);
    const compressed = deflateSync(json); const header = Buffer.alloc(44);
    new PublicKey(key(30)).toBuffer().copy(header, 8); header.writeUInt32LE(compressed.length, 40);
    put((await idlAddress(new PublicKey(p.address))).toBase58(), new PublicKey(p.address), Buffer.concat([header, compressed]));
  }
  const state = contracts.singletons.find(s => s.id === "liquid-staking-state")!;
  const msol = registry.mints.find(m => m.id === "msol")!.address;
  const mnde = registry.mints.find(m => m.id === "mnde")!.address;
  const lp = registry.mints.find(m => m.id === "msol-sol-lp")!.address;
  put(state.address!, new PublicKey(registry.programs.find(p => p.id === state.program)!.address), accountBytes(idls.get(state.program)!, "State", {
    msolMint: msol, "liqPool.lpMint": lp, adminAuthority: key(41), "validatorSystem.managerAuthority": key(42), pauseAuthority: key(43),
    treasuryMsolAccount: key(44), "liqPool.msolLeg": key(45), "stakeSystem.stakeList.account": key(46), "validatorSystem.validatorList.account": key(47),
    "rewardFee.basisPoints": rewardFee, "depositSolFee.bpCents": 150, msolPrice: price, msolSupply: "9007199254740993", paused: true,
  }));
  const vsr = new PublicKey(registry.programs.find(p => p.id === "vsr")!.address);
  const registrarKey = PublicKey.findProgramAddressSync([new PublicKey(registry.governance.realm).toBuffer(), Buffer.from("registrar"), new PublicKey(mnde).toBuffer()], vsr)[0];
  put(registrarKey.toBase58(), vsr, accountBytes(idls.get("vsr")!, "Registrar", {
    realm: registry.governance.realm, realmGoverningTokenMint: mnde, realmAuthority: key(48), "votingMints.0.mint": mnde,
    "votingMints.0.grantAuthority": key(49), "votingMints.0.digitShift": -2, "votingMints.0.baselineVoteWeightScaledFactor": "1000000000",
    "votingMints.0.maxExtraLockupVoteWeightScaledFactor": "2000000000", "votingMints.0.lockupSaturationSecs": "2592000",
    ...Object.fromEntries([1, 2, 3].flatMap(i => [[`votingMints.${i}.mint`, PublicKey.default.toBase58()], [`votingMints.${i}.grantAuthority`, PublicKey.default.toBase58()]])),
  }));
  for (const n of [44, 45]) {
    const data = Buffer.alloc(165); new PublicKey(msol).toBuffer().copy(data); new PublicKey(key(41)).toBuffer().copy(data, 32); data.writeBigUInt64LE(12345678901234567n, 64);
    put(key(n), TOKEN_PROGRAM, data);
  }
  put(key(41), SystemProgram.programId, Buffer.alloc(0));
  rpc.connection.getAccountInfoAndContext = async pk => ({ context: { slot: 1234 }, value: infos.get(pk.toBase58()) ?? null });
  (rpc.connection as any).getProgramAccounts = async (program: PublicKey, config: { filters: { memcmp?: { offset: number; bytes: string } }[]; dataSlice?: { offset: number; length: number }; withContext: boolean }) => {
    if (program.toBase58() === registry.governance.program) return { context: { slot: 1233 }, value: [] };
    const p = registry.programs.find(p => p.address === program.toBase58())!;
    const entry = contracts.enumerate.find(e => e.program === p.id && config.filters[0].memcmp?.bytes === bs58.encode(accountDiscriminator(e.account)));
    expect(entry).toBeDefined();
    expect(config.withContext).toBe(true);
    expect(config.filters).toEqual([{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator(entry!.account)) } }]);
    expect(config.dataSlice).toEqual(entry!.mode === "count" ? { offset: 0, length: 0 } : undefined);
    const data = entry!.mode === "count" ? Buffer.alloc(0) : accountBytes(idls.get(p.id)!, entry!.account);
    return { context: { slot: 1235 }, value: Array.from({ length: entry!.mode === "count" ? 2 : 1 }, (_, i) => ({ pubkey: new PublicKey(key(60 + i)), account: { data, owner: program, executable: false, lamports: 1, rentEpoch: 0 } })) };
  };
  return readContractsLayer(rpc, registry, contracts);
}

describe("contracts layer with synthetic RPC responses", () => {
  let layer: Layer;
  beforeAll(async () => { layer = await syntheticLayer(); });

  test("reads nine IDLs and both singletons, preserves exact raw values and known mint checks", () => {
    expect(layer.programs.filter(p => p.idl.kind === "idl")).toHaveLength(9);
    expect(layer.programs.find(p => p.id === "governance-program")?.idl.kind).toBe("no-idl");
    expect(layer.singletons).toHaveLength(2);
    expect(layer.singletons[0].trailingBytes).toBe(5);
    expect(layer.singletons[1].derivation).toMatchObject({ basis: "derived", seeds: ["realm", "utf8:registrar", "mint:mnde"] });
    expect(layer.checks.every(c => c.status === "verified")).toBe(true);
    expect(layer.parameters.find(p => p.field === "msolSupply")?.raw).toBe("9007199254740993");
    expect(layer.parameters.find(p => p.field === "depositSolFee")).toMatchObject({ raw: 150, unit: "hundredths of a basis point" });
    expect(layer.parameters.find(p => p.field === "msolPrice")?.scaling).toMatchObject({ divisor: "4294967296", solPerMsol: 1.5, sanityCheck: { passed: true } });
    expect(layer.parameters).toHaveLength(20);
  });

  test("full enumerations decode, count enumerations discard accounts, and every row has resolvable provenance", () => {
    expect(layer.enumerations).toHaveLength(contracts.enumerate.length);
    for (const entry of layer.enumerations) {
      expect(entry.count).toBe(entry.mode === "count" ? 2 : 1);
      if (entry.mode === "count") expect("accounts" in entry).toBe(false);
      else expect(entry.accounts![0]).toMatchObject({ type: entry.account, trailingBytes: 5 });
    }
    const evidenceIds = new Set(layer.evidence.map(e => e.id));
    function check(value: unknown) {
      if (!value || typeof value !== "object") return;
      if ("evidenceIds" in value) {
        const row = value as { evidenceIds: string[]; slot: number | null; basis: string };
        expect(row.evidenceIds.length).toBeGreaterThan(0);
        expect(["decoded", "declared", "derived", "inferred"]).toContain(row.basis);
        expect(row.slot).toBeGreaterThan(0);
        for (const id of row.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
      }
      for (const nested of Object.values(value)) check(nested);
    }
    check(layer);
    expect(layer.asOfSlotRange).toEqual([1233, 1235]);
    expect(() => JSON.stringify(toPlain(layer))).not.toThrow();
  });

  test("classifies list account references and reads both token balances", () => {
    expect(layer.authorities).toHaveLength(10);
    expect(layer.authorities.find(a => a.field === "stakeSystem.stakeList")).toMatchObject({ stateField: "stakeSystem.stakeList.account", address: key(46) });
    expect(layer.authorities.find(a => a.field === "validatorSystem.validatorList")).toMatchObject({ stateField: "validatorSystem.validatorList.account", address: key(47) });
    for (const field of ["treasuryMsolAccount", "liqPool.msolLeg"]) {
      expect(layer.authorities.find(a => a.field === field)).toMatchObject({ classification: { kind: "token-account" }, balance: { value: { amountRaw: "12345678901234567" }, basis: "decoded", slot: 1234 } });
    }
    for (const row of layer.authorities) { expect(row.classification.kind).toBeDefined(); expect(row.evidenceIds.length).toBeGreaterThan(1); }
  });

  test("resolves inferred control through the signer role to the classified State holder", () => {
    const reward = layer.parameterControl.controls.find(c => c.parameter === "rewardFee")!;
    expect(reward.settings).toContainEqual(expect.objectContaining({ instruction: "configMarinade", argPath: "params.rewardsFee", basis: "inferred",
      signers: [expect.objectContaining({ role: "adminAuthority", holderField: "adminAuthority", holder: key(41), classification: expect.objectContaining({ address: key(41) }) })] }));
    expect(layer.parameterControl.controls.find(c => c.parameter === "paused")!.settings.map(s => s.instruction)).toEqual(["pause", "resume"]);
    expect(layer.parameterControl.controls.find(c => c.parameter === "msolPrice")!.unresolved).toBeDefined();
    expect(layer.parameterControl.unmatched.length).toBeGreaterThan(0);
    const unresolved = layer.parameterControl.links.flatMap(l => l.signers).filter(s => !s.holder);
    for (const row of unresolved) { expect(row.classification).toBeNull(); expect(row.unresolved).toBeDefined(); }
  });

  test("Registrar retains raw voting factors, digit shift and unused mint slots with authority classifications", () => {
    expect(layer.registrar.votingMints).toHaveLength(4);
    expect(layer.registrar.votingMints[0]).toMatchObject({ mint: registry.mints.find(m => m.id === "mnde")!.address, digitShift: -2,
      baselineVoteWeightScaledFactor: "1000000000", maxExtraLockupVoteWeightScaledFactor: "2000000000", lockupSaturationSecs: "2592000",
      grantAuthority: { address: key(49), classification: { address: key(49) } } });
    expect(layer.registrar.realmAuthority.classification.address).toBe(key(48));
    expect(layer.registrar.votingMints[1].mint).toBe(PublicKey.default.toBase58());
  });

  test("claim v1 states the decoded contradiction first", () => {
    expect(layer.claims[0]).toMatchObject({ id: "v1", status: "contradiction", basis: "decoded", note: "Decoded rewardFee.basisPoints = 75 basis points. Contradicts the registry claim that reward_fee is 0." });
  });

  test("zero reward fee verifies v1; implausible scaled prices remain flagged", async () => {
    const other = await syntheticLayer(0, "429496729");
    expect(other.claims[0].status).toBe("verified");
    expect(other.parameters.find(p => p.field === "msolPrice")?.scaling?.sanityCheck.passed).toBe(false);
  });
});

const fixtureDir = new URL("../fixtures/marinade-contracts/", import.meta.url);
const hasFixtures = existsSync(fixtureDir) && readdirSync(fixtureDir).some(f => f.endsWith(".json"));
if (!hasFixtures) console.warn("SKIP contracts-marinade recorded checks: fixtures/marinade-contracts/ is empty or absent; run bun run scripts/record-contracts.ts --record.");

describe("recorded Marinade contracts (offline)", () => {
  let layer: Layer;
  beforeAll(async () => {
    if (hasFixtures) layer = await readContractsLayer(new RecordingRpc(runOptions({ offline: true, record: false }), "marinade-contracts"), registry, contracts);
  });
  test.skipIf(!hasFixtures)("State decodes with registry mSOL and LP mints", () => {
    const state = layer.singletons.find(s => s.id === "liquid-staking-state")!;
    expect(state.account).toBe("State"); expect(state.bytesRead).toBeGreaterThan(8);
    expect(state.value.msolMint).toBe(registry.mints.find(m => m.id === "msol")!.address);
    expect((state.value.liqPool as { lpMint: string }).lpMint).toBe(registry.mints.find(m => m.id === "msol-sol-lp")!.address);
  });
  test.skipIf(!hasFixtures)("Registrar voting mints include MNDE", () => {
    expect(layer.registrar.votingMints.map(m => m.mint)).toContain(registry.mints.find(m => m.id === "mnde")!.address);
  });
  test.skipIf(!hasFixtures)("every authority row has classification and evidence", () => {
    for (const a of [...layer.authorities, layer.registrar.realmAuthority, ...layer.registrar.votingMints.map(m => m.grantAuthority)]) {
      expect(a.classification.kind).toBeDefined(); expect(a.evidenceIds.length).toBeGreaterThan(0); expect(a.slot).toBeGreaterThan(0);
    }
  });
  test.skipIf(!hasFixtures)("scaled mSOL price passes its explicit sanity range", () => {
    expect(layer.parameters.find(p => p.field === "msolPrice")?.scaling?.sanityCheck.passed).toBe(true);
  });
});
