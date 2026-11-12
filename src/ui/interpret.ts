/**
 * Messages to a drawn tree of plain objects. Value components draw each row's provenance themselves: the bases as
 * words, the block or slot or the time, and the evidence ids. No prop switches that off.
 */
import { CATALOG } from "./catalog";
import { layoutGraph } from "./graph-layout";
import { isRecord, pointerGet, readSurface } from "./messages";
import type { SurfaceState } from "./messages";
import { CLASSES, STRINGS } from "./strings";
import { UiRejected } from "./types";
import type { GraphEdge, GraphNode, GraphResult, SurfaceTree, UiError, UiNode } from "./types";

const MAX_DRAWN = 600;

function el(tag: string, className: string, text?: string, children: UiNode[] = [], attrs: Record<string, string> = {}): UiNode {
  const node: UiNode = { tag, attrs: className ? { class: className, ...attrs } : { ...attrs }, children };
  if (text !== undefined) node.text = text;
  return node;
}

interface Ctx { state: SurfaceState; errors: UiError[]; stack: string[]; drawn: number; scope: unknown }

interface Row {
  rowKind: string;
  values: Record<string, unknown>;
  bases: string[];
  evidenceIds: string[];
  blockOrSlot: string | number | null;
  asOf: string | null;
  scopeSource: string | null;
}

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map(String) : []);
const blockOf = (value: unknown): string | number | null => (typeof value === "string" || typeof value === "number" ? value : null);

function asRow(raw: unknown): Row {
  const row = isRecord(raw) ? raw : {};
  return {
    rowKind: typeof row.rowKind === "string" ? row.rowKind : "",
    values: isRecord(row.values) ? row.values : {},
    bases: texts(row.bases),
    evidenceIds: texts(row.evidenceIds),
    blockOrSlot: blockOf(row.blockOrSlot),
    asOf: typeof row.asOf === "string" ? row.asOf : null,
    scopeSource: typeof row.scopeSource === "string" ? row.scopeSource : null,
  };
}

const isGap = (value: unknown): boolean => !(typeof value === "string" || typeof value === "number" || typeof value === "boolean") || value === "";
const cellText = (value: unknown): string => (isGap(value) ? STRINGS.notRecorded : String(value));
const MONO_ROLES = new Set(["subject", "address", "value", "amount", "time"]);

/** One value as a node. `unknown` and `none` are different words and carry different classes; a gap is said in words. */
function valueNode(tag: string, value: unknown, role: string | undefined, attrs: Record<string, string> = {}): UiNode {
  let className = "lk-value";
  if (role !== undefined && MONO_ROLES.has(role)) className += " lk-mono";
  if (value === STRINGS.unknown) className += ` ${CLASSES.unknown}`;
  else if (value === STRINGS.none) className += ` ${CLASSES.none}`;
  else if (isGap(value)) className += " lk-gap";
  return el(tag, className, cellText(value), [], attrs);
}

function basisNodes(bases: string[]): UiNode[] {
  return bases.map((basis) => el("span", basis === STRINGS.unknown ? `${CLASSES.basis} ${CLASSES.unknown}` : CLASSES.basis, basis));
}

/** The observation of a row: its block or slot, else its time, else the words that neither was recorded. */
function observationNodes(row: { blockOrSlot: string | number | null; asOf: string | null }, labelBlock: boolean): UiNode[] {
  if (row.blockOrSlot !== null) {
    const value = el("span", `${CLASSES.observation} lk-mono`, String(row.blockOrSlot));
    return labelBlock ? [el("span", "lk-obs-label", STRINGS.blockOrSlot), value] : [value];
  }
  if (row.asOf !== null) return [el("span", "lk-obs-label", STRINGS.asOf), el("span", `${CLASSES.observation} lk-mono`, row.asOf)];
  const gap = el("span", `${CLASSES.observation} lk-gap`, STRINGS.notRecorded);
  return labelBlock ? [el("span", "lk-obs-label", STRINGS.blockOrSlot), gap] : [gap];
}

