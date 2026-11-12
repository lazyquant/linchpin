import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import { redactedRpcUrl } from "../../chain/rpc";
import { runOptions, type RunOptions } from "../../config";
import { HTTP_HEADERS, verifyKaminoLendCapture, type HttpRecord, type RpcRecord, type KaminoLendCapture } from "./capture";
import { KAMINO_LEND_TARGET, KLEND_PROGRAM, SQUADS_PROGRAM, SCOPE_PROGRAM, SWITCHBOARD_PROGRAM, SQUADS_V3_PROGRAM, CONTROL_CANDIDATES, KAMINO_LEND_LAYOUT_SOURCES, isConfiguredKey } from "./constants";
import { accountBytes, decodeMarket, decodeReserve, decodeProgramDataHead, isDecodeFailure, programDataAddress } from "../kamino/layout";
import { PublicKey } from "@solana/web3.js";

export interface RecordOptions extends Partial<RunOptions> { out?: string }
/** The only network entry point. No credentials or transaction methods are used. */
export async function recordKaminoLendCapture(options: RecordOptions = {}): Promise<KaminoLendCapture> {
  const opts = runOptions({ ...options, record: true, minIntervalMs: options.minIntervalMs ?? 250 });
  if (opts.offline) throw new Error("Recording requires online mode");
  const endpoint = new URL(opts.rpcUrl);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("Recording requires a credential-free public RPC origin");
  const startedAt = new Date().toISOString(), captureId = `main-market-${startedAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
  const out = options.out ?? "fixtures/kamino-lend", target = join(out, captureId), staging = join(out, `.${captureId}.partial`);
  if (existsSync(target) || existsSync(staging)) throw new Error("Capture destination already exists");
  let lastStart = -Infinity;
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  async function request(url: string, init?: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      await pause(Math.max(0, opts.minIntervalMs - (performance.now() - lastStart))); lastStart = performance.now();
      let response: Response;
      try { response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(opts.requestTimeoutMs) }); } catch { throw new Error("Public capture network request failed"); }
      const body = await response.text();
      if (attempt >= 2 || response.status !== 429 && response.status < 500) return { response, body, retrievedAt: new Date().toISOString() };
      const retry = response.headers.get("retry-after"), seconds = retry === null ? NaN : Number(retry);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 1000 * (attempt + 1);
      await pause(Math.min(30000, Math.max(0, Number.isFinite(ms) ? ms : 1000)));
    }
  }
  const records: KaminoLendCapture["records"] = {};
  async function http(role: string, url: string) {
    const { response, body, retrievedAt } = await request(url); const u = new URL(url);
    const headers = Object.fromEntries(HTTP_HEADERS.flatMap(k => { const v = response.headers.get(k); return v === null ? [] : [[k, v]]; }));
    const r: HttpRecord = { kind: "http", role, host: u.host, path: u.pathname, retrievedAt, httpStatus: response.status, headers, bodySha256: sha256(body), body };
    records[`${role}.json`] = r;
  }
  const seen = new Set<string>();
  async function rpc(role: string, keys: string[], length?: number) {
    if (keys.length > 100) throw new Error("Account capture exceeds the one-call bound");
    for (const key of keys) { if (seen.has(key)) throw new Error("Account lists overlap"); seen.add(key); }
    const params: RpcRecord["params"] = [keys, { encoding: "base64", commitment: "confirmed", ...(length === undefined ? {} : { dataSlice: { offset: 0, length } }) }];
    const result = await request(opts.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params }) });
    let response: RpcRecord["response"];
    try { const raw = JSON.parse(result.body); response = raw.result ?? raw.error; if (!response || typeof response !== "object") throw new Error(); } catch { response = { code: result.response.status, message: "Non-JSON RPC response" }; }
    const r: RpcRecord = { kind: "rpc", role, method: "getMultipleAccounts", params, endpoint: redactedRpcUrl(opts.rpcUrl), retrievedAt: result.retrievedAt, httpStatus: result.response.status, slot: response.context?.slot ?? null, responseSha256: sha256(canonical(response)), response };
    records[`${role}.json`] = r; return r;
  }
  const unique = (keys: string[]) => [...new Set(keys)];
  await http("api-reserves", `https://api.kamino.finance/kamino-market/${KAMINO_LEND_TARGET.market}/reserves/metrics`);
  const api = records["api-reserves.json"] as HttpRecord;
  if (api.httpStatus < 200 || api.httpStatus >= 300) throw new Error("Reserve discovery HTTP request failed");
  const entries: unknown = JSON.parse(api.body);
  if (!Array.isArray(entries) || entries.length !== 58) throw new Error("Expected 58 reserve entries");
  const reserves = entries.map(entry => {
    const key = entry?.reserve;
    if (typeof key !== "string" || new PublicKey(key).toBase58() !== key) throw new Error("Invalid API reserve address");
    return key;
  });
  if (unique(reserves).length !== reserves.length) throw new Error("Duplicate API reserve address");
  const state = await rpc("rpc-state", [KAMINO_LEND_TARGET.market, KAMINO_LEND_TARGET.globalConfig, ...reserves]);
  const market = decodeMarket(state.response.value?.[0]);
  if (isDecodeFailure(market)) throw new Error("Cannot decode market");
  const marketBytes = accountBytes(state.response.value?.[0]);
  const globalAccount = state.response.value?.[1], globalBytes = accountBytes(globalAccount);
  if (globalAccount?.owner !== KLEND_PROGRAM || globalBytes.length !== 1032 || !globalBytes.subarray(0, 8).equals(Buffer.from(sha256("account:GlobalConfig"), "hex").subarray(0, 8))) throw new Error("Invalid global config");
  const keyAt = (bytes: Buffer, offset: number) => new PublicKey(bytes.subarray(offset, offset + 32)).toBase58();
  const decoded = reserves.map((_, i) => {
    const reserve = decodeReserve(state.response.value?.[i + 2]);
    if (isDecodeFailure(reserve)) throw new Error("Cannot decode reserve");
    if (reserve.lendingMarket !== KAMINO_LEND_TARGET.market) throw new Error("Reserve membership mismatch");
    return reserve;
  });
  await rpc("rpc-assets", unique([...decoded.map(r => r.mintPubkey), ...decoded.flatMap(r => r.oracleKeys)]), 82);
  const programs = [KLEND_PROGRAM, SCOPE_PROGRAM, SWITCHBOARD_PROGRAM, SQUADS_PROGRAM, SQUADS_V3_PROGRAM];
  const programdata = [KLEND_PROGRAM, SCOPE_PROGRAM].map(programDataAddress);
  const p = await rpc("rpc-programs", [...programs, ...programdata], 45);
  const upgrades = programdata.flatMap((_, i) => {
    const head = decodeProgramDataHead(p.response.value?.[programs.length + i]);
    if (isDecodeFailure(head)) throw new Error("Cannot decode program data head");
    return head.upgradeAuthority ? [head.upgradeAuthority] : [];
  });
  const marketAuthority = PublicKey.findProgramAddressSync([Buffer.from("lma"), new PublicKey(KAMINO_LEND_TARGET.market).toBuffer()], new PublicKey(KLEND_PROGRAM))[0].toBase58();
  await rpc("rpc-control", unique([market.lendingMarketOwner, keyAt(marketBytes, 160), keyAt(marketBytes, 3312), keyAt(globalBytes, 8), keyAt(globalBytes, 72), ...upgrades, ...CONTROL_CANDIDATES, marketAuthority].filter(isConfiguredKey)));
  const capture = verifyKaminoLendCapture({ manifest: { version: 1, captureId, constructed: false, target: KAMINO_LEND_TARGET, startedAt, finishedAt: new Date().toISOString(), records: Object.keys(records), layoutSources: [...KAMINO_LEND_LAYOUT_SOURCES] }, records });
  mkdirSync(out, { recursive: true });
  mkdirSync(staging);
  try { for (const [file, record] of Object.entries(records)) await Bun.write(join(staging, file), JSON.stringify(record, null, 2) + "\n"); await Bun.write(join(staging, "manifest.json"), JSON.stringify(capture.manifest, null, 2) + "\n"); if (existsSync(target)) throw new Error("Capture destination already exists"); renameSync(staging, target); } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
  return capture;
}
