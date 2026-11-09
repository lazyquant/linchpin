import type { QueryRequest, QueryScope } from "../contracts";
import { isTraversalRelation } from "./vocabulary";

export const MAX_HOPS = 8;
export const MAX_RESULTS = 500;
export const MAX_RELATIONS = 16;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SUBJECT_PATTERN = /^solana:(mainnet-beta|devnet|testnet):[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export type RejectionCode = "not-object" | "unknown-name" | "extra-key" | "missing-key" | "wrong-type"
  | "nonfinite-number" | "unbounded-limit" | "malformed-identity" | "malformed-id" | "malformed-time"
  | "unknown-relation" | "duplicate-entry";
export class QueryRejected extends Error {
  constructor(public readonly code: RejectionCode) { super(`Query rejected: ${code}`); this.name = "QueryRejected"; }
}
function reject(code: RejectionCode): never { throw new QueryRejected(code); }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function isTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) reject("not-object");
  // Accessors, symbols and non-enumerable keys are not part of the JSON contract.
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") reject("extra-key");
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!d.enumerable || !("value" in d)) reject("wrong-type");
  }
  return value;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).some(k => !expected.includes(k))) reject("extra-key");
  if (expected.some(k => !Object.hasOwn(value, k))) reject("missing-key");
}
function string(value: unknown): string {
  if (typeof value !== "string") reject("wrong-type");
  return value;
}
function id(value: unknown): string {
  const s = string(value); if (!ID_PATTERN.test(s)) reject("malformed-id"); return s;
}
function subject(value: unknown): string {
  const s = string(value); if (!SUBJECT_PATTERN.test(s)) reject("malformed-identity"); return s;
}
function limit(value: unknown, maximum: number): number {
  if (typeof value !== "number") reject("wrong-type");
  if (!Number.isFinite(value)) reject("nonfinite-number");
  if (!Number.isInteger(value) || value < 1 || value > maximum) reject("unbounded-limit");
  return value;
}
function strings(value: unknown, maximum: number, parse: (value: unknown) => string): string[] {
  if (!Array.isArray(value)) reject("wrong-type");
  if (value.length < 1 || value.length > maximum) reject("unbounded-limit");
  const result = Array.from(value, parse);
  if (new Set(result).size !== result.length) reject("duplicate-entry");
  return result;
}
function scope(value: unknown): QueryScope {
  const v = record(value); keys(v, ["asOf", "snapshotId", "maxHops", "maxResults"]);
  const asOf = string(v.asOf); if (!isTime(asOf)) reject("malformed-time");
  return { asOf, snapshotId: id(v.snapshotId), maxHops: limit(v.maxHops, MAX_HOPS), maxResults: limit(v.maxResults, MAX_RESULTS) };
}
/** Validate and copy the entire request before any storage operation is allowed. */
export function parseQueryRequest(input: unknown): QueryRequest {
  const v = record(input);
  if (!Object.hasOwn(v, "name")) reject("missing-key");
  const name = string(v.name);
  switch (name) {
    case "dependencies":
      keys(v, ["name", "subject", "relations", "scope"]);
      return { name, subject: subject(v.subject), scope: scope(v.scope), relations: strings(v.relations, MAX_RELATIONS, value => {
        const s = string(value); if (!isTraversalRelation(s)) reject("unknown-relation"); return s;
      }) };
    case "control":
      keys(v, ["name", "subject", "scope"]);
      return { name, subject: subject(v.subject), scope: scope(v.scope) };
    case "changes":
      keys(v, ["name", "subject", "beforeSnapshotId", "afterSnapshotId", "maxResults"]);
      return { name, subject: subject(v.subject), beforeSnapshotId: id(v.beforeSnapshotId), afterSnapshotId: id(v.afterSnapshotId), maxResults: limit(v.maxResults, MAX_RESULTS) };
    case "evidence": {
      keys(v, ["name", "evidenceIds", "maxResults"]);
      const maxResults = limit(v.maxResults, MAX_RESULTS);
      return { name, maxResults, evidenceIds: strings(v.evidenceIds, maxResults, id) };
    }
    default: return reject("unknown-name");
  }
}
