/**
 * From the app's data to A2UI surfaces of the second catalog. Every function returns messages; nothing here draws.
 * One tab is one surface. The same data gives the same messages, in Bun and on the page.
 */
import { CATALOG_V2 } from "../../ui/catalog-v2";
import { A2UI_VERSION, updateComponents, updateDataModel } from "../../ui/messages";
import { instantiateV2, type ExplorerInput } from "../../ui/templates-v2";
import type { A2uiComponent, A2uiMessage, AnyResultV2, ChangesResult, GraphResult, ReceiptRecord, ResultRow, ResultSet, SurfaceMeta } from "../../ui/types";
import { RESULT, findSeries, type AppData, type PackData, type ReadData, type SeriesData, type TabId } from "./model";
import { APP_STRINGS as S, LAYERS } from "./strings";

/** What the page has chosen on an explorer: state of the page, placed into the surface as literal props. */
export interface ExplorerView { focus: string; steps: number; layers: string[]; expanded: string[] }

/** The most receipt cards one drawer surface holds. */
export const MAX_DRAWER_RECEIPTS = 24;
const LEAD_ROWS = 3;

function surface(surfaceId: string, model: Record<string, unknown>, components: A2uiComponent[]): A2uiMessage[] {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: CATALOG_V2.id } },
    updateDataModel(surfaceId, "/", model),
    updateComponents(surfaceId, components),
  ];
}
const column = (children: string[]): A2uiComponent => ({ id: "root", component: "Column", children });
const bind = (result: AnyResultV2): { path: string } => ({ path: `/results/${result.resultId}` });
const byId = (results: AnyResultV2[]): Record<string, AnyResultV2> => Object.fromEntries(results.map((result) => [result.resultId, result]));

const isConstructed = (result: AnyResultV2): boolean =>
  result.constructed === true || (result.shape !== "graph" && (result.rows as { constructed?: true }[]).some((row) => row.constructed === true));

/** The meta of a tab: the series' own, without its capture list, and marked constructed when a result on it is. */
function metaOf(series: SeriesData, results: AnyResultV2[]): SurfaceMeta {
  const { captures: _captures, ...meta } = series.meta;
  return results.some(isConstructed) ? { ...meta, constructed: true } : meta;
}

function lead<T extends ResultSet | ChangesResult>(result: T, resultId: string): T {
  return { ...result, resultId, rows: result.rows.slice(0, LEAD_ROWS), truncated: result.rows.length > LEAD_ROWS, total: result.rows.length };
}
const emptyUnknowns = (resultId: string): ResultSet => ({ resultId, shape: "unknowns", columns: [], coverage: "mapped", coverageNotes: [], rows: [], truncated: false, total: 0 });

/** Every chain row of the Control tab in tab order, the rows about the series' subject first. */
export function controlLead(series: SeriesData): ResultSet {
  const groups = series.controlGroups.map((group) => series.results[group.resultId] as ResultSet);
  const rows = groups.flatMap((group) => group.rows);
  const own = (row: ResultRow): number => (row.values.target === series.focus ? 0 : 1);
  const ordered = [...rows].sort((a, b) => own(a) - own(b));
  return { resultId: "who", shape: "chain", columns: groups[0]?.columns ?? [], coverage: "mapped", coverageNotes: [], rows: ordered, truncated: false, total: ordered.length };
}

/** A still preview of the graph: the subject and the first edges that name it. Its total is that of the whole graph. */
export function graphLead(series: SeriesData): GraphResult {
  const graph = series.results[RESULT.graph] as GraphResult;
  const naming = [...graph.edges.filter((edge) => edge.from === series.focus), ...graph.edges.filter((edge) => edge.to === series.focus && edge.from !== series.focus)].slice(0, LEAD_ROWS);
  const ids = new Set<string>([series.focus, ...naming.flatMap((edge) => [edge.from, edge.to])]);
  return { ...graph, resultId: "rests", nodes: graph.nodes.filter((node) => ids.has(node.id)), edges: naming, truncated: graph.edges.length > naming.length, total: graph.edges.length };
}

