/** Offline guard for the preflight suite: every outbound attempt is recorded and refused, loopback included. */
import net from "node:net";
import http from "node:http";
import https from "node:https";

export interface OfflineTrap { attempts: string[]; restore(): void }

export function installOfflineTrap(): OfflineTrap {
  const attempts: string[] = [];
  const realFetch = globalThis.fetch;
  const originals: [object, string, unknown][] = [];
  globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
    attempts.push("fetch");
    throw new Error("offline by test guard: the preflight suite must not reach the network");
  }) as unknown as typeof fetch;
  const spy = (target: any, key: string, label: string) => {
    if (typeof target[key] !== "function") return;
    originals.push([target, key, target[key]]);
    try {
      target[key] = (...a: unknown[]) => {
        attempts.push(label);
        throw new Error("offline by test guard: the preflight suite must not open a socket");
      };
    } catch { originals.pop(); }
  };
  spy(Bun, "connect", "Bun.connect");
  spy(net, "connect", "net.connect");
  spy(net, "createConnection", "net.createConnection");
  spy(http, "request", "http.request");
  spy(https, "request", "https.request");
  return {
    attempts,
    restore() {
      globalThis.fetch = realFetch;
      for (const [t, k, f] of originals) (t as any)[k] = f;
    },
  };
}
