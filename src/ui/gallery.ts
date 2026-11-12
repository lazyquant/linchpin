/**
 * The gallery: every catalog component in every state, in light and in dark, and one full subject panel.
 * Each specimen is a real surface: messages, drawn by the kit. Build it with
 * `bun run src/ui/gallery.ts build [--out <dir>]`.
 */
import type { EvidenceReceipt, Fact } from "../engine/contracts";
import { factsToResult, graphResult } from "./adapters";
import type { FactColumn } from "./adapters";
import { CATALOG } from "./catalog";
import data from "./gallery-data.json";
import { treeToHtml } from "./html";
import { interpret } from "./interpret";
import { createSurface, updateComponents, updateDataModel } from "./messages";
import { pageShell } from "./page";
import { CLASSES, GALLERY_STRINGS as G } from "./strings";
import { instantiate } from "./templates";
import type { A2uiComponent, A2uiMessage, AnyResult, BlockOrSlot, CoverageInput, GraphResult, ResultRow, ResultSet, SurfaceMeta, UiNode } from "./types";
import { receiptResolver, validateSurface } from "./validate";

export const GALLERY_STATES = ["filled", "long identifiers", "empty", "none", "unknown", "not mapped", "constructed", "unsupported component"] as const;
type State = (typeof GALLERY_STATES)[number];

const FACTS = data.facts as unknown as Fact[];
const RECEIPTS = data.receipts as unknown as EvidenceReceipt[];
const SUBJECT: string = data.subject;
const SNAPSHOT: string = data.snapshotId;
const PREFIX = SUBJECT.slice(0, SUBJECT.lastIndexOf(":") + 1);
const short = (id: string): string => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id);

const OWN = FACTS.filter((fact) => fact.subject === SUBJECT);
const HOLDERS = FACTS.filter((fact) => fact.subject.startsWith(`${SUBJECT}#`));
const UNKNOWN = FACTS.filter((fact) => fact.object === "unknown" && fact.basis === "unknown");
const ROLES = OWN.filter((fact) => fact.predicate === "holds-role");
const KEYS = OWN.filter((fact) => fact.predicate === "has-function-call-key");
const ALL_KEYS = OWN.filter((fact) => fact.predicate.endsWith("-key"));
const CODE = OWN.filter((fact) => fact.predicate !== "holds-role" && !fact.predicate.endsWith("-key"));
const NONE = FACTS.filter((fact) => fact.object === "none");

const RECEIPT_BY_ID = new Map(RECEIPTS.map((receipt) => [receipt.id, receipt]));
const resolveEvidence = receiptResolver(RECEIPT_BY_ID.keys());

const el = (tag: string, className: string, text?: string, children: UiNode[] = []): UiNode => {
  const node: UiNode = { tag, attrs: className ? { class: className } : {}, children };
  if (text !== undefined) node.text = text;
  return node;
};

/* ---------- data for the surfaces ---------- */

/** The block range and the latest observation time of the receipts a set of facts cites. Blocks are returned as stored. */
function observedOver(facts: Fact[]): { from: BlockOrSlot; to: BlockOrSlot; latest: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  let latest: string | null = null;
  for (const id of facts.flatMap((fact) => fact.evidenceIds)) {
    const seen = RECEIPT_BY_ID.get(id)?.observation;
    if (!seen) continue;
    const block = seen.blockOrSlot;
    if (block !== null) {
      if (from === null || BigInt(block) < BigInt(from)) from = block;
      if (to === null || BigInt(block) > BigInt(to)) to = block;
    }
    if (latest === null || seen.observedAt > latest) latest = seen.observedAt;
  }
  return { from, to, latest };
}

function metaFor(facts: Fact[], extra: Partial<SurfaceMeta> = {}): SurfaceMeta {
  const over = observedOver(facts);
  return { snapshotIds: [SNAPSHOT], fromBlockOrSlot: over.from, toBlockOrSlot: over.to, capturedAt: over.latest, ...extra };
}

const SUBJECT_META = metaFor(OWN, { title: short(SUBJECT), subjectId: SUBJECT });

const OWN_COLUMNS: FactColumn[] = [
  { name: "predicate", role: "label", field: "predicate" },
  { name: "object", role: "value", field: "object" },
  { name: "status", role: "status", field: "status" },
];

