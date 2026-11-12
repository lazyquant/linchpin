import type { FactChange, PrivatePosition, QueryReason } from "../../engine/index";
import { cmp, compareDecimals, sortedUnique, sortReasons, type PredicateRole } from "../../policy/index";
import { parseBook, PositionRejected, selectBook } from "./book";
import { engineAccess, executeRound, queryChains, solanaRoleOf, type EngineOptions, type RunRecord } from "./chain";
import type { PositionEvidence } from "./evidence";
export interface PositionChange { field: "presence" | "subject" | "unit" | "quantity"; before: string; after: string }
export interface PositionChanged { kind: "position-changed"; positionId: string; changes: PositionChange[] }
export interface DependencyChange {
  subject: string; key: string; kind: FactChange["kind"]; role: PredicateRole | null;
  beforeFactId: string | null; afterFactId: string | null; beforeObject: string | null; afterObject: string | null; evidenceIds: string[];
}
export interface DependencyChanged {
  kind: "dependency-changed"; positionId: string; subject: string; beforeSnapshotId: string; afterSnapshotId: string;
  constructed: boolean; label: string; changes: DependencyChange[];
}
export interface WatchReport { events: (PositionChanged | DependencyChanged)[]; unknowns: QueryReason[]; runs: RunRecord[] }
export interface WatchPositionsInput {
  evidence: PositionEvidence; book: readonly PrivatePosition[]; bookBefore?: string; bookAfter?: string; before: string; after: string; engine?: EngineOptions;
}
export async function watchPositions(input: WatchPositionsInput): Promise<WatchReport> {
  const { evidence } = input;
  const before = evidence.store.snapshot(input.before), after = evidence.store.snapshot(input.after);
  if (!before || !after) throw new PositionRejected("snapshot-not-found");
  const book = parseBook(input.book), oldBook = selectBook(book, input.bookBefore), newBook = selectBook(book, input.bookAfter);
  const oldPositions = new Map(oldBook.map(p => [p.id, p])), newPositions = new Map(newBook.map(p => [p.id, p]));
  const events: WatchReport["events"] = [];
  for (const id of sortedUnique([...oldPositions.keys(), ...newPositions.keys()])) {
    const old = oldPositions.get(id), current = newPositions.get(id), changes: PositionChange[] = [];
    if (!old || !current) changes.push({ field: "presence", before: old ? "present" : "absent", after: current ? "present" : "absent" });
    else {
      for (const field of ["subject", "unit", "quantity"] as const) {
        if (field === "quantity" ? compareDecimals(old.quantity, current.quantity) !== 0 : old[field] !== current[field]) changes.push({ field, before: old[field], after: current[field] });
      }
    }
    if (changes.length) events.push({ kind: "position-changed", positionId: id, changes });
  }
  const covered = newBook.filter(p => before.subjects.includes(p.subject) && after.subjects.includes(p.subject));
  const roots = sortedUnique(covered.map(p => p.subject)), engine = engineAccess(evidence.store, input.engine);
  const oldChains = await queryChains(engine, roots, before.id, before.observedTo, false);
  const newChains = await queryChains(engine, roots, after.id, after.observedTo, false);
  const allSubjects = sortedUnique([...oldChains.chains.values(), ...newChains.chains.values()].flatMap(c => c.subjects));
  const comparison = await executeRound(engine, allSubjects.map(subject => ({ name: "changes", subject, beforeSnapshotId: before.id, afterSnapshotId: after.id, maxResults: 500 })), "changes");
  const unknowns = [...oldChains.chains.values(), ...newChains.chains.values()].flatMap(c => c.reasons);
  unknowns.push(...comparison.entries.flatMap(e => e.result.reasons));
  for (const p of newBook) if (!before.subjects.includes(p.subject) || !after.subjects.includes(p.subject)) unknowns.push({ code: "missing-coverage", subject: p.subject, ref: null });
  for (const p of covered) {
    const closure = new Set([...oldChains.chains.get(p.subject)!.subjects, ...newChains.chains.get(p.subject)!.subjects]);
    const raw = comparison.entries.filter(e => "subject" in e.request && closure.has(e.request.subject)).flatMap(e => e.result.changes);
    const changes: DependencyChange[] = [...new Map(raw.map(c => [c.key, c])).values()].sort((a, b) => cmp(a.key, b.key)).map(c => {
      const fact = c.after ?? c.before!;
      return { subject: fact.subject, key: c.key, kind: c.kind, role: solanaRoleOf(fact.predicate) ?? null,
        beforeFactId: c.before?.id ?? null, afterFactId: c.after?.id ?? null, beforeObject: c.before?.object ?? null, afterObject: c.after?.object ?? null,
        evidenceIds: sortedUnique([...(c.before?.evidenceIds ?? []), ...(c.after?.evidenceIds ?? [])]) };
    });
    if (!changes.length) continue;
    const constructed = before.constructed || after.constructed;
    events.push({ kind: "dependency-changed", positionId: p.id, subject: p.subject, beforeSnapshotId: before.id, afterSnapshotId: after.id, constructed,
      label: constructed ? "constructed: not an observed historical change" : "observed between two recorded captures", changes });
  }
  return { events: events.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.positionId, b.positionId)), unknowns: sortReasons(unknowns),
    runs: [...oldChains.runs, ...newChains.runs, ...comparison.runs] };
}
