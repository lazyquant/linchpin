# Linchpin Tokenomics Dependency Graph — Plan, Research Pack and Marketing Pack (Oct 2026)

*Repository copy of the vault plan. Plan by Claude, 2026-10-06 11:24:40 CEST, at Peter's request (D-2026-10-06-5). Code: `lazyquant/linchpin`, branch `tokenomics-graph`, worktree `~/linchpin-graph`; a copy for Codex is in the repo at `docs/plans/2026-10-06-tokenomics-dependency-graph.md`. The stage build for 7 Oct stays frozen at tag `v0.3-demo` (D-2026-10-06-6).*

## 0. Status as of 2026-10-06 11:30 CEST

| Layer | What Linchpin has | Basis | Gap |
|---|---|---|---|
| Control | Upgrade authorities of 10 Marinade programs (9 DAO-controlled; the mSOL program's `551FBX…` unresolved); mint and freeze authorities of 4 mints | verified on chain (24 verified · 2 contradictions · 4 unresolved) | Authorities *inside* program state (admin, manager, pause) and the fee parameters they control are not read |
| Supply | MNDE: no mint or freeze authority; 300,000,000 burned in MIP-14; implied pre-burn 999,997,047.68 vs the claimed 1 B cap. mSOL supply read | verified; cap claimed | mSOL mint and burn mechanism not modelled; holders and concentration not read |
| Treasury | DAO treasury ledger from 277 executed proposals (MNDE external out 203.4 M, internal 560.7 M, burns 300 M; USDC 562 k, USDT 560 k out) | observed, 0 mismatches | Flows outside governance: fee income, buybacks, staking rewards out (old B.2) |
| Value routes | Nine docs claims (reward fee 0, SAM bids, Select 20 bps, lending 5 %, MIP-22 10 % to buybacks → stakers, 10 M MNDE pool seed, 30-day unlock) | claimed | None verified |
| Token utility | — | — | Locking (VSR), voting power, gauges, directed stake not modelled |
| Downstream | — | — | Who holds and depends on mSOL and MNDE |
| Graph | Aura holds the demo's cross-case evidence graph (360 entities, 395 relations) | rebuildable index | No tokenomics model in it |

**In one sentence:** Linchpin answers who controls Marinade's code, supply and treasury, and what the DAO spent; it does not yet answer the pack's research question, *is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?*

## 1. What the mainnet probe showed (2026-10-06, Alchemy, read-only)

Spike scripts: `scripts/spike/tokenomics-probe.ts`, `scripts/spike/tokenomics-counts.ts` in the branch. Numbers below are spike readings at slot ~453.86 M; the product re-captures them as evidence before any of them goes into a pack.
- **Contract interfaces are on chain.** Nine of ten programs publish an Anchor IDL account (all except SPL Governance, which is not Anchor), including the three documented as *closed source* (escrow relocker, validator and liquidity gauges, directed stake). Their state can therefore be decoded from mainnet without trusting the docs.
- **The liquid-staking program's control surface, from its IDL:** `configMarinade` and `configLp` (fees, caps, LP parameters) and `changeAuthority` (reassigns admin, validator manager, operational SOL account, treasury mSOL account, pause authority) require the **admin authority**; `pause`/`resume` require the **pause authority**; validator add/remove/score and emergency unstakes require the **validator manager**. State fields include `rewardFee`, `delayedUnstakeFee`, `withdrawStakeAccountFee`, `depositSolFee`, `depositStakeAccountFee`, LP `treasuryCut`, `lpMinFee`/`lpMaxFee`, `stakingSolCap`, `msolPrice`, `msolSupply`, `treasuryMsolAccount`.
- **Layouts match:** the liquid-staking State `8szGku…` (2,616 bytes) and the VSR registrar for MNDE carry the discriminators their IDLs predict.
- **Account counts:** 1,094 delayed-unstake tickets; 18,908 VSR voters (MNDE lockers); escrow relocker 3,728 escrows, 135 gauges, 554 gauge voters, 622 gauge votes; directed stake 7,685 vote records; 40 Native roots; 29 referral states.
- **Holders:** MNDE 62,684 non-zero accounts, top 10 hold 68.27 %, top 100 hold 94.62 %; largest: DAO treasury 21.94 %, Labs treasury 16.74 %, a second DAO-treasury MNDE account 5.16 %, then VSR voter vaults. mSOL 145,617 non-zero accounts, top 10 hold 36.40 %, top 100 66.29 %.
- **Observed calls (8 recent transactions per program):** liquid staking → Token, System; referral → liquid staking, Token; Native proxy → Stake; VSR → Token. Gauges, escrow relocker and directed stake show no recent cross-program calls; their newest transactions are from July–August 2026 (Q18: are gauges still live?).

## 2. Research questions (the research pack answers these with evidence)

1. **Supply control:** who can create, destroy or freeze MNDE and mSOL, through which program and authority path?
2. **Parameter control:** which economic parameters (fees, caps, LP cut, pause) exist, which instruction changes each, which signer role it needs, and who holds that role (DAO governance, multisig, wallet, unknown)?
3. **Value routes:** where does protocol revenue arise (reward fee, unstake fees, LP cut, SAM, Select, lending fee, Native), which account receives it (decoded from state), what was observed to flow there in the last 30 days, and does any of it reach MNDE holders (MIP-22 buybacks → staking rewards)?
4. **Token utility:** what MNDE does on chain today: locking in VSR (amount, share of supply, lockup kinds, voting-power configuration), gauge and directed-stake voting (counts, last activity), unlock delay.
5. **Concentration and float:** who holds MNDE (DAO, Labs, lockers, wallets), what is locked vs liquid.
6. **Downstream dependencies:** where mSOL sits (lending, pools, exchanges), i.e. who depends on the mSOL program and its authorities.
7. **Program dependencies:** which programs call which, and which Marinade programs are dormant.
8. **Claims vs chain:** each docs claim (v1–v9 and the contract-page authority labels) marked verified, contradicted or unresolved, with the chain result first.

## 3. Graph model

- **Nodes** (Neo4j label `:TG` plus a type label): `Program` (IDL name and version, upgrade authority, last activity), `Instruction` (signer roles, arguments), `StateAccount` (decoded singleton/config accounts), `Parameter` (value, unit, slot), `Mint`, `TokenAccount`, `Authority` (classified: DAO governance, native treasury PDA, multisig, wallet, program PDA, unknown), `Mechanism` (reward fee, unstake fees, LP cut, SAM, Select, lending fee, buyback, MNDE staking rewards, locking, gauge voting, directed stake), `Holder` (classified; third-party labels marked *reported*), `Claim`.
- **Relationships:** `UPGRADE_AUTHORITY`, `HAS_STATE`, `FIELD` (state → account, with field name), `HAS_PARAM`, `SETS` (instruction → parameter; inferred from IDL argument names, basis *inferred*), `REQUIRES_SIGNER` (instruction → role), `HOLDS_ROLE` (authority → role), `MINT_AUTHORITY`, `FREEZE_AUTHORITY`, `CALLS` (observed cross-program calls with counts and sample signatures), `HOLDS` (holder → mint, amount, share), `LOCKS` (voter → MNDE, lockup), `FEEDS` (mechanism → account), `FLOWS_TO` (observed value flows with window and total), `CLAIMS`/`CHECKS` (claim ↔ fact).
- **Basis on every edge:** `declared` (IDL), `decoded` (account state via IDL), `observed` (transactions), `derived` (PDA maths), `claimed` (docs), `reported` (third-party labels), `inferred` (name matching); plus evidence ids and slot.
- **Isolation until the merge review:** all nodes carry `:TG` with their own uniqueness constraint; relationship types avoid the demo's unlabelled `TRANSFER`/`BURN`; the loader re-runs the four demo queries before and after each load and must find identical rows. No Aura writes before Demo Day ends (D-2026-10-06-6).

## 4. Tasks

| # | Task | Owner | When | Done when |
|---|---|---|---|---|
| G0 | Freeze the stage build (`v0.3-demo`), new worktree and branch, mainnet spikes | Claude | 6 Oct | done 11:35 |
| G1 | **Contract interfaces from chain:** read on-chain Anchor IDLs through the recorder; IDL-driven Borsh decoder (legacy IDL type grammar); instruction inventory (signer roles, arguments); record script | Codex builds; Claude records and verifies | 6 Oct | 9 IDLs captured as evidence; State and Registrar decode; known-value checks pass (State.msolMint = mSOL mint; Registrar voting mint = MNDE) |
| G2 | **State and parameter-control map:** decode the singleton/config accounts of all nine programs; parameters with units; every authority field classified with the existing classifier; instruction → parameter (`SETS`, inferred) → signer role → holder | Codex + Claude | 6 Oct | RQ2 answered for the liquid-staking program; claim v1 (reward fee 0) verified or contradicted |
| G3 | **Utility and participation:** VSR voters (locked MNDE by lockup kind, voting-power config), escrow relocker and gauges (counts, totals, last activity), directed-stake votes, delayed-unstake tickets | Codex + Claude | 6–7 Oct | RQ4 numbers with evidence; Q18 answered |
| G4 | **Holders and downstream:** MNDE and mSOL distributions; top 25 holders classified (DAO, Labs, VSR vault, program-owned, PDA, wallet); third-party labels as *reported* | Codex + Claude | 7 Oct (after Demo Day) | RQ5–RQ6 with evidence |
| G5 | **Value routes and flows (old B.2):** mechanisms linked to parameters and receiving accounts; 30-day observed flows into the treasury mSOL account and through the buyback wallet; claims v1–v9 checked | Codex + Claude | 7–8 Oct | RQ3 and RQ8 |
| G6 | **Neo4j:** `:TG` loader, one Cypher query per research question, the demo-query regression check, Aura console views | Codex + Claude | 8 Oct | Aura loaded; RQ1–RQ8 answer from Aura; demo queries unchanged |
| G7 | **Research pack:** "Marinade (MNDE) — Tokenomics Dependency Report, generated by Linchpin": findings per question with evidence ids and slots, diagrams, unknowns, method, Cypher appendix; format chosen via the artifact quickstart when drafting starts | Claude drafts from the graph; Peter edits | 8–9 Oct | Peter approves v1 |
| G8 | **Marketing pack:** one-pager, 8–10-slide deck, graph visuals, 3-minute demo-video script for Colosseum, positioning copy, all built from G7's verified findings | Claude drafts; Peter decides | 9–11 Oct | Peter approves; nothing published or sent without him |

## 5. Timeline
- **Tue 6 Oct:** G1–G2, G3 started (Codex builds in `~/linchpin-graph`, Claude records through Alchemy and verifies by exit code). Peter rehearses on the frozen stage build.
- **Wed 7 Oct:** no changes to the stage worktree or the Aura instance before Demo Day ends (14:00 slot); afterwards G3–G4.
- **Thu 8 Oct:** merge review (`protocol-pack` → `main`), then `tokenomics-graph` → `protocol-pack`; G5–G6; research pack v1.
- **Fri 9 – Sun 11 Oct:** marketing pack; Colosseum videos and submission (Peter).
- **Mon 12 Oct, 23:59 PDT:** Colosseum deadline.

## 6. Rules
- An IDL is a *claim* about a layout until a decode matches independent facts (discriminator, known mint addresses, totals that reconcile with token balances).
- Inferred instruction-to-parameter links stay labelled *inferred*; a field name is not proof of behaviour.
- Third-party labels (exchange, protocol names) are *reported by* their source with a date, never verified.
- Supply shares use the supply read at the same slot range; "locked" means held under a VSR or escrow lockup, decoded, not "staked" in the SOL sense.
- No secrets in code, fixtures, notes or chat; nothing published or sent without Peter.

## Log
- 2026-10-06 11:24:40 CEST — Plan written after Peter's request and two read-only mainnet spikes; stage build frozen at `v0.3-demo`; G1 dispatched to Codex. (Claude)
