/**
 * The retrieval interface: what a backend must give the answer agent. A backend returns rows that carry their
 * bases, their block or slot and their evidence ids; nothing downstream adds, merges or drops one of them.
 */
import type { EvidenceRecord } from "../tokenomics/api";
import type { ResultRow, ResultSet } from "../ui/types";

export type { ResultRow } from "../ui/types";

/** A free string: the basis words of the recorded bundles. */
export type BasisName = string;
export type Mechanic = "control" | "code-upgrade" | "supply" | "dependencies" | "parameters" | "fees" | "treasury" | "governance" | "holders" | "flows" | "claims";
export type CoverageStatus = "mapped" | "partial" | "not-mapped";
export type RowKind = "fact" | "path" | "scope" | "coverage" | "unknown";
export type ColumnRole = "subject" | "label" | "address" | "value" | "amount" | "unit" | "status" | "role" | "instruction" | "time" | "note";

/** The mechanics in their fixed order. */
export const MECHANICS: readonly Mechanic[] = Object.freeze(["control", "code-upgrade", "supply", "dependencies", "parameters", "fees", "treasury", "governance", "holders", "flows", "claims"]);

/** A JSON Schema subset. `additionalProperties` is always false. */
export type ParamSchema = {
  type: "object"; additionalProperties: false; required: string[];
  properties: Record<string, {
    type: "string" | "integer" | "boolean" | "array"; enum?: string[]; maxLength?: number; pattern?: string;
    minimum?: number; maximum?: number; items?: { type: "string"; enum?: string[] }; maxItems?: number;
  }>;
};

export type TemplateDescriptor = {
  /** Matches ^[a-z][a-z0-9-]{0,47}$ and is unique per backend. */
  id: string;
  /** Changes whenever rows for the same input can change. */
  version: string;
  title: string;
  question: string;
  /** `null` for a template that cuts across mechanics. */
  mechanic: Mechanic | null;
  /** Which catalog components may bind its result. */
  shape: "table" | "chain" | "path" | "unknowns";
  /** The protocol is not a param; `run` takes it. */
  params: ParamSchema;
  columns: { name: string; role: ColumnRole }[];
  /** One sentence: what this template does not establish. */
  cannotTell: string;
};

/** A result as a backend returns it: the kit's result set, and where it came from. */
export type RetrievalResult = ResultSet & {
  protocol: string;
  backend: { id: string; version: string; templatesSha256: string };
  templateId: string;
  templateVersion: string;
};

export type Coverage = {
  protocol: string;
  title: string;
  snapshotIds: string[];
  mechanics: { mechanic: Mechanic | "documentation"; status: CoverageStatus; note: string }[];
  subjects: { subjectId: string; readers: string[]; status: "complete" | "partial" | "failed" }[];
};

export interface RetrievalBackend {
  readonly id: string;
  readonly version: string;
  protocols(): { id: string; title: string }[];
  coverage(protocol: string): Coverage;
  templates(protocol: string): TemplateDescriptor[];
  /**
   * Runs one template. The result id a backend sets is a placeholder; the tool layer numbers the results of one
   * answer r1, r2, and so on.
   */
  run(protocol: string, templateId: string, params: Record<string, unknown>, options: { maxRows: number; asOf?: string }): Promise<RetrievalResult>;
  evidence(protocol: string, ids: string[]): Promise<{ items: EvidenceRecord[]; missing: string[] }>;
}

export type RetrievalErrorCode = "invalid-params" | "unknown-template" | "as-of-unsupported";

/** The one refusal of a backend. It carries a code and no detail. */
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode) {
    super(code);
    this.name = "RetrievalError";
    this.code = code;
  }
}

/** Param names a template may never declare and a caller may never send: nothing here takes a query fragment. */
export const FORBIDDEN_PARAM_NAMES: readonly string[] = Object.freeze(["cypher", "query", "label", "property", "where"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `params` satisfies the schema: a plain object, declared names only, every required name, every value of its type. */
export function paramsMatch(schema: ParamSchema, params: unknown): params is Record<string, unknown> {
  if (!isRecord(params)) return false;
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_PARAM_NAMES.includes(key)) return false;
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return false;
  }
  for (const name of schema.required) if (!Object.prototype.hasOwnProperty.call(params, name)) return false;
  for (const [name, value] of Object.entries(params)) {
    const spec = schema.properties[name];
    if (spec.type === "string") {
      if (typeof value !== "string") return false;
      if (spec.maxLength !== undefined && [...value].length > spec.maxLength) return false;
      if (spec.enum && !spec.enum.includes(value)) return false;
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, "u").test(value)) return false;
    } else if (spec.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
      if (spec.minimum !== undefined && value < spec.minimum) return false;
      if (spec.maximum !== undefined && value > spec.maximum) return false;
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") return false;
    } else {
      if (!Array.isArray(value)) return false;
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return false;
      for (const item of value) {
        if (typeof item !== "string") return false;
        if (spec.items?.enum && !spec.items.enum.includes(item)) return false;
      }
    }
  }
  return true;
}

/** A result without the four fields a backend adds: the kit's result set, in the kit's key order. */
export function kitResult(result: RetrievalResult): ResultSet {
  return {
    resultId: result.resultId, shape: result.shape, columns: result.columns, coverage: result.coverage,
    coverageNotes: result.coverageNotes, rows: result.rows as ResultRow[], truncated: result.truncated,
  };
}
