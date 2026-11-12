# NEAR governance review

Deterministic Sputnik proposal review over the recorded NEAR snapshots. The module decodes proposals, classifies each action, computes execution thresholds from the policy read, and intersects derived reach with a subject's dependency chain. It performs no network requests.

```sh
bun run linchpin near governance burrow.sputnik-dao.near 1746 --for contract.main.burrow.near --offline
bun run linchpin near governance rainbowbridge.sputnik-dao.near --open --offline
bun run linchpin near governance burrow.sputnik-dao.near --open --snapshot near-constructed-governance-expired --offline
bun run linchpin near governance burrow.sputnik-dao.near 1746 --compare near-constructed-governance-policy-changed --offline
```

Each command writes `governance-review.md` and `governance-review.json` beneath `out/near-governance/<dao>-<id-or-open>`. `--out` changes that directory. `--snapshot` selects recorded evidence; the default is `near-2026-11-09`. `--compare` selects a second snapshot. Without it, comparison uses the latest two live captures when available, or returns explicit missing coverage.

Import `reviewProposal`, `sweepOpen`, `openProposals`, or `proposalsTouching` from `index.ts`. Each takes a context `{ snapshotId, root?, registry? }`; `root` defaults to `fixtures/near`. Decoding, classification, threshold math, reach and rendering functions are exported separately. `supportingFacts` in the report preserves the source edges and policy facts used by intersections, summaries and reason references.

`executesOn` describes the recorded vote counts under the policy read. It does not establish an execution receipt. Approved proposals retain their recorded status and are excluded from open sweeps. Open sweeps retain expired, unexecuted proposals with that explicit state. Policy diffs compare against the policy read; missing historical policy remains unknown. Accounts named inside arguments are shown separately from reach.

Threshold math follows `WeightOrRatio::to_weight` and `Policy::proposal_status` in `sputnikdao2/src/policy.rs` of `near-daos/sputnik-dao-contract`, commit `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`. Each outcome count is compared with the maximum of quorum and the capped threshold. Token weight is reported without computing member stakes.

The three constructed fixtures retain provenance labels and response hashes. Reproduction commands below refuse to overwrite an existing destination; use a separate fixture root with the live source copied into it when reproducing them programmatically.

```sh
bun run src/near/governance/construct.ts governance-expired --from near-2026-11-09
bun run src/near/governance/construct.ts governance-policy-changed --from near-2026-11-09
bun run src/near/governance/construct.ts governance-kinds --from near-2026-11-09
```
