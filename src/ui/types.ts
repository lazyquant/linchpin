/** Shared types of the UI kit: result rows, A2UI v0.9.1 messages, the drawn tree and the validator's result. */

export type Shape = "table" | "chain" | "path" | "unknowns" | "graph";
/** The shapes of the second catalog: the five above and `changes`. */
export type ShapeV2 = Shape | "changes";
/** `reader` is a row a position reader returned: it cites receipts and a source, and states no basis. Second catalog only. */
export type RowKind = "fact" | "path" | "scope" | "coverage" | "unknown" | "reader";
/** Why a named thing is absent from the evidence. */
export type GapReason = "not-captured" | "not-computed" | "not-mapped" | "not-read";
export type ColumnRole = "subject" | "label" | "address" | "value" | "amount" | "unit" | "status" | "role" | "instruction" | "time" | "note";
export type CoverageStatus = "mapped" | "partial" | "not-mapped";
export type Cell = string | number | boolean | null;
/** A block or slot is kept as its source gave it: a string from an engine receipt, a number from a bundle row. Never converted. */
export type BlockOrSlot = string | number | null;

export interface ResultRow {
  rowKind: RowKind;
  key: string;
  values: Record<string, Cell>;
  factIds: string[];
  bases: string[];
  evidenceIds: string[];
  blockOrSlot: BlockOrSlot;
  asOf: string | null;
  snapshotIds: string[];
  scopeSource?: string;
  /** The row was written for a demonstration and records nothing about a live subject. */
  constructed?: true;
  /** Where a `reader` row comes from. */
  source?: string;
  /** For a row of a gap list: one of the `GapReason` words. */
  reason?: string;
}

export interface ResultSet {
  resultId: string;
  shape: "table" | "chain" | "path" | "unknowns";
  columns: { name: string; role: ColumnRole }[];
  coverage: CoverageStatus;
  coverageNotes: string[];
  rows: ResultRow[];
  truncated: boolean;
  /** Rows before a cut. */
  total?: number;
  constructed?: true;
}

/**
 * A word a graph node may carry beside its label. The kit draws each as a word and a line pattern and gives none a
 * meaning: the surface that sets a mark says what it stands for. A node takes one word or a list of distinct words.
 */
export type GraphMark = "attention" | "undetermined" | "clear" | "unmarked" | "changed";

/** `name` is a display label and never the identity. `kind` is shown as recorded, with `kindBasis`. */
export interface GraphNode { id: string; label: string; isolated: boolean; mark?: GraphMark | GraphMark[]; kind?: string; kindBasis?: string; name?: string }

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  relation: string;
  factIds: string[];
  bases: string[];
  evidenceIds: string[];
  blockOrSlot: BlockOrSlot;
  asOf: string | null;
  /** A display grouping of the relation. In the second catalog `to` may be the literal `none` or `unknown` with no such node. */
  layer?: string;
}

export interface GraphResult {
  resultId: string;
  shape: "graph";
  coverage: CoverageStatus;
  coverageNotes: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  /** Edges before a cut. */
  total?: number;
  constructed?: true;
}

export type AnyResult = ResultSet | GraphResult;

/** One side of a change: what a capture holds, with its own citation, or the statement that it holds nothing and why. */
export interface ChangeSidePresent { value: Cell; bases: string[]; blockOrSlot: BlockOrSlot; evidenceIds: string[]; factIds?: string[]; asOf?: string | null }
export interface ChangeSideAbsent { absent: true; reason: string }
export type ChangeSide = ChangeSidePresent | ChangeSideAbsent;
export interface ChangeRow { kind: string; key: string; before: ChangeSide; after: ChangeSide; constructed?: true }
/** What differs between two captures. `captureIds` names both, the earlier first. */
export interface ChangesResult {
  resultId: string;
  shape: "changes";
  coverage: CoverageStatus;
  coverageNotes: string[];
  captureIds: string[];
  rows: ChangeRow[];
  truncated: boolean;
  total?: number;
  constructed?: true;
}
export type AnyResultV2 = AnyResult | ChangesResult;