/** The evidence chip, a native disclosure listing the row's evidence ids, or the words "no evidence". */
function evidenceNode(evidenceIds: string[]): UiNode {
  if (evidenceIds.length === 0) return el("span", CLASSES.noEvidence, STRINGS.noEvidence);
  return el("details", CLASSES.chip, undefined, [
    el("summary", "lk-chip-summary", STRINGS.evidence, [el("span", "lk-count", String(evidenceIds.length))]),
    ...evidenceIds.map((id) => el("code", CLASSES.evidenceId, id)),
  ]);
}

const scopeNode = (row: Row): UiNode => el("span", CLASSES.scope, STRINGS.scope(row.scopeSource ?? STRINGS.notRecorded));

/** Provenance for a row drawn outside a table. */
function provenance(row: Row): UiNode {
  if (row.rowKind === "scope") return el("div", "lk-prov", undefined, [scopeNode(row)]);
  return el("div", "lk-prov", undefined, [
    el("span", "lk-bases", undefined, [el("span", "lk-obs-label", STRINGS.basis), ...basisNodes(row.bases)]),
    el("span", "lk-obs-group", undefined, observationNodes(row, true)),
    evidenceNode(row.evidenceIds),
  ]);
}

/** Whether the word `unknown` has to be added to an unknown row: only when nothing drawn in it holds the word. */
function unknownWord(row: Row, drawn: unknown[]): UiNode[] {
  if (row.rowKind !== "unknown") return [];
  const held = [...drawn.map(cellText), ...row.bases].some((text) => /(^|[^a-z])unknown($|[^a-z])/i.test(text));
  return held ? [] : [el("span", `lk-unknown-word ${CLASSES.unknown}`, STRINGS.unknown)];
}

const rowClass = (row: Row, extra = ""): string =>
  [CLASSES.row, row.rowKind === "unknown" ? CLASSES.unknown : "", row.rowKind === "scope" ? "lk-row-scope" : "", extra].filter(Boolean).join(" ");

function pair(label: string, value: unknown, role?: string): UiNode {
  return el("span", "lk-pair", undefined, [el("span", "lk-pair-label", label), valueNode("span", value, role)]);
}

interface Columns { name: string; role: string | undefined }
function columnsOf(result: Record<string, unknown>): Columns[] {
  const list = Array.isArray(result.columns) ? result.columns : [];
  return list.filter(isRecord).filter((column) => typeof column.name === "string").map((column) => ({ name: column.name as string, role: typeof column.role === "string" ? column.role : undefined }));
}
const rowsOf = (result: Record<string, unknown>): Row[] => (Array.isArray(result.rows) ? result.rows.map(asRow) : []);

function notes(result: Record<string, unknown>, rows: Row[], emptyText: string = STRINGS.noRows): UiNode[] {
  const out: UiNode[] = [];
  if (rows.length === 0) out.push(el("p", "lk-empty", emptyText));
  if (result.truncated === true) out.push(el("p", "lk-truncated", STRINGS.truncated));
  return out;
}

function gapBox(): UiNode {
  return el("p", "lk-empty lk-gap", STRINGS.notRecorded);
}

/* ---------- bindings ---------- */

function fail(ctx: Ctx, code: string, componentId: string | null, message: string): void {
  ctx.errors.push({ code, componentId, message });
}

/** The value a binding names: an absolute pointer into the data model, or a relative one into the template element. */
function bound(ctx: Ctx, componentId: string, value: unknown): unknown {
  if (!isRecord(value) || typeof value.path !== "string") {
    fail(ctx, "literal-value", componentId, "a bound prop holds no binding");
    return undefined;
  }
  const found = value.path.startsWith("/") ? pointerGet(ctx.state.model, value.path) : pointerGet(ctx.scope, `/${value.path}`);
  if (found === undefined) fail(ctx, "dangling-binding", componentId, "a binding names nothing in the data model");
  return found;
}

function boundResult(ctx: Ctx, component: Record<string, unknown>, shapes: readonly string[]): Record<string, unknown> | null {
  const id = component.id as string;
  const result = bound(ctx, id, component.result);
  if (result === undefined) return null;
  if (!isRecord(result) || !shapes.includes(result.shape as string)) {
    fail(ctx, "dangling-binding", id, "the bound value is not a result this component draws");
    return null;
  }
  return result;
}

/* ---------- components ---------- */

