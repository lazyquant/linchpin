/**
 * The validator: rules V1 to V15 over a message list, and V16 to V23 for a surface of the second catalog. It refuses
 * a surface whose values are not bound to cited rows. It never throws; malformed input is a result with codes.
 */
import { CATALOG } from "./catalog";
import { CATALOG_V2, CLAIM_COLUMNS, GAP_REASONS, POSITION_COLUMNS } from "./catalog-v2";
import { A2UI_VERSION, MESSAGE_KEYS, isRecord, pointerGet, readSurface } from "./messages";
import { TEXT_RULE_WORDS } from "./strings";
import type { CoverageInput, ResolveEvidence, RuleCode, ValidationFinding, ValidationResult } from "./types";

const RULES: readonly RuleCode[] = [
  "schema", "unknown-component", "literal-value", "dangling-binding", "uncited-row", "unresolved-evidence",
  "advice-word", "number-in-text", "text-too-long", "missing-coverage-note", "not-mapped-as-fact", "structure",
  "forbidden-action", "edge-without-fact", "section-title",
  "uncited-receipt", "change-side", "reader-row", "constructed-unmarked", "count-mismatch", "gap-without-reason",
  "claimed-amount", "trace-incomplete",
];
const MAX_COMPONENTS = 60;
const VALUE_COMPONENTS = new Set(["FactTable", "ControlChain", "ValuePath", "UnknownList", "DependencyGraph", "Timeline"]);
const VALUE_COMPONENTS_V2 = new Set([
  ...VALUE_COMPONENTS, "GraphExplorer", "FactCard", "ReceiptCard", "AnswerPath", "FindingList", "ClaimCheck", "ChangeList",
  "PositionList", "CaptureList", "GapList", "QueryTrace",
]);
const CITED_ROW_KINDS = new Set(["fact", "path", "unknown"]);
const GAP_ENDS = new Set(["none", "unknown"]);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const unescapeToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

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
      if (body.catalogId !== CATALOG.id && body.catalogId !== CATALOG_V2.id) return bad(`${where} names another catalog`);
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

/** What the bindings of a second-catalog surface name besides results. */
interface BoundV2 {
  rows: { row: unknown; binder: Bound }[];
  receipts: { record: Record<string, unknown>; binder: Bound }[];
  captures: { list: unknown[]; binder: Bound }[];
  traces: { record: Record<string, unknown>; binder: Bound }[];
  counts: { resultId: string; binder: Bound }[];
}

/** The catalog id of the first `createSurface` message decides which catalog a surface is checked against. */
function catalogIdOf(messages: unknown[]): unknown {
  for (const message of messages) {
    if (isRecord(message) && isRecord(message.createSurface)) return message.createSurface.catalogId;
  }
  return undefined;
}

