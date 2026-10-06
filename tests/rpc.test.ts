import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc, redactedRpcUrl, redactSecrets } from "../src/chain/rpc";
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

describe("RPC redaction", () => {
  test.each([
    ["https://user:password@solana-mainnet.g.alchemy.com/v2/long-private-api-key-123456#private", "https://solana-mainnet.g.alchemy.com"],
    ["https://mainnet.helius-rpc.com/?api-key=SECRET", "https://mainnet.helius-rpc.com"],
    ["http://user:password@localhost:8899/private?api-key=SECRET#private", "http://localhost:8899"],
  ])("keeps only the scheme and host of %s", (url, host) => {
    expect(redactedRpcUrl(url)).toBe(host);
  });

  test("scrubs every full URL, query string and long path segment literally", () => {
    const key = "private.key+with[regex]-123456";
    const url = `https://rpc.example/v2/${key}/another-long-key-12345?api-key=SECRET`;
    expect(redactSecrets(`${url} ${url} ${key} ${key} another-long-key-12345 ?api-key=SECRET api-key=SECRET`, url))
      .toBe(Array(7).fill("[redacted]").join(" "));
    expect(redactSecrets("unchanged", url)).toBe("unchanged");
    expect(redactSecrets("invalid endpoint: bad-url", "bad-url")).toBe("invalid endpoint: [redacted]");
  });
});

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
    expect(live.evidence.rpcUrl).toBe("https://mainnet.helius-rpc.com");
    expect(JSON.stringify(recorder.evidence)).not.toContain("SECRET");
    const fixture = readFileSync(join(fixturesDir, "redacted", `${fixtureKey("getBalance", { pubkey: pk.toBase58() })}.json`), "utf8");
    for (const secret of ["SECRET", "user", "password", "private"]) expect(fixture).not.toContain(secret);
    expect(JSON.parse(fixture).rpcUrl).toBe("https://mainnet.helius-rpc.com");
    const replayer = new RecordingRpc(runOptions({ offline: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "redacted");
    const replay = await replayer.getBalance(pk);
    expect(replay.evidence).toMatchObject({ id: live.evidence.id, rpcUrl: live.evidence.rpcUrl, source: "fixture" });
  });

  test("path keys never reach recorded fixtures or flushed evidence and do not affect ids", async () => {
    const key = "private-alchemy-key-123456789";
    const rpc = recorder({ rpcUrl: `https://solana-mainnet.g.alchemy.com/v2/${key}` });
    rpc.connection.getBalanceAndContext = async () => ({ context: { slot: 42 }, value: 5 });
    const live = await rpc.getBalance(pk);
    expect(live.evidence.rpcUrl).toBe("https://solana-mainnet.g.alchemy.com");
    const evidence = readFileSync(rpc.flushEvidence(tempDir()), "utf8");
    const fixture = readFileSync(join(rpc.opts.fixturesDir, "resume", `${fixtureKey("getBalance", { pubkey: pk.toBase58() })}.json`), "utf8");
    for (const text of [evidence, fixture]) expect(text).not.toContain(key);
    const publicRpc = recorder();
    publicRpc.connection.getBalanceAndContext = rpc.connection.getBalanceAndContext;
    expect((await publicRpc.getBalance(pk)).evidence.id).toBe(live.evidence.id);
    expect((await new RecordingRpc({ ...rpc.opts, offline: true }, "resume").getBalance(pk)).evidence.id).toBe(live.evidence.id);
  });

  test.each(["invalid account", "429 Too Many Requests"])("scrubs thrown errors and logs while preserving error class: %s", async message => {
    const key = "private-alchemy-key-123456789";
    const rpc = recorder({ rpcUrl: `https://rpc.example/v2/${key}?api-key=SECRET` });
    const error = new TypeError(`${message}: ${rpc.opts.rpcUrl} ${key} ?api-key=SECRET`);
    rpc.connection.getBalanceAndContext = async () => { throw error; };
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const caught = await rpc.getBalance(pk).catch(e => e);
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught.name).toBe("TypeError");
      expect(caught.message).toBe(`${message}: [redacted] [redacted] [redacted]`);
      expect(caught).not.toBe(error);
      for (const text of [caught.stack, JSON.stringify(log.mock.calls)]) {
        expect(text).not.toContain(key);
        expect(text).not.toContain("SECRET");
      }
    } finally { log.mockRestore(); }
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

