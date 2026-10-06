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

Every run writes `out/web/<case>/packet.json`, `graph.json`, `evidence.jsonl` and `memo.md`. Existing CLI output directories are preserved. Downloads use the current completed in-memory result; a failed rebuild leaves the last completed example available.

The case boundary is fixed by the four checked-in specifications. The UI does not accept arbitrary paths, addresses or shell commands. Amounts and totals come from the core packet’s exact raw integer arithmetic. Human approval, safety and historical authorization are not inferred from simulation success.

Development stays on `protocol-pack`; do not merge to `main` before the existing 2026-10-08 freeze ends.
