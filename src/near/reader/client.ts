import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, QueryReason } from "../../engine/contracts";
import { nearSubject, parseNearJson, requestSha256, type BlockRef, type FinalityOrBlock, type NearClient, type NearClientOptions, type NearRead, type NearRecord, type NearRequest } from "./types";
export { requestSha256 } from "./types";
export const DEFAULT_NEAR_RPC = "https://archival-rpc.mainnet.fastnear.com";
export function endpointOrigin(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("NEAR RPC URL must be a credential-free origin"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("NEAR RPC URL must be a credential-free origin");
  return u;
}
export function receiptFor(record: NearRecord, snapshotId: string, constructed = false): EvidenceReceipt {
  return { id: `nr:${snapshotId}:${record.requestSha256.slice(0, 40)}`, source: `near-rpc:${record.endpointHost}`, responseSha256: record.responseSha256, privacy: "public",
    observation: { chain: "near", network: "mainnet", blockOrSlot: record.blockHeight, blockHash: record.blockHash, observedAt: record.retrievedAt, retrievedAt: record.retrievedAt,
      historicalState: constructed ? "constructed" : "block_id" in record.request.params && record.outcome === "result" ? "pinned" : "current-only" } };
}
export function restoredResponse(r: NearRecord): unknown {
  const body = structuredClone(r.response) as any;
  if (r.resultText !== undefined) body.result.result = [...Buffer.from(r.resultText, "utf8")];
  return body;
}
export function verifyRecord(r: NearRecord): void {
  if (r.version !== 1 || requestSha256(r.request) !== r.requestSha256) throw new Error("NEAR request hash mismatch");
  if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(r.endpointHost)) throw new Error("Invalid NEAR endpoint host");
  if (r.request.method === "query" && r.request.params.request_type === "view_code" && r.outcome === "result") {
    if (!/^[0-9a-f]{64}$/.test(r.codeSha256 ?? "")) throw new Error("Invalid code hash");
  } else if (sha256(canonical(restoredResponse(r))) !== r.responseSha256) throw new Error("NEAR response hash mismatch");
}
export function recordValue(r: NearRecord): unknown {
  const result = (r.response as any)?.result;
  if (r.request.method === "block") return { height: String(result.header.height), hash: result.header.hash, timestampNs: String(result.header.timestamp_nanosec ?? result.header.timestamp), protocolVersion: result.header.latest_protocol_version };
  if (r.request.method === "query") {
    if (r.request.params.request_type === "call_function") return parseNearJson(r.resultText!);
    if (r.request.params.request_type === "view_code") return { codeSha256: r.codeSha256, rpcCodeHash: result.hash };
  }
  return result;
}
function errorName(body: any): string | null { return body?.error?.cause?.name ?? body?.error?.name ?? (typeof body?.result?.error === "string" && body.result.error.includes("MethodNotFound") ? "MethodNotFound" : null); }
function ref(at?: BlockRef): FinalityOrBlock {
  if (!at || "finality" in at) return { finality: "final" };
  if (!/^(0|[1-9][0-9]*)$/.test(at.blockId) || !Number.isSafeInteger(Number(at.blockId))) throw new Error("Invalid NEAR block height");
  return { block_id: Number(at.blockId) };
}
/** persist=false is used by dry runs: requests and receipts stay in memory. */
export function createNearClient(options: NearClientOptions, persist = true): NearClient & { status(): Promise<NearRead<unknown>> } {
  const online = options.mode === "record";
  const endpoint = online ? endpointOrigin(options.endpointUrl ?? process.env.LINCHPIN_NEAR_RPC_URL ?? DEFAULT_NEAR_RPC) : null;
  const archiveValue = online ? options.archivalUrl === undefined ? process.env.LINCHPIN_NEAR_ARCHIVAL_RPC_URL ?? null : options.archivalUrl : null;
  const archive = archiveValue ? endpointOrigin(archiveValue) : null;
  const host = endpoint?.host ?? options.endpointHost;
  const records = new Map<string, NearRecord>();
  const pending = new Map<string, Promise<NearRead<any>>>();
  let lastCall = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const now = options.now ?? (() => new Date());
  const save = (r: NearRecord) => {
    records.set(r.requestSha256, r);
    if (online && persist) { mkdirSync(options.snapshotDir, { recursive: true }); writeFileSync(join(options.snapshotDir, `${r.requestSha256}.json`), JSON.stringify(r, null, 1) + "\n"); }
  };
  const missing = (request: NearRequest): NearRead<never> => ({ ok: false, error: { kind: "missing-fixture", name: null, bodySha256: null }, receipt: null, record: null, reasons: [{ code: "missing-evidence", subject: request.method === "query" ? nearSubject(request.params.account_id) : null, ref: requestSha256(request) }] });
  async function post(request: NearRequest, url: URL): Promise<{ body: any; status: number }> {
    const operation = async () => {
      for (let attempt = 0; ; attempt++) {
        const delay = Math.max(0, (options.minIntervalMs ?? 150) - (Date.now() - lastCall));
        if (delay) await Bun.sleep(delay);
        lastCall = Date.now();
        let retryable = true;
        try {
          const response = await (options.fetch ?? globalThis.fetch)(url.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "near-reader", ...request }), signal: AbortSignal.timeout(options.timeoutMs ?? 20000), redirect: "error" });
          if (response.status === 429 || response.status >= 500) {
            if (attempt < (options.retries ?? 2)) { const retryAfter = Number(response.headers.get("retry-after")); await response.body?.cancel(); await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20000) : 1000 * 2 ** attempt); continue; }
            throw new Error("RPC unavailable");
          }
          retryable = false;
          const body = await response.json();
          if (!response.ok || !body || typeof body !== "object" || !("result" in body || "error" in body)) throw new Error("Invalid RPC response");
          return { body, status: response.status };
        } catch {
          if (!retryable || attempt >= (options.retries ?? 2)) throw new Error("NEAR RPC transport failed");
          await Bun.sleep(150 * 2 ** attempt);
        }
      }
    };
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function execute(request: NearRequest): Promise<NearRead<any>> {
    const hash = requestSha256(request);
    let r = records.get(hash);
    const pinned = "block_id" in request.params ? String(request.params.block_id) : null;
    if (!r && !online) {
      try { r = JSON.parse(readFileSync(join(options.snapshotDir, `${hash}.json`), "utf8")); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return missing(request); throw e; }
      if (r!.requestSha256 !== hash) throw new Error("NEAR fixture request mismatch");
      verifyRecord(r!); records.set(hash, r!);
    }
    if (!r) {
      const retrievedAt = now().toISOString();
      if (pinned && !archive) {
        const response = { notAttempted: request };
        r = { version: 1, requestSha256: hash, request, endpointHost: host, retrievedAt, httpStatus: 0, outcome: "not-attempted", blockHeight: null, blockHash: null, responseSha256: sha256(canonical(response)), response, archival: { requestedBlockId: pinned, attempted: false, reason: "archival-unconfigured" } };
      } else {
        let reply;
        try { reply = await post(request, pinned ? archive! : endpoint!); }
        catch { return { ok: false, error: { kind: "transport", name: null, bodySha256: null }, receipt: null, record: null, reasons: [{ code: "missing-evidence", subject: request.method === "query" ? nearSubject(request.params.account_id) : null, ref: hash }] }; }
        const { body, status } = reply;
        const result = body.result;
        r = { version: 1, requestSha256: hash, request, endpointHost: (pinned ? archive! : endpoint!).host, retrievedAt: now().toISOString(), httpStatus: status,
          outcome: body.error ? "rpc-error" : result?.error ? "call-error" : "result",
          blockHeight: result?.block_height != null ? String(result.block_height) : request.method === "block" && result?.header?.height != null ? String(result.header.height) : null,
          blockHash: result?.block_hash ?? (request.method === "block" ? result?.header?.hash ?? null : null), responseSha256: sha256(canonical(body)), response: structuredClone(body) };
        const stored = r.response as any;
        if (request.method === "query" && request.params.request_type === "call_function" && Array.isArray(result?.result)) {
          r.resultText = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(result.result)); delete stored.result.result;
        }
        if (request.method === "query" && request.params.request_type === "view_code" && typeof result?.code_base64 === "string") {
          r.codeSha256 = sha256(Buffer.from(result.code_base64, "base64")); delete stored.result.code_base64;
        }
        if (pinned) r.archival = { requestedBlockId: pinned, attempted: true, host: archive!.host, errorName: errorName(body), errorBodySha256: r.outcome === "rpc-error" ? r.responseSha256 : null };
      }
      save(r);
    }
    if (pinned && (r.outcome === "not-attempted" || r.outcome === "rpc-error")) {
      const current = { ...request, params: { ...request.params, finality: "final" } } as any;
      delete current.params.block_id;
      const fallbackHash = requestSha256(current);
      if (!online && r.fallbackRequestSha256 !== fallbackHash) throw new Error("Invalid NEAR fallback reference");
      const fallback = await read(current);
      if (online) { r.fallbackRequestSha256 = fallbackHash; save(r); }
      // A failed pinned receipt stays current-only; only the separate history receipt is unknown.
      const historyReceipt = r.outcome === "not-attempted" ? null : receiptFor(r, options.snapshotId);
      if (historyReceipt) historyReceipt.observation.historicalState = "unknown";
      const reason: QueryReason = { code: "missing-history", subject: request.method === "query" ? nearSubject(request.params.account_id) : null, ref: historyReceipt?.id ?? hash };
      return fallback.ok ? { ...fallback, reasons: [...fallback.reasons, reason], historyReceipt } : { ...fallback, reasons: [...fallback.reasons, reason] };
    }
    const receipt = receiptFor(r, options.snapshotId);
    if (r.outcome !== "result") return { ok: false, record: r, receipt, error: { kind: errorName(r.response) === "UNKNOWN_BLOCK" ? "unknown-block" : r.outcome === "call-error" ? "call-error" : "rpc-error", name: errorName(r.response), bodySha256: r.responseSha256 }, reasons: [{ code: "missing-evidence", subject: request.method === "query" ? nearSubject(request.params.account_id) : null, ref: receipt.id }] };
    return { ok: true, value: recordValue(r), record: r, receipt, reasons: [], historyReceipt: null };
  }
  function read(request: NearRequest): Promise<NearRead<any>> {
    const hash = requestSha256(request);
    if (pending.has(hash)) return pending.get(hash)!;
    const result = execute(request); pending.set(hash, result); return result;
  }
  const query = (account: string, params: object, at?: BlockRef) => { nearSubject(account); return read({ method: "query", params: { account_id: account, ...params, ...ref(at) } } as NearRequest); };
  return {
    viewAccount: (a, at) => query(a, { request_type: "view_account" }, at),
    viewAccessKeys: (a, at) => query(a, { request_type: "view_access_key_list" }, at),
    viewCodeHash: (a, at) => query(a, { request_type: "view_code" }, at),
    callFunction: (a, method, args, at) => query(a, { request_type: "call_function", method_name: method, args_base64: Buffer.from(canonical(args)).toString("base64") }, at),
    block: at => read({ method: "block", params: ref(at) }), status: () => read({ method: "status", params: [] }),
    get records() { return structuredClone([...records.values()]); },
  };
}