describe("contract RPC reads", () => {
  const pk = new PublicKey(Buffer.alloc(32, 21));
  const recorder = () => new RecordingRpc(runOptions({ record: true, offline: false, refresh: false, minIntervalMs: 0, fixturesDir: tempDir(), rpcUrl: "http://127.0.0.1:1" }), "contracts");

  test("optional dataSlice has a separate fixture key while omitted and undefined preserve old params", async () => {
    const rpc = recorder();
    const filters = [{ memcmp: { offset: 0, bytes: "abc" } }];
    const calls: unknown[] = [];
    (rpc.connection as any).getProgramAccounts = async (_key: PublicKey, config: { dataSlice?: { offset: number; length: number } }) => {
      calls.push(config);
      return { context: { slot: 71 }, value: [{ pubkey: pk, account: { owner: pk, executable: false, lamports: 1, data: config.dataSlice ? Buffer.alloc(0) : Buffer.from([7]), rentEpoch: 0 } }] };
    };
    const old = await rpc.getProgramAccounts(pk, filters);
    const explicitUndefined = await rpc.getProgramAccounts(pk, filters, undefined);
    const sliced = await rpc.getProgramAccounts(pk, filters, { offset: 0, length: 0 });
    expect(old.evidence.params).toEqual({ programId: pk.toBase58(), filters });
    expect(explicitUndefined.evidence.id).toBe(old.evidence.id);
    expect(sliced.evidence.params).toEqual({ programId: pk.toBase58(), filters, dataSlice: { offset: 0, length: 0 } });
    expect(sliced.evidence.id).not.toBe(old.evidence.id);
    expect(calls).toEqual([{ filters, withContext: true }, { filters, withContext: true, dataSlice: { offset: 0, length: 0 } }]);
    const replay = new RecordingRpc({ ...rpc.opts, offline: true }, "contracts");
    expect(await replay.getProgramAccounts(pk, filters, { offset: 0, length: 0 })).toEqual({ ...sliced, evidence: { ...sliced.evidence, source: "fixture" } });
    expect((await replay.getProgramAccounts(pk, filters)).value[0].account.data).toEqual(Buffer.from([7]));
  });

  test("multiple accounts preserve null positions, buffers, pubkeys, order and evidence on replay", async () => {
    const rpc = recorder();
    const keys = [pk, PublicKey.default, pk];
    const info = { data: Buffer.from([128, 255]), owner: pk, executable: false, lamports: 99, rentEpoch: 0 };
    rpc.connection.getMultipleAccountsInfoAndContext = async addresses => {
      expect(addresses).toEqual(keys);
      return { context: { slot: 72 }, value: [info, null, info] };
    };
    const live = await rpc.getMultipleAccounts(keys);
    expect(live).toMatchObject({ value: [info, null, info], evidence: { method: "getMultipleAccounts", slot: 72, params: { pubkeys: keys.map(k => k.toBase58()) } } });
    const fx = JSON.parse(readFileSync(join(rpc.opts.fixturesDir, "contracts", `${fixtureKey("getMultipleAccounts", live.evidence.params)}.json`), "utf8"));
    expect(fx.response).toEqual([{ ...info, owner: pk.toBase58(), data: "gP8=" }, null, { ...info, owner: pk.toBase58(), data: "gP8=" }]);
    const offline = new RecordingRpc({ ...rpc.opts, offline: true }, "contracts");
    expect(await offline.getMultipleAccounts(keys)).toEqual({ ...live, evidence: { ...live.evidence, source: "fixture" } });
  });

  test("multiple accounts accepts 100 and rejects 101 before any RPC", async () => {
    const rpc = recorder(); let calls = 0;
    rpc.connection.getMultipleAccountsInfoAndContext = async addresses => { calls++; return { context: { slot: 73 }, value: addresses.map(() => null) }; };
    expect((await rpc.getMultipleAccounts(Array(100).fill(pk))).value).toHaveLength(100);
    expect(() => rpc.getMultipleAccounts(Array(101).fill(pk))).toThrow("at most 100");
    expect(calls).toBe(1); expect(rpc.evidence).toHaveLength(1);
  });

  test("largest token accounts preserve raw precision and return replayable evidence", async () => {
    const rpc = recorder();
    rpc.connection.getTokenLargestAccounts = async mint => {
      expect(mint).toEqual(pk);
      return { context: { slot: 74 }, value: [{ address: PublicKey.default, amount: "18446744073709551615", decimals: 9, uiAmount: null }] };
    };
    const live = await rpc.getTokenLargestAccounts(pk);
    expect(live).toMatchObject({ value: [{ address: PublicKey.default.toBase58(), amountRaw: "18446744073709551615", decimals: 9 }], evidence: { slot: 74, method: "getTokenLargestAccounts", params: { mint: pk.toBase58() } } });
    const offline = new RecordingRpc({ ...rpc.opts, offline: true }, "contracts");
    expect(await offline.getTokenLargestAccounts(pk)).toEqual({ ...live, evidence: { ...live.evidence, source: "fixture" } });
  });
});

describe("unsupported transaction versions", () => {
  test("a transaction in a newer format is recorded as unavailable (null) and replays identically", async () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), "linchpin-txv-"));
    const live = new RecordingRpc(runOptions({ offline: false, record: true, refresh: false, rpcUrl: "https://rpc.example", fixturesDir, minIntervalMs: 0 }), "txv");
    (live.connection as any).getTransaction = async () => { throw new Error('failed to get transaction: Transaction version (1) is not supported by the requesting client.'); };
    const recorded = await live.getTransaction("5ig1");
    expect(recorded.value).toBeNull();
    const offline = new RecordingRpc(runOptions({ offline: true, record: false, refresh: false, rpcUrl: "http://127.0.0.1:1", fixturesDir }), "txv");
    const replayed = await offline.getTransaction("5ig1");
    expect(replayed.value).toBeNull();
    expect(replayed.evidence.id).toBe(recorded.evidence.id);
  });
  test("other getTransaction errors still fail", async () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), "linchpin-txv-"));
    const live = new RecordingRpc(runOptions({ offline: false, record: true, refresh: false, rpcUrl: "https://rpc.example", fixturesDir, minIntervalMs: 0, retryDelaysMs: [] }), "txv");
    (live.connection as any).getTransaction = async () => { throw new Error("invalid signature"); };
    await expect(live.getTransaction("bad")).rejects.toThrow();
  });
});
