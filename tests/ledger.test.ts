import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, type AccountInfo, type GetProgramAccountsFilter } from "@solana/web3.js";
import { Governance, Proposal, ProposalOption, ProposalState, ProposalTransaction, InstructionData, AccountMetaData, getAccountTypes, getNativeTreasuryAddress, getProposalTransactionAddress, GOVERNANCE_ACCOUNT_SCHEMA_V2 } from "@solana/spl-governance";
import { serialize } from "borsh";
import bs58 from "bs58";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { ASSOCIATED_TOKEN_PROGRAM } from "../src/governance/decode";
import { type ProposalBundle, type RawInstruction } from "../src/governance/reader";
import { type Receipt } from "../src/governance/receipt";
import { buildTreasuryLedger, ledgerEntriesFromBundle, ledgerSummary, listRealmProposals, proposalDisposition } from "../src/pack/ledger";
import { buildPack, type PackRegistry } from "../src/pack/build";
import { renderJson, renderPackHtml } from "../src/pack/packet";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const program = key(1), realm = key(2), governance = key(3), proposal = key(4), mint = key(5), source = key(6), destination = key(7), recipient = key(8);
const treasury = (await getNativeTreasuryAddress(program, governance)).toBase58();
const txAddress = (await getProposalTransactionAddress(program, 3, proposal, 0, 0)).toBase58();
const addr = (pk: PublicKey) => pk.toBase58();
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(join(process.cwd(), ".ledger-test-")); tempDirs.push(dir); return dir; }
function instruction(tag: number, amount: bigint, accounts: PublicKey[]): RawInstruction {
  const data = Buffer.alloc(9); data[0] = tag; data.writeBigUInt64LE(amount, 1);
  return { programId: TOKEN_PROGRAM.toBase58(), accounts: accounts.map(pk => ({ pubkey: addr(pk), isSigner: false, isWritable: true })), dataHex: data.toString("hex") };
}
function bundle(): ProposalBundle {
  return {
    programId: addr(program), programVersion: 3,
    proposal: { address: addr(proposal), name: "Synthetic burn and transfer", descriptionLink: "", state: ProposalState.Completed, stateName: "Completed", governance: addr(governance), governingTokenMint: addr(mint),
      options: [{ label: "Approve", voteWeightRaw: "1", voteResult: 1, instructionsCount: 1, instructionsExecutedCount: 1 }], maxVoteWeightRaw: null, abstainVoteWeightRaw: null, voteThreshold: null,
      executionDelaySeconds: null, denyVoteWeightRaw: null, vetoVoteWeightRaw: null, draftAt: null, votingAt: null, votingCompletedAt: 90, executingAt: 100, closedAt: 100, evidenceId: "proposal-evidence" },
    governance: { address: addr(governance), realm: addr(realm), governedAccount: addr(source), nativeTreasury: treasury, baseVotingTime: 0, votingCoolOffTime: 0, minInstructionHoldUpTime: 0, evidenceId: "governance-evidence" },
    realm: { address: addr(realm), name: "Synthetic", communityMint: addr(mint), councilMint: null, authority: null, evidenceId: "realm-evidence" },
    transactions: [{ address: txAddress, optionIndex: 0, index: 0, holdUpTime: 0, executedAt: 100, executionStatus: 1, evidenceId: "tx-evidence", instructions: [instruction(8, 200n, [source, mint, new PublicKey(treasury)]), instruction(3, 300n, [source, destination, new PublicKey(treasury)])] }],
    tokenAccounts: {
      [addr(source)]: { mint: addr(mint), owner: treasury, amountRaw: 500n, slot: 99, evidenceId: "source-evidence" },
      [addr(destination)]: { mint: addr(mint), owner: addr(recipient), amountRaw: 300n, slot: 99, evidenceId: "destination-evidence" },
    },
    mints: { [addr(mint)]: { decimals: 2, supplyRaw: 10000n, mintAuthority: null, freezeAuthority: null, slot: 99, evidenceId: "mint-evidence" } },
  };
}
function receipt(): Receipt {
  return { txIndex: 0, proposalTransaction: txAddress, signature: "synthetic-signature", slot: 88, blockTime: 100, success: true,
    programsInvoked: [addr(program)], innerPrograms: [TOKEN_PROGRAM.toBase58()], governanceExecuteLogged: true,
    tokenBalances: [
      { account: addr(source), mint: addr(mint), owner: treasury, preRaw: "1000", postRaw: "500", deltaRaw: "-500" },
      { account: addr(destination), mint: addr(mint), owner: addr(recipient), preRaw: "0", postRaw: "300", deltaRaw: "300" },
    ], logs: [], evidenceIds: ["signatures-evidence", "receipt-evidence"] };
}

