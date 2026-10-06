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
| `POST /api/tokenomics/marinade/graph/load` | `{ nodes, relationships, batches, host, regression, changedQueries }`; same-origin, serialized, 120 s deadline; 409 if Neo4j is not configured or a load is in progress |

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

The server builds the tokenomics bundle once after preparing the captured examples and logs elapsed milliseconds and fixture/live read counts. It reuses the captured Marinade pack's controller paths, supply facts, documentation checks and treasury ledger. `src/tokenomics/build.ts` calls `readContractsLayer`, `readParticipation`, `readAuthorities`, `readGovernanceConfig`, `readHolders`, then `readFlows` with the same registry, contracts input and `marinade-contracts` recorder as `scripts/record-contracts.ts`. It does not import or execute that script. Offline mode, recording and refresh settings are explicit; missing fixtures fail the build. Direct access to the recorder's live connection throws before any network request.

Section assembly is pure. Exact amounts remain decimal-string integers; displays use the decoded units. Fee basis points divide by 100 for percent, FeeCents divide by 10,000 for percent, and lamports divide by 1 billion for SOL. The mSOL price uses the contract layer's declared scaling convention. Time-locked MNDE is distinct from all deposited MNDE. Top lockers rank deposits, including unlocked deposits. Treasury balances cover only the token accounts captured by the pack, not all possible DAO holdings. Observed proposal outflows are not evidence of market sales.

All timestamps come from recorded evidence, including the participation layer's fixed time for lockup buckets and dormancy. Machine time and the pack's generation timestamp do not enter the bundle. Identical fixtures and environment configuration produce byte-identical JSON. Each envelope counts unique cited evidence and derives its slot range and capture date from those records; graph metadata includes path, control, claim, participation and holder evidence. Layer assumptions and ledger scope notes are carried into the envelopes. The evidence endpoint indexes every layer, retains `.json` or `.json.gz` fixture filenames, and includes content-hashed records for the captured documentation and registry. Recorder endpoint fields are excluded by an explicit field allowlist. Evidence requests accept up to 200 SHA-256 identifiers, with absent identifiers returned in `missing`.

`holders` and `flows` use G4 and G5 directly. Optional local reported-label files are loaded in sorted filename order, as in `record-contracts.ts`. All RPC reads replay fixtures. G5 receives the captured pack ledger; its generation timestamp is excluded so replay stays deterministic. Registry and documentation source references map to file-backed evidence records; G5 ledger references resolve to the captured pack's original evidence. No contract-layer adapter is needed.

`holders` exposes MNDE owner concentration, top-owner classifications and custody-based float components, plus mSOL token-account concentration, top holders and downstream groups. DAO holdings derive from governance ownership; the Labs identity remains claimed. Both float estimates show their exclusions. Float is a custody remainder, not market liquidity; mSOL downstream groups can overlap.

`flows` exposes declared account candidates, treasury inflows with instruction attribution and an explicit observed window, outgoing authority transfers, and monthly buyback aggregates. Raw amounts remain exact decimal strings. Instruction candidates do not prove causality, unavailable transactions do not become zero revenue, and samples are bounded rather than complete protocol histories. Claim rows preserve G5's v1–v9 and documentation fee checks, including unresolved cross-window revenue comparisons.

Path observations distinguish wallet-operated purchases, direct distributions to current VSR voter authorities, and other observed recipients. Recipient account ownership is reported without assigning an unknown program a purpose. `not-observed` means no matching observation in the stated sample; it does not disprove indirect payouts. A contradiction requires chain evidence against the specific claim. The delayed-unstake destination remains a pending link because G5 reports no declared destination. Section envelopes are ready when their layers are available, even when individual facts remain unresolved.

The eight answer templates cover council control of configuration, community treasury voting with council veto, reward fees, LP treasury cuts, deposited and time-locked MNDE, upgrade control with council membership overlap, pause control, and observed buyback amounts, spending, recipients and windows. All governance thresholds, proposal minima, membership and overlap counts come from the governance layer. The short answer distinguishes council configuration control from onward actions by treasury and buyback accounts. No enforced end-to-end entitlement is inferred from wallet activity.