function check(messages: unknown, opts: { resolveEvidence?: ResolveEvidence; coverage?: CoverageInput } | undefined, report: Report): void {
  if (!checkSchema(messages, report)) return;
  const v2 = catalogIdOf(messages as unknown[]) === CATALOG_V2.id;
  const catalog: { components: Record<string, { props: Record<string, { kind: string; required: boolean; accepts?: string[]; maxLength?: number }> }> } = v2 ? CATALOG_V2 : CATALOG;
  const more: BoundV2 = { rows: [], receipts: [], captures: [], traces: [], counts: [] };
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
    const spec = Object.prototype.hasOwnProperty.call(catalog.components, component.component) ? catalog.components[component.component] : undefined;
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
        if (v2 && checkBindingV2(prop, value.path, { componentId: id, component: name }, model, more, report)) continue;
        checkBinding(prop, value.path, { componentId: id, component: name }, component, model, boundResults, boundMechanics, report, catalog.components[name].props[prop].accepts);
      } else if (propSpec.kind === "children") {
        if (Array.isArray(value) && value.every((child) => typeof child === "string")) childIds.set(id, value as string[]);
        else if (isRecord(value) && typeof value.path === "string" && typeof value.componentId === "string") {
          childIds.set(id, [value.componentId]);
          if (!Array.isArray(pointerGet(model, value.path))) report("dangling-binding", id, "children path names no list in the data model");
        } else structure(id, "children is neither a list of ids nor a template");
      } else if (name === "GraphExplorer") {
        checkExplorerLiteral(prop, value, id, report);
      } else if ((name === "Section" || name === "Disclosure") && prop === "title") {
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
  const asked = new Set<string>();
  // The ids asked of the resolver are the ids the renderer draws: every string or number member, as text.
  const cite = (ids: unknown): void => {
    for (const member of Array.isArray(ids) ? ids : []) {
      if (typeof member !== "string" && typeof member !== "number") continue;
      const id = String(member);
      if (asked.has(id)) continue;
      asked.add(id);
      evidenceIds.push(id);
    }
  };
  const marked = v2 && pointerGet(model, "/meta/constructed") === true;
  const constructedCheck = (holder: Record<string, unknown>, componentId: string, what: string): void => {
    if (v2 && holder.constructed === true && !marked) report("constructed-unmarked", componentId, `${what} is constructed and the surface meta does not say so`);
  };
  /** V5 for one row, with the row kinds and the component rules of the second catalog. */
  const checkRow = (row: Record<string, unknown>, binders: Bound[]): void => {
    const first = binders[0].componentId;
    const gapList = v2 ? binders.find((binder) => binder.component === "GapList") : undefined;
    const positions = v2 ? binders.find((binder) => binder.component === "PositionList") : undefined;
    if (row.rowKind === "scope") {
      if (!isText(row.scopeSource)) {
        if (gapList) report("gap-without-reason", gapList.componentId, "a gap row has no source");
        else report("uncited-row", first, "a scope row has no scopeSource");
      }
    } else if (row.rowKind === "coverage") {
      const other = binders.find((binder) => binder.component !== "CoverageNote");
      if (other) report("uncited-row", other.componentId, "a coverage row is bound to a value component");
    } else if (v2 && row.rowKind === "reader") {
      if (!positions && (!isCitationList(row.evidenceIds) || !isText(row.source))) report("uncited-row", first, "a reader row has no evidence id or no source");
    } else if (CITED_ROW_KINDS.has(row.rowKind as string)) {
      if (!isCitationList(row.evidenceIds) || !isCitationList(row.bases)) report("uncited-row", first, "a row has no evidence id or no basis, or holds one that is not a non-empty string");
    } else report("uncited-row", first, "a row has no known kind");
    cite(row.evidenceIds);
    if (!v2) return;
    constructedCheck(row, first, "a row");
    if (positions && (row.rowKind !== "reader" || !isCitationList(row.evidenceIds) || !isText(row.source) || !isText(row.scopeSource))) {
      report("reader-row", positions.componentId, "a position row is not a reader row with evidence, a source and the source of its join");
    }
    if (gapList && !GAP_REASONS.includes(row.reason as string)) report("gap-without-reason", gapList.componentId, "a gap row has no reason word");
    const path = binders.find((binder) => binder.component === "AnswerPath" || binder.component === "ValuePath");
    if (path && isRecord(row.values)) {
      const amount = row.values.amount;
      const hasAmount = (typeof amount === "string" && amount !== "") || typeof amount === "number" || typeof amount === "boolean";
      const status = row.values.status;
      const claimedOnly = typeof status === "string" && status !== "" ? status === "claimed-only" : Array.isArray(row.bases) && row.bases.length === 1 && row.bases[0] === "claimed";
      if (hasAmount && claimedOnly) report("claimed-amount", path.componentId, "a link that is claimed only carries an amount");
    }
  };
  /** V17 for one side of a change row. Returns false when the side is neither cited nor absent with a reason. */
  const sideOk = (side: unknown): boolean => {
    if (!isRecord(side)) return false;
    if (side.absent === true) return isText(side.reason);
    cite(side.evidenceIds);
    return isCitationList(side.bases) && isCitationList(side.evidenceIds);
  };
  for (const [resultId, binders] of boundResults) {
    const result = isRecord(results) ? results[resultId] : undefined;
    if (!isRecord(result)) continue;
    const first = binders[0].componentId;
    if (v2) {
      constructedCheck(result, first, "a result");
      const size = result.shape === "graph" ? (Array.isArray(result.edges) ? result.edges.length : 0) : Array.isArray(result.rows) ? result.rows.length : 0;
      if (result.truncated === true) {
        if (!isWhole(result.total) || result.total < size) report("count-mismatch", first, "a cut result does not state a total that covers its rows");
      } else if (result.total !== undefined && result.total !== size) report("count-mismatch", first, "the total of a result differs from its rows");
    }
    if (result.shape === "graph") {
      for (const edge of Array.isArray(result.edges) ? result.edges : []) {
        if (!isRecord(edge)) continue;
        if (!isCitationList(edge.bases) || !isCitationList(edge.evidenceIds)) report("edge-without-fact", first, "a graph edge has no basis or no evidence, or holds one that is not a non-empty string");
        cite(edge.evidenceIds);
      }
      continue;
    }
    if (v2 && result.shape === "changes") {
      if (!Array.isArray(result.captureIds) || result.captureIds.filter(isText).length < 2) report("change-side", first, "a changes result names fewer than two captures");
      for (const row of Array.isArray(result.rows) ? result.rows : []) {
        if (!isRecord(row)) continue;
        const before = sideOk(row.before);
        const after = sideOk(row.after);
        if (!before || !after) report("change-side", first, "a side of a change has neither a citation nor a reason for its absence");
        constructedCheck(row, first, "a change row");
      }
      continue;
    }
    for (const row of Array.isArray(result.rows) ? result.rows : []) {
      if (isRecord(row)) checkRow(row, binders);
    }
  }

  // The second catalog: rows, receipts, captures, traces and counts bound outside a result binding.
  if (v2) {
    for (const { row, binder } of more.rows) {
      if (isRecord(row)) checkRow(row, [binder]);
    }
    for (const { list, binder } of more.captures) {
      for (const capture of list) {
        if (!isRecord(capture)) continue;
        if (!isCitationList(capture.evidenceIds) || !isText(capture.source)) report("uncited-row", binder.componentId, "a capture has no evidence id or no source");
        cite(capture.evidenceIds);
        constructedCheck(capture, binder.componentId, "a capture");
      }
    }
    // V16. A receipt the resolver does not know is reported here alone, not as V6.
    const receiptIds = more.receipts.map(({ record }) => record.id).filter(isText);
    let missingReceipts: string[] | null = [];
    if (receiptIds.length > 0) {
      try {
        const answer = typeof opts?.resolveEvidence === "function" ? opts.resolveEvidence([...new Set(receiptIds)]) : null;
        missingReceipts = isRecord(answer) && Array.isArray(answer.missing) ? strings(answer.missing) : null;
      } catch {
        missingReceipts = null;
      }
    }
    for (const { record, binder } of more.receipts) {
      if (!isText(record.source) || !isText(record.responseSha256) || !isText(record.privacy)) report("uncited-receipt", binder.componentId, "a receipt has no source, no response sha256 or no privacy");
      else if (missingReceipts === null || missingReceipts.includes(record.id as string)) report("uncited-receipt", binder.componentId, "the receipt id could not be resolved");
      constructedCheck(record, binder.componentId, "a receipt");
    }
    // V23.
    for (const { record, binder } of more.traces) {
      if (!isText(record.template) || !isText(record.outcome) || !isWhole(record.rowsReturned)) report("trace-incomplete", binder.componentId, "a trace has no template, no outcome or no count of rows returned");
    }
    // V4 and V20 for Disclosure.count: the result is bound inside the Disclosure, and the number equals its rows.
    for (const { resultId, binder } of more.counts) {
      const inside = new Set<string>();
      const walk = (id: string): void => {
        for (const child of childIds.get(id) ?? []) {
          if (inside.has(child)) continue;
          inside.add(child);
          walk(child);
        }
      };
      walk(binder.componentId);
      const result = isRecord(results) ? results[resultId] : undefined;
      if (!isRecord(result) || !(boundResults.get(resultId) ?? []).some((bound) => inside.has(bound.componentId))) {
        report("dangling-binding", binder.componentId, "count names a result that no component inside the Disclosure binds");
        continue;
      }
      const size = result.shape === "graph" ? (Array.isArray(result.edges) ? result.edges.length : 0) : Array.isArray(result.rows) ? result.rows.length : 0;
      if (result.truncated !== true && result.total !== size) report("count-mismatch", binder.componentId, "the count of a Disclosure differs from the rows inside it");
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
    else if (missing.length > 0) {
      const gone = new Set(missing);
      for (const id of evidenceIds) if (gone.has(id)) report("unresolved-evidence", null, `evidence id ${id} is missing`);
    }
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
      } else if (result.coverage === "partial" && !noted && !drawn.some((binder) => (v2 ? VALUE_COMPONENTS_V2 : VALUE_COMPONENTS).has(binder.component))) {
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
  boundResults: Map<string, Bound[]>, boundMechanics: Set<number>, report: Report, accepts: readonly string[] | undefined,
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
  const resultId = unescapeToken(match[1]);
  if (!boundResults.has(resultId)) boundResults.set(resultId, []);
  boundResults.get(resultId)!.push(binder);

  const shape = result.shape;
  if (accepts && !accepts.includes(shape as string)) return dangling("the component does not accept the shape of this result");
  if (shape === "graph") {
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) return dangling("the graph result has no nodes or no edges");
    const ids = new Set(result.nodes.map((node) => (isRecord(node) ? node.id : undefined)));
    for (const edge of result.edges) {
      const gapEnd = binder.component === "GraphExplorer" && isRecord(edge) && GAP_ENDS.has(edge.to as string);
      if (!isRecord(edge) || !ids.has(edge.from) || (!ids.has(edge.to) && !gapEnd)) return dangling("a graph edge ends at no node");
    }
    if (binder.component === "GraphExplorer" && typeof component.focus === "string" && !ids.has(component.focus)) return dangling("focus is not a node of the result");
    return;
  }
  if (!Array.isArray(result.rows)) return dangling("the result has no rows");
  const columns = Array.isArray(result.columns) ? result.columns.filter(isRecord) : [];
  if (binder.component === "Timeline" && !columns.some((column) => column.role === "time")) return dangling("the result has no column of role time");
  const named = (wanted: readonly string[]): boolean => wanted.every((name) => columns.some((column) => column.name === name));
  if (binder.component === "FindingList" && !(columns.some((column) => column.role === "note") && columns.some((column) => column.role === "status"))) return dangling("the result has no column of role note or none of role status");
  if (binder.component === "ClaimCheck" && !named(CLAIM_COLUMNS)) return dangling("the result lacks a column a claim check reads");
  if (binder.component === "PositionList" && !named(POSITION_COLUMNS)) return dangling("the result lacks a column a position list reads");
  if (binder.component === "FactTable" && Array.isArray(component.columns)) {
    const names = new Set(columns.map((column) => column.name));
    if (component.columns.some((column) => typeof column === "string" && !names.has(column))) dangling("a chosen column is not a column of the result");
  }
}

/** V2 for the literal props of a GraphExplorer. Whether `focus` names a node is checked with the binding (V4). */
function checkExplorerLiteral(prop: string, value: unknown, id: string, report: Report): void {
  if (prop === "focus") {
    if (typeof value !== "string") report("unknown-component", id, "focus is not a node id");
  } else if (prop === "steps") {
    if (value !== 1 && value !== 2 && value !== 3) report("unknown-component", id, "steps is not one, two or three");
  } else if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) report("unknown-component", id, `${prop} is not a list of names`);
}

