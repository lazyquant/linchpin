/**
 * Composition: the data model the server writes, the messages of a reply, the gate every surface passes before it
 * is sent, and the two fixed surfaces. A model's answer supplies components or a view id; it never supplies a
 * value, and nothing of an answer the gate refused is kept.
 */
import { createSurface, isRecord, updateComponents, updateDataModel } from "../ui/messages";
import { instantiate, listViewTemplates } from "../ui/templates";
import { UiRejected } from "../ui/types";
import type { A2uiComponent, A2uiMessage, AnyResult, CoverageInput, ResultSet, SurfaceMeta } from "../ui/types";
import { validateSurface } from "../ui/validate";
import { BACKEND_NOTES } from "./bundle-backend";
import type { RetrievalBackend, RetrievalResult } from "./retrieval";

export const SURFACE_ID = "answer";
export const REFUSAL_TEXT = "No answer could be composed from the recorded evidence for this question.";
export const NO_MODEL_TEXT = "No model is configured on this machine";
export const PINNED_LABEL = "Composed by a fixed script over recorded evidence, not by a model";
export const PREPARED_TITLE = "Prepared answers";
export const PREPARED_SCOPE = "prepared answers of this build";
export const RULE_CODES_PREFIX = "Rule codes: ";

/** Every fixed string this module can put into a reply. */
export const REPLY_STRINGS: readonly string[] = Object.freeze([
  REFUSAL_TEXT, NO_MODEL_TEXT, PINNED_LABEL, PREPARED_TITLE, PREPARED_SCOPE, RULE_CODES_PREFIX,
  SURFACE_ID, "root", "header", "refusal", "status", "label", "prepared", "protocol", "question",
  ...BACKEND_NOTES,
]);

/** The question as the header shows it: trimmed, runs of whitespace made one space. Nothing else is in the meta. */
export function answerMeta(question: string, title: string, snapshotIds: string[]): SurfaceMeta {
  return { question: question.trim().replace(/\s+/g, " "), protocolTitle: title, snapshotIds: [...snapshotIds] };
}

/** The data model of a reply. The server alone writes it: the meta, every result the tools returned, the coverage. */
export function dataModel(meta: SurfaceMeta, results: RetrievalResult[], coverage: CoverageInput): { meta: SurfaceMeta; results: Record<string, RetrievalResult>; coverage: CoverageInput } {
  return { meta, results: Object.fromEntries(results.map((result) => [result.resultId, result])), coverage };
}

/** One message per line, each line ended by a line feed. */
export function toNdjson(messages: A2uiMessage[]): string {
  return messages.map((message) => `${JSON.stringify(message)}\n`).join("");
}

const noCoverage = (): CoverageInput => ({ mechanics: [], asked: [] });

function fixedNote(resultId: string, notes: string[]): ResultSet {
  return { resultId, shape: "table", columns: [], coverage: "not-mapped", coverageNotes: notes, rows: [], truncated: false };
}

/** The fixed refusal: the header, one sentence and the rule codes. It holds nothing of what was refused. */
export function refusalSurface(meta: SurfaceMeta, codes: string[]): A2uiMessage[] {
  const model = { meta, results: { refusal: fixedNote("refusal", [REFUSAL_TEXT, RULE_CODES_PREFIX + codes.join(", ")]) }, coverage: noCoverage() };
  const components: A2uiComponent[] = [
    { id: "root", component: "Column", children: ["header", "refusal"] },
    { id: "header", component: "AnswerHeader", meta: { path: "/meta" } },
    { id: "refusal", component: "CoverageNote", result: { path: "/results/refusal" } },
  ];
  return [createSurface(SURFACE_ID), updateDataModel(SURFACE_ID, "/", model), updateComponents(SURFACE_ID, components)];
}

/** The fixed surface of a machine without a model: one sentence, the label of the prepared answers, and their list. */
export function noModelSurface(meta: SurfaceMeta, prepared: { id: string; protocol: string; question: string }[]): A2uiMessage[] {
  const list: ResultSet = {
    resultId: "prepared", shape: "table", columns: [{ name: "protocol", role: "label" }, { name: "question", role: "label" }],
    coverage: "mapped", coverageNotes: [],
    rows: prepared.map((entry) => ({
      rowKind: "scope", key: `prepared:${entry.id}`, values: { protocol: entry.protocol, question: entry.question },
      factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [], scopeSource: PREPARED_SCOPE,
    })),
    truncated: false,
  };
  const model = { meta, results: { status: fixedNote("status", [NO_MODEL_TEXT]), prepared: list }, coverage: noCoverage() };
  const components: A2uiComponent[] = [
    { id: "root", component: "Column", children: ["header", "status", "label", "prepared"] },
    { id: "header", component: "AnswerHeader", meta: { path: "/meta" } },
    { id: "status", component: "CoverageNote", result: { path: "/results/status" } },
    { id: "label", component: "Note", text: PINNED_LABEL },
    { id: "prepared", component: "FactTable", result: { path: "/results/prepared" }, title: PREPARED_TITLE },
  ];
  return [createSurface(SURFACE_ID), updateDataModel(SURFACE_ID, "/", model), updateComponents(SURFACE_ID, components)];
}

