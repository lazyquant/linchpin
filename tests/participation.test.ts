import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { RecordingRpc } from "../src/chain/rpc";
import { canonical, fixtureKey, sha256 } from "../src/chain/evidence";
import { runOptions } from "../src/config";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { associatedTokenAccount } from "../src/pack/classify";
import { accountDiscriminator, decodeAccountAs, toPlain } from "../src/contracts/decode";
import { readContractsLayer, type ContractsInput } from "../src/contracts/marinade";
import { readParticipation, fieldOffset, remainingLockup, lockupBucket, votingPower, BUCKETS, ratio, provenance, type ContractsLayer } from "../src/contracts/participation";
import type { PackRegistry } from "../src/pack/build";
import { key, vector, accountBytes, hasFixture } from "./helpers/contracts";

const registry: PackRegistry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
const contracts: ContractsInput = JSON.parse(readFileSync(new URL("../packs/marinade/contracts.json", import.meta.url), "utf8"));
const vsr = vector("vsr"), now = 1_800_000_000n;
const lockup = (variant: string, end = now + 86400n, start = now - 86400n) => ({ kind: { variant }, startTs: start, endTs: end });
const config = { digitShift: 0, baselineVoteWeightScaledFactor: "1000000000", maxExtraLockupVoteWeightScaledFactor: "2000000000", lockupSaturationSecs: "100" };
const info = (owner: string, data: Buffer): AccountInfo<Buffer> => ({ owner: new PublicKey(owner), data, executable: false, lamports: 1, rentEpoch: 0 });

