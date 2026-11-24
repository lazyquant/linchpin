/**
 * The reference questions against a configured model.
 *
 *   bun run src/answers/eval.ts --dry-run    lists the questions and makes no request
 *   bun run src/answers/eval.ts              answers each with the model named by LINCHPIN_AGENT_MODEL and writes a
 *                                            report to the file named by LINCHPIN_AGENT_EVAL_OUT, outside the repository
 *
 * The report says, per question, how the answer ended and which row keys it cites, beside the keys the fixed
 * script cites. It sets no pass mark.
 */
import { GOLDEN } from "./golden";

const USAGE = "usage: bun run src/answers/eval.ts [--dry-run]";
const VALUE_COMPONENTS = new Set(["FactTable", "ControlChain", "ValuePath", "UnknownList", "Timeline"]);
const CITED_KINDS = new Set(["fact", "path", "unknown"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The keys of the cited rows a reply draws: the fact, path and unknown rows of every result a value component binds. */
export function citedKeys(ndjson: string): string[] {
  const messages = ndjson.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown).filter(isRecord);
  const model = messages.map((message) => message.updateDataModel).find(isRecord)?.value;
  const components = messages.map((message) => message.updateComponents).find(isRecord)?.components;
  const results = isRecord(model) && isRecord(model.results) ? model.results : {};
  const keys: string[] = [];
  for (const component of Array.isArray(components) ? components.filter(isRecord) : []) {
    if (!VALUE_COMPONENTS.has(String(component.component)) || !isRecord(component.result) || typeof component.result.path !== "string") continue;
    const result = results[component.result.path.replace(/^\/results\//, "")];
    for (const row of isRecord(result) && Array.isArray(result.rows) ? result.rows.filter(isRecord) : []) {
      if (CITED_KINDS.has(String(row.rowKind)) && typeof row.key === "string" && !keys.includes(row.key)) keys.push(row.key);
    }
  }
  return keys;
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--dry-run") {
    for (const entry of GOLDEN) console.log(`${entry.id}\t${entry.protocol}\t${entry.question}`);
    return 0;
  }
  if (argv.length > 0) {
    console.error(USAGE);
    return 2;
  }
  // Loaded only for a real run: a dry run reads no bundle and builds no model.
  const { anthropicModelFromEnv } = await import("./anthropic");
  const { ModelError, ScriptedModel, answerQuestion } = await import("./planner");
  try {
    anthropicModelFromEnv();
    if (!process.env.ANTHROPIC_API_KEY) throw new ModelError("model-not-configured");
  } catch (error) {
    console.error(error instanceof ModelError ? error.code : "model-not-configured");
    return 2;
  }
  const { insideRepository } = await import("./log");
  const out = process.env.LINCHPIN_AGENT_EVAL_OUT;
  if (!out || insideRepository(out)) {
    console.error("LINCHPIN_AGENT_EVAL_OUT must name a file outside the repository");
    return 2;
  }
  const { loadBundleBackend } = await import("./bundle-backend");
  const backend = await loadBundleBackend();
  const questions = [];
  for (const entry of GOLDEN) {
    const model = anthropicModelFromEnv();
    const started = Date.now();
    const outcome = await answerQuestion({ question: entry.question, protocol: entry.protocol, backend, model });
    const scripted = await answerQuestion({ question: entry.question, protocol: entry.protocol, backend, model: new ScriptedModel(entry.script) });
    const cited = outcome.ndjson === "" ? [] : citedKeys(outcome.ndjson);
    const expected = citedKeys(scripted.ndjson);
    questions.push({
      id: entry.id, protocol: entry.protocol, question: entry.question, modelId: model.id, kind: outcome.kind, codes: outcome.codes,
      modelCalls: outcome.modelCalls, toolCalls: outcome.toolCalls, templateIds: outcome.templateIds,
      inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, latencyMs: Date.now() - started,
      citedKeys: cited, scriptCitedKeys: expected, sameKeysAsScript: cited.length === expected.length && cited.every((key) => expected.includes(key)),
    });
    console.log(`${entry.id}\t${outcome.kind}\t${outcome.codes.join(",")}`);
  }
  await Bun.write(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), questions }, null, 2)}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
