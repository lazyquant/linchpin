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

The right pane provides evidence navigation and focused follow-up actions. It is not a live conversational agent. The memo is deterministic synthesis from existing checks, explicitly marked as draft. There is no LLM, vector index or Neo4j connection in this local slice. Code references identify the local decoder/check modules; they do not assert a comprehensive smart-contract audit.

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

If `LINCHPIN_RPC_URL` is unset, the server uses the public mainnet endpoint from `src/config.ts` (`https://api.mainnet-beta.solana.com`). The timeout and minimum interval settings apply to live requests, including retries. Public endpoints may rate-limit reads. Only the redacted scheme and host are shown in activity, API responses and evidence; endpoint credentials, paths and query strings are not displayed.

- **Marinade / MNDE:** refreshes program controllers, mint and freeze authorities, mint supplies (including council supply), the governance list, and registry treasury balances, including the buyback wallet's MNDE account and treasury mSOL accounts. The hundreds-of-proposals ledger scan and its historical receipts replay committed fixtures through a separate offline RPC. Ledger source records keep their original capture dates.
- **MIP-14 and BonkDAO BIP-76:** reread proposal, governance, realm and transaction accounts, the token balances and mint supplies touched by the packet, historical execution receipts, and conditional-preview simulations. These previews use current state and do not submit transactions or establish historical authorization.
- **MIP-14 opinion:** rereads the signaling proposal, governance, realm and governing mint. There is no executable payload and no simulation to invent.

Each refresh has its own directory, `out/web/<case>/live/<filesystem-safe ISO timestamp>/`, containing `fixtures/`, `packet.json`, `graph.json`, `evidence.jsonl` and `memo.md`. Committed `fixtures/`, pack specifications, and the captured example are untouched by refresh. At most one run per case is active. A refresh has a **120-second wall-clock cap**, including retries. Failure or timeout reports the reason in Activity and leaves the captured example selected; partial evidence may remain in the isolated directory, but it is not published as a completed live result.

After success, the scope line shows the live read time, slot, redacted host and read count. **Captured | Live** switches findings, control map, ledger / timeline, memo, sources and exports together. **Current vs captured** at the top of Live findings shows changed facts with both slots and timestamps; expand the unchanged facts to inspect them. A newer latest slot counts as a change in review cases even when balances are identical. Capture times and slots describe individual reads, not an atomic snapshot of the cluster.

The live memo includes the captured baseline date range and a **What changed since capture** section. Live downloads come from that refresh's directory and have `-live` before the extension (for example, `linchpin-mip-14-memo-live.md`). The server retains the latest successful live result per case during its process lifetime; restarting opens the captured examples again. **Run research** remains an offline replay.

For API clients, `POST /api/cases/:id/refresh` returns a run to poll at `/api/runs/:runId`. `GET /api/cases/:id` selects captured evidence; add `?source=live` for the latest completed refresh. The same parameter selects `/sources` and `/export/*`; live requests return 404 with an explanation until a refresh succeeds. Every case view includes `freshness` with read counts, capture range, slot range, redacted host and the relative live directory. Live views also include `stateDiff`, exact raw values and `changedCount`.