test("proposal filtering requires payload and exactly Completed, Executing or Succeeded", () => {
  for (const state of Object.values(ProposalState).filter((s): s is number => typeof s === "number")) {
    expect(proposalDisposition({ state, options: [] })).toBe("no executable payload");
    expect(proposalDisposition({ state, options: [{ instructionsCount: 0 }] })).toBe("no executable payload");
    expect(proposalDisposition({ state, options: [{ instructionsCount: 0 }, { instructionsCount: 2 }] })).toBe(
      [ProposalState.Completed, ProposalState.Executing, ProposalState.Succeeded].includes(state) ? "payload" : "not executed");
  }
});

test("synthetic burn and transfer produce two evidenced entries with exact per-mint totals", () => {
  const rows = ledgerEntriesFromBundle(bundle(), [receipt()]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ kind: "burn", asset: addr(mint), amountRaw: "200", amountDisplay: "2", sourceOwner: treasury, sourceIsDaoTreasury: true, destination: null, basis: "observed", reconciliation: "matched", receiptSlot: 88, txIndex: 0, ixIndex: 0 });
  expect(rows[1]).toMatchObject({ kind: "transfer", amountRaw: "300", amountDisplay: "3", destination: addr(destination), destinationOwner: addr(recipient), receiptSignature: "synthetic-signature", ixIndex: 1 });
  for (const row of rows) {
    expect(row.evidenceIds).toContain("mint-evidence"); expect(row.evidenceIds).toContain("receipt-evidence");
    expect(row.slots).toEqual([99, 88]);
  }
  expect(ledgerSummary(rows).assets).toEqual([{ asset: addr(mint), decimals: 2, outflowsRaw: "500", inflowsRaw: "0", burnsRaw: "200", outflowsDisplay: "5", inflowsDisplay: "0", burnsDisplay: "2" }]);
  expect(ledgerSummary(rows).countsByKind).toMatchObject({ burn: 1, transfer: 1 });
});

test("unsupported program stays visible, including SOL instructions, without invented token amounts", () => {
  const b = bundle(); b.transactions[0].instructions = [{ programId: "11111111111111111111111111111111", accounts: [], dataHex: "02000000" }];
  const rows = ledgerEntriesFromBundle(b, [receipt()]);
  expect(rows[0]).toMatchObject({ kind: "unsupported", programId: "11111111111111111111111111111111", asset: null, amountRaw: null, basis: "decoded", reconciliation: "not-reconcilable" });
  expect(ledgerSummary(rows).unsupportedPrograms).toEqual(["11111111111111111111111111111111"]);
  expect(ledgerSummary(rows).assets).toEqual([]);
});

test("unexecuted, missing, failed and mismatched receipts never contribute executed totals", () => {
  for (const mode of ["unexecuted", "missing", "failed", "mismatch"] as const) {
    const b = bundle(), r = receipt();
    if (mode === "unexecuted") b.transactions[0].executedAt = null;
    if (mode === "failed") r.success = false;
    if (mode === "mismatch") { r.tokenBalances[0].deltaRaw = "-501"; r.tokenBalances[1].deltaRaw = "299"; }
    const rows = ledgerEntriesFromBundle(b, mode === "missing" ? [] : [r]);
    expect(rows.every(row => row.basis === "decoded")).toBe(true);
    expect(ledgerSummary(rows).assets).toEqual([]);
  }
});

