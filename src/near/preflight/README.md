# NEAR preflight

`preflight(action, policy, ctx)` checks the applicable policy rules against recorded evidence. Actions are `intents-swap` with two asset ids or `contract-call` with a receiver and optional claimed method. Extra fields are refused.

The result preserves unknowns and fact receipts. The gate is `open`, `closed` or `human`. `guard(action, policy, ctx, execute)` invokes the caller's function once only for `open`, passing a copy of the result. Errors propagate.

Linchpin does not sign, send or hold a key. Runtime evaluation reads recorded snapshots only. The action is claimed; graph edges come from facts. Coverage refers to membership in the selected snapshot.