/** A provenance cell of a table row. Its label is repeated on the cell, for the stacked layout of a narrow screen. */
function provCell(label: string, children: UiNode[], attrs: Record<string, string> = {}): UiNode {
  return el("td", "lk-prov-cell", undefined, [el("span", "lk-cell-body", undefined, children)], { ...attrs, "data-label": label });
}

function drawFactTable(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const out: UiNode[] = [];
  if (typeof component.title === "string") out.push(el("h3", "lk-title", component.title));
  const result = boundResult(ctx, component, ["table", "chain", "path", "unknowns"]);
  if (!result) return el("div", "lk-facts", undefined, [...out, gapBox()]);
  let columns = columnsOf(result);
  if (Array.isArray(component.columns)) {
    const chosen: Columns[] = [];
    for (const name of component.columns) {
      const column = columns.find((candidate) => candidate.name === name);
      if (column) chosen.push(column);
      else fail(ctx, "dangling-binding", component.id as string, "a chosen column is not a column of the result");
    }
    columns = chosen;
  }
  const rows = rowsOf(result);
  if (rows.length > 0) {
    const head = el("thead", "", undefined, [el("tr", "", undefined, [
      ...columns.map((column) => el("th", "", column.name, [], { scope: "col" })),
      el("th", "lk-prov-head", STRINGS.basis, [], { scope: "col" }),
      el("th", "lk-prov-head", STRINGS.blockOrSlot, [], { scope: "col" }),
      el("th", "lk-prov-head", STRINGS.evidence, [], { scope: "col" }),
    ])]);
    const body = el("tbody", "", undefined, rows.map((row) => {
      const cells = columns.map((column) => el("td", "", undefined, [valueNode("span", row.values[column.name], column.role)], { "data-label": column.name }));
      if (row.rowKind === "scope") {
        return el("tr", rowClass(row), undefined, [...cells, provCell(STRINGS.basis, [scopeNode(row)], { colspan: "3" })]);
      }
      return el("tr", rowClass(row), undefined, [
        ...cells,
        provCell(STRINGS.basis, [...unknownWord(row, columns.map((column) => row.values[column.name])), ...basisNodes(row.bases)]),
        provCell(STRINGS.blockOrSlot, observationNodes(row, false)),
        provCell(STRINGS.evidence, [evidenceNode(row.evidenceIds)]),
      ]);
    }));
    out.push(el("table", "lk-table", undefined, [head, body]));
  }
  return el("div", "lk-facts", undefined, [...out, ...notes(result, rows)]);
}

const CHAIN_STEPS = [
  ["target", STRINGS.target], ["instruction", STRINGS.instruction], ["role", STRINGS.role],
  ["authority", STRINGS.authority], ["controller", STRINGS.controller],
] as const;

function drawControlChain(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const result = boundResult(ctx, component, ["chain"]);
  if (!result) return el("div", "lk-chain-wrap", undefined, [gapBox()]);
  const roles = new Map(columnsOf(result).map((column) => [column.name, column.role]));
  const rows = rowsOf(result);
  const items = rows.map((row) => {
    const steps = CHAIN_STEPS.map(([name, label]) => {
      const value = row.values[name];
      return isGap(value)
        ? el("span", "lk-pair", undefined, [el("span", "lk-pair-label", label), el("span", "lk-value lk-gap", STRINGS.notMapped)])
        : pair(label, value, roles.get(name) ?? "address");
    });
    if (!isGap(row.values.threshold)) steps.push(pair(STRINGS.threshold, row.values.threshold, "amount"));
    return el("li", rowClass(row), undefined, [
      el("div", "lk-steps", undefined, [...steps, ...unknownWord(row, CHAIN_STEPS.map(([name]) => row.values[name]))]),
      provenance(row),
    ]);
  });
  return el("div", "lk-chain-wrap", undefined, [...(rows.length > 0 ? [el("ol", "lk-chain", undefined, items)] : []), ...notes(result, rows)]);
}