function table(id: string, facts: Fact[], columns?: FactColumn[], shape: "table" | "unknowns" = "table"): ResultSet {
  const { result, skipped } = factsToResult(facts, RECEIPTS, { id, shape, columns, snapshotIds: [SNAPSHOT] });
  if (skipped.length > 0) throw new Error(`gallery data: ${skipped.length} fact(s) cite a receipt the extract does not hold`);
  return result;
}

function emptyResult(id: string, shape: ResultSet["shape"], columns: ResultSet["columns"]): ResultSet {
  return { resultId: id, shape, columns, coverage: "mapped", coverageNotes: [], rows: [], truncated: false };
}

const CHAIN_COLUMNS: ResultSet["columns"] = [
  { name: "target", role: "address" }, { name: "instruction", role: "instruction" }, { name: "role", role: "address" },
  { name: "authority", role: "address" }, { name: "controller", role: "address" },
];

/** A chain row from two facts: the contract's role, and one holder of that role. Nothing is added to them. */
function chainResult(id: string, holderFacts: Fact[]): ResultSet {
  const rows: ResultRow[] = [];
  for (const holder of holderFacts) {
    const role = ROLES.find((fact) => fact.object === holder.subject);
    if (!role) continue;
    const evidenceIds = [...new Set([...role.evidenceIds, ...holder.evidenceIds])];
    const over = observedOver([role, holder]);
    rows.push({
      rowKind: "fact",
      key: `${role.id}+${holder.id}`,
      values: { target: role.subject, role: role.object, authority: holder.object },
      factIds: [role.id, holder.id],
      bases: [...new Set([role.basis, holder.basis])],
      evidenceIds,
      blockOrSlot: over.to,
      asOf: over.latest,
      snapshotIds: [SNAPSHOT],
    });
  }
  return { resultId: id, shape: "chain", columns: CHAIN_COLUMNS, coverage: "mapped", coverageNotes: [], rows, truncated: false };
}

function panelGraph(): GraphResult {
  const ids = [SUBJECT, ...ROLES.map((fact) => fact.object)];
  for (const fact of HOLDERS) if (fact.object !== "none" && !ids.includes(fact.object)) ids.push(fact.object);
  return graphResult(ids.map((id) => ({ id, label: short(id) })), [...OWN, ...HOLDERS], { id: "graph", receipts: RECEIPTS }).result;
}

/* ---------- surfaces ---------- */

function handBuilt(surfaceId: string, model: Record<string, unknown>, components: A2uiComponent[]): A2uiMessage[] {
  return [createSurface(surfaceId), updateDataModel(surfaceId, "/", model), updateComponents(surfaceId, components)];
}
const column = (children: string[]): A2uiComponent => ({ id: "root", component: "Column", children });
const modelOf = (meta: SurfaceMeta, results: AnyResult[] = []): Record<string, unknown> => ({ meta, results: Object.fromEntries(results.map((result) => [result.resultId, result])) });

interface Specimen { caption: string; messages: A2uiMessage[]; valid?: false; coverage?: CoverageInput }

/** Draws one specimen. A specimen built from recorded rows must pass the validator, or the build stops. */
function drawSpecimen(specimen: Specimen): UiNode[] {
  if (specimen.valid !== false) {
    const verdict = validateSurface(specimen.messages, { resolveEvidence, coverage: specimen.coverage });
    if (!verdict.ok) throw new Error(`gallery specimen refused (${verdict.codes.join(", ")}): ${specimen.caption}`);
  }
  const tree = interpret(specimen.messages);
  return [el("p", "lk-gallery-caption", specimen.caption), el("div", "lk-specimen", undefined, [{ ...tree.root, tag: "div" }])];
}

