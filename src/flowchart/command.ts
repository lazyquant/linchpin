import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { FlowchartError } from "./index";
import { generateFlowchartHtml, validateFlowchartHtml } from "./index";
import type { FlowchartInput, FlowchartModel, FlowchartProblem } from "./index";

const FLOWCHART_USAGE = "usage: linchpin flowchart <input.json> --out <file.html> [--title <text>] [--source evidence-graph]";
const VALIDATE_USAGE = "usage: linchpin flowchart-validate <file.html> [--input <input.json>] [--source evidence-graph]";

type ParsedArgs = { positional: string[]; flags: Map<string, string> };

function parseArgs(argv: string[], allowed: ReadonlySet<string>): ParsedArgs | null {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!allowed.has(name)) return null;
      if (i + 1 >= argv.length) return null;
      flags.set(name, argv[i + 1]);
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function printProblems(problems: FlowchartProblem[]): void {
  for (const problem of problems) process.stdout.write(`${sanitize(problem.code)}\t${sanitize(problem.detail)}\n`);
}

function readModel(html: string): FlowchartModel | null {
  const match = /<script type="application\/json" id="linchpin-flowchart-model">([^<]*)<\/script>/.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as FlowchartModel;
  } catch {
    return null;
  }
}

function sourceFlag(flags: Map<string, string>): string | null {
  const source = flags.get("source");
  if (source === undefined) return "evidence-graph";
  return source === "evidence-graph" ? source : null;
}

export async function runFlowchartCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, new Set(["out", "title", "source"]));
  if (!parsed) {
    process.stderr.write(`${FLOWCHART_USAGE}\n`);
    return 2;
  }
  const { positional, flags } = parsed;
  const out = flags.get("out");
  if (positional.length !== 1 || out === undefined) {
    process.stderr.write(`${FLOWCHART_USAGE}\n`);
    return 2;
  }
  if (sourceFlag(flags) === null) {
    process.stderr.write(`${FLOWCHART_USAGE}\n`);
    return 2;
  }

  const inputPath = positional[0];
  let text: string;
  try {
    text = readFileSync(inputPath, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${inputPath}: ${reasonOf(error)}\n${FLOWCHART_USAGE}\n`);
    return 2;
  }

  let graph: unknown;
  try {
    graph = JSON.parse(text);
  } catch {
    process.stdout.write(`source-invalid\t${sanitize(inputPath)}: not valid JSON\n`);
    return 1;
  }

  let html: string;
  try {
    html = generateFlowchartHtml({ source: "evidence-graph", graph }, flags.get("title") ?? "Linchpin flowchart");
  } catch (error) {
    if (error instanceof FlowchartError) {
      printProblems(error.problems);
    } else {
      process.stdout.write(`source-invalid\t${sanitize(reasonOf(error))}\n`);
    }
    return 1;
  }

  const temporary = `${out}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, html, "utf8");
    renameSync(temporary, out);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      void 0;
    }
    process.stderr.write(`cannot write ${out}: ${reasonOf(error)}\n${FLOWCHART_USAGE}\n`);
    return 2;
  }

  const model = readModel(html);
  if (!model) {
    process.stdout.write(`${out}\n`);
    return 0;
  }
  process.stdout.write(`${out}\tnodes=${model.nodes.length}\tedges=${model.edges.length}\tsha256=${model.sha256}\n`);
  return 0;
}

export async function runFlowchartValidateCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, new Set(["input", "source"]));
  if (!parsed) {
    process.stderr.write(`${VALIDATE_USAGE}\n`);
    return 2;
  }
  const { positional, flags } = parsed;
  if (positional.length !== 1) {
    process.stderr.write(`${VALIDATE_USAGE}\n`);
    return 2;
  }
  if (sourceFlag(flags) === null) {
    process.stderr.write(`${VALIDATE_USAGE}\n`);
    return 2;
  }

  const htmlPath = positional[0];
  let html: string;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${htmlPath}: ${reasonOf(error)}\n${VALIDATE_USAGE}\n`);
    return 2;
  }

  let input: FlowchartInput | undefined;
  const inputPath = flags.get("input");
  if (inputPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(inputPath, "utf8");
    } catch (error) {
      process.stderr.write(`cannot read ${inputPath}: ${reasonOf(error)}\n${VALIDATE_USAGE}\n`);
      return 2;
    }
    let graph: unknown;
    try {
      graph = JSON.parse(text);
    } catch {
      process.stdout.write(`source-invalid\t${sanitize(inputPath)}: not valid JSON\n`);
      return 1;
    }
    input = { source: "evidence-graph", graph };
  }

  const problems = validateFlowchartHtml(html, input);
  if (problems.length > 0) {
    printProblems(problems);
    return 1;
  }

  const model = readModel(html);
  if (!model) {
    process.stdout.write("ok\n");
    return 0;
  }
  process.stdout.write(`ok\tnodes=${model.nodes.length}\tedges=${model.edges.length}\tsha256=${model.sha256}\n`);
  return 0;
}
