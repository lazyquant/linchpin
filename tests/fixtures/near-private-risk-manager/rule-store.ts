/**
 * Small mutated snapshots for rule tests. Every case starts from the committed live
 * snapshot, then drops or adds facts, so the evidence ids and receipts stay valid.
 * The result is a validated snapshot (validateSnapshot), never a hand-forged object.
 */
import { join } from "node:path";
import { openStore, validateSnapshot, type EvidenceSnapshot, type EvidenceStore, type Fact } from "../../../src/engine/index";
import { buildNearSnapshot } from "../../../src/near/reader/index";
import { createNearRegistry, evaluateNearPolicy, NO_LIBRARIES, type NearLibraries } from "../../../src/near/policy/index";
import { parsePolicy } from "../../../src/policy/index";

export const NEAR_ROOT = join(import.meta.dir, "..", "..", "..", "fixtures", "near");
export const LIVE = "near-2026-11-09";
export const N = (account: string) => `near:mainnet:${account}`;
let base: EvidenceSnapshot | undefined;
export function liveSnapshot(): EvidenceSnapshot { return base ??= buildNearSnapshot(LIVE, { root: NEAR_ROOT }); }

export interface Mutation {
  id?: string;
  drop?: (f: Fact) => boolean;
  add?: { subject: string; predicate: string; object: string; status?: Fact["status"] }[];
  shiftObservedMs?: number;
}
export function mutate(m: Mutation): EvidenceSnapshot {
  const s = structuredClone(liveSnapshot());
  const receipt = s.receipts[0].id;
  s.id = m.id ?? "tst-mutated";
  s.facts = s.facts.filter(f => !m.drop?.(f));
  (m.add ?? []).forEach((a, i) => {
    if (!s.subjects.includes(a.subject)) s.subjects.push(a.subject);
    s.facts.push({ id: `tst-added-${i}`, subject: a.subject, predicate: a.predicate, object: a.object, basis: "observed", status: a.status ?? "verified", evidenceIds: [receipt], path: [], validFrom: null, validTo: null, privacy: "public" });
  });
  s.subjects.sort();
  if (m.shiftObservedMs) {
    const shift = (t: string) => new Date(Date.parse(t) + m.shiftObservedMs!).toISOString();
    for (const r of s.receipts) r.observation.observedAt = shift(r.observation.observedAt);
    s.observedFrom = shift(s.observedFrom); s.observedTo = shift(s.observedTo); s.freshUntil = shift(s.freshUntil);
  }
  return validateSnapshot(s);
}

export type Outcome = "within-policy" | "outside-policy" | "undetermined";
export function evaluateRule(kind: string, params: Record<string, unknown>, snap: EvidenceSnapshot = liveSnapshot(), libs: NearLibraries = NO_LIBRARIES, extra: EvidenceSnapshot[] = []) {
  const store: EvidenceStore = openStore([snap, ...extra]);
  const policy = parsePolicy({ policyId: "tst", subjects: [N("intents.near")], rules: [{ id: "r", kind, params }] }, createNearRegistry(libs));
  const verdict = evaluateNearPolicy(policy, store, snap.id, libs);
  const rule = verdict.rules[0];
  return { verdict, rule, outcome: rule.outcome as Outcome, codes: rule.reasons.map((r: { code: string }) => r.code) };
}