/** The first gap rows of a series as their own result, for a view that has nothing else to show. */
function gapsLead(series: SeriesData, resultId: string): ResultSet {
  const gaps = series.results[RESULT.gaps] as ResultSet | undefined;
  return gaps ? lead(gaps, resultId) : emptyUnknowns(resultId);
}

export function headerSurface(_data: AppData, pack: PackData, series: SeriesData): A2uiMessage[] {
  return surface(`header-${pack.id}-${series.id}`, { meta: series.meta, results: {} }, [
    column(["header", "captures"]),
    { id: "header", component: "SubjectHeader", meta: { path: "/meta" } },
    { id: "captures", component: "CaptureList", captures: { path: "/meta/captures" } },
  ]);
}

export function indexSurface(_data: AppData, pack: PackData): A2uiMessage[] {
  return surface(`index-${pack.id}`, { meta: { snapshotIds: pack.index.rows.flatMap((row) => row.snapshotIds) }, results: byId([pack.index]) }, [
    column(["counts"]),
    { id: "counts", component: "FactTable", result: bind(pack.index) },
  ]);
}

/** The five results of the Overview, each cut to its lead rows with the count of all of them. */
export function overviewResults(series: SeriesData): AnyResultV2[] {
  const routed: AnyResultV2 = series.results[RESULT.findings]
    ? lead(series.results[RESULT.findings] as ResultSet, "routed")
    : series.results[RESULT.value] ? { ...(series.results[RESULT.value] as ResultSet), resultId: "routed" } : gapsLead(series, "routed");
  const changed: AnyResultV2 = series.results[RESULT.changes]
    ? lead(series.results[RESULT.changes] as ChangesResult, "changed")
    : { ...(series.results[RESULT.changesGap] as ResultSet), resultId: "changed" };
  return [lead(controlLead(series), "who"), graphLead(series), routed, lead(series.results[RESULT.unknowns] as ResultSet, "unknown"), changed];
}

export const OVERVIEW_TITLES: Record<string, string> = { who: S.blockControl, rests: S.blockRests, routed: S.blockValue, unknown: S.blockUnknown, changed: S.blockChanged };

export function defaultView(series: SeriesData): ExplorerView {
  return { focus: series.focus, steps: 1, layers: LAYERS.map((layer) => layer.name), expanded: [] };
}

