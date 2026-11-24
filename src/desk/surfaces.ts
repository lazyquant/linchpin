/**
 * The desk's views as kit surfaces. Each builder is pure: the same state gives the same messages. A row cites the
 * receipts of the facts it rests on; a row that rests on no fact is a scope row and says where it comes from.
 * Nothing here draws: the kit's validator decides whether a surface is served, and the kit draws it.
 */
import type { EvidenceReceipt, Fact } from "../engine/contracts";
import { ruleSubjects, type WatchEvent } from "../near/private/watch";
import type { Outcome, PublicRuleResult, RuleSpec } from "../policy/types";
import { graphResult } from "../ui/adapters";
import { MAX_GRAPH_NODES } from "../ui/graph-layout";
import { interpret } from "../ui/interpret";
import { createSurface, updateComponents, updateDataModel } from "../ui/messages";
import type { A2uiComponent, A2uiMessage, AnyResult, BlockOrSlot, Cell, ColumnRole, GraphMark, GraphResult, ResultRow, ResultSet, SurfaceMeta } from "../ui/types";
import { receiptResolver, validateSurface } from "../ui/validate";
import { sentenceFor } from "./sentences";
import { factIndex, nearPositions, publicReceiptIds, type DeskState } from "./state";
import { DESK_STRINGS as S, DESK_TEXT as T } from "./strings";

export const DESK_VIEWS = ["verdict", "map", "words", "changes", "unknowns"] as const;
export type DeskView = (typeof DESK_VIEWS)[number];
export const isDeskView = (value: string): value is DeskView => (DESK_VIEWS as readonly string[]).includes(value);

export type NodeOutcome = Outcome | "no-rule";
/** The kit mark a node carries for the worst outcome among the rules that name it. */
export const MARK_OF_OUTCOME: Readonly<Record<NodeOutcome, GraphMark>> = Object.freeze({
  "outside-policy": "attention",
  undetermined: "undetermined",
  "within-policy": "clear",
  "no-rule": "unmarked",
});

/** Most position maps one surface holds: the kit takes sixty components, and each map needs up to three. */
export const MAX_POSITION_MAPS = 17;
const MAX_CHAIN_NODES = MAX_GRAPH_NODES - 1;
const NEAR_PREFIX = "near:mainnet:";

interface Ctx {
  state: DeskState;
  facts: Map<string, Fact>;
  byReceipt: Map<string, Fact[]> | null;
  rules: Map<string, PublicRuleResult>;
}

function context(state: DeskState): Ctx {
  return { state, facts: factIndex(state), byReceipt: null, rules: new Map(state.review.publicVerdict.rules.map((rule) => [rule.ruleId, rule])) };
}

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

/** The greatest block and the latest time of a set of receipts, each as stored. */
function observed(receipts: EvidenceReceipt[]): { blockOrSlot: BlockOrSlot; asOf: string | null } {
  const blocks = receipts.map((receipt) => receipt.observation.blockOrSlot).filter((block): block is string => typeof block === "string");
  let blockOrSlot: BlockOrSlot = null;
  if (blocks.length > 0) {
    blockOrSlot = blocks[0];
    if (blocks.every((block) => /^[0-9]+$/.test(block))) for (const block of blocks) if (BigInt(block) > BigInt(blockOrSlot)) blockOrSlot = block;
  }
  let asOf: string | null = null;
  for (const receipt of receipts) {
    const at = receipt.observation.observedAt;
    if (typeof at === "string" && (asOf === null || at > asOf)) asOf = at;
  }
  return { blockOrSlot, asOf };
}

function scopeRow(ctx: Ctx, key: string, values: Record<string, Cell>, source: string): ResultRow {
  return { rowKind: "scope", key, values, factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [ctx.state.snapshotId], scopeSource: source };
}

