/**
 * Regression check: the test trap's loopback fetch must not reuse a pooled keep-alive connection.
 *
 * In tests/near-private-risk-manager.test.ts the MCP server runs in the test process. Bun checks a server's idle
 * timeout with a sweep that runs only when the event loop turns, in ticks of about 4 s. After minutes of CPU-bound
 * in-process CLI work, the first event-loop turn can close an idle pooled socket at the moment fetch's HTTP thread
 * writes the next request on it. That request fails with ECONNRESET, "The socket connection was closed unexpectedly",
 * about 1 ms in. The server here is a stand-in with a 1 s idle timeout, so one synchronous block just over a sweep tick
 * recreates that state in about 4 s. Without `keepalive: false` in installTrap, the second test below failed on every
 * run measured (Bun 1.4.2); with it, it passes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { installTrap, type Trap } from "./fixtures/near-private-risk-manager/mcp-client";

const SWEEP_TICK_MS = 4_100; // just over Bun's 4 s idle-timeout sweep tick
let trap: Trap;
let server: ReturnType<typeof Bun.serve>;
const connectionHeaders: (string | null)[] = [];

beforeAll(() => {
  trap = installTrap();
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 1,
    async fetch(req) { connectionHeaders.push(req.headers.get("connection")); await req.text(); return new Response("ok"); },
  });
});
afterAll(async () => { await server.stop(true); trap.restore(); expect(trap.attempts).toEqual([]); });

const post = () => fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

test("the trap's loopback fetch does not ask the server to keep the connection alive", async () => {
  connectionHeaders.length = 0;
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(200);
  expect(connectionHeaders).toHaveLength(2);
  for (const h of connectionHeaders) expect(h?.toLowerCase()).not.toBe("keep-alive");
});

test("the first request after a CPU-bound stretch past the server's idle timeout succeeds (no ECONNRESET on a stale pooled socket)", async () => {
  for (let round = 0; round < 2; round++) {
    expect((await post()).status).toBe(200); // a pooled keep-alive socket would be left here
    Bun.sleepSync(SWEEP_TICK_MS);             // CPU-bound stretch: the event loop does not turn, the idle sweep is postponed
    const res = await post();                 // the sweep runs while this request is in flight
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  }
}, 30_000);
