/**
 * Tester child harness for the panel command's refusal of a failing kit
 * surface.
 *
 * Through the test runtime's module mock it replaces the kit validator with a
 * verdict that follows the kit's public result shape and fails with two codes
 * of the kit's public rule vocabulary. It then calls the panel command's
 * public entry point and records the returned code, every error line and the
 * output directory's content in the JSON file named by
 * PANEL_INVALID_SURFACE_RESULT; the command's output directory arrives in
 * PANEL_INVALID_SURFACE_OUT. Without both paths the harness does nothing, so
 * an accidental discovery run stays inert.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mock, expect, spyOn, test } from "bun:test";

const resultPath = process.env.PANEL_INVALID_SURFACE_RESULT;
const outDir = process.env.PANEL_INVALID_SURFACE_OUT;
const subjectAccount = "intents.near";
const fullSubject = "near:mainnet:intents.near";
const codes = ["unresolved-evidence", "uncited-row"] as const;

if (!resultPath || !outDir) {
  test("the invalid-surface child harness runs only when its env paths are set", () => {
    expect(resultPath ?? outDir).toBeUndefined();
  });
} else {
  mock.module("../../../src/ui/validate", () => ({
    receiptResolver: () => ({ missing: [] }),
    validateSurface: () => ({
      ok: false,
      codes: [...codes],
      findings: codes.map((code) => ({
        rule: "tester-probe",
        code,
        componentId: null,
        detail: "planted failing surface",
      })),
    }),
  }));

  test("the panel command refuses the failing surface with a nonzero code, the subject, the rule codes and no file", async () => {
    const errorSpy = spyOn(console, "error");
    let code = 0;
    let threw: string | null = null;
    try {
      const { run } = await import("../../../src/near/cli/panel");
      code = await run([subjectAccount, "--out", outDir, "--offline"]);
    } catch (e) {
      threw = String(e);
    }
    const stderrLines = errorSpy.mock.calls.map((call) => call.map(String).join(" "));
    errorSpy.mockRestore();
    writeFileSync(
      resultPath,
      JSON.stringify({ code, threw, stderrLines }, null, 2) + "\n",
    );
    expect(threw, threw ?? "").toBe(null);
    expect(code).not.toBe(0);
    const stderr = stderrLines.join("\n");
    expect(stderr, stderr).toContain(fullSubject);
    for (const code of codes) expect(stderr, code).toContain(code);
    const files = existsSync(outDir) ? readdirSync(outDir) : [];
    expect(files, files.join(" | ")).toHaveLength(0);
  });
}
