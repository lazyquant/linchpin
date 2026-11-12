import type { EvidenceReceipt, Fact } from "../contracts";
import { canonical } from "../../chain/evidence";
import { ID_PATTERN, SUBJECT_PATTERN, isRecord, isTime } from "./request";
import { isPredicate } from "./vocabulary";

export interface EvidenceSnapshot {
  version: 1;
  id: string;
  chain: "solana" | "near" | "ethereum";
  network: "mainnet-beta" | "devnet" | "testnet" | "mainnet";
  constructed: boolean;
  observedFrom: string;
  observedTo: string;
  fromBlockOrSlot: string | null;
  toBlockOrSlot: string | null;
  freshUntil: string;
  subjects: string[];
  readers: { id: string; status: "complete" | "partial" | "failed"; subjects: string[] }[];
  names: Record<string, string>;
  receipts: EvidenceReceipt[];
  facts: Fact[];
}
export interface EvidenceStore {
  snapshot(id: string): EvidenceSnapshot | undefined;
  receipt(id: string): EvidenceReceipt | undefined;
  factsFrom(snapshotId: string, subject: string): Fact[];
  /** Reverse provenance index for the evidence query, which has no snapshot in its request. */
  snapshotsForReceipt(id: string): EvidenceSnapshot[];
}
export class SnapshotRejected extends Error {
  constructor(detail: string) { super(`Snapshot rejected: ${detail}`); this.name = "SnapshotRejected"; }
}
function check(ok: unknown, detail: string): asserts ok { if (!ok) throw new SnapshotRejected(detail); }
function object(value: unknown, fields?: string[]): Record<string, unknown> {
  check(isRecord(value), "expected plain object");
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === "string", "unexpected symbol key");
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    check(d.enumerable && "value" in d, "expected JSON properties");
  }
  if (fields) check(Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k)), "unexpected or missing fields");
  return value;
}
function text(value: unknown): asserts value is string { check(typeof value === "string", "expected string"); }
function id(value: unknown): asserts value is string { text(value); check(ID_PATTERN.test(value), "malformed id"); }
function time(value: unknown): asserts value is string { check(isTime(value), "malformed time"); }
function nullableTime(value: unknown) { if (value !== null) time(value); }
function slot(value: unknown): asserts value is string | null { check(value === null || typeof value === "string" && /^\d+$/.test(value), "malformed slot"); }
function array(value: unknown): unknown[] { check(Array.isArray(value), "expected array"); return Array.from(value); }
function uniqueStrings(value: unknown, validate: (v: unknown) => void): string[] {
  const a = array(value); a.forEach(validate);
  check(new Set(a).size === a.length, "duplicate entry"); return a as string[];
}
function oneOf(value: unknown, values: readonly unknown[]) { check(values.includes(value), "unknown enum value"); }
function subject(value: unknown, network: unknown, chain: unknown): asserts value is string {
  text(value); check(SUBJECT_PATTERN.test(value) && value.startsWith(`${chain}:${network}:`), "malformed or incompatible subject");
}
function privacy(value: unknown) { oneOf(value, ["public", "private"]); }