export function tabSurface(_data: AppData, pack: PackData, series: SeriesData, tab: TabId, view?: ExplorerView): A2uiMessage[] {
  const surfaceId = `${tab}-${pack.id}-${series.id}`;
  const results = series.results;
  if (tab === "overview") {
    const five = overviewResults(series);
    return instantiateV2("protocol-overview", { surfaceId, meta: metaOf(series, five), results: five, titles: OVERVIEW_TITLES, explorer: { focus: series.focus, steps: 1 } });
  }
  if (tab === "control") {
    const groups = series.controlGroups.map((group) => results[group.resultId]);
    const tables = [results[RESULT.members], results[RESULT.thresholds]].filter((result): result is ResultSet => result !== undefined && result.shape === "table" && result.rows.length > 0);
    return instantiateV2("protocol-control", {
      surfaceId, meta: metaOf(series, groups), results: [...groups, ...tables],
      titles: { ...Object.fromEntries(series.controlGroups.map((group) => [group.resultId, group.title])), [RESULT.members]: S.membersTitle, [RESULT.thresholds]: S.thresholdsTitle },
    });
  }
  if (tab === "dependencies") {
    const explorer: ExplorerInput = view ?? defaultView(series);
    return instantiateV2("graph-explorer", { surfaceId, meta: metaOf(series, []), results: [results[RESULT.graph]], explorer });
  }
  if (tab === "value-path") {
    if (results[RESULT.path]) {
      const shown = [results[RESULT.findings], results[RESULT.path], results[RESULT.claims], results[RESULT.pathUnknowns]].filter((result): result is AnyResultV2 => result !== undefined);
      return instantiateV2("answer-panel", {
        surfaceId, meta: metaOf(series, shown), results: shown,
        titles: { [RESULT.findings]: S.findingsTitle, [RESULT.path]: S.pathTitle, [RESULT.claims]: S.claimsTitle, [RESULT.pathUnknowns]: S.pathUnknownsTitle },
      });
    }
    if (series.coverage) {
      const routed = series.coverage.mechanics.map((entry, n) => ({ entry, n })).filter(({ entry }) => ["fees", "treasury", "flows"].includes(entry.mechanic));
      return surface(surfaceId, { meta: metaOf(series, []), results: {}, coverage: series.coverage }, [
        column(routed.map(({ n }) => `m-${n}`)),
        ...routed.map(({ n }) => ({ id: `m-${n}`, component: "CoverageNote", coverage: { path: `/coverage/mechanics/${n}` } })),
      ]);
    }
    const gaps = gapsLead(series, "routed");
    return surface(surfaceId, { meta: metaOf(series, [gaps]), results: byId([gaps]) }, [column(["gaps"]), { id: "gaps", component: "GapList", result: bind(gaps) }]);
  }
  if (tab === "unknowns") {
    const shown = [results[RESULT.unknowns], results[RESULT.gaps]].filter((result): result is AnyResultV2 => result !== undefined);
    return instantiateV2("protocol-unknowns", { surfaceId, meta: metaOf(series, shown), results: shown, ...(series.coverage ? { coverage: series.coverage } : {}) });
  }
  const changes = results[RESULT.changes];
  if (changes) {
    const notes = results[RESULT.changeNotes];
    const shown = notes ? [changes, notes] : [changes];
    return surface(surfaceId, { meta: metaOf(series, shown), results: byId(shown) }, [
      column(notes ? ["changes", "notes"] : ["changes"]),
      { id: "changes", component: "ChangeList", result: bind(changes) },
      ...(notes ? [{ id: "notes", component: "GapList", result: bind(notes) }] : []),
    ]);
  }
  const gap = results[RESULT.changesGap];
  return surface(surfaceId, { meta: metaOf(series, [gap]), results: byId([gap]) }, [column(["gap"]), { id: "gap", component: "GapList", result: bind(gap) }]);
}

/** Every edge fact and every state fact of the capture as tables: the full text beside the explorer. */
export function tablesSurface(_data: AppData, pack: PackData, series: SeriesData): A2uiMessage[] {
  const edges = series.results[RESULT.edges];
  const state = series.results[RESULT.state];
  const columns = ["subject", "predicate", "object", "status", "layer"];
  return surface(`tables-${pack.id}-${series.id}`, { meta: metaOf(series, [edges, state]), results: byId([edges, state]) }, [
    column(["edges-box", "state-box"]),
    { id: "edges-box", component: "Disclosure", title: S.edgesTitle, children: ["edges"] },
    { id: "edges", component: "FactTable", result: bind(edges), columns },
    { id: "state-box", component: "Disclosure", title: S.stateTitle, children: ["state"] },
    { id: "state", component: "FactTable", result: bind(state), columns: columns.slice(0, 4) },
  ]);
}

export type Selection =
  | { kind: "edge"; pack: string; series: string; key: string }
  | { kind: "evidence"; id: string };

/**
 * The evidence drawer: one FactCard per fact of the selected edge and one ReceiptCard per receipt, all bound.
 * An id the data does not hold is returned in `missing` and gets no card and no invented field.
 */
