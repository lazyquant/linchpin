/**
 * The gallery of the second catalog: each component it adds, in each of its states, in light and in dark. Each
 * specimen is a real surface that the validator accepted. Build it with
 * `bun run src/ui/gallery-v2.ts build [--out <dir>]`.
 */
import { CATALOG_V2, V2_COMPONENT_NAMES } from "./catalog-v2";
import data from "./gallery-v2-data.json";
import { treeToHtml } from "./html";
import { interpret } from "./interpret";
import { A2UI_VERSION, updateComponents, updateDataModel } from "./messages";
import { pageShell } from "./page";
import { CLASSES, GALLERY_V2_STRINGS as G } from "./strings";
import { instantiateV2 } from "./templates-v2";
import { UiRejected } from "./types";
import type { A2uiComponent, A2uiMessage, AnyResultV2, CaptureRecord, ChangesResult, GraphResult, ReceiptRecord, ResultSet, SurfaceMeta, TraceRecord, UiNode } from "./types";
import { receiptResolver, validateSurface } from "./validate";

/** The states the page shows, each as a heading under the component it belongs to. */
export const GALLERY_V2_STATES = ["filled", "empty", "unknown", "none", "constructed", "reader row", "folded group", "gap end", "absent change side"] as const;
type State = (typeof GALLERY_V2_STATES)[number];

const RESULTS = data.results as unknown as Record<string, AnyResultV2>;
const RECEIPTS = data.receipts as unknown as Record<string, ReceiptRecord>;
const CAPTURES = data.captures as unknown as CaptureRecord[];
const TRACE = data.trace as unknown as TraceRecord;
const RECEIPT_IDS: string[] = data.receiptIds;
const resolveEvidence = receiptResolver(RECEIPT_IDS);

const table = (id: string): ResultSet => RESULTS[id] as ResultSet;
const graph = (id: string): GraphResult => RESULTS[id] as GraphResult;
const META: SurfaceMeta = { snapshotIds: data.source.captures, question: G.question };
const CONSTRUCTED_META: SurfaceMeta = { snapshotIds: [], constructed: true };

const el = (tag: string, className: string, text?: string, children: UiNode[] = []): UiNode => {
  const node: UiNode = { tag, attrs: className ? { class: className } : {}, children };
  if (text !== undefined) node.text = text;
  return node;
};

export interface SpecimenV2 { component: string; state: State; caption: string; messages: A2uiMessage[]; receiptIds: string[] }

/** A surface written out by hand, for the components no template places alone. */
function handBuilt(surfaceId: string, model: Record<string, unknown>, components: A2uiComponent[]): A2uiMessage[] {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: CATALOG_V2.id } },
    updateDataModel(surfaceId, "/", model),
    updateComponents(surfaceId, components),
  ];
}
const column = (children: string[]): A2uiComponent => ({ id: "root", component: "Column", children });
const one = (surfaceId: string, component: string, result: AnyResultV2, meta: SurfaceMeta = META, extra: Record<string, unknown> = {}): A2uiMessage[] =>
  handBuilt(surfaceId, { meta, results: { [result.resultId]: result } }, [column(["v"]), { id: "v", component, result: { path: `/results/${result.resultId}` }, ...extra }]);
const emptied = <T extends { rows: unknown[] }>(result: T, resultId: string): T => ({ ...result, resultId, rows: [], total: 0, truncated: false, constructed: true });
const explorer = (surfaceId: string, result: GraphResult, focus?: string, steps?: number, expanded?: string[], meta: SurfaceMeta = META): A2uiMessage[] =>
  instantiateV2("graph-explorer", { surfaceId, meta, results: [result], explorer: { ...(focus !== undefined ? { focus } : {}), ...(steps !== undefined ? { steps } : {}), ...(expanded !== undefined ? { expanded } : {}) } });

