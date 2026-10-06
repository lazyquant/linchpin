import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  const pk = new PublicKey("11111111111111111111111111111111");
  function recorder(overrides: Parameters<typeof runOptions>[0] = {}) {
    return new RecordingRpc(runOptions({ offline: false, record: true, refresh: false, minIntervalMs: 0,
      retryDelaysMs: Array(8).fill(0), fixturesDir: tempDir(), rpcUrl: "http://127.0.0.1:1", ...overrides }), "resume");
  }

  test("record resumes existing fixtures with the same value and evidence as offline", async () => {
    const rpc = recorder();
    rpc.connection.getAccountInfoAndContext = async () => ({ context: { slot: 42 }, value: {
      data: Buffer.from([1, 2, 3]), owner: pk, executable: false, lamports: 5, rentEpoch: 0,
    } });
    await rpc.getAccountInfo(pk);
    const path = join(rpc.opts.fixturesDir, "resume", `${fixtureKey("getAccountInfo", { pubkey: pk.toBase58() })}.json`);
    const before = readFileSync(path, "utf8");
    const resumed = new RecordingRpc(rpc.opts, "resume");
    resumed.connection.getAccountInfoAndContext = async () => { throw new Error("unexpected live call"); };
    const replay = await resumed.getAccountInfo(pk);
    const offline = new RecordingRpc({ ...rpc.opts, offline: true, refresh: true }, "resume");
    expect(replay).toEqual(await offline.getAccountInfo(pk));
    expect(replay.evidence.source).toBe("fixture");
    expect(Buffer.isBuffer(replay.value!.data)).toBe(true);
    expect(resumed.counts).toEqual({ live: 0, replayed: 1, retries: 0 });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refresh calls live and overwrites an existing fixture", async () => {
    const rpc = recorder();
    rpc.connection.getBalanceAndContext = async () => ({ context: { slot: 42 }, value: 5 });
    const first = await rpc.getBalance(pk);
    const refreshed = new RecordingRpc({ ...rpc.opts, refresh: true }, "resume");
    let calls = 0;
    refreshed.connection.getBalanceAndContext = async () => { calls++; return { context: { slot: 43 }, value: 9 }; };
    const live = await refreshed.getBalance(pk);
    expect(calls).toBe(1);
    expect(live.value).toBe(9);
    expect(live.evidence.source).toBe("rpc");
    expect(live.evidence.id).not.toBe(first.evidence.id);
    const offline = new RecordingRpc({ ...rpc.opts, offline: true }, "resume");
    expect(await offline.getBalance(pk)).toMatchObject({ value: 9, evidence: { id: live.evidence.id, slot: 43 } });
  });

  test.each(["429 Too Many Requests", "Too Many Requests", "503", "502", "ECONNRESET", "ETIMEDOUT", "fetch failed", "TimeoutError", "AbortError", "aborted", "The operation was aborted", "timed out"])("retries transient error %s twice then records success", async message => {
    const rpc = recorder();
    let calls = 0;
    rpc.connection.getBalanceAndContext = async () => {
      if (++calls <= 2) throw new Error(message);
      return { context: { slot: 42 }, value: 5 };
    };
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await rpc.getBalance(pk)).value).toBe(5);
      expect(calls).toBe(3);
      expect(rpc.counts).toEqual({ live: 1, replayed: 0, retries: 2 });
      expect(rpc.evidence).toHaveLength(1);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0][0]).toContain("getBalance retry: attempt 2/8");
      expect(log.mock.calls[1][0]).toContain("getBalance retry: attempt 3/8");
      expect((await new RecordingRpc({ ...rpc.opts, offline: true }, "resume").getBalance(pk)).value).toBe(5);
    } finally { log.mockRestore(); }
  });

  test.each(["TimeoutError", "AbortError"])("retries errors identified by name %s", async name => {
    const rpc = recorder({ retryDelaysMs: [0, 0] });
    let calls = 0;
    rpc.connection.getBalanceAndContext = async () => {
      if (++calls === 1) throw Object.assign(new Error("request interrupted"), { name });
      return { context: { slot: 42 }, value: 5 };
    };
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await rpc.getBalance(pk)).value).toBe(5);
      expect(calls).toBe(2);
      expect(rpc.counts.retries).toBe(1);
    } finally { log.mockRestore(); }
  });

  test.each([1, 2])("abandons %s hanging fetch attempts after the timeout and records success", async hangingAttempts => {
    const rpc = recorder({ requestTimeoutMs: 50, retryDelaysMs: [0, 0] });
    const signals: AbortSignal[] = [];
    const elapsed: number[] = [];
    const fetchStub = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const signal = init!.signal!;
      signals.push(signal);
      const request = JSON.parse(init!.body as string);
      expect(request.method).toBe("getBalance");
      expect(init!.method).toBe("POST");
      if (signals.length <= hangingAttempts) {
        const start = performance.now();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            elapsed.push(performance.now() - start);
            reject(signal.reason);
          }, { once: true });
        });
      }
      expect(signal.aborted).toBe(false);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 42 }, value: 5 } }));
    }, { preconnect: fetch.preconnect }));
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await rpc.getBalance(pk)).toMatchObject({ value: 5, evidence: { slot: 42, source: "rpc" } });
      expect(fetchStub).toHaveBeenCalledTimes(hangingAttempts + 1);
      expect(new Set(signals).size).toBe(hangingAttempts + 1);
      expect(elapsed).toHaveLength(hangingAttempts);
      for (let i = 0; i < hangingAttempts; i++) {
        expect(signals[i].aborted).toBe(true);
        expect(signals[i].reason.name).toBe("TimeoutError");
        expect(elapsed[i]).toBeGreaterThanOrEqual(40);
      }
      expect(rpc.counts).toEqual({ live: 1, replayed: 0, retries: hangingAttempts });
      expect(rpc.evidence).toHaveLength(1);
    } finally { fetchStub.mockRestore(); log.mockRestore(); }
  }, 2000);

  test("stops after eight attempts and propagates the original error", async () => {
    const rpc = recorder();
    const error = new Error("429 Too Many Requests");
    let calls = 0;
    rpc.connection.getBalanceAndContext = async () => { calls++; throw error; };
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(rpc.getBalance(pk)).rejects.toBe(error);
      expect(calls).toBe(8);
      expect(rpc.counts).toEqual({ live: 0, replayed: 0, retries: 7 });
      expect(rpc.evidence).toHaveLength(0);
      expect(log).toHaveBeenCalledTimes(7);
    } finally { log.mockRestore(); }
  });

  test("other errors propagate unchanged without retries and do not block later calls", async () => {
    const rpc = recorder();
    const error = new Error("invalid account");
    let calls = 0;
    rpc.connection.getBalanceAndContext = async () => { calls++; throw error; };
    await expect(rpc.getBalance(pk)).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(rpc.counts.retries).toBe(0);
    rpc.connection.getBalanceAndContext = async () => ({ context: { slot: 42 }, value: 5 });
    expect((await rpc.getBalance(pk)).value).toBe(5);
  });

  test.each([false, true])("throttles live starts by at least 50 ms (concurrent=%s)", async concurrent => {
    const rpc = recorder({ minIntervalMs: 50, refresh: true });
    const starts: number[] = [];
    rpc.connection.getBalanceAndContext = async () => { starts.push(performance.now()); return { context: { slot: 42 }, value: 5 }; };
    if (concurrent) await Promise.all([rpc.getBalance(pk), rpc.getBalance(pk)]);
    else { await rpc.getBalance(pk); await rpc.getBalance(pk); }
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(50);
  });

  test("reports progress every 25 successful live reads and includes replay counts", async () => {
    const rpc = recorder();
    rpc.connection.getBalanceAndContext = async () => ({ context: { slot: 42 }, value: 5 });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      await rpc.getBalance(pk);
      await rpc.getBalance(pk);
      for (let i = 1; i < 50; i++) await rpc.getBalance(new PublicKey(Buffer.alloc(32, i)));
      expect(log.mock.calls).toEqual([
        ["[record] 25 live reads, 1 replayed, last: getBalance"],
        ["[record] 50 live reads, 1 replayed, last: getBalance"],
      ]);
      expect(rpc.counts).toEqual({ live: 50, replayed: 1, retries: 0 });
    } finally { log.mockRestore(); }
  });

  test("redacts RPC secrets from evidence, fixture files and offline replay", async () => {
    const fixturesDir = tempDir();
    const pk = new PublicKey("11111111111111111111111111111111");
    const recorder = new RecordingRpc(runOptions({ offline: false, record: true, fixturesDir, rpcUrl: "https://user:password@mainnet.helius-rpc.com/?api-key=SECRET#private" }), "redacted");
    recorder.connection.getBalanceAndContext = async () => ({ context: { slot: 42 }, value: 5 });
    const live = await recorder.getBalance(pk);
    expect(live.evidence.rpcUrl).toBe("https://mainnet.helius-rpc.com/");
    expect(JSON.stringify(recorder.evidence)).not.toContain("SECRET");
    const fixture = readFileSync(join(fixturesDir, "redacted", `${fixtureKey("getBalance", { pubkey: pk.toBase58() })}.json`), "utf8");
    for (const secret of ["SECRET", "user", "password", "private"]) expect(fixture).not.toContain(secret);
    expect(JSON.parse(fixture).rpcUrl).toBe("https://mainnet.helius-rpc.com/");
    const replayer = new RecordingRpc(runOptions({ offline: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "redacted");
    const replay = await replayer.getBalance(pk);
    expect(replay.evidence).toMatchObject({ id: live.evidence.id, rpcUrl: live.evidence.rpcUrl, source: "fixture" });
  });
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

describe("recording options", () => {
  test("request timeout defaults, environment overrides, and validation", () => {
    const timeout = process.env.LINCHPIN_RPC_TIMEOUT_MS;
    try {
      delete process.env.LINCHPIN_RPC_TIMEOUT_MS;
      expect(runOptions().requestTimeoutMs).toBe(30000);
      process.env.LINCHPIN_RPC_TIMEOUT_MS = "50";
      expect(runOptions().requestTimeoutMs).toBe(50);
      expect(runOptions({ requestTimeoutMs: 100 }).requestTimeoutMs).toBe(100);
      for (const invalid of ["", "0", "-1", "NaN", "Infinity", "1.5", "9007199254740992"]) {
        process.env.LINCHPIN_RPC_TIMEOUT_MS = invalid;
        expect(() => runOptions()).toThrow("LINCHPIN_RPC_TIMEOUT_MS");
        expect(() => runOptions({ requestTimeoutMs: Number(invalid) })).toThrow("LINCHPIN_RPC_TIMEOUT_MS");
      }
    } finally {
      if (timeout === undefined) delete process.env.LINCHPIN_RPC_TIMEOUT_MS; else process.env.LINCHPIN_RPC_TIMEOUT_MS = timeout;
    }
  });

  test("defaults and environment overrides preserve explicit options", () => {
    const refresh = process.env.LINCHPIN_REFRESH;
    const interval = process.env.LINCHPIN_RPC_MIN_INTERVAL_MS;
    try {
      delete process.env.LINCHPIN_REFRESH;
      delete process.env.LINCHPIN_RPC_MIN_INTERVAL_MS;
      expect(runOptions()).toMatchObject({ refresh: false, minIntervalMs: 0 });
      expect(runOptions({ record: true }).minIntervalMs).toBe(250);
      process.env.LINCHPIN_REFRESH = "1";
      process.env.LINCHPIN_RPC_MIN_INTERVAL_MS = "50";
      expect(runOptions()).toMatchObject({ refresh: true, minIntervalMs: 50 });
      expect(runOptions({ refresh: false, minIntervalMs: 0 })).toMatchObject({ refresh: false, minIntervalMs: 0 });
      for (const invalid of ["-1", "NaN", "Infinity"]) {
        process.env.LINCHPIN_RPC_MIN_INTERVAL_MS = invalid;
        expect(() => runOptions()).toThrow("LINCHPIN_RPC_MIN_INTERVAL_MS");
      }
    } finally {
      if (refresh === undefined) delete process.env.LINCHPIN_REFRESH; else process.env.LINCHPIN_REFRESH = refresh;
      if (interval === undefined) delete process.env.LINCHPIN_RPC_MIN_INTERVAL_MS; else process.env.LINCHPIN_RPC_MIN_INTERVAL_MS = interval;
    }
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
