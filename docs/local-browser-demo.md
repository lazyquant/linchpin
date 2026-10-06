# Local browser demo

Run from the `protocol-pack` worktree. No hosting account or API key is required.

```sh
cd /Users/siki/linchpin-pack
bun run web
```

Open http://127.0.0.1:8875 in the laptop browser. The server binds only to loopback. It prepares four completed examples by running the existing pipeline against recorded fixtures. All scripts, styles and graph rendering are bundled locally; the app does not load a CDN or require internet. Original source links open external pages only when clicked.

`LINCHPIN_WEB_PORT=8876 bun run web` selects a different local port. Stop with Ctrl-C. First startup rebuilds the examples; wait for the printed workspace URL. Missing fixtures fail startup with an error rather than falling back to a live RPC.

## Workflow

1. Choose Marinade / MNDE. Show the documented claim, authority path and captured chain evidence in **Findings** and **Control map**.
2. Press **Run research**. Activity events report actual completed stages, fixture reads and zero live reads. Replaying is not a refresh of the blockchain snapshot.
3. Show the **Timeline / ledger**: the governance execution boundary, reconciled treasury flows, unsupported instructions and source records.
4. Open **Memo**. Inspect a citation, export Markdown or use the browser’s print dialog to save PDF.
5. Switch to BonkDAO BIP-76. Show the treasury movement, control path and receipt timeline as a retrospective reconstruction. Reported voter counts and concentration remain unverified.
6. Optionally show MIP-14’s burn versus its separate opinion vote. A successful opinion vote has no executable burn payload.

The right pane provides evidence navigation and focused follow-up actions. It is not a live conversational agent. The memo is deterministic synthesis from existing checks, explicitly marked as draft. There is no LLM or vector index in this local slice. The Graph tab optionally queries Neo4j Aura, with an automatic local fallback. Code references identify the local decoder/check modules; they do not assert a comprehensive smart-contract audit.

Every run writes `out/web/<case>/packet.json`, `graph.json`, `evidence.jsonl` and `memo.md`. Existing CLI output directories are preserved. Captured downloads use the completed in-memory example. Live downloads use the latest successful refresh directory; a failed refresh keeps the captured example selected.

The case boundary is fixed by the four checked-in specifications. The UI does not accept arbitrary paths, addresses or shell commands. Amounts and totals come from the core packet’s exact raw integer arithmetic. Human approval, safety and historical authorization are not inferred from simulation success.

Development stays on `protocol-pack`; do not merge to `main` before the existing 2026-10-08 freeze ends.

## Refresh from chain

The completed examples always start from committed fixtures. **Refresh from chain ↗** makes real RPC reads using the endpoint in the server's environment. Configure it outside the repository, for example in `~/.config/linchpin.env`:

```sh
LINCHPIN_RPC_URL=https://your-solana-rpc-endpoint
LINCHPIN_RPC_TIMEOUT_MS=30000
LINCHPIN_RPC_MIN_INTERVAL_MS=250
```

Start the server with that file:

```sh
bun --env-file="$HOME/.config/linchpin.env" run web
```

Shortcut for the demo laptop (same thing, plus a 50 ms read pace that suits a paid endpoint such as Alchemy; the public endpoint should keep the 250 ms default):

```sh
cd ~/linchpin-pack
bun run web:live
```

If `LINCHPIN_RPC_URL` is unset, the server uses the public mainnet endpoint from `src/config.ts` (`https://api.mainnet-beta.solana.com`). The timeout and minimum interval settings apply to live requests, including retries. Public endpoints may rate-limit reads. Only the redacted scheme and host are shown in activity, API responses and evidence; endpoint credentials, paths and query strings are not displayed.

