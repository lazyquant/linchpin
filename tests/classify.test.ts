import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type GetProgramAccountsFilter } from "@solana/web3.js";
import { getAccountTypes, getNativeTreasuryAddress, Governance } from "@solana/spl-governance";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { associatedTokenAccount, classifyAuthority, listGovernances, readMintState, readTokenAccount } from "../src/pack/classify";

const program = new PublicKey(Buffer.alloc(32, 9));
const realm = new PublicKey(Buffer.alloc(32, 8));
const governance = new PublicKey(Buffer.alloc(32, 7));
const mint = new PublicKey(Buffer.alloc(32, 6));
const wallet = Keypair.fromSeed(Buffer.alloc(32, 5)).publicKey;
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("synthetic")], program);
const ctx = { program, governances: [governance] };
const account = (owner: PublicKey, data = Buffer.alloc(0)): AccountInfo<Buffer> =>
  ({ owner, data, executable: false, lamports: 1, rentEpoch: 0 });

function syntheticRpc(value: AccountInfo<Buffer> | null) {
  const rpc = new RecordingRpc(runOptions({ offline: false, rpcUrl: "http://127.0.0.1:1" }), "synthetic-classify");
  rpc.connection.getAccountInfoAndContext = async () => ({ context: { slot: 42 }, value });
  return rpc;
}
function tokenData() {
  const data = Buffer.alloc(165); mint.toBuffer().copy(data); wallet.toBuffer().copy(data, 32); data.writeBigUInt64LE(123456789012345678n, 64);
  return data;
}

