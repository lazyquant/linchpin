import type { Fact, FactChange, QueryRequest, QueryResult, ReasonCode } from "../contracts";
import { canonical, sha256 } from "../../chain/evidence";
import { parseQueryRequest, SUBJECT_PATTERN } from "./request";
import type { EvidenceSnapshot, EvidenceStore } from "./snapshot";
import { VOCABULARY, type Predicate } from "./vocabulary";

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const edgeOrder = (a: Fact, b: Fact) => cmp(a.predicate, b.predicate) || cmp(a.object, b.object) || cmp(a.id, b.id);
const factOrder = (a: Fact, b: Fact) => (a.path.length || 1) - (b.path.length || 1)
  || cmp(a.subject, b.subject) || edgeOrder(a, b) || cmp(canonical(a), canonical(b));
const factKey = (f: Fact) => `${f.subject}|${f.predicate}${VOCABULARY[f.predicate as Predicate].cardinality === "many" ? `|${f.object}` : ""}`;
const semantic = (f: Fact) => canonical({ object: f.object, status: f.status, basis: f.basis });

class Answer {
  readonly result: QueryResult = { outcome: "unknown", facts: [], receipts: [], unknowns: [], conflicts: [], truncated: false, snapshotIds: [], reasons: [], observations: [], changes: [] };
  constructor(readonly store: EvidenceStore) {}
  reason(code: ReasonCode, subject: string | null = null, ref: string | null = null) {
    this.result.reasons.push({ code, subject, ref });
  }
  observe(s: EvidenceSnapshot, asOf: string | null) {
    this.result.snapshotIds.push(s.id);
    this.result.observations.push({ snapshotId: s.id, chain: s.chain, network: s.network, constructed: s.constructed,
      observedFrom: s.observedFrom, observedTo: s.observedTo, fromBlockOrSlot: s.fromBlockOrSlot,
      toBlockOrSlot: s.toBlockOrSlot, freshUntil: s.freshUntil, asOf });
  }
  readers(s: EvidenceSnapshot, subject: string): boolean {
    const incomplete = s.readers.filter(r => r.subjects.includes(subject) && r.status !== "complete");
    for (const r of incomplete) this.reason("partial-reader", subject, r.id);
    return incomplete.length > 0;
  }
  truncate(subject: string) { this.result.truncated = true; this.reason("truncated", subject); }
  /** Conflicts are evaluated within one snapshot, never between the two sides of a change. */
  conflicts(facts: Fact[]): Fact[] {
    const objects = new Map<string, Set<string>>();
    for (const f of facts) {
      if (VOCABULARY[f.predicate as Predicate].cardinality !== "one") continue;
      const k = factKey(f), values = objects.get(k) ?? new Set<string>(); values.add(f.object); objects.set(k, values);
    }
    return facts.map(f => {
      const key = factKey(f);
      if (f.status === "conflicting" || (objects.get(key)?.size ?? 0) > 1) {
        this.result.conflicts.push(key); this.reason("conflict", f.subject, key);
        return { ...f, status: "conflicting" };
      }
      return f;
    });
  }
  quality(f: Fact) {
    if (f.object === "unknown" && VOCABULARY[f.predicate as Predicate].class === "control") this.reason("unknown-controller", f.subject, f.id);
    else if (f.object === "unknown" || f.basis === "unknown" || f.status === "unverified") this.reason("missing-coverage", f.subject, f.id);
    if (f.status === "missing") this.reason("missing-evidence", f.subject, f.id);
  }
  temporal(f: Fact, asOf: string): boolean {
    const at = Date.parse(asOf);
    if (f.validTo !== null && Date.parse(f.validTo) <= at) { this.reason("expired", f.subject, f.id); return false; }
    if (f.validFrom !== null && Date.parse(f.validFrom) > at) { this.reason("missing-history", f.subject, f.id); return false; }
    const permitted = f.evidenceIds.some(id => {
      const r = this.store.receipt(id);
      if (!r) { this.reason("missing-evidence", f.subject, id); return false; }
      const o = r.observation;
      if (Date.parse(o.observedAt) > at) return false;
      return o.historicalState === "current-only" || (o.historicalState === "pinned" || o.historicalState === "constructed") && f.validFrom !== null;
    });
    if (!permitted) this.reason("missing-history", f.subject, f.id);
    return permitted;
  }
  finish(evidence = false, subject: string | null = null): QueryResult {
    const r = this.result;
    r.facts = [...new Map(r.facts.map(f => [canonical(f), f])).values()].sort(factOrder);
    for (const f of r.facts) {
      this.quality(f);
      for (const id of f.evidenceIds) {
        const receipt = this.store.receipt(id);
        if (receipt) r.receipts.push(receipt); else this.reason("missing-evidence", f.subject, id);
      }
    }
    r.receipts = [...new Map(r.receipts.map(receipt => [receipt.id, receipt])).values()].sort((a, b) => cmp(a.id, b.id));
    const nonempty = evidence ? r.receipts.length > 0 : r.facts.length > 0;
    if (!nonempty && !r.reasons.some(reason => ["missing-subject", "missing-coverage", "incompatible-snapshots", "missing-evidence"].includes(reason.code))) this.reason("no-facts", subject);
    r.reasons = [...new Map(r.reasons.map(reason => [canonical(reason), reason])).values()].sort((a, b) => cmp(a.code, b.code) || cmp(a.subject ?? "", b.subject ?? "") || cmp(a.ref ?? "", b.ref ?? ""));
    r.unknowns = [...new Set(r.reasons.flatMap(reason => {
      const refersToEvidenceOrFact = ["missing-evidence", "missing-history", "expired", "unknown-controller"].includes(reason.code)
        || r.facts.some(f => f.id === reason.ref);
      return [reason.subject, refersToEvidenceOrFact ? reason.ref : null].filter((s): s is string => s !== null);
    }))].sort(cmp);
    r.conflicts = [...new Set(r.conflicts)].sort(cmp);
    r.snapshotIds = [...new Set(r.snapshotIds)].sort(cmp);
    r.observations = [...new Map(r.observations.map(o => [canonical(o), o])).values()].sort((a, b) => cmp(a.snapshotId, b.snapshotId));
    r.changes.sort((a, b) => cmp(a.key, b.key) || cmp(a.kind, b.kind) || cmp(canonical(a), canonical(b)));
    r.outcome = !nonempty ? "unknown" : r.reasons.length || r.truncated ? "partial" : "complete";
    return r;
  }
}

