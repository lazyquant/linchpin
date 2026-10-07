import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PublicKey, Keypair, SystemProgram, type AccountInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { decodeOwnerSlice, decodeAmountSlice, aggregateOwners, gini, nakamoto, histogram, floatComponents, classifyOwner, rankRoles, validateLabels, readHolders, type Role } from "../src/contracts/holders";
import { readContractsLayer } from "../src/contracts/marinade";
import { readParticipation, type ContractsLayer } from "../src/contracts/participation";
import { readAuthorities } from "../src/contracts/authorities";
import { key, hasFixture } from "./helpers/contracts";
const meta = { evidenceIds: ["e"], slot: 1, asOf: "2026-10-06T00:00:00Z", basis: "decoded" as const };
const info = (owner: string, data = Buffer.alloc(0)): AccountInfo<Buffer> => ({ owner: new PublicKey(owner), data, lamports: 1, executable: false, rentEpoch: 0 });
const slice = (owner: string, n: bigint) => { const b = Buffer.alloc(40); new PublicKey(owner).toBuffer().copy(b); b.writeBigUInt64LE(n, 32); return b; };
const mintInfo = (n: bigint) => { const b = Buffer.alloc(82); b.writeBigUInt64LE(n, 36); b[44] = 9; return info(TOKEN_PROGRAM.toBase58(), b); };
const tokenInfo = (mint: string, owner: string, n: bigint) => { const b = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(b); new PublicKey(owner).toBuffer().copy(b, 32); b.writeBigUInt64LE(n, 64); return info(TOKEN_PROGRAM.toBase58(), b); };

describe("holder arithmetic", () => {
  test("owner slices preserve u64 and aggregate multiple accounts", () => {
    const rows = [decodeOwnerSlice(slice(key(1), 20n)), decodeOwnerSlice(slice(key(1), 30n)), decodeOwnerSlice(slice(key(2), 0n)), decodeOwnerSlice(slice(key(3), 2n ** 63n))];
    expect(aggregateOwners(rows)).toEqual([{ owner: key(3), amountRaw: String(2n ** 63n), accounts: 1, nonZeroAccounts: 1 }, { owner: key(1), amountRaw: "50", accounts: 2, nonZeroAccounts: 2 }, { owner: key(2), amountRaw: "0", accounts: 1, nonZeroAccounts: 0 }]);
    expect(decodeAmountSlice(slice(key(1), 99n).subarray(32))).toBe("99");
    expect(() => decodeOwnerSlice(Buffer.alloc(39))).toThrow(); expect(() => decodeAmountSlice(Buffer.alloc(40))).toThrow();
  });
  test("Nakamoto uses strictly greater than half, and reports incomplete supply", () => {
    expect(nakamoto([50n, 25n, 25n])).toBe(2); expect(nakamoto([51n, 49n])).toBe(1); expect(nakamoto([40n], 100n)).toBeNull(); expect(nakamoto([])).toBeNull();
  });
  test("population Gini hand calculations and nonzero denominator", () => {
    expect(gini([1n, 1n, 1n])).toBe(0); expect(gini([1n, 3n])).toBe(0.25); expect(gini([0n, 1n, 2n, 3n])).toBeCloseTo(2 / 9, 10); expect(gini([])).toBeNull();
  });
  test("powers-of-ten histogram boundaries include sub-token amounts", () => {
    expect(histogram([0n, 1n, 999999999n, 1000000000n, 9999999999n, 10000000000n], 9).map(r => [r.exponent, r.count])).toEqual([[-9, 1], [-1, 1], [0, 2], [1, 1]]);
  });
  test("float displays claimed subtraction separately and retains negative remainder", () => {
    expect(floatComponents(100n, 20n, 10n, 5n, 30n)).toMatchObject({ verifiedOnlyRaw: "65", includingClaimedRaw: "35", labsClaimedRaw: "30" });
    expect(floatComponents(10n, 20n, 0n, 0n, 0n)).toMatchObject({ verifiedOnlyRaw: "-10", nonnegative: false });
  });
});
describe("classification and labels", () => {
  test("wallet, PDA, absent and program-owned branches", () => {
    const wallet = Keypair.fromSeed(Buffer.alloc(32, 4)).publicKey.toBase58(), pda = PublicKey.findProgramAddressSync([Buffer.from("test")], TOKEN_PROGRAM)[0].toBase58();
    expect(classifyOwner(wallet, null).kind).toBe("wallet-no-account"); expect(classifyOwner(pda, null).kind).toBe("pda-no-account");
    expect(classifyOwner(wallet, info(SystemProgram.programId.toBase58())).kind).toBe("wallet"); expect(classifyOwner(pda, info(SystemProgram.programId.toBase58())).kind).toBe("pda-system");
    expect(classifyOwner(pda, info(key(1)))).toMatchObject({ kind: "program-owned", ownerProgram: key(1) });
  });
  test("derived > decoded > claimed > reported; all sources retained", () => {
    const roles: Role[] = (["reported", "claimed", "decoded", "derived"] as const).map(basis => ({ ...meta, name: basis, basis, source: "source", retrievedAt: meta.asOf }));
    expect(rankRoles(roles).map(r => r.basis)).toEqual(["derived", "decoded", "claimed", "reported"]); expect(roles[0].basis).toBe("reported");
    expect(rankRoles(roles)[3].retrievedAt).toBe(meta.asOf);
  });
  test("labels require source, date and valid address", () => {
    const file = { source: "synthetic service", retrievedAt: meta.asOf, labels: [{ address: key(1), label: "Protocol", category: "lending" }] };
    expect(validateLabels(file)).toEqual(file); expect(() => validateLabels({ ...file, retrievedAt: "bad" })).toThrow(); expect(() => validateLabels({ ...file, labels: [{ address: "bad", label: "x" }] })).toThrow();
  });
});

