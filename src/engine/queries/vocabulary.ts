export type PredicateClass = "dependency" | "backing" | "origin" | "control" | "state";
const entry = (kind: PredicateClass, cardinality: "one" | "many") =>
  Object.freeze({ class: kind, direction: "subject-to-object" as const, cardinality });

/** Exact identities only. Display names never participate in this vocabulary. */
export const VOCABULARY = Object.freeze({
  UPGRADE_AUTHORITY: entry("control", "one"),
  MINT_AUTHORITY: entry("control", "one"),
  FREEZE_AUTHORITY: entry("control", "one"),
  CONFIG_AUTHORITY: entry("control", "one"),
  PROGRAM_DATA: entry("dependency", "one"),
  ISSUED_BY_PROGRAM: entry("dependency", "one"),
  DEPENDS_ON: entry("dependency", "many"),
  BACKED_BY: entry("backing", "many"),
  ORIGINATES_FROM: entry("origin", "one"),
  SUPPLY_RAW: entry("state", "one"),
});
export type Predicate = keyof typeof VOCABULARY;
export function isPredicate(value: string): value is Predicate {
  return Object.hasOwn(VOCABULARY, value);
}
export function isTraversalRelation(value: string): value is Predicate {
  return isPredicate(value) && ["dependency", "backing", "origin"].includes(VOCABULARY[value].class);
}
