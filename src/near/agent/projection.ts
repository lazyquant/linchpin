import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact, ObservationBound, QueryReason, QueryResult, ReviewEnvelope, ReasonCode } from "../../engine/contracts";
import { projectForModel } from "../../engine/privacy";
import { registrySha256 } from "../subjects/registry";
import { record } from "./errors";
import type { NearAgentContext } from "./types";

export const MAX_FORWARDED_FACTS = 12;
export const MAX_TOOL_BYTES = 32768;
const REASONS: readonly ReasonCode[] = ["missing-subject", "missing-history", "missing-coverage", "missing-evidence", "stale", "expired", "partial-reader", "conflict", "unknown-controller", "truncated", "incompatible-snapshots", "no-facts"];
export function stringsIn(value: unknown): Set<string> {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") found.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (record(v)) Object.values(v).forEach(visit);
  };
  visit(value); return found;
}
export function reasonsIn(value: unknown): QueryReason[] {
  const found = new Map<string, QueryReason>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (record(v)) {
      const code = REASONS.find(c => c === v.code);
      if (code && (v.subject === null || typeof v.subject === "string") && (v.ref === null || typeof v.ref === "string")) {
        const reason = { code, subject: v.subject, ref: v.ref };
        found.set(canonical(reason), reason);
      }
      Object.values(v).forEach(visit);
    }
  };
  visit(value); return [...found.values()];
}
export function resolvePublicFacts(context: NearAgentContext, value: unknown): { facts: Fact[]; receipts: EvidenceReceipt[]; reasons: QueryReason[] } {
  const references = stringsIn(value), facts = new Map<string, Fact>();
  for (const id of context.snapshotIds) for (const fact of context.store.snapshot(id)?.facts ?? []) {
    if (references.has(fact.id)) facts.set(fact.id, fact);
  }
  const sorted = [...facts.values()].sort((a, b) => a.id.localeCompare(b.id));
  const receiptIds = new Set([...references, ...sorted.flatMap(f => f.evidenceIds)]);
  const receipts = [...receiptIds].flatMap(id => context.store.receipt(id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
  return { facts: sorted, receipts, reasons: reasonsIn(value) };
}
/** A typed adapter container for the projector; it is not an execution receipt. */
export function projectionEnvelope(context: NearAgentContext, facts: Fact[], receipts: EvidenceReceipt[], reasons: QueryReason[]): ReviewEnvelope {
  const observations: ObservationBound[] = context.snapshotIds.flatMap(id => {
    const s = context.store.snapshot(id);
    return s ? [{ snapshotId: s.id, chain: s.chain, network: s.network, constructed: s.constructed,
      observedFrom: s.observedFrom, observedTo: s.observedTo, fromBlockOrSlot: s.fromBlockOrSlot,
      toBlockOrSlot: s.toBlockOrSlot, freshUntil: s.freshUntil, asOf: s.observedTo }] : [];
  });
  const result: QueryResult = { outcome: reasons.length ? "partial" : facts.length ? "complete" : "unknown", facts, receipts,
    reasons, unknowns: reasons.map(r => `${r.code}:${r.subject ?? ""}`), conflicts: [], truncated: false,
    snapshotIds: [...context.snapshotIds], observations, changes: [] };
  const request = { name: "evidence" as const, evidenceIds: receipts.map(r => r.id), maxResults: Math.max(1, receipts.length) };
  const blueprintId = "near-public-tool-projection";
  return { runId: `projection:${sha256(canonical(request))}`, blueprintId, blueprintSha256: sha256(blueprintId),
    registrySha256: registrySha256(), planSha256: sha256(canonical(request)),
    results: [{ key: "public", nodeId: "public", request, result, resultSha256: sha256(canonical(result)) }],
    review: { claims: [], unknowns: [], snapshotIds: [...context.snapshotIds], observations, policy: "not-evaluated", privacy: "public" } };
}
const TOOL_ERRORS = new Set(["timeout", "tool-failed", "unknown-policy", "missing-snapshot", "invalid-result", "unknown-tool", "invalid-tool-input", "action-mismatch", "tool-budget-exhausted"]);
const OUTCOMES = new Set(["within-policy", "outside-policy", "undetermined"]);
export function forwardTool(context: NearAgentContext, name: string, value: Record<string, unknown>, isError: boolean,
  evidence: { facts: Fact[]; receipts: EvidenceReceipt[]; reasons: QueryReason[] }, action?: unknown, resultId = "result"): { value: unknown; truncated: boolean } {
  const projection = projectForModel(projectionEnvelope(context, evidence.facts, evidence.receipts, evidence.reasons), [...context.subjects]);
  const original = projection.request.publicFacts.length;
  const facts = projection.request.publicFacts.slice(0, MAX_FORWARDED_FACTS);
  const verdict = record(value.verdict) ? value.verdict : value;
  const rawRules = Array.isArray(value.applicable) ? value.applicable : Array.isArray(verdict.rules) ? verdict.rules : [];
  const rules = rawRules.flatMap(r => record(r) && typeof r.ruleId === "string" && typeof r.outcome === "string" && OUTCOMES.has(r.outcome)
    ? [{ ruleId: r.ruleId, outcome: r.outcome }] : []);
  const policyId = typeof verdict.policyId === "string" && context.policies.has(verdict.policyId) ? verdict.policyId : undefined;
  let truncated = value.truncated === true || facts.length < original;
  const build = (): unknown => {
    const ids = new Set(facts.flatMap(f => f.evidenceIds));
    return { tool: name, resultId, shape: "table", isError, error: typeof value.error === "string" ? TOOL_ERRORS.has(value.error) ? value.error : "tool-failed" : undefined,
      snapshotIds: [...context.snapshotIds], truncated, policyId, rules,
      gate: value.gate === "open" || value.gate === "closed" || value.gate === "human" ? value.gate : undefined,
      outcome: typeof verdict.outcome === "string" && OUTCOMES.has(verdict.outcome) ? verdict.outcome : undefined,
      action,
      projection: { ...projection.request, publicFacts: facts, maxOutputTokens: 1200 },
      receipts: evidence.receipts.filter(r => ids.has(r.id)).map(r => ({ id: r.id, source: r.source, responseSha256: r.responseSha256, observation: r.observation })) };
  };
  let output = build();
  while (Buffer.byteLength(JSON.stringify(output)) > MAX_TOOL_BYTES && facts.length) {
    facts.pop(); truncated = true; output = build();
  }
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_TOOL_BYTES) {
    truncated = true;
    output = { tool: name, resultId, shape: "table", isError: true, error: "tool-result-too-large", snapshotIds: [context.snapshotId], truncated,
      projection: { blueprintId: projection.request.blueprintId, publicFacts: [], unknowns: [], maxOutputTokens: 1200 }, receipts: [] };
  }
  return { value: output, truncated };
}
