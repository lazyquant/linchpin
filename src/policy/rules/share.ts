import type { RuleKind, RuleReason } from "../types";
import { GAP_REASON_CODES } from "../types";
import { parameters, PolicyRejected } from "../registry";
import { addDecimals, compareDecimals, multiplyDecimals } from "../decimal";
import { evaluation, reason, sortedUnique, factUsableAt } from "../evaluate";
export interface ShareParams { kind: "controller" | "oracle-source"; maxPercent: number; basis: "count" | "value" }
export const maxShareBehind: RuleKind<ShareParams> = {
  kind: "max-share-behind",
  parse(input) {
    const p = parameters(input, ["kind", "maxPercent", "basis"]);
    if (!["controller", "oracle-source"].includes(p.kind as string) || !["count", "value"].includes(p.basis as string)
      || !Number.isInteger(p.maxPercent) || (p.maxPercent as number) < 0 || (p.maxPercent as number) > 99) throw new PolicyRejected("bad-params");
    return p as unknown as ShareParams;
  },
  evaluate(p, store, ctx) {
    const targets = ctx.positions.filter(p => p.inScope);
    if (!targets.length) return evaluation("undetermined", [reason("no-positions")]);
    let weights = targets.map(() => "1");
    if (p.basis === "value") {
      const prices = targets.map(position => ctx.price(position.unit));
      if (prices.some(price => price === null)) return evaluation("undetermined", [reason("missing-price")]);
      if (new Set(prices.map(price => price!.unitOfAccount)).size !== 1) return evaluation("undetermined", [reason("incomparable-units")]);
      weights = targets.map((position, i) => multiplyDecimals(position.quantity, prices[i]!.value));
    }
    const total = weights.reduce((a, b) => addDecimals(a, b), "0");
    if (compareDecimals(total, "0") === 0) return evaluation("undetermined", [reason("no-positions")]);
    const role = p.kind === "controller" ? "control" : "oracle";
    const positions = targets.map((position, i) => {
      const facts = position.chain?.facts.filter(f => ctx.roleOf(f.predicate) === role) ?? [];
      const usable = facts.filter(f => factUsableAt(f, store, ctx.evaluatedAt));
      const members = new Set(usable.filter(f => f.status === "verified" && f.object !== "none" && f.object !== "unknown").map(f => f.object));
      const unknown = position.chain === null || position.chain.reasons.some(r => GAP_REASON_CODES.includes(r.code))
        || !facts.length || usable.length !== facts.length || facts.some(f => f.object === "unknown" || f.basis === "unknown" || f.status !== "verified");
      return { facts: usable, members, unknown, weight: weights[i]! };
    });
    const members = sortedUnique(positions.flatMap(p => [...p.members]));
    const exceeds = (value: string) => compareDecimals(multiplyDecimals(value, "100"), multiplyDecimals(total, String(p.maxPercent))) > 0;
    const sum = (items: typeof positions) => items.reduce((sum, p) => addDecimals(sum, p.weight), "0");
    const outside: RuleReason[] = [], uncertain: RuleReason[] = [];
    for (const member of members) {
      const lower = sum(positions.filter(p => p.members.has(member)));
      const upper = addDecimals(lower, sum(positions.filter(p => p.unknown && !p.members.has(member))));
      if (exceeds(lower)) outside.push(reason("share-exceeded", member));
      else if (exceeds(upper)) uncertain.push(reason("share-uncertain", member));
    }
    if (exceeds(sum(positions.filter(p => p.unknown)))) uncertain.push(reason("share-uncertain"));
    return { ...evaluation(outside.length ? "outside-policy" : uncertain.length ? "undetermined" : "within-policy",
      outside.length ? outside : uncertain, positions.flatMap(p => p.facts)),
      evidence: { basis: p.basis, positions: positions.length, candidates: members.length } };
  },
};
