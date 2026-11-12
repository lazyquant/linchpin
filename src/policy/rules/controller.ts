import type { RuleKind } from "../types";
import { parameters, PolicyRejected } from "../registry";
import { evaluation, factUsableAt, POLICY_SUBJECT_PATTERN, reason } from "../evaluate";
export const controllerResolved: RuleKind<{ account: string }> = {
  kind: "controller-resolved",
  parse(input) {
    const p = parameters(input, ["account"]);
    if (typeof p.account !== "string" || !POLICY_SUBJECT_PATTERN.test(p.account)) throw new PolicyRejected("bad-params");
    return { account: p.account };
  },
  evaluate(p, store, ctx) {
    const snapshot = store.snapshot(ctx.snapshotId);
    if (!snapshot) return evaluation("undetermined", [reason("missing-snapshot", p.account, ctx.snapshotId)]);
    if (!snapshot.subjects.includes(p.account)) return evaluation("undetermined", [reason("missing-fact", p.account)]);
    const all = store.factsFrom(ctx.snapshotId, p.account).filter(f => ctx.roleOf(f.predicate) === "control");
    const facts = all.filter(f => factUsableAt(f, store, ctx.evaluatedAt));
    if (facts.length !== all.length) return evaluation("undetermined", [reason("observed-after-evaluation", p.account)], facts);
    if (!facts.length) return evaluation("undetermined", [reason("missing-fact", p.account)]);
    if (facts.some(f => f.status === "conflicting")) return evaluation("outside-policy", [reason("conflict", p.account)], facts);
    if (facts.some(f => f.object === "unknown" || f.basis === "unknown" || f.status !== "verified")) return evaluation("undetermined", [reason("unknown-controller", p.account)], facts);
    return evaluation("within-policy", [], facts);
  },
};
