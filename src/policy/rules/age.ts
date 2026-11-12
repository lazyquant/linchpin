import type { Outcome, PolicyEvidence, RuleKind, RuleReason } from "../types";
import { GAP_REASON_CODES } from "../types";
import { parameters, PolicyRejected, positiveInteger } from "../registry";
import { combineOutcomes, evaluation, reason, sortedUnique } from "../evaluate";
/** Receipt age is measured against the supplied evaluation time, never the clock. */
export function receiptAgeReasons(ids: readonly string[], subject: string | null, days: number, store: PolicyEvidence, at: string): RuleReason[] {
  return sortedUnique(ids).flatMap(id => {
    const receipt = store.receipt(id);
    if (!receipt) return [reason("missing-evidence", subject, id)];
    const age = Date.parse(at) - Date.parse(receipt.observation.observedAt);
    if (!Number.isFinite(age) || age < 0) return [reason("observed-after-evaluation", subject, id)];
    if (age > days * 86_400_000) return [reason("stale-evidence", subject, id)];
    return [];
  });
}
export function ageOutcome(reasons: readonly RuleReason[]): Outcome {
  return reasons.some(r => r.code === "stale-evidence") ? "outside-policy" : reasons.length ? "undetermined" : "within-policy";
}
export const maxEvidenceAge: RuleKind<{ days: number }> = {
  kind: "max-evidence-age",
  parse(input) {
    const p = parameters(input, ["days"]);
    if (!positiveInteger(p.days)) throw new PolicyRejected("bad-params");
    return { days: p.days };
  },
  evaluate(p, store, ctx) {
    const targets = ctx.positions.filter(p => p.inScope);
    if (!targets.length) return evaluation("undetermined", [reason("no-positions")]);
    const results = targets.map(position => {
      if (!position.chain) return evaluation("undetermined", [reason("uncovered-position")]);
      const { facts, exit, reasons: gaps } = position.chain;
      const receiptIds = [...facts.flatMap(f => f.evidenceIds), ...exit.flatMap(item => item.receiptIds)];
      const reasons = receiptAgeReasons(receiptIds, position.subject, p.days, store, ctx.evaluatedAt);
      reasons.push(...gaps.filter(r => GAP_REASON_CODES.includes(r.code)).map(r => reason("incomplete-chain", r.subject, r.code)));
      if (!facts.length) reasons.push(reason("missing-fact", position.subject));
      if (facts.some(f => !f.evidenceIds.length)) reasons.push(reason("missing-evidence", position.subject));
      return { ...evaluation(ageOutcome(reasons), reasons, facts), receiptIds };
    });
    return { outcome: combineOutcomes(results.map(r => r.outcome)), reasons: results.flatMap(r => r.reasons),
      factIds: results.flatMap(r => r.factIds), receiptIds: results.flatMap(r => r.receiptIds), evidence: {} };
  },
};
