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
| `POST /api/tokenomics/marinade/graph/load` | loads the tokenomics graph into Neo4j (same-origin only; 409 when Neo4j is not configured) |

A section with `status: 'pending'` has `data: null` and a note saying what is missing; render it as "in progress", never as zero. `failed` carries `error` (secret-free).

## Rules for the frontend
- Show the **basis** next to every value (declared, decoded, observed, derived, claimed, reported, inferred) and let every value open its evidence through `/evidence`.
- Never upgrade a status: `claimed` stays claimed, `reported` labels stay reported, `inferred` links stay inferred.
- Status vocabulary for path links: `enforced-by-code` (program code and decoded state make it happen), `operated-by-accounts` (it happens only if a wallet, multisig or governance acts), `claimed-only`, `not-observed`, `contradicted`, `pending`.
- Amounts: use `display` and `unit`; `raw` is exact; never re-round in a way that changes meaning.
- Addresses: shorten for display, full value in a tooltip; `label` only with its `labelBasis`.

## Data freshness
Sections are built from recorded mainnet reads (fixtures in the repository) at server start. `asOf` and `slotRange` say when the chain was read. A live refresh of the tokenomics sections is a later step.
