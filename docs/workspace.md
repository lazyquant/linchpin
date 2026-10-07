# Research workspace

The research workspace is Linchpin's local web application. It serves both use cases, protocol research and governance review, from the same evidence graph. The server binds only to loopback. No hosting account or API key is needed to work with recorded evidence.

```sh
bun install
bun run web
```

Open http://127.0.0.1:8875. `LINCHPIN_WEB_PORT=8876 bun run web` selects another port; stop with Ctrl-C. On first start the server builds the governance cases and the tokenomics research bundle from the recorded fixtures (the tokenomics bundle takes up to about 30 seconds, then loads from a content-addressed cache in about one second). Missing fixtures fail startup with an error instead of falling back to live reads. All scripts, styles and graph rendering are bundled locally; the app loads no CDN. Source links open external pages only when clicked.

## Home

The root URL, `#home`, the **Home** sidebar entry and the brand link open the home view. It presents the two use cases with their entry points, the current tokenomics answer with its section and evidence counts, and the evidence-graph badge with live node and relationship counts. The sidebar uses the same grouping:

- **1 · Protocol research:** Marinade tokenomics (`#tokenomics`) and the Marinade / MNDE control, supply and treasury case (`#marinade`).
- **2 · Governance review:** MIP-14's 300,000,000 MNDE burn (`#mip-14`), its signaling opinion vote (`#mip-14-opinion`) and BonkDAO BIP-76 (`#bonk-bip76`).

Hashes open views directly, and changing the hash in the address bar switches views without reloading.

## Protocol research: tokenomics view

`#tokenomics` answers one question with evidence: *is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?*

| Tab | What it shows |
| --- | --- |
| Answer & path | The short answer and its status, the statements behind it, the unknowns, and the value path with four filters (treasury → MNDE, fees into treasury, who controls the route, whole dependency path) |
| Control | Controllers, roles and the governances behind every parameter, authority and upgrade |
| Parameters | Fee and limit parameters decoded from program state |
| Programs | The protocol's programs, their published interfaces and upgrade authorities |
| Participation | Voting bodies, locked MNDE and participation estimates |
| Holders & float | Top holders, custody exclusions and float |
| Flows | Declared routes and observed flows: treasury, buybacks, distributors and claims |
| Claims vs chain | Each documented claim next to what the captured chain evidence establishes |
| Graph | The tokenomics graph: a connected default picture, canned queries with their Cypher, and the governance cases that touch it |

Every value shows its basis (declared, decoded, observed, derived, claimed, reported or inferred), its slot and capture time, and opens its evidence records in the inspector. The **Questions** panel retrieves cited records and graph results from the research bundle; it is deterministic retrieval, not a language model. **Download research JSON** exports the whole bundle; **Print report** produces a printable version.

## Governance review: cases

Each case opens with its research question and five tabs:

| Tab | What it shows |
| --- | --- |
| Findings | Numbered findings, each with its basis and supporting records: treasury movement, supply change, claim coverage, control change, account creation, unsupported instructions, execution conditions, vote outcome, observed execution, conditional previews |
| Control map | The control path from the touched account to the realm (token account → native treasury → governance → realm); click an account or a relation to inspect its evidence |
| Timeline / ledger | The governance execution boundary, reconciled treasury movements, unsupported instructions and source records |
| Memo | A cited research memo, marked as a draft for human review; export Markdown or print to PDF |
| Graph | Cross-case queries, the evidence-graph counts, and **Proposal → protocol dependencies**: the accounts this case touches that also carry roles in the protocol's tokenomics graph |

**Run research** rebuilds the case from recorded evidence. Activity events report the completed stages, fixture reads and live reads. Replaying recorded evidence does not refresh the chain snapshot.

The right pane provides evidence navigation and focused follow-up questions; it is not a conversational agent. Code references identify the decoder and check modules; they do not assert a smart-contract audit. The case boundary is fixed by the checked-in specifications in `cases/`; the UI accepts no arbitrary paths, addresses or shell commands. Amounts and totals come from exact raw-integer arithmetic. Approval, safety and historical authorization are never inferred from a successful simulation.

Every run writes `out/web/<case>/packet.json`, `graph.json`, `evidence.jsonl` and `memo.md`.

## Guided walkthroughs

`#walkthrough-bonk` and `#walkthrough-mnde` open a full-screen guided view of the two flagship cases; the **Guided walkthrough ↗** button opens it from any page. Each case has four scenes:

- **BonkDAO BIP-76:** the proposal (declared action → authority → executed effect), how it passed (approval against the recorded maximum vote weight and the threshold, hold-up and execution timing), what executed (each transaction and its receipt), and the cited memo.
- **Marinade and MNDE:** the value path (code routes, account operations and claimed links drawn differently), who controls it (who sets the fee route, where MNDE holders vote), what was observed (buyback receipts split into same-transaction purchases and credits without payment, distributor claims), and the cited memo.

Every fact opens its supporting records. The **Ask the evidence** rail answers suggested and typed questions from cited records only; it uses no language model and says when a question is not established by the captured case. Arrow keys move between scenes. **Download cited memo ↓** exports the case memo from `GET /api/walkthrough/bonk/memo.md` or `GET /api/walkthrough/mnde/memo.md`, marked as a draft for human review. **Open full workspace ↗** returns to the matching case.

