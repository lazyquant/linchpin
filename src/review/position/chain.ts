import { runPlan, memoryTraceSink, VOCABULARY, SUBJECT_PATTERN, isTraversalRelation, MAX_RELATIONS,
  type EnginePlan, type EngineNode, type RunLimits, type QueryRequest, type RunPlanInput, type EngineRunOutcome,
  type EvidenceStore, type TraceSink, type RenderReviewEntry, type ReviewClaim, type QueryReason, type Fact, type EvidenceReceipt } from "../../engine/index";
import { cmp, sortedUnique, sortReasons, factUsableAt, type PredicateRole } from "../../policy/index";
export const MAX_QUERIES_PER_PLAN = 31;
export interface EngineAccess { execute(input: RunPlanInput): Promise<EngineRunOutcome>; store: EvidenceStore; trace: TraceSink }
export type EngineOptions = Partial<Pick<EngineAccess, "execute" | "trace">>;
export function engineAccess(store: EvidenceStore, options: EngineOptions = {}): EngineAccess {
  return { execute: options.execute ?? runPlan, store, trace: options.trace ?? memoryTraceSink() };
}
export interface RunRecord {
  round: string; planSha256: string; blueprintId: string; blueprintSha256: string; registrySha256: string;
  lastSequence: number; claims: ReviewClaim[]; unknowns: string[]; runId: string;
}
export interface ChainReview {
  snapshotId: string; constructed: boolean; subjects: string[];
  dependencyFacts: Fact[]; controlFacts: Fact[]; stateFacts: Fact[];
  controllers: string[]; oracleSources: string[]; reasons: QueryReason[]; receipts: EvidenceReceipt[]; entries: RenderReviewEntry[];
}
export class ReviewRunFailed extends Error {
  constructor(readonly status: string, readonly code: string) { super(`executor ${status} ${code}`); this.name = "ReviewRunFailed"; }
}
export function solanaRoleOf(predicate: string): PredicateRole | undefined {
  if (!Object.hasOwn(VOCABULARY, predicate)) return undefined;
  if (predicate === "PRICED_BY") return "oracle";
  if (predicate === "IDLE_RAW") return "idle";
  if (predicate === "AVAILABLE_LIQUIDITY_RAW") return "available-liquidity";
  if (predicate === "BORROWED_RAW") return "utilization-input";
  const kind = VOCABULARY[predicate as keyof typeof VOCABULARY].class;
  return kind === "control" ? "control" : kind === "state" ? "state" : "dependency";
}
export function buildRoundPlans(requests: QueryRequest[]): { plan: EnginePlan; limits: RunLimits }[] {
  const plans: { plan: EnginePlan; limits: RunLimits }[] = [];
  for (let offset = 0; offset < requests.length; offset += MAX_QUERIES_PER_PLAN) {
    const batch = requests.slice(offset, offset + MAX_QUERIES_PER_PLAN);
    const nodes: EngineNode[] = batch.map((request, i) => ({
      id: `q${String(i).padStart(2, "0")}`, agent: request.name, domain: "protocol-review",
      input: Object.fromEntries(Object.entries(request).filter(([key]) => key !== "name").map(([key, value]) => [key, { literal: structuredClone(value) }])), dependsOn: [],
    }));
    const ids = nodes.map(n => n.id);
    nodes.push({ id: "review", agent: "render-review", domain: "protocol-review", input: Object.fromEntries(ids.map(id => [id, { ref: id }])), dependsOn: ids });
    plans.push({ plan: { version: 1, nodes, outputNodeId: "review" }, limits: { maxNodes: 32, maxDepth: 2, maxToolCalls: batch.length, maxTokens: 0, timeoutMs: 60000 } });
  }
  return plans;
}
export async function executeRound(engine: EngineAccess, requests: QueryRequest[], round = "query"): Promise<{ entries: RenderReviewEntry[]; runs: RunRecord[] }> {
  const entries: RenderReviewEntry[] = [], runs: RunRecord[] = [];
  for (const { plan, limits } of buildRoundPlans(requests)) {
    const result = await engine.execute({ plan, limits, blueprintId: "position-review-v1", store: engine.store, trace: engine.trace });
    if (result.status !== "succeeded") throw new ReviewRunFailed(result.status, result.code);
    const e = result.envelope;
    entries.push(...e.results);
    runs.push({ round, planSha256: e.planSha256, blueprintId: e.blueprintId, blueprintSha256: e.blueprintSha256,
      registrySha256: e.registrySha256, lastSequence: result.lastSequence, claims: e.review.claims, unknowns: e.review.unknowns, runId: e.runId });
  }
  return { entries, runs };
}
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()].sort((a, b) => cmp(a.id, b.id));
}
export function chainFacts(chain: ChainReview): Fact[] { return uniqueById([...chain.dependencyFacts, ...chain.controlFacts, ...chain.stateFacts]); }
export async function queryChains(engine: EngineAccess, roots: string[], snapshotId: string, asOf: string, withState = true): Promise<{ chains: Map<string, ChainReview>; runs: RunRecord[] }> {
  const rootIds = sortedUnique(roots), scope = { snapshotId, asOf, maxHops: 8, maxResults: 500 };
  // Only the traversal relations this snapshot actually uses. The shared vocabulary also holds other
  // chains' predicates, and listing them all would exceed the query's relation bound.
  const used = new Set((engine.store.snapshot(snapshotId)?.facts ?? []).map(fact => fact.predicate));
  const traversal = Object.keys(VOCABULARY).filter(isTraversalRelation).sort(cmp);
  const inUse = traversal.filter(p => used.has(p));
  // A query needs at least one relation. With none in use, any choice returns no facts, and the query still
  // reports why: no-facts for an existing snapshot, missing-coverage for an unknown one.
  const relations = inUse.length ? inUse : traversal.slice(0, 1);
  // Splitting the list across several queries would miss paths that mix relations from different parts, and
  // dropping relations would hide dependencies. So a snapshot that uses more relations than one query allows
  // fails closed, with a pointed code instead of the query's generic rejection.
  if (relations.length > MAX_RELATIONS) throw new ReviewRunFailed("rejected", `relation-limit:${relations.length}>${MAX_RELATIONS}`);
  const dependencies = await executeRound(engine, rootIds.map(subject => ({ name: "dependencies", subject, relations, scope })), "dependencies");
  const entries = [...dependencies.entries], runs = [...dependencies.runs];
  const closures = new Map(rootIds.map(root => [root, new Set([root])]));
  for (const entry of dependencies.entries) {
    if (!("subject" in entry.request)) continue;
    const closure = closures.get(entry.request.subject)!;
    for (const fact of entry.result.facts) {
      closure.add(fact.subject);
      if (SUBJECT_PATTERN.test(fact.object)) closure.add(fact.object);
    }
  }
  const queried = new Set<string>(), controlBySubject = new Map<string, Fact[]>();
  let controlRound = 0;
  function expand() {
    for (const closure of closures.values()) {
      // Set iteration visits newly inserted identities, closing cycles without recursion.
      for (const subject of closure) for (const fact of controlBySubject.get(subject) ?? []) {
        if (SUBJECT_PATTERN.test(fact.object)) closure.add(fact.object);
      }
    }
  }
  for (;;) {
    expand();
    const frontier = sortedUnique([...closures.values()].flatMap(set => [...set])).filter(s => !queried.has(s));
    if (!frontier.length || queried.size >= 64) break;
    const batch = frontier.slice(0, 64 - queried.size);
    const control = await executeRound(engine, batch.map(subject => ({ name: "control", subject, scope: { ...scope, maxHops: 1 } })), `control-${++controlRound}`);
    batch.forEach(s => queried.add(s));
    for (const entry of control.entries) if ("subject" in entry.request) controlBySubject.set(entry.request.subject, entry.result.facts);
    entries.push(...control.entries); runs.push(...control.runs);
  }
  expand();
  if (withState) {
    const subjects = sortedUnique([...closures.values()].flatMap(set => [...set]));
    const state = await executeRound(engine, subjects.map(subject => ({ name: "changes", subject, beforeSnapshotId: snapshotId, afterSnapshotId: snapshotId, maxResults: 500 })), "state");
    entries.push(...state.entries); runs.push(...state.runs);
  }
  const chains = new Map<string, ChainReview>();
  for (const root of rootIds) {
    const closure = closures.get(root)!;
    const selected = entries.filter(e => "subject" in e.request && closure.has(e.request.subject));
    const dependencyFacts = uniqueById(selected.filter(e => e.request.name === "dependencies").flatMap(e => e.result.facts));
    const controlFacts = uniqueById(selected.filter(e => e.request.name === "control").flatMap(e => e.result.facts));
    const stateFacts = uniqueById(selected.filter(e => e.request.name === "changes").flatMap(e => e.result.facts)
      .filter(f => ["idle", "available-liquidity", "utilization-input", "state"].includes(solanaRoleOf(f.predicate) ?? "") && factUsableAt(f, engine.store, asOf)));
    const reasons = selected.flatMap(e => e.result.reasons);
    if ([...closure].some(s => !queried.has(s))) reasons.push({ code: "truncated", subject: root, ref: "control-query-limit" });
    chains.set(root, { snapshotId, constructed: engine.store.snapshot(snapshotId)?.constructed ?? false,
      subjects: [...closure].sort(cmp), dependencyFacts, controlFacts, stateFacts,
      controllers: sortedUnique(controlFacts.filter(f => f.status === "verified" && SUBJECT_PATTERN.test(f.object)).map(f => f.object)),
      oracleSources: sortedUnique(dependencyFacts.filter(f => solanaRoleOf(f.predicate) === "oracle" && f.status === "verified" && SUBJECT_PATTERN.test(f.object)).map(f => f.object)),
      reasons: sortReasons(reasons), receipts: uniqueById(selected.flatMap(e => e.result.receipts)), entries: selected });
  }
  return { chains, runs };
}