/**
 * A row that cites receipts. Its bases are the distinct bases of the facts behind it: the facts named by
 * `factIds`, or, with `byReceipt`, the facts that cite one of the receipts when no fact id is given. A row with no
 * receipt, or with no fact to take a basis from, cites nothing and becomes a scope row with `fallback` as its source.
 */
function citedRow(
  ctx: Ctx, kind: "fact" | "unknown", key: string, values: Record<string, Cell>,
  factIds: readonly string[], receiptIds: readonly string[], fallback: string, byReceipt = false,
): ResultRow {
  const evidenceIds = distinct(receiptIds);
  let facts = distinct(factIds).map((id) => ctx.facts.get(id)).filter((fact): fact is Fact => fact !== undefined);
  if (facts.length === 0 && byReceipt && evidenceIds.length > 0) {
    if (ctx.byReceipt === null) {
      ctx.byReceipt = new Map();
      for (const fact of ctx.facts.values()) for (const id of fact.evidenceIds) ctx.byReceipt.set(id, [...(ctx.byReceipt.get(id) ?? []), fact]);
    }
    facts = evidenceIds.flatMap((id) => ctx.byReceipt!.get(id) ?? []);
  }
  const bases = distinct(facts.map((fact) => fact.basis)).sort();
  if (evidenceIds.length === 0 || bases.length === 0) return scopeRow(ctx, key, values, fallback);
  const seen = observed(evidenceIds.map((id) => ctx.state.store.receipt(id)).filter((receipt): receipt is EvidenceReceipt => receipt !== undefined));
  return { rowKind: kind, key, values, factIds: distinct(factIds), bases, evidenceIds, blockOrSlot: seen.blockOrSlot, asOf: seen.asOf, snapshotIds: [ctx.state.snapshotId] };
}

function table(resultId: string, columns: [string, ColumnRole][], rows: ResultRow[], notes: string[] = [], shape: ResultSet["shape"] = "table"): ResultSet {
  return { resultId, shape, columns: columns.map(([name, role]) => ({ name, role })), coverage: "mapped", coverageNotes: notes, rows, truncated: false };
}

function meta(state: DeskState, title: string, snapshotIds: string[] = [state.snapshotId]): SurfaceMeta {
  const snapshot = state.review.snapshot;
  return {
    title, subjectId: state.policy.policyId, snapshotIds,
    fromBlockOrSlot: snapshot.fromBlockOrSlot, toBlockOrSlot: snapshot.toBlockOrSlot, capturedAt: snapshot.observedTo, constructed: snapshot.constructed,
  };
}

/** Collects the components and results of one surface. A result that is not plainly mapped gets its coverage note. */
class Surface {
  readonly components: A2uiComponent[] = [];
  readonly results: Record<string, AnyResult> = {};
  constructor(readonly surfaceId: string, readonly meta: SurfaceMeta | null) {}

  private bind(result: AnyResult): { path: string } {
    this.results[result.resultId] = result;
    return { path: `/results/${result.resultId}` };
  }
  /** Adds the value component of a result, and a coverage note when it has a note or is not mapped. Returns the child ids. */
  value(component: "FactTable" | "UnknownList" | "DependencyGraph", result: AnyResult): string[] {
    const binding = this.bind(result);
    const ids: string[] = [];
    if (result.coverage !== "not-mapped") {
      ids.push(`v-${result.resultId}`);
      this.components.push({ id: `v-${result.resultId}`, component, result: binding });
    }
    if (result.coverage !== "mapped" || result.coverageNotes.length > 0) {
      ids.push(`c-${result.resultId}`);
      this.components.push({ id: `c-${result.resultId}`, component: "CoverageNote", result: binding });
    }
    return ids;
  }
  section(id: string, title: string, children: string[]): string {
    this.components.push({ id, component: "Section", title, children });
    return id;
  }
  header(): string {
    this.components.push({ id: "header", component: "SubjectHeader", meta: { path: "/meta" } });
    return "header";
  }
  messages(rootChildren: string[]): A2uiMessage[] {
    const model: Record<string, unknown> = { results: this.results };
    if (this.meta !== null) model.meta = this.meta;
    const components: A2uiComponent[] = [{ id: "root", component: "Column", children: rootChildren }, ...this.components];
    return [createSurface(this.surfaceId), updateDataModel(this.surfaceId, "/", model), updateComponents(this.surfaceId, components)];
  }
}

