import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileTraceSink, memoryTraceSink } from "../../engine/index";
import { createGenericRegistry, parsePolicy, PolicyRejected, type Policy } from "../../policy/index";
import { DEFAULT_BOOK_PATH, DEFAULT_POLICY_PATH, loadBook, nearestRepository, PositionRejected, resolvedLocalPath } from "./book";
import { ReviewRunFailed } from "./chain";
import { runDemo, toPublicDemo } from "./demo";
import { loadKaminoEvidence } from "./evidence";
import { checkPrivateExportPath, exportJson, toPublicReview, toPublicWatch, writePrivateExport } from "./export";
import { renderMarkdown } from "./render";
import { reviewPositions } from "./review";
import { watchPositions } from "./watch";
const USAGE = "usage: linchpin position review|watch|demo [--fixtures path] [--out dir] [--private-export path] [--trace path]; review [--book path] [--book-snapshot id] [--policy path] [--snapshot id] [--as-of UTC]; watch --before id --after id [--book path] [--book-before id] [--book-after id]";
const FLAGS: Record<string, string[]> = {
  review: ["book", "book-snapshot", "policy", "fixtures", "snapshot", "as-of", "out", "private-export", "trace"],
  watch: ["before", "after", "book", "book-before", "book-after", "fixtures", "out", "private-export", "trace"],
  demo: ["fixtures", "out", "private-export", "trace"],
};
class UsageError extends Error { constructor() { super(USAGE); this.name = "UsageError"; } }
function argumentsFor(argv: string[]) {
  const command = argv[0] ?? "";
  if (!Object.hasOwn(FLAGS, command)) throw new UsageError();
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!, value = argv[i + 1];
    if (!flag.startsWith("--") || !FLAGS[command].includes(flag.slice(2)) || value === undefined || !value.length || value.startsWith("--") || Object.hasOwn(flags, flag.slice(2))) throw new UsageError();
    flags[flag.slice(2)] = value;
  }
  if (command === "watch" && (!flags.before || !flags.after)) throw new UsageError();
  return { command, flags };
}
async function policyAt(path: string, explicit: boolean): Promise<Policy | null> {
  if (!existsSync(path) && !explicit) return null;
  let text: string;
  try { text = await Bun.file(path).text(); } catch { throw new PositionRejected("policy-not-found"); }
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new PolicyRejected("malformed-json"); }
  return parsePolicy(json, createGenericRegistry());
}
async function writePublic(path: string, value: string): Promise<void> {
  try { mkdirSync(dirname(path), { recursive: true }); await Bun.write(path, value); }
  catch { throw new PositionRejected("public-export-write-failed"); }
}
export async function runPositionCommand(argv: string[]): Promise<number> {
  try {
    const { command, flags } = argumentsFor(argv);
    const out = resolve(flags.out ?? "out/position-review");
    const privatePath = flags["private-export"] === undefined ? null : checkPrivateExportPath(flags["private-export"]);
    const tracePath = flags.trace === undefined ? null : resolvedLocalPath(flags.trace);
    if (tracePath !== null && nearestRepository(tracePath) !== null) throw new PositionRejected("trace-in-repository");
    const outputNames = command === "review" ? ["position-review.public.json", "position-review.public.md"]
      : command === "watch" ? ["position-watch.public.json"] : ["position-demo.public.json", "position-demo.public.md"];
    const destinations = outputNames.map(name => resolvedLocalPath(join(out, name)));
    const inputs = command === "demo" ? [] : [resolvedLocalPath(flags.book ?? DEFAULT_BOOK_PATH), resolvedLocalPath(flags.policy ?? DEFAULT_POLICY_PATH)];
    const outputs = [...destinations, ...(privatePath ? [privatePath] : []), ...(tracePath ? [tracePath] : [])];
    if (new Set(outputs).size !== outputs.length || outputs.some(path => inputs.includes(path))) throw new PositionRejected("output-path-collision");
    const fixtures = flags.fixtures ?? "fixtures/kamino";
    // Captures are public and normalized before reading any private inventory.
    const evidence = command === "demo" ? null : loadKaminoEvidence(fixtures);
    const book = command === "demo" ? null : await loadBook(flags.book ?? DEFAULT_BOOK_PATH);
    const policy = command === "review" ? await policyAt(flags.policy ?? DEFAULT_POLICY_PATH, flags.policy !== undefined) : null;
    if (tracePath) mkdirSync(dirname(tracePath), { recursive: true });
    const engine = { trace: tracePath ? fileTraceSink(tracePath) : memoryTraceSink() };
    if (command === "review") {
      const report = await reviewPositions({ evidence: evidence!, book: book!, bookSnapshotId: flags["book-snapshot"], snapshotId: flags.snapshot, asOf: flags["as-of"], policy, engine });
      const publicReport = toPublicReview(report), jsonPath = join(out, outputNames[0]);
      if (privatePath) writePrivateExport(privatePath, report);
      await writePublic(jsonPath, exportJson(publicReport));
      await writePublic(join(out, outputNames[1]), renderMarkdown(publicReport));
      console.log(`position review: snapshot ${report.snapshot.id} · verdict ${report.verdict?.outcome ?? "not-evaluated"} · ${jsonPath}`);
    } else if (command === "watch") {
      const report = await watchPositions({ evidence: evidence!, book: book!, bookBefore: flags["book-before"], bookAfter: flags["book-after"], before: flags.before, after: flags.after, engine });
      const json = exportJson(toPublicWatch(report));
      if (privatePath) writePrivateExport(privatePath, report);
      await writePublic(join(out, outputNames[0]), json);
      console.log(json.trimEnd());
    } else {
      const demo = await runDemo(fixtures, engine), projected = toPublicDemo(demo);
      if (privatePath) writePrivateExport(privatePath, demo);
      await writePublic(join(out, outputNames[0]), exportJson(projected));
      const md = [renderMarkdown(toPublicReview(demo.review)), "## Dependency-change scenario", "",
        ...toPublicWatch(demo.dependencyChange).events.flatMap(e => [e.label, ...e.changes.map(c => `- \`${c.key}\`: \`${c.beforeObject}\` → \`${c.afterObject}\`; receipts ${c.evidenceIds.map(id => `\`${id}\``).join(", ")}.`)]), "",
        "## Unchanged scenario", "", `${demo.unchanged.events.length} events.`, "", "## Missing-data scenario", "",
        ...demo.missingData.rules.map(r => `- \`${r.ruleId}\`: \`${r.outcome}\`; ${r.reasons.map(reason => `\`${reason.code}\``).join(", ")}.`),
        ...demo.missingData.unknownControllers.map(subject => `- \`unknown-controller\`: \`${subject}\`.`),
        ...demo.missingData.missing.map(missing => `- \`${missing}\`.`), "", "Valuation: unknown (missing price).", "", "## Scenario receipts", "",
        ...demo.receipts.map(r => `- \`${r.id}\`: \`${r.source}\`; observed \`${r.observation.observedAt}\`; slot \`${r.observation.blockOrSlot ?? "unknown"}\`; \`${r.observation.historicalState}\`.`), ""].join("\n");
      await writePublic(join(out, outputNames[1]), md);
      console.log(`position demo: review · verdict ${demo.review.verdict!.outcome}`);
      console.log(`position demo: dependency-change · ${demo.dependencyChange.events.length} event`);
      console.log(`position demo: unchanged · ${demo.unchanged.events.length} events`);
      console.log(`position demo: missing-data · undetermined evidence`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ReviewRunFailed) { console.error(`${error.name}: ${error.message}`); return 1; }
    if (error instanceof UsageError || error instanceof PositionRejected || error instanceof PolicyRejected) { console.error(`${error.name}: ${error.message}`); return 2; }
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") { console.error("PositionRejected: input-or-path-unavailable"); return 2; }
    console.error("PositionError: unexpected-error");
    return 1;
  }
}