function build(): SpecimenV2[] {
  const out: SpecimenV2[] = [];
  const add = (component: string, state: State, caption: string, messages: A2uiMessage[]): void => {
    out.push({ component, state, caption, messages, receiptIds: RECEIPT_IDS });
  };
  const facts = table("fact-rows");
  const factAt = (pick: (row: ResultSet["rows"][number]) => boolean): number => facts.rows.findIndex(pick);
  const factCard = (surfaceId: string, at: number): A2uiMessage[] =>
    handBuilt(surfaceId, { meta: META, results: { [facts.resultId]: facts } }, [column(["v"]), { id: "v", component: "FactCard", fact: { path: `/results/${facts.resultId}/rows/${at}` } }]);
  const receiptCard = (surfaceId: string, record: ReceiptRecord, meta: SurfaceMeta): A2uiMessage[] =>
    handBuilt(surfaceId, { meta, results: {}, receipts: { [record.id]: record } }, [column(["v"]), { id: "v", component: "ReceiptCard", receipt: { path: `/receipts/${record.id}` } }]);
  const receipts = Object.values(RECEIPTS);
  const folded = graph("explorer-folded");
  const foldedGroup = `${data.market}|IN_MARKET|in`;

  add("GraphExplorer", "filled", G.capExplorerFilled, explorer("explorer-filled", graph("explorer-filled"), data.vault, 2));
  add("GraphExplorer", "filled", G.capExplorerWhole, explorer("explorer-whole", graph("explorer-whole")));
  add("GraphExplorer", "folded group", G.capExplorerFolded, explorer("explorer-folded", folded, data.market, 1));
  add("GraphExplorer", "folded group", G.capExplorerOpened, explorer("explorer-opened", { ...folded, resultId: "explorer-opened" }, data.market, 1, [foldedGroup]));
  add("GraphExplorer", "gap end", G.capExplorerGap, explorer("explorer-gap", graph("explorer-gap"), data.unknownAccount, 1));
  add("GraphExplorer", "empty", G.capExplorerEmpty, explorer("explorer-empty", { resultId: "explorer-empty", shape: "graph", coverage: "mapped", coverageNotes: [], nodes: [], edges: [], truncated: false, constructed: true }, undefined, undefined, undefined, CONSTRUCTED_META));

  add("FactCard", "filled", G.capFactFilled, factCard("fact-filled", factAt((row) => row.rowKind === "fact" && row.values.object !== "none")));
  add("FactCard", "unknown", G.capFactUnknown, factCard("fact-unknown", factAt((row) => row.rowKind === "unknown")));
  add("FactCard", "none", G.capFactNone, factCard("fact-none", factAt((row) => row.values.object === "none")));

  add("ReceiptCard", "filled", G.capReceiptFilled, receiptCard("receipt-filled", receipts.find((record) => record.constructed !== true)!, META));
  add("ReceiptCard", "constructed", G.capReceiptConstructed, receiptCard("receipt-constructed", receipts.find((record) => record.constructed === true)!, CONSTRUCTED_META));

  const path = table("path-filled");
  const claimed: ResultSet = {
    ...path, resultId: "path-constructed", constructed: true, total: 1,
    rows: [{ ...path.rows[0], key: "constructed-link", constructed: true, bases: ["claimed"], values: { ...path.rows[0].values, status: "claimed-only", amount: null, unit: null, window: null, transactions: null } }],
  };
  add("AnswerPath", "filled", G.capPathFilled, one("path-filled", "AnswerPath", path));
  add("AnswerPath", "constructed", G.capPathConstructed, one("path-constructed", "AnswerPath", claimed, CONSTRUCTED_META));
  add("AnswerPath", "empty", G.capPathEmpty, one("path-empty", "AnswerPath", emptied(path, "path-empty"), CONSTRUCTED_META));

  add("FindingList", "filled", G.capFindingsFilled, one("findings-filled", "FindingList", table("findings-filled")));
  add("FindingList", "empty", G.capFindingsEmpty, one("findings-empty", "FindingList", emptied(table("findings-filled"), "findings-empty"), CONSTRUCTED_META));

  add("ClaimCheck", "filled", G.capClaimsFilled, one("claims-filled", "ClaimCheck", table("claims-filled")));
  add("ClaimCheck", "empty", G.capClaimsEmpty, one("claims-empty", "ClaimCheck", emptied(table("claims-filled"), "claims-empty"), CONSTRUCTED_META));

  const changes = RESULTS["changes-filled"] as ChangesResult;
  const absent: ChangesResult = {
    ...changes, resultId: "changes-absent", constructed: true, total: 1,
    rows: [{ ...changes.rows[0], constructed: true, after: { absent: true, reason: "not in this capture" } }],
  };
  add("ChangeList", "filled", G.capChangesFilled, one("changes-filled", "ChangeList", changes));
  add("ChangeList", "absent change side", G.capChangesAbsent, one("changes-absent", "ChangeList", absent, CONSTRUCTED_META));
  add("ChangeList", "empty", G.capChangesEmpty, one("changes-empty", "ChangeList", emptied(changes, "changes-empty"), CONSTRUCTED_META));

  add("PositionList", "reader row", G.capPositionsReader, one("positions-reader", "PositionList", table("positions-reader"), CONSTRUCTED_META));
  add("PositionList", "empty", G.capPositionsEmpty, one("positions-empty", "PositionList", table("positions-empty")));

  const captureList = (surfaceId: string, captures: CaptureRecord[], meta: SurfaceMeta): A2uiMessage[] =>
    handBuilt(surfaceId, { meta: { ...meta, captures }, results: {} }, [column(["v"]), { id: "v", component: "CaptureList", captures: { path: "/meta/captures" } }]);
  add("CaptureList", "filled", G.capCapturesFilled, captureList("captures-filled", CAPTURES, META));
  add("CaptureList", "constructed", G.capCapturesConstructed, captureList("captures-constructed", CAPTURES.map((capture, at) => (at === 0 ? { ...capture, constructed: true } : capture)), CONSTRUCTED_META));

  add("GapList", "filled", G.capGapsFilled, one("gaps-filled", "GapList", table("gaps-filled")));
  add("GapList", "filled", G.capGapsNotRead, one("gaps-not-read", "GapList", table("gaps-not-read")));
  add("GapList", "empty", G.capGapsEmpty, one("gaps-empty", "GapList", emptied(table("gaps-filled"), "gaps-empty"), CONSTRUCTED_META));

  add("QueryTrace", "filled", G.capTraceFilled, handBuilt("trace-filled", { meta: { ...META, trace: TRACE }, results: {} }, [column(["v"]), { id: "v", component: "QueryTrace", trace: { path: "/meta/trace" } }]));

  const group = table("control-group");
  add("Disclosure", "filled", G.capDisclosureFilled, instantiateV2("protocol-control", { surfaceId: "disclosure-filled", meta: META, results: [group], titles: { [group.resultId]: G.titleGroup } }));
  add("Disclosure", "empty", G.capDisclosureEmpty, handBuilt("disclosure-empty", { meta: CONSTRUCTED_META, results: {} }, [column(["d"]), { id: "d", component: "Disclosure", title: G.titlePlain, children: [] }]));
  return out;
}