/* ---------- rules ---------- */

const specOf = (state: DeskState, ruleId: string): RuleSpec | undefined => state.policy.rules.find((rule) => rule.id === ruleId);

function ruleRow(ctx: Ctx, kind: "fact" | "unknown", rule: PublicRuleResult, values: Record<string, Cell>, key = rule.ruleId): ResultRow {
  return citedRow(ctx, kind, key, values, rule.factIds, rule.receiptIds, S.scopeNoFact);
}

/** For each subject a rule names, the outcomes of the rules naming it. */
function outcomesBySubject(ctx: Ctx): Map<string, Outcome[]> {
  const named = new Map<string, Outcome[]>();
  for (const spec of ctx.state.policy.rules) {
    const outcome = ctx.rules.get(spec.id)?.outcome;
    if (outcome === undefined) continue;
    for (const subject of ruleSubjects(spec)) named.set(subject, [...(named.get(subject) ?? []), outcome]);
  }
  return named;
}

/** The worst outcome among the rules that name a node: outside policy, then undetermined, then within policy. */
export function worstOutcome(outcomes: readonly Outcome[]): NodeOutcome {
  if (outcomes.includes("outside-policy")) return "outside-policy";
  if (outcomes.includes("undetermined")) return "undetermined";
  return outcomes.length > 0 ? "within-policy" : "no-rule";
}

/* ---------- verdict ---------- */

function verdictSurface(ctx: Ctx): A2uiMessage[] {
  const { state } = ctx;
  const verdict = state.review.publicVerdict;
  const surface = new Surface("desk-verdict", meta(state, T.policyTitle(state.policy.policyId)));

  const outcome = table("outcome", [[S.colPolicy, "label"], [S.colOutcome, "status"]], [
    scopeRow(ctx, "outcome", { [S.colPolicy]: verdict.policyId, [S.colOutcome]: verdict.outcome }, S.scopeOutcome),
  ]);

  const positions = nearPositions(state);
  const summaryRows: ResultRow[] = [];
  for (const root of distinct(positions.map((item) => item.joined.root))) {
    const onRoot = positions.filter((item) => item.joined.root === root);
    const chain = onRoot[0].joined.chain;
    if (chain === null) {
      summaryRows.push(scopeRow(ctx, root, {
        [S.colChain]: root, [S.colPositions]: onRoot.length, [S.colRulesOutside]: null, [S.colSentence]: T.summaryUncovered(onRoot.length, root),
      }, S.scopeNotInSnapshot));
      continue;
    }
    const nodes = new Set(chain.controls.map((control) => control.subject));
    const outside = state.policy.rules
      .filter((spec) => ruleSubjects(spec).some((subject) => nodes.has(subject)))
      .map((spec) => ctx.rules.get(spec.id))
      .filter((rule): rule is PublicRuleResult => rule !== undefined && rule.outcome === "outside-policy");
    summaryRows.push(citedRow(ctx, "fact", root, {
      [S.colChain]: root, [S.colPositions]: onRoot.length, [S.colRulesOutside]: outside.length, [S.colSentence]: T.summary(onRoot.length, root, outside.length),
    }, outside.flatMap((rule) => rule.factIds), outside.flatMap((rule) => rule.receiptIds), S.scopeNoOutside));
  }
  const summary = table("summary", [[S.colChain, "subject"], [S.colPositions, "value"], [S.colRulesOutside, "value"], [S.colSentence, "note"]], summaryRows);

  const rules = table("rules", [[S.colRule, "label"], [S.colKind, "label"], [S.colOutcome, "status"]],
    verdict.rules.map((rule) => ruleRow(ctx, "fact", rule, { [S.colRule]: rule.ruleId, [S.colKind]: rule.kind, [S.colOutcome]: rule.outcome })));

  return surface.messages([
    surface.header(),
    surface.section("s-verdict", S.sectionOutcome, [...surface.value("FactTable", outcome), ...surface.value("FactTable", summary)]),
    surface.section("s-rules", S.sectionRules, surface.value("FactTable", rules)),
  ]);
}

