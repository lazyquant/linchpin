/**
 * The validator: rules V1 to V15 over a message list. It refuses a surface whose values are not bound to cited
 * rows. It never throws; malformed input is a result with codes.
 */
import { CATALOG } from "./catalog";
import { A2UI_VERSION, MESSAGE_KEYS, isRecord, pointerGet, readSurface } from "./messages";
import { TEXT_RULE_WORDS } from "./strings";
import type { CoverageInput, ResolveEvidence, RuleCode, ValidationFinding, ValidationResult } from "./types";

const RULES: readonly RuleCode[] = [
  "schema", "unknown-component", "literal-value", "dangling-binding", "uncited-row", "unresolved-evidence",
  "advice-word", "number-in-text", "text-too-long", "missing-coverage-note", "not-mapped-as-fact", "structure",
  "forbidden-action", "edge-without-fact", "section-title",
];
const MAX_COMPONENTS = 60;
const VALUE_COMPONENTS = new Set(["FactTable", "ControlChain", "ValuePath", "UnknownList", "DependencyGraph", "Timeline"]);
const CITED_ROW_KINDS = new Set(["fact", "path", "unknown"]);

/** A resolver over a fixed set of receipt ids: every id outside the set is reported missing. */
export function receiptResolver(receiptIds: Iterable<string>): ResolveEvidence {
  const known = new Set(receiptIds);
  return (ids) => ({ missing: ids.filter((id) => !known.has(id)) });
}

