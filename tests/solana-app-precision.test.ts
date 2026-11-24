import { expect, spyOn, test } from "bun:test";
import { startServer, type AppServer } from "../src/apps/solana/server";
import type { AppData } from "../src/apps/solana/model";

test("private quantities retain their full decimal precision at the answers boundary", async () => {
  const address = "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp";
  const quantity = "739172635000000123";
  const data: AppData = {
    version: 1, build: "public", mode: "served", packs: [], absent: [], receipts: {},
    positions: null, replayAddress: address, live: true, ask: { enabled: true },
  };
  const realFetch = globalThis.fetch;
  let origin = "";
  const trap = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== origin) throw new Error("unexpected network request");
    return realFetch(input, init);
  }) as typeof fetch);
  let calls = 0;
  let forwarded = "";
  let server: AppServer | undefined;
  try {
    server = await startServer({
      data, live: true, rpcUrl: "http://127.0.0.1:1",
      deps: { readPositions: async () => ({
        positions: [{
          id: "precision-position", subject: `solana:mainnet-beta:${address}#holder:${address}`,
          quantity, unit: "solana:mainnet-beta:synthetic-unit", snapshotId: "precision-read",
          source: "reader", fixtureKind: "synthetic", receiptIds: [],
        }],
        receipts: [], notRead: [],
      }) },
      answers: async (request) => { calls++; forwarded = await request.text(); return new Response("", { status: 404 }); },
    });
    origin = server.origin;
    const warm = await fetch(`${origin}/api/positions`, {
      method: "POST", headers: { origin, "x-app-token": server.token, "content-type": "application/json" },
      body: JSON.stringify({ source: "live", address }),
    });
    expect(warm.status).toBe(200);
    for (const body of [
      `{"question":"how much?","amount":${quantity}}`,
      `{"question":"how much?","nested":{"amount":${quantity}}}`,
      '{"question":"held: 7.39172635000000123e17"}',
      '{"question":"how much?","amount":7.39172635000000123e17}',
      `{"question":"how much?","amount":${quantity}.0}`,
      `{"question":"${[...quantity].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`,
    ]) {
      expect((await fetch(`${origin}/api/answers/ask`, { method: "POST", body })).status).toBe(422);
      expect(calls).toBe(0);
    }
    // A different number containing the private digits is not the remembered whole token.
    const benignBody = `{"question":"how much?","amount":1${quantity}}`;
    const benign = await fetch(`${origin}/api/answers/ask`, { method: "POST", body: benignBody });
    expect(benign.status).toBe(404);
    expect(calls).toBe(1);
    expect(forwarded).toBe(benignBody);
  } finally {
    await server?.stop();
    trap.mockRestore();
  }
}, 300_000);