/* ---------- map ---------- */

const changedSubjects = (state: DeskState): Set<string> =>
  new Set((state.watch?.events ?? []).filter((event): event is Extract<WatchEvent, { kind: "dependency-changed" }> => event.kind === "dependency-changed").map((event) => event.subject));

function mapSurface(ctx: Ctx): A2uiMessage[] {
  const { state } = ctx;
  const surface = new Surface("desk-map", meta(state, S.titleMap));
  const legendRows: [GraphMark, string][] = [
    ["attention", S.legendAttention], ["undetermined", S.legendUndetermined], ["clear", S.legendClear],
    ["unmarked", S.legendUnmarked], ["changed", S.legendChanged],
  ];
  const legend = table("legend", [[S.colMark, "label"], [S.colStandsFor, "note"]],
    legendRows.map(([mark, text]) => scopeRow(ctx, mark, { [S.colMark]: mark, [S.colStandsFor]: text }, S.scopeLegend)));
  const children = [surface.header(), surface.section("s-marks", S.sectionMarks, surface.value("FactTable", legend))];

  const positions = nearPositions(state);
  if (positions.length === 0) {
    const empty: GraphResult = { resultId: "map", shape: "graph", coverage: "not-mapped", coverageNotes: [S.noNearPosition], nodes: [], edges: [], truncated: false };
    children.push(surface.section("s-map", S.sectionPositionMap, surface.value("DependencyGraph", empty)));
    return surface.messages(children);
  }

  const named = outcomesBySubject(ctx);
  const changed = changedSubjects(state);
  positions.slice(0, MAX_POSITION_MAPS).forEach(({ entry, joined }, n) => {
    const chain = joined.chain;
    const all = chain === null ? [joined.root] : chain.controls.map((control) => control.subject);
    const subjects = all.slice(0, MAX_CHAIN_NODES);
    const nodes: { id: string; label: string; mark?: GraphMark | GraphMark[] }[] = [
      { id: `position:${entry.position.id}`, label: `${entry.position.id} · ${S.positionPrivate}` },
      ...subjects.map((subject) => {
        const mark = MARK_OF_OUTCOME[worstOutcome(named.get(subject) ?? [])];
        return { id: subject, label: subject.startsWith(NEAR_PREFIX) ? subject.slice(NEAR_PREFIX.length) : subject, mark: changed.has(subject) ? [mark, "changed" as const] : mark };
      }),
    ];
    const { result, skipped } = graphResult(nodes, chain === null ? [] : (chain.facts as unknown as Fact[]), { id: `pos-${n}`, receipts: state.review.receipts });
    if (chain === null) result.coverageNotes.push(S.missingSubject);
    if (skipped.some((item) => item.reason === "missing-receipt")) result.coverageNotes.push(S.mapEdgesSkipped);
    if (all.length > subjects.length) {
      result.truncated = true;
      result.coverageNotes.push(S.mapNodesCut);
    }
    if (result.coverageNotes.length > 0) result.coverage = "partial";
    children.push(surface.section(`s-pos-${n}`, S.sectionPositionMap, surface.value("DependencyGraph", result)));
  });
  if (positions.length > MAX_POSITION_MAPS) {
    const more: GraphResult = {
      resultId: "map-more", shape: "graph", coverage: "not-mapped", nodes: [], edges: [], truncated: true,
      coverageNotes: [S.mapPositionsCut, T.morePositions(positions.length - MAX_POSITION_MAPS)],
    };
    children.push(...surface.value("DependencyGraph", more));
  }
  return surface.messages(children);
}

