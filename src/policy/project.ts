import type { PolicyVerdict, PublicPolicyVerdict } from "./types";
export function projectVerdict(verdict: PolicyVerdict, publicSubjects: readonly string[] | ReadonlySet<string>): PublicPolicyVerdict {
  const allowed = new Set(publicSubjects);
  return {
    policyId: verdict.policyId, outcome: verdict.outcome, evaluatedAt: verdict.evaluatedAt,
    rules: verdict.rules.map(r => ({ ruleId: r.ruleId, kind: r.kind, outcome: r.outcome,
      reasons: r.reasons.filter(reason => reason.subject === null || allowed.has(reason.subject)).map(r => ({ ...r })),
      factIds: [...r.factIds], receiptIds: [...r.receiptIds] })),
  };
}
