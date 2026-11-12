import type { Fact } from "../../engine/contracts";
import type { RuleKind } from "../types";
import { parameters, PolicyRejected } from "../registry";
import { combineOutcomes, evaluation, factUsableAt, ID_PATTERN, POLICY_SUBJECT_PATTERN, reason, sortedUnique } from "../evaluate";
export const unchangedSince: RuleKind<{ snapshotId: string; factKeys: string[] }> = {
  kind: "unchanged-since",
  parse(input) {
    const p = parameters(input, ["snapshotId", "factKeys"]);
    if (typeof p.snapshotId !== "string" || !ID_PATTERN.test(p.snapshotId) || !Array.isArray(p.factKeys)
      || !p.factKeys.length || p.factKeys.length > 64 || new Set(p.factKeys).size !== p.factKeys.length
      || p.factKeys.some(key => {
        if (typeof key !== "string") return true;
        const parts = key.split("|");
        return ![2, 3].includes(parts.length) || !POLICY_SUBJECT_PATTERN.test(parts[0]!)
          || !/^[A-Z][A-Z0-9_]{0,127}$/.test(parts[1]!) || (parts.length === 3 && (!parts[2] || /\s/.test(parts[2])));
      })) throw new PolicyRejected("bad-params");
    return { snapshotId: p.snapshotId, factKeys: [...p.factKeys] };
  },
  evaluate(p, store, ctx) {
    const earlier = store.snapshot(p.snapshotId), current = store.snapshot(ctx.snapshotId);
    if (!earlier || !current) return evaluation("undetermined", [reason("missing-snapshot", null, !earlier ? p.snapshotId : ctx.snapshotId)]);
    const results = p.factKeys.map(key => {
      const [subject, predicate, object] = key.split("|") as [string, string, string | undefined];
      if (!earlier.subjects.includes(subject) || !current.subjects.includes(subject)) return evaluation("undetermined", [reason("missing-fact", subject, key)]);
      const matches = (f: Fact) => f.predicate === predicate && (object === undefined || f.object === object);
      const e = store.factsFrom(p.snapshotId, subject).filter(matches), n = store.factsFrom(ctx.snapshotId, subject).filter(matches);
      const facts = [...e, ...n];
      if (facts.some(f => !factUsableAt(f, store, ctx.evaluatedAt))) return evaluation("undetermined", [reason("observed-after-evaluation", subject, key)], facts.filter(f => factUsableAt(f, store, ctx.evaluatedAt)));
      if (!e.length || !n.length) return evaluation("undetermined", [reason("missing-fact", subject, key)], facts);
      if (facts.some(f => f.object === "unknown" || f.basis === "unknown" || f.status !== "verified")) return evaluation("undetermined", [reason(ctx.roleOf(predicate) === "control" ? "unknown-controller" : "missing-coverage", subject, key)], facts);
      const signatures = (facts: Fact[]) => JSON.stringify(sortedUnique(facts.map(f => JSON.stringify({ object: f.object, status: f.status, basis: f.basis }))));
      return signatures(e) === signatures(n) ? evaluation("within-policy", [], facts) : evaluation("outside-policy", [reason("changed", subject, key)], facts);
    });
    return { outcome: combineOutcomes(results.map(r => r.outcome)), reasons: results.flatMap(r => r.reasons),
      factIds: results.flatMap(r => r.factIds), receiptIds: results.flatMap(r => r.receiptIds), evidence: {} };
  },
};
