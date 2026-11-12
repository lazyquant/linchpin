import type { NotReadReason } from "../../positions/types";
import { PositionsRejected } from "../../positions/types";
import { redactSecrets } from "../../chain/rpc";
export class RpcFailure extends Error {
  constructor(public readonly reason: NotReadReason) { super(reason); this.name = "RpcFailure"; }
}
export interface SolanaRpcClient {
  host: string;
  programAccounts: boolean;
  call(method: string, params: unknown[]): Promise<{result: unknown; retrievedAt: string}>;
}
export function createSolanaRpcClient(options: {url: string; timeoutMs: number; programAccounts: boolean; fetch?: typeof fetch; now?: () => number}): SolanaRpcClient {
  let endpoint: URL;
  try { endpoint = new URL(options.url); } catch { throw new PositionsRejected("invalid-endpoint"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2147483647) throw new PositionsRejected("invalid-configuration");
  return { host: endpoint.host, programAccounts: options.programAccounts, async call(method, params) {
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(endpoint.href, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc:"2.0", id:1, method, params}), signal, redirect: "error"});
      if (!response.ok) throw new RpcFailure(response.status === 403 ? "rpc-method-refused" : "rpc-error");
      const body = await response.json() as {result?: unknown; error?: {code?: number}};
      if (!body || typeof body !== "object") throw new RpcFailure("rpc-error");
      if (body.error) throw new RpcFailure([-32601, -32010].includes(body.error.code ?? 0) ? "rpc-method-refused" : "rpc-error");
      return {result: body.result, retrievedAt: new Date((options.now ?? Date.now)()).toISOString()};
    } catch (error) {
      if (signal.aborted || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new RpcFailure("timeout");
      const failure = error instanceof RpcFailure ? error : new RpcFailure("rpc-error");
      failure.message = redactSecrets(failure.message, options.url);
      throw failure;
    }
  }};
}