test("mint credits and transfers reconcile transaction net changes and preserve historical owners", () => {
  const b = bundle(), r = receipt();
  b.transactions[0].instructions.push(instruction(7, 100n, [mint, source, recipient]));
  r.tokenBalances[0] = { ...r.tokenBalances[0], postRaw: "600", deltaRaw: "-400" };
  b.tokenAccounts[addr(source)].owner = addr(recipient);
  const rows = ledgerEntriesFromBundle(b, [r]);
  expect(rows.every(row => row.reconciliation === "matched")).toBe(true);
  expect(rows[2]).toMatchObject({ kind: "mintTo", amountRaw: "100", destinationOwner: treasury, destinationIsDaoTreasury: true });
  expect(ledgerSummary(rows).assets[0]).toMatchObject({ outflowsRaw: "500", inflowsRaw: "100", burnsRaw: "200" });
});

test("destination mismatch cannot be reported as a matched transfer", () => {
  const r = receipt(); r.tokenBalances[1].deltaRaw = "299";
  const rows = ledgerEntriesFromBundle(bundle(), [r]);
  expect(rows[1].reconciliation).toBe("mismatch");
  expect(ledgerSummary(rows).assets[0].outflowsRaw).toBe("200");
});

test("ATA creation and authority changes produce rows; uncaptured mint units remain raw", () => {
  const b = bundle(); b.mints = {};
  b.transactions[0].instructions.push({ programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [recipient, destination, recipient, mint, key(0), TOKEN_PROGRAM].map(pk => ({ pubkey: addr(pk), isSigner: false, isWritable: false })), dataHex: "01" });
  b.transactions[0].instructions.push({ programId: TOKEN_PROGRAM.toBase58(), accounts: [{ pubkey: addr(source), isSigner: false, isWritable: true }], dataHex: "060200" });
  const rows = ledgerEntriesFromBundle(b, [receipt()]);
  expect(rows[0].amountDisplay).toBe("200 raw (decimals unknown)");
  expect(rows[2]).toMatchObject({ kind: "createAccount", destination: addr(destination), destinationOwner: addr(recipient), asset: addr(mint) });
  expect(rows[3]).toMatchObject({ kind: "setAuthority", source: addr(source) });
});

test("summary uses bigint math, separate assets, gross internal flows and excludes non-DAO outflows", () => {
  const base = ledgerEntriesFromBundle(bundle(), [receipt()])[1];
  const huge = "900719925474099312345";
  const rows = [
    { ...base, amountRaw: huge, destinationIsDaoTreasury: true },
    { ...base, amountRaw: "2", sourceIsDaoTreasury: false, destinationIsDaoTreasury: true },
    { ...base, kind: "burn" as const, amountRaw: "7" },
    { ...base, kind: "burn" as const, amountRaw: "11", sourceIsDaoTreasury: false },
    { ...base, asset: addr(key(20)), decimals: null, amountRaw: "30" },
  ];
  const summary = ledgerSummary(rows);
  expect(summary.assets.find(a => a.asset === addr(mint))).toMatchObject({ outflowsRaw: "900719925474099312352", inflowsRaw: "900719925474099312347", burnsRaw: "18" });
  expect(summary.assets.find(a => a.asset === addr(key(20)))).toMatchObject({ outflowsRaw: "30", outflowsDisplay: "30 raw (decimals unknown)" });
  expect(summary.countsByKind).toMatchObject({ transfer: 3, burn: 2 });
});