describe("compressed fixture storage", () => {
  test.each([100, 800_000])("round trips %i account bytes and preserves canonical evidence", async size => {
    const dir = mkdtempSync(join(tmpdir(), "linchpin-gzip-"));
    try {
      const opts = runOptions({ fixturesDir: dir, rpcUrl: "http://127.0.0.1:1", record: true, offline: false, refresh: false, minIntervalMs: 0 });
      const rpc = new RecordingRpc(opts, "test"), pk = new PublicKey(key(2));
      rpc.connection.getAccountInfoAndContext = async () => ({ value: info(key(3), Buffer.alloc(size, 3)), context: { slot: 42 } });
      const live = await rpc.getAccountInfo(pk), path = join(dir, "test", `${fixtureKey("getAccountInfo", { pubkey: key(2) })}.json`), gz = size > 100;
      expect(existsSync(gz ? path + ".gz" : path)).toBe(true); expect(existsSync(gz ? path : path + ".gz")).toBe(false);
      const bytes = readFileSync(gz ? path + ".gz" : path), fx = JSON.parse((gz ? gunzipSync(bytes) : bytes).toString());
      expect(fx.responseSha256).toBe(sha256(canonical(fx.response)));
      const offline = new RecordingRpc({ ...opts, offline: true }, "test");
      const replay = await offline.getAccountInfo(pk); expect(replay.value).toEqual(live.value); expect(replay.evidence.id).toBe(live.evidence.id);
      const resume = new RecordingRpc(opts, "test"); expect((await resume.getAccountInfo(pk)).evidence.source).toBe("fixture");
      // Refresh in both directions must remove the obsolete alternate encoding.
      const refresh = new RecordingRpc({ ...opts, refresh: true }, "test");
      refresh.connection.getAccountInfoAndContext = async () => ({ value: info(key(3), Buffer.alloc(gz ? 10 : 800_000, 4)), context: { slot: 43 } });
      const updated = await refresh.getAccountInfo(pk);
      expect(existsSync(gz ? path : path + ".gz")).toBe(true); expect(existsSync(gz ? path + ".gz" : path)).toBe(false);
      expect((await offline.getAccountInfo(pk)).evidence.id).toBe(updated.evidence.id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("IDL layouts, lockups and claimed voting formula", () => {
  test("asOf uses latest recorded timestamp while slot follows the figure's evidence", () => {
    const evidence = [
      { id: "earlier", slot: 10, retrievedAt: "2026-01-01T00:00:00.000Z" },
      { id: "later", slot: 20, retrievedAt: "2026-02-01T00:00:00.000Z" },
    ] as any;
    expect(provenance(evidence, ["earlier"])).toEqual({ evidenceIds: ["earlier"], slot: 10, asOf: "2026-02-01T00:00:00.000Z", basis: "decoded" });
  });
  test("registrar offset follows IDL field order and rejects variable prefixes", () => {
    expect(fieldOffset(vsr, "Voter", "registrar")).toBe(40);
    const changed = structuredClone(vsr); const d = changed.accounts!.find(a => a.name === "Voter")!.type;
    if (d.kind !== "struct") throw new Error();
    d.fields.unshift({ name: "newField", type: "u64" }); expect(fieldOffset(changed, "Voter", "registrar")).toBe(48);
    d.fields.unshift({ name: "variable", type: "string" }); expect(() => fieldOffset(changed, "Voter", "registrar")).toThrow("variable");
  });
  test.each(["None", "Daily", "Monthly", "Cliff", "Constant"])("IDL writer and decoder preserve %s and used flags", kind => {
    const d: any = toPlain(decodeAccountAs(vsr, "Voter", accountBytes(vsr, "Voter", { voterAuthority: key(5), registrar: key(6), deposits: [
      { isUsed: true, amountDepositedNative: "9007199254740993", lockup: lockup(kind) }, { isUsed: false, amountDepositedNative: "99" },
    ] })).value);
    expect(d.deposits[0].lockup.kind.variant).toBe(kind); expect(d.deposits[0].amountDepositedNative).toBe("9007199254740993");
    expect(d.deposits.filter((d: any) => d.isUsed)).toHaveLength(1);
    expect(remainingLockup(d.deposits[0].lockup, now)).toBe(kind === "None" ? 0n : kind === "Constant" ? 172800n : 86400n);
  });
  test.each([[0n, 0], [1n, 1], [30n * 86400n - 1n, 1], [30n * 86400n, 2], [180n * 86400n - 1n, 2], [180n * 86400n, 3], [365n * 86400n, 3], [365n * 86400n + 1n, 4]] as const)("bucket boundary %s", (seconds, index) => expect(lockupBucket(seconds)).toBe(BUCKETS[index]));
  test("expired Cliff is none; expired Constant retains period", () => {
    expect(remainingLockup(lockup("Cliff", now - 1n), now)).toBe(0n);
    expect(remainingLockup(lockup("Constant", now - 1n, now - 101n), now)).toBe(100n);
  });
  test("baseline, extra, saturation, digit shifts and exact integer truncation", () => {
    expect(votingPower(1000n, 0n, config)).toBe(1000n); expect(votingPower(1000n, 50n, config)).toBe(2000n);
    expect(votingPower(1000n, 500n, config)).toBe(3000n);
    expect(votingPower(1000n, 50n, { ...config, digitShift: -1 })).toBe(200n);
    expect(votingPower(1000n, 50n, { ...config, digitShift: 2 })).toBe(200000n);
    expect(votingPower(19n, 33n, { ...config, digitShift: -1 })).toBe(1n);
    expect(() => votingPower(1000n, 50n, { ...config, lockupSaturationSecs: 0 })).toThrow("zero saturation");
    expect(ratio(1n, 0n)).toBeNull();
  });
});

async function syntheticParticipation(voterCount = 3, signatures?: any[]) {
  const rpc = new RecordingRpc(runOptions({ record: false, offline: false, minIntervalMs: 0, rpcUrl: "http://127.0.0.1:1" }), "synthetic");
  const mnde = registry.mints.find(m => m.id === "mnde")!.address, registrar = key(80), state = key(81);
  const mintBytes = Buffer.alloc(82); mintBytes.writeBigUInt64LE(1000_000_000_000n, 36); mintBytes[44] = 9;
  rpc.connection.getAccountInfoAndContext = async pk => ({ context: { slot: 70 }, value: pk.toBase58() === mnde ? info(TOKEN_PROGRAM.toBase58(), mintBytes) : null });
  const evidence = (await rpc.getAccountInfo(new PublicKey(mnde))).evidence;
  const meta = { evidenceIds: [evidence.id], slot: 70, basis: "decoded" };
  const programs = registry.programs.filter(p => p.id !== "governance-program").map(p => ({ ...p, upgradeAuthority: { classification: null }, idl: { kind: "idl", program: p.address, idl: vector(p.id), ...meta } }));
  const layer = { programs, evidence: [evidence], enumerations: [], authorities: [], parameterControl: { links: [] }, registrar: { address: registrar, votingMints: [{ ...config, index: 0, mint: mnde, ...meta }, { ...config, index: 1, mint: key(99), ...meta }], ...meta }, singletons: [
    { id: "liquid-staking-state", address: state, value: { circulatingTicketCount: "2", circulatingTicketBalance: "99" }, ...meta },
    { id: "vsr-registrar-mnde", value: { timeOffset: "0" }, ...meta },
  ] } as unknown as ContractsLayer;
  const voterKeys = Array.from({ length: voterCount }, (_, i) => { const b = Buffer.alloc(32, 5); b.writeUInt32LE(i, 0); return new PublicKey(b); });
  const vaultMap = new Map(voterKeys.map((v, i) => {
    const b = Buffer.alloc(165); new PublicKey(mnde).toBuffer().copy(b); v.toBuffer().copy(b, 32); b.writeBigUInt64LE(i === 1 ? 9n : 10n, 64);
    return [associatedTokenAccount(v, new PublicKey(mnde)).toBase58(), i === 2 ? null : info(TOKEN_PROGRAM.toBase58(), b)] as const;
  }));
  const batches: number[] = [];
  rpc.connection.getMultipleAccountsInfoAndContext = async keys => { batches.push(keys.length); return { context: { slot: 71 }, value: keys.map(k => vaultMap.get(k.toBase58())!) }; };
  rpc.connection.getProgramAccounts = (async (program: PublicKey, options: any) => {
    if (program.toBase58() === registry.governance.program) return { context: { slot: 70 }, value: [] };
    const p = programs.find(p => p.address === program.toBase58())!, idl = p.idl.idl;
    const name = idl.accounts!.find(a => bs58.encode(accountDiscriminator(a.name)) === options.filters[0].memcmp.bytes)!.name;
    let values: Record<string, any>[] = [];
    if (name === "Voter") {
      expect(options.filters[1]).toEqual({ memcmp: { offset: fieldOffset(vsr, "Voter", "registrar"), bytes: registrar } });
      values = voterKeys.map((_, i) => ({ voterAuthority: key(10), registrar, deposits: [
        { isUsed: true, amountDepositedNative: 10, lockup: lockup("Constant", 100n, 0n) },
        { isUsed: false, amountDepositedNative: 900 },
        ...(i === 0 ? [{ isUsed: true, amountDepositedNative: 50, votingMintConfigIdx: 1, lockup: lockup("None") }] : []),
      ] }));
    } else if (name === "TicketAccountData") { expect(options.dataSlice.length).toBe(0); expect(options.filters[1].memcmp.bytes).toBe(state); values = [{}, {}]; }
    else if (name === "VoteRecord") values = [{ target: key(40) }, { target: key(40) }, { target: key(41) }];
    else if (name === "ReferralState") values = [{ partnerName: "partner", baseFee: 100, accumDepositSolFee: 500 }];
    else if (name === "Escrow") values = [{ amount: 99, realm: key(22) }];
    else if (p.id === "native-staking-proxy") values = [{ admin: key(21), operator: key(22), alternateStaker: key(23) }];
    return { context: { slot: 72 }, value: values.map((v, i) => ({ pubkey: name === "Voter" ? voterKeys[i] : new PublicKey(key(100 + i)), account: info(p.address, options.dataSlice ? Buffer.alloc(0) : accountBytes(idl, name, v)) })) };
  }) as any;
  rpc.connection.getSignaturesForAddress = async () => signatures ?? [{ signature: "old", slot: 1, blockTime: 100, err: null, memo: null }, { signature: "older", slot: 1, blockTime: 90, err: null, memo: null }];
  return { result: await readParticipation(rpc, registry, contracts, layer), batches };
}

test("synthetic end-to-end participation: amounts, mint isolation, vault mismatches, activity and IDL limits", async () => {
  const { result: r } = await syntheticParticipation();
  expect(r.vsr.totalDeposited.raw).toBe("30"); expect(r.vsr.totalDeposited.display).toBe("0.000000030");
  expect(r.vsr.usedDepositEntries.value).toBe(4); expect(r.vsr.mndeUsedDepositEntries.value).toBe(3);
  expect(r.vsr.shareOfSupply.value).toBe(ratio(30n, 1000_000_000_000n));
  expect(r.vsr.voting.total.value).toBe("140"); expect(r.vsr.voting.top20Share.value).toBe(1);
  expect(r.vsr.reconciliation.matched.value).toBe(1); expect(r.vsr.reconciliation.mismatched.value).toBe(1); expect(r.vsr.reconciliation.missing.value).toBe(1);
  expect(r.vsr.reconciliation.deposits.raw).toBe("30"); expect(r.vsr.reconciliation.vaultBalances.raw).toBe("19");
  expect(r.vsr.reconciliation.examples[0].reason).toContain("differs"); expect(r.activity).toHaveLength(9);
  expect(r.activity.every(a => a.dormant.value)).toBe(true); expect(r.activity[0].transactionsPerDay.value).toBe(17280);
  expect(r.directedStake.total.value).toBe(3); expect(r.directedStake.top20Targets[0].records.value).toBe(2); expect(r.directedStake.amount.value).toBeNull();
  expect(r.referral.partners[0].name).toBe("partner"); expect(r.nativeProxy.authorities).toHaveLength(3);
  expect(r.escrow.totalEscrowed.value).toBe("99"); expect(r.escrow.owners.value).toBeNull(); expect(r.delayedUnstake.countsAgree.value).toBe(true);
  expect(() => JSON.stringify(r)).not.toThrow(); assertTotals(r);
});
test("vault reads batch at most 100 and top shares use the full totals", async () => {
  const { batches, result: r } = await syntheticParticipation(101); expect(batches).toEqual([100, 1]);
  expect(r.vsr.top20).toHaveLength(20); expect(r.vsr.top10ShareOfDeposits.value).toBe(ratio(100n, 1010n));
  expect(r.vsr.top10ShareOfSupply.value).toBe(ratio(100n, BigInt(r.vsr.supply.raw)));
  expect(r.vsr.voting.top20Share.value).toBe(ratio(650n, 3080n));
});
test("empty voters and activity have zero totals and unknown concentration/dormancy", async () => {
  const { result: r } = await syntheticParticipation(0, []);
  expect(r.vsr.totalDeposited.raw).toBe("0"); expect(r.vsr.top10ShareOfDeposits.value).toBeNull();
  expect(r.vsr.voting.top20Share.value).toBeNull(); expect(r.activity.every(a => a.dormant.value === null)).toBe(true);
  expect(r.activity.every(a => a.transactionsPerDay.value === null)).toBe(true);
});
test("unknown or single block time gives unknown rate", async () => {
  const { result: r } = await syntheticParticipation(0, [{ signature: "no-time", blockTime: null, slot: 1, err: null, memo: null }]);
  expect(r.activity[0].newestBlockTime.value).toBeNull(); expect(r.activity[0].dormant.value).toBeNull(); expect(r.activity[0].transactionsPerDay.value).toBeNull();
});
function assertTotals(r: Awaited<ReturnType<typeof readParticipation>>) {
  const total = r.vsr.rows.reduce((n, row) => n + BigInt(row.amount.raw), 0n);
  expect(r.vsr.totalDeposited.raw).toBe(String(total));
  expect(r.vsr.byLockupKind.reduce((n, row) => n + BigInt(row.raw), 0n)).toBe(total);
  expect(r.vsr.byRemainingLockup.reduce((n, row) => n + BigInt(row.raw), 0n)).toBe(total);
  expect(r.vsr.shareOfSupply.value).toBe(ratio(total, BigInt(r.vsr.supply.raw)));
  for (const row of r.vsr.rows) expect(row.shareOfSupply.value).toBe(ratio(BigInt(row.amount.raw), BigInt(r.vsr.supply.raw)));
  const ids = new Set(r.evidence.map(e => e.id));
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    if ("basis" in v) { expect(v.evidenceIds.length).toBeGreaterThan(0); expect(v.evidenceIds.every((id: string) => ids.has(id))).toBe(true); expect(v).toHaveProperty("slot"); expect(v).toHaveProperty("asOf"); }
    for (const [k, x] of Object.entries(v)) if (k !== "evidence") walk(x);
  }
  walk(r);
}
const p = registry.programs.find(p => p.id === "vsr")!;
const registrarAddress = PublicKey.findProgramAddressSync([new PublicKey(registry.governance.realm).toBuffer(), Buffer.from("registrar"), new PublicKey(registry.mints.find(m => m.id === "mnde")!.address).toBuffer()], new PublicKey(p.address))[0].toBase58();
const recorded = hasFixture("getProgramAccounts", { programId: p.address, filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Voter")) } }, { memcmp: { offset: fieldOffset(vsr, "Voter", "registrar"), bytes: registrarAddress } }] });
test.skipIf(!recorded)("mainnet participation sums, recorded supply shares and evidence (skipped until Claude records G3 keys)", async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true, record: false }), "marinade-contracts");
  assertTotals(await readParticipation(rpc, registry, contracts, await readContractsLayer(rpc, registry, contracts)));
}, 120000);
