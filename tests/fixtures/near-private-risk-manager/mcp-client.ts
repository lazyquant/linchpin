/** JSON-RPC client for the MCP server under test, plus the outbound-socket trap. */
import net from "node:net";
import http from "node:http";
import https from "node:https";

export interface Trap { attempts: string[]; restore(): void; real: { connect: typeof Bun.connect } }
/**
 * Replaces fetch (loopback 127.0.0.1 allowed, everything else recorded and refused) and spies on the other socket entry points.
 *
 * Every allowed loopback fetch goes out with `keepalive: false`, so no request reuses a pooled connection.
 * The MCP server under test runs in this process, and its idle timeout is checked only when the event loop turns.
 * After a long CPU-bound stretch (the in-process CLI tests), the first turn can close an idle pooled socket while
 * fetch's HTTP thread is already writing the next request on it. The request then fails with ECONNRESET,
 * "The socket connection was closed unexpectedly", about 1 ms in. tests/near-private-risk-manager-mcp-connection.test.ts
 * reproduces that race.
 */
export function installTrap(): Trap {
  const attempts: string[] = [];
  const realFetch = globalThis.fetch;
  const realConnect = Bun.connect;
  const originals: [object, string, unknown][] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1") { attempts.push(`fetch ${url.hostname}`); throw new Error("outbound network blocked by test trap"); }
    return realFetch(input, { ...init, keepalive: false });
  }) as typeof fetch;
  const spy = (target: any, key: string, label: string) => {
    if (typeof target[key] !== "function") return;
    originals.push([target, key, target[key]]);
    try { target[key] = (...a: unknown[]) => { attempts.push(label); throw new Error("outbound socket blocked by test trap"); }; } catch { originals.pop(); }
  };
  spy(Bun, "connect", "Bun.connect");
  spy(net, "connect", "net.connect"); spy(net, "createConnection", "net.createConnection");
  spy(http, "request", "http.request"); spy(https, "request", "https.request");
  return { attempts, real: { connect: realConnect }, restore() { globalThis.fetch = realFetch; for (const [t, k, f] of originals) (t as any)[k] = f; } };
}

export interface RpcReply { status: number; text: string; json: any }
export class McpClient {
  private id = 0;
  readonly bodies: string[] = [];
  constructor(readonly url: string, readonly token: string | null) {}
  async post(body: unknown, headers: Record<string, string> = {}, raw = false): Promise<RpcReply> {
    const h: Record<string, string> = { "content-type": "application/json", ...headers };
    if (this.token !== null && !("authorization" in h)) h.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.url, { method: "POST", headers: h, body: raw ? String(body) : JSON.stringify(body) });
    const text = await res.text(); this.bodies.push(text);
    let json: any = null; try { json = JSON.parse(text); } catch { /* empty or non JSON body */ }
    return { status: res.status, text, json };
  }
  rpc(method: string, params?: unknown, headers?: Record<string, string>) { return this.post({ jsonrpc: "2.0", id: ++this.id, method, ...(params === undefined ? {} : { params }) }, headers); }
  call(name: string, args: unknown) { return this.rpc("tools/call", { name, arguments: args }); }
}