function specimens(): Record<string, [State, Specimen[]][]> {
  const roles = table("roles", ROLES, OWN_COLUMNS);
  const code = table("code", CODE, OWN_COLUMNS);
  const holders = table("holders", HOLDERS);
  const constructedMeta: SurfaceMeta = { ...SUBJECT_META, kind: G.constructedKind, constructed: true };
  const namedHolders = HOLDERS.filter((fact) => fact.object !== "none" && !/:[0-9a-f]{64}$/.test(fact.object));
  const longHolder = HOLDERS.find((fact) => /:[0-9a-f]{64}$/.test(fact.object))!;
  const pathRows: ResultRow[] = [
    { rowKind: "path", key: "example-a", values: { from: "example:fee-vault", to: "example:stakers", amount: "12.5", unit: "example units", window: "per example epoch" }, factIds: [], bases: ["claimed"], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [] },
    { rowKind: "unknown", key: "example-b", values: { from: "example:stakers", to: "unknown" }, factIds: [], bases: ["unknown"], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [] },
  ];
  const pathColumns: ResultSet["columns"] = [
    { name: "from", role: "address" }, { name: "to", role: "address" }, { name: "amount", role: "amount" }, { name: "unit", role: "unit" }, { name: "window", role: "note" },
  ];
  const timeColumns: FactColumn[] = [{ name: "observed at", role: "time", field: "observedAt" }, ...OWN_COLUMNS];
  const coverage: CoverageInput = { mechanics: [{ mechanic: G.mechanicName, status: "not-mapped", note: G.mechanicNote }], asked: [G.mechanicName] };
  const unknownGraph = graphResult(UNKNOWN.map((fact) => ({ id: fact.subject, label: short(fact.subject) })), UNKNOWN, { id: "owners", receipts: RECEIPTS }).result;
  const emptyMeta: SurfaceMeta = { snapshotIds: [] };

  return {
    Column: [
      ["filled", [{ caption: G.capColumnFilled, messages: handBuilt("column-filled", modelOf(SUBJECT_META, [code]), [column(["n", "t"]), { id: "n", component: "Note", text: G.noteText }, { id: "t", component: "FactTable", result: { path: "/results/code" } }]) }]],
      ["empty", [{ caption: G.capColumnEmpty, messages: handBuilt("column-empty", modelOf(SUBJECT_META), [column([])]) }]],
      ["unsupported component", [{ caption: G.capColumnUnsupported, valid: false, messages: handBuilt("column-unsupported", modelOf(SUBJECT_META, [roles]), [column(["x"]), { id: "x", component: "Sparkline", values: { path: "/results/roles" } }]) }]],
    ],
    AnswerHeader: [
      ["filled", [{ caption: G.capAnswerFilled, messages: handBuilt("answer", modelOf({ snapshotIds: [SNAPSHOT], question: G.questionRoles }, [holders]), [column(["h", "t"]), { id: "h", component: "AnswerHeader", meta: { path: "/meta" } }, { id: "t", component: "FactTable", result: { path: "/results/holders" } }]) }]],
    ],
    FactTable: [
      ["filled", [{ caption: G.capFactsFilled, messages: instantiate("fact-table", { surfaceId: "facts-filled", meta: SUBJECT_META, results: [roles] }) }]],
      ["long identifiers", [{ caption: G.capFactsLong, messages: instantiate("fact-table", { surfaceId: "facts-long", meta: SUBJECT_META, results: [table("keys", KEYS, OWN_COLUMNS)] }) }]],
      ["none", [{ caption: G.capFactsNone, messages: instantiate("fact-table", { surfaceId: "facts-none", meta: SUBJECT_META, results: [table("none", NONE)] }) }]],
      ["unknown", [{ caption: G.capFactsUnknown, messages: instantiate("fact-table", { surfaceId: "facts-unknown", meta: metaFor(UNKNOWN), results: [table("owners", UNKNOWN)] }) }]],
      ["empty", [{ caption: G.capFactsEmpty, messages: instantiate("fact-table", { surfaceId: "facts-empty", meta: constructedMeta, results: [emptyResult("rows", "table", roles.columns)] }) }]],
    ],
    ControlChain: [
      ["filled", [{ caption: G.capChainFilled, messages: instantiate("control-chain", { surfaceId: "chain-filled", meta: SUBJECT_META, results: [chainResult("chain", namedHolders)] }) }]],
      ["none", [{ caption: G.capChainNone, messages: instantiate("control-chain", { surfaceId: "chain-none", meta: SUBJECT_META, results: [chainResult("chain", HOLDERS.filter((fact) => fact.object === "none").slice(0, 3))] }) }]],
      ["empty", [{ caption: G.capChainEmpty, messages: instantiate("control-chain", { surfaceId: "chain-empty", meta: constructedMeta, results: [emptyResult("chain", "chain", CHAIN_COLUMNS)] }) }]],
    ],
    ValuePath: [
      ["constructed", [{
        caption: G.capPathConstructed, valid: false,
        messages: handBuilt("path-constructed", modelOf({ snapshotIds: [], title: G.pathTitle, kind: G.constructedSource, constructed: true }, [{ resultId: "path", shape: "path", columns: pathColumns, coverage: "mapped", coverageNotes: [], rows: pathRows, truncated: false }]),
          [column(["h", "p"]), { id: "h", component: "SubjectHeader", meta: { path: "/meta" } }, { id: "p", component: "ValuePath", result: { path: "/results/path" } }]),
      }]],
      ["empty", [{ caption: G.capPathEmpty, messages: handBuilt("path-empty", modelOf(constructedMeta, [emptyResult("path", "path", pathColumns)]), [column(["p"]), { id: "p", component: "ValuePath", result: { path: "/results/path" } }]) }]],
    ],
    CoverageNote: [
      ["not mapped", [{ caption: G.capCoverageNotMapped, messages: instantiate("coverage", { surfaceId: "coverage-not-mapped", meta: constructedMeta, results: [{ ...emptyResult("fees", "path", pathColumns), coverage: "not-mapped", coverageNotes: [G.coverageNoteNotMapped] }] }) }]],
      ["constructed", [
        { caption: G.capCoverageConstructed, messages: instantiate("coverage", { surfaceId: "coverage-partial", meta: constructedMeta, results: [{ ...chainResult("chain", namedHolders), coverage: "partial", coverageNotes: [G.coverageNotePartial] }] }) },
        { caption: G.capCoverageMechanic, coverage, messages: handBuilt("coverage-mechanic", { ...modelOf(constructedMeta), coverage }, [column(["c"]), { id: "c", component: "CoverageNote", coverage: { path: "/coverage/mechanics/0" } }]) },
      ]],
    ],
    UnknownList: [
      ["unknown", [{ caption: G.capUnknownsUnknown, messages: instantiate("unknowns", { surfaceId: "unknowns", meta: metaFor(UNKNOWN), results: [table("owners", UNKNOWN, undefined, "unknowns")] }) }]],
      ["empty", [{ caption: G.capUnknownsEmpty, messages: instantiate("unknowns", { surfaceId: "unknowns-empty", meta: constructedMeta, results: [emptyResult("owners", "unknowns", holders.columns)] }) }]],
    ],
    Note: [
      ["filled", [{ caption: G.capNoteFilled, messages: handBuilt("note", modelOf(SUBJECT_META), [column(["n"]), { id: "n", component: "Note", text: G.noteText }]) }]],
    ],
    SubjectHeader: [
      ["filled", [{ caption: G.capHeaderFilled, messages: handBuilt("header-filled", modelOf(SUBJECT_META), [column(["h"]), { id: "h", component: "SubjectHeader", meta: { path: "/meta" } }]) }]],
      ["long identifiers", [{ caption: G.capHeaderLong, messages: handBuilt("header-long", modelOf(metaFor([longHolder], { subjectId: longHolder.object })), [column(["h"]), { id: "h", component: "SubjectHeader", meta: { path: "/meta" } }]) }]],
      ["constructed", [{ caption: G.capHeaderConstructed, messages: handBuilt("header-constructed", modelOf(constructedMeta), [column(["h"]), { id: "h", component: "SubjectHeader", meta: { path: "/meta" } }]) }]],
      ["empty", [{ caption: G.capHeaderEmpty, messages: handBuilt("header-empty", modelOf(emptyMeta), [column(["h"]), { id: "h", component: "SubjectHeader", meta: { path: "/meta" } }]) }]],
    ],
    Section: [
      ["filled", [{ caption: G.capSectionFilled, messages: handBuilt("section-filled", modelOf(SUBJECT_META, [code]), [column(["s"]), { id: "s", component: "Section", title: G.titleCode, children: ["t"] }, { id: "t", component: "FactTable", result: { path: "/results/code" } }]) }]],
      ["empty", [{ caption: G.capSectionEmpty, messages: handBuilt("section-empty", modelOf(SUBJECT_META), [column(["s"]), { id: "s", component: "Section", title: G.titleSection, children: [] }]) }]],
    ],
    DependencyGraph: [
      ["filled", [{ caption: G.capGraphFilled, messages: instantiate("dependency-graph", { surfaceId: "graph-filled", meta: SUBJECT_META, results: [panelGraph()] }) }]],
      ["unknown", [{ caption: G.capGraphUnknown, messages: instantiate("dependency-graph", { surfaceId: "graph-unknown", meta: metaFor(UNKNOWN), results: [unknownGraph] }) }]],
      ["empty", [{ caption: G.capGraphEmpty, messages: instantiate("dependency-graph", { surfaceId: "graph-empty", meta: constructedMeta, results: [{ resultId: "graph", shape: "graph", coverage: "mapped", coverageNotes: [], nodes: [], edges: [], truncated: false }] }) }]],
    ],
    Timeline: [
      ["filled", [{ caption: G.capTimelineFilled, messages: instantiate("timeline", { surfaceId: "timeline-filled", meta: SUBJECT_META, results: [table("timeline", CODE, timeColumns)] }) }]],
      ["empty", [{ caption: G.capTimelineEmpty, messages: instantiate("timeline", { surfaceId: "timeline-empty", meta: constructedMeta, results: [emptyResult("timeline", "table", timeColumns.map(({ name, role }) => ({ name, role })))] }) }]],
    ],
  };
}