function drawValuePath(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const result = boundResult(ctx, component, ["path"]);
  if (!result) return el("div", "lk-path-wrap", undefined, [gapBox()]);
  const rows = rowsOf(result);
  const items = rows.map((row) => {
    const link = [pair(STRINGS.from, row.values.from, "address"), pair(STRINGS.to, row.values.to, "address")];
    const extra: UiNode[] = [];
    if (!isGap(row.values.amount)) extra.push(pair(STRINGS.amount, row.values.amount, "amount"));
    if (!isGap(row.values.unit)) extra.push(pair(STRINGS.unit, row.values.unit));
    if (!isGap(row.values.window)) extra.push(pair(STRINGS.window, row.values.window));
    return el("li", rowClass(row, row.bases.includes("claimed") ? "lk-link-claimed" : ""), undefined, [
      el("div", "lk-steps", undefined, [...link, ...unknownWord(row, [row.values.from, row.values.to])]),
      ...(extra.length > 0 ? [el("div", "lk-pairs", undefined, extra)] : []),
      provenance(row),
    ]);
  });
  return el("div", "lk-path-wrap", undefined, [...(rows.length > 0 ? [el("ol", "lk-path", undefined, items)] : []), ...notes(result, rows)]);
}

function drawUnknownList(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const result = boundResult(ctx, component, ["unknowns"]);
  if (!result) return el("div", "lk-unknowns-wrap", undefined, [gapBox()]);
  const columns = columnsOf(result);
  const rows = rowsOf(result);
  const items = rows.map((row) => {
    const unknownRow: Row = { ...row, rowKind: row.rowKind === "scope" ? "scope" : "unknown" };
    return el("li", rowClass(unknownRow, row.rowKind === "scope" ? CLASSES.unknown : ""), undefined, [
      el("div", "lk-pairs", undefined, [
        ...columns.map((column) => pair(column.name, row.values[column.name], column.role)),
        ...unknownWord({ ...row, rowKind: "unknown" }, columns.map((column) => row.values[column.name])),
      ]),
      provenance(row),
    ]);
  });
  return el("div", "lk-unknowns-wrap", undefined, [...(rows.length > 0 ? [el("ul", "lk-unknowns", undefined, items)] : []), ...notes(result, rows)]);
}

/**
 * The order of a Timeline. A time value is read for ordering only; what is drawn stays the value as it was given.
 * Four classes, in this order: numbers (a number, or a string of digits with an optional sign and fraction, such as
 * a block or slot), compared by value; dates (a string in ISO 8601 form, read as UTC when it names no offset),
 * compared by instant; any other text, compared by code unit; and a value that is not recorded, last. Values of
 * different classes keep the order of their classes, and equal values keep the order of the rows.
 */
type TimeKey = { rank: 0; value: bigint | number } | { rank: 1; value: number } | { rank: 2; value: string } | { rank: 3 };

const NUMERIC_TIME = /^[+-]?[0-9]+(\.[0-9]+)?$/;
const ISO_TIME = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ]([0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?)(Z|[+-][0-9]{2}:[0-9]{2})?)?$/;

function timeKey(value: unknown): TimeKey {
  if (isGap(value)) return { rank: 3 };
  if (typeof value === "number" && Number.isFinite(value)) return { rank: 0, value };
  const text = String(value);
  if (typeof value === "string" && NUMERIC_TIME.test(text)) {
    return { rank: 0, value: /^[+-]?[0-9]+$/.test(text) ? BigInt(text) : Number(text) };
  }
  const iso = typeof value === "string" ? ISO_TIME.exec(text) : null;
  if (iso) {
    const instant = Date.parse(iso[2] === undefined ? iso[1] : `${iso[1]}T${iso[2]}${iso[3] ?? "Z"}`);
    if (!Number.isNaN(instant)) return { rank: 1, value: instant };
  }
  return { rank: 2, value: text };
}

function compareTimeKeys(a: TimeKey, b: TimeKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank === 3 || b.rank === 3) return 0;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

