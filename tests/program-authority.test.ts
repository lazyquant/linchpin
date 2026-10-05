import { describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { readProgramAuthority, UPGRADEABLE_LOADER } from "../src/chain/program-authority";

const program = new PublicKey(Buffer.alloc(32, 1));
const programData = new PublicKey(Buffer.alloc(32, 2));
const authority = new PublicKey(Buffer.alloc(32, 3));
const account = (data: Buffer, owner = UPGRADEABLE_LOADER): AccountInfo<Buffer> =>
  ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 });

function syntheticRpc(accounts: Map<string, AccountInfo<Buffer>>) {
  const rpc = new RecordingRpc(runOptions({ offline: false, rpcUrl: "http://127.0.0.1:1" }), "synthetic-program");
  rpc.connection.getAccountInfoAndContext = async (key) => ({ context: { slot: 42 }, value: accounts.get(key.toBase58()) ?? null });
  return rpc;
}

function loaderAccounts(hasAuthority: boolean) {
  const p = Buffer.alloc(36); p.writeUInt32LE(2); programData.toBuffer().copy(p, 4);
  const d = Buffer.alloc(hasAuthority ? 45 : 13); d.writeUInt32LE(3); d.writeBigUInt64LE(123456n, 4);
  if (hasAuthority) { d[12] = 1; authority.toBuffer().copy(d, 13); }
  return new Map([[program.toBase58(), account(p)], [programData.toBase58(), account(d)]]);
}

describe("program upgrade authority", () => {
  test("reads Program and ProgramData with both evidence ids", async () => {
    const rpc = syntheticRpc(loaderAccounts(true));
    expect(await readProgramAuthority(rpc, program)).toEqual({
      kind: "upgradeable", program: program.toBase58(), programData: programData.toBase58(),
      lastDeploySlot: 123456, upgradeAuthority: authority.toBase58(), upgradeable: true, slot: 42,
      evidenceIds: rpc.evidence.map(e => e.id),
    });
    expect(rpc.evidence).toHaveLength(2);
  });
  test("option zero means immutable", async () => {
    expect(await readProgramAuthority(syntheticRpc(loaderAccounts(false)), program)).toMatchObject({
      programData: programData.toBase58(), lastDeploySlot: 123456, upgradeAuthority: null, upgradeable: false,
    });
  });
  test("a different loader is not upgradeable", async () => {
    const rpc = syntheticRpc(new Map([[program.toBase58(), account(Buffer.alloc(36), SystemProgram.programId)]]));
    expect(await readProgramAuthority(rpc, program)).toEqual({
      kind: "not-upgradeable-loader", program: program.toBase58(), owner: SystemProgram.programId.toBase58(), evidenceIds: [rpc.evidence[0].id],
    });
  });
  test("missing program preserves evidence", async () => {
    const rpc = syntheticRpc(new Map());
    expect(await readProgramAuthority(rpc, program)).toEqual({ kind: "not-found", program: program.toBase58(), owner: null, evidenceIds: [rpc.evidence[0].id] });
  });
  test("missing ProgramData preserves both reads", async () => {
    const accounts = loaderAccounts(true); accounts.delete(programData.toBase58());
    const rpc = syntheticRpc(accounts);
    expect(await readProgramAuthority(rpc, program)).toEqual({ kind: "not-found", program: program.toBase58(), owner: null, evidenceIds: rpc.evidence.map(e => e.id) });
    expect(rpc.evidence).toHaveLength(2);
  });
  test.each([Buffer.alloc(35), Buffer.alloc(36)])("rejects short or non-Program loader data", async data => {
    expect(await readProgramAuthority(syntheticRpc(new Map([[program.toBase58(), account(data)]])), program)).toMatchObject({ kind: "not-upgradeable-loader" });
  });
});
