import type { RuleKind } from "../types";
import { parameters, PolicyRejected, positiveInteger } from "../registry";
import { combineOutcomes, evaluation, ID_PATTERN, reason } from "../evaluate";
import { ageOutcome, receiptAgeReasons } from "./age";
export const minExitEvidence: RuleKind<{ maxAgeDays: number; positions?: string[] }> = {
  kind: "min-exit-evidence",
  parse(input) {
    const p = parameters(input, ["maxAgeDays"], ["positions"]);
    if (!positiveInteger(p.maxAgeDays) || (Object.hasOwn(p, "positions") && (!Array.isArray(p.positions)
      || p.positions.some(id => typeof id !== "string" || !ID_PATTERN.test(id)) || new Set(p.positions).size !== p.positions.length))) throw new PolicyRejected("bad-params");
    return { maxAgeDays: p.maxAgeDays, ...(p.positions === undefined ? {} : { positions: [...p.positions as string[]] }) };
  },
  evaluate(p, store, ctx) {
    const targets = p.positions ? p.positions.map(id => ctx.positions.find(position => position.positionRef === id)) : ctx.positions.filter(p => p.inScope);
    if (!targets.length) return evaluation("undetermined", [reason("no-positions")]);
    const results = targets.map(position => {
      if (!position) return evaluation("undetermined", [reason("unknown-position")]);
      if (!position.chain) return evaluation("undetermined", [reason("uncovered-position")]);
      const liquidity = position.chain.exit.filter(e => e.role === "idle" || e.role === "available-liquidity");
      const constraints = position.chain.exit.filter(e => e.role === "withdrawal-constraint");
      const utilization = position.chain.exit.filter(e => e.role === "utilization");
      const items = [...liquidity, ...constraints];
      const reasons = items.flatMap(item => item.receiptIds.length
        ? receiptAgeReasons(item.receiptIds, item.subject, p.maxAgeDays, store, ctx.evaluatedAt)
        : [reason("missing-evidence", item.subject)]);
      if (!liquidity.length && utilization.length) reasons.push(reason("utilization-only", position.subject));
      else if (!liquidity.length || !constraints.length) reasons.push(reason("missing-exit-evidence", position.subject));
      return { outcome: ageOutcome(reasons), reasons, factIds: items.flatMap(i => i.factIds), receiptIds: items.flatMap(i => i.receiptIds), evidence: {} };
    });
    return { outcome: combineOutcomes(results.map(r => r.outcome)), reasons: results.flatMap(r => r.reasons),
      factIds: results.flatMap(r => r.factIds), receiptIds: results.flatMap(r => r.receiptIds), evidence: {} };
  },
};
