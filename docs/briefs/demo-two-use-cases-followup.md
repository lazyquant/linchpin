# Follow-up to the demo polish brief — the tokenomics Graph tab must show a graph

*Claude, 2026-10-06 19:25 CEST. Second Codex pass after `demo-two-use-cases.md`; same rules.*

## Problem seen on 2026-10-06 (port 8876, Neo4j connected)
The tokenomics **Graph** tab opens with "Showing 36 of 368 matching entities and 0 connecting relations": a grid of `Authority` cards with raw addresses, no edges. It reads as an empty database even though the eight query tables below are answered from Neo4j. The Answer tab's "Whole dependency path" picture is what a graph should look like here.

## T5 · Default picture with edges
- On opening the Graph tab, the picture shows a **connected default subgraph**, not the first 36 nodes alphabetically: the value-path nodes (`PathNode`) with their `ROUTES_TO` / flow edges, plus the controllers and governances attached to them (`CAN_CHANGE`, `VOTES_IN`, `CONTROLLED_BY`, `MEMBER_OF` one hop out). Cap at about 60 nodes; draw the edges with their type labels; keep the existing layout code (`graph-layout.ts`) if it fits, otherwise a simple layered layout: path nodes in the middle row, controllers above, holders/parameters below.
- The entity-type filter and the search keep working; when a filter yields nodes with no edges among them, say "N entities, no relations between them in this selection" instead of "0 connecting relations".
- The header line reads: "Showing N entities and M relations of 585 nodes · 573 relationships in the tokenomics graph" (numbers from `/api/graph/summary`, T2; local fallback counts otherwise).
- Node cards show the `label` (e.g. "Marinade DAO council"), with the short address underneath, never the raw id prefix (`controller:realm:…`).

## T6 · Verify
- `LINCHPIN_WEB_PORT=8877 bun run web` (offline): the Graph tab shows a connected picture with edges on first open, for both the local fallback and (Claude verifies) Neo4j.
- `bun test` green by exit code. Do not commit; append to `out/demo-polish-summary.md`.