/** The full panel for the subject: header, facts by predicate group, the graph, then the unknowns of the capture. */
export function subjectPanelMessages(): A2uiMessage[] {
  return instantiate("subject-panel", {
    surfaceId: "subject-panel",
    meta: SUBJECT_META,
    results: [
      table("roles", ROLES, OWN_COLUMNS),
      table("holders", HOLDERS),
      table("keys", ALL_KEYS, OWN_COLUMNS),
      table("code", CODE, OWN_COLUMNS),
      panelGraph(),
      table("owners", UNKNOWN, undefined, "unknowns"),
    ],
    titles: { roles: G.titleRoles, holders: G.titleHolders, keys: G.titleKeys, code: G.titleCode, graph: G.titleGraph, owners: G.titleUnknowns },
  });
}

/* ---------- page ---------- */

function paneContent(): UiNode[] {
  const bySpec = specimens();
  const blocks: UiNode[] = [];
  for (const name of Object.keys(CATALOG.components)) {
    const states = bySpec[name] ?? [];
    blocks.push(el("div", "lk-gallery-component", undefined, [
      el("div", "lk-gallery-name", undefined, [el("h2", "", name), el("p", "lk-gallery-draws", CATALOG.components[name].draws)]),
      el("div", "lk-gallery-states", undefined, states.map(([state, list]) => el("div", "lk-gallery-state", undefined, [el("h3", "", state), ...list.flatMap(drawSpecimen)]))),
    ]));
  }
  blocks.push(el("div", "lk-gallery-panel", undefined, [
    el("div", "lk-gallery-name", undefined, [el("h2", "", G.panelHeading)]),
    ...drawSpecimen({ caption: G.panelCaption, messages: subjectPanelMessages() }),
  ]));
  return blocks;
}