function drawTimeline(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const result = boundResult(ctx, component, ["table"]);
  const columns = result ? columnsOf(result) : [];
  const timeColumn = columns.find((column) => column.role === "time");
  if (!result || !timeColumn) {
    if (result) fail(ctx, "dangling-binding", component.id as string, "the result has no column of role time");
    return el("div", "lk-timeline-wrap", undefined, [gapBox()]);
  }
  const others = columns.filter((column) => column !== timeColumn);
  const rows = rowsOf(result)
    .map((row, at) => ({ row, at, key: timeKey(row.values[timeColumn.name]) }))
    .sort((a, b) => compareTimeKeys(a.key, b.key) || a.at - b.at);
  const items = rows.map(({ row }) =>
    el("li", rowClass(row), undefined, [
      el("div", "lk-time", undefined, [el("span", "lk-pair-label", timeColumn.name), valueNode("span", row.values[timeColumn.name], "time")]),
      el("div", "lk-pairs", undefined, [
        ...others.map((column) => pair(column.name, row.values[column.name], column.role)),
        ...unknownWord(row, columns.map((column) => row.values[column.name])),
      ]),
      provenance(row),
    ]),
  );
  return el("div", "lk-timeline-wrap", undefined, [...(rows.length > 0 ? [el("ol", "lk-timeline", undefined, items)] : []), ...notes(result, rows.map(({ row }) => row))]);
}

const COVERAGE_WORDS: Record<string, [string, string]> = {
  mapped: [STRINGS.mapped, "lk-coverage-mapped"],
  partial: [STRINGS.partlyMapped, "lk-coverage-partial"],
  "not-mapped": [STRINGS.notMapped, "lk-coverage-not-mapped"],
};

function drawCoverageNote(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const id = component.id as string;
  const fromResult = Object.prototype.hasOwnProperty.call(component, "result");
  const source = bound(ctx, id, fromResult ? component.result : component.coverage);
  if (!isRecord(source)) {
    if (source !== undefined) fail(ctx, "dangling-binding", id, "the bound value holds no coverage");
    return el("aside", "lk-coverage", undefined, [gapBox()]);
  }
  const status = fromResult ? source.coverage : source.status;
  const [word, className] = COVERAGE_WORDS[typeof status === "string" ? status : ""] ?? [STRINGS.notRecorded, "lk-coverage-gap"];
  const head = [el("span", "lk-pair-label", STRINGS.coverage), el("span", "lk-coverage-status", word)];
  if (!fromResult) head.push(pair(STRINGS.mechanic, source.mechanic));
  const lines = fromResult ? texts(source.coverageNotes) : typeof source.note === "string" && source.note !== "" ? [source.note] : [];
  return el("aside", `lk-coverage ${className}`, undefined, [el("p", "lk-coverage-head", undefined, head), ...lines.map((line) => el("p", "lk-coverage-note", line))]);
}

function metaItem(label: string, children: UiNode[]): UiNode {
  return el("div", "lk-meta-item", undefined, [el("dt", "", label), el("dd", "", undefined, children)]);
}
function idList(ids: string[]): UiNode[] {
  return ids.length > 0 ? ids.map((id) => el("span", "lk-id", id)) : [el("span", "lk-gap", STRINGS.notRecorded)];
}
function rangeNodes(from: string | number | null, to: string | number | null): UiNode[] {
  const low = from ?? to;
  const high = to ?? from;
  if (low === null || high === null) return [el("span", "lk-gap", STRINGS.notRecorded)];
  return [el("span", "lk-mono", String(low) === String(high) ? String(low) : `${low} ${STRINGS.rangeTo} ${high}`)];
}
const timeNodes = (time: unknown): UiNode[] => [typeof time === "string" && time !== "" ? el("span", "lk-mono", time) : el("span", "lk-gap", STRINGS.notRecorded)];

function drawSubjectHeader(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const found = bound(ctx, component.id as string, component.meta);
  const meta = isRecord(found) ? found : {};
  const subjectId = typeof meta.subjectId === "string" && meta.subjectId !== "" ? meta.subjectId : null;
  const title = typeof meta.title === "string" && meta.title !== "" ? meta.title : subjectId;
  const eyebrow: UiNode[] = [];
  if (typeof meta.kind === "string" && meta.kind !== "") eyebrow.push(el("span", "lk-pair-label", STRINGS.kind), el("span", "lk-kind", meta.kind));
  if (meta.constructed === true) eyebrow.push(el("span", CLASSES.constructed, STRINGS.constructed));
  return el("header", "lk-header", undefined, [
    ...(eyebrow.length > 0 ? [el("p", "lk-eyebrow", undefined, eyebrow)] : []),
    el("h1", title === null ? "lk-gap" : "", title ?? STRINGS.notRecorded),
    el("p", "lk-subject-id", undefined, [el("span", "lk-pair-label", STRINGS.subject), subjectId === null ? el("span", "lk-gap", STRINGS.notRecorded) : el("span", "lk-id", subjectId)]),
    el("dl", "lk-meta", undefined, [
      metaItem(STRINGS.snapshot, idList(texts(meta.snapshotIds))),
      metaItem(STRINGS.blockOrSlot, rangeNodes(blockOf(meta.fromBlockOrSlot), blockOf(meta.toBlockOrSlot))),
      metaItem(STRINGS.captured, timeNodes(meta.capturedAt)),
    ]),
  ]);
}

