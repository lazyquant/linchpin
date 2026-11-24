/**
 * The four closed tools a model may call. A tool names a protocol, a template and params that fit the template's
 * schema, and nothing else: no query text, no label, no property name. A failure goes back as a code.
 */
import { listViewTemplates } from "../ui/templates";
import { FORBIDDEN_PARAM_NAMES, RetrievalError, paramsMatch, type Coverage, type RetrievalBackend, type RetrievalResult } from "./retrieval";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; additionalProperties: false; required: string[]; properties: Record<string, { type: string; description: string }> };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

const SPECS: ToolSpec[] = [
  {
    name: "coverage",
    description: "Which mechanics the recorded snapshot maps for the protocol, each with its status and recorded note.",
    inputSchema: { type: "object", additionalProperties: false, required: ["protocol"], properties: { protocol: { type: "string", description: "The protocol id you were given." } } },
  },
  {
    name: "list_templates",
    description: "The retrieval templates of the protocol: id, question, params, columns, shape and what each cannot tell.",
    inputSchema: { type: "object", additionalProperties: false, required: ["protocol"], properties: { protocol: { type: "string", description: "The protocol id you were given." } } },
  },
  {
    name: "run_template",
    description: "Runs one retrieval template and returns its rows as a result with an id. Rows carry their bases, block or slot and evidence ids.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["protocol", "templateId"],
      properties: {
        protocol: { type: "string", description: "The protocol id you were given." },
        templateId: { type: "string", description: "A template id from list_templates." },
        params: { type: "object", description: "Params that fit the template's schema. Leave out when the template takes none." },
      },
    },
  },
  {
    name: "list_views",
    description: "The stored view templates that can draw a result: id, title, accepted shapes and one sentence.",
    inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
];

export const TOOL_SPECS: readonly ToolSpec[] = deepFreeze(SPECS);

export const TOOL_NAMES: readonly string[] = Object.freeze(TOOL_SPECS.map((spec) => spec.name));
/** Rows a template returns to one answer, at most. */
export const DEFAULT_MAX_ROWS = 50;

export type ToolErrorCode = "unknown-tool" | "invalid-params" | "unknown-template" | "tool-budget-exhausted" | "tool-failed";
export type ToolError = { error: ToolErrorCode };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (input: Record<string, unknown>, allowed: string[]): boolean => Object.keys(input).every((key) => allowed.includes(key));

/** A result as the model sees it: every row cut to its key, kind, values, bases, block or slot, time and evidence ids. */
function forModel(result: RetrievalResult): unknown {
  if (!Array.isArray(result.rows)) return result;
  return {
    ...result,
    rows: result.rows.map((row) => (isRecord(row)
      ? { key: row.key, rowKind: row.rowKind, values: row.values, bases: row.bases, blockOrSlot: row.blockOrSlot, asOf: row.asOf, evidenceIds: row.evidenceIds }
      : row)),
  };
}

/**
 * The tools of one answer. It keeps what the tools returned: the results in call order, numbered r1, r2 and so
 * on, and the mechanics list of the latest coverage call. A backend's result is passed on as it is.
 */
export class ToolSession {
  readonly results: RetrievalResult[] = [];
  readonly toolNames: string[] = [];
  readonly templateIds: string[] = [];
  mechanics: Coverage["mechanics"] = [];
  private readonly backend: RetrievalBackend;
  private readonly protocol: string;
  private readonly maxRows: number;

  constructor(options: { backend: RetrievalBackend; protocol: string; maxRows?: number }) {
    this.backend = options.backend;
    this.protocol = options.protocol;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  }

  /** Runs one tool call and returns what the model gets back. It never throws. */
  async call(name: string, input: unknown): Promise<unknown> {
    this.toolNames.push(typeof name === "string" ? name : "");
    try {
      if (!TOOL_NAMES.includes(name)) return fail("unknown-tool");
      const args = input === undefined || input === null ? {} : input;
      if (!isRecord(args)) return fail("invalid-params");
      if (name === "list_views") return onlyKeys(args, []) ? listViewTemplates() : fail("invalid-params");
      if (args.protocol !== this.protocol) return fail("invalid-params");
      if (name === "coverage") {
        if (!onlyKeys(args, ["protocol"])) return fail("invalid-params");
        const coverage = this.backend.coverage(this.protocol);
        this.mechanics = coverage.mechanics;
        return coverage;
      }
      if (name === "list_templates") return onlyKeys(args, ["protocol"]) ? this.backend.templates(this.protocol) : fail("invalid-params");

      if (!onlyKeys(args, ["protocol", "templateId", "params"]) || typeof args.templateId !== "string") return fail("invalid-params");
      const params = args.params === undefined ? {} : args.params;
      if (!isRecord(params) || Object.keys(params).some((key) => FORBIDDEN_PARAM_NAMES.includes(key))) return fail("invalid-params");
      const descriptor = this.backend.templates(this.protocol).find((candidate) => candidate.id === args.templateId);
      if (descriptor && !paramsMatch(descriptor.params, params)) return fail("invalid-params");
      const returned = await this.backend.run(this.protocol, args.templateId, params, { maxRows: this.maxRows });
      const result: RetrievalResult = { ...returned, resultId: `r${this.results.length + 1}` };
      this.results.push(result);
      this.templateIds.push(args.templateId);
      return forModel(result);
    } catch (error) {
      if (error instanceof RetrievalError && (error.code === "invalid-params" || error.code === "unknown-template")) return fail(error.code);
      return fail("tool-failed");
    }
  }
}

function fail(code: ToolErrorCode): ToolError {
  return { error: code };
}
