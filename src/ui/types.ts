/** Shared types of the UI kit: result rows, A2UI v0.9.1 messages, the drawn tree and the validator's result. */

export type Shape = "table" | "chain" | "path" | "unknowns" | "graph";
export type RowKind = "fact" | "path" | "scope" | "coverage" | "unknown";
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
}

export interface ResultSet {
  resultId: string;
  shape: "table" | "chain" | "path" | "unknowns";
  columns: { name: string; role: ColumnRole }[];
  coverage: CoverageStatus;
  coverageNotes: string[];
  rows: ResultRow[];
  truncated: boolean;
}

export interface GraphNode { id: string; label: string; isolated: boolean }

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
}

export interface GraphResult {
  resultId: string;
  shape: "graph";
  coverage: CoverageStatus;
  coverageNotes: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export type AnyResult = ResultSet | GraphResult;

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

/** Rule codes V1 to V15, in rule order. */
export type RuleCode =
  | "schema" | "unknown-component" | "literal-value" | "dangling-binding" | "uncited-row" | "unresolved-evidence"
  | "advice-word" | "number-in-text" | "text-too-long" | "missing-coverage-note" | "not-mapped-as-fact" | "structure"
  | "forbidden-action" | "edge-without-fact" | "section-title";

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
