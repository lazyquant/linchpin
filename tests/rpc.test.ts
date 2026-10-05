import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { parseMint, parseTokenAccount, formatUnits } from "../src/chain/token-layout";
import { fixtureKey } from "../src/chain/evidence";

const tempDirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(process.cwd(), ".rpc-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("RecordingRpc", () => {
  test("records a fixture and replays it offline with the same evidence id", async () => {
    const fixturesDir = tempDir();
    const pk = new PublicKey("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi");
    const recorder = new RecordingRpc(runOptions({ record: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "t");
    // stub the live connection: a fake token account of 165 bytes
    const data = Buffer.alloc(165); data.writeBigUInt64LE(5n, 64);
    (recorder.connection as any).getAccountInfoAndContext = async () => ({ context: { slot: 42 }, value: { data, owner: pk, executable: false, lamports: 1, rentEpoch: 0 } });
    const live = await recorder.getAccountInfo(pk);
    expect(live.evidence.slot).toBe(42);
    const replayer = new RecordingRpc(runOptions({ offline: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "t");
    const replay = await replayer.getAccountInfo(pk);
    expect(replay.evidence.id).toBe(live.evidence.id);
    expect(replay.evidence.source).toBe("fixture");
    expect(parseTokenAccount(replay.value!.data).amountRaw).toBe(5n);
  });
  test("offline without a fixture fails loudly", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true, fixturesDir: tempDir(), rpcUrl: "http://127.0.0.1:1" }), "t");
    await expect(rpc.getBalance(new PublicKey("11111111111111111111111111111111"))).rejects.toThrow(/fixture missing/);
  });
  test("program accounts record base64 and replay canonical params with evidence", async () => {
    const fixturesDir = tempDir();
    const pk = new PublicKey(Buffer.alloc(32, 7));
    const data = Buffer.from([0, 1, 128, 255]);
    const recorder = new RecordingRpc(runOptions({ offline: false, record: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "t");
    const filters = [{ memcmp: { offset: 1, bytes: pk.toBase58() } }, { dataSize: 4 }];
    (recorder.connection as any).getProgramAccounts = async (program: PublicKey, config: unknown) => {
      expect(program.equals(pk)).toBe(true);
      expect(config).toMatchObject({ filters, withContext: true });
      return { context: { slot: 77 }, value: [{ pubkey: pk, account: { data, owner: pk, executable: false, lamports: 9, rentEpoch: 0 } }] };
    };
    const live = await recorder.getProgramAccounts(pk, filters);
    const params = { programId: pk.toBase58(), filters };
    expect(live.evidence.params).toEqual(params);
    const fixture = JSON.parse(readFileSync(join(fixturesDir, "t", `${fixtureKey("getProgramAccounts", params)}.json`), "utf8"));
    expect(fixture.response[0]).toMatchObject({ pubkey: pk.toBase58(), account: { owner: pk.toBase58(), data: data.toString("base64") } });
    const replayer = new RecordingRpc(runOptions({ offline: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "t");
    replayer.connection.getProgramAccounts = async () => { throw new Error("offline attempted network"); };
    const replay = await replayer.getProgramAccounts(pk, [{ memcmp: { bytes: pk.toBase58(), offset: 1 } }, { dataSize: 4 }]);
    expect(replay.value).toEqual(live.value);
    expect(replay.evidence).toMatchObject({ id: live.evidence.id, slot: 77, source: "fixture" });
    expect(Buffer.isBuffer(replay.value[0].account.data)).toBe(true);
    expect(replay.value[0].pubkey.equals(pk)).toBe(true);
  });
});

describe("token layout", () => {
  test("parses mint supply and decimals; formats units", () => {
    const m = Buffer.alloc(82); m.writeUInt32LE(0, 0); m.writeBigUInt64LE(699997047681352988n, 36); m[44] = 9;
    const mint = parseMint(m);
    expect(mint.decimals).toBe(9);
    expect(formatUnits(mint.supplyRaw, 9)).toBe("699,997,047.681352988");
    expect(formatUnits(-300000000000000000n, 9)).toBe("-300,000,000");
  });
});
