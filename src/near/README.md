# NEAR

Linchpin's NEAR face: one reader of NEAR's DeFi control surface into receipted facts and snapshots, and three reviews on top of it: intent review, governance review and a private risk manager with an MCP server for IronClaw. All reads are mainnet view calls; nothing here signs or sends a transaction.

## Recorded reader

The registry in `subjects/registry.ts` names each covered account, its view recipes,
and the relations those recipes produce. The reader keeps current observations,
historical read failures, and constructed examples distinct.

```sh
bun run linchpin near subjects
bun run linchpin near facts intents.near --offline
bun run linchpin near snapshot near-2026-11-09 --offline
bun run linchpin near diff 'intents.near#role:UnrestrictedAccountLocker' near-2026-11-09 near-constructed-intents-locker-added --offline
```

Capture a new dated snapshot with `bun run src/near/reader/snapshot.ts <id>`.
Use `--dry-run` to validate recipes without writing files. The command refuses to
overwrite an existing snapshot. `LINCHPIN_NEAR_RPC_URL` selects a credential-free
HTTPS origin; `LINCHPIN_NEAR_ARCHIVAL_RPC_URL` optionally enables pinned reads.
Neither full endpoint URLs nor headers are saved in receipt metadata.

Import the public helpers from `reader/index.ts`. `loadNearSnapshot(id)` opens an
engine evidence store; `buildNearSnapshot(id)` returns its validated snapshot.
`nearReads(id)` exposes the underlying recorded responses for application parsers.
`loadNearSnapshots(ids)` supports comparisons. `controlSurface` queries the root
and its role nodes; `historyFacts` reports dated deployment and submitted proposal
events with their source facts. Proposal submission time is not approval time.

Live data lives in `fixtures/near/<id>/`, constructed data in
`fixtures/near/constructed/<name>/`, and the historical error probe in
`fixtures/near/probes/unknown-block/`. Manifests bind the file hashes and canonical
fact/receipt hash. Dates and block ranges come from observations; the snapshot id
is only a label. Loading and offline commands never fetch. Unknown or uncovered
controllers remain explicit query reasons.

History event facts preserve the source fact's receipts and are returned as a
feed; adding them to an evidence snapshot still requires the engine's two-input
receipt rule for derived facts. Add application commands by exporting
`run(args: string[]): Promise<number>` from a new file in `cli/`.
