# Solana app

One offline screen for what Linchpin has recorded about Solana protocols: who controls each account, what it rests on, where value is routed, what is unknown and what changed between two captures; and the positions of one address with the chain behind each. It computes nothing about a protocol. It reads the committed captures through the repository's builders and draws them with the UI kit.

```sh
bun run src/apps/solana/main.ts serve [--port <n>] [--live]
bun run src/apps/solana/main.ts build [--out <dir>]
```

`serve` binds `127.0.0.1` only (default port 4406) and prints `solana-app http://127.0.0.1:<port>/#token=<64 hex>`. `build` writes one self-contained `index.html` (default `dist/solana-app`) that opens from disk. Both take about a minute to start, because the Marinade sections replay several thousand recorded reads. A wrong argument, `--host`, or a port outside 1 to 65535 prints one line and exits 2. `--live` needs `LINCHPIN_RPC_URL` and adds a live read of an address. Captures, positions replay and prepared answers use no network; a typed Ask question can call the configured model.

## Rules it keeps

- Every evidence value is drawn by the UI kit inside a surface that `validateSurface` accepted, with a resolver over the receipts the app loaded. App views use catalog `linchpin.evidence.v2`; mounted answers use `linchpin.evidence.v1`. A refused surface shows "view refused:" with its codes and nothing of itself.
- The shell (top bar, tabs, controls, drawer frame, status line) holds the app's own words and no evidence value.
- A read of positions leaves the server through `POST /api/positions` only, to a request with the launch token in `x-app-token` and this server's own `Origin`. The static build holds the two replayed reads of an account its holder named as public.
- A constructed read, capture or change carries CONSTRUCTED wherever it is drawn. A reader position states no basis; its join to a recorded subject is a scope statement that cites `src/solana/positions/registry.ts`. The replayed bodies hold a slot and no retrieval time, so no age is computed.
- Layers of the explorer (Control, Structure, Pricing, Code) are this app's grouping of relations, and the legend says so. A kind is shown only as the capture records it.
- Both served launchers mount `createAnswersHandler` through the shared `startAppServer` path. Ask selects one of the backend's protocols (Marinade tokenomics or the Sentora PYUSD kVault) and lists prepared answers labelled as fixed scripts. These are the answers backend's scope, not every protocol or capture in the app. Every prepared surface and typed answer passes the app's validator with its own receipt resolver. Position ids, quantities and addresses from this process's position reads are refused with 422 before reaching the handler. Cross-origin requests are refused, asks are capped at 4096 bytes, and a concurrent ask receives 409.
- With no `ANTHROPIC_API_KEY`, a typed question shows "No model is configured on this machine"; prepared answers still work offline. `LINCHPIN_AGENT_LOG` optionally names a trace file outside the repository; by default no trace is written, and a path inside the repository refuses startup. The static build keeps "Ask is not in this build" because it has no server. Preflight is a reserved place with four lanes, each "not built".
- Typed Ask controls wait for the protocol list and for any current ask. If loading prepared answers fails, the refusal stays visible; leave and re-enter Ask to retry.
- The app loads the full public Marinade pack receipt set, including records used by answer templates beyond the fixed app views. Typed answers and their receipt drawers use the same app resolver; historical state absent from a pack record remains unknown.

## Files

| File | Holds |
|---|---|
| `main.ts` | The command |
| `load.ts`, `providers.ts`, `rows.ts`, `layers.ts` | The data: captures to kit results, copied, with their receipts |
| `positions.ts`, `join.ts` | The replayed reads, the sheet of a position, and the join as scope |
| `model.ts` | The data block's types |
| `surfaces.ts`, `compose.ts` | Data to surfaces; validate, then interpret |
| `route.ts`, `state.ts`, `chrome.ts`, `app.ts`, `client.ts` | The page: fragment, state, shell trees, drawing, entry |
| `page.ts`, `server.ts`, `guard.ts` | The document, the loopback server, what may not reach the answers route |
| `strings.ts`, `app.css` | The app's words and the shell's styles |

## Limits

Marinade has no coverage rows ("coverage not recorded") and is the only protocol with a value path; its rows carry evidence ids and no fact ids. Exit limits exist for the Sentora PYUSD vault only. A group of the explorer that would bring a drawing over sixty accounts stays folded. The document is about five megabytes, most of it the evidence ids of the Marinade path.
