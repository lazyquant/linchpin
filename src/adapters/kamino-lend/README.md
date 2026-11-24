# Kamino Lend recorded evidence

`buildKaminoLendSnapshots(root = "fixtures/kamino-lend")` replays recorded Main Market captures offline. `buildKaminoLendResults(root)` also returns `gaps`, `coverage` and `mechanics`; `normalizeKaminoLendCapture(capture)` handles one capture. Coverage notes are beside the snapshot and do not make a reader partial.

The manifest lists five records: the API reserve list, full market/reserve state, sliced mint/oracle accounts, full control accounts and sliced programs/program data. Capture validation checks hashes, slots, duplicate accounts and bounded file names. Receipts identify each recorded account and HTTP body. Recorded facts have no historical validity start; constructed captures use their observation start.

The layout module reuses the existing Kamino decoders and adds lending authorities, global configuration and mint headers. Reserve balances are raw token base units; borrowed fixed-point amounts are shifted by 60 bits. API tickers supply display names only. Multisig control requires a decoded Squads v4 account and matching vault PDA, with both source receipts. Squads v3 control remains unknown.

The mechanics kinds model is decoded only from facts held by the snapshot: Market, Reserve, Mint, Scope OracleSource, Program, ProgramData and Squads v4 multisig Authority.

Each reserve's stored status is emitted as `KLEND_RESERVE_STATUS`, with object `amount:0`, `amount:1` or `amount:2` (Active, Obsolete or Hidden). This is the code only, not a statement about what the reserve permits. A code above 2 produces a `malformed-record` gap and omits only the status fact; other decoded reserve facts remain.

Coverage notes identify reserve-list completeness, what a reserve status permits, Scope indices, time locks, pending authorities, Squads v3, fee collector, Switchboard upgrade control and proposer initialisation scope. Null accounts and records that cannot be decoded produce gaps without facts for the affected subject.

The private capture CLI supports `--check [root]` for offline replay and `--record` for explicitly authorised collection. The index does not export the network recorder. No registration in the shared evidence graph or tokenomics view is performed by this module.
