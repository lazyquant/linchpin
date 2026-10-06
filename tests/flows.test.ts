import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { DESTINATION_PATTERNS, snakeCase, instructionDiscriminator, tokenDeltas, tokenTransfers, attributeInstruction, walletCosts, aggregateBuybackMonths, compareRevenueWindows, declaredRoutes, matchFeeStatements, assembleVerdict, readFlows, type BuybackObservation } from "../src/contracts/flows";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { readContractsLayer } from "../src/contracts/marinade";
import { readParticipation, type ContractsLayer } from "../src/contracts/participation";
import { instructionInventory } from "../src/contracts/inventory";
import { key, vector, hasFixture } from "./helpers/contracts";

const meta = { evidenceIds: ["e"], slot: 100, asOf: "2026-10-06T00:00:00Z", basis: "derived" as const };
const liquid = vector("liquid-staking"), referral = vector("referral");
const wallet = key(1), mint = key(2), token = key(3), dest = key(4), program = key(5), usdc = key(6);
const balance = (accountIndex: number, amount: string, owner = wallet, mintAddress = mint, decimals = 9) => ({ accountIndex, owner, mint: mintAddress, uiTokenAmount: { amount, decimals } });
function tx() { return { slot: 100, blockTime: 1791244800, transaction: { message: { accountKeys: [wallet, token, dest, program, TOKEN_PROGRAM.toBase58(), key(7)], instructions: [{ programIdIndex: 3, accounts: [1], data: bs58.encode(instructionDiscriminator("liquidUnstake")) }] } }, meta: { err: null as any, fee: 5000, preBalances: [1e9], postBalances: [999995000], preTokenBalances: [balance(1, "10")], postTokenBalances: [balance(1, "30")], innerInstructions: [] as any[] } }; }
const parameter = (field: string, raw: number, unit = "hundredths of a basis point") => ({ field, raw, value: raw, unit, ...meta, basis: "decoded" as const, scaling: undefined });
const layer = { programs: [["liquid-staking", liquid], ["referral", referral]].map(([id, idl]: any) => ({ id, address: program, inventory: { instructions: instructionInventory(idl).map(ix => ({ ...ix, ...meta, accounts: ix.accounts.map(a => ({ ...a, ...meta })) })) } })),
  singletons: [{ program: "liquid-staking", address: key(8), value: { treasuryMsolAccount: token, liqPool: { msolLeg: dest } }, ...meta }], enumerations: [] } as unknown as ContractsLayer;
const participation = { referral: { rows: [{ address: key(9), value: { msolTokenPartnerAccount: dest }, ...meta }] } } as any;

