# Neo4j cross-case evidence index

The graph is a **rebuildable index** of committed evidence, not a new source of truth. Packets, recorded RPC fixtures, receipt reconciliation and evidence identifiers remain authoritative. Loading does not fetch Solana state or refresh the captured evidence. The application can call `runCannedLocal(records, id)` when Neo4j is unavailable and render the same columns as `runCannedNeo4j(driver, id, { database })`.

The research workspace provides these queries in its **Graph** tab, with an optional Aura connection, a load button, and automatic local fallback. See [the workspace Graph guide](workspace.md#graph) for configuration, source badges, memo provenance, and API routes.

## Create an Aura database

When network access is available, open the Neo4j Aura console at <https://console.neo4j.io/>, sign in, and create an AuraDB instance using the **Free** option. Save the generated credentials securely and wait until the instance is available. Copy its connection URI, normally `neo4j+s://<instance>.databases.neo4j.io`. Console wording may vary. This repository does not provision an instance.

Set these environment variables in your shell or secret manager; do not commit credentials:

| Variable | Meaning | Default |
| --- | --- | --- |
| `NEO4J_URI` | Aura connection URI | Required for loading |
| `NEO4J_PASSWORD` | Database password | Required for loading |
| `NEO4J_USERNAME` | Database username | `neo4j` |
| `NEO4J_DATABASE` | Target database | `neo4j` |

The installed `neo4j-driver` dependency is sufficient. Run from the repository root:

```sh
bun run scripts/load-neo4j.ts --dry-run
bun run scripts/load-neo4j.ts
```

Both commands build `marinade`, `mip-14`, `mip-14-opinion`, and `bonk-bip76` through the existing offline `runPipeline`. That pipeline also writes its usual generated artifacts under `out/web/<case>/`. Dry-run prints one JSON inventory line per case and stops before reading Neo4j configuration or creating a driver. It requires no credentials or network access.

The load command prints the inventories and redacted database hostname, verifies connectivity, creates the entity uniqueness constraint, writes nodes and then relationships, runs the four queries, and prints their row counts. It closes the driver on success or failure. Missing configuration or invalid arguments return exit code 2; other failures return 1. Driver errors are deliberately summarized because raw error messages can contain credentials or a complete connection URI.

Select cases with repeatable flags:

```sh
bun run scripts/load-neo4j.ts --dry-run --case marinade --case mip-14
bun run scripts/load-neo4j.ts --case marinade --case mip-14
```

Use a dedicated database. Repeating a load of the same recorded inputs is idempotent: entity IDs and relationship keys are merged, never appended blindly. Partial loads retain existing case memberships and other cases' inventory metadata. This is an additive loader, not a synchronization/deletion tool: removing or changing records upstream does not delete old indexed entities, relationships, or labels. For a changed evidence snapshot, rebuild a fresh dedicated database and load all four cases together. Batches commit independently, so a failed load can leave a partial index; retry the complete load before treating the inventory as complete. There is no automatic fallback inside the driver API; the caller decides when to use the local query API.

## Schema and evidence boundaries

Every entity has `:Entity` plus a sanitized label derived from its type, and `id`, `type`, display `label`, and sorted `cases` properties. The view uses bare addresses in the Marinade pack and presentation prefixes in review cases. The loader canonicalizes address-bearing `realm:`, `gov:`, `treasury:`, `proposal:`, `ta:`, `acct:`, `mint:`, and `ptx:` IDs to their base58 addresses. Other graph IDs retain their existing identity. Thus the Marinade realm and treasury join across all relevant cases. More specific known types take precedence over ledger fallback `Account` nodes in a combined build.

Only an allowlist of structured descriptive properties is copied. Arbitrary source/detail/configuration maps, URLs, local paths, secrets, unslotted balances and supplies are excluded. Evidence references are IDs, not source bodies or locations. Node state snapshots are not flattened into a timeless balance. Inventory evidence counts and slot bounds come directly from each view and are stored under per-case metadata properties on an existing entity. Inventory node and relationship counts include the ledger additions; evidence counts cover the full packet, not just edge citations. Slot bounds describe fixture coverage, not merely execution slots.

View edges preserve their direction and basis (`claimed`, `decoded`, `simulated`, or `observed`). The relation vocabulary is an explicit table in `src/graph/neo4j.ts`; unknown names are rejected. Relationship identity is SHA-256 of `case|source|type|target|label`. Existing duplicate view edges merge their evidence IDs. Labels and relationship types are validated before entering Cypher; all property values are parameters. Writes use `UNWIND` in groups of at most 500 rows and need no APOC procedures.

For Marinade, reconciled observed ledger transfers become `TRANSFER` relationships, and burns become source-account-to-mint `BURN` relationships. Each has proposal address/name, mint, exact string amounts, decimals, owner classifications, reconciliation status, receipt signature, execution slot/time, and evidence IDs. Proposal nodes carry name, case and execution time. When one proposal has several instructions, its node time is the last processed instruction's time; the relationship time remains authoritative for each movement. Instruction labels include transaction address and option/transaction/instruction indices so repeated equal payments retain distinct keys. No additional `MOVED` relationships are emitted.

The ledger has no stored `flow` field. The loader uses its summary names and control rules:

| `flow` | Rule |
| --- | --- |
| `externalOutflows` | DAO-controlled source → external destination |
| `internalMoves` | DAO-controlled source → DAO-controlled destination |
| `externalInflows` | External source → DAO-controlled destination |
| `burns` | Burn from a DAO-controlled source |
| `unclassified` | Other observed transfer/burn with insufficient qualifying control information |

Only rows with observed basis, an execution time, a receipt signature and matched reconciliation (including an aggregate match) become movements. Aggregate matches retain the ledger's decoded instruction amounts and reconciliation description; they do not assert an independently observed per-instruction delta. Remaining rows become `Proposal` → `Program` `INSTRUCTED` edges with program, category, label, basis and reconciliation. This includes unsupported instructions and unobserved token payloads, which must not be represented as proven movements. Mint-to instructions are retained as instructions and are outside the ledger's transfer/burn flow formula.

## Four cross-case questions

`CANNED_QUERIES` exports each question's title, exact runnable Cypher, parameters and columns. The driver runs this Cypher with read routing. Both implementations return `{ id, title, question, cypher, columns, rows }`; every cell is a string, number or null. No Neo4j objects or bigint values reach the UI.

| ID | Question and result |
| --- | --- |
| `shared-controllers` | Which Governance, NativeTreasury, Realm and Program entities occur in at least two cases? Returns `entity`, `type`, `label`, comma-joined sorted `cases`, and `inboundControlEdges`. The count includes case-specific control relationships into the entity. |
| `paths-to-realm` | Which TokenAccount, Program and Mint entities reach Marinade's realm in one to four directed control hops? Returns `start`, `startType`, `hops`, IDs joined with ` → ` as `path`, per-hop comma-joined `bases`, and sorted union of the edges' `cases`. |
| `mnde-external-destinations` | Which destinations received reconciled external MNDE outflows? Returns `destination`, `destinationControl`, distinct `proposals` count, exact `totalRaw`, `totalDisplay`, `firstExecutedAt`, and `lastExecutedAt`, sorted by descending raw total, then destination. |
| `case-inventory` | What is indexed for each recorded case? Returns `case`, `nodes`, `relationships`, `evidence`, `slotMin`, and `slotMax`. |

Control relationships include ownership, treasury membership, realm membership, derivation, and authority links. Paths use the recorded edge direction (dependent entity toward controller in these fixtures). A result may combine edges from different cases and slots; its case union and per-hop bases do not prove that every hop existed simultaneously. Parallel paths with identical displayed fields collapse to one row. Relationships cannot repeat within a path, matching Cypher's path semantics.

The realm and MNDE mint are read from the committed Marinade registry and passed as parameters. MNDE display uses nine decimal places of precision, thousands separators, and trims trailing fractional zeros. Raw totals remain decimal strings. The local implementation uses `BigInt` internally; Cypher sums decimal digit columns with carries, avoiding floating-point rounding and signed-64-bit overflow of whole raw amounts. Execution dates are ISO strings, with null for unavailable dates. The committed Marinade fixture's grouped external outflows reconcile to the packet summary's **203,378,500.27 MNDE**.

Inspect or export any query's complete Cypher and parameters without a database:

```sh
bun -e 'import { CANNED_QUERIES } from "./src/graph/neo4j"; for (const q of CANNED_QUERIES) console.log(JSON.stringify({id:q.id, cypher:q.cypher, params:q.params}, null, 2))'
```

A local consumer can build records once and answer all questions offline:

```ts
import { CASES } from './src/web/model';
import { runPipeline } from './src/web/runner';
import { buildGraphRecords, CANNED_QUERIES, runCannedLocal } from './src/graph/neo4j';

const inputs = [];
for (const { id: caseId } of CASES) inputs.push({ caseId, ...await runPipeline(caseId) });
const records = buildGraphRecords(inputs);
for (const query of CANNED_QUERIES) {
  console.log(runCannedLocal(records, query.id));
}
```

## Offline verification

```sh
bun test
bun run typecheck
bun run scripts/load-neo4j.ts --dry-run
```

Tests rebuild all four recorded cases, reconcile exact flow totals, check batching and parameterization, and inject a fake driver to verify write order, error propagation, read routing and result normalization. They do not connect to Aura or execute Cypher against a database. Connectivity and server-side Cypher execution must be checked by the load command in an environment with database access.