/** The block range and the latest time over every result some component of the surface binds. */
function observedOverSurface(ctx: Ctx): { from: string | number | null; to: string | number | null; latest: string | null } {
  const blocks: (string | number)[] = [];
  let latest: string | null = null;
  const seen = new Set<string>();
  for (const component of ctx.state.components.values()) {
    const binding = component.result;
    if (!isRecord(binding) || typeof binding.path !== "string" || seen.has(binding.path)) continue;
    seen.add(binding.path);
    const result = pointerGet(ctx.state.model, binding.path);
    if (!isRecord(result)) continue;
    const items = Array.isArray(result.rows) ? result.rows : Array.isArray(result.edges) ? result.edges : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const block = blockOf(item.blockOrSlot);
      if (block !== null) blocks.push(block);
      if (typeof item.asOf === "string" && (latest === null || item.asOf > latest)) latest = item.asOf;
    }
  }
  if (blocks.length === 0) return { from: null, to: null, latest };
  let from = blocks[0];
  let to = blocks[0];
  if (blocks.every((block) => /^[0-9]+$/.test(String(block)))) {
    for (const block of blocks) {
      if (BigInt(block) < BigInt(from)) from = block;
      if (BigInt(block) > BigInt(to)) to = block;
    }
  } else {
    const sorted = [...blocks].map(String).sort();
    from = sorted[0];
    to = sorted[sorted.length - 1];
  }
  return { from, to, latest };
}

function drawAnswerHeader(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const found = bound(ctx, component.id as string, component.meta);
  const meta = isRecord(found) ? found : {};
  const question = typeof meta.question === "string" && meta.question !== "" ? meta.question : null;
  const over = observedOverSurface(ctx);
  return el("header", "lk-header", undefined, [
    el("p", "lk-eyebrow", undefined, [el("span", "lk-pair-label", STRINGS.question)]),
    el("h1", question === null ? "lk-gap" : "", question ?? STRINGS.notRecorded),
    el("dl", "lk-meta", undefined, [
      metaItem(STRINGS.protocol, [typeof meta.protocolTitle === "string" && meta.protocolTitle !== "" ? el("span", "", meta.protocolTitle) : el("span", "lk-gap", STRINGS.notRecorded)]),
      metaItem(STRINGS.snapshot, idList(texts(meta.snapshotIds))),
      metaItem(STRINGS.blockOrSlot, rangeNodes(over.from, over.to)),
      metaItem(STRINGS.latestAsOf, timeNodes(over.latest)),
    ]),
    el("p", "lk-recorded", STRINGS.recorded),
  ]);
}

function asGraph(result: Record<string, unknown>): GraphResult {
  const nodes: GraphNode[] = (Array.isArray(result.nodes) ? result.nodes : []).filter(isRecord).filter((node) => typeof node.id === "string")
    .map((node) => ({ id: node.id as string, label: typeof node.label === "string" && node.label !== "" ? node.label : (node.id as string), isolated: node.isolated === true }));
  const edges: GraphEdge[] = (Array.isArray(result.edges) ? result.edges : []).filter(isRecord).map((edge, at) => ({
    key: typeof edge.key === "string" ? edge.key : String(at),
    from: typeof edge.from === "string" ? edge.from : "",
    to: typeof edge.to === "string" ? edge.to : "",
    relation: typeof edge.relation === "string" ? edge.relation : "",
    factIds: texts(edge.factIds),
    bases: texts(edge.bases),
    evidenceIds: texts(edge.evidenceIds),
    blockOrSlot: blockOf(edge.blockOrSlot),
    asOf: typeof edge.asOf === "string" ? edge.asOf : null,
  }));
  return { resultId: "", shape: "graph", coverage: "mapped", coverageNotes: [], nodes, edges, truncated: result.truncated === true };
}