## Refresh from chain

**Refresh from chain ↗** reads current state through the RPC endpoint configured in the server's environment. Configure it outside the repository, for example in `~/.config/linchpin.env` (mode 600):

```sh
LINCHPIN_RPC_URL=https://your-solana-rpc-endpoint
LINCHPIN_RPC_TIMEOUT_MS=30000
LINCHPIN_RPC_MIN_INTERVAL_MS=250
```

Start the server with that file:

```sh
bun --env-file="$HOME/.config/linchpin.env" run web
```

`bun run web:live` does the same with a 50 ms read pace that suits a paid endpoint; keep the 250 ms default for a public one. Without `LINCHPIN_RPC_URL` the server uses the public mainnet endpoint from `src/config.ts`. Timeout and pacing apply to live requests, including retries. Only the redacted scheme and host appear in activity, API responses and evidence; credentials, paths and query strings are never shown.

- **Marinade / MNDE:** program controllers, mint and freeze authorities, supplies (including council supply), the governance list, and registry treasury balances, including the buyback wallet's MNDE account and the treasury mSOL accounts. The historical proposal ledger and its receipts replay from recorded evidence.
- **MIP-14 and BonkDAO BIP-76:** proposal, governance, realm and transaction accounts, the touched token balances and supplies, historical execution receipts, and conditional previews against current state. Previews never submit transactions.
- **MIP-14 opinion vote:** the signaling proposal, governance, realm and governing mint. There is no executable payload and no simulation.

Each refresh writes its own directory, `out/web/<case>/live/<timestamp>/`, with `fixtures/`, `packet.json`, `graph.json`, `evidence.jsonl` and `memo.md`; committed fixtures are never modified. One run per case is active at a time, with a 120-second cap including retries. A failure leaves the captured result selected and reports the reason in Activity.

After a successful refresh the scope line shows the live read time, slot, redacted host and read count. **Captured | Live** switches findings, control map, ledger, memo, sources and exports together. **Current vs captured** lists changed facts with both slots and timestamps. The live memo adds a **What changed since capture** section; live downloads carry `-live` in their names.

## Graph

Both workspaces read one evidence graph. The badge names the source and shows live counts, for example **Neo4j Aura · <host> · 945 nodes · 988 relationships · governance cases 360 · tokenomics 585**, or **Local graph · …** with the same counts from the in-memory records. Counts describe the graph index, not a new chain capture.

- The governance Graph tab answers four cross-case questions (shared controllers, control paths to the Marinade realm, reconciled external MNDE destinations, case inventory) and **Proposal → protocol dependencies** for the open case.
- The tokenomics Graph tab opens on a connected picture: the value path with its controllers, governances, members and authorities, typed edges and labelled cards. Filters by entity type and a search narrow it. Eight canned queries follow, and **Governance cases touching this graph** groups the shared accounts by case.

Each query card shows its question, columns, row count, and the Cypher with its parameters. Missing configuration, a connection failure or a query timeout returns the same answers from the local graph, labelled as such.

Configure Neo4j only in the server environment:

```sh
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j
```

`NEO4J_URI` and `NEO4J_PASSWORD` enable the connection; username and database default to `neo4j`. Credentials and the full URI never reach the browser. Queries use read routing and bounded deadlines; results are cached briefly. **Load into Neo4j** (governance cases) and **Load latest graph into Neo4j** (tokenomics) appear only when the server is configured; loads run one at a time with a 120-second cap, report their counts in Activity, and invalidate the caches. The tokenomics loader replaces only its own namespace and checks that the governance-case queries return the same rows before and after the write. See [Neo4j: governance cases](neo4j.md) and [Neo4j: tokenomics graph](neo4j-tokenomics.md).

## API

| Route | Purpose |
| --- | --- |
| `GET /api/cases` | The governance and protocol cases with their questions |
| `GET /api/cases/:id` | A case view; `?source=live` selects the latest successful refresh |
| `POST /api/cases/:id/run`, `POST /api/cases/:id/refresh` | Start a replay or a live refresh; poll `GET /api/runs/:runId` |
| `GET /api/cases/:id/sources`, `GET /api/cases/:id/export/:file` | Sources and exports (`packet.json`, `graph.json`, `evidence.jsonl`, `memo.md`) |
| `GET /api/tokenomics/marinade[/:section]` | The tokenomics research bundle or one section; see [the tokenomics API](tokenomics-api.md) |
| `GET /api/tokenomics/marinade/evidence?id=…` | Evidence records by SHA-256 id (up to 200 per request) |
| `GET /api/graph`, `GET /api/graph/:id` | Cross-case graph queries |
| `GET /api/graph/summary` | Live node and relationship counts for both graph namespaces |
| `GET /api/graph/proposal-dependencies?case=…` | Accounts a case touches that carry tokenomics roles |
| `GET /api/graph/governance-cases` | Governance cases that share accounts with the tokenomics graph |
| `GET /api/walkthrough/:case/memo.md` | The cited memo of a guided walkthrough (`bonk` or `mnde`) |
| `POST /api/graph/load`, `POST /api/tokenomics/marinade/graph/load` | Load the graph into Neo4j (same-origin only) |

Responses carry `source`, the redacted `host`, a scrubbed `reason` on fallback, and `retrievedAt`. Unknown cases and sections return 404; loading without configuration returns 409.