Controllers represent **voting bodies**, with separate `controller:realm:<realm>:community` and `controller:realm:<realm>:council` IDs. The DAO council and Emergency Council use `council-realm`; their `members` contain only current council owners with positive recorded deposits. The DAO community uses `dao-governance`, with “MNDE voters through VSR” when the recorded add-in matches the registry's VSR program. Each controller's additive `governances` field lists address, native treasury, classification, side, vote/proposal/veto permissions, and governance-specific threshold text. `threshold` summarizes those configurations; it is not a realm-wide fixed threshold.

Control rows retain `controllerId` for the primary proposing body and add `controllerIds` for all voting/veto bodies, `governance` for the exact governance address, and `note` for its thresholds and limits. Veto permission does not imply proposal creation or an independent ability to transfer funds. Admin configuration rows explicitly state “community voting disabled in this governance” when the decoded classification is council-only. DAO and documentation-labelled Labs MNDE treasuries use their individual configurations. All program upgrades, including Native proxy, and council mint authorities are included. The liquid-staking upgrade row carries the current council-member/multisig overlap count.

Wallets, multisigs, program PDAs, absent authorities and unresolved groups remain distinct. Unresolved Native operator and alternate-staker authorities remain grouped by role; their `members` are address details, not asserted council or multisig memberships. Parameter setters reference the control rows so a council governance cannot be conflated with its realm's community controller.

The path has separate branches: `Marinade DAO council → admin authority → fee parameters` and `MNDE voters (VSR) → DAO treasury governance → DAO treasury MNDE`. Both carry decoded governance evidence and `enforced-by-code` status under the section's IDL/state assumptions. The treasury branch carries vote thresholds, proposal minima and the council veto. VSR voting has no link to the admin authority. These paths describe configured permissions, not an observed vote or transfer.

Until the new governance reads are captured, missing fixtures fail the offline bundle build; the backend never falls back to the old realm-wide controller model. `out/contracts-marinade/answer.synthetic.json` is an explicitly labelled synthetic example generated by the section functions, not a mainnet result. Capture with `bun run scripts/record-contracts.ts --record`, then rebuild the API to obtain the recorded short answer and statements.

## Graph section

The graph is built only from the API bundle, using `:TG` plus a type label. It never uses `:Entity`, `TRANSFER` or `BURN`. See [Neo4j tokenomics](neo4j-tokenomics.md) for the schema, queries and console examples.

`graph.data` contains `source`, `configured`, a redacted `host`, a fallback `reason`, all eight query definitions/results, and a path-and-control `subgraph`. Query IDs are `path-to-holders`, `who-can-change`, `parameter-control`, `supply-control`, `upgrade-control`, `who-votes-where`, `claims-vs-chain`, and `holders-and-float`. Rows contain only scalar strings, numbers or nulls; local and Neo4j results share their columns and ordering.

GET graph, bundle, protocol index and JSON export routes use the graph service. The driver is lazy. Configured Aura reads use READ routing, a 5 s deadline per query, and a 30 s cache. Unconfigured, unreachable, timed-out or mismatched graph snapshots return the same query results from memory with `source: 'local'` and a scrubbed reason. No GET loads or updates Aura. Subgraph data always comes from the captured bundle.

The POST loader validates the complete namespace before any write, snapshots all four demo canned queries, creates the TG uniqueness constraint, replaces only TG nodes/relationships, and writes parameterized batches of at most 500 records. It then reruns the demo queries and compares normalized rows. `regression: 'changed'` includes the differing query IDs and makes the graph envelope `failed`, with the same message in `error`; local data remains available. A successful subsequent load clears the failure. The loader returns 409 when unconfigured or another load is active, 504 on its deadline, and 502 on a scrubbed driver failure. Its lock remains held until an in-flight call settles, even after a timeout response. Cross-origin POSTs return 403 before accessing the loader.

The offline startup bundle remains deterministic. Runtime graph source, host, reason and failure status reflect the service state and can therefore differ between requests. No Neo4j or Solana credentials are sent to the browser.
