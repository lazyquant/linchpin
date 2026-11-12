import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WaiversRejected, buildReport, exitCodeOf, loadDefaultInputs, parseWaivers, renderReport } from "./report";

/**
 * Prints the conformance report. Exit 0 only when every question case passes or is uncovered and no
 * blocking finding is open; 1 otherwise or when the waivers file is malformed; 2 for a bad argument.
 * It reads local files only and writes a file only when `--out` is given.
 */
export interface CliDeps {
  root: string;
  waiversText(): string;
  out(text: string): void;
  err(text: string): void;
  writeText(path: string, text: string): void;
}

const MODULE_DIR = import.meta.dir;

function defaultDeps(): CliDeps {
  return {
    root: join(MODULE_DIR, "..", "..", ".."),
    waiversText: () => readFileSync(join(MODULE_DIR, "waivers.json"), "utf8"),
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(`${text}\n`); },
    writeText: (path, text) => writeFileSync(path, text),
  };
}

export async function main(args: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  let outFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && i + 1 < args.length) outFile = args[++i]!;
    else { deps.err(`Unknown argument: ${args[i]}`); return 2; }
  }
  let waivers;
  try { waivers = parseWaivers(deps.waiversText()); } catch (error) {
    if (error instanceof WaiversRejected) { deps.err(error.message); return 1; }
    throw error;
  }
  const report = buildReport({ ...loadDefaultInputs(deps.root), waivers });
  const text = renderReport(report);
  deps.out(text);
  if (outFile !== null) deps.writeText(outFile, text);
  return exitCodeOf(report);
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
