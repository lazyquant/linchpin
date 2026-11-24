/**
 * Offline guard for the NEAR agent suite: every outbound attempt is recorded and refused.
 * The one carve-out is fetch to this machine's loopback addresses, because the suite starts
 * the agent's own in-process listener there; nothing may leave the machine.
 */

export interface OfflineTrap { attempts: string[]; restore(): void }

import net from "node:net";
import http from "node:http";
import https from "node:https";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const r = input as { url?: unknown } | undefined;
  return typeof r?.url === "string" ? r.url : String(input);
}

export function installOfflineTrap(): OfflineTrap {
  const attempts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    let host = "";
    try { host = new URL(urlOf(input)).hostname; } catch { /* unreachable URL is refused below */ }
    if (LOOPBACK.has(host)) return realFetch(input as URL, init as RequestInit);
    attempts.push(`fetch ${urlOf(input)}`);
    throw new Error("offline by test guard: the near-agent suite must not reach the network");
  }) as unknown as typeof fetch;

  const originals: [object, string, unknown][] = [];
  const spy = (target: unknown, key: string, label: string): void => {
    const t = target as Record<string, unknown>;
    if (typeof t[key] !== "function") return;
    originals.push([t, key, t[key]]);
    try {
      t[key] = (...args: unknown[]) => {
        attempts.push(label);
        throw new Error("offline by test guard: the near-agent suite must not open a socket");
      };
    } catch { originals.pop(); }
  };
  const BunAny = Bun as unknown as Record<string, unknown>;
  spy(BunAny, "connect", "Bun.connect");
  spy(globalThis, "WebSocket", "WebSocket");
  spy(net, "connect", "net.connect");
  spy(net, "createConnection", "net.createConnection");
  spy(http, "request", "http.request");
  spy(https, "request", "https.request");

  return {
    attempts,
    restore() {
      globalThis.fetch = realFetch;
      for (const [t, k, f] of originals) (t as unknown as Record<string, unknown>)[k] = f;
    },
  };
}