- **Marinade / MNDE:** refreshes program controllers, mint and freeze authorities, mint supplies (including council supply), the governance list, and registry treasury balances, including the buyback wallet's MNDE account and treasury mSOL accounts. The hundreds-of-proposals ledger scan and its historical receipts replay committed fixtures through a separate offline RPC. Ledger source records keep their original capture dates.
- **MIP-14 and BonkDAO BIP-76:** reread proposal, governance, realm and transaction accounts, the token balances and mint supplies touched by the packet, historical execution receipts, and conditional-preview simulations. These previews use current state and do not submit transactions or establish historical authorization.
- **MIP-14 opinion:** rereads the signaling proposal, governance, realm and governing mint. There is no executable payload and no simulation to invent.

Each refresh has its own directory, `out/web/<case>/live/<filesystem-safe ISO timestamp>/`, containing `fixtures/`, `packet.json`, `graph.json`, `evidence.jsonl` and `memo.md`. Committed `fixtures/`, pack specifications, and the captured example are untouched by refresh. At most one run per case is active. A refresh has a **120-second wall-clock cap**, including retries. Failure or timeout reports the reason in Activity and leaves the captured example selected; partial evidence may remain in the isolated directory, but it is not published as a completed live result.

After success, the scope line shows the live read time, slot, redacted host and read count. **Captured | Live** switches findings, control map, ledger / timeline, memo, sources and exports together. **Current vs captured** at the top of Live findings shows changed facts with both slots and timestamps; expand the unchanged facts to inspect them. A newer latest slot counts as a change in review cases even when balances are identical. Capture times and slots describe individual reads, not an atomic snapshot of the cluster.

The live memo includes the captured baseline date range and a **What changed since capture** section. Live downloads come from that refresh's directory and have `-live` before the extension (for example, `linchpin-mip-14-memo-live.md`). The server retains the latest successful live result per case during its process lifetime; restarting opens the captured examples again. **Run research** remains an offline replay.

For API clients, `POST /api/cases/:id/refresh` returns a run to poll at `/api/runs/:runId`. `GET /api/cases/:id` selects captured evidence; add `?source=live` for the latest completed refresh. The same parameter selects `/sources` and `/export/*`; live requests return 404 with an explanation until a refresh succeeds. Every case view includes `freshness` with read counts, capture range, slot range, redacted host and the relative live directory. Live views also include `stateDiff`, exact raw values and `changedCount`.

## Graph

The fifth tab, **Graph**, answers four questions across all four captured cases: shared controllers, control paths to the Marinade realm, reconciled external MNDE destinations, and case inventory. The inventory strip shows entity, relationship and evidence counts with slot ranges. Each query card includes the question, result columns, row count, and expandable **Cypher** with its parameters. Long IDs are shortened with the complete value available on hover. Select an entity row to open the current case’s evidence inspector; if it is outside that case’s displayed graph, a notice names its recorded cases.

The badge always identifies the query source: **Neo4j Aura · <host>** or **Local graph · Neo4j unavailable: <reason>**. Missing configuration, a connection failure, or a query timeout returns all four local answers from the in-memory records. The server builds these records once at startup and labels them **captured graph**. Live case refreshes do not change the index; selecting an entity in a live case opens that case’s live evidence, with the captured-query boundary stated in the inspector.

Configure Aura only in the server environment (for example, the same external `~/.config/linchpin.env` used above):

```sh
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j
```

`NEO4J_URI` and `NEO4J_PASSWORD` enable the connection; username and database default to `neo4j`. Credentials and the full URI never reach the browser. The server lazily creates one driver on the first graph request and closes it on Ctrl-C. Each query uses read routing, the configured database and a five-second deadline. Successful Aura responses are cached for 30 seconds; **Refresh queries** uses that cache while it is fresh.

**Load into Neo4j** appears only when the server is configured. It writes the captured graph to the configured database, reports progress and the returned node, relationship and batch counts in Activity, then refreshes the cards. A successful load invalidates the query cache. Loads have a 120-second cap and run one at a time. A timed-out write may still be settling; the server retains its lock until that call finishes and will not start further batches. Batches commit independently, so retry a failed load before relying on a partial index. Use a dedicated database; the loader merges records and does not delete old data. See [Neo4j schema and loading details](neo4j.md).