function drawDependencyGraph(ctx: Ctx, component: Record<string, unknown>): UiNode {
  const id = component.id as string;
  const result = boundResult(ctx, component, ["graph"]);
  if (!result) return el("figure", "lk-graph", undefined, [gapBox()]);
  const graph = asGraph(result);
  const layout = layoutGraph(graph);
  const known = new Set(layout.nodes.map((node) => node.id));
  const drawnEdges = graph.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
  if (drawnEdges.length !== graph.edges.length) fail(ctx, "dangling-binding", id, "a graph edge ends at no node");
  const isolated = new Set(graph.nodes.filter((node) => node.isolated).map((node) => node.id));
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));

  const children: UiNode[] = [];
  if (layout.nodes.length === 0) children.push(el("p", "lk-empty", STRINGS.noNodes));
  else {
    const marks: UiNode[] = [];
    layout.edges.forEach((edge, at) => {
      const source = drawnEdges[at];
      const dashed = source.bases.includes(STRINGS.unknown) ? " lk-edge-unknown" : "";
      marks.push(el("path", `${CLASSES.graphEdge}${dashed}`, undefined, [el("title", "", `${source.relation}: ${source.bases.join(", ")}`)], { d: edge.d }));
      marks.push(el("polygon", `lk-graph-arrow${dashed}`, undefined, [], { points: edge.arrow }));
    });
    for (const node of layout.nodes) {
      const x = String(node.x + 12);
      marks.push(el("g", isolated.has(node.id) ? `${CLASSES.graphNode} lk-node-isolated` : CLASSES.graphNode, undefined, [
        el("title", "", node.id),
        el("rect", "", undefined, [], { x: String(node.x), y: String(node.y), width: String(node.width), height: String(node.height), rx: "2" }),
        el("text", "", undefined, node.lines.map((line, at) => el("tspan", "", line, [], at === 0 ? { x } : { x, dy: "16" })), { x, y: String(node.y + 22) }),
      ]));
    }
    children.push(el("div", "lk-graph-frame", undefined, [
      el("svg", "lk-graph-svg", undefined, marks, {
        viewBox: `0 0 ${layout.width} ${layout.height}`, width: String(layout.width), height: String(layout.height), role: "img", "aria-label": STRINGS.graphLabel,
      }),
    ]));
  }
  children.push(el("p", "lk-list-label", STRINGS.graphNodes, [el("span", "lk-count", String(layout.nodes.length))]));
  children.push(el("ul", "lk-graph-nodes", undefined, layout.nodes.map((node) => el("li", isolated.has(node.id) ? "lk-node-isolated" : "", undefined, [
    el("span", "lk-id", node.id),
    ...(labels.get(node.id) !== node.id ? [el("span", "lk-node-label", labels.get(node.id) ?? "")] : []),
    ...(isolated.has(node.id) ? [el("span", "lk-isolated", STRINGS.isolated)] : []),
  ]))));
  children.push(el("p", "lk-list-label", STRINGS.graphEdges, [el("span", "lk-count", String(graph.edges.length))]));
  if (graph.edges.length === 0) children.push(el("p", "lk-empty", STRINGS.noEdges));
  children.push(el("ul", "lk-graph-edges", undefined, graph.edges.map((edge) => {
    const row: Row = { rowKind: "fact", values: {}, bases: edge.bases, evidenceIds: edge.evidenceIds, blockOrSlot: edge.blockOrSlot, asOf: edge.asOf, scopeSource: null };
    return el("li", CLASSES.row, undefined, [
      el("div", "lk-edge", undefined, [el("span", "lk-id", edge.from), el("span", "lk-relation", edge.relation), el("span", "lk-id", edge.to)]),
      provenance(row),
    ]);
  })));
  if (graph.truncated) children.push(el("p", "lk-truncated", STRINGS.truncated));
  return el("figure", "lk-graph", undefined, children);
}

