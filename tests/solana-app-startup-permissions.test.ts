import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// A port diagnosis belongs to listener creation. Asset and loader permission
// failures must remain generic, regardless of their system error code.
const root = join(import.meta.dir, "..");
const fixture = "tests/fixtures/solana-app-startup-permissions/probe.ts";

for (const mode of ["serve-assets", "build-assets", "load"] as const) {
  test(`${mode} errors do not become port-bind failures or expose exception details`, () => {
    const output = mkdtempSync(join(tmpdir(), "solana-startup-permission-"));
    try {
      const result = Bun.spawnSync([process.execPath, "run", fixture, mode, output], {
        cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "", NO_COLOR: "1" },
      });
      expect(result.exitCode).toBe(1);
      const lines = result.stderr.toString().trim().split("\n");
      const diagnosis = lines.filter((line) => !line.includes("reading the committed captures"));
      expect(diagnosis).toHaveLength(1);
      expect(diagnosis[0].trim().length).toBeGreaterThan(0);
      expect(diagnosis[0]).not.toContain("port");
      expect(result.stderr.toString()).not.toContain("STARTUP_DETAIL_CANARY");
      expect(result.stderr.toString()).not.toContain("    at ");
      expect(result.stderr.toString()).not.toContain("could not be bound");
      expect(result.stderr.toString()).not.toContain("EACCES");
      expect(result.stderr.toString()).not.toContain("EADDRINUSE");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 15_000);
}