/** Validate at the storage boundary and return an owned copy, never the caller's mutable input. */
export function validateSnapshot(input: unknown): EvidenceSnapshot {
  const s = object(input, ["version", "id", "chain", "network", "constructed", "observedFrom", "observedTo", "fromBlockOrSlot", "toBlockOrSlot", "freshUntil", "subjects", "readers", "names", "receipts", "facts"]);
  check(s.version === 1 && (s.chain === "solana" || s.chain === "near" || s.chain === "ethereum"), "unsupported snapshot version or chain");
  id(s.id); oneOf(s.network, s.chain === "near" ? ["mainnet", "testnet"] : s.chain === "ethereum" ? ["mainnet"] : ["mainnet-beta", "devnet", "testnet"]);
  check(typeof s.constructed === "boolean", "expected constructed flag");
  time(s.observedFrom); time(s.observedTo); time(s.freshUntil);
  check(Date.parse(s.observedFrom) <= Date.parse(s.observedTo), "inverted observation boundary");
  slot(s.fromBlockOrSlot); slot(s.toBlockOrSlot);
  if (s.fromBlockOrSlot !== null && s.toBlockOrSlot !== null) check(BigInt(s.fromBlockOrSlot) <= BigInt(s.toBlockOrSlot), "inverted slot boundary");
  const subjects = uniqueStrings(s.subjects, v => subject(v, s.network, s.chain));
  const readerIds = new Set<string>();
  for (const value of array(s.readers)) {
    const r = object(value, ["id", "status", "subjects"]); id(r.id);
    check(!readerIds.has(r.id), "duplicate reader id"); readerIds.add(r.id);
    oneOf(r.status, ["complete", "partial", "failed"]);
    for (const member of uniqueStrings(r.subjects, v => subject(v, s.network, s.chain))) check(subjects.includes(member), "reader subject outside coverage");
  }
  const names = object(s.names);
  for (const [key, value] of Object.entries(names)) { subject(key, s.network, s.chain); text(value); }
  const receipts = new Map<string, EvidenceReceipt>();
  for (const value of array(s.receipts)) {
    const r = object(value, ["id", "source", "responseSha256", "observation", "privacy"]);
    id(r.id); text(r.source); check(r.source.trim().length > 0 && !r.source.includes("://"), "missing or URL receipt source");
    text(r.responseSha256); check(/^[0-9a-fA-F]{64}$/.test(r.responseSha256), "malformed response hash"); privacy(r.privacy);
    const o = object(r.observation, ["chain", "network", "blockOrSlot", "blockHash", "observedAt", "retrievedAt", "historicalState"]);
    check(o.chain === s.chain && o.network === s.network, "receipt network mismatch");
    slot(o.blockOrSlot); check(o.blockHash === null || typeof o.blockHash === "string" && o.blockHash.length > 0, "malformed block hash");
    time(o.observedAt); time(o.retrievedAt); oneOf(o.historicalState, ["pinned", "current-only", "constructed", "unknown"]);
    check(s.constructed === (o.historicalState === "constructed"), "constructed provenance mismatch");
    const old = receipts.get(r.id);
    check(!old || canonical(old) === canonical(r), "duplicate receipt id with different content");
    receipts.set(r.id, r as unknown as EvidenceReceipt);
  }
  if (receipts.size) {
    const times = [...receipts.values()].map(r => Date.parse(r.observation.observedAt));
    check(Date.parse(s.observedFrom) === Math.min(...times) && Date.parse(s.observedTo) === Math.max(...times), "observation bounds do not match receipts");
    for (const r of receipts.values()) {
      const block = r.observation.blockOrSlot;
      if (block !== null) {
        if (s.fromBlockOrSlot !== null) check(BigInt(block) >= BigInt(s.fromBlockOrSlot), "receipt before slot boundary");
        if (s.toBlockOrSlot !== null) check(BigInt(block) <= BigInt(s.toBlockOrSlot), "receipt after slot boundary");
      }
    }
  }
  const factIds = new Set<string>();
  for (const value of array(s.facts)) {
    const f = object(value, ["id", "subject", "predicate", "object", "basis", "status", "evidenceIds", "path", "validFrom", "validTo", "privacy"]);
    id(f.id); check(!factIds.has(f.id), "duplicate fact id"); factIds.add(f.id);
    subject(f.subject, s.network, s.chain); check(subjects.includes(f.subject), "fact subject outside coverage");
    text(f.predicate); check(isPredicate(f.predicate), "unknown predicate");
    text(f.object); check(SUBJECT_PATTERN.test(f.object) || ["none", "unknown"].includes(f.object) || /^amount:\d+$/.test(f.object) || ((s.chain === "near" || s.chain === "ethereum") && f.object.length > 0 && f.object.length <= 1048576 && !/[\u0000-\u001f]/.test(f.object)), "malformed fact object");
    if (SUBJECT_PATTERN.test(f.object)) subject(f.object, s.network, s.chain);
    oneOf(f.basis, ["claimed", "reported", "decoded", "simulated", "observed", "derived", "unknown"]);
    oneOf(f.status, ["verified", "unverified", "conflicting", "missing"]); privacy(f.privacy);
    const evidenceIds = uniqueStrings(f.evidenceIds, id);
    check(evidenceIds.length > 0 && evidenceIds.every(e => receipts.has(e)), "unresolved or empty fact evidence");
    check(f.basis !== "derived" || evidenceIds.length >= 2, "derived fact needs distinct input receipts");
    if (f.privacy === "public") check(evidenceIds.every(e => receipts.get(e)!.privacy === "public"), "public fact with private evidence");
    array(f.path).forEach(id); nullableTime(f.validFrom); nullableTime(f.validTo);
    if (f.validFrom !== null && f.validTo !== null) check(Date.parse(f.validFrom as string) < Date.parse(f.validTo as string), "empty or inverted validity interval");
    if (evidenceIds.every(e => receipts.get(e)!.observation.historicalState === "current-only")) check(f.validFrom === null, "current-only fact cannot assert historical validity");
  }
  const result = structuredClone(input) as EvidenceSnapshot;
  result.receipts = [...receipts.values()].map(r => structuredClone(r));
  return result;
}

export function openStore(inputs: unknown[]): EvidenceStore {
  check(Array.isArray(inputs), "expected snapshots array");
  const snapshots = new Map<string, EvidenceSnapshot>();
  const receipts = new Map<string, EvidenceReceipt>();
  const membership = new Map<string, Set<string>>();
  const facts = new Map<string, Map<string, Fact[]>>();
  for (const input of inputs) {
    const s = validateSnapshot(input);
    const previous = snapshots.get(s.id);
    check(!previous || canonical(previous) === canonical(s), "duplicate snapshot id with different content");
    if (previous) continue;
    snapshots.set(s.id, s);
    const bySubject = new Map<string, Fact[]>();
    for (const f of s.facts) { const bucket = bySubject.get(f.subject) ?? []; bucket.push(f); bySubject.set(f.subject, bucket); }
    facts.set(s.id, bySubject);
    for (const r of s.receipts) {
      const previousReceipt = receipts.get(r.id);
      check(!previousReceipt || canonical(previousReceipt) === canonical(r), "duplicate receipt id with different content");
      receipts.set(r.id, r);
      const ids = membership.get(r.id) ?? new Set<string>(); ids.add(s.id); membership.set(r.id, ids);
    }
  }
  // Copies at both boundaries protect replay from mutations of inputs or prior results.
  return {
    snapshot: id => { const s = snapshots.get(id); return s && structuredClone(s); },
    receipt: id => { const r = receipts.get(id); return r && structuredClone(r); },
    factsFrom: (snapshotId, subject) => structuredClone(facts.get(snapshotId)?.get(subject) ?? []),
    snapshotsForReceipt: id => [...membership.get(id) ?? []].sort().map(s => structuredClone(snapshots.get(s)!)),
  };
}
