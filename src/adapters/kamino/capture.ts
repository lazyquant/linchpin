import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { canonical, sha256 } from "../../chain/evidence";
import { KAMINO_TARGET, VAULT_TARGETS, type VaultSlug, LAYOUT_SOURCES } from "./constants";
import type { AccountRecord } from "./layout";

export interface Manifest { version: 1; captureId: string; constructed: boolean; target: typeof KAMINO_TARGET; startedAt: string; finishedAt: string; records: string[]; layoutSources: string[] }
export interface RpcResponse { context?: { slot: number; [key: string]: unknown }; value?: (AccountRecord | null)[]; code?: number; message?: string; [key: string]: unknown }
export interface RpcRecord { kind: "rpc"; role: string; method: "getMultipleAccounts"; params: [string[], { encoding: "base64"; commitment: "confirmed"; dataSlice?: { offset: number; length: number } }]; endpoint: string; retrievedAt: string; httpStatus: number; slot: number | null; responseSha256: string; response: RpcResponse }
export interface HttpRecord { kind: "http"; role: string; host: string; path: string; retrievedAt: string; httpStatus: number; headers: Record<string, string>; bodySha256: string; body: string }
export interface KaminoCapture { manifest: Manifest; records: Record<string, RpcRecord | HttpRecord> }
export class CaptureRejected extends Error { constructor(readonly code: string) { super(`Capture rejected: ${code}`); this.name = "CaptureRejected"; } }
function reject(code = "malformed-capture"): never { throw new CaptureRejected(code); }
const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
function exact(x: unknown, keys: string[]): asserts x is Record<string, unknown> { if (!obj(x) || Reflect.ownKeys(x).length !== keys.length || !keys.every(k => Object.hasOwn(x, k)) || Object.values(Object.getOwnPropertyDescriptors(x)).some(d => !d.enumerable || !("value" in d))) reject(); }
const time = (x: unknown) => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x));
const pubkey = (x: unknown) => { try { return typeof x === "string" && new PublicKey(x).toBase58() === x; } catch { return false; } };
export const REQUIRED_RECORDS = ["api-vault.json", "api-metrics.json", "docs-liquidity.json", "rpc-programs.json", "rpc-state.json"] as const;
export const HTTP_HEADERS = ["content-type", "etag", "last-modified", "retry-after", "x-kamino-truncated", "date"] as const;
const FILES = [...REQUIRED_RECORDS, "rpc-discovery-1.json", "rpc-discovery-2.json", "rpc-discovery-3.json"];
export function vaultSlugOf(captureId: string): VaultSlug {
  return (Object.keys(VAULT_TARGETS) as VaultSlug[]).find(slug => captureId.startsWith(`${slug}-`)) ?? "sentora-pyusd";
}
/** Integrity validation is separate from interpretation of a recorded error or malformed account. */
export function verifyCapture(raw: unknown): KaminoCapture {
  exact(raw, ["manifest", "records"]);
  const m = raw.manifest; exact(m, ["version", "captureId", "constructed", "target", "startedAt", "finishedAt", "records", "layoutSources"]);
  exact(m.target, ["vault", "tokenMint", "kvaultProgram"]);
  if (m.version !== 1 || typeof m.captureId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(m.captureId) || typeof m.constructed !== "boolean" || canonical(m.target) !== canonical(VAULT_TARGETS[vaultSlugOf(m.captureId)]) || !time(m.startedAt) || !time(m.finishedAt) || Date.parse(m.startedAt as string) > Date.parse(m.finishedAt as string) || !Array.isArray(m.records) || m.records.some(f => typeof f !== "string" || !FILES.includes(f)) || new Set(m.records).size !== m.records.length || canonical(m.layoutSources) !== canonical(LAYOUT_SOURCES) || !obj(raw.records)) reject();
  for (const file of REQUIRED_RECORDS) if (!m.records.includes(file)) reject("missing-record");
  for (const file of m.records as string[]) if (!Object.hasOwn(raw.records, file)) reject("missing-record");
  if (Object.keys(raw.records).some(f => !(m.records as string[]).includes(f))) reject();
  const seen = new Set<string>();
  for (const file of m.records as string[]) {
    const r = raw.records[file];
    if (!obj(r)) reject();
    const role = file.replace(/\.json$/, "");
    if (r.role !== role || !time(r.retrievedAt) || !Number.isInteger(r.httpStatus) || (r.httpStatus as number) < 100 || (r.httpStatus as number) > 599) reject();
    if (file.startsWith("rpc-")) {
      exact(r, ["kind", "role", "method", "params", "endpoint", "retrievedAt", "httpStatus", "slot", "responseSha256", "response"]);
      if (r.kind !== "rpc" || r.method !== "getMultipleAccounts" || !Array.isArray(r.params) || r.params.length !== 2 || !Array.isArray(r.params[0]) || r.params[0].length > 100 || !r.params[0].every(pubkey) || !obj(r.params[1]) || typeof r.endpoint !== "string" || !obj(r.response) || typeof r.responseSha256 !== "string" || !(r.slot === null || Number.isSafeInteger(r.slot) && (r.slot as number) >= 0)) reject();
      const config = r.params[1]; exact(config, config.dataSlice === undefined ? ["encoding", "commitment"] : ["encoding", "commitment", "dataSlice"]);
      if (config.encoding !== "base64" || config.commitment !== "confirmed") reject();
      if (config.dataSlice !== undefined) { exact(config.dataSlice, ["offset", "length"]); if (![config.dataSlice.offset, config.dataSlice.length].every(v => Number.isSafeInteger(v) && (v as number) >= 0)) reject(); }
      try { const url = new URL(r.endpoint); if (!/^https?:$/.test(url.protocol) || r.endpoint !== `${url.protocol}//${url.host}`) reject(); } catch { reject(); }
      if (r.responseSha256 !== sha256(canonical(r.response))) reject("hash-mismatch");
      const context = r.response.context;
      if (context !== undefined && (!obj(context) || !Number.isSafeInteger(context.slot) || (context.slot as number) < 0)) reject();
      if (r.slot !== (obj(context) ? context.slot : null)) reject("slot-mismatch");
      if (file === "rpc-state.json" || file === "rpc-programs.json") for (const key of r.params[0] as string[]) { if (seen.has(key)) reject("duplicate-account"); seen.add(key); }
    } else {
      exact(r, ["kind", "role", "host", "path", "retrievedAt", "httpStatus", "headers", "bodySha256", "body"]);
      if (r.kind !== "http" || typeof r.host !== "string" || typeof r.path !== "string" || !r.path.startsWith("/") || !obj(r.headers) || Object.entries(r.headers).some(([k,v]) => !HTTP_HEADERS.includes(k as typeof HTTP_HEADERS[number]) || typeof v !== "string") || typeof r.body !== "string" || typeof r.bodySha256 !== "string") reject();
      if (r.bodySha256 !== sha256(r.body)) reject("hash-mismatch");
    }
  }
  return structuredClone(raw) as unknown as KaminoCapture;
}
export function loadCapture(dir: string): KaminoCapture {
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { return reject("malformed-capture"); }
  if (!obj(manifest) || !Array.isArray(manifest.records) || manifest.captureId !== basename(resolve(dir))) reject();
  const records: Record<string, unknown> = {};
  for (const file of manifest.records) {
    if (typeof file !== "string" || !FILES.includes(file)) reject();
    try { records[file] = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch (e) { return reject((e as NodeJS.ErrnoException).code === "ENOENT" ? "missing-record" : "malformed-capture"); }
  }
  return verifyCapture({ manifest, records });
}
