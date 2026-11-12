/** The component catalog `linchpin.evidence.v1`: twelve components, their props and what each draws. */
import type { Shape } from "./types";

/** B: the value must be a binding `{ "path": … }`. L: a literal. children: a list of component ids, or a template. */
export interface PropSpec { kind: "B" | "L" | "children"; required: boolean; accepts?: Shape[]; maxLength?: number }
export interface ComponentSpec { props: Record<string, PropSpec>; draws: string }
export interface Catalog { id: string; components: Record<string, ComponentSpec>; instructions: string[] }

const ALL_ROW_SHAPES: Shape[] = ["table", "chain", "path", "unknowns"];
const ALL_SHAPES: Shape[] = ["table", "chain", "path", "unknowns", "graph"];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export const CATALOG: Catalog = deepFreeze({
  id: "linchpin.evidence.v1",
  components: {
    Column: {
      props: { children: { kind: "children", required: true } },
      draws: "Vertical layout of its children, in order.",
    },
    AnswerHeader: {
      props: { meta: { kind: "B", required: true } },
      draws: "The question as asked, the protocol title, the snapshot ids, the block or slot range and the latest time over the results bound on the surface, and the line that the evidence is recorded and not refreshed.",
    },
    FactTable: {
      props: {
        result: { kind: "B", required: true, accepts: ALL_ROW_SHAPES },
        columns: { kind: "L", required: false },
        title: { kind: "L", required: false, maxLength: 80 },
      },
      draws: "One table row per result row: the chosen columns, then the bases, the block or slot or the time, and the evidence chip.",
    },
    ControlChain: {
      props: { result: { kind: "B", required: true, accepts: ["chain"] } },
      draws: "Per row: target, instruction, role, authority, controller, and the threshold where the row has one. A missing step reads not mapped.",
    },
    ValuePath: {
      props: { result: { kind: "B", required: true, accepts: ["path"] } },
      draws: "Per row: one link from a node to a node with its bases; an amount, unit and window only where the row has them.",
    },
    CoverageNote: {
      props: {
        result: { kind: "B", required: false, accepts: ALL_SHAPES },
        coverage: { kind: "B", required: false },
      },
      draws: "The coverage status in words and each recorded note verbatim. Takes exactly one of its two props.",
    },
    UnknownList: {
      props: { result: { kind: "B", required: true, accepts: ["unknowns"] } },
      draws: "Each unresolved item with every column and its provenance, hatched.",
    },
    Note: {
      props: { text: { kind: "L", required: true, maxLength: 280 } },
      draws: "One short plain sentence.",
    },
    SubjectHeader: {
      props: { meta: { kind: "B", required: true } },
      draws: "The subject's title, its id in full, the kind line, the snapshot ids, the block or slot range, the capture time, and the constructed mark when the data says so.",
    },
    Section: {
      props: { title: { kind: "L", required: true, maxLength: 80 }, children: { kind: "children", required: true } },
      draws: "A titled section holding its children.",
    },
    DependencyGraph: {
      props: { result: { kind: "B", required: true, accepts: ["graph"] } },
      draws: "A drawing of the nodes and edges, and the same nodes and edges as text lists. Every edge shows its relation, bases and evidence.",
    },
    Timeline: {
      props: { result: { kind: "B", required: true, accepts: ["table"] } },
      draws: "One entry per row in ascending order of the first column of role time; a row with no time comes last.",
    },
  },
  instructions: [
    "A surface is three messages: createSurface, updateDataModel, updateComponents. Components are a flat list; one has the id root.",
    "Every value comes from the data model through a binding. A prop of kind B takes { \"path\": \"/json/pointer\" } and nothing else.",
    "meta binds to /meta. result binds to /results/<id>. CoverageNote.coverage binds to /coverage/mechanics/<n>.",
    "Value components draw each row's bases, its block or slot or time, and its evidence ids themselves. Nothing switches that off.",
    "A result whose coverage is not-mapped is shown through CoverageNote only. A partial result is shown with a CoverageNote or in a value component.",
    "ControlChain reads the columns target, instruction, role, authority, controller and, when present, threshold.",
    "ValuePath reads the columns from, to and, when present, amount, unit, window.",
    "Timeline needs a table result with a column of role time. UnknownList draws every column of each row.",
    "Literal text (Note.text, FactTable.title, Section.title) holds no digit, no advice word and no absence word; values and counts belong in rows.",
    "No component takes an action, a URL or a handler.",
  ],
});

/** The catalog as a JSON document for a model or a client. The same bytes on every call. */
export function catalogJson(): string {
  return JSON.stringify({ catalogId: CATALOG.id, components: CATALOG.components, instructions: CATALOG.instructions }, null, 2);
}