describe("flow declarations and instruction identities", () => {
  test.each([["liquidUnstake", "liquid_unstake"], ["withdrawStakeAccount", "withdraw_stake_account"], ["HTTPServer", "http_server"], ["update_active", "update_active"], ["v2DepositSOL", "v2_deposit_sol"]])("snake case %s", (name, expected) => expect(snakeCase(name)).toBe(expected));
  test("Anchor discriminator is eight sha256 bytes", () => {
    expect(instructionDiscriminator("deposit").toString("hex")).toBe("f223c68952e1f2b6");
    expect(instructionDiscriminator("liquidUnstake")).toEqual(instructionDiscriminator("liquid_unstake"));
  });
  test("explicit destination patterns, nested treasury accounts and referral destinations", () => {
    expect(DESTINATION_PATTERNS).toEqual(["treasury", "fee", "partner", "beneficiary", "bond", "reserve", "leg", "vault"]);
    const routes = declaredRoutes(layer, participation, meta.asOf);
    expect(routes).toHaveLength(liquid.instructions.length + referral.instructions.length);
    for (const name of ["liquidUnstake", "withdrawStakeAccount", "updateActive", "updateDeactivated"]) {
      const r = routes.find(r => r.program === "liquid-staking" && r.instruction === name)!;
      expect(r.destinations.find(d => d.account.endsWith("treasuryMsolAccount"))?.resolutions[0].address).toBe(token);
    }
    expect(routes.find(r => r.instruction === "orderUnstake")?.note).toBe("no destination account declared");
    for (const name of ["deposit", "liquidUnstake"]) expect(routes.find(r => r.program === "referral" && r.instruction === name)?.destinations.find(d => d.account === "msolTokenPartnerAccount")?.resolutions[0].address).toBe(dest);
    expect(routes.find(r => r.instruction === "initialize")?.destinations.some(d => d.account === "treasuryMsolAccount")).toBe(false);
  });
  test("inner attribution and ambiguous calls never double allocate", () => {
    const t = tx(); t.meta.innerInstructions = [{ index: 0, instructions: [t.transaction.message.instructions[0]] }]; t.transaction.message.instructions = [];
    expect(attributeInstruction(t, program, liquid, token)).toMatchObject({ instruction: "liquidUnstake", candidates: [{ location: "inner", parentIndex: 0 }] });
    t.transaction.message.instructions = t.meta.innerInstructions[0].instructions;
    expect(attributeInstruction(t, program, liquid, token).instruction).toBe("ambiguous");
  });
});
describe("observed deltas, transfers and cost aggregation", () => {
  test("exact token deltas include creation and closure; absent metadata stays unknown", () => {
    const t = tx(); t.meta.preTokenBalances.push(balance(2, "90071992547409930"));
    expect(tokenDeltas(t)?.map(d => d.deltaRaw)).toEqual(["20", "-90071992547409930"]);
    t.meta.preTokenBalances = []; expect(tokenDeltas(t)?.[0].deltaRaw).toBe("30");
    expect(tokenDeltas({ ...t, meta: {} })).toBeNull();
  });
  test("changed authority is not attributed to its new wallet", () => {
    const t = tx(); t.meta.postTokenBalances[0].owner = dest;
    expect(tokenDeltas(t)?.[0]).toMatchObject({ owner: null, ownerChanged: true });
  });
  test("checked inner transfers preserve exact recipient, mint and enclosing program", () => {
    const t = tx(), b = Buffer.alloc(10); b[0] = 12; b.writeBigUInt64LE(20n, 1); b[9] = 9;
    t.meta.postTokenBalances.push(balance(2, "20", dest));
    t.meta.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: 4, accounts: [1, 5, 2, 0], data: bs58.encode(b) }] }];
    expect(tokenTransfers(t)[0]).toMatchObject({ source: token, destination: dest, destinationOwner: dest, amountRaw: "20", enclosingProgram: program });
    t.meta.err = { failed: true }; expect(tokenTransfers(t)).toEqual([]);
  });
  test("wallet costs net accounts by asset and exclude signature fees", () => {
    const t = tx(); t.meta.preTokenBalances.push(balance(2, "1000000", wallet, usdc, 6), balance(5, "0", wallet, usdc, 6));
    t.meta.postTokenBalances.push(balance(2, "0", wallet, usdc, 6), balance(5, "250000", wallet, usdc, 6));
    expect(walletCosts(t, wallet, mint).costs).toEqual([{ asset: usdc, raw: "750000", decimals: 6 }]);
  });
  test("UTC monthly aggregation pairs cost with purchases, not unrelated deposits", () => {
    const base: BuybackObservation = { ...meta, slot: 100, basis: "observed", signature: "s", blockTime: Date.parse("2026-09-30T23:59:59Z") / 1000, mndeDeltaRaw: "2000000000", boughtRaw: "2000000000", costs: [{ asset: usdc, raw: "1000000", decimals: 6 }], recipients: [] };
    const months = aggregateBuybackMonths([base, { ...base, boughtRaw: "0", costs: [], blockTime: Date.parse("2026-10-01T00:00:00Z") / 1000, recipients: [{ owner: wallet, destination: token, amountRaw: "100", voterAuthority: true }, { owner: dest, destination: dest, amountRaw: "300", voterAuthority: false }] }]);
    expect(months.map(m => m.month)).toEqual(["2026-09", "2026-10"]); expect(months[0].costs[0].averagePricePerMnde).toBe(0.5);
    expect(months[1].voterAuthorityShare.value).toBe(0.25); expect(months[1].mndeBoughtRaw.value).toBe("0");
  });
});
describe("claims and conservative verdict", () => {
  test("fee sentences match percent, bps and FeeCents; unrelated or ambiguous remain unresolved", () => {
    const capture = { retrievedAt: meta.asOf, claimSentences: [
      "Delayed unstaking of mSOL carries a 0.2% protocol fee.", "The reward fee is 2 basis points.", "Select charges a fee of 20 bps.", "Marinade takes 0% of the rewards the pool earns Delayed unstaking of mSOL carries a 0.2% protocol fee.",
    ].map(text => ({ text, page: "fees" })) };
    const result = matchFeeStatements(capture, [parameter("delayedUnstakeFee", 2000), parameter("rewardFee", 0, "basis points")]);
    expect(result.map(r => r.status)).toEqual(["verified", "contradiction", "unresolved", "verified", "verified"]);
    expect(result[0].actualBps).toBe(20);
  });
  test("v5 refuses mismatched windows, missing coverage, and different assets", () => {
    const w = { oldestBlockTime: 1, newestBlockTime: 100 };
    expect(compareRevenueWindows(w, { ...w, newestBlockTime: 101 }, 100n, 10n, true, true).ratio).toBeNull();
    expect(compareRevenueWindows(w, w, 100n, 10n, false, true).ratio).toBeNull();
    expect(compareRevenueWindows(w, w, 100n, 10n, true, false).ratio).toBeNull();
    expect(compareRevenueWindows(w, w, 100n, 10n, true, true)).toMatchObject({ ratio: 0.1, status: "unresolved" });
  });
  test("verdict keeps declarations, operations, claims and offsets separate", () => {
    const result = assembleVerdict(declaredRoutes(layer, participation, meta.asOf), [{ parameter: "rewardFee", evidenceIds: ["e"] }], [{ id: "v5", status: "unresolved", chainResult: "windows differ", evidenceIds: ["e"] }], [{ link: "DAO outflows" }], meta);
    expect(result.enforcedByCode.length).toBe(2); expect(result.operatedByAccounts).toHaveLength(1); expect(result.unverified[0].claim).toBe("v5"); expect(result.offsets).toEqual([{ link: "DAO outflows" }]);
  });
});
const registry = JSON.parse(readFileSync(new URL("../packs/marinade/registry.json", import.meta.url), "utf8"));
const contracts = JSON.parse(readFileSync(new URL("../packs/marinade/contracts.json", import.meta.url), "utf8"));
const docs = JSON.parse(readFileSync(new URL("../packs/marinade/sources/marinade-docs-capture-2026-10-05.json", import.meta.url), "utf8"));
const buyback = registry.accounts.find((a: any) => a.id === "buyback-accumulation").address;
import { associatedTokenAccount } from "../src/pack/classify";
const ata = associatedTokenAccount(new PublicKey(buyback), new PublicKey(registry.mints.find((m: any) => m.id === "mnde").address));
test.skipIf(!hasFixture("getSignaturesForAddress", { pubkey: ata.toBase58(), limit: 1000 }))("mainnet flows (skipped until Claude records G5 keys)", async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true, record: false }), "marinade-contracts");
  const layer = await readContractsLayer(rpc, registry, contracts), participation = await readParticipation(rpc, registry, contracts, layer);
  const result = await readFlows(rpc, registry, layer, participation, null, docs);
  expect(result.routes.length).toBeGreaterThan(0); expect(result.claims).toHaveLength(9); expect(result.treasury.transactionsRequested.value).toBeLessThanOrEqual(1000);
  expect(() => JSON.stringify(result)).not.toThrow();
}, 60000);