function drawChildren(ctx: Ctx, component: Record<string, unknown>): UiNode[] {
  const children = component.children;
  if (Array.isArray(children)) return children.flatMap((child) => (typeof child === "string" ? draw(ctx, child) : []));
  if (isRecord(children) && typeof children.path === "string" && typeof children.componentId === "string") {
    const list = bound(ctx, component.id as string, { path: children.path });
    if (!Array.isArray(list)) return [];
    const outer = ctx.scope;
    const out = list.flatMap((item) => {
      ctx.scope = item;
      return draw(ctx, children.componentId as string);
    });
    ctx.scope = outer;
    return out;
  }
  return [];
}

function draw(ctx: Ctx, id: string): UiNode[] {
  const component = ctx.state.components.get(id) as Record<string, unknown> | undefined;
  if (!component) {
    fail(ctx, "structure", id, "a child id names no component");
    return [];
  }
  if (ctx.stack.includes(id)) {
    fail(ctx, "structure", id, "the components form a cycle");
    return [];
  }
  if (++ctx.drawn > MAX_DRAWN) {
    if (ctx.drawn === MAX_DRAWN + 1) fail(ctx, "structure", id, "the surface draws too many components");
    return [];
  }
  const name = component.component as string;
  if (!Object.prototype.hasOwnProperty.call(CATALOG.components, name)) {
    fail(ctx, "unknown-component", id, "the component is not in the catalog");
    return [el("div", CLASSES.unsupported, STRINGS.unsupported)];
  }
  ctx.stack.push(id);
  try {
    switch (name) {
      case "Column": return [el("div", "lk-column", undefined, drawChildren(ctx, component))];
      case "Section": {
        const title = typeof component.title === "string" && component.title !== "" ? component.title : null;
        return [el("section", "lk-section", undefined, [el("h2", title === null ? "lk-gap" : "", title ?? STRINGS.notRecorded), ...drawChildren(ctx, component)])];
      }
      case "Note": return typeof component.text === "string" ? [el("p", "lk-note", component.text)] : [];
      case "SubjectHeader": return [drawSubjectHeader(ctx, component)];
      case "AnswerHeader": return [drawAnswerHeader(ctx, component)];
      case "FactTable": return [drawFactTable(ctx, component)];
      case "ControlChain": return [drawControlChain(ctx, component)];
      case "ValuePath": return [drawValuePath(ctx, component)];
      case "UnknownList": return [drawUnknownList(ctx, component)];
      case "Timeline": return [drawTimeline(ctx, component)];
      case "CoverageNote": return [drawCoverageNote(ctx, component)];
      case "DependencyGraph": return [drawDependencyGraph(ctx, component)];
      default: return [el("div", CLASSES.unsupported, STRINGS.unsupported)];
    }
  } finally {
    ctx.stack.pop();
  }
}

/**
 * Applies the messages in order and draws the surface: one `main` holding what the component `root` draws.
 * Malformed input never throws; it leaves entries in `errors`. The one refusal is a graph result over the node
 * limit, which throws `UiRejected("graph-too-large")`.
 */
export function interpret(messages: unknown): SurfaceTree {
  const errors: UiError[] = [];
  const root: UiNode = el("main", CLASSES.surface);
  let state: SurfaceState;
  try {
    state = readSurface(messages);
  } catch {
    errors.push({ code: "schema", componentId: null, message: "the messages could not be read" });
    return { surfaceId: null, deleted: false, root, errors };
  }
  if (!Array.isArray(messages)) errors.push({ code: "schema", componentId: null, message: "the messages are not a list" });
  if (!state.deleted) {
    const ctx: Ctx = { state, errors, stack: [], drawn: 0, scope: undefined };
    try {
      if (state.components.has("root")) root.children = draw(ctx, "root");
      else if (Array.isArray(messages)) errors.push({ code: "structure", componentId: null, message: "no component with id root" });
    } catch (error) {
      if (error instanceof UiRejected) throw error;
      root.children = [];
      errors.push({ code: "schema", componentId: null, message: "the surface could not be drawn" });
    }
  }
  return { surfaceId: state.surfaceId, deleted: state.deleted, root, errors };
}
