import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { parseMint, parseTokenAccount, formatUnits } from "../src/chain/token-layout";

describe("RecordingRpc", () => {
  test("records a fixture and replays it offline with the same evidence id", async () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), "linchpin-fx-"));
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
    const rpc = new RecordingRpc(runOptions({ offline: true, fixturesDir: mkdtempSync(join(tmpdir(), "linchpin-empty-")), rpcUrl: "http://127.0.0.1:1" }), "t");
    await expect(rpc.getBalance(new PublicKey("11111111111111111111111111111111"))).rejects.toThrow(/fixture missing/);
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
