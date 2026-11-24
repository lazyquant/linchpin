import { createSurface, readSurface, updateComponents, updateDataModel } from "../../ui/messages";
import { instantiate } from "../../ui/templates";
import { receiptResolver, validateSurface } from "../../ui/validate";
import type { A2uiComponent, A2uiMessage } from "../../ui/types";
import { record } from "./errors";
import { coverageResult } from "./rows";
import type { SurfaceInput } from "./types";
import { LABELS } from "./web/strings";

export interface ViewChoice { view: string; results: string[]; summary?: string }
export interface ComposedSurface { messages: A2uiMessage[]; codes: string[] }
function choice(value: unknown): ViewChoice | null {
  if (!record(value) || Object.keys(value).some(k => !["view", "results", "summary"].includes(k))
    || typeof value.view !== "string" || !Array.isArray(value.results) || !value.results.length || value.results.length > 6
    || !value.results.every((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(id))
    || new Set(value.results).size !== value.results.length
    || value.summary !== undefined && typeof value.summary !== "string") return null;
  return { view: value.view, results: value.results, ...(typeof value.summary === "string" ? { summary: value.summary } : {}) };
}
const TITLES: Record<string, string> = { authority: "Authoritative result", r1: LABELS.facts, policy_rules: LABELS.policy, authority_graph: LABELS.graph,
  unknown_facts: LABELS.unknowns, authority_gaps: LABELS.unknowns, attestation: LABELS.report, binding: LABELS.binding, receipts: LABELS.receipts, notice: LABELS.result };

/** All data is server owned. A model can only add a view over named results. */
export function composeSurface(input: SurfaceInput, selection?: unknown, notice?: string): ComposedSurface {
  const results = [...input.results];
  if (notice) results.push(coverageResult("notice", [notice]));
  const mandatoryIds = new Set(["authority", "r1", "policy_rules", "authority_graph", "unknown_facts", "authority_gaps", "attestation", "binding", "receipts", "notice"]);
  const mandatory = results.filter(r => mandatoryIds.has(r.resultId));
  const base = readSurface(instantiate("subject-panel", { surfaceId: "near-answer", meta: input.meta, results: mandatory, titles: TITLES }));
  const components = [...base.components.values()].map(c => c.id === "header" ? { ...c, component: "AnswerHeader" } : c);
  const root = components.find(c => c.id === "root")!;
  const children = [...root.children as string[]];
  let codes: string[] = [];
  if (selection !== undefined) {
    const picked = choice(selection);
    if (!picked) codes = ["schema"];
    else {
      const selected = picked.results.map(id => results.find(r => r.resultId === id));
      if (selected.some(r => !r)) codes = ["unknown-result"];
      else {
        try {
          const extra = readSurface(instantiate(picked.view, { surfaceId: "near-answer", meta: input.meta, results: selected.filter(r => r !== undefined) }));
          const extraRoot = extra.components.get("root")!;
          const extraChildren = (extraRoot.children as string[]).filter(id => extra.components.get(id)?.component !== "SubjectHeader");
          const added: A2uiComponent[] = [...extra.components.values()].filter(c => c.id !== "root" && c.component !== "SubjectHeader").map(c => ({
            ...c, id: `chosen-${c.id}`, ...(Array.isArray(c.children) ? { children: c.children.map(id => `chosen-${id}`) } : {}),
          }));
          if (extraChildren.length) {
            children.push("chosen-section");
            components.push({ id: "chosen-section", component: "Section", title: LABELS.context, children: extraChildren.map(id => `chosen-${id}`) }, ...added);
          }
          if (picked.summary !== undefined) {
            children.push("summary-label", "summary");
            components.push({ id: "summary-label", component: "Note", text: LABELS.summary }, { id: "summary", component: "Note", text: picked.summary });
          }
        } catch (error) { codes = [record(error) && typeof error.code === "string" ? error.code : "unknown-template"]; }
      }
    }
  }
  // The kit requires even an unselected context gap to be visible. Retain the complete
  // server result map while giving every otherwise undrawn partial result a note.
  const bound = new Set(components.flatMap(c => record(c.result) && typeof c.result.path === "string" ? [c.result.path] : []));
  const gaps = results.filter(r => r.coverage !== "mapped" && !bound.has(`/results/${r.resultId}`));
  if (gaps.length) {
    const ids = gaps.map((r, i) => `context-gap-${i}`);
    children.push("context-gaps");
    components.push({ id: "context-gaps", component: "Section", title: LABELS.unknowns, children: ids },
      ...gaps.map((r, i) => ({ id: ids[i]!, component: "CoverageNote", result: { path: `/results/${r.resultId}` } })));
  }
  root.children = children;
  const model = { meta: input.meta, results: Object.fromEntries(results.map(r => [r.resultId, r])), receipts: input.receipts };
  const messages = [createSurface("near-answer"), updateDataModel("near-answer", "/", model), updateComponents("near-answer", components)];
  const verdict = validateSurface(messages, { resolveEvidence: receiptResolver(input.receipts.map(r => r.id)) });
  return { messages, codes: [...new Set([...codes, ...verdict.codes])] };
}
