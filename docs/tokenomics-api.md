# Tokenomics API (v1, 2026-10-06)

Contract between the backend (branch `tokenomics-graph`) and the frontend (branch `tokenomics-ui`). The TypeScript types in `src/tokenomics/api.ts` are the source of truth; this page explains them.

## The question the views answer

> Is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?

`answer` holds the short answer and the headline findings; `path`, `control` and `offsets` hold the three parts of the question; the other sections hold the supporting facts.

## Endpoints (all GET unless noted; JSON; same origin; no credentials ever reach the browser)

| Endpoint | Returns |
|---|---|
| `/api/tokenomics` | `ProtocolsResponse`: protocols and the status of each section |
| `/api/tokenomics/marinade` | `BundleResponse`: every section envelope |
| `/api/tokenomics/marinade/:section` | `SectionEnvelope<…>` for `answer`, `path`, `control`, `offsets`, `parameters`, `programs`, `participation`, `holders`, `flows`, `claims`, `graph` |
| `/api/tokenomics/marinade/evidence?id=…` | `EvidenceResponse` (repeat `id`, up to 200) |
| `/api/tokenomics/marinade/export/tokenomics.json` | the whole bundle as a download |
| `POST /api/tokenomics/marinade/graph/load` | reserved graph loader (same-origin only; currently 501, `tokenomics graph loader not built yet`) |

A section with `status: 'pending'` has `data: null` and a note saying what is missing; render it as "in progress", never as zero. `failed` carries `error` (secret-free).

## Rules for the frontend
- Show the **basis** next to every value (declared, decoded, observed, derived, claimed, reported, inferred) and let every value open its evidence through `/evidence`.
- Never upgrade a status: `claimed` stays claimed, `reported` labels stay reported, `inferred` links stay inferred.
- Status vocabulary for path links: `enforced-by-code` (program code and decoded state make it happen), `operated-by-accounts` (it happens only if a wallet, multisig or governance acts), `claimed-only`, `not-observed`, `contradicted`, `pending`.
- Amounts: use `display` and `unit`; `raw` is exact; never re-round in a way that changes meaning.
- Addresses: shorten for display, full value in a tooltip; `label` only with its `labelBasis`.

## Data freshness
Sections are built from recorded mainnet reads (fixtures in the repository) at server start. `asOf` and `slotRange` say when the chain was read. A live refresh of the tokenomics sections is a later step.

## Backend notes

The server builds the tokenomics bundle once after preparing the captured examples and logs elapsed milliseconds and fixture/live read counts. It reuses the captured Marinade pack's controller paths, supply facts, documentation checks and treasury ledger. `src/tokenomics/build.ts` calls `readContractsLayer`, `readParticipation`, then `readAuthorities` with the same registry, contracts input and `marinade-contracts` recorder as `scripts/record-contracts.ts`. It does not import or execute that script. Offline mode, recording and refresh settings are explicit; missing fixtures fail the build. Direct access to the recorder's live connection throws before any network request.

Section assembly is pure. Exact amounts remain decimal-string integers; displays use the decoded units. Fee basis points divide by 100 for percent, FeeCents divide by 10,000 for percent, and lamports divide by 1 billion for SOL. The mSOL price uses the contract layer's declared scaling convention. Time-locked MNDE is distinct from all deposited MNDE. Top lockers rank deposits, including unlocked deposits. Treasury balances cover only the token accounts captured by the pack, not all possible DAO holdings. Observed proposal outflows are not evidence of market sales.

All timestamps come from recorded evidence, including the participation layer's fixed time for lockup buckets and dormancy. Machine time and the pack's generation timestamp do not enter the bundle. Identical fixtures and optional-layer/environment configuration produce byte-identical JSON. Each envelope counts unique cited evidence and derives its slot range and capture date from those records; graph metadata uses the path and control evidence. Layer assumptions and ledger scope notes are carried into the envelopes. The evidence endpoint indexes every layer, retains `.json` or `.json.gz` fixture filenames, and includes content-hashed records for the captured documentation and registry. Recorder endpoint fields are excluded by an explicit field allowlist. Evidence requests accept up to 200 SHA-256 identifiers, with absent identifiers returned in `missing`.

`holders` and `flows` are optional and currently absent. Their envelopes have `status: 'pending'`, `data: null`, and an explanation. The loader checks for `src/contracts/holders.ts` and `src/contracts/flows.ts` before importing them. An optional module integrates through an exported `buildTokenomicsSection` adapter (the `OptionalLayerReader` type in `build.ts`): it receives the offline recorder and existing layers and returns API-shaped `data`, `evidence`, `assumptions`, and optional `notes`. An existing module without an adapter fails explicitly, rather than treating an incompatible or broken layer as absent. Flow observations and claim upgrades require supported evidence mappings; the backend does not infer them from the mere presence of transactions.

The current path's `enforced-by-code` statuses mean declared routes plus decoded state under the carried contract assumptions; they are not an independent source audit. Onward treasury transfers remain `operated-by-accounts`; buyback allocation and staker distributions remain `claimed-only`; purchases and the delayed-unstake fee destination remain `pending`. The answer checks directed activity-to-holder paths, so enforced fee links followed by these conditional links yield `partly`, never `yes`. It renders eight deterministic statement templates and lists unresolved authorities and pending links as unknowns.

The graph response is local, has no host or queries, and reports only whether Neo4j credentials are configured. The reserved graph-load POST returns 501 regardless of configuration; a cross-origin POST returns 403 before any loader handling. GET routes only read the startup bundle, and the export route returns that same bundle with an attachment header.
