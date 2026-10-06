# Demo polish brief — two use cases, Neo4j visibly populated, proposal → protocol bridge

*Written by Claude on 2026-10-06 for a Codex implementation run on branch `demo-polish` (worktree `~/linchpin-demo`). Demo Day is 2026-10-07 14:00 CEST. Codex has no network and cannot write `.git`; Claude verifies against Neo4j Aura and commits.*

## Context
- The app is the local research workspace: Bun server `src/web/server.ts`, plain TypeScript frontend `src/web/*.ts` + `src/web/index.html` + `src/web/style.css`, no framework. Governance cases come from `/api/cases` (`marinade`, `mip-14`, `mip-14-opinion`, `bonk-bip76`); the tokenomics view (`#tokenomics`) comes from `/api/tokenomics/marinade/...` (`src/web/tokenomics-routes.ts`, UI in `src/web/tokenomics-ui.ts` / `tokenomics-view.ts`).
- Two Neo4j namespaces live in one database: governance cases as `:Entity` (node `id` = raw Solana address, `cases` array; loader `src/graph/neo4j.ts`, 360 nodes) and tokenomics as `:TG` (prefixed `id`, raw address in the `address` property; loader `src/graph/tokenomics-neo4j.ts`, 585 nodes). 60 `:TG` nodes share an address with an `:Entity` node. Both graph tabs already have a local in-memory fallback when Neo4j is unavailable; keep that.
- Rules: no new network calls beyond the existing RPC and Neo4j paths; no secrets anywhere (hosts only, never URIs with credentials); do not change `src/tokenomics/api.ts` shapes; do not touch `fixtures/` or `packs/`; keep `bun test` green (411 tests; use 120 s timeouts for fixture tests); keep all existing routes working.