/** A receipt as the data model of a second-catalog surface holds it under `/receipts/<id>`. */
export interface ReceiptRecord {
  id: string;
  source: string;
  responseSha256: string;
  blockOrSlot: BlockOrSlot;
  observedAt: string | null;
  historicalState: string | null;
  privacy: string;
  constructed?: true;
}
/** One capture on record for a subject, under `/meta/captures`. `evidenceIds` are the receipt ids of the capture. */
export interface CaptureRecord {
  id: string;
  observedFrom: string | null;
  observedTo: string | null;
  fromBlockOrSlot: BlockOrSlot;
  toBlockOrSlot: BlockOrSlot;
  facts: number;
  subjects: number;
  shown: boolean;
  constructed: boolean;
  source: string;
  evidenceIds: string[];
}
/** How an answer was produced, under `/meta/trace`. */
export interface TraceRecord {
  template: string;
  params: Record<string, Cell | string[]>;
  outcome: string;
  rowsReturned: number;
  reasons: { code: string; count: number }[];
}

export interface SurfaceMeta {
  title?: string;
  subjectId?: string;
  kind?: string;
  question?: string;
  protocolTitle?: string;
  snapshotIds: string[];
  fromBlockOrSlot?: BlockOrSlot;
  toBlockOrSlot?: BlockOrSlot;
  capturedAt?: string | null;
  constructed?: boolean;
  captures?: CaptureRecord[];
  trace?: TraceRecord;
}

export interface CoverageInput {
  mechanics: { mechanic: string; status: CoverageStatus; note: string }[];
  asked: string[];
}

export type Binding = { path: string };
export type ChildrenProp = string[] | { path: string; componentId: string };
export interface A2uiComponent { id: string; component: string; [prop: string]: unknown }

export type A2uiMessage =
  | { version: "v0.9.1"; createSurface: { surfaceId: string; catalogId: string } }
  | { version: "v0.9.1"; updateDataModel: { surfaceId: string; path: string; value: unknown } }
  | { version: "v0.9.1"; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: "v0.9.1"; deleteSurface: { surfaceId: string } };

/** One drawn element. `text` is drawn before the children. */
export interface UiNode { tag: string; attrs: Record<string, string>; text?: string; children: UiNode[] }
export interface UiError { code: string; componentId: string | null; message: string }
export interface SurfaceTree { surfaceId: string | null; deleted: boolean; root: UiNode; errors: UiError[] }

/** Rule codes V1 to V23, in rule order. V16 to V23 are reported for surfaces of the second catalog only. */
export type RuleCode =
  | "schema" | "unknown-component" | "literal-value" | "dangling-binding" | "uncited-row" | "unresolved-evidence"
  | "advice-word" | "number-in-text" | "text-too-long" | "missing-coverage-note" | "not-mapped-as-fact" | "structure"
  | "forbidden-action" | "edge-without-fact" | "section-title"
  | "uncited-receipt" | "change-side" | "reader-row" | "constructed-unmarked" | "count-mismatch" | "gap-without-reason"
  | "claimed-amount" | "trace-incomplete";

export interface ValidationFinding { rule: string; code: RuleCode; componentId: string | null; detail: string }
/** `codes` holds each code once, in rule order. */
export interface ValidationResult { ok: boolean; codes: RuleCode[]; findings: ValidationFinding[] }
export type ResolveEvidence = (ids: string[]) => { missing: string[] };

/** The kit's one refusal. `code` says why; `codes` carries the validator's rule codes when a surface was refused. */
export class UiRejected extends Error {
  readonly code: string;
  readonly codes: string[];
  constructor(code: string, codes?: string[]) {
    super(codes && codes.length > 0 ? `${code}: ${codes.join(", ")}` : code);
    this.name = "UiRejected";
    this.code = code;
    this.codes = codes ? [...codes] : [code];
  }
}
