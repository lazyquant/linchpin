# Brief: tokenomics views in the research web app (frontend)

*Written by Claude, 2026-10-06, for a separate Codex session that builds the frontend while Claude and Codex build the backend. Peter will use these views to show findings to the Marinade team, so precision and neutral wording matter more than decoration.*

## The question the views answer
> Is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?

## Where to work
- Worktree **`~/linchpin-ui`**, branch **`tokenomics-ui`** (created from `tokenomics-graph`). Do not run git commands; leave your changes uncommitted. Claude reviews, tests, commits and merges.
- Run the app on **port 8876** so it does not collide with the stage server on 8875:
  `cd ~/linchpin-ui && LINCHPIN_WEB_PORT=8876 bun run web:live` (uses `~/.config/linchpin.env`; never print or copy its values).
- The backend routes (`/api/tokenomics/...`) land on `tokenomics-graph` in stages; Claude merges them into `tokenomics-ui` and tells Peter. Until then, build against the types and use small hand-made samples inside your tests.

## Files you own
`src/web/app.ts`, `src/web/index.html`, `src/web/style.css`, new files `src/web/tokenomics-*.ts` (views, layout helpers) and `tests/web-tokenomics-ui*.test.ts`.
**Do not modify:** `src/web/server.ts`, `src/web/tokenomics-routes.ts`, anything under `src/tokenomics/`, `src/contracts/`, `src/graph/`, `src/chain/`, `src/pack/`, `scripts/`, `fixtures/`, `packs/`, `package.json`. If you need a backend change, write it into your summary as a request.

## Contract
`src/tokenomics/api.ts` (types, source of truth) and `docs/tokenomics-api.md` (rules). Endpoints: `/api/tokenomics`, `/api/tokenomics/marinade`, `/api/tokenomics/marinade/:section`, `/api/tokenomics/marinade/evidence?id=…`, `/api/tokenomics/marinade/export/tokenomics.json`, `POST /api/tokenomics/marinade/graph/load`.

## Views
1. **Entry:** a "Marinade tokenomics" item in the left navigation, beside the four recorded cases. Page title = the research question; under it the short answer (status chip + text), "as of" slot range, evidence count.
2. **Answer:** the 4–8 headline statements, each with its basis and status and an evidence link.
3. **Path:** a left-to-right diagram, activity → fees → treasury mSOL account → treasury operator → buyback wallet → MNDE purchases → MNDE lockers and holders, plus the governance loop (MNDE voters → DAO governance → fee authority). One line style per link status, with a legend that uses text and icons, not colour alone: enforced by code, operated by accounts, claimed only, not observed, contradicted, pending. Clicking a link opens the side panel: mechanism, parameters, observed flow (window, amount, per-day), claims, who controls it, evidence.
4. **Who can change it:** grouped by controller (Marinade DAO governance; Marinade DAO Emergency Council; the 6-of-13 multisig with its members; individual wallets; nobody, for MNDE minting). Each group lists what it can change and through which instruction or role.
5. **What offsets it:** offset rows with amount, window, basis and note.
6. **Supporting tabs:** Parameters; Programs (with activity and the upgrade timeline); Participation (locking totals, lockup buckets, top lockers, gauge and directed-stake activity); Holders and float; Flows; Claims vs chain (status table, chain result first); Graph (query cards with the Cypher shown, plus a picture of the subgraph; reuse the existing Graph tab patterns).
7. **Pending sections** show "in progress" with the envelope's note, never zeros.
8. **Evidence:** reuse the existing right-hand inspector; values open their evidence records.
9. **Export:** a download of the bundle JSON and a print-friendly layout of the answer, path, control and offsets. Nothing is sent anywhere; Peter decides what he shares.

## Language and design
- Neutral and factual, chain result first. No judgement words ("risky", "centralised", "safe"); the controls and numbers speak. Every number carries its basis.
- Keep the calm look of the current app (pale workspace, one green accent, existing type scale and spacing). Legible on a projector at 1280–1440 px; no horizontal overflow. Status colours: green for enforced by code, amber for operated by accounts, grey dashed for claimed only, red for contradicted, light grey for pending, always with a text label.
- Accessibility: keyboard reachable, visible focus, `prefers-reduced-motion` respected.

## Done when
`bun test` and `bun run typecheck` pass in `~/linchpin-ui`; the views render the live API with pending sections handled; a short summary lists files changed, screenshots (path) and any backend requests.