## Feedback this answers (mentors, 2026-10-06)
1. The product should present two use cases: **(1) Protocol research** (a token, its flows, the protocol's mechanics) and **(2) Governance review** (proposals, their dependencies, their impact on the protocol).
2. "I don't see any data in the Neo4j database": the graph must be visibly populated inside the app (live counts from the database, both namespaces).
3. The link between a proposal and the protocol's tokenomics must be shown, not implied.

## T1 · Home view with the two use cases
- Route: no hash, `#home`, or a click on the brand link opens a home panel in `<main>` (the case scope/workspace and the tokenomics workspace are hidden while it shows).
- Content: `h1` "Linchpin"; subtitle "The dependency engine for protocol economics"; one sentence: "Reads a protocol's programs, state and transactions from Solana mainnet and keeps what is claimed, what the code allows and what happened side by side."
- Two numbered cards:
  1. **Protocol research** — "A token, its flows and the protocol's mechanics." Buttons: "Marinade tokenomics" (opens the tokenomics view exactly like the sidebar entry) and "Marinade / MNDE · control and supply map, DAO treasury ledger" (opens case `marinade`). Under the buttons, from `/api/tokenomics/marinade` (already cached, ~1 s warm): the short-answer status (e.g. "partly"), "11 sections", and the evidence count.
  2. **Governance review** — "Proposals, their dependencies and their impact on the protocol." Buttons for `mip-14` ("Marinade MIP-14 · burn of 300,000,000 MNDE"), `mip-14-opinion` ("MIP-14 opinion vote · signaling only") and `bonk-bip76` ("BonkDAO BIP-76 · treasury transfer"); use the labels and questions from `/api/cases`.
- Under both cards one line from T2: "Evidence graph · Neo4j Aura · <host> · N nodes · M relationships" or the local fallback wording.
- Sidebar: rename the group "PROTOCOL ECONOMICS" to "1 · PROTOCOL RESEARCH" and move the `marinade` case button into it under "Marinade tokenomics"; rename "RESEARCH CASES" to "2 · GOVERNANCE REVIEW" with `mip-14`, `mip-14-opinion`, `bonk-bip76`. Add a "Home" entry at the top. Selected-state styling unchanged.
- Keep deep links working: `#tokenomics`, `#mip-14`, etc. still open directly. Also make hash changes switch views at runtime (`hashchange`), so a presenter can use the address bar; today only the initial hash is read.

## T2 · Live graph counts
- New route `GET /api/graph/summary` → `{ source: 'neo4j' | 'local', host: string | null, reason: string | null, nodes: number, relationships: number, byNamespace: { governance: number, tokenomics: number }, byLabel: Record<string, number>, retrievedAt: string }`.
  - Neo4j: `MATCH (n) RETURN count(n)`, `MATCH ()-[r]->() RETURN count(r)`, `MATCH (n:Entity) RETURN count(n)`, `MATCH (n:TG) RETURN count(n)`, and `MATCH (n) UNWIND labels(n) AS l WITH l WHERE l <> 'Entity' AND l <> 'TG' RETURN l, count(*)` for `byLabel`. Reuse the existing driver/session helpers and error mapping in `src/web/graph.ts`; 20 s timeout; cache the result for 60 s in memory.
  - Local fallback: count the in-memory governance graph (`GraphRecords`) and the tokenomics graph.
- Show it as the badge text in **both** Graph tabs and on the home panel: `Neo4j Aura · <host> · 945 nodes · 1,0xx relationships · governance cases 360 · tokenomics 585` (numbers live, formatted with thousands separators). Keep the "Load into Neo4j" buttons as they are.

## T3 · Bridge card: proposal → protocol dependencies
- In the governance workspace's Graph tab add a canned query card **"Proposal → protocol dependencies"** for the active case, question: "Which accounts this case touches also carry the protocol's tokenomics, and in what role?"
- Neo4j Cypher (parameter `case`):
  ```cypher
  MATCH (c:Entity) WHERE $case IN c.cases
  MATCH (t:TG {address: c.id})
  OPTIONAL MATCH (t)-[r]-(u:TG)
  WITH c, t, collect(DISTINCT type(r) + ' · ' + coalesce(u.label, u.id))[0..6] AS links
  RETURN c.id AS address, c.type AS caseRole, c.label AS caseLabel, labels(t)[1] AS tokenomicsType, t.label AS tokenomicsLabel, links
  ORDER BY tokenomicsType, caseLabel
  ```
  Local fallback: join the governance graph's node ids for the case with tokenomics nodes whose `props.address` equals that id, and collect their relationships the same way.
- Columns: "Account" (short address), "In this case as" (`caseLabel` with `caseRole`), "In the protocol graph as" (`tokenomicsType` + `tokenomicsLabel`), "Protocol links". One line under the table: "N of this case's accounts appear in the protocol's tokenomics graph."
- Expected rows for `mip-14` (verify in the local fallback): `B56RWQ…` (native treasury PDA, the burn authority ↔ TG HolderGroup "DAO treasury MNDE", PathNode buyback recipient, Authority), `8z6A4q…` (governance ↔ TG Governance where MNDE holders vote), `899YG3…` (realm ↔ TG Controller, the Marinade DAO council), `MNDEFz…` (mint ↔ TG Mint MNDE). If the local join finds no rows for a case, show "No shared accounts" rather than an empty table.
- Mirror in the tokenomics Graph tab: a card **"Governance cases touching this graph"**: for each `:Entity` whose id matches a `:TG` address, list the case ids and the entity label, grouped by case (`MATCH (t:TG) MATCH (c:Entity {id: t.address}) UNWIND c.cases AS caseId RETURN caseId, count(DISTINCT c) AS sharedAccounts, collect(DISTINCT t.label)[0..8] AS examples ORDER BY sharedAccounts DESC`), with a local fallback.

## T4 · Verify and document
- `bun test` green by exit code.
- `LINCHPIN_WEB_PORT=8877 bun run web` (offline, no env file) shows: home with both cards, renamed sidebar groups, "Local graph" badge with counts, the bridge card for `mip-14` with the expected rows from the local fallback, deep links and `hashchange` working.
- Append a section "Two use cases and the graph summary (2026-10-06)" to `docs/local-browser-demo.md` describing the home view, the summary route and the two bridge cards.
- Do not commit. Write a short summary of files changed and how you verified to `out/demo-polish-summary.md`.