// Exercise the real SDK parser, bundle reader, receipt finder and recorder using
// synthetic Borsh accounts and stubbed transport. No stored chain fixtures needed.
async function syntheticRpc(record = false) {
  const rpc = new RecordingRpc(runOptions({ offline: false, record, fixturesDir: tempDir(), rpcUrl: "http://127.0.0.1:1" }), "ledger");
  const account = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, executable: false, lamports: 1, rentEpoch: 0 });
  const proposalData = (state: ProposalState, count: number, name: string) => Buffer.from(serialize(GOVERNANCE_ACCOUNT_SCHEMA_V2, Object.assign(new Proposal({
    accountType: 14, governance, governingTokenMint: mint, state, tokenOwnerRecord: key(9), signatoriesCount: 0, signatoriesSignedOffCount: 0,
    voteType: { type: 0 }, options: [new ProposalOption({ label: "Approve", voteWeight: 1, voteResult: 1, instructionsExecutedCount: count, instructionsCount: count, instructionsNextIndex: count } as any)],
    denyVoteWeight: null, reserved1: 0, abstainVoteWeight: null, startVotingAt: null, draftAt: 1, signingOffAt: null, votingAt: null, votingAtSlot: null,
    votingCompletedAt: 90, executingAt: 100, closedAt: null, executionFlags: 0, maxVoteWeight: null, maxVotingTime: null, voteThreshold: null, reserved: Array(64).fill(0), name, descriptionLink: "", vetoVoteWeight: 0,
  } as any), { reserved: Array(64).fill(0) })));
  const govData = Buffer.alloc(236); govData[0] = getAccountTypes(Governance)[0]; realm.toBuffer().copy(govData, 1);
  const realmData = Buffer.alloc(512); realmData[0] = 16; mint.toBuffer().copy(realmData, 1);
  const txData = Buffer.from(serialize(GOVERNANCE_ACCOUNT_SCHEMA_V2, new ProposalTransaction({ accountType: 13, proposal, optionIndex: 0, instructionIndex: 0, holdUpTime: 0, executedAt: 100, executionStatus: 1,
    instructions: bundle().transactions[0].instructions.map(ix => new InstructionData({ programId: new PublicKey(ix.programId), accounts: ix.accounts.map(a => new AccountMetaData({ ...a, pubkey: new PublicKey(a.pubkey) })), data: Buffer.from(ix.dataHex, "hex") })),
  } as any)));
  const mintData = Buffer.alloc(82); mintData[44] = 2; mintData.writeBigUInt64LE(10000n, 36);
  const tokenData = (owner: string) => { const data = Buffer.alloc(165); mint.toBuffer().copy(data); new PublicKey(owner).toBuffer().copy(data, 32); return data; };
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [addr(governance), account(program, govData)], [addr(realm), account(program, realmData)],
    [addr(proposal), account(program, proposalData(ProposalState.Completed, 1, "<Synthetic proposal>"))],
    [addr(key(10)), account(program, proposalData(ProposalState.Completed, 0, "No payload"))],
    [addr(key(11)), account(program, proposalData(ProposalState.Cancelled, 1, "Not executed"))],
    [txAddress, account(program, txData)], [addr(mint), account(TOKEN_PROGRAM, mintData)],
    [addr(source), account(TOKEN_PROGRAM, tokenData(treasury))], [addr(destination), account(TOKEN_PROGRAM, tokenData(addr(recipient)))],
  ]);
  rpc.connection.getAccountInfoAndContext = async pk => ({ context: { slot: 100 }, value: accounts.get(addr(pk)) ?? null });
  (rpc.connection as any).getProgramAccounts = async (id: PublicKey, config: { filters: GetProgramAccountsFilter[]; withContext: boolean }) => {
    expect(id.equals(program)).toBe(true); expect(config.withContext).toBe(true);
    const filters = config.filters as { memcmp: { bytes: string; offset: number } }[];
    return { context: { slot: 100 }, value: [...accounts].filter(([, a]) => a.owner.equals(program) && filters.every(f => a.data.subarray(f.memcmp.offset, f.memcmp.offset + bs58.decode(f.memcmp.bytes).length).equals(Buffer.from(bs58.decode(f.memcmp.bytes))))).map(([pk, account]) => ({ pubkey: new PublicKey(pk), account })) };
  };
  rpc.connection.getSignaturesForAddress = async () => [{ signature: "synthetic-signature", slot: 88, blockTime: 100, err: null, memo: null }];
  rpc.connection.getTransaction = async () => ({ slot: 88, blockTime: 100, transaction: { message: { accountKeys: [source, destination, program, TOKEN_PROGRAM], instructions: [{ programIdIndex: 2 }] } },
    meta: { err: null, logMessages: ["Program log: GOVERNANCE-INSTRUCTION: ExecuteTransaction"], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 3 }] }],
      preTokenBalances: receipt().tokenBalances.map((b, accountIndex) => ({ accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.preRaw } })),
      postTokenBalances: receipt().tokenBalances.map((b, accountIndex) => ({ accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.postRaw } })),
    } } as any);
  return { rpc, accounts };
}