/* ---------- plain words ---------- */

function wordsSurface(ctx: Ctx): A2uiMessage[] {
  const { state } = ctx;
  const surface = new Surface("desk-words", null);
  const rows: ResultRow[] = [];
  for (const rule of state.review.publicVerdict.rules) {
    if (rule.outcome === "within-policy") continue;
    const spec = specOf(state, rule.ruleId) ?? { id: rule.ruleId, kind: rule.kind, params: {} };
    const facts = rule.factIds.map((id) => ctx.facts.get(id)).filter((fact): fact is Fact => fact !== undefined);
    rows.push(ruleRow(ctx, "fact", rule, {
      [S.colRule]: rule.ruleId, [S.colOutcome]: rule.outcome, [S.colSentence]: sentenceFor(spec, rule, facts).text,
    }));
  }
  const words = table("words", [[S.colRule, "label"], [S.colOutcome, "status"], [S.colSentence, "note"]], rows, rows.length === 0 ? [S.noWords] : []);
  return surface.messages([surface.section("s-words", S.sectionWords, surface.value("FactTable", words))]);
}

/* ---------- changes ---------- */

function changesSurface(ctx: Ctx): A2uiMessage[] {
  const { state } = ctx;
  if (state.watch === null || state.before === null) {
    const surface = new Surface("desk-changes", null);
    const none: ResultSet = { ...table("changes", [], []), coverage: "not-mapped", coverageNotes: [S.noEarlierSnapshot] };
    return surface.messages(surface.value("FactTable", none));
  }
  const surface = new Surface("desk-changes", meta(state, T.changesTitle(state.before), distinct([state.before, state.snapshotId])));
  const dependencyRows: ResultRow[] = [];
  const positionRows: ResultRow[] = [];
  state.watch.events.forEach((event, at) => {
    if (event.kind === "position-changed") {
      positionRows.push(scopeRow(ctx, `position-${at}`, { [S.colRoot]: event.root, [S.colChange]: event.change }, S.scopePrivateBook));
      return;
    }
    const detail = [
      ...event.changes.map((change) => `${change.kind} ${change.key}`),
      ...event.proposals.map((proposal) => `proposal ${proposal}`),
      ...event.flippedRules.map((rule) => `${T.ruleItem(rule.ruleId)}: ${rule.before} to ${rule.after}`),
    ].join("; ");
    const factIds = event.changes.flatMap((change) => [change.beforeFactId, change.afterFactId]).filter((id): id is string => id !== null);
    dependencyRows.push(citedRow(ctx, "fact", `dependency-${at}`, {
      [S.colSubject]: event.subject, [S.colCause]: event.cause, [S.colLabel]: event.constructed ? S.constructed : S.recorded, [S.colDetail]: detail,
    }, factIds, event.receiptIds, S.scopeWatch, true));
  });
  const dependencies = table("dependency-changed", [[S.colSubject, "subject"], [S.colCause, "label"], [S.colLabel, "note"], [S.colDetail, "note"]],
    dependencyRows, dependencyRows.length === 0 ? [S.noChange] : []);
  const positions = table("position-changed", [[S.colRoot, "subject"], [S.colChange, "label"]], positionRows, positionRows.length === 0 ? [S.noChange] : []);
  return surface.messages([
    surface.header(),
    surface.section("s-dependencies", S.sectionDependencies, surface.value("FactTable", dependencies)),
    surface.section("s-positions", S.sectionPositions, surface.value("FactTable", positions)),
  ]);
}

/* ---------- unknowns ---------- */