/**
 * V4 for the bindings only the second catalog has. Returns true when the prop was one of them, so the caller does
 * not read it as a result binding.
 */
function checkBindingV2(prop: string, path: string, binder: Bound, model: unknown, more: BoundV2, report: Report): boolean {
  const dangling = (detail: string): true => {
    report("dangling-binding", binder.componentId, detail);
    return true;
  };
  if (binder.component === "FactCard" && prop === "fact") {
    if (!/^\/results\/[^/]+\/rows\/(0|[1-9][0-9]*)$/.test(path)) return dangling("fact is not bound to /results/<id>/rows/<n>");
    const row = pointerGet(model, path);
    if (!isRecord(row)) return dangling("the data model has no such row");
    more.rows.push({ row, binder });
    return true;
  }
  if (binder.component === "ReceiptCard" && prop === "receipt") {
    const match = /^\/receipts\/([^/]+)$/.exec(path);
    if (!match) return dangling("receipt is not bound to /receipts/<id>");
    const record = pointerGet(model, path);
    if (!isRecord(record) || record.id !== unescapeToken(match[1])) return dangling("the data model has no receipt with that id");
    more.receipts.push({ record, binder });
    return true;
  }
  if (binder.component === "CaptureList" && prop === "captures") {
    if (path !== "/meta/captures") return dangling("captures is not bound to /meta/captures");
    const list = pointerGet(model, path);
    if (!Array.isArray(list)) return dangling("the data model has no list of captures");
    more.captures.push({ list, binder });
    return true;
  }
  if (binder.component === "QueryTrace" && prop === "trace") {
    if (path !== "/meta/trace") return dangling("trace is not bound to /meta/trace");
    const record = pointerGet(model, path);
    if (!isRecord(record)) return dangling("the data model has no trace");
    more.traces.push({ record, binder });
    return true;
  }
  if (binder.component === "Disclosure" && prop === "count") {
    const match = /^\/results\/([^/]+)\/total$/.exec(path);
    if (!match) return dangling("count is not bound to /results/<id>/total");
    if (!isWhole(pointerGet(model, path))) return dangling("the data model has no whole number there");
    more.counts.push({ resultId: unescapeToken(match[1]), binder });
    return true;
  }
  return false;
}