test("discovery and full ledger build record all reads and replay without a connection", async () => {
  const { rpc } = await syntheticRpc(true);
  const proposals = await listRealmProposals(rpc, program, realm);
  expect(proposals).toHaveLength(3);
  expect(proposals.find(p => p.proposal === addr(proposal))).toMatchObject({ governance: addr(governance), name: "<Synthetic proposal>", stateName: "Completed", votingCompletedAt: 90, executingAt: 100, options: [{ instructionsCount: 1 }], slot: 100 });
  expect(rpc.evidence.filter(e => e.method === "getProgramAccounts")).toHaveLength(getAccountTypes(Governance).length + getAccountTypes(Proposal).length);
  const ledger = await buildTreasuryLedger(rpc, program, 3, proposals);
  expect(ledger.entries).toHaveLength(2);
  expect(ledger).toMatchObject({ proposalsScanned: 3, proposalsWithPayload: 2 });
  expect(ledger.proposals.map(p => p.disposition).sort()).toEqual(["no executable payload", "not executed", "payload"]);
  expect(ledger.summary.assets[0]).toMatchObject({ outflowsRaw: "500", burnsRaw: "200" });
  const ids = new Set(rpc.evidence.map(e => e.id));
  expect(ledger.entries.every(e => e.evidenceIds.length > 0 && e.evidenceIds.every(id => ids.has(id)) && e.slots.includes(100))).toBe(true);
  expect(new Set(rpc.evidence.map(e => e.method))).toEqual(new Set(["getProgramAccounts", "getAccountInfo", "getSignaturesForAddress", "getTransaction"]));
  const offline = new RecordingRpc({ ...rpc.opts, offline: true, record: false }, "ledger");
  for (const method of ["getAccountInfoAndContext", "getProgramAccounts", "getSignaturesForAddress", "getTransaction"] as const) (offline.connection as any)[method] = async () => { throw new Error("offline attempted network"); };
  const replay = await buildTreasuryLedger(offline, program, 3, await listRealmProposals(offline, program, realm));
  expect(replay).toEqual(ledger);
});

test("proposal cap is explicit and skipped proposals do not trigger bundle reads", async () => {
  const { rpc } = await syntheticRpc();
  const proposals = await listRealmProposals(rpc, program, realm);
  rpc.connection.getAccountInfoAndContext = async () => { throw new Error("unexpected bundle read"); };
  const ledger = await buildTreasuryLedger(rpc, program, 3, proposals, { maxProposals: 0 });
  expect(ledger.entries).toEqual([]);
  expect(ledger.proposals.some(p => p.disposition === "limit reached")).toBe(true);
  expect(ledger.notes.join(" ")).toContain("truncated");
  await expect(buildTreasuryLedger(rpc, program, 3, proposals, { maxProposals: -1 })).rejects.toThrow("maxProposals");
});

