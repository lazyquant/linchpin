import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, QueryReason } from "../../engine/contracts";
import { endpointOrigin, isNearAccountId, parseNearJson } from "../reader";
import type { OmftRouteEvidence, RouteObservation, RouteRuleSet } from "./types";

// Near-One/omni-bridge, rev 9f0bf05, near/omni-token/src/{lib,migrate}.rs.
// OmniToken begins with controller: AccountId. The relayer is a separate storage key.
export function decodeBorshAccount(bytes: Uint8Array, prefixOnly = false): string {
  if (bytes.length < 4) throw new Error("Truncated Borsh account");
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (n < 2 || n > 64 || bytes.length < n + 4 || !prefixOnly && bytes.length !== n + 4) throw new Error("Invalid Borsh account length");
  const account = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, n + 4));
  if (!isNearAccountId(account)) throw new Error("Invalid Borsh account");
  return account;
}
export function isOmniTokenMetadata(value: unknown): boolean {
  const v = value as { link?: unknown; build_info?: { contract_path?: unknown } } | null;
  if (typeof v?.link !== "string") return false;
  try {
    const u = new URL(v.link);
    return u.hostname === "github.com" && /^\/Near-One\/omni-bridge(?:\/|$)/i.test(u.pathname)
      && (u.pathname.includes("near/omni-token") || v.build_info?.contract_path === "near/omni-token");
  } catch { return false; }
}
export interface RouteRead {
  version: 1;
  request: { method: "query"; params: { finality: "final"; account_id: string; request_type: "view_account" | "call_function" | "view_state"; method_name?: string; args_base64?: string; prefix_base64?: string; include_proof?: boolean } };
  requestSha256: string; endpointHost: string; retrievedAt: string; httpStatus: number;
  outcome: "result" | "rpc-error" | "call-error" | "transport-error";
  response: unknown; responseSha256: string; blockHeight: string | null; blockHash: string | null;
}
export function verifyRouteRead(r: RouteRead): void {
  if (r.version !== 1 || sha256(canonical(r.request)) !== r.requestSha256 || sha256(canonical(r.response)) !== r.responseSha256
    || !/^[a-zA-Z0-9.-]+$/.test(r.endpointHost) || r.request.method !== "query" || r.request.params.finality !== "final"
    || !isNearAccountId(r.request.params.account_id)) throw new Error("Invalid route read");
  const result = (r.response as any)?.result;
  const outcome = r.httpStatus === 0 ? "transport-error" : (r.httpStatus < 200 || r.httpStatus >= 300 || (r.response as any)?.error) ? "rpc-error" : result?.error ? "call-error" : "result";
  if (outcome !== r.outcome || r.blockHeight !== (result?.block_height == null ? null : String(result.block_height)) || r.blockHash !== (result?.block_hash ?? null)) throw new Error("Invalid route outcome");
}
export function routeReceipt(r: RouteRead): EvidenceReceipt {
  return { id: `route:${sha256(`${r.endpointHost}:${r.requestSha256}:${r.responseSha256}:${r.retrievedAt}`).slice(0,40)}`, source: `near-rpc:${r.endpointHost}`, responseSha256: r.responseSha256, privacy: "public", observation: { chain: "near", network: "mainnet", blockOrSlot: r.blockHeight, blockHash: r.blockHash, observedAt: r.retrievedAt, retrievedAt: r.retrievedAt, historicalState: "current-only" } };
}
function callValue(r: RouteRead): unknown {
  const bytes = (r.response as any)?.result?.result;
  if (!Array.isArray(bytes)) throw new Error("Missing call bytes");
  return parseNearJson(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)));
}
export function routeTokens(rules: RouteRuleSet): { token: string; chain: string }[] {
  return [...rules.migrations ?? [], { token: "eth.omft.near", chain: "Eth" }];
}
export async function captureRouteReads(rules: RouteRuleSet, options: { endpointUrl: string; fetch?: typeof fetch; now?: () => Date; records?: RouteRead[]; onRecord?: (records: RouteRead[]) => void }): Promise<RouteRead[]> {
  const records: RouteRead[] = structuredClone(options.records ?? []);
  records.forEach(verifyRouteRead);
  let activeEndpoint = options.endpointUrl, lastReadAt = 0;
  async function read(account: string, params: Omit<RouteRead["request"]["params"], "account_id" | "finality">, endpointUrl?: string): Promise<RouteRead> {
    const request: RouteRead["request"] = { method: "query", params: { account_id: account, finality: "final", ...params } };
    const requestHash = sha256(canonical(request));
    const previous = [...records].reverse().find(r => r.requestSha256 === requestHash && (endpointUrl === undefined || r.endpointHost === endpointOrigin(endpointUrl).host));
    if (previous && previous.httpStatus === 200) return previous;
    for (let attempt = 0; ; attempt++) {
      const url = endpointUrl ?? activeEndpoint;
      const delay = Math.max(0, 1000 - (Date.now() - lastReadAt));
      if (delay) await Bun.sleep(delay);
      lastReadAt = Date.now();
      let response: unknown, httpStatus = 0;
      try {
        const res = await (options.fetch ?? globalThis.fetch)(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "intent-route", ...request }), redirect: "error", signal: AbortSignal.timeout(20_000) });
        httpStatus = res.status;
        const body = await res.text();
        try { response = JSON.parse(body); } catch { response = body; }
      } catch { response = { error: { name: "TRANSPORT_ERROR" } }; httpStatus = 0; }
      const body = response as any, result = body?.result;
      const r: RouteRead = { version: 1, request, requestSha256: requestHash, endpointHost: endpointOrigin(url).host, retrievedAt: (options.now?.() ?? new Date()).toISOString(), httpStatus, outcome: !httpStatus ? "transport-error" : httpStatus < 200 || httpStatus >= 300 || body?.error ? "rpc-error" : result?.error ? "call-error" : "result", response, responseSha256: sha256(canonical(response)), blockHeight: result?.block_height == null ? null : String(result.block_height), blockHash: result?.block_hash ?? null };
      records.push(r); options.onRecord?.(records);
      if (httpStatus === 429) {
        if (attempt < 3) { await Bun.sleep(1000 * 2 ** attempt); continue; }
        if (!endpointUrl && endpointOrigin(activeEndpoint).host === "archival-rpc.mainnet.fastnear.com") {
          activeEndpoint = "https://archival-rpc.mainnet.near.org"; attempt = -1; continue;
        }
        throw new Error("Route capture stopped: HTTP 429 after retries");
      }
      if (httpStatus !== 200 || !body || typeof body !== "object" || !("result" in body || "error" in body)) throw new Error(`Route capture stopped: HTTP or response error for ${account}`);
      return r;
    }
  }
  const call = (account: string, method: string, args: unknown) => read(account, { request_type: "call_function", method_name: method, args_base64: Buffer.from(canonical(args)).toString("base64") });
  for (const { token, chain } of routeTokens(rules)) {
    await read(token, { request_type: "view_account" });
    await call(token, "contract_source_metadata", {});
    await call(token, "owner_get", {});
    for (const key of ["STATE", "WITHDRAW_RELAYER_ADDRESS"]) {
      const params = { request_type: "view_state" as const, prefix_base64: Buffer.from(key).toString("base64"), include_proof: false };
      const r = await read(token, params);
      if (r.outcome !== "result" && r.endpointHost === "archival-rpc.mainnet.fastnear.com") await read(token, params, "https://rpc.mainnet.fastnear.com");
    }
    const mapping = await call("omni.bridge.near", "get_token_address", { chain_kind: chain, token });
    const value = mapping.outcome === "result" ? callValue(mapping) : null;
    // Always record both methods, even if there is no foreign address to reverse.
    await call("omni.bridge.near", "get_bridged_token", typeof value === "string" ? { address: value, chain: "Near" } : { address: `near:${token}`, chain });
  }
  return records;
}
export function buildRouteEvidence(records: RouteRead[], rules: RouteRuleSet): Record<string, OmftRouteEvidence> {
  records.forEach(verifyRouteRead);
  const out: Record<string, OmftRouteEvidence> = {};
  for (const { token, chain } of routeTokens(rules)) {
    const receipts = new Map<string, EvidenceReceipt>(), reasons: QueryReason[] = [];
    const own = records.filter(r => r.request.params.account_id === token);
    const observe = <T>(r: RouteRead | undefined, decode: (r: RouteRead) => T): RouteObservation<T> | null => {
      if (!r) return null;
      const receipt = routeReceipt(r); receipts.set(receipt.id, receipt);
      if (r.outcome !== "result") return null;
      try { return { value: decode(r), receipt, basis: "observed", status: "verified" }; }
      catch { reasons.push({ code: "missing-evidence", subject: `near:mainnet:${token}`, ref: `undetermined:decode:${receipt.id}` }); return null; }
    };
    for (const r of own) receipts.set(routeReceipt(r).id, routeReceipt(r));
    const fn = (method: string) => [...own].reverse().find(r => r.request.params.method_name === method);
    const sourceMetadata = observe(fn("contract_source_metadata"), callValue);
    const stringValue = (r: RouteRead) => { const v = callValue(r); if (typeof v !== "string") throw new Error("Expected string"); return v; };
    const state = (key: string, prefixOnly: boolean) => {
      const rs = own.filter(r => r.request.params.request_type === "view_state" && r.request.params.prefix_base64 === Buffer.from(key).toString("base64"));
      const observation = observe([...rs].reverse().find(r => r.outcome === "result") ?? rs.at(-1), r => {
        const values = (r.response as any).result.values;
        const item = Array.isArray(values) && values.find(v => v.key === Buffer.from(key).toString("base64"));
        if (!item || typeof item.value !== "string") throw new Error("State key missing");
        return decodeBorshAccount(Buffer.from(item.value, "base64"), prefixOnly);
      });
      return observation ? { ...observation, basis: "decoded" as const } : null;
    };
    const findCall = (method: string, args: unknown) => [...records].reverse().find(r => r.request.params.account_id === "omni.bridge.near" && r.request.params.method_name === method && r.request.params.args_base64 === Buffer.from(canonical(args)).toString("base64"));
    const mappingValue = (r: RouteRead): string | null => { const v = callValue(r); if (v !== null && typeof v !== "string") throw new Error("Invalid mapping"); return v; };
    const mapping = observe(findCall("get_token_address", { chain_kind: chain, token }), mappingValue);
    const reverseMapping = observe(findCall("get_bridged_token", mapping?.value ? { address: mapping.value, chain: "Near" } : { address: `near:${token}`, chain }), mappingValue);
    out[token] = { token, codeHash: observe([...own].reverse().find(r => r.request.params.request_type === "view_account"), r => { const result = (r.response as any).result; const hash = result.global_contract_hash ?? result.code_hash; if (typeof hash !== "string") throw new Error("Code hash missing"); return hash; }), sourceMetadata, owner: observe(fn("owner_get"), stringValue), controller: isOmniTokenMetadata(sourceMetadata?.value) ? state("STATE", true) : null, withdrawRelayer: isOmniTokenMetadata(sourceMetadata?.value) ? state("WITHDRAW_RELAYER_ADDRESS", false) : null, mapping, reverseMapping, reasons, receipts: [...receipts.values()] };
  }
  return out;
}
