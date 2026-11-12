import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import { redactedRpcUrl } from "../../chain/rpc";
import { runOptions, type RunOptions } from "../../config";
import { HTTP_HEADERS, verifyCapture, type HttpRecord, type RpcRecord, type KaminoCapture } from "./capture";
import { VAULT_TARGETS, isVaultSlug, KVAULT_PROGRAM, KLEND_PROGRAM, LAYOUT_SOURCES, isConfiguredKey } from "./constants";
import { accountBytes, decodeVault, decodeReserve, decodeProgramDataHead, isDecodeFailure, programDataAddress, type AccountRecord, type ReserveState } from "./layout";
import { PublicKey } from "@solana/web3.js";

export interface RecordOptions extends Partial<RunOptions> { out?: string; vault?: string }
/** The only network entry point. No credentials or transaction methods are used. */
export async function recordCapture(options: RecordOptions = {}): Promise<KaminoCapture> {
  const slug = options.vault ?? "sentora-pyusd";
  if (!isVaultSlug(slug)) throw new Error(`Unregistered vault: ${slug}`);
  const out = options.out ?? (slug === "sentora-pyusd" ? "fixtures/kamino" : join("fixtures/kamino-vaults", slug));
  if (slug !== "sentora-pyusd" && resolve(out) === resolve("fixtures/kamino")) throw new Error("Output fixtures/kamino is reserved for sentora-pyusd captures");
  const outSlug = basename(resolve(out));
  if (isVaultSlug(outSlug) && outSlug !== slug) throw new Error(`Output slug ${outSlug} does not match recording slug ${slug}`);
  const vaultTarget = VAULT_TARGETS[slug];
  const opts = runOptions({ ...options, record: true, minIntervalMs: options.minIntervalMs ?? 250 });
  if (opts.offline) throw new Error("Recording requires online mode");
  const endpoint = new URL(opts.rpcUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("Recording requires a credential-free public RPC origin");
  const startedAt = new Date().toISOString(), captureId = `${slug}-${startedAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
  const target = join(out, captureId), staging = join(out, `.${captureId}.partial`);
  if (existsSync(target) || existsSync(staging)) throw new Error("Capture destination already exists");
  let lastStart = -Infinity;
  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  async function request(url: string, init?: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      await pause(Math.max(0, opts.minIntervalMs - (performance.now() - lastStart))); lastStart = performance.now();
      let response: Response;
      try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.requestTimeoutMs) }); } catch { throw new Error("Public capture network request failed"); }
      const body = await response.text();
      if (attempt >= 2 || response.status !== 429 && response.status < 500) return { response, body, retrievedAt: new Date().toISOString() };
      const retry = response.headers.get("retry-after"), seconds = retry === null ? NaN : Number(retry);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 1000 * (attempt + 1);
      await pause(Math.min(30000, Math.max(0, Number.isFinite(ms) ? ms : 1000)));
    }
  }
  const records: KaminoCapture["records"] = {};
  async function http(role: string, url: string) {
    const { response, body, retrievedAt } = await request(url); const u = new URL(url);
    const headers = Object.fromEntries(HTTP_HEADERS.flatMap(k => { const v = response.headers.get(k); return v === null ? [] : [[k, v]]; }));
    const r: HttpRecord = { kind: "http", role, host: u.host, path: u.pathname, retrievedAt, httpStatus: response.status, headers, bodySha256: sha256(body), body };
    records[`${role}.json`] = r;
  }
  async function rpc(role: string, keys: string[], length?: number) {
    if (keys.length > 100) throw new Error("Account capture exceeds the one-call bound");
    const params: RpcRecord["params"] = [keys, { encoding: "base64", commitment: "confirmed", ...(length === undefined ? {} : { dataSlice: { offset: 0, length } }) }];
    const result = await request(opts.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params }) });
    let response: RpcRecord["response"];
    try { const raw = JSON.parse(result.body); response = raw.result ?? raw.error; if (!response || typeof response !== "object") throw new Error(); } catch { response = { code: result.response.status, message: "Non-JSON RPC response" }; }
    const r: RpcRecord = { kind: "rpc", role, method: "getMultipleAccounts", params, endpoint: redactedRpcUrl(opts.rpcUrl), retrievedAt: result.retrievedAt, httpStatus: result.response.status, slot: response.context?.slot ?? null, responseSha256: sha256(canonical(response)), response };
    records[`${role}.json`] = r; return r;
  }
  const unique = (keys: string[]) => [...new Set(keys)];
  await http("api-vault", `https://api.kamino.finance/kvaults/vaults/${vaultTarget.vault}`);
  await http("api-metrics", `https://api.kamino.finance/kvaults/vaults/${vaultTarget.vault}/metrics`);
  await http("docs-liquidity", "https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals.md");
  const d1 = await rpc("rpc-discovery-1", [vaultTarget.vault]);
  const vault = decodeVault(d1.response.value?.[0]); if (isDecodeFailure(vault)) throw new Error("Cannot discover vault accounts");
  const reserves = unique(vault.allocations.map(a => a.reserve)), d2 = await rpc("rpc-discovery-2", reserves);
  const decoded = reserves.map((_, i) => decodeReserve(d2.response.value?.[i]));
  if (decoded.some(isDecodeFailure)) throw new Error("Cannot discover reserve accounts");
  const good = decoded.filter((v): v is ReserveState => !isDecodeFailure(v));
  const markets = unique(good.map(r => r.lendingMarket)), oracles = unique(good.flatMap(r => r.oracleKeys));
  const d3 = await rpc("rpc-discovery-3", [...markets, ...oracles], 120);
  const owners = markets.map((_, i) => { const b = accountBytes(d3.response.value?.[i]); if (b.length < 56) throw new Error("Cannot discover market owner"); return new PublicKey(b.subarray(24, 56)).toBase58(); });
  const oraclePrograms = oracles.map((_, i) => { const a = d3.response.value?.[markets.length + i]; accountBytes(a); return (a as AccountRecord).owner; });
  const programs = unique([KVAULT_PROGRAM, KLEND_PROGRAM, ...oraclePrograms]), programdata = programs.map(programDataAddress);
  const p = await rpc("rpc-programs", [...programs, ...programdata], 45);
  const upgrades = programdata.flatMap((_, i) => { const a = decodeProgramDataHead(p.response.value?.[programs.length + i]); return isDecodeFailure(a) || !a.upgradeAuthority ? [] : [a.upgradeAuthority]; });
  const authorities = unique([vault.vaultAdminAuthority, vault.allocationAdmin, ...owners, ...upgrades].filter(isConfiguredKey));
  const stateKeys = unique([vaultTarget.vault, ...reserves, ...markets, ...oracles, ...authorities, vault.sharesMint]);
  if (stateKeys.some(k => [...programs, ...programdata].includes(k))) throw new Error("State and program account lists overlap");
  await rpc("rpc-state", stateKeys);
  const capture = verifyCapture({ manifest: { version: 1, captureId, constructed: false, target: vaultTarget, startedAt, finishedAt: new Date().toISOString(), records: Object.keys(records), layoutSources: [...LAYOUT_SOURCES] }, records });
  mkdirSync(out, { recursive: true });
  mkdirSync(staging);
  try { for (const [file, record] of Object.entries(records)) await Bun.write(join(staging, file), JSON.stringify(record, null, 2) + "\n"); await Bun.write(join(staging, "manifest.json"), JSON.stringify(capture.manifest, null, 2) + "\n"); if (existsSync(target)) throw new Error("Capture destination already exists"); renameSync(staging, target); } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
  return capture;
}