function pane(themeClass: string, themeName: string, content: UiNode[]): UiNode {
  return el("div", `lk-gallery-pane ${themeClass}`, undefined, [
    el("div", "lk-gallery-inner", undefined, [
      el("div", "lk-gallery-masthead", undefined, [
        el("p", "lk-gallery-theme", themeName),
        el("h1", "", G.title),
        el("p", "lk-gallery-lede", G.lede),
        el("p", "lk-gallery-source", `${G.source}: `, [el("span", "lk-id", SNAPSHOT), el("span", "", `, ${G.sourceDetail}.`)]),
      ]),
      ...content,
    ]),
  ]);
}

/** The gallery as one self-contained HTML document. The same bytes on every call. */
export function buildGallery(): string {
  const content = paneContent();
  const body = el("div", "lk-gallery", undefined, [
    pane(CLASSES.themeLight, G.themeLight, content),
    pane(CLASSES.themeDark, G.themeDark, content),
  ]);
  return pageShell({ title: G.title, lang: "en", bodyHtml: treeToHtml(body) });
}

async function main(args: string[]): Promise<number> {
  const out = args.length === 1 ? "dist/ui-gallery" : args[2];
  const wellFormed = args[0] === "build" && (args.length === 1 || (args.length === 3 && args[1] === "--out" && out !== ""));
  if (!wellFormed) {
    console.error(G.usage);
    return 2;
  }
  const file = `${out.replace(/\/+$/, "")}/gallery.html`;
  await Bun.write(file, buildGallery());
  console.log(file);
  return 0;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
