/**
 * The component catalog `linchpin.evidence.v2`: the twelve components of the first catalog, unchanged, and twelve
 * more. A surface names one catalog; the first catalog stays as it is for every surface that names it.
 */
import { CATALOG } from "./catalog";
import type { ShapeV2 } from "./types";

export interface PropSpecV2 { kind: "B" | "L" | "children"; required: boolean; accepts?: ShapeV2[]; maxLength?: number }
export interface ComponentSpecV2 { props: Record<string, PropSpecV2>; draws: string }
export interface CatalogV2 { id: string; components: Record<string, ComponentSpecV2>; instructions: string[] }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/** The names the second catalog adds, in catalog order. */
export const V2_COMPONENT_NAMES: readonly string[] = Object.freeze([
  "GraphExplorer", "FactCard", "ReceiptCard", "AnswerPath", "FindingList", "ClaimCheck", "ChangeList", "PositionList",
  "CaptureList", "GapList", "QueryTrace", "Disclosure",
]);

/** The words a gap row may give as its reason. */
export const GAP_REASONS: readonly string[] = Object.freeze(["not-captured", "not-computed", "not-mapped", "not-read"]);
export const CLAIM_COLUMNS: readonly string[] = Object.freeze(["claim", "source", "chain result", "status"]);
export const POSITION_COLUMNS: readonly string[] = Object.freeze(["account", "quantity", "unit", "leg", "joined to"]);

export const CATALOG_V2: CatalogV2 = deepFreeze({
  id: "linchpin.evidence.v2",
  components: {
    ...(CATALOG.components as Record<string, ComponentSpecV2>),
    GraphExplorer: {
      props: {
        result: { kind: "B", required: true, accepts: ["graph"] },
        focus: { kind: "L", required: false },
        steps: { kind: "L", required: false },
        layers: { kind: "L", required: false },
        expanded: { kind: "L", required: false },
      },
      draws: "The neighbourhood of one node: who controls it above, what it rests on and what rests on it beside it, one column per step, large sets of neighbours folded into a group. Without a focus, the whole graph. The same nodes, groups and edges follow as text lists; every edge shows its relation, layer, bases and evidence.",
    },
    FactCard: {
      props: { fact: { kind: "B", required: true } },
      draws: "One row in full: subject and object with their kinds where the row has them, the relation, the status, the fact ids, the snapshot ids, the bases, the block or slot and the evidence chip.",
    },
    ReceiptCard: {
      props: { receipt: { kind: "B", required: true } },
      draws: "One receipt: id, source, response sha256, block or slot, observation time, historical state and privacy.",
    },
    AnswerPath: {
      props: { result: { kind: "B", required: true, accepts: ["path"] } },
      draws: "A value path as a staged drawing and the same links as a list: from, to, mechanism and status, and an amount, unit, window and transaction count only where the row has them.",
    },
    FindingList: {
      props: { result: { kind: "B", required: true, accepts: ["table"] } },
      draws: "One entry per row: the text of the note column, the status word, and the row's provenance.",
    },
    ClaimCheck: {
      props: { result: { kind: "B", required: true, accepts: ["table"] } },
      draws: "One entry per row: a documented claim, where it is stated, what the chain shows and the status word, with the row's provenance.",
    },
    ChangeList: {
      props: { result: { kind: "B", required: true, accepts: ["changes"] } },
      draws: "What differs between two captures. Per row the kind, the key and both sides, each with its own value, bases, block or slot and evidence; a side a capture does not hold says so with its reason.",
    },
    PositionList: {
      props: { result: { kind: "B", required: true, accepts: ["table"] } },
      draws: "The positions of one read: account, quantity, unit, leg and what the account is joined to as a scope statement, with the block or slot and the evidence chip. The basis reads as not stated by the reader.",
    },
    CaptureList: {
      props: { captures: { kind: "B", required: true } },
      draws: "The captures on record for a subject: id, times, block or slot range, fact and account counts, which one is shown, constructed or recorded, and where the list comes from.",
    },
    GapList: {
      props: { result: { kind: "B", required: true, accepts: ["unknowns"] } },
      draws: "Named things that are absent from the evidence, each hatched, with every column, its reason word and the source of the statement.",
    },
    QueryTrace: {
      props: { trace: { kind: "B", required: true } },
      draws: "How an answer was produced: template, parameters, outcome, rows returned and the reasons by code.",
    },
    Disclosure: {
      props: {
        title: { kind: "L", required: true, maxLength: 80 },
        count: { kind: "B", required: false },
        children: { kind: "children", required: true },
      },
      draws: "A section that is closed until opened. Its summary holds the title and, with count, the number of rows inside.",
    },
  },
  instructions: [
    ...CATALOG.instructions,
    "GraphExplorer.result binds to a graph result. focus is a node id of that result, steps is the number one, two or three, layers and expanded are lists of names. An edge may end at the literal none or unknown.",
    "FactCard.fact binds to /results/<id>/rows/<n>. ReceiptCard.receipt binds to /receipts/<id>.",
    "AnswerPath reads the columns from, to and, when present, mechanism, status, amount, unit, window, transactions. A link that is claimed only carries no amount.",
    "FindingList needs a column of role note and a column of role status. ClaimCheck needs the columns claim, source, chain result, status.",
    "ChangeList.result binds to a result of shape changes that names two capture ids. Each side of a row carries bases and evidence, or says it is absent and why.",
    "PositionList needs the columns account, quantity, unit, leg, joined to. Its rows are of kind reader, each with evidence, a source and the source of its join.",
    "CaptureList.captures binds to /meta/captures. QueryTrace.trace binds to /meta/trace.",
    "GapList draws rows whose reason is one of not-captured, not-computed, not-mapped, not-read.",
    "Disclosure.count binds to /results/<id>/total of a result bound inside that Disclosure. Disclosure.title follows the rule of Section.title.",
    "A constructed row, capture, receipt or result is allowed only on a surface whose meta says constructed. A cut result states its total.",
  ],
});

/** The second catalog as a JSON document. The same bytes on every call. */
export function catalogJsonV2(): string {
  return JSON.stringify({ catalogId: CATALOG_V2.id, components: CATALOG_V2.components, instructions: CATALOG_V2.instructions }, null, 2);
}
