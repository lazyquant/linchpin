import { expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAccountTypes, Governance } from "@solana/spl-governance";
import { doctor } from "../src/cli";
import { fixtureKey } from "../src/chain/evidence";
import { associatedTokenAccount } from "../src/pack/classify";

const registry = JSON.parse(readFileSync("packs/marinade/registry.json", "utf8"));
const source = registry.accounts.find((a: any) => a.id === "dao-treasury-mnde-token-account").address;
const receipt = JSON.parse(readFileSync("fixtures/mip-14/getTransaction-4fe335555c17.json", "utf8"));
const preview = readdirSync("fixtures/mip-14").filter(p => p.startsWith("simulateTransaction"))
  .map(p => JSON.parse(readFileSync(`fixtures/mip-14/${p}`, "utf8"))).find(f => f.response.err == null);
const methods = ["getSlot", "getAccountInfo", "getProgramAccounts", "getTransaction", "simulateTransaction", "getSignaturesForAddress"];

test.each(["succeeded", "failed", "rpc-errors", "timeout"])("doctor probes the configured endpoint without recording: %s", async mode => {
  const previousUrl = process.env.LINCHPIN_RPC_URL;
  const key = "private-alchemy-key-123456789";
  const rpcUrl = `https://rpc.example/v2/${key}?api-key=SECRET`;
  process.env.LINCHPIN_RPC_URL = rpcUrl;
  const calls: { method: string; params: any[] }[] = [];
  const signals: AbortSignal[] = [];
  let expectedGovernances = 0;
  const fetchStub = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    expect(String(input)).toBe(rpcUrl);
    const request = JSON.parse(init!.body as string);
    const { method, params } = request;
    const respond = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    // Exercise the SDK's caught-error logging/fallback without any network calls.
    if ((method === "getAccountInfo" && params[0] !== source) || method === "getRecentBlockhash")
      throw new Error(`SDK lookup failed: ${rpcUrl} ${key}`);
    calls.push({ method, params });
    signals.push(init!.signal!);
    if (mode === "rpc-errors" && (method === "getSlot" || method === "getProgramAccounts"))
      return new Response(`${rpcUrl} ${key} ?api-key=SECRET ${"x".repeat(300)}`, { status: 429 });
    if (mode === "timeout" && method === "getSlot") return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    if (method === "getSlot") return respond(123);
    if (method === "getAccountInfo") return respond({ context: { slot: 124 }, value: null });
    if (method === "getProgramAccounts") {
      expect(params[0]).toBe(registry.governance.program);
      expect(params[1].filters[1]).toMatchObject({ memcmp: { offset: 1, bytes: registry.governance.realm } });
      const filters = params[1].filters.map(({ memcmp }: any) => ({ memcmp: { offset: memcmp.offset, bytes: memcmp.bytes } }));
      const fixture = JSON.parse(readFileSync(`fixtures/marinade-pack/${fixtureKey(method, { programId: params[0], filters })}.json`, "utf8"));
      expectedGovernances += fixture.response.length;
      return respond(fixture.response.map((entry: any) => ({ ...entry, account: { ...entry.account, data: [entry.account.data, "base64"] } })));
    }
    if (method === "getTransaction") {
      expect(params[0]).toBe(receipt.params.signature);
      expect(params[1]).toMatchObject({ maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      return respond(null);
    }
    if (method === "simulateTransaction") {
      expect(params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: preview.params.config.accounts });
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0], "base64"));
      expect(Buffer.from(tx.message.serialize()).toString("base64")).toBe(preview.params.message);
      return respond({ context: { slot: 125 }, value: { err: mode === "failed" ? { InstructionError: [0, "InsufficientFunds"] } : null, logs: [] } });
    }
    if (method === "getSignaturesForAddress") {
      const wallet = registry.accounts.find((a: any) => a.id === "buyback-accumulation").address;
      const mint = registry.mints.find((m: any) => m.id === "mnde").address;
      expect(params[0]).toBe(associatedTokenAccount(new PublicKey(wallet), new PublicKey(mint)).toBase58());
      expect(params[1].limit).toBe(5);
      return respond([{ signature: receipt.params.signature, slot: 126, err: null, memo: null, blockTime: null }]);
    }
    throw new Error(`unexpected RPC method: ${method}`);
  }, { preconnect: fetch.preconnect }));
  const log = spyOn(console, "log").mockImplementation(() => {});
  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    await doctor();
    const lines = log.mock.calls.map(([line]) => JSON.parse(line));
    const versions = lines.filter(l => l.caseId);
    expect(versions).toHaveLength(readdirSync("cases").filter(p => p.endsWith(".json")).length);
    for (const line of versions) expect(line).toMatchObject({ sdkMetadataVersion: 1, programVersionPinned: expect.any(Number) });
    const probes = lines.filter(l => l.probe);
    expect(probes.map(l => l.probe)).toEqual(methods);
    for (const line of probes) {
      expect(line.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(line.ms)).toBe(true);
      if (line.error) expect(line.error.length).toBeLessThanOrEqual(200);
    }
    const failures = mode === "rpc-errors" ? 2 : mode === "timeout" ? 1 : 0;
    if (!failures) expect(probes.filter(p => !p.ok)).toEqual([]);
    expect(lines.at(-1)).toEqual({ host: "https://rpc.example", ok: 6 - failures, failed: failures });
    expect(probes.find(p => p.probe === "simulateTransaction")).toMatchObject({ ok: true, slot: 125, result: mode === "failed" ? "failed" : "succeeded" });
    expect(probes.find(p => p.probe === "getSignaturesForAddress")).toMatchObject({ ok: true, count: 1 });
    expect(calls.filter(c => c.method === "getSlot")).toHaveLength(1);
    expect(calls.filter(c => c.method === "getProgramAccounts")).toHaveLength(mode === "rpc-errors" ? 1 : getAccountTypes(Governance).length);
    if (mode !== "rpc-errors") expect(probes.find(p => p.probe === "getProgramAccounts")).toMatchObject({ ok: true, count: expectedGovernances });
    if (mode === "timeout") {
      expect(signals[0].aborted).toBe(true);
      expect(probes[0]).toMatchObject({ ok: false, error: expect.stringContaining("15000 ms") });
      expect(probes[0].ms).toBeGreaterThanOrEqual(14900);
      expect(probes[0].ms).toBeLessThan(17000);
    }
    const output = JSON.stringify([log.mock.calls, errorLog.mock.calls]);
    for (const secret of [rpcUrl, key, "SECRET"]) expect(output).not.toContain(secret);
    expect(errorLog).not.toHaveBeenCalled();
  } finally {
    fetchStub.mockRestore(); log.mockRestore(); errorLog.mockRestore();
    if (previousUrl === undefined) delete process.env.LINCHPIN_RPC_URL; else process.env.LINCHPIN_RPC_URL = previousUrl;
  }
}, 20000);
