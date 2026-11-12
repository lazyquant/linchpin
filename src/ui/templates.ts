/** View templates: stored component lists with bindings and no value. A panel is a template filled by results. */
import { createSurface, updateComponents, updateDataModel } from "./messages";
import { MAX_GRAPH_NODES } from "./graph-layout";
import { STRINGS } from "./strings";
import { UiRejected } from "./types";
import type { A2uiComponent, A2uiMessage, AnyResult, CoverageInput, Shape, SurfaceMeta } from "./types";

/**
 * In a stored component, `{result}` inside a binding path stands for the result id, `{n}` inside an id for the
 * position of the result, and `{title}` for the section title. `instantiate` replaces them.
 */
export interface ViewTemplate {
  id: string;
  version: string;
  title: string;
  description: string;
  accepts: Shape[];
  components: A2uiComponent[];
  /** For a template that takes several results: the components added for each one. */
  perResult?: { section: A2uiComponent; value: Record<Shape, A2uiComponent>; coverage: A2uiComponent };
}

const ROW_SHAPES: Shape[] = ["table", "chain", "path", "unknowns"];
const ALL_SHAPES: Shape[] = ["table", "chain", "path", "unknowns", "graph"];
const RESULT_PATH = "/results/{result}";
const COVERAGE_NOTE: A2uiComponent = { id: "c-{n}", component: "CoverageNote", result: { path: RESULT_PATH } };

function single(id: string, title: string, description: string, accepts: Shape[], component: string): ViewTemplate {
  const coverageOnly = component === "CoverageNote";
  return {
    id, version: "1", title, description, accepts,
    components: [
      { id: "root", component: "Column", children: [coverageOnly ? "c-0" : "v-0"] },
      { id: coverageOnly ? "c-0" : "v-0", component, result: { path: RESULT_PATH } },
    ],
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export const VIEW_TEMPLATES: readonly ViewTemplate[] = deepFreeze([
  single("fact-table", "Fact table", "Draws one result as a table with one row per result row and the provenance of each row.", ROW_SHAPES, "FactTable"),
  single("control-chain", "Control chain", "Draws a chain result as target, instruction, role, authority and controller for each row.", ["chain"], "ControlChain"),
  single("dependency-graph", "Dependency graph", "Draws a graph result as a drawing and as text lists of the same nodes and edges.", ["graph"], "DependencyGraph"),
  single("timeline", "Timeline", "Draws a table result that has a time column as entries in ascending order of time.", ["table"], "Timeline"),
  single("unknowns", "Unknowns", "Draws an unknowns result as a list of unresolved items with their provenance.", ["unknowns"], "UnknownList"),
  single("coverage", "Coverage", "Draws the coverage status of one result in words with its recorded notes.", ALL_SHAPES, "CoverageNote"),
  {
    id: "subject-panel", version: "1", title: "Subject panel",
    description: "Draws a subject header, then one titled section for each given result in the given order, with unknowns results last.",
    accepts: ALL_SHAPES,
    components: [
      { id: "root", component: "Column", children: ["header"] },
      { id: "header", component: "SubjectHeader", meta: { path: "/meta" } },
    ],
    perResult: {
      section: { id: "s-{n}", component: "Section", title: "{title}", children: [] },
      value: {
        table: { id: "v-{n}", component: "FactTable", result: { path: RESULT_PATH } },
        chain: { id: "v-{n}", component: "ControlChain", result: { path: RESULT_PATH } },
        path: { id: "v-{n}", component: "ValuePath", result: { path: RESULT_PATH } },
        graph: { id: "v-{n}", component: "DependencyGraph", result: { path: RESULT_PATH } },
        unknowns: { id: "v-{n}", component: "UnknownList", result: { path: RESULT_PATH } },
      },
      coverage: COVERAGE_NOTE,
    },
  },
]);

/** What a model or a caller needs to pick a template: id, title, accepted shapes and one sentence. */
export function listViewTemplates(): { id: string; title: string; accepts: Shape[]; description: string }[] {
  return VIEW_TEMPLATES.map(({ id, title, accepts, description }) => ({ id, title, accepts: [...accepts], description }));
}

const DEFAULT_TITLES: Record<Shape, string> = {
  table: STRINGS.sectionTable,
  chain: STRINGS.sectionChain,
  path: STRINGS.sectionPath,
  graph: STRINGS.sectionGraph,
  unknowns: STRINGS.sectionUnknowns,
};

function fill(stored: A2uiComponent, vars: { result: string; n: number; title: string }): A2uiComponent {
  const out: A2uiComponent = { id: stored.id.replace("{n}", String(vars.n)), component: stored.component };
  for (const [key, value] of Object.entries(stored)) {
    if (key === "id" || key === "component") continue;
    if (value === "{title}") out[key] = vars.title;
    else if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { path?: unknown }).path === "string") {
      out[key] = { ...(value as object), path: (value as { path: string }).path.replace("{result}", vars.result) };
    } else if (Array.isArray(value)) out[key] = [...value];
    else out[key] = value;
  }
  return out;
}

