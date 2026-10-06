import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { DESTINATION_PATTERNS, snakeCase, instructionDiscriminator, tokenDeltas, tokenTransfers, attributeInstruction, walletCosts, aggregateBuybackMonths, aggregateFunding, fundingCredits, distributorInstructions, aggregateDistributorClaims, readDistributor, compareRevenueWindows, declaredRoutes, matchFeeStatements, assembleVerdict, readFlows, type BuybackObservation } from "../src/contracts/flows";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { readContractsLayer } from "../src/contracts/marinade";
import { readParticipation, type ContractsLayer } from "../src/contracts/participation";
import { instructionInventory } from "../src/contracts/inventory";
import { key, vector, hasFixture, accountBytes } from "./helpers/contracts";

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
import { deflateSync } from "node:zlib";
import { idlAddress, type LegacyIdl } from "../src/contracts/idl";
const ata = associatedTokenAccount(new PublicKey(buyback), new PublicKey(registry.mints.find((m: any) => m.id === "mnde").address));
test.skipIf(!hasFixture("getSignaturesForAddress", { pubkey: buyback, limit: 1000 }))("mainnet flows (skipped until Claude records G5b keys)", async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true, record: false }), "marinade-contracts");
  const layer = await readContractsLayer(rpc, registry, contracts), participation = await readParticipation(rpc, registry, contracts, layer);
  const result = await readFlows(rpc, registry, layer, participation, null, docs);
  expect(result.routes.length).toBeGreaterThan(0); expect(result.claims).toHaveLength(9); expect(result.treasury.transactionsRequested.value).toBeLessThanOrEqual(1000);
  expect(result.buybackFunding.wallet).toBe(buyback); expect(Array.isArray(result.distributors)).toBe(true);
  expect(() => JSON.stringify(result)).not.toThrow();
}, 120_000);

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
    if (k.toBase58() === buyback) { expect(opts?.limit).toBe(1000); return signatures(["purchase", "payout", "labs-funding"]); }
    expect(k.equals(ata)).toBe(true); expect(opts?.limit).toBe(1000); return signatures(["purchase", "distribution", "unknown-out"]);
  };
  const tr = (source: number, dest: number, n: bigint) => { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(n, 1); return { programIdIndex: 4, accounts: [source, dest, 0], data: bs58.encode(b) }; };
  function transaction(owner: string, account: string, recipient: string, before: string, after: string, asset: string) {
    return { slot: 100, blockTime: 1791244800, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [owner, account, recipient, program, TOKEN_PROGRAM.toBase58(), costAccount], instructions: [] as any[] } },
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
  const labs = registry.accounts.find((a: any) => a.id === "labs-treasury").address;
  transactions["labs-funding"] = { slot: 100, blockTime: 1791244800, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [labs, buyback], instructions: [] } },
    meta: { err: null, fee: 5000, preBalances: [2000005000, 0], postBalances: [0, 2000000000], preTokenBalances: [], postTokenBalances: [] } };
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
  expect(result.buybackFunding.excludedPurchases.value).toBe(1);
  expect(result.buybackFunding.bySource[0]).toMatchObject({ source: authority, asset: msol, amountRaw: "1000000000" });
  expect(result.buybackFunding.sources.find(s => s.address === authority)?.roles[0]).toMatchObject({ name: "treasury mSOL account owner", basis: "decoded" });
  expect(result.claims.find(c => c.id === "v5")?.chainResult).toContain("Observed funding sources:");
  expect(result.buybackFunding.sources.find(s => s.address === labs)?.roles[0]).toMatchObject({ name: "Labs treasury", basis: "claimed" });
  expect(result.buybackFunding.months[0]).toMatchObject({ solReceivedRaw: "2000000000", solSpentOnMndeRaw: "0" });
  expect(result.verdict.operatedByAccounts.some(r => r.link.includes("funding source"))).toBe(true);
  expect(result.claims.find(c => c.id === "v9")?.status).toBe("verified"); expect(result.claims.find(c => c.id === "v5")?.status).toBe("unresolved");
  expect(result.claims.find(c => c.id === "v6")?.status).toBe("partly"); expect(() => JSON.stringify(result)).not.toThrow();
  // Exercise discovery from an actual buyback outflow, then drive v6 through the distributor.
  distribution.meta.postTokenBalances[1].owner = distributor;
  const previousAccountRead = rpc.connection.getAccountInfoAndContext, previousSignatures = rpc.connection.getSignaturesForAddress;
  const idlKey = await idlAddress(new PublicKey(program)), compressed = deflateSync(Buffer.from(JSON.stringify(distributorIdl))), header = Buffer.alloc(44);
  header.writeUInt32LE(compressed.length, 40);
  rpc.connection.getAccountInfoAndContext = async (k, options) => k.toBase58() === distributor || k.equals(idlKey) ? { context: { slot: 500 }, value: {
    owner: new PublicKey(program), executable: false, lamports: 1, rentEpoch: 0, data: k.equals(idlKey) ? Buffer.concat([header, compressed]) :
      accountBytes(distributorIdl, "Distributor", { mint: mnde, vault, admin: wallet, clawbackReceiver: wallet }),
  } } : previousAccountRead(k, options);
  rpc.connection.getSignaturesForAddress = async (k, options, commitment) => k.toBase58() === distributor ? (expect(options?.limit).toBe(300), signatures(["claim-one", "claim-two"])) :
    options?.limit === 50 ? [] : previousSignatures(k, options, commitment);
  transactions["claim-one"] = claimTx(voterAuthority); transactions["claim-two"] = claimTx(dest, "300");
  for (const t of [transactions["claim-one"], transactions["claim-two"]]) for (const b of [...t.meta.preTokenBalances, ...t.meta.postTokenBalances]) b.mint = mnde;
  const indirect = await readFlows(rpc, registry, fullLayer, fullParticipation, null, docs);
  expect(indirect.distributors).toHaveLength(1);
  expect(indirect.buybacks.voterAuthorityShare.value).toBe(0);
  expect(indirect.distributorSummary).toMatchObject({ distinctClaimants: 2, voterAuthorityClaimants: 1, claimedAmountShare: 0.25 });
  expect(indirect.claims.find(c => c.id === "v6")).toMatchObject({ status: "partly" });
  expect(indirect.claims.find(c => c.id === "v6")?.chainResult).toContain("1 of 2 sampled distributor claimants (25.00 %");
  expect(indirect.verdict.operatedByAccounts.some(r => r.link.includes("merkle_distributor"))).toBe(true);
  expect(indirect.verdict.enforcedByCode.some(r => r.link.includes(distributor))).toBe(false);
  expect(() => JSON.stringify(indirect)).not.toThrow();
});