function scoped(answer: Answer, request: Extract<QueryRequest, { name: "dependencies" | "control" }>): EvidenceSnapshot | undefined {
  const s = answer.store.snapshot(request.scope.snapshotId);
  answer.result.snapshotIds.push(request.scope.snapshotId);
  if (!s) { answer.reason("missing-coverage", request.subject, request.scope.snapshotId); return; }
  answer.observe(s, request.scope.asOf);
  if (!s.subjects.includes(request.subject)) { answer.reason("missing-subject", request.subject, s.id); return; }
  if (Date.parse(request.scope.asOf) > Date.parse(s.freshUntil)) answer.reason("stale", request.subject, s.id);
  answer.readers(s, request.subject);
  return s;
}
function dependencies(answer: Answer, request: Extract<QueryRequest, { name: "dependencies" }>) {
  const s = scoped(answer, request); if (!s) return;
  const queue = [{ subject: request.subject, depth: 0, path: [] as string[] }];
  const visited = new Set([request.subject]);
  const seenFacts = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (!s.subjects.includes(node.subject)) { answer.reason("missing-subject", node.subject, s.id); continue; }
    answer.readers(s, node.subject);
    const facts = answer.conflicts(answer.store.factsFrom(s.id, node.subject)
      .filter(f => request.relations.includes(f.predicate) && answer.temporal(f, request.scope.asOf))).sort(edgeOrder);
    for (const f of facts) {
      if (node.depth === request.scope.maxHops) { answer.truncate(request.subject); continue; }
      if (seenFacts.has(f.id)) continue;
      if (answer.result.facts.length === request.scope.maxResults) { answer.truncate(request.subject); return; }
      seenFacts.add(f.id);
      const path = [...node.path, f.id];
      answer.result.facts.push({ ...f, path: node.depth === 0 ? [] : path });
      if (SUBJECT_PATTERN.test(f.object) && !visited.has(f.object)) {
        visited.add(f.object); queue.push({ subject: f.object, depth: node.depth + 1, path });
      }
    }
  }
}
function control(answer: Answer, request: Extract<QueryRequest, { name: "control" }>) {
  const s = scoped(answer, request); if (!s) return;
  const facts = answer.conflicts(answer.store.factsFrom(s.id, request.subject)
    .filter(f => VOCABULARY[f.predicate as Predicate].class === "control" && answer.temporal(f, request.scope.asOf))).sort(factOrder);
  answer.result.facts = facts.slice(0, request.scope.maxResults);
  if (facts.length > request.scope.maxResults) answer.truncate(request.subject);
}
function group(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) { const key = factKey(f), bucket = groups.get(key) ?? []; bucket.push(f); groups.set(key, bucket); }
  for (const bucket of groups.values()) bucket.sort(factOrder);
  return groups;
}
function changes(answer: Answer, request: Extract<QueryRequest, { name: "changes" }>) {
  const before = answer.store.snapshot(request.beforeSnapshotId), after = answer.store.snapshot(request.afterSnapshotId);
  answer.result.snapshotIds.push(request.beforeSnapshotId, request.afterSnapshotId);
  if (before) answer.observe(before, null); if (after) answer.observe(after, null);
  if (!before || !after) { answer.reason("missing-coverage", request.subject); return; }
  if (before.chain !== after.chain || before.network !== after.network) { answer.reason("incompatible-snapshots", request.subject); return; }
  if (!before.subjects.includes(request.subject) || !after.subjects.includes(request.subject)) { answer.reason("missing-coverage", request.subject); return; }
  const beforePartial = answer.readers(before, request.subject), afterPartial = answer.readers(after, request.subject);
  // Compare each capture at its own boundary; never infer an earlier state from today's receipt.
  const read = (s: EvidenceSnapshot) => {
    if (Date.parse(s.observedTo) > Date.parse(s.freshUntil)) answer.reason("stale", request.subject, s.id);
    const all = answer.conflicts(answer.store.factsFrom(s.id, request.subject));
    const usable = all.filter(f => answer.temporal(f, s.observedTo));
    return { all, usable };
  };
  const bf = read(before), af = read(after), bg = group(bf.usable), ag = group(af.usable);
  answer.result.facts = [...new Map([...bf.all, ...af.all].map(f => [canonical(f), f])).values()].sort(factOrder);
  for (const key of [...new Set([...bg.keys(), ...ag.keys()])].sort(cmp)) {
    const b = bg.get(key) ?? [], a = ag.get(key) ?? [];
    // Ambiguous assertions cannot be collapsed to an arbitrarily selected controller/change.
    const bs = new Set(b.map(semantic)), as = new Set(a.map(semantic));
    if (bs.size > 1 || as.size > 1) { answer.reason("missing-coverage", request.subject, key); continue; }
    const b0 = b[0] ?? null, a0 = a[0] ?? null;
    let change: FactChange | undefined;
    if (!b0 && a0 && !beforePartial) change = { kind: "added", key, before: null, after: a0 };
    else if (b0 && !a0 && !afterPartial) change = { kind: "removed", key, before: b0, after: null };
    else if (b0 && a0 && semantic(b0) !== semantic(a0)) change = { kind: "changed", key, before: b0, after: a0 };
    // Missing temporal/evidential coverage is not an observed addition/removal either.
    if (change && (change.kind === "added" || change.kind === "removed")) {
      const missing = change.kind === "added" ? before : after;
      if (answer.store.factsFrom(missing.id, request.subject).some(f => factKey(f) === key)) {
        answer.reason("missing-coverage", request.subject, key); continue;
      }
    }
    if (change) answer.result.changes.push(change);
  }
  if (answer.result.facts.length > request.maxResults || answer.result.changes.length > request.maxResults) {
    answer.truncate(request.subject);
    answer.result.facts = answer.result.facts.slice(0, request.maxResults);
    const returned = new Set(answer.result.facts.map(canonical));
    answer.result.changes = answer.result.changes.filter(c => (!c.before || returned.has(canonical(c.before))) && (!c.after || returned.has(canonical(c.after)))).slice(0, request.maxResults);
  }
}
function evidence(answer: Answer, request: Extract<QueryRequest, { name: "evidence" }>) {
  for (const id of [...request.evidenceIds].sort(cmp)) {
    const receipt = answer.store.receipt(id);
    if (!receipt) { answer.reason("missing-evidence", null, id); continue; }
    answer.result.receipts.push(receipt);
    const snapshots = answer.store.snapshotsForReceipt(id);
    if (!snapshots.length) answer.reason("missing-coverage", null, id);
    for (const s of snapshots) answer.observe(s, null);
  }
}
export function runQuery(store: EvidenceStore, input: unknown): QueryResult {
  const request = parseQueryRequest(input);
  const answer = new Answer(store);
  switch (request.name) {
    case "dependencies": dependencies(answer, request); break;
    case "control": control(answer, request); break;
    case "changes": changes(answer, request); break;
    case "evidence": evidence(answer, request); break;
  }
  return answer.finish(request.name === "evidence", "subject" in request ? request.subject : null);
}
export function resultSha256(result: QueryResult): string { return sha256(canonical(result)); }