function hasTimeColumn(result: AnyResult): boolean {
  return result.shape === "table" && Array.isArray(result.columns) && result.columns.some((column) => column.role === "time");
}

/**
 * Fills a template. Returns exactly three messages: `createSurface`, `updateDataModel` (the whole model at `/`:
 * `meta`, `results` by id, and `coverage` when given) and `updateComponents`. Values are placed as given.
 */
export function instantiate(
  templateId: string,
  input: { surfaceId: string; meta: SurfaceMeta; results: AnyResult[]; titles?: Record<string, string>; coverage?: CoverageInput },
): A2uiMessage[] {
  const template = VIEW_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) throw new UiRejected("unknown-template");
  const results = input.results;
  const ids = new Set<string>();
  for (const result of results) {
    if (typeof result.resultId !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(result.resultId)) throw new UiRejected("bad-result-id");
    if (ids.has(result.resultId)) throw new UiRejected("duplicate-result");
    ids.add(result.resultId);
    if (!template.accepts.includes(result.shape)) throw new UiRejected("shape-not-accepted");
    if (template.id === "timeline" && !hasTimeColumn(result)) throw new UiRejected("shape-not-accepted");
    if (result.shape === "graph" && result.nodes.length > MAX_GRAPH_NODES) throw new UiRejected("graph-too-large");
  }
  if (!template.perResult && results.length !== 1) throw new UiRejected("result-count");

  const components: A2uiComponent[] = [];
  if (!template.perResult) {
    const result = results[0];
    const vars = { result: result.resultId, n: 0, title: "" };
    const value = fill(template.components[1], vars);
    const isNote = value.component === "CoverageNote";
    const children: string[] = [];
    const drawn: A2uiComponent[] = [];
    if (isNote || result.coverage !== "not-mapped") {
      children.push(value.id);
      drawn.push(value);
    }
    if (!isNote && result.coverage !== "mapped") {
      const note = fill(COVERAGE_NOTE, vars);
      children.push(note.id);
      drawn.push(note);
    }
    components.push({ ...fill(template.components[0], vars), children }, ...drawn);
  } else {
    const ordered = [...results.filter((result) => result.shape !== "unknowns"), ...results.filter((result) => result.shape === "unknowns")];
    const sections: A2uiComponent[] = [];
    const inner: A2uiComponent[] = [];
    ordered.forEach((result, n) => {
      const vars = { result: result.resultId, n, title: input.titles?.[result.resultId] ?? DEFAULT_TITLES[result.shape] };
      const children: string[] = [];
      if (result.coverage !== "not-mapped") {
        const value = fill(template.perResult!.value[result.shape], vars);
        children.push(value.id);
        inner.push(value);
      }
      if (result.coverage !== "mapped") {
        const note = fill(template.perResult!.coverage, vars);
        children.push(note.id);
        inner.push(note);
      }
      sections.push({ ...fill(template.perResult!.section, vars), children });
    });
    const [root, ...fixed] = template.components.map((stored) => fill(stored, { result: "", n: 0, title: "" }));
    components.push({ ...root, children: [...(root.children as string[]), ...sections.map((section) => section.id)] }, ...fixed, ...sections, ...inner);
  }

  const model: Record<string, unknown> = { meta: input.meta, results: Object.fromEntries(results.map((result) => [result.resultId, result])) };
  if (input.coverage !== undefined) model.coverage = input.coverage;
  return [createSurface(input.surfaceId), updateDataModel(input.surfaceId, "/", model), updateComponents(input.surfaceId, components)];
}