test("discovery queries proposals for every governance in the realm and excludes foreign realms", async () => {
  const { rpc, accounts } = await syntheticRpc();
  const gov = accounts.get(addr(governance))!;
  const otherGovernance = key(12);
  accounts.set(addr(otherGovernance), { ...gov, data: Buffer.from(gov.data) });
  const foreign = Buffer.from(gov.data); key(14).toBuffer().copy(foreign, 1);
  accounts.set(addr(key(13)), { ...gov, data: foreign });
  const p = accounts.get(addr(proposal))!;
  const otherProposal = Buffer.from(p.data); otherGovernance.toBuffer().copy(otherProposal, 1);
  accounts.set(addr(key(15)), { ...p, data: otherProposal });
  const proposals = await listRealmProposals(rpc, program, realm);
  expect(proposals).toHaveLength(4);
  expect(proposals.find(p => p.proposal === addr(key(15)))?.governance).toBe(addr(otherGovernance));
  expect(rpc.evidence.filter(e => e.method === "getProgramAccounts")).toHaveLength(getAccountTypes(Governance).length + 2 * getAccountTypes(Proposal).length);
});

const registry: PackRegistry = { pack: "synthetic", title: "Synthetic", retrievedAt: "2026-10-05", researchQuestion: "Treasury movements?", sources: {}, programs: [], mints: [], accounts: [],
  governance: { program: addr(program), realm: addr(realm), councilMint: addr(mint), knownGovernances: [], claims: [] }, valueRouteClaims: [], unknownsSeed: [] };

test("pack integration renders ledger, escapes proposal names and retains row evidence in JSON", async () => {
  const { rpc } = await syntheticRpc();
  const packet = await buildPack(rpc, registry, { ledger: { enabled: true, maxProposals: 300 } });
  const html = renderPackHtml(packet, addr(realm));
  expect(html).toContain("DAO treasury ledger (from governance)");
  expect(html).toContain("&lt;Synthetic proposal&gt;"); expect(html).not.toContain("<Synthetic proposal>");
  expect(html).toContain("no executable payload"); expect(html).toContain("not executed");
  expect(JSON.parse(renderJson(packet)).ledger.entries[0]).toMatchObject({ receiptSlot: 88, evidenceIds: packet.ledger.entries[0].evidenceIds, slots: packet.ledger.entries[0].slots });
});

test("offline pack falls back only for missing ledger fixtures and discards partial ledgers", async () => {
  const { rpc } = await syntheticRpc(true);
  await listRealmProposals(rpc, program, realm); // Discovery recorded; bundle reads deliberately absent.
  const offline = new RecordingRpc({ ...rpc.opts, offline: true, record: false }, "ledger");
  const packet = await buildPack(offline, registry, { ledger: { enabled: true } });
  expect(packet.ledger.entries).toEqual([]); expect(packet.ledger.notes).toEqual(["ledger not recorded yet"]);
  expect(renderPackHtml(packet, addr(realm))).toContain("ledger not recorded yet");
  const live = new RecordingRpc({ ...rpc.opts, record: false }, "ledger");
  live.getProgramAccounts = rpc.getProgramAccounts.bind(rpc);
  live.connection.getAccountInfoAndContext = async () => { throw new Error("synthetic transport error"); };
  await expect(buildPack(live, registry, { ledger: { enabled: true } })).rejects.toThrow("synthetic transport error");
});

test("missing transaction accounts stay visible as a coverage note", async () => {
  const { rpc, accounts } = await syntheticRpc(); accounts.delete(txAddress);
  const ledger = await buildTreasuryLedger(rpc, program, 3, await listRealmProposals(rpc, program, realm));
  expect(ledger.entries).toEqual([]);
  expect(ledger.notes.join(" ")).toContain("1 proposal transaction account(s) missing");
});
