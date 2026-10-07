# Tokenomics in Neo4j

The tokenomics graph projects the captured API bundle. It performs no Solana reads beyond offline fixture replay, and introduces no independent fact calculations. The graph and API therefore use the same amounts, controllers, windows, claim checks and qualifications.

## Namespace and loading

Every node has `:TG` and exactly one type label:

`Governance`, `PathNode`, `Program`, `Parameter`, `Role`, `Authority`, `Controller`, `Member`, `Mint`, `TokenAccount`, `Claim`, `HolderGroup`, `Metric`.

Relationships are `ROUTES_TO`, `SET_BY`, `HELD_BY`, `CONTROLLED_BY`, `MEMBER_OF`, `UPGRADE_AUTHORITY`, `MINT_AUTHORITY`, `FREEZE_AUTHORITY`, `CAN_CHANGE`, `CHECKS`, `HOLDS`, `LOCKS`, `VOTES_IN`, and `VETOES`.

Every relationship carries `basis` (an array), `evidenceIds`, `slot`, and `key`. Keys are SHA-256 of the type, endpoints and distinguishing fields such as the source link ID or setter instruction. Evidence IDs resolve through the tokenomics evidence endpoint. Raw token amounts remain strings; no floating-point sum is used. `MEMBER_OF` represents recorded multisig owners and current council owners. Unresolved groups retain address details in `detailAddresses`. `Governance` nodes preserve individual configurations; controllers reach them through `VOTES_IN` or veto-only `VETOES`, carrying per-side permissions and threshold text. Governance `CAN_CHANGE` edges identify the controlled targets.

Static validation rejects any other label or relationship, notably the governance-case namespace's `:Entity`, `TRANSFER`, and `BURN`. The loader creates:

```cypher
CREATE CONSTRAINT tg_id IF NOT EXISTS FOR (n:TG) REQUIRE n.id IS UNIQUE
```

It replaces the TG namespace so removed facts cannot survive a new snapshot. The governance-case namespace is retained. Values enter Cypher exclusively through parameters, and validated type groups use `UNWIND` batches of at most 500 records. Nodes load before relationships. Replacement is sequential, not one atomic transaction; a failed load may leave an incomplete TG snapshot. The API's query parity check then falls back to its complete local graph until a successful reload.

Before the first write and after the last write, all four `CANNED_QUERIES` execute via `runCannedNeo4j`. Sorted normalized rows must remain equal, including duplicates. Load results report `regression: 'unchanged' | 'changed'` and `changedQueries`. A change fails the API graph envelope and the CLI exits nonzero. The demo queries are read-only throughout this check.

## Commands

Inspect the offline graph without creating a driver or accessing a network:

```sh
bun run scripts/load-tokenomics-neo4j.ts --dry-run
```

With `NEO4J_URI`, `NEO4J_PASSWORD` and optionally `NEO4J_USERNAME` / `NEO4J_DATABASE` already configured securely:

```sh
bun run scripts/load-tokenomics-neo4j.ts
```

The loader prints counts by type, redacted host, batch totals, regression result and the eight query row counts. It exits nonzero for a changed governance-case query, a failed load, or an Aura result that differs from the captured bundle. Credentials are never printed.

The server endpoint is `POST /api/tokenomics/marinade/graph/load`. It accepts same-origin requests, serializes loads, and caps a load at 120 seconds. GET requests never load the database. READ queries have a five-second deadline and a 30-second cache. The driver is created only when needed. Unavailable or stale Aura results use local rows and a scrubbed explanation.

## Queries

`TOKENOMICS_QUERIES` in `src/graph/tokenomics-neo4j.ts` is the authoritative catalog. Each entry includes ID, title, question, Cypher, parameters and ordered columns. `runTokenomicsLocal(graph, id)` performs the corresponding joins in memory.

| ID | Traversal and interpretation |
|---|---|
| `path-to-holders` | Each path link, including its mechanism, status, observed amount and window; the separate governance loop and actual recipient branches remain visible. |
| `who-can-change` | Controller → target, with what, role, instruction and authority. |
| `parameter-control` | Parameter → setter instruction → role → authority → controller. Setter matches remain inferred. |
| `supply-control` | MNDE/mSOL → mint or freeze authority → controller. Absent authority is represented by the explicit No authority controller. |
| `upgrade-control` | Program → upgrade authority → controller, including the recorded multisig threshold. |
| `who-votes-where` | Voting body → exact governance → controlled target, with classification, side and thresholds. The DAO council controls the admin governance; VSR community voting is separate. |
| `claims-vs-chain` | Claim → checked fact, with G5 status and chain result, plus earlier decoded checks. |
| `holders-and-float` | Holder group → mint, with exact raw amount, display and supply share. Float components, estimates and top-owner groups overlap; never sum all rows. |

## Aura console examples

Inspect observed routes without dropping pending or unobserved links:

```cypher
MATCH (a:TG:PathNode)-[r:ROUTES_TO]->(b:TG:PathNode)
RETURN a.label AS source, b.label AS destination,
       r.status AS status, r.mechanism AS mechanism,
       r.amount AS amount, r.unit AS unit,
       r.windowStart AS firstObserved, r.windowEnd AS lastObserved,
       r.basis AS basis, r.evidenceIds AS evidence
ORDER BY source, destination
```

Follow each fee parameter to its signing controller:

```cypher
MATCH (p:TG:Parameter)-[s:SET_BY]->(r:TG:Role)
      -[:HELD_BY]->(a:TG:Authority)-[:CONTROLLED_BY]->(c:TG:Controller)
RETURN p.label AS parameter, p.display AS value, s.instruction AS instruction,
       r.label AS role, a.address AS authority, c.label AS controller
ORDER BY parameter, instruction
```

Inspect claims without interpreting unresolved checks as contradictions:

```cypher
MATCH (c:TG:Claim)-[r:CHECKS]->(f:TG:Metric)
RETURN c.claimId AS id, c.label AS claim, r.status AS status,
       f.result AS chainResult, r.evidenceIds AS evidence
ORDER BY id
```

Inspect upgrade controllers and their detail entries:

```cypher
MATCH (p:TG:Program)-[:UPGRADE_AUTHORITY]->(a:TG:Authority)
      -[:CONTROLLED_BY]->(c:TG:Controller)
OPTIONAL MATCH (m:TG:Member)-[:MEMBER_OF]->(c)
RETURN p.label AS program, a.address AS authority, c.label AS controller,
       c.controllerType AS kind, c.threshold AS threshold,
       collect(m.address) AS multisigMembers, c.detailAddresses AS authorityDetails
ORDER BY program
```

The path's code-route statuses inherit the API's IDL/state assumptions; this graph is not an independent source-code audit. Buyback credits with wallet spend follow G5's trade-intent qualification. A zero direct receipt by current VSR voter authorities does not establish the absence of indirect distributions or historical eligibility.