function wordPattern(word: string): RegExp {
  const body = word.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}($|[^\\p{L}\\p{N}])`, "iu");
}
const TEXT_RULE_PATTERNS = TEXT_RULE_WORDS.map(wordPattern);
const hasRuleWord = (text: string): boolean => TEXT_RULE_PATTERNS.some((pattern) => pattern.test(text));
const hasDigit = (text: string): boolean => /\p{N}/u.test(text);
const length = (text: string): number => [...text].length;

function isBinding(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string" && Object.keys(value).length === 1;
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
/** A citation list: at least one member, and every member a non-empty string. Anything else cites nothing. */
const isCitationList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "");

export function validateSurface(messages: unknown, opts: { resolveEvidence: ResolveEvidence; coverage?: CoverageInput }): ValidationResult {
  const findings: ValidationFinding[] = [];
  const report = (code: RuleCode, componentId: string | null, detail: string): void => {
    findings.push({ rule: `V${RULES.indexOf(code) + 1}`, code, componentId, detail });
  };
  try {
    check(messages, opts, report);
  } catch {
    report("schema", null, "the surface could not be read");
  }
  const codes = RULES.filter((code) => findings.some((finding) => finding.code === code));
  return { ok: findings.length === 0, codes, findings };
}

type Report = (code: RuleCode, componentId: string | null, detail: string) => void;

/** V1: the message list itself. Returns false when it has a schema finding. */
function checkSchema(messages: unknown, report: Report): boolean {
  if (!Array.isArray(messages)) {
    report("schema", null, "the messages are not a list");
    return false;
  }
  let ok = true;
  let created = false;
  const bad = (detail: string): void => { ok = false; report("schema", null, detail); };
  messages.forEach((message, at) => {
    const where = `message ${at}`;
    if (!isRecord(message)) return bad(`${where} is not an object`);
    if (message.version !== A2UI_VERSION) return bad(`${where} has no version ${A2UI_VERSION}`);
    const keys = Object.keys(message).filter((key) => key !== "version");
    if (keys.length !== 1 || !(MESSAGE_KEYS as readonly string[]).includes(keys[0])) return bad(`${where} does not hold exactly one message`);
    const body = message[keys[0]];
    if (!isRecord(body)) return bad(`${where} has no body`);
    if (typeof body.surfaceId !== "string" || body.surfaceId === "") return bad(`${where} has no surfaceId`);
    if (keys[0] === "createSurface") {
      created = true;
      if (body.catalogId !== CATALOG.id) return bad(`${where} names another catalog`);
    } else if (keys[0] === "updateDataModel") {
      if (typeof body.path !== "string" || !body.path.startsWith("/")) return bad(`${where} has no path starting with /`);
    } else if (keys[0] === "updateComponents") {
      if (!Array.isArray(body.components)) return bad(`${where} has no component list`);
      for (const component of body.components) {
        if (!isRecord(component) || typeof component.id !== "string" || typeof component.component !== "string") return bad(`${where} holds a component without a string id and component`);
      }
    }
  });
  if (ok && !created) bad("no createSurface message");
  return ok;
}

interface Bound { componentId: string; component: string }

function check(messages: unknown, opts: { resolveEvidence?: ResolveEvidence; coverage?: CoverageInput } | undefined, report: Report): void {
  if (!checkSchema(messages, report)) return;
  const state = readSurface(messages);
  const components = state.components;
  const model = state.model;

  // V12, the parts that need no walk.
  let structureOk = true;
  const structure = (componentId: string | null, detail: string): void => { structureOk = false; report("structure", componentId, detail); };
  if (state.surfaceIds.length > 1) structure(null, "more than one surface id");
  for (const id of state.duplicateIds) structure(id, "duplicate component id");
  if (components.size > MAX_COMPONENTS) structure(null, `more than ${MAX_COMPONENTS} components`);
  if (!components.has("root")) structure(null, "no component with id root");

  const boundResults = new Map<string, Bound[]>();
  const boundMechanics = new Set<number>();
  const childIds = new Map<string, string[]>();

  // Per component: V2, V3, V4, V7 to V9, V13, V15.
  for (const [id, component] of components) {
    const spec = Object.prototype.hasOwnProperty.call(CATALOG.components, component.component) ? CATALOG.components[component.component] : undefined;
    if (!spec) {
      report("unknown-component", id, "component is not in the catalog");
      continue;
    }
    const name = component.component;
    for (const key of Object.keys(component)) {
      if (key === "id" || key === "component") continue;
      if (key === "action") report("forbidden-action", id, "action prop");
      else if (!Object.prototype.hasOwnProperty.call(spec.props, key)) report("unknown-component", id, "prop is not defined for this component");
    }
    for (const [prop, propSpec] of Object.entries(spec.props)) {
      const present = Object.prototype.hasOwnProperty.call(component, prop);
      if (!present) {
        if (propSpec.required) report("unknown-component", id, `required prop ${prop} is missing`);
        continue;
      }
      const value = component[prop];
      if (propSpec.kind === "B") {
        if (!isBinding(value)) {
          report("literal-value", id, `${prop} is not a binding`);
          continue;
        }
        checkBinding(prop, value.path, { componentId: id, component: name }, component, model, boundResults, boundMechanics, report);
      } else if (propSpec.kind === "children") {
        if (Array.isArray(value) && value.every((child) => typeof child === "string")) childIds.set(id, value as string[]);
        else if (isRecord(value) && typeof value.path === "string" && typeof value.componentId === "string") {
          childIds.set(id, [value.componentId]);
          if (!Array.isArray(pointerGet(model, value.path))) report("dangling-binding", id, "children path names no list in the data model");
        } else structure(id, "children is neither a list of ids nor a template");
      } else if (name === "Section" && prop === "title") {
        if (typeof value !== "string" || length(value) > (propSpec.maxLength ?? 80) || hasDigit(value) || hasRuleWord(value)) report("section-title", id, "title is not a short plain title");
      } else if (prop === "columns") {
        if (!Array.isArray(value) || value.some((column) => typeof column !== "string")) report("unknown-component", id, "columns is not a list of names");
      } else {
        if (typeof value !== "string") {
          report("unknown-component", id, `${prop} is not text`);
          continue;
        }
        if (hasRuleWord(value)) report("advice-word", id, `${prop} holds a word of the text rule list`);
        if (hasDigit(value)) report("number-in-text", id, `${prop} holds a digit`);
        if (propSpec.maxLength !== undefined && length(value) > propSpec.maxLength) report("text-too-long", id, `${prop} is over ${propSpec.maxLength} characters`);
      }
    }
    if (name === "CoverageNote") {
      const has = (prop: string): boolean => Object.prototype.hasOwnProperty.call(component, prop);
      if (has("result") === has("coverage")) report("unknown-component", id, "CoverageNote takes exactly one of result and coverage");
    }
  }

  // V12, the walk from root: a child that does not exist, a cycle.
  if (structureOk) {
    const state2 = new Map<string, 1 | 2>();
    const walk = (id: string): void => {
      state2.set(id, 1);
      for (const child of childIds.get(id) ?? []) {
        if (!components.has(child)) structure(id, "a child id does not exist");
        else if (state2.get(child) === 1) structure(id, "the components form a cycle");
        else if (state2.get(child) === undefined) walk(child);
      }
      state2.set(id, 2);
    };
    walk("root");
  }

  // Bound results: V5, V14, and the evidence ids for V6.
  const results = pointerGet(model, "/results");
  const evidenceIds: string[] = [];
  // The ids asked of the resolver are the ids the renderer draws: every string or number member, as text.
  const cite = (ids: unknown): void => {
    for (const member of Array.isArray(ids) ? ids : []) {
      if (typeof member !== "string" && typeof member !== "number") continue;
      const id = String(member);
      if (!evidenceIds.includes(id)) evidenceIds.push(id);
    }
  };
  for (const [resultId, binders] of boundResults) {
    const result = isRecord(results) ? results[resultId] : undefined;
    if (!isRecord(result)) continue;
    const first = binders[0].componentId;
    if (result.shape === "graph") {
      for (const edge of Array.isArray(result.edges) ? result.edges : []) {
        if (!isRecord(edge)) continue;
        if (!isCitationList(edge.bases) || !isCitationList(edge.evidenceIds)) report("edge-without-fact", first, "a graph edge has no basis or no evidence, or holds one that is not a non-empty string");
        cite(edge.evidenceIds);
      }
      continue;
    }
    for (const row of Array.isArray(result.rows) ? result.rows : []) {
      if (!isRecord(row)) continue;
      if (row.rowKind === "scope") {
        if (typeof row.scopeSource !== "string" || row.scopeSource === "") report("uncited-row", first, "a scope row has no scopeSource");
      } else if (row.rowKind === "coverage") {
        const other = binders.find((binder) => binder.component !== "CoverageNote");
        if (other) report("uncited-row", other.componentId, "a coverage row is bound to a value component");
      } else if (CITED_ROW_KINDS.has(row.rowKind as string)) {
        if (!isCitationList(row.evidenceIds) || !isCitationList(row.bases)) report("uncited-row", first, "a row has no evidence id or no basis, or holds one that is not a non-empty string");
      } else report("uncited-row", first, "a row has no known kind");
      cite(row.evidenceIds);
    }
  }

  // V6.
  if (evidenceIds.length > 0) {
    let missing: string[] | null = null;
    try {
      const answer = typeof opts?.resolveEvidence === "function" ? opts.resolveEvidence([...evidenceIds]) : null;
      if (isRecord(answer) && Array.isArray(answer.missing)) missing = strings(answer.missing);
    } catch {
      missing = null;
    }
    if (missing === null) report("unresolved-evidence", null, "the evidence could not be resolved");
    else for (const id of evidenceIds) if (missing.includes(id)) report("unresolved-evidence", null, `evidence id ${id} is missing`);
  }

  // V10 and V11, over every result of the data model.
  if (isRecord(results)) {
    for (const [resultId, result] of Object.entries(results)) {
      if (!isRecord(result)) continue;
      const binders = boundResults.get(resultId) ?? [];
      const noted = binders.some((binder) => binder.component === "CoverageNote");
      const drawn = binders.filter((binder) => binder.component !== "CoverageNote");
      if (result.coverage === "not-mapped") {
        if (!noted) report("missing-coverage-note", null, `result ${resultId} is not mapped and no CoverageNote shows it`);
        for (const binder of drawn) report("not-mapped-as-fact", binder.componentId, `result ${resultId} is not mapped and is bound to a value component`);
      } else if (result.coverage === "partial" && !noted && !drawn.some((binder) => VALUE_COMPONENTS.has(binder.component))) {
        report("missing-coverage-note", null, `result ${resultId} is partly mapped and nothing shows it`);
      }
    }
  }
  const coverage = opts?.coverage;
  if (isRecord(coverage) && Array.isArray(coverage.mechanics) && Array.isArray(coverage.asked)) {
    coverage.mechanics.forEach((mechanic, n) => {
      if (isRecord(mechanic) && mechanic.status === "not-mapped" && coverage.asked.includes(mechanic.mechanic as string) && !boundMechanics.has(n)) {
        report("missing-coverage-note", null, "an asked mechanic is not mapped and no CoverageNote shows it");
      }
    });
  }
}

/** V4 for one binding, and the record of what it binds. */
function checkBinding(
  prop: string, path: string, binder: Bound, component: Record<string, unknown>, model: unknown,
  boundResults: Map<string, Bound[]>, boundMechanics: Set<number>, report: Report,
): void {
  const dangling = (detail: string): void => report("dangling-binding", binder.componentId, detail);
  if (prop === "meta") {
    if (path !== "/meta") return dangling("meta is not bound to /meta");
    if (!isRecord(pointerGet(model, path))) return dangling("the data model has no /meta");
    return;
  }
  if (prop === "coverage") {
    const match = /^\/coverage\/mechanics\/(0|[1-9][0-9]*)$/.exec(path);
    if (!match) return dangling("coverage is not bound to /coverage/mechanics/<n>");
    if (!isRecord(pointerGet(model, path))) return dangling("the data model has no such mechanic");
    boundMechanics.add(Number(match[1]));
    return;
  }
  const match = /^\/results\/([^/]+)$/.exec(path);
  if (!match) return dangling("result is not bound to /results/<id>");
  const result = pointerGet(model, path);
  if (!isRecord(result)) return dangling("the data model has no such result");
  const resultId = match[1].replace(/~1/g, "/").replace(/~0/g, "~");
  if (!boundResults.has(resultId)) boundResults.set(resultId, []);
  boundResults.get(resultId)!.push(binder);

  const spec = CATALOG.components[binder.component].props[prop];
  const shape = result.shape;
  if (spec.accepts && !(spec.accepts as string[]).includes(shape as string)) return dangling("the component does not accept the shape of this result");
  if (shape === "graph") {
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) return dangling("the graph result has no nodes or no edges");
    const ids = new Set(result.nodes.map((node) => (isRecord(node) ? node.id : undefined)));
    for (const edge of result.edges) {
      if (!isRecord(edge) || !ids.has(edge.from) || !ids.has(edge.to)) return dangling("a graph edge ends at no node");
    }
    return;
  }
  if (!Array.isArray(result.rows)) return dangling("the result has no rows");
  const columns = Array.isArray(result.columns) ? result.columns.filter(isRecord) : [];
  if (binder.component === "Timeline" && !columns.some((column) => column.role === "time")) return dangling("the result has no column of role time");
  if (binder.component === "FactTable" && Array.isArray(component.columns)) {
    const names = new Set(columns.map((column) => column.name));
    if (component.columns.some((column) => typeof column === "string" && !names.has(column))) dangling("a chosen column is not a column of the result");
  }
}
