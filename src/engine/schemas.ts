import type { QueryResult, ReviewEnvelope, Fact, EvidenceReceipt, ObservationBound } from "./contracts";
import { isRecord, parseQueryRequest } from "./queries/request";

/** JSON objects must contain only enumerable own data properties. */
export function dataRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && d.enumerable && "value" in d;
  });
}
export function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return dataRecord(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
export function dataArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
      .every(d => !!d && d.enumerable && "value" in d);
}
export function isJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = dataArray(value) && value.every(v => isJson(v, ancestors));
  } else valid = dataRecord(value) && Object.values(value).every(v => isJson(v, ancestors));
  ancestors.delete(value);
  return valid;
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
const nullableString = (v: unknown) => v === null || typeof v === "string";
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
const privacy = (v: unknown) => oneOf(v, ["public", "private"]);
function fact(v: unknown): v is Fact {
  return exactKeys(v, ["id", "subject", "predicate", "object", "basis", "status", "evidenceIds", "path", "validFrom", "validTo", "privacy"])
    && [v.id, v.subject, v.predicate, v.object].every(x => typeof x === "string")
    && oneOf(v.basis, ["claimed", "reported", "decoded", "simulated", "observed", "derived", "unknown"])
    && oneOf(v.status, ["verified", "unverified", "conflicting", "missing"])
    && strings(v.evidenceIds) && strings(v.path) && nullableString(v.validFrom) && nullableString(v.validTo) && privacy(v.privacy);
}
function receipt(v: unknown): v is EvidenceReceipt {
  if (!exactKeys(v, ["id", "source", "responseSha256", "observation", "privacy"])) return false;
  const o = v.observation;
  return [v.id, v.source, v.responseSha256].every(x => typeof x === "string") && privacy(v.privacy)
    && exactKeys(o, ["chain", "network", "blockOrSlot", "blockHash", "observedAt", "retrievedAt", "historicalState"])
    && [o.chain, o.network, o.observedAt, o.retrievedAt].every(x => typeof x === "string")
    && nullableString(o.blockOrSlot) && nullableString(o.blockHash)
    && oneOf(o.historicalState, ["pinned", "current-only", "constructed", "unknown"]);
}
function bound(v: unknown): v is ObservationBound {
  return exactKeys(v, ["snapshotId", "chain", "network", "constructed", "observedFrom", "observedTo", "fromBlockOrSlot", "toBlockOrSlot", "freshUntil", "asOf"])
    && [v.snapshotId, v.chain, v.network, v.observedFrom, v.observedTo, v.freshUntil].every(x => typeof x === "string")
    && typeof v.constructed === "boolean" && [v.fromBlockOrSlot, v.toBlockOrSlot, v.asOf].every(nullableString);
}
export function validateQueryResult(value: unknown): value is QueryResult {
  try {
    if (!isJson(value) || !exactKeys(value, ["outcome", "facts", "receipts", "unknowns", "conflicts", "truncated", "snapshotIds", "reasons", "observations", "changes"])) return false;
    return oneOf(value.outcome, ["complete", "partial", "unknown"])
      && Array.isArray(value.facts) && value.facts.every(fact)
      && Array.isArray(value.receipts) && value.receipts.every(receipt)
      && strings(value.unknowns) && strings(value.conflicts) && strings(value.snapshotIds) && typeof value.truncated === "boolean"
      && Array.isArray(value.observations) && value.observations.every(bound)
      && Array.isArray(value.reasons) && value.reasons.every(r => exactKeys(r, ["code", "subject", "ref"])
        && oneOf(r.code, ["missing-subject", "missing-history", "missing-coverage", "missing-evidence", "stale", "expired", "partial-reader", "conflict", "unknown-controller", "truncated", "incompatible-snapshots", "no-facts"])
        && nullableString(r.subject) && nullableString(r.ref))
      && Array.isArray(value.changes) && value.changes.every(c => exactKeys(c, ["kind", "key", "before", "after"])
        && typeof c.key === "string" && (c.before === null || fact(c.before)) && (c.after === null || fact(c.after))
        && (c.kind === "added" && c.before === null && c.after !== null
          || c.kind === "removed" && c.before !== null && c.after === null
          || c.kind === "changed" && c.before !== null && c.after !== null));
  } catch { return false; }
}
export function isReviewEnvelope(value: unknown): value is ReviewEnvelope {
  try {
    if (!isJson(value) || !exactKeys(value, ["runId", "blueprintId", "blueprintSha256", "registrySha256", "planSha256", "results", "review"])) return false;
    if (![value.runId, value.blueprintId, value.blueprintSha256, value.registrySha256, value.planSha256].every(x => typeof x === "string")) return false;
    if (!Array.isArray(value.results) || !value.results.every(e => {
      if (!exactKeys(e, ["key", "nodeId", "request", "result", "resultSha256"]) || ![e.key, e.nodeId, e.resultSha256].every(x => typeof x === "string") || !validateQueryResult(e.result)) return false;
      parseQueryRequest(e.request); return true;
    })) return false;
    const r = value.review;
    return exactKeys(r, ["claims", "unknowns", "snapshotIds", "observations", "policy", "privacy"])
      && strings(r.unknowns) && strings(r.snapshotIds) && Array.isArray(r.observations) && r.observations.every(bound)
      && oneOf(r.policy, ["meets-configured-checks", "violates-policy", "insufficient-evidence", "not-evaluated"]) && privacy(r.privacy)
      && Array.isArray(r.claims) && r.claims.every(c => {
        if (!exactKeys(c, ["text", "factIds", "evidenceIds", "kind", "template", "source"])) return false;
        const s = c.source;
        return typeof c.text === "string" && strings(c.factIds) && strings(c.evidenceIds)
          && oneOf(c.kind, ["fact", "interpretation", "unknown"]) && oneOf(c.template, ["fact", "change", "unchanged", "unknown"])
          && exactKeys(s, ["nodeId", "field", "index"]) && typeof s.nodeId === "string"
          && (s.field === "result" ? s.index === null : oneOf(s.field, ["facts", "changes", "reasons"]) && Number.isSafeInteger(s.index) && (s.index as number) >= 0);
      });
  } catch { return false; }
}
