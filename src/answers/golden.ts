/**
 * The reference questions and the fixed script that answers each one. A script names tool calls and a surface;
 * it holds no value of a bundle. Every value a prepared answer shows is bound from the rows its tool calls return.
 */
import type { Script } from "./planner";

export interface GoldenEntry { id: string; protocol: string; question: string; script: Script }

type Component = { id: string; component: string; [prop: string]: unknown };

const HEADER: Component = { id: "header", component: "AnswerHeader", meta: { path: "/meta" } };
const R1 = { path: "/results/r1" };

function run(protocol: string, templateId: string, params?: Record<string, unknown>): { tools: { name: string; input: unknown }[] } {
  return { tools: [{ name: "run_template", input: params ? { protocol, templateId, params } : { protocol, templateId } }] };
}
/** The header, then one component over the first result. */
function one(component: Component): { answer: unknown } {
  return { answer: { components: [{ id: "root", component: "Column", children: ["header", component.id] }, HEADER, component] } };
}
const view = (id: string): { answer: unknown } => ({ answer: { view: id, results: ["r1"] } });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export const OUTSIDE_SNAPSHOT_NOTE = "The recorded snapshot maps protocol mechanics only; a price forecast is outside it.";
/** The position of the documentation entry in a coverage list: after the eleven mechanics. */
const DOCUMENTATION_ENTRY = "/coverage/mechanics/11";

export const GOLDEN: readonly GoldenEntry[] = deepFreeze([
  { id: "K1", protocol: "kamino", question: "Who can change the vault's allocations?",
    script: { turns: [run("kamino", "section-control", { subject: "Vault allocations" }), one({ id: "chain", component: "ControlChain", result: R1 })] } },
  { id: "K2", protocol: "kamino", question: "Who can upgrade the lending program?",
    script: { turns: [run("kamino", "section-control", { subject: "Lending program" }), one({ id: "chain", component: "ControlChain", result: R1 })] } },
  { id: "K3", protocol: "kamino", question: "What fees does the vault charge?",
    script: { turns: [run("kamino", "section-parameters", { subject: "FeeBps" }), one({ id: "facts", component: "FactTable", result: R1, columns: ["target", "value", "unit"], title: "Vault fee parameters" })] } },
  { id: "K4", protocol: "kamino", question: "What does the vault depend on?",
    script: { turns: [run("kamino", "vault-dependencies"), view("fact-table")] } },
  { id: "K5", protocol: "kamino", question: "Does the documentation's buffer claim match the chain?",
    script: { turns: [run("kamino", "section-claims", { subject: "buffer" }), one({ id: "facts", component: "FactTable", result: R1, title: "Documentation claim against the chain" })] } },
  { id: "K6", protocol: "kamino", question: "Where do the vault's fees go?",
    script: { turns: [run("kamino", "section-path"), one({ id: "coverage", component: "CoverageNote", result: R1 })] } },
  { id: "K7", protocol: "kamino", question: "Who holds KMNO?",
    script: { turns: [run("kamino", "section-holders"), view("coverage")] } },
  { id: "K8", protocol: "kamino", question: "What does the treasury hold?",
    script: { turns: [run("kamino", "section-offsets"), one({ id: "coverage", component: "CoverageNote", result: R1 })] } },
  { id: "K9", protocol: "kamino", question: "How is KMNO governed?",
    script: { turns: [run("kamino", "section-participation"), one({ id: "coverage", component: "CoverageNote", result: R1 })] } },
  { id: "M1", protocol: "marinade", question: "Who controls the reward fee?",
    script: { turns: [run("marinade", "section-control", { subject: "rewardFee" }), one({ id: "chain", component: "ControlChain", result: R1 })] } },
  { id: "M2", protocol: "marinade", question: "Who can change the fees?",
    script: { turns: [run("marinade", "section-control", { subject: "rewardFee" }), one({ id: "chain", component: "ControlChain", result: R1 })] } },
  { id: "M3", protocol: "marinade", question: "Can more MNDE be minted?",
    script: { turns: [run("marinade", "section-control", { subject: "MNDE supply" }), one({ id: "chain", component: "ControlChain", result: R1 })] } },
  { id: "M4", protocol: "marinade", question: "Predict Bitcoin closing price tomorrow",
    script: { turns: [
      { tools: [{ name: "coverage", input: { protocol: "marinade" } }] },
      { answer: { components: [
        { id: "root", component: "Column", children: ["header", "note", "coverage"] },
        HEADER,
        { id: "note", component: "Note", text: OUTSIDE_SNAPSHOT_NOTE },
        { id: "coverage", component: "CoverageNote", coverage: { path: DOCUMENTATION_ENTRY } },
      ] } },
    ] } },
  { id: "M5", protocol: "marinade", question: "What buybacks flowed?",
    script: { turns: [run("marinade", "section-flows", { subject: "buybacks.months" }), one({ id: "facts", component: "FactTable", result: R1, columns: ["time", "amount", "unit", "sent", "credited"], title: "Buybacks by month" })] } },
  { id: "M6", protocol: "marinade", question: "Is the value path to MNDE holders enforced?",
    script: { turns: [run("marinade", "section-path"), one({ id: "path", component: "ValuePath", result: R1 })] } },
  { id: "M7", protocol: "marinade", question: "Show external outflows",
    script: { turns: [run("marinade", "section-offsets", { subject: "external" }), one({ id: "facts", component: "FactTable", result: R1, title: "External outflows" })] } },
  { id: "M8", protocol: "marinade", question: "Show graph program dependencies",
    script: { turns: [run("marinade", "upgrade-control"), one({ id: "facts", component: "FactTable", result: R1, title: "Program upgrade control" })] } },
  { id: "M9", protocol: "marinade", question: "What remains unresolved?",
    script: { turns: [run("marinade", "unknowns"), one({ id: "unknowns", component: "UnknownList", result: R1 })] } },
]);
