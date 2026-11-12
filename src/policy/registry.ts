import type { RuleKind } from "./types";
export type { RuleKind } from "./types";
export class PolicyRejected extends Error {
  constructor(readonly code: string, readonly ruleIndex: number | null = null) {
    super(`policy${ruleIndex === null ? "" : ` rule ${ruleIndex}`}: ${code}`); this.name = "PolicyRejected";
  }
}
export interface RuleRegistry {
  get(kind: string): RuleKind | undefined;
  kinds(): string[];
  extend(kinds: readonly RuleKind[]): RuleRegistry;
}
export function createRuleRegistry(kinds: readonly RuleKind[]): RuleRegistry {
  const map = new Map<string, RuleKind>();
  for (const rule of kinds) {
    if (map.has(rule.kind)) throw new PolicyRejected("duplicate-kind");
    map.set(rule.kind, Object.freeze({ kind: rule.kind, parse: rule.parse.bind(rule), evaluate: rule.evaluate.bind(rule) }));
  }
  return Object.freeze({
    get: (kind: string) => map.get(kind),
    kinds: () => [...map.keys()].sort(),
    extend: (additional: readonly RuleKind[]) => createRuleRegistry([...map.values(), ...additional]),
  });
}
/** Require plain JSON data and exact parameter keys, without including values in errors. */
export function jsonRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).every(k => typeof k === "string" && (() => {
      const d = Object.getOwnPropertyDescriptor(input, k)!; return d.enumerable && "value" in d;
    })());
}
export function parameters(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!jsonRecord(input) || required.some(k => !Object.hasOwn(input, k))
    || Object.keys(input).some(k => !required.includes(k) && !optional.includes(k))) throw new PolicyRejected("bad-params");
  return input;
}
export function positiveInteger(input: unknown): input is number { return Number.isSafeInteger(input) && (input as number) >= 1; }