/** Every evidence id a result names, as the renderer would draw it: string and number members, as text. */
function evidenceIdsOf(results: unknown[]): string[] {
  const ids = new Set<string>();
  const cite = (members: unknown): void => {
    for (const member of Array.isArray(members) ? members : []) if (typeof member === "string" || typeof member === "number") ids.add(String(member));
  };
  for (const result of results) {
    if (!isRecord(result)) continue;
    for (const row of Array.isArray(result.rows) ? result.rows : []) if (isRecord(row)) cite(row.evidenceIds);
    for (const edge of Array.isArray(result.edges) ? result.edges : []) if (isRecord(edge)) cite(edge.evidenceIds);
  }
  return [...ids];
}

/**
 * The gate. The backend is asked once for every evidence id of every result in the data model; the kit's
 * validator then checks the surface with that answer and with the coverage the model was given.
 */
export async function gate(messages: A2uiMessage[], input: { backend: RetrievalBackend; protocol: string; results: unknown[]; coverage: CoverageInput }): Promise<string[]> {
  const ids = evidenceIdsOf(input.results);
  let missing: Set<string> | null = new Set();
  if (ids.length > 0) {
    try {
      const answer = await input.backend.evidence(input.protocol, ids);
      missing = isRecord(answer) && Array.isArray(answer.missing) ? new Set(answer.missing.filter((id): id is string => typeof id === "string")) : null;
    } catch {
      missing = null;
    }
  }
  const resolveEvidence = (asked: string[]): { missing: string[] } => {
    if (missing === null) throw new Error("evidence-not-resolved");
    const absent = missing;
    return { missing: asked.filter((id) => absent.has(id)) };
  };
  return validateSurface(messages, { resolveEvidence, coverage: input.coverage }).codes;
}

export interface Composed { messages: A2uiMessage[]; codes: string[] }

/**
 * Turns a model's answer into the three messages of a reply and passes them through the gate. `codes` is empty
 * when the surface may be sent. The first two messages are the server's own whatever the answer holds.
 */
export async function composeAnswer(input: {
  answer: unknown; meta: SurfaceMeta; results: RetrievalResult[]; coverage: CoverageInput; backend: RetrievalBackend; protocol: string;
}): Promise<Composed> {
  const model = dataModel(input.meta, input.results, input.coverage);
  const head = [createSurface(SURFACE_ID), updateDataModel(SURFACE_ID, "/", model)];
  const answer = input.answer;
  let components: unknown;

  if (isRecord(answer) && Object.prototype.hasOwnProperty.call(answer, "view")) {
    if (Object.keys(answer).some((key) => key !== "view" && key !== "results" && key !== "titles")) return { messages: [], codes: ["schema"] };
    if (typeof answer.view !== "string") return { messages: [], codes: ["schema"] };
    if (!listViewTemplates().some((template) => template.id === answer.view)) return { messages: [], codes: ["unknown-template"] };
    const named = answer.results;
    if (!Array.isArray(named) || named.some((id) => typeof id !== "string")) return { messages: [], codes: ["schema"] };
    const titles = answer.titles;
    if (titles !== undefined && (!isRecord(titles) || Object.values(titles).some((title) => typeof title !== "string"))) return { messages: [], codes: ["schema"] };
    const chosen: RetrievalResult[] = [];
    for (const id of named as string[]) {
      const result = input.results.find((candidate) => candidate.resultId === id);
      if (!result) return { messages: [], codes: ["dangling-binding"] };
      chosen.push(result);
    }
    try {
      const drawn = instantiate(answer.view, { surfaceId: SURFACE_ID, meta: input.meta, results: chosen as AnyResult[], titles: titles as Record<string, string> | undefined, coverage: input.coverage });
      const third = drawn[2];
      components = "updateComponents" in third ? third.updateComponents.components : undefined;
    } catch (error) {
      if (error instanceof UiRejected) return { messages: [], codes: [error.code] };
      return { messages: [], codes: ["schema"] };
    }
  } else if (isRecord(answer) && Object.keys(answer).every((key) => key === "components")) {
    components = answer.components;
  } else {
    return { messages: [], codes: ["schema"] };
  }

  const messages = [...head, updateComponents(SURFACE_ID, components as A2uiComponent[])];
  const codes = await gate(messages, { backend: input.backend, protocol: input.protocol, results: input.results, coverage: input.coverage });
  return { messages, codes };
}