The memo and Markdown export include **Cross-case graph**, with up to five shared-controller rows, the graph source and retrieval time. Startup memos use the local captured graph; opening Graph or Memo updates this section from the latest graph response. Retrieval time is the query time, not a new chain capture.

API routes are `GET /api/graph`, `GET /api/graph/:id` (one of the four canned query IDs), and same-origin `POST /api/graph/load`. Query responses include `source`, `configured`, redacted `host`, scrubbed `reason`, captured `stats`, query metadata/parameters/rows, `retrievedAt`, and entity case memberships. The single-query route uses the same envelope with one item in `queries`. Loading without configuration returns 409; a concurrent load returns 409, a failed load 502, and a timed-out load 504.

## Two use cases and the graph summary (2026-10-06)

The root URL, `#home`, the **Home** sidebar entry and the brand link open a home panel headed **Linchpin — The dependency engine for protocol economics**. It presents **1 · Protocol research** (Marinade tokenomics and the Marinade / MNDE control, supply and treasury case) and **2 · Governance review** (MIP-14's burn, its signaling opinion vote and BonkDAO BIP-76). The sidebar uses the same grouping. Home shows the tokenomics short-answer status, eleven sections and the number of distinct cited evidence IDs in the bundle returned by `/api/tokenomics/marinade`.

Existing case hashes and `#tokenomics` still open directly. Changing the hash in the address bar also switches workspaces without reloading. Home hides the case workspace, tokenomics workspace and inspectors.

`GET /api/graph/summary` returns `source`, host-only `host`, scrubbed `reason`, `nodes`, `relationships`, `byNamespace: { governance, tokenomics }`, `byLabel`, and `retrievedAt`. Its Neo4j queries count the whole database and each namespace separately, excluding only the namespace labels `Entity` and `TG` from the label breakdown. Reads reuse the governance driver, use read routing and a 20-second deadline, and cache the complete result for 60 seconds, including fallback results. Concurrent summary requests share a read. Graph loads invalidate the summary cache. No configuration or a read failure gives exact counts from both local graphs. Addresses shared between namespaces remain separate nodes.

Home and both Graph tabs display the same count badge, for example **Local graph · 945 nodes · 968 relationships · governance cases 360 · tokenomics 585** for the current fixtures, or **Neo4j Aura · <host> · …** with live database counts. Counts use thousands separators. The existing load buttons retain their behavior. Counts describe the graph index; they do not imply a new Solana capture. Each bridge card separately reports its query source and retrieval time.

The governance Graph tab adds **Proposal → protocol dependencies**, served by `GET /api/graph/proposal-dependencies?case=mip-14` (substitute any known case ID). It joins case `Entity.id` to tokenomics `TG.address`, preserves every matching protocol role, and lists up to six distinct incident protocol links per role. The account total below the table counts distinct addresses, not rows. Cases without matches show **No shared accounts**. Unknown case IDs return 404.

The tokenomics Graph tab adds **Governance cases touching this graph**, served by `GET /api/graph/governance-cases`. It groups shared accounts by case, counts distinct governance entities, exposes the entity labels in expandable lists, and shows up to eight protocol examples. Select a case ID to open that case. Both bridge cards include their Cypher; their local fallbacks use the same address join, distinctness rules and limits.

Single-owner MNDE HolderGroups now retain their owner address, and the named MNDE/mSOL Mint nodes retain their registry address. Aggregate float groups remain without an account address. The treasury HolderGroup uses the path's **DAO treasury MNDE** label. These properties are required for the documented cross-namespace join: reload the tokenomics graph into Aura before verifying the bridge against an existing database. No tokenomics API type shapes, fixtures or pack files change.

For MIP-14, verify the treasury `B56RWQ…` as HolderGroup, buyback-recipient PathNode, treasury PathNode and Authority; governance `8z6A4q…`; council Controller `899YG3…`; and MNDE Mint `MNDEFz…`. The join can return additional genuine shared accounts. Run the offline server with `LINCHPIN_WEB_PORT=8877 bun run web` and the tests from the worktree root with `bun test --timeout 120000`.