const distributorIdl: LegacyIdl = { name: "merkle_distributor", version: "0.1.0", instructions: [
  { name: "claim", accounts: [{ name: "distributor", isMut: true, isSigner: false }, { name: "actors", accounts: [{ name: "claimant", isMut: true, isSigner: true }] }], args: [] },
  { name: "claimVested", accounts: [{ name: "distributor", isMut: true, isSigner: false }, { name: "userAuthority", isMut: true, isSigner: true }], args: [] },
  { name: "initialize", accounts: [], args: [] },
], accounts: [{ name: "Distributor", type: { kind: "struct", fields: [
  { name: "root", type: { array: ["u8", 32] } }, { name: "mint", type: "publicKey" }, { name: "vault", type: "publicKey" },
  { name: "maxTotalClaim", type: "u64" }, { name: "totalAmountClaimed", type: "u64" }, { name: "maxNumNodes", type: "u64" },
  { name: "admin", type: "publicKey" }, { name: "clawbackReceiver", type: "publicKey" },
] } }] };
const distributor = key(50), claimant = key(51), claimantToken = key(52), vault = key(53);
function claimTx(who = claimant, amount = "100", name = "claim"): any {
  return { slot: 123, blockTime: 1791244800, transaction: { message: { header: { numRequiredSignatures: 2 },
    accountKeys: [wallet, who, distributor, claimantToken, vault, program], instructions: [{ programIdIndex: 5, accounts: [2, 1], data: bs58.encode(instructionDiscriminator(name)) }] } },
    meta: { err: null, preTokenBalances: [balance(4, "1000", distributor)], postTokenBalances: [balance(4, String(1000n - BigInt(amount)), distributor), balance(3, amount, who)],
      preBalances: [10000, 0, 0, 0, 0, 0], postBalances: [5000, 0, 0, 0, 0, 0], fee: 5000, innerInstructions: [] } };
}
describe("distributor claim evidence", () => {
  test("discriminator names, nested signer roles and weighted current voter overlap", () => {
    const voters = new Set([claimant]);
    const a = distributorInstructions(claimTx(), program, distributor, distributorIdl, mint, voters);
    const b = distributorInstructions(claimTx(dest, "300", "claimVested"), program, distributor, distributorIdl, mint, voters);
    expect(a.instructions[0]).toMatchObject({ name: "claim", claimant, claimantBasis: "IDL signer role and transaction signer" });
    expect(a.claims[0]).toMatchObject({ amountRaw: "100", voterAuthority: true });
    expect(b.instructions[0].name).toBe("claimVested");
    expect(aggregateDistributorClaims([{ signature: "a", claims: a.claims }, { signature: "b", claims: b.claims }])).toMatchObject({
      claims: 2, distinctClaimants: 2, voterAuthorityClaimants: 1, totalClaimedRaw: "400", claimantShare: 0.5, claimedAmountShare: 0.25,
    });
  });
  test("non-signing IDL role falls back to fee payer; CPI and loaded keys decode", () => {
    const t = claimTx(); t.transaction.message.header.numRequiredSignatures = 1;
    t.meta.postTokenBalances[1].owner = wallet;
    const instruction = t.transaction.message.instructions.pop();
    t.meta.innerInstructions = [{ index: 0, instructions: [instruction] }];
    t.meta.loadedAddresses = { writable: [], readonly: [t.transaction.message.accountKeys.pop()] };
    const r = distributorInstructions(t, program, distributor, distributorIdl, mint, new Set([wallet]));
    expect(r.instructions[0]).toMatchObject({ claimant: wallet, claimantBasis: "fee payer fallback", parentIndex: 0 });
    expect(r.claims[0].amountRaw).toBe("100");
  });
  test("failed/unknown calls, missing metadata, repeated claims and ambiguous distributor deltas", () => {
    const t = claimTx(); t.meta.err = { failed: true };
    expect(distributorInstructions(t, program, distributor, distributorIdl, mint, new Set()).claims).toEqual([]);
    t.meta.err = null; t.transaction.message.instructions[0].data = bs58.encode(Buffer.alloc(8));
    expect(distributorInstructions(t, program, distributor, distributorIdl, mint, new Set()).instructions[0].name).toBeNull();
    const twice = claimTx(); twice.transaction.message.instructions.push(twice.transaction.message.instructions[0]);
    const r = distributorInstructions(twice, program, distributor, distributorIdl, mint, new Set());
    expect(aggregateDistributorClaims([{ signature: "twice", claims: r.claims }])).toMatchObject({ claims: 2, distinctClaimants: 1, totalClaimedRaw: "100" });
    twice.transaction.message.accountKeys.push(dest);
    twice.transaction.message.instructions[1] = { ...twice.transaction.message.instructions[0], accounts: [6, 1] };
    expect(distributorInstructions(twice, program, distributor, distributorIdl, mint, new Set()).claims[0]).toMatchObject({ amountRaw: null, ambiguous: true });
    delete twice.meta.preTokenBalances;
    expect(distributorInstructions(twice, program, distributor, distributorIdl, mint, new Set()).claims[0].amountRaw).toBeNull();
  });
  test("on-chain synthetic IDL/account, exact fields, vault balance and off-curve G2b resolution", async () => {
    const rpc = new RecordingRpc(runOptions({ record: false, rpcUrl: "http://127.0.0.1:1", minIntervalMs: 0 }), "synthetic-distributor");
    const admin = PublicKey.findProgramAddressSync([Buffer.from("admin")], new PublicKey(program))[0];
    const idlKey = await idlAddress(new PublicKey(program)), compressed = deflateSync(Buffer.from(JSON.stringify(distributorIdl))), header = Buffer.alloc(44);
    header.writeUInt32LE(compressed.length, 40);
    const account = accountBytes(distributorIdl, "Distributor", { root: Array(32).fill(7), mint, vault, maxTotalClaim: "90071992547409930", totalAmountClaimed: "400", maxNumNodes: "100", admin: admin.toBase58(), clawbackReceiver: wallet });
    const vaultData = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(vaultData); new PublicKey(distributor).toBuffer().copy(vaultData, 32); vaultData.writeBigUInt64LE(900n, 64);
    let published = true;
    rpc.connection.getAccountInfoAndContext = async k => ({ context: { slot: 123 }, value: k.equals(idlKey) ? published ? { data: Buffer.concat([header, compressed]), owner: new PublicKey(program), executable: false, lamports: 1, rentEpoch: 0 } : null :
      k.toBase58() === distributor ? { data: account, owner: new PublicKey(program), executable: false, lamports: 1, rentEpoch: 0 } :
      k.toBase58() === vault ? { data: vaultData, owner: TOKEN_PROGRAM, executable: false, lamports: 1, rentEpoch: 0 } : null });
    const resolvedAddresses: string[] = [];
    rpc.connection.getProgramAccounts = (async () => ({ context: { slot: 123 }, value: [] })) as any;
    rpc.connection.getSignaturesForAddress = async (k, options) => { expect(options?.limit).toBe(50); resolvedAddresses.push(k.toBase58()); return []; };
    const sample = async (address: string, limit: number) => { expect(address).toBe(distributor); expect(limit).toBe(300); return { address, limit, evidenceIds: ["history"], window: { oldestBlockTime: 1791244800, newestBlockTime: 1791244800 }, rows: [
      { ...meta, basis: "observed" as const, signature: "one", tx: claimTx(), blockTime: 1791244800 },
      { ...meta, basis: "observed" as const, signature: "two", tx: claimTx(dest, "300"), blockTime: 1791244800 },
      { ...meta, basis: "observed" as const, signature: "missing", tx: null, blockTime: null },
    ] }; };
    const p = { evidence: [], vsr: { rows: [{ voterAuthority: claimant, evidenceIds: ["voter"] }] } } as any;
    const read = () => readDistributor(rpc, registry, { evidence: [] } as any, { program: new PublicKey(registry.governance.program), governances: [] }, distributor, program, mint, p, sample);
    const result = await read();
    expect(result).toMatchObject({ status: "decoded", idlName: "merkle_distributor", account: { basis: "decoded", value: { maxTotalClaim: "90071992547409930", root: Array(32).fill(7), totalAmountClaimed: "400", maxNumNodes: "100" } }, summary: { claimedAmountShare: 0.25 } });
    expect(result.vaults[0]).toMatchObject({ balanceRaw: "900", mintMatches: true, ownerMatches: true, basis: "decoded" });
    expect(resolvedAddresses).toContain(admin.toBase58());
    expect(result.authorities.find(a => a.field === "admin")?.resolution?.status).toBe("unresolved");
    expect(result.transactions[2].unavailable).toBe(true); expect(() => JSON.stringify(result)).not.toThrow();
    published = false;
    const missing = await read(); expect(missing).toMatchObject({ status: "unresolved", account: null, idlName: null, summary: { claims: 0 } });
    expect(missing.transactions[0].observations?.programCalls).toHaveLength(1);
  });
});
function fundingTx(): any {
  return { slot: 100, transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [dest, wallet, program, SystemProgram.programId.toBase58()], instructions: [] } },
    meta: { err: null, fee: 5000, preBalances: [2000005000, 0, 0, 0], postBalances: [0, 2000000000, 0, 0], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] } };
}
describe("buyback wallet funding", () => {
  test("SOL credit excludes source fee and monthly totals compare existing purchase spend", () => {
    const a = fundingCredits(fundingTx(), wallet, mint);
    expect(a.credits[0]).toMatchObject({ asset: "SOL", sourceAccount: dest, sourceOwner: dest, amountRaw: "2000000000", attribution: "inferred from sole same-asset debit" });
    const months = aggregateBuybackMonths([{ ...meta, slot: 100, basis: "observed", signature: "purchase", blockTime: 1791244800, mndeDeltaRaw: "100", boughtRaw: "100", recipients: [], costs: [{ asset: "SOL", raw: "1500000000", decimals: 9 }] }]);
    const totals = aggregateFunding([{ blockTime: 1791244800, credits: a.credits }, { blockTime: null, credits: a.credits }], months);
    expect(totals.bySource[0].amountRaw).toBe("4000000000");
    expect(totals.months.find(m => m.month === "2026-10")).toMatchObject({ solReceivedRaw: "2000000000", solSpentOnMndeRaw: "1500000000" });
    expect(totals.months.find(m => m.month === "unknown")?.solReceivedRaw).toBe("2000000000");
  });
  test("multiple SOL sources reconcile decoded transfers; ambiguous candidates stay unallocated", () => {
    const t = fundingTx(); t.meta.preBalances = [1000005000, 0, 1000000000, 0];
    let r = fundingCredits(t, wallet, mint); expect(r.credits[0].sourceAccount).toBeNull(); expect(r.credits[0].candidates).toHaveLength(2);
    const transfer = (source: number) => { const b = Buffer.alloc(12); b.writeUInt32LE(2); b.writeBigUInt64LE(1000000000n, 4); return { programIdIndex: 3, accounts: [source, 1], data: bs58.encode(b) }; };
    t.transaction.message.instructions = [transfer(0), transfer(2)];
    r = fundingCredits(t, wallet, mint); expect(r.credits.map(c => [c.sourceAccount, c.amountRaw])).toEqual([[dest, "1000000000"], [program, "1000000000"]]);
  });
  test("signed MNDE purchases are excluded even with a SOL credit; unsigned receipts remain", () => {
    const t = fundingTx(); t.transaction.message.header.numRequiredSignatures = 2;
    t.transaction.message.accountKeys.push(token, claimantToken);
    t.meta.preTokenBalances = [balance(5, "100", wallet, usdc)];
    t.meta.postTokenBalances = [balance(4, "10", wallet), balance(5, "0", wallet, usdc)];
    expect(fundingCredits(t, wallet, mint)).toMatchObject({ excludedPurchase: true, credits: [] });
    t.transaction.message.header.numRequiredSignatures = 1;
    expect(fundingCredits(t, wallet, mint).credits[0].amountRaw).toBe("2000000000");
    t.meta.err = { failed: true }; expect(fundingCredits(t, wallet, mint).credits).toEqual([]);
    expect(fundingCredits(null, wallet, mint).unavailable).toBe(true);
  });
  test("other mint credits use the debited token account and its observed owner", () => {
    const t = fundingTx(); t.transaction.message.accountKeys.push(token, claimantToken);
    t.meta.preTokenBalances = [balance(4, "90071992547409930", dest, usdc, 6)];
    t.meta.postTokenBalances = [balance(5, "90071992547409930", wallet, usdc, 6)];
    const r = fundingCredits(t, wallet, mint);
    expect(r.credits[1]).toMatchObject({ asset: usdc, decimals: 6, sourceAccount: token, sourceOwner: dest, amountRaw: "90071992547409930" });
    delete t.meta.preTokenBalances; expect(fundingCredits(t, wallet, mint).unavailable).toBe(true);
  });
});