describe("authority classification", () => {
  test.each([
    ["dao-governance-account", pda, account(program)],
    ["squads-v4-account", pda, account(new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"))],
    ["squads-v3-account", pda, account(new PublicKey("SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu"))],
    ["wallet", wallet, account(SystemProgram.programId)],
    ["pda-no-account", pda, null],
    ["wallet-no-account", wallet, null],
    ["program-owned", pda, account(mint)],
    ["program-owned", pda, account(SystemProgram.programId)],
    ["program-owned", wallet, account(TOKEN_PROGRAM, Buffer.alloc(82))],
  ] as const)("classifies %s with account owner and evidence", async (kind, address, value) => {
    const rpc = syntheticRpc(value);
    expect(await classifyAuthority(rpc, address, ctx)).toMatchObject({
      kind, address: address.toBase58(), onCurve: PublicKey.isOnCurve(address.toBytes()),
      owner: value?.owner.toBase58() ?? null, slot: 42, evidenceIds: [rpc.evidence[0].id],
    });
  });
  test.each([true, false])("recognizes derived native treasury even if account exists = %s", async exists => {
    const treasury = await getNativeTreasuryAddress(program, governance);
    const rpc = syntheticRpc(exists ? account(SystemProgram.programId) : null);
    expect(await classifyAuthority(rpc, treasury, ctx)).toMatchObject({
      kind: "native-treasury-pda", governance: governance.toBase58(), address: treasury.toBase58(), onCurve: false,
      owner: exists ? SystemProgram.programId.toBase58() : null, evidenceIds: [rpc.evidence[0].id],
    });
  });
  test("token account separates the chain owner from the token authority", async () => {
    expect(await classifyAuthority(syntheticRpc(account(TOKEN_PROGRAM, tokenData())), pda, ctx)).toMatchObject({
      kind: "token-account", owner: TOKEN_PROGRAM.toBase58(), tokenOwner: wallet.toBase58(), mint: mint.toBase58(), amountRaw: 123456789012345678n,
    });
  });
});

describe("state readers", () => {
  test("mint parser carries authorities, supply, slot and evidence", async () => {
    const data = Buffer.alloc(82); data.writeUInt32LE(1); wallet.toBuffer().copy(data, 4);
    data.writeBigUInt64LE(699997047681352988n, 36); data[44] = 9;
    data.writeUInt32LE(1, 46); pda.toBuffer().copy(data, 50);
    const rpc = syntheticRpc(account(TOKEN_PROGRAM, data));
    expect(await readMintState(rpc, mint)).toEqual({ address: mint.toBase58(), value: {
      supplyRaw: 699997047681352988n, decimals: 9, mintAuthority: wallet.toBase58(), freezeAuthority: pda.toBase58(),
    }, slot: 42, evidenceIds: [rpc.evidence[0].id] });
  });
  test("mint parser preserves absent authorities", async () => {
    expect((await readMintState(syntheticRpc(account(TOKEN_PROGRAM, Buffer.alloc(82))), mint)).value).toMatchObject({ mintAuthority: null, freezeAuthority: null });
  });
  test("token parser carries raw amount, slot and evidence", async () => {
    const rpc = syntheticRpc(account(TOKEN_PROGRAM, tokenData()));
    expect(await readTokenAccount(rpc, pda)).toEqual({ address: pda.toBase58(), value: {
      mint: mint.toBase58(), owner: wallet.toBase58(), amountRaw: 123456789012345678n,
    }, slot: 42, evidenceIds: [rpc.evidence[0].id] });
  });
  test.each([null, account(SystemProgram.programId, tokenData()), account(TOKEN_PROGRAM, Buffer.alloc(81))])("non-token states skip gracefully with evidence", async value => {
    const rpc = syntheticRpc(value);
    expect(await readTokenAccount(rpc, pda)).toEqual({ address: pda.toBase58(), value: null, slot: 42, evidenceIds: [rpc.evidence[0].id] });
    expect((await readMintState(rpc, mint)).value).toBeNull();
  });
  test("mint and token layouts cannot be mistaken for each other", async () => {
    expect((await readMintState(syntheticRpc(account(TOKEN_PROGRAM, tokenData())), mint)).value).toBeNull();
    expect((await readTokenAccount(syntheticRpc(account(TOKEN_PROGRAM, Buffer.alloc(82))), pda)).value).toBeNull();
  });
  test("ATA derivation matches SPL Token for wallets and PDAs", () => {
    for (const owner of [wallet, pda]) expect(associatedTokenAccount(owner, mint).equals(getAssociatedTokenAddressSync(mint, owner, true))).toBe(true);
  });
});

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("governance SDK parses synthetic recorded program accounts and replays offline", async () => {
  const fixturesDir = mkdtempSync(join(process.cwd(), ".governance-test-")); tempDirs.push(fixturesDir);
  const rpc = new RecordingRpc(runOptions({ offline: false, record: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "synthetic");
  const types = getAccountTypes(Governance);
  // A zero-filled 236-byte GovernanceV2 layout with disabled vote thresholds is valid Borsh.
  const entries = types.map((type, index) => {
    const data = Buffer.alloc(236); data[0] = type; realm.toBuffer().copy(data, 1);
    return { pubkey: new PublicKey(Buffer.alloc(32, index + 20)), account: account(program, data) };
  });
  let calls = 0;
  (rpc.connection as any).getProgramAccounts = async (id: PublicKey, config: { filters: GetProgramAccountsFilter[]; withContext: boolean }) => {
    expect(id.equals(program)).toBe(true);
    expect(config.withContext).toBe(true);
    expect(config.filters[1]).toEqual({ memcmp: { offset: 1, bytes: realm.toBase58() } });
    const typeFilter = config.filters[0] as { memcmp: { offset: number; bytes: string } };
    expect(typeFilter.memcmp.offset).toBe(0);
    const type = bs58.decode(typeFilter.memcmp.bytes)[0]; calls++;
    return { context: { slot: 100 + type }, value: entries.filter(e => e.account.data[0] === type) };
  };
  const live = await listGovernances(rpc, program, realm);
  expect(calls).toBe(types.length);
  expect(live.governances).toHaveLength(types.length);
  expect(live.evidenceIds).toEqual(rpc.evidence.map(e => e.id));
  for (const [index, g] of live.governances.entries()) {
    expect(g).toEqual({ address: entries[index].pubkey.toBase58(), realm: realm.toBase58(),
      nativeTreasury: (await getNativeTreasuryAddress(program, entries[index].pubkey)).toBase58(),
      slot: 100 + types[index], evidenceIds: [rpc.evidence[index].id],
    });
  }
  const offline = new RecordingRpc(runOptions({ offline: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "synthetic");
  offline.connection.getProgramAccounts = async () => { throw new Error("offline attempted network"); };
  expect(await listGovernances(offline, program, realm)).toEqual(live);
  expect(offline.evidence.every(e => e.source === "fixture")).toBe(true);
});

test("empty governance discovery retains evidence for every account type", async () => {
  const rpc = syntheticRpc(null);
  (rpc.connection as any).getProgramAccounts = async () => ({ context: { slot: 42 }, value: [] });
  const result = await listGovernances(rpc, program, realm);
  expect(result.governances).toEqual([]);
  expect(result.evidenceIds).toEqual(rpc.evidence.map(e => e.id));
  expect(result.evidenceIds).toHaveLength(getAccountTypes(Governance).length);
});
