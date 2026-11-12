import type { Fact } from "../engine/contracts";
import type { Outcome, Policy, PolicyContext, PolicyEvidence, PolicyVerdict, RuleEvaluation, RuleReason } from "./types";
import { jsonRecord, PolicyRejected, type RuleRegistry } from "./registry";
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const POLICY_SUBJECT_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9-]+:[^\s|]{1,128}$/;
export const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort(cmp);
export function sortReasons<T extends RuleReason>(reasons: readonly T[]): T[] {
  return [...new Map(reasons.map(r => [JSON.stringify([r.code, r.subject, r.ref]), r])).values()]
    .sort((a, b) => cmp(a.code, b.code) || cmp(a.subject ?? "", b.subject ?? "") || cmp(a.ref ?? "", b.ref ?? ""));
}
export function combineOutcomes(outcomes: readonly Outcome[]): Outcome {
  return outcomes.includes("outside-policy") ? "outside-policy"
    : !outcomes.length || outcomes.includes("undetermined") ? "undetermined" : "within-policy";
}
export function parsePolicy(input: unknown, registry: RuleRegistry): Policy {
  const exact = (value: unknown, keys: string[]) => jsonRecord(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  if (!exact(input, ["policyId", "subjects", "rules"])) throw new PolicyRejected("schema");
  const p = input as Record<string, unknown>;
  if (typeof p.policyId !== "string" || !ID_PATTERN.test(p.policyId) || !Array.isArray(p.subjects) || !Array.isArray(p.rules)) throw new PolicyRejected("schema");
  if (!p.subjects.length) throw new PolicyRejected("empty-subjects");
  if (p.subjects.some(s => typeof s !== "string" || !POLICY_SUBJECT_PATTERN.test(s)) || new Set(p.subjects).size !== p.subjects.length) throw new PolicyRejected("schema");
  if (!p.rules.length) throw new PolicyRejected("empty-rules");
  const seen = new Set<string>();
  const rules = p.rules.map((r: unknown, index: number) => {
    if (!exact(r, ["id", "kind", "params"])) throw new PolicyRejected("schema", index);
    const v = r as Record<string, unknown>;
    if (typeof v.id !== "string" || !ID_PATTERN.test(v.id) || typeof v.kind !== "string" || !jsonRecord(v.params)) throw new PolicyRejected("schema", index);
    if (seen.has(v.id)) throw new PolicyRejected("duplicate-rule-id", index);
    seen.add(v.id);
    const kind = registry.get(v.kind);
    if (!kind) throw new PolicyRejected("unknown-kind", index);
    try { kind.parse(v.params); } catch { throw new PolicyRejected("bad-params", index); }
    return { id: v.id, kind: v.kind, params: structuredClone(v.params) };
  });
  return { policyId: p.policyId, subjects: [...p.subjects], rules };
}
export function factUsableAt(fact: Fact, store: PolicyEvidence, evaluatedAt: string): boolean {
  return fact.evidenceIds.every(id => {
    const receipt = store.receipt(id);
    return receipt !== undefined && Date.parse(receipt.observation.observedAt) <= Date.parse(evaluatedAt);
  });
}
/** The outcome is always named: a rule that forgets it must not pass by default. */
export function evaluation(outcome: Outcome, reasons: RuleReason[] = [], facts: Fact[] = []): RuleEvaluation {
  return { outcome, reasons, factIds: facts.map(f => f.id), receiptIds: facts.flatMap(f => f.evidenceIds), evidence: {} };
}
export function reason(code: string, subject: string | null = null, ref: string | null = null): RuleReason { return { code, subject, ref }; }
export function evaluatePolicy(policy: Policy, store: PolicyEvidence, context: PolicyContext): PolicyVerdict {
  const parsed = parsePolicy(policy, context.registry);
  const rules = parsed.rules.map(rule => {
    let result: RuleEvaluation;
    try {
      const kind = context.registry.get(rule.kind)!;
      result = kind.evaluate(kind.parse(rule.params), store, context);
      if (!["within-policy", "outside-policy", "undetermined"].includes(result.outcome)
        || result.reasons.some(r => !/^[a-z][a-z0-9-]{0,63}$/.test(r.code)
          || (r.subject !== null && typeof r.subject !== "string") || (r.ref !== null && typeof r.ref !== "string"))
        || [...result.factIds, ...result.receiptIds].some(id => typeof id !== "string")) throw new Error();
      result = { outcome: result.outcome, reasons: sortReasons(result.reasons), factIds: sortedUnique(result.factIds), receiptIds: sortedUnique(result.receiptIds), evidence: structuredClone(result.evidence) };
    } catch { result = evaluation("undetermined", [reason("rule-error")]); }
    return { ruleId: rule.id, kind: rule.kind, ...result };
  });
  return { policyId: parsed.policyId, outcome: combineOutcomes(rules.map(r => r.outcome)), evaluatedAt: context.evaluatedAt, rules };
}
