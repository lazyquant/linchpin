// Runs in its own process, started by the vocabulary gate test. It installs a trap for the graph database
// driver package before anything else is imported, then loads the vocabulary module and builds the report.
// It exits 0 only when the trap never fired: the package was neither loaded nor used. The mode "construct"
// does the forbidden thing on purpose, so the test can show that this check is able to fail.
//
// Usage: bun driver-trap.ts report | construct

export {};

const mode = process.argv[2] ?? "report";
if (mode !== "report" && mode !== "construct") {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

const packageName = ["neo4j", "-", "driver"].join("");
const fired: string[] = [];

Bun.plugin({
  name: "driver-trap",
  setup(build) {
    build.module(packageName, () => {
      fired.push("loaded");
      const refuse = () => {
        fired.push("constructed");
        throw new Error("driver trap: a driver was constructed");
      };
      return { exports: { default: { driver: refuse, Driver: refuse }, driver: refuse, Driver: refuse }, loader: "object" };
    });
  },
});

const report = await import("../../../src/graph/vocabulary/report");
const cli = await import("../../../src/graph/vocabulary/cli");
const questions = await import("../../../src/graph/vocabulary/questions");

const outputs: string[] = [];
await cli.main([], { out: (text: string) => outputs.push(text) });
const built = report.buildReport({ ...report.loadDefaultInputs(), waivers: [] });
void questions.QUESTIONS;

if (mode === "construct") {
  const driverModule = (await import(packageName)) as { default: { driver: (url: string) => unknown } };
  try {
    driverModule.default.driver("bolt://127.0.0.1:1");
  } catch {
    // Swallowed on purpose: the check must rest on the trap record, not on an exception reaching the top.
  }
}

console.log(JSON.stringify({ mode, fired, printed: outputs.length, findings: built.findings.length }));
process.exit(fired.length === 0 ? 0 : 1);
