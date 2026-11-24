/**
 * A fresh-subprocess entry the regression tests spawn to observe how the app command
 * reports startup failures. Two modes:
 *
 *   bun run tests/fixtures/solana-app-final-review-fixes/startup-probe.ts bind <port>
 *       runs `serve` on an already-occupied local port with minimal loaded data;
 *   bun run tests/fixtures/solana-app-final-review-fixes/startup-probe.ts build-fail <out>
 *       replaces Bun.build with one that throws a synthetic ENOENT carrying a private
 *       detail canary, then runs `build` with minimal loaded data.
 *
 * The process exit code and stderr are the observed behavior under test.
 */
import { run } from "../../../src/apps/solana/main";
import type { AppData } from "../../../src/apps/solana/model";

const CANARY = "LK-PRIVATE-DETAIL:/home/private/meeting-notes/request-body.txt";
const ADDRESS = "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp";

const minimalData = (): AppData => ({
  version: 1, build: "public", mode: "served", packs: [], absent: [], receipts: {},
  positions: null, replayAddress: ADDRESS, live: false, ask: { enabled: false },
});

const [mode, argument] = process.argv.slice(2);

/** Runs one command of the app and exits with the code `run` reports. */
const observe = async (code: Promise<number>): Promise<void> => {
  const reported = await code;
  if (reported >= 0) process.exitCode = reported;
  // A reported -1 keeps serving; the test's spawn timeout ends such a process.
};

if (mode === "bind") {
  await observe(run({ command: "serve", port: Number(argument), live: false }, async () => minimalData()));
} else if (mode === "build-fail") {
  const boom = Object.assign(new Error(`synthetic asset failure ${CANARY}`), { code: "ENOENT" });
  (Bun as unknown as { build: unknown }).build = ((): never => {
    throw boom;
  }) as unknown;
  try {
    // A startup failure that escapes `run` is the defect under test: let it reject, so the
    // unhandled rejection carries whatever text the implementation lets through.
    await observe(run({ command: "build", out: argument }, async () => minimalData()));
  } catch {
    process.exitCode = 1;
  }
} else {
  console.error("startup-probe: mode is bind <port> or build-fail <out>");
  process.exitCode = 2;
}
