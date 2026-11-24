/**
 * View templates of the second catalog, in their own registry. Each fills a fixed arrangement of components with
 * bindings and no value, and emits a surface that names `linchpin.evidence.v2`.
 */
import { CATALOG_V2, CLAIM_COLUMNS, GAP_REASONS, POSITION_COLUMNS } from "./catalog-v2";
import { A2UI_VERSION, updateComponents, updateDataModel } from "./messages";
import { STRINGS } from "./strings";
import { UiRejected } from "./types";
import type { A2uiComponent, A2uiMessage, AnyResultV2, CoverageInput, ReceiptRecord, ShapeV2, SurfaceMeta } from "./types";

export interface ViewTemplateV2 { id: string; version: string; title: string; description: string; accepts: ShapeV2[] }

/** What a GraphExplorer of the surface is opened on. */
export interface ExplorerInput { focus?: string; steps?: number; layers?: string[]; expanded?: string[] }

export interface TemplateInputV2 {
  surfaceId: string;
  meta: SurfaceMeta;
  results: AnyResultV2[];
  /** Section and disclosure titles by result id; `coverage` names the section of the mechanics. */
  titles?: Record<string, string>;
  coverage?: CoverageInput;
  receipts?: Record<string, ReceiptRecord>;
  explorer?: ExplorerInput;
  /** One plain sentence, for the templates that hold a Note. */
  note?: string;
}

const ALL: ShapeV2[] = ["table", "chain", "path", "unknowns", "graph", "changes"];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export const VIEW_TEMPLATES_V2: readonly ViewTemplateV2[] = deepFreeze([
  { id: "answer-panel", version: "1", title: "Answer panel", accepts: ALL,
    description: "Draws an answer header, then one titled section for each given result with unknowns last, and the query trace when the surface has one." },
  { id: "protocol-overview", version: "1", title: "Protocol overview", accepts: ["chain", "graph", "path", "table", "unknowns", "changes"],
    description: "Draws one titled section for each given result in the given order, each cut to its lead rows with its count, and the coverage of each mechanic." },
  { id: "protocol-control", version: "1", title: "Protocol control", accepts: ["chain", "table"],
    description: "Draws each chain result as a control chain inside a closed section with its row count, then each table result as a fact table." },
  { id: "protocol-unknowns", version: "1", title: "Protocol unknowns", accepts: ["unknowns"],
    description: "Draws the unresolved facts, then the coverage of each mechanic, then every further result as a list of named gaps with reasons." },
  { id: "position-sheet", version: "1", title: "Position sheet", accepts: ["graph", "chain", "table", "unknowns"],
    description: "Draws the observations of one position, the graph it rests on, the accounts that control it, its exit limits and the named gaps." },
  { id: "graph-explorer", version: "1", title: "Graph explorer", accepts: ["graph"],
    description: "Draws one graph result as an explorer opened on a focus, a number of steps and a set of layers." },
]);

/** What a model or a caller needs to pick a template: id, title, accepted shapes and one sentence. */
export function listViewTemplatesV2(): { id: string; title: string; accepts: ShapeV2[]; description: string }[] {
  return VIEW_TEMPLATES_V2.map(({ id, title, accepts, description }) => ({ id, title, accepts: [...accepts], description }));
}

const DEFAULT_TITLES: Record<ShapeV2, string> = {
  table: STRINGS.sectionTable, chain: STRINGS.sectionChain, path: STRINGS.sectionPath, graph: STRINGS.sectionGraph,
  unknowns: STRINGS.sectionUnknowns, changes: STRINGS.sectionChanges,
};

const columnsOf = (result: AnyResultV2): { name: string; role: string }[] => ("columns" in result && Array.isArray(result.columns) ? result.columns : []);
const hasColumns = (result: AnyResultV2, names: readonly string[]): boolean => names.every((name) => columnsOf(result).some((column) => column.name === name));

/** Whether every row of an unknowns result names a gap reason: such a result reads as a list of gaps. */
function isGapResult(result: AnyResultV2): boolean {
  return result.shape === "unknowns" && result.rows.length > 0 && result.rows.every((row) => GAP_REASONS.includes(row.reason ?? ""));
}

/** The value component a result is drawn with, by its shape and its columns. */
export function valueComponentFor(result: AnyResultV2): string {
  switch (result.shape) {
    case "chain": return "ControlChain";
    case "path": return "AnswerPath";
    case "graph": return "GraphExplorer";
    case "changes": return "ChangeList";
    case "unknowns": return isGapResult(result) ? "GapList" : "UnknownList";
    default:
      if (hasColumns(result, CLAIM_COLUMNS)) return "ClaimCheck";
      if (hasColumns(result, POSITION_COLUMNS)) return "PositionList";
      if (columnsOf(result).some((column) => column.role === "note") && columnsOf(result).some((column) => column.role === "status")) return "FindingList";
      return "FactTable";
  }
}

const pathOf = (result: AnyResultV2): string => `/results/${result.resultId}`;