const registry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
const contracts = JSON.parse(readFileSync(new URL("../packs/marinade/contracts.json", import.meta.url), "utf8"));
const mnde = registry.mints.find((m: any) => m.id === "mnde").address, msol = registry.mints.find((m: any) => m.id === "msol").address;
function synthetic() {
  const wallet = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey.toBase58(), pda = PublicKey.findProgramAddressSync([Buffer.from("vault")], TOKEN_PROGRAM)[0].toBase58();
  const labs = registry.accounts.find((a: any) => a.id === "labs-treasury").address;
  const voter = key(10), escrowOwner = key(11), protocol = key(12), treasuryToken = key(13), topToken = key(14), escrowVault = key(15);
  const infos = new Map<string, AccountInfo<Buffer>>([[mnde, mintInfo(1000n)], [msol, mintInfo(100n)], [topToken, tokenInfo(msol, pda, 40n)], [treasuryToken, tokenInfo(msol, wallet, 60n)], [wallet, info(SystemProgram.programId.toBase58())]]);
  const rpc = new RecordingRpc(runOptions({ record: false, offline: false, rpcUrl: "http://127.0.0.1:1", minIntervalMs: 0 }), "synthetic-holders");
  rpc.connection.getAccountInfoAndContext = async k => ({ context: { slot: 102 }, value: infos.get(k.toBase58()) ?? null });
  rpc.connection.getMultipleAccountsInfoAndContext = async keys => { expect(keys.length).toBeLessThanOrEqual(100); return { context: { slot: 103 }, value: keys.map(k => infos.get(k.toBase58()) ?? null) }; };
  rpc.connection.getProgramAccounts = (async (program: PublicKey, config: any) => {
    if (!program.equals(TOKEN_PROGRAM)) return { context: { slot: 100 }, value: [] };
    expect(config.filters[0]).toEqual({ dataSize: 165 }); expect(config.filters[1].memcmp.offset).toBe(0);
    if (config.filters[1].memcmp.bytes === mnde) {
      expect(config.dataSlice).toEqual({ offset: 32, length: 40 });
      return { context: { slot: 100 }, value: [[key(20), wallet, 300n], [key(21), wallet, 200n], [key(22), labs, 200n], [key(23), voter, 200n], [escrowVault, escrowOwner, 50n], [key(24), wallet, 0n]].map(([address, owner, n]) => ({ pubkey: new PublicKey(address as string), account: info(TOKEN_PROGRAM.toBase58(), slice(owner as string, n as bigint)) })) };
    }
    expect(config.dataSlice).toEqual({ offset: 64, length: 8 });
    return { context: { slot: 101 }, value: [[topToken, 40n], [treasuryToken, 60n]].map(([address, n]) => ({ pubkey: new PublicKey(address as string), account: info(TOKEN_PROGRAM.toBase58(), slice(wallet, n as bigint).subarray(32)) })) };
  }) as any;
  rpc.connection.getTokenLargestAccounts = async () => ({ context: { slot: 102 }, value: [{ address: new PublicKey(topToken), amount: "40", decimals: 9, uiAmount: 4e-8 }, { address: new PublicKey(treasuryToken), amount: "60", decimals: 9, uiAmount: 6e-8 }] });
  rpc.connection.getSignaturesForAddress = async (address, config) => { expect(address.toBase58()).toBe(topToken); expect(config?.limit).toBe(10); return [{ signature: "sig", slot: 99, blockTime: 1791244800, err: null, memo: null }]; };
  const transfer = Buffer.alloc(9); transfer[0] = 3; transfer.writeBigUInt64LE(3n, 1);
  rpc.connection.getTransaction = async () => ({ slot: 99, blockTime: 1791244800, transaction: { message: { accountKeys: [wallet, topToken, key(25), protocol, TOKEN_PROGRAM.toBase58()], instructions: [{ programIdIndex: 3, accounts: [1, 2], data: "" }] } }, meta: { err: null, preTokenBalances: [{ accountIndex: 1, owner: pda, mint: msol, uiTokenAmount: { amount: "43", decimals: 9 } }], postTokenBalances: [{ accountIndex: 1, owner: pda, mint: msol, uiTokenAmount: { amount: "40", decimals: 9 } }], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [1, 2, 0], data: bs58.encode(transfer) }] }] } }) as any;
  const layer = { evidence: [], authorities: [{ field: "treasuryMsolAccount", address: treasuryToken, ...meta }] } as unknown as ContractsLayer;
  const participation = { evidence: [], vsr: { rows: [{ address: voter, voterAuthority: wallet, deposits: [{ lockup: { kind: { variant: "Constant" } } }], amount: { raw: "200" }, ...meta }], totalDeposited: { raw: "200", ...meta }, timeLocked: { raw: "180", ...meta }, reconciliation: { missing: { value: 0 }, mismatched: { value: 0 }, vaultBalances: { raw: "200" }, ...meta } },
    escrow: { rows: [{ address: key(26), value: { realm: key(27), vault: escrowVault, amount: "9999", state: { variant: "Exited" } }, ...meta }], ...meta }, gauges: { realm: { rows: [{ address: key(27), value: { govMint: mnde }, ...meta }], ...meta } } } as any;
  const authorities = { evidence: [], authorities: [] } as any;
  return { rpc, infos, layer, participation, authorities, wallet, pda, protocol, labs, voter, treasuryToken, topToken };
}
test("synthetic holder reader reconciles supply, classifies roles, splits float and observes token-account outflows", async () => {
  const s = synthetic();
  const labels = [{ source: "test service", retrievedAt: meta.asOf, labels: [{ address: s.protocol, label: "Test protocol" }, { address: s.labs, label: "reported exchange" }] }];
  const result = await readHolders(s.rpc, registry, s.layer, s.participation, s.authorities, labels);
  expect(result.mnde.accounts.value).toBe(6); expect(result.mnde.nonZeroAccounts.value).toBe(5); expect(result.mnde.distinctNonZeroOwners.value).toBe(4);
  expect(result.mnde.differenceFromSupplyRaw.value).toBe("-50"); expect(result.mnde.nakamotoCoefficient.value).toBe(2);
  expect(result.float.verifiedOnly.raw).toBe("750"); expect(result.float.includingClaimed.raw).toBe("550");
  expect(result.classifications.find(c => c.address === s.labs)?.roles.map(r => r.basis)).toEqual(["claimed", "reported"]);
  expect(result.classifications.find(c => c.address === s.voter)?.roles[0].name).toBe("VSR voter account");
  expect(result.downstream.find(d => d.program === s.protocol)).toMatchObject({ msolHeldRaw: "40", basis: "observed", label: { name: "Test protocol", basis: "reported" } });
  expect(result.msol.top20.find(a => a.address === s.treasuryToken)?.roles[0].basis).toBe("derived");
  expect(result.msol.differenceFromSupplyRaw.value).toBe("0"); expect(result.asOfSlotRange).toEqual([100, 103]); expect(() => JSON.stringify(result)).not.toThrow();
});

