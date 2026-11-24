import { run } from "../../../src/apps/solana/main";
import type { AppData } from "../../../src/apps/solana/model";

const mode = process.argv[2];
const data: AppData = {
  version: 1, build: "public", mode: "served", packs: [], absent: [], receipts: {},
  positions: null, replayAddress: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp",
  live: false, ask: { enabled: false },
};
const failure = Object.assign(new Error("STARTUP_DETAIL_CANARY"), {
  code: mode === "load" ? "EADDRINUSE" : "EACCES",
});
if (mode !== "load") {
  Bun.build = (() => { throw failure; }) as typeof Bun.build;
}
const command = mode === "build-assets"
  ? { command: "build" as const, out: process.argv[3]! }
  : { command: "serve" as const, port: 0, live: false };
const code = await run(command, async () => {
  if (mode === "load") throw failure;
  return data;
});
if (code >= 0) process.exitCode = code;