test("synthetic flow reader keeps missing transactions, treasury windows, purchases and voter payouts evidenced", async () => {
  const mnde = registry.mints.find((m: any) => m.id === "mnde").address, msol = registry.mints.find((m: any) => m.id === "msol").address;
  const authority = key(40), treasury = key(41), voterAuthority = key(42), recipientToken = key(43), costAccount = key(44);
  const rpc = new RecordingRpc(runOptions({ record: false, offline: false, rpcUrl: "http://127.0.0.1:1", minIntervalMs: 0 }), "synthetic-flows");
  const data = Buffer.alloc(165); new PublicKey(msol).toBuffer().copy(data); new PublicKey(authority).toBuffer().copy(data, 32);
  rpc.connection.getAccountInfoAndContext = async k => ({ context: { slot: 500 }, value: k.toBase58() === treasury ? { owner: TOKEN_PROGRAM, data, executable: false, lamports: 1, rentEpoch: 0 } : null });
  rpc.connection.getProgramAccounts = (async () => ({ context: { slot: 500 }, value: [] })) as any;
  const signatures = (names: string[]) => names.map((signature, i) => ({ signature, slot: 100 - i, blockTime: 1791244800 - i * 86400, err: null, memo: null }));
  rpc.connection.getSignaturesForAddress = async (k, opts) => {
    if (k.toBase58() === treasury) { expect(opts?.limit).toBe(1000); return signatures(["revenue", "missing"]); }
    if (k.toBase58() === authority) { expect(opts?.limit).toBe(200); return signatures(["payout"]); }
    expect(k.equals(ata)).toBe(true); expect(opts?.limit).toBe(1000); return signatures(["purchase", "distribution", "unknown-out"]);
  };
  const tr = (source: number, dest: number, n: bigint) => { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(n, 1); return { programIdIndex: 4, accounts: [source, dest, 0], data: bs58.encode(b) }; };
  function transaction(owner: string, account: string, recipient: string, before: string, after: string, asset: string) {
    return { slot: 100, blockTime: 1791244800, transaction: { message: { accountKeys: [owner, account, recipient, program, TOKEN_PROGRAM.toBase58(), costAccount], instructions: [] as any[] } },
      meta: { err: null, fee: 5000, preBalances: [10000], postBalances: [5000], preTokenBalances: [balance(1, before, owner, asset)], postTokenBalances: [balance(1, after, owner, asset)], innerInstructions: [] as any[] } };
  }
  const revenue = transaction(authority, treasury, recipientToken, "0", "1000000000", msol);
  revenue.transaction.message.instructions = [{ programIdIndex: 3, accounts: [1], data: bs58.encode(instructionDiscriminator("updateActive")) }];
  const purchase = transaction(buyback, ata.toBase58(), recipientToken, "0", "2000000000", mnde);
  purchase.meta.preTokenBalances.push(balance(5, "1000000", buyback, usdc, 6)); purchase.meta.postTokenBalances.push(balance(5, "0", buyback, usdc, 6));
  const distribution = transaction(buyback, ata.toBase58(), recipientToken, "2000000000", "1000000000", mnde);
  distribution.meta.postTokenBalances.push(balance(2, "1000000000", voterAuthority, mnde)); distribution.transaction.message.instructions = [tr(1, 2, 1000000000n)];
  const payout = transaction(authority, treasury, recipientToken, "1000000000", "0", msol);
  payout.meta.postTokenBalances.push(balance(2, "1000000000", buyback, msol)); payout.transaction.message.instructions = [tr(1, 2, 1000000000n)];
  const unknownOut = transaction(buyback, ata.toBase58(), recipientToken, "1000000000", "0", mnde);
  const transactions: Record<string, any> = { revenue, purchase, distribution, payout, "unknown-out": unknownOut };
  rpc.connection.getTransaction = async signature => transactions[signature] ?? null;
  const fullLayer = { ...layer, programs: layer.programs.map(p => ({ ...p, evidenceIds: ["e"], idl: { kind: "idl", idl: p.id === "liquid-staking" ? liquid : referral } })), authorities: [{ field: "treasuryMsolAccount", address: treasury }],
    parameters: [parameter("rewardFee", 0, "basis points"), parameter("delayedUnstakeFee", 2000)], claims: [{ id: "v1", status: "verified", note: "Decoded reward fee = 0", ...meta }], evidence: [] } as unknown as ContractsLayer;
  const fullParticipation = { ...participation, evidence: [], referral: { rows: [], partners: [] }, vsr: { timeLocked: meta, rows: [{ voterAuthority, evidenceIds: ["voter-evidence"], deposits: [{ mint: mnde, lockup: { kind: { variant: "Constant" } }, remainingSeconds: { value: "2592000" }, amountRaw: { value: "1" } }] }] } } as any;
  const result = await readFlows(rpc, registry, fullLayer, fullParticipation, null, docs);
  expect(result.treasury.transactionsRequested.value).toBe(2); expect(result.treasury.transactionsRead.value).toBe(1); expect(result.treasury.unavailableDeltas.value).toBe(1);
  expect(result.treasury.byInstruction[0]).toMatchObject({ instruction: "updateActive", inflowRaw: "1000000000", inflowMsol: "1" });
  expect(result.buybacks.months[0].mndeBoughtRaw.value).toBe("2000000000"); expect(result.buybacks.months[0].costs[0].averagePricePerMnde).toBe(0.5);
  expect(result.buybacks.months[0].unattributedOutflowRaw.value).toBe("1000000000"); expect(result.buybacks.voterAuthorityShare.value).toBe(0.5);
  expect(result.treasuryAuthority.transfers[0].destinationDetail.category).toBe("buyback wallet");
  expect(result.claims.find(c => c.id === "v9")?.status).toBe("verified"); expect(result.claims.find(c => c.id === "v5")?.status).toBe("unresolved");
  expect(result.claims.find(c => c.id === "v6")?.status).toBe("partly"); expect(() => JSON.stringify(result)).not.toThrow();
});