test.skipIf(!hasFixture("getProgramAccounts", { programId: TOKEN_PROGRAM.toBase58(), filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mnde } }], dataSlice: { offset: 32, length: 40 } }))("mainnet holder sums and provenance (skipped until the mainnet fixtures are recorded)", async () => {
  const rpc = new RecordingRpc(runOptions({ record: false, offline: true }), "marinade-contracts");
  const layer = await readContractsLayer(rpc, registry, contracts), participation = await readParticipation(rpc, registry, contracts, layer), authorities = await readAuthorities(rpc, registry, layer);
  const result = await readHolders(rpc, registry, layer, participation, authorities);
  const total = result.mnde.owners.reduce((n, r) => n + BigInt(r.amountRaw), 0n);
  expect(String(total)).toBe(result.mnde.totalRaw.value); expect(String(total - BigInt(result.mnde.supplyRaw.value))).toBe(result.mnde.differenceFromSupplyRaw.value);
  expect(result.msol.top20.length).toBeLessThanOrEqual(20); expect(result.float.verifiedOnly.evidenceIds.length).toBeGreaterThan(0);
}, 120_000);


test("program-owned mSOL dependencies group by decoded program without signature guesses", async () => {
  const s = synthetic(); s.infos.set(s.pda, info(s.protocol));
  s.rpc.connection.getSignaturesForAddress = async () => { throw new Error("program-owned accounts do not need inference"); };
  const result = await readHolders(s.rpc, registry, s.layer, s.participation, s.authorities);
  expect(result.downstream.find(d => d.program === s.protocol)).toMatchObject({ basis: "decoded", label: null, msolHeldRaw: "40" });
  expect(result.downstreamObservations).toEqual([]);
});
test("unreconciled VSR float uses deposits and exposes the missing-vault condition", async () => {
  const s = synthetic(); s.participation.vsr.reconciliation.missing.value = 1; s.participation.vsr.reconciliation.vaultBalances.raw = "0";
  const result = await readHolders(s.rpc, registry, s.layer, s.participation, s.authorities);
  expect(result.float.verifiedOnly.raw).toBe("750"); expect(result.float.vsrReconciled.value).toBe(false);
  expect(result.float.components.find(c => c.name === "VSR custody")).toMatchObject({ raw: "200", method: "G3 decoded deposited total; vault reconciliation incomplete" });
});
