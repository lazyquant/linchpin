# Local policy evaluation

`parsePolicy(input, registry)` validates a policy and each rule's parameters.
`evaluatePolicy(policy, store, context)` returns a deterministic verdict using the
context's explicit evaluation time. It never reads the clock or performs I/O.
Each rule lists the fact and receipt ids it used; a thrown evaluator becomes
`undetermined` with `rule-error`, without copying the exception's message.

Outcomes are `within-policy`, `outside-policy`, and `undetermined`.
`combineOutcomes` chooses outside if any rule is outside, otherwise undetermined
if any is undetermined, otherwise within. An empty list is undetermined.
`projectVerdict(verdict, publicSubjects)` removes private rule evidence and reasons
whose subjects are outside the supplied public identities. Parameters are never
part of a verdict.

The generic registry supplies `max-share-behind`, `min-exit-evidence`,
`max-evidence-age`, `controller-resolved`, and `unchanged-since`. A chain extends it
with `createGenericRegistry().extend(customKinds)`. Each kind implements
`RuleKind<P>`: `kind`, `parse(unknown): P`, and
`evaluate(P, PolicyEvidence, PolicyContext): RuleEvaluation`. Extension returns a
new immutable registry and rejects duplicate kind names. Supply a structural
`PolicyEvidence` store, a predicate-to-role function, local position chains, and a
price resolver; no chain runtime is imported by this module.

`parseDecimal(string)` returns `{coefficient: bigint, scale: number}`.
`normalizeDecimal`, `addDecimals`, and `multiplyDecimals` return normalized decimal
strings; `compareDecimals` returns -1, 0, or 1. These functions accept decimal
strings or the parsed representation and never round quantities.