export function drawerSurface(data: AppData, selection: Selection, extraReceipts: Record<string, ReceiptRecord> = {}): { messages: A2uiMessage[] | null; missing: string[] } {
  const receiptOf = (id: string): ReceiptRecord | undefined => (Object.prototype.hasOwnProperty.call(data.receipts, id) ? data.receipts[id] : Object.prototype.hasOwnProperty.call(extraReceipts, id) ? extraReceipts[id] : undefined);
  const missing: string[] = [];
  let rows: ResultRow[] = [];
  let columns: ResultSet["columns"] = [];
  let evidenceIds: string[] = [];
  let snapshotIds: string[] = [];
  if (selection.kind === "edge") {
    const found = findSeries(data, selection.pack, selection.series);
    const graph = found?.series.results[RESULT.graph] as GraphResult | undefined;
    const edge = graph?.edges.find((candidate) => candidate.key === selection.key);
    const facts = found?.series.results[RESULT.edges] as ResultSet | undefined;
    if (!edge || !facts) return { messages: null, missing: [selection.key] };
    columns = facts.columns;
    snapshotIds = [found!.series.snapshotId];
    for (const factId of edge.factIds) {
      const row = facts.rows.find((candidate) => candidate.key === factId);
      if (row) rows.push(row);
      else missing.push(factId);
    }
    evidenceIds = [...new Set(rows.flatMap((row) => row.evidenceIds))];
  } else evidenceIds = [selection.id];
  const receipts: Record<string, ReceiptRecord> = {};
  for (const id of evidenceIds.slice(0, MAX_DRAWER_RECEIPTS)) {
    const record = receiptOf(id);
    if (record) receipts[id] = record;
    else missing.push(id);
  }
  const receiptIds = Object.keys(receipts);
  if (rows.length === 0 && receiptIds.length === 0) return { messages: null, missing };
  const facts: ResultSet = { resultId: "facts", shape: "table", columns, coverage: "mapped", coverageNotes: [], rows, truncated: false };
  const constructed = rows.some((row) => row.constructed === true) || receiptIds.some((id) => receipts[id].constructed === true);
  const components: A2uiComponent[] = [
    column([...rows.map((_, n) => `fact-${n}`), ...receiptIds.map((_, n) => `receipt-${n}`)]),
    ...rows.map((_, n) => ({ id: `fact-${n}`, component: "FactCard", fact: { path: `/results/facts/rows/${n}` } })),
    ...receiptIds.map((id, n) => ({ id: `receipt-${n}`, component: "ReceiptCard", receipt: { path: `/receipts/${id}` } })),
  ];
  return { messages: surface("drawer", { meta: { snapshotIds, ...(constructed ? { constructed: true } : {}) }, results: rows.length > 0 ? byId([facts]) : {}, receipts }, components), missing };
}

/** The positions of one read: the address and the read in the header, the positions, then what was not read. */
export function positionsSurface(read: ReadData): A2uiMessage[] {
  return surface(`positions-${read.source}`, { meta: read.meta, results: byId([read.list, read.notRead]) }, [
    column(["header", "positions", "not-read"]),
    { id: "header", component: "SubjectHeader", meta: { path: "/meta" } },
    { id: "positions", component: "PositionList", result: bind(read.list) },
    { id: "not-read", component: "GapList", result: bind(read.notRead) },
  ]);
}

/** The explorer of a sheet: the joined account, two steps, every layer but the control lane. */
export function sheetView(account: string, expanded: string[] = []): ExplorerView {
  return { focus: account, steps: 2, layers: LAYERS.slice(1).map((layer) => layer.name), expanded };
}

/** The sheet of one position. `ordinal` is the position's place in the list, from one. Returns `null` for no such position. */
export function sheetSurface(data: AppData, read: ReadData, ordinal: number, view?: ExplorerView): A2uiMessage[] | null {
  const sheet = read.sheets.find((candidate) => candidate.ordinal === ordinal);
  if (!sheet) return null;
  const joined = sheet.join ? findSeries(data, sheet.join.pack, sheet.join.series) : null;
  const graph = joined ? (joined.series.results[RESULT.graph] as GraphResult | undefined) : undefined;
  const shown: AnyResultV2[] = [sheet.results.observations];
  if (graph && sheet.join && graph.nodes.some((node) => node.id === sheet.join!.account)) shown.push(graph);
  for (const id of ["control", "exit", "gaps"]) if (sheet.results[id]) shown.push(sheet.results[id]);
  return instantiateV2("position-sheet", {
    surfaceId: `sheet-${read.source}-${ordinal}`,
    meta: { snapshotIds: [...read.meta.snapshotIds, ...sheet.snapshotIds], ...(sheet.constructed ? { constructed: true } : {}) },
    results: shown,
    titles: { [RESULT.graph]: S.sheetRests, control: S.sheetControl, exit: S.sheetExit },
    note: read.source === "live" ? S.liveSheetNote : S.sheetNote,
    ...(sheet.join ? { explorer: view ?? sheetView(sheet.join.account) } : {}),
  });
}
