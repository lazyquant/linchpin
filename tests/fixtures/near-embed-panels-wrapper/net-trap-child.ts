/**
 * Tester fixture preload for a spawned CLI child.
 *
 * It replaces this fixture's trapped network entry points of the child process
 * (fetch, WebSocket, Bun.connect and node:net through its default-export
 * object; the ESM namespace binding cannot be redefined from a preload, a
 * limit disclosed in the test report) with a trap that
 * appends one `attempt:<kind>` line to the file named by PANEL_NETTRAP_LOG and
 * then throws, so any network attempt fails the child. With PANEL_NETTRAP_PROBE
 * set it also makes one deliberate attempt per entry point and records
 * `probe:<kind>:threw` when the trap blocked it, or `probe:<kind>:NOT-BLOCKED`
 * when an attempt went through. Without a log path attempts still fail but are
 * not recorded. The child exits after the command, which is its own restore;
 * the parent test file restores its own traps.
 */
import { appendFileSync } from "node:fs";
import * as netNamespace from "node:net";
import netDefault from "node:net";

const logPath = process.env.PANEL_NETTRAP_LOG;
const trapError = (kind: string) => new Error(`network is trapped in this child process (${kind})`);

function log(line: string): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* recording must never mask the trap itself */
  }
}

function record(kind: string): never {
  log(`attempt:${kind}`);
  throw trapError(kind);
}

(globalThis as unknown as { fetch: unknown }).fetch = function trappedFetch(): never {
  record("fetch");
} as unknown as typeof fetch;

(globalThis as unknown as { WebSocket: unknown }).WebSocket = class trappedWebSocket {
  constructor() {
    record("websocket");
  }
};

const bunApi = Bun as unknown as { connect: unknown };
bunApi.connect = (): never => record("bun.connect");

// The ESM namespace object's bindings cannot be replaced from a preload; the
// default-export object can, and both entry names are trapped there. The
// namespace's own bindings stay native: a child-side limit, disclosed in the
// test report; the test file traps that form in its own process.
for (const netModule of [netDefault, netNamespace] as unknown as Record<string, unknown>[]) {
  for (const name of ["connect", "createConnection"]) {
    if (typeof netModule[name] !== "function") continue;
    const trap = (): never => record(`net.${name}`);
    try {
      Object.defineProperty(netModule, name, { value: trap, writable: true, configurable: true });
    } catch {
      try {
        netModule[name] = trap;
      } catch {
        /* an untrapdable entry point stays native; the probe reports only trapped kinds */
      }
    }
  }
}

if (process.env.PANEL_NETTRAP_PROBE) {
  const probe = (kind: string, attempt: () => unknown): void => {
    try {
      attempt();
      log(`probe:${kind}:NOT-BLOCKED`);
    } catch {
      log(`probe:${kind}:threw`);
    }
  };
  probe("fetch", () => (globalThis as unknown as { fetch: (url: string) => unknown }).fetch("https://panel-trap.invalid"));
  probe("websocket", () => new (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket("ws://panel-trap.invalid"));
  probe("bun.connect", () => (bunApi.connect as (opts: unknown) => unknown)({}));
  probe("net.connect", () => (netDefault as unknown as { connect: (opts: unknown) => unknown }).connect({}));
  probe("net.createConnection", () => (netDefault as unknown as { createConnection: (opts: unknown) => unknown }).createConnection({}));
}