/** Every specimen of the page, in page order. Each passes the validator with the receipt ids it names. */
export function galleryV2Specimens(): SpecimenV2[] {
  return build();
}

function drawSpecimen(specimen: SpecimenV2): UiNode[] {
  const verdict = validateSurface(specimen.messages, { resolveEvidence });
  if (!verdict.ok) throw new UiRejected("invalid-surface", verdict.codes);
  return [el("p", "lk-gallery-caption", specimen.caption), el("div", "lk-specimen", undefined, [interpret(specimen.messages).root])];
}

function paneContent(): UiNode[] {
  const all = build();
  return V2_COMPONENT_NAMES.map((name) => {
    const own = all.filter((specimen) => specimen.component === name);
    const states = GALLERY_V2_STATES.filter((state) => own.some((specimen) => specimen.state === state));
    return el("div", "lk-gallery-component", undefined, [
      el("div", "lk-gallery-name", undefined, [el("h2", "", name), el("p", "lk-gallery-draws", CATALOG_V2.components[name].draws)]),
      el("div", "lk-gallery-states", undefined, states.map((state) => el("div", "lk-gallery-state", undefined, [el("h3", "", state), ...own.filter((specimen) => specimen.state === state).flatMap(drawSpecimen)]))),
    ]);
  });
}

function pane(themeClass: string, themeName: string, content: UiNode[]): UiNode {
  return el("div", `lk-gallery-pane ${themeClass}`, undefined, [
    el("div", "lk-gallery-inner", undefined, [
      el("div", "lk-gallery-masthead", undefined, [
        el("p", "lk-gallery-theme", themeName),
        el("h1", "", G.title),
        el("p", "lk-gallery-lede", G.lede),
        el("p", "lk-gallery-source", `${G.source}: `, [...data.source.captures.flatMap((id, at) => [...(at > 0 ? [el("span", "", ", ")] : []), el("span", "lk-id", id)]), el("span", "", `; ${data.source.read}; ${G.sourceDetail}.`)]),
      ]),
      ...content,
    ]),
  ]);
}

/** The gallery as one self-contained HTML document. The same bytes on every call. */
export function buildGalleryV2(): string {
  const content = paneContent();
  const body = el("div", "lk-gallery", undefined, [pane(CLASSES.themeLight, G.themeLight, content), pane(CLASSES.themeDark, G.themeDark, content)]);
  return pageShell({ title: G.title, lang: "en", bodyHtml: treeToHtml(body) });
}

async function main(args: string[]): Promise<number> {
  const out = args.length === 1 ? "dist/ui-gallery" : args[2];
  const wellFormed = args[0] === "build" && (args.length === 1 || (args.length === 3 && args[1] === "--out" && out !== ""));
  if (!wellFormed) {
    console.error(G.usage);
    return 2;
  }
  const file = `${out.replace(/\/+$/, "")}/gallery-v2.html`;
  await Bun.write(file, buildGalleryV2());
  console.log(file);
  return 0;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