/** Collects components; ids are given in order so the same input gives the same list. */
class Parts {
  readonly list: A2uiComponent[] = [];
  private n = 0;
  constructor(private readonly explorer: ExplorerInput | undefined) {}
  add(prefix: string, component: string, props: Record<string, unknown>): string {
    const id = `${prefix}-${this.n++}`;
    this.list.push({ id, component, ...props });
    return id;
  }
  /** The value component of a result, or its coverage note alone when the result is not mapped. Returns the ids. */
  value(result: AnyResultV2, component = valueComponentFor(result), extra: Record<string, unknown> = {}): string[] {
    const ids: string[] = [];
    if (result.coverage !== "not-mapped") {
      const props: Record<string, unknown> = { result: { path: pathOf(result) }, ...extra };
      if (component === "GraphExplorer" && this.explorer) {
        for (const key of ["focus", "steps", "layers", "expanded"] as const) if (this.explorer[key] !== undefined) props[key] = this.explorer[key];
      }
      ids.push(this.add("v", component, props));
    }
    if (result.coverage !== "mapped") ids.push(this.add("c", "CoverageNote", { result: { path: pathOf(result) } }));
    return ids;
  }
  section(title: string, children: string[]): string {
    return this.add("s", "Section", { title, children });
  }
}

/**
 * Fills a template of the second catalog. Returns exactly three messages: `createSurface`, `updateDataModel` (the
 * whole model at `/`: `meta`, `results` by id, and `coverage` and `receipts` when given) and `updateComponents`.
 */
export function instantiateV2(templateId: string, input: TemplateInputV2): A2uiMessage[] {
  const template = VIEW_TEMPLATES_V2.find((candidate) => candidate.id === templateId);
  if (!template) throw new UiRejected("unknown-template");
  const results = input.results;
  const seen = new Set<string>();
  for (const result of results) {
    if (typeof result.resultId !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(result.resultId)) throw new UiRejected("bad-result-id");
    if (seen.has(result.resultId)) throw new UiRejected("duplicate-result");
    seen.add(result.resultId);
    if (!template.accepts.includes(result.shape)) throw new UiRejected("shape-not-accepted");
  }
  if (template.id === "graph-explorer" && results.length !== 1) throw new UiRejected("result-count");

  const parts = new Parts(input.explorer);
  const titleOf = (result: AnyResultV2): string => input.titles?.[result.resultId] ?? DEFAULT_TITLES[result.shape];
  const mechanics = input.coverage?.mechanics ?? [];
  const mechanicNotes = (): string[] => mechanics.map((_, n) => parts.add("m", "CoverageNote", { coverage: { path: `/coverage/mechanics/${n}` } }));
  const root: string[] = [];

  if (template.id === "answer-panel") {
    root.push(parts.add("h", "AnswerHeader", { meta: { path: "/meta" } }));
    const ordered = [...results.filter((result) => result.shape !== "unknowns"), ...results.filter((result) => result.shape === "unknowns")];
    for (const result of ordered) root.push(parts.section(titleOf(result), parts.value(result)));
    if (input.meta.trace !== undefined) root.push(parts.add("t", "QueryTrace", { trace: { path: "/meta/trace" } }));
  } else if (template.id === "protocol-overview") {
    for (const result of results) root.push(parts.section(titleOf(result), parts.value(result)));
    if (mechanics.length > 0) root.push(parts.section(input.titles?.coverage ?? STRINGS.sectionCoverage, mechanicNotes()));
  } else if (template.id === "protocol-control") {
    for (const result of results.filter((candidate) => candidate.shape === "chain")) {
      const children = parts.value(result);
      const props: Record<string, unknown> = { title: titleOf(result), children };
      if (typeof result.total === "number" && result.coverage !== "not-mapped") props.count = { path: `${pathOf(result)}/total` };
      root.push(parts.add("d", "Disclosure", props));
    }
    for (const result of results.filter((candidate) => candidate.shape === "table")) {
      root.push(...parts.value(result, "FactTable", input.titles?.[result.resultId] !== undefined ? { title: input.titles[result.resultId] } : {}));
    }
  } else if (template.id === "protocol-unknowns") {
    results.forEach((result, at) => {
      root.push(...parts.value(result, at === 0 ? "UnknownList" : "GapList"));
      if (at === 0) root.push(...mechanicNotes());
    });
    if (results.length === 0) root.push(...mechanicNotes());
  } else if (template.id === "position-sheet") {
    const tables = results.filter((result) => result.shape === "table");
    if (tables.length > 0) root.push(...parts.value(tables[0], "FactTable"));
    if (typeof input.note === "string") root.push(parts.add("n", "Note", { text: input.note }));
    for (const result of results.filter((candidate) => candidate.shape === "graph")) root.push(parts.section(titleOf(result), parts.value(result)));
    for (const result of results.filter((candidate) => candidate.shape === "chain")) root.push(parts.section(titleOf(result), parts.value(result)));
    for (const result of tables.slice(1)) root.push(parts.section(titleOf(result), parts.value(result, "FactTable")));
    for (const result of results.filter((candidate) => candidate.shape === "unknowns")) root.push(...parts.value(result, "GapList"));
  } else {
    root.push(...parts.value(results[0], "GraphExplorer"));
  }

  const model: Record<string, unknown> = { meta: input.meta, results: Object.fromEntries(results.map((result) => [result.resultId, result])) };
  if (input.coverage !== undefined) model.coverage = input.coverage;
  if (input.receipts !== undefined) model.receipts = input.receipts;
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId: input.surfaceId, catalogId: CATALOG_V2.id } },
    updateDataModel(input.surfaceId, "/", model),
    updateComponents(input.surfaceId, [{ id: "root", component: "Column", children: root }, ...parts.list]),
  ];
}