function unknownsSurface(ctx: Ctx): A2uiMessage[] {
  const { state } = ctx;
  const surface = new Surface("desk-unknowns", null);
  const rows: ResultRow[] = [];
  const row = (item: string | null, reason: string, detail: string | null): Record<string, Cell> => ({ [S.colItem]: item, [S.colReason]: reason, [S.colDetail]: detail });

  // Every rule that could not be decided.
  for (const rule of state.review.publicVerdict.rules) {
    if (rule.outcome !== "undetermined") continue;
    const detail = rule.reasons.map((reason) => [reason.code, reason.subject, reason.ref].filter((part) => part !== null).join(" ")).join("; ");
    rows.push(ruleRow(ctx, "unknown", rule, row(T.ruleItem(rule.ruleId), S.undetermined, detail === "" ? null : detail), `rule-${rule.ruleId}`));
  }
  // Every position whose subject the snapshot does not hold, by its public root.
  const uncovered = nearPositions(state).filter((item) => item.joined.coverage === "uncovered");
  for (const root of distinct(uncovered.map((item) => item.joined.root))) {
    const count = uncovered.filter((item) => item.joined.root === root).length;
    rows.push(scopeRow(ctx, `uncovered-${root}`, row(root, uncovered[0].joined.reason ?? "missing-subject", `${S.uncoveredDetail}; ${T.positionsOnRoot(count)}`), S.scopeJoin));
  }
  // Every address that was not read, or not read in full. The address itself is never written into a row.
  for (const address of state.addresses) {
    if (address.reason === null) continue;
    rows.push(scopeRow(ctx, `address-${address.ordinal}`, row(T.addressItem(address.ordinal, address.chain), address.reason, null), S.scopeReader));
  }
  // Every chain the book holds positions on and no review covers.
  const others = state.positions.filter((entry) => entry.root === null);
  for (const chain of distinct(others.map((entry) => entry.chain))) {
    rows.push(scopeRow(ctx, `chain-${chain}`, row(T.chainItem(chain), S.noReviewYet, T.positionsListed(others.filter((entry) => entry.chain === chain).length)), S.scopeDesk));
  }
  // Every reason the review and the comparison recorded.
  const seen = new Set<string>();
  const reasons: { code: string; subject: string | null; ref: string | null; ruleId?: string }[] = [...state.review.unknowns, ...(state.watch?.unknowns ?? [])];
  reasons.forEach((reason, at) => {
    const identity = JSON.stringify([reason.code, reason.subject, reason.ref, reason.ruleId ?? null]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const rule = reason.ruleId === undefined ? null : T.ruleItem(reason.ruleId);
    const values = row(reason.subject ?? rule, reason.code, [rule, reason.ref].filter((part) => part !== null).join("; ") || null);
    const fact = reason.ref === null ? undefined : ctx.facts.get(reason.ref);
    rows.push(fact ? citedRow(ctx, "unknown", `reason-${at}`, values, [fact.id], fact.evidenceIds, S.scopeQueryReason) : scopeRow(ctx, `reason-${at}`, values, S.scopeQueryReason));
  });

  const unknowns = table("unknowns", [[S.colItem, "label"], [S.colReason, "note"], [S.colDetail, "note"]], rows, rows.length === 0 ? [S.noneRecorded] : [], "unknowns");
  return surface.messages([surface.section("s-unknowns", S.sectionUnknowns, surface.value("UnknownList", unknowns))]);
}

/* ---------- positions (private: served by the positions route only) ---------- */

/** The positions as a kit surface. A reader position cites its private receipts; a book entry is a scope row. */
export function buildPositionsSurface(state: DeskState): A2uiMessage[] {
  const ctx = context(state);
  const surface = new Surface("desk-positions", null);
  const privateReceipts = new Map(state.privateReceipts.map((receipt) => [receipt.id, receipt]));
  const joined = new Map(nearPositions(state).map((item) => [item.entry, item.joined]));
  const rows = state.positions.map((entry, at): ResultRow => {
    const near = joined.get(entry);
    const values: Record<string, Cell> = {
      [S.colId]: entry.position.id, [S.colSubject]: entry.position.subject, [S.colQuantity]: entry.position.quantity, [S.colUnit]: entry.position.unit,
      [S.colSource]: entry.source.kind === "manual" ? S.manual : `${S.sourceReader} ${entry.source.chain}`,
      [S.colCoverage]: near ? (near.reason === null ? near.coverage : `${near.coverage}: ${near.reason}`) : S.noReviewYet,
    };
    if (entry.source.kind === "manual") return scopeRow(ctx, `position-${at}`, values, state.book === "file" ? S.scopeBookFile : S.scopeSyntheticBook);
    const receipts = entry.receiptIds.map((id) => privateReceipts.get(id)).filter((receipt): receipt is EvidenceReceipt => receipt !== undefined);
    if (entry.receiptIds.length === 0) return scopeRow(ctx, `position-${at}`, values, S.scopeReader);
    const seen = observed(receipts);
    // A reader position is a balance the reader observed on chain; its receipts are its evidence.
    return { rowKind: "fact", key: `position-${at}`, values, factIds: [], bases: ["observed"], evidenceIds: [...entry.receiptIds], blockOrSlot: seen.blockOrSlot, asOf: seen.asOf, snapshotIds: [entry.position.snapshotId] };
  });
  const positions = table("positions", [[S.colId, "label"], [S.colSubject, "subject"], [S.colQuantity, "amount"], [S.colUnit, "unit"], [S.colSource, "label"], [S.colCoverage, "status"]],
    rows, rows.length === 0 ? [S.noneRecorded] : []);
  return surface.messages([surface.section("s-positions", S.sectionPositions, surface.value("FactTable", positions))]);
}

/* ---------- build and serve ---------- */

/** The messages of one view. Pure: the same state gives the same messages. */
export function buildSurface(view: DeskView, state: DeskState): A2uiMessage[] {
  const ctx = context(state);
  switch (view) {
    case "verdict": return verdictSurface(ctx);
    case "map": return mapSurface(ctx);
    case "words": return wordsSurface(ctx);
    case "changes": return changesSurface(ctx);
    case "unknowns": return unknownsSurface(ctx);
  }
}

/**
 * The codes a surface is refused with: the validator's rule codes, then the error codes of a trial drawing.
 * An empty list means the surface may be served.
 */
export function refusalCodes(messages: A2uiMessage[], receiptIds: Iterable<string>): string[] {
  const verdict = validateSurface(messages, { resolveEvidence: receiptResolver(receiptIds) });
  const codes: string[] = [...verdict.codes];
  if (verdict.ok) {
    try {
      for (const error of interpret(messages).errors) if (!codes.includes(error.code)) codes.push(error.code);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      codes.push(typeof code === "string" ? code : "schema");
    }
  }
  return codes;
}

export type Served = { ok: true; messages: A2uiMessage[] } | { ok: false; codes: string[] };

/** Builds a view and serves it only when the kit's validator passes it and the kit draws it without an error. */
export function serveSurface(view: DeskView, state: DeskState, opts: { missingReceiptIds?: readonly string[] } = {}): Served {
  const messages = buildSurface(view, state);
  const missing = new Set(opts.missingReceiptIds ?? []);
  const codes = refusalCodes(messages, publicReceiptIds(state).filter((id) => !missing.has(id)));
  return codes.length > 0 ? { ok: false, codes } : { ok: true, messages };
}

/** The positions surface, checked the same way with the reader's private receipts added to what may be cited. */
export function servePositionsSurface(state: DeskState, opts: { missingReceiptIds?: readonly string[] } = {}): Served {
  const messages = buildPositionsSurface(state);
  const missing = new Set(opts.missingReceiptIds ?? []);
  const codes = refusalCodes(messages, [...publicReceiptIds(state), ...state.privateReceipts.map((receipt) => receipt.id)].filter((id) => !missing.has(id)));
  return codes.length > 0 ? { ok: false, codes } : { ok: true, messages };
}
