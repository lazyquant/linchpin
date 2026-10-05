---
tags: [project/quantrin-ledger, project/current, product, linchpin, protocol-pack, marinade, mnde, solana, implementation-plan]
date: 2026-10-05
updated: 2026-10-05
status: active
type: implementation-plan
related: ["[[Researcher Pack — Review and First Protocol Plan, Marinade MNDE (Oct 2026)]]", "[[One-Day Build Plan — Linchpin Governance Review Demo (Oct 2026)]]", "[[Marinade]]"]
project: "[[Quantrin Project Home]]"
project_role: current
---

# Linchpin Protocol Pack — Slice A Plan: Marinade Control and Supply Map (Oct 2026)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Codex implements in the worktree **`~/linchpin-pack` (branch `protocol-pack`)**, never in `~/linchpin` (main is frozen at `v0.2-demo` until after Demo Day). Codex has no network and cannot write `.git`: Claude records fixtures (`--record`) and commits. Verify by exit code.

**Goal:** By Thu 9 Oct 2026 a `linchpin pack packs/marinade/pack.json --offline` command renders the **Marinade control and supply map** as of a recorded slot: every program, mint and treasury account in the declared boundary with its controller path and a status (verified / claimed / contradiction / unresolved / outside scope), the MNDE supply statement, the docs' value-route claims listed as claims, and an unknowns queue. Zero wrongly attributed controller paths in Claude's review.

**Architecture:** the same recorder, evidence and HTML machinery as the governance packets, plus three small readers (program upgrade authority, account classifier, mint/token state) and a pack model that is a list of *controller paths* and *statements*, each with evidence ids. No flow ledger yet (Slice B), no database, no LLM.

**Tech stack:** unchanged (Bun, web3.js 1.99, spl-governance 0.3.28, spl-token 0.4.15).

**Decisions implemented:** D-2026-10-05-10 (start Tue 6 Oct in parallel with rehearsal, Slice A first), D-2026-10-05-7 (Linchpin), D-2026-10-05-6 (TypeScript slice). Research question (from the review): *Is there an enforceable path from Marinade's protocol activity to MNDE holders as of slot S, through which mechanism, what offsets it, and who can change the route?* Slice A answers the "who can change the route" and "what is the supply" parts.

## 0. Inputs already in the branch (committed by Claude, 2026-10-05)

- `packs/marinade/registry.json` — programs (10), mints (4), governance (realm, program, council mint, VSR, known governances), accounts (12: DAO Treasury = native treasury PDA `B56RWQ…`, its MNDE token account `GR1LBT…`, Labs Treasury `J5BEce…`, buyback accumulation `BBaQsi…`, treasury reserve SOL, treasury mSOL accounts, Native authorities), nine value-route claims, the research question, the unknowns seed. Every entry names its source (`docs:*`, `forum:*`, `chain:2026-10-05`).
- `packs/marinade/sources/marinade-docs-capture-2026-10-05.json` — verbatim text capture of the Marinade docs pages with retrieval time; quote from it, never paraphrase into a claim.
- Verified already (public RPC, 2026-10-05): MNDE mint has no mint and no freeze authority (slot 453658037); governance program upgrade authority `6egAu2…` is a DAO governance account (slot 453676355); mSOL program upgrade authority `551FBX…` is an off-curve address with no account (slot 453676353). Codex re-records these through the recorder so the pack carries its own evidence.

**Authority pass already run (Claude, public RPC, 2026-10-05 ~22:12 CEST; `packs/marinade/sources/authority-spike-2026-10-05.json`):** eight programs have upgrade authorities that are **DAO governance accounts** (owned by `GovMaiH…`, 236 bytes): governance program → `6egAu2…`, tokadapt → `CWRgRr…`, escrow-relocker → `AEej7L…`, validator gauges → `CLydpg…`, liquidity gauges → `3cBS14…` (the contract page says "None"), referral → `6XQFdW…`, directed stake → `2aQP7N…`, VSR → `2w6ny7…`. The **mSOL liquid-staking program** → `551FBX…`, an off-curve address with no account (unresolved; docs say "ecosystem multisig"). The **Marinade Native proxy** → `6YAju4…`, a system-owned off-curve PDA with no data, **not** a DAO governance account (the governance page claims the DAO holds Native's upgrade authority: contradiction to record). Codex re-records all of this through the recorder in Task A2 so the pack carries its own evidence; the spike file is reference only.

**Further facts from the same pass (slot ~453683420):** council mint supply **5, decimals 0** (docs claim verified) but it has a **mint authority `26Pw2q…`** (to classify: who can mint council seats); mSOL mint authority is the documented PDA `3JLPCS…`, supply 1,600,336.17 mSOL; the buyback accumulation address `BBaQsi…` is a **system-owned wallet**, so the bought MNDE sits in its associated token account (derive the MNDE ATA and read it); Labs Treasury `J5BEce…` is an off-curve system PDA (classify: likely a governance native treasury); the liquid-staking Treasury Reserve PDA holds 36,641.08 SOL; the VSR registrar is an 880-byte account owned by the VSR program.


> **Correction (2026-10-05 ~22:50 CEST, Claude):** the recorder's classifier matched the Native proxy's upgrade authority `6YAju4…` to a **native treasury PDA of one of the realm's governances**, so the DAO does hold Native's upgrade authority; the earlier "not a DAO governance account" reading came from an owner-only check. The contradiction to record remains the contract page's "Marinade council (3/5)" labels versus these DAO-controlled authorities, and the mSOL program's `551FBX…` stays unresolved.

**Claims to carry as claims, never as facts:** the governance page's authority list, the contract page's "Marinade council (3/5)" labels (page layout makes their attachment ambiguous), the forum's 1 B cap, and every value-route sentence in the registry.

## 1. Timeline

| When | What | Who |
|---|---|---|
| Tue 6 Oct morning | Tasks A1–A2 (readers, classifier, tests on synthetic data) | Codex; Claude reviews |
| Tue 6 Oct afternoon | Claude records fixtures (`--record`), runs offline tests, commits; Task A3 | Claude, Codex |
| Wed 7 Oct | **No work on the pack** (Demo Day) | — |
| Thu 8 Oct | Tasks A4–A5 (pack model, packet, contradictions) | Codex; Claude reviews |
| Fri 9 Oct | Task A6 (tests, README section), Claude's controller-path review, merge decision; data-access gate for Slice B (D-2026-10-05-12) | Claude |

## 2. File structure (worktree `~/linchpin-pack`)

```
packs/marinade/pack.json            case file for the pack (boundary, registry path, claims file, options)
packs/marinade/registry.json        (exists) addresses, roles, sources, claims
packs/marinade/sources/*.json       (exists) docs capture
src/chain/program-authority.ts      upgrade authority from the BPF upgradeable loader
src/pack/classify.ts                what an authority address is: DAO governance account, native treasury PDA, Squads account, token account, wallet, PDA without account, unknown
src/pack/model.ts                   ControllerPath, Statement, PackClaim, Unknown, PackPacket
src/pack/build.ts                   registry + recorded state → paths, statements, unknowns
src/pack/packet.ts                  JSON + HTML renderer (reuses the review packet CSS)
src/cli.ts                          new command: pack <pack.json> [--record|--offline] [--out dir]
fixtures/marinade-pack/*.json       recorded by Claude
tests/program-authority.test.ts  tests/classify.test.ts  tests/pack.test.ts
```

## 3. Tasks

### Task A1: Program upgrade authority reader

**Files:** create `src/chain/program-authority.ts`, `tests/program-authority.test.ts`.

- [ ] Write the failing test with a synthetic program account (4-byte tag 2 + programdata pubkey) and a synthetic programdata account (tag 3, u64 slot, option u8 = 1, 32-byte authority), stubbing `RecordingRpc.getAccountInfo` as in `tests/rpc.test.ts`; expect `{ programData, lastDeploySlot, upgradeAuthority, upgradeable: true }`; a second case with option 0 → `upgradeAuthority: null, upgradeable: false`; a third case where the program account is not owned by `BPFLoaderUpgradeab1e11111111111111111111111` → `{ kind: "not-upgradeable-loader" }`.
- [ ] Implement:

```ts
import { PublicKey } from "@solana/web3.js";
import type { RecordingRpc } from "./rpc";
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export type ProgramAuthority =
  | { kind: "upgradeable"; program: string; programData: string; lastDeploySlot: number; upgradeAuthority: string | null; upgradeable: boolean; slot: number | null; evidenceIds: string[] }
  | { kind: "not-upgradeable-loader" | "not-found"; program: string; owner: string | null; evidenceIds: string[] };
export async function readProgramAuthority(rpc: RecordingRpc, program: PublicKey): Promise<ProgramAuthority> {
  const p = await rpc.getAccountInfo(program);
  if (!p.value) return { kind: "not-found", program: program.toBase58(), owner: null, evidenceIds: [p.evidence.id] };
  if (!p.value.owner.equals(UPGRADEABLE_LOADER) || p.value.data.length < 36 || p.value.data.readUInt32LE(0) !== 2)
    return { kind: "not-upgradeable-loader", program: program.toBase58(), owner: p.value.owner.toBase58(), evidenceIds: [p.evidence.id] };
  const programData = new PublicKey(p.value.data.subarray(4, 36));
  const d = await rpc.getAccountInfo(programData);
  if (!d.value) return { kind: "not-found", program: program.toBase58(), owner: null, evidenceIds: [p.evidence.id, d.evidence.id] };
  const b = d.value.data; const has = b[12] === 1;
  return { kind: "upgradeable", program: program.toBase58(), programData: programData.toBase58(), lastDeploySlot: Number(b.readBigUInt64LE(4)), upgradeAuthority: has ? new PublicKey(b.subarray(13, 45)).toBase58() : null, upgradeable: has, slot: d.evidence.slot, evidenceIds: [p.evidence.id, d.evidence.id] };
}
```
- [ ] Run `bun test ./tests/program-authority.test.ts` → pass. Claude commits.

### Task A2: Authority classifier and state readers

**Files:** create `src/pack/classify.ts`, `tests/classify.test.ts`.

- [ ] `classifyAuthority(rpc, address, ctx)` returns one of: `dao-governance-account` (owner = the pack's governance program), `native-treasury-pda` (equals `getNativeTreasuryAddress(program, governance)` for a governance in `ctx.governances`), `squads-v4-account` (owner `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`), `squads-v3-account` (owner `SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu`), `token-account` (owner = SPL Token, 165 bytes; include mint, owner, amount), `wallet` (system-owned, on curve), `pda-no-account` (off curve, no account), `wallet-no-account`, `program-owned` (other owner; include owner). Always return `{ kind, address, onCurve, owner, evidenceIds }`.
- [ ] `readMintState(rpc, mint)` and `readTokenAccount(rpc, account)` wrap `parseMint`/`parseTokenAccount` with evidence ids and slot (reuse `src/chain/token-layout.ts`). `associatedTokenAccount(owner, mint)` derives the ATA (spl-token `getAssociatedTokenAddressSync`) so wallet-type registry accounts (the buyback accumulation wallet) get their MNDE balance read.
- [ ] `listGovernances(rpc, program, realm)`: use `getGovernanceAccounts(connection, program, Governance, [pubkeyFilter(1, realm)])` through the recorder (add a recorded `getProgramAccounts` wrapper to `RecordingRpc` mirroring the other methods; serialize account data base64), then derive each native treasury PDA. Expected on Marinade: at least `8z6A4q…` and `23xVZX…`. Classification covers every upgrade authority, every mint authority (including the council mint's `26Pw2q…`) and every registry account (token account, native treasury PDA, wallet, PDA without account).
- [ ] Tests with synthetic accounts for each classifier branch; a test that the governance list parser accepts the fixture shape (recorded by Claude in step A2.r).
- [ ] Run tests → pass. Claude records `fixtures/marinade-pack` with a temporary script `scripts/record-pack.ts` (reads the registry, calls readProgramAuthority for every program, classifyAuthority for every authority, readMintState for every mint, readTokenAccount for every account that is a token account, listGovernances for the realm), then commits.

### Task A3: Supply statement

**Files:** create `src/pack/supply.ts`, `tests/supply.test.ts`.

- [ ] `supplyStatement({ mint, claims, burns })` → `{ mint, supplyRaw, decimals, mintAuthority, freezeAuthority, capClaim: { text, source } | null, capStatus: "consistent" | "contradicted" | "unverifiable", knownBurns: [{ amountRaw, signature, slot, source }], impliedPreBurnSupplyRaw, note }`. For MNDE: supply 699,997,047.681352988 + burn 300,000,000 (MIP-14 receipt) → implied pre-burn 999,997,047.68 vs claimed cap 1,000,000,000: status `consistent (difference 2,952.32 MNDE unexplained; other burns not enumerated)`. Mint authority null → "no further issuance possible under the current mint state (verified at slot S)"; cap claim stays a claim.
- [ ] Test with the MNDE numbers; test the contradicted branch with a synthetic cap smaller than supply.

### Task A4: Pack model, builder, packet, CLI

**Files:** create `src/pack/model.ts`, `src/pack/build.ts`, `src/pack/packet.ts`; modify `src/cli.ts`; create `packs/marinade/pack.json`.

- [ ] Model:

```ts
export type Status = "verified" | "claimed" | "contradiction" | "unresolved" | "outside-scope";
export type ControllerPath = { subject: string; subjectKind: "program" | "mint" | "account"; role: string; authorityType: "upgrade" | "mint" | "freeze" | "owner" | "stake" | "config"; authority: string | null; authorityKind: string; path: string[]; status: Status; claims: { text: string; source: string }[]; evidenceIds: string[]; slot: number | null; note: string };
export type Statement = { id: string; topic: "supply" | "governance" | "treasury"; text: string; status: Status; evidenceIds: string[]; slot: number | null };
export type PackClaim = { id: string; text: string; source: string; retrievedAt: string; checkable: boolean; status: Status; note: string };
export type Unknown = { id: string; text: string; firstSeen: string };
export type PackPacket = { pack: string; title: string; generatedAt: string; offline: boolean; asOfSlotRange: [number, number]; researchQuestion: string; controllerPaths: ControllerPath[]; statements: Statement[]; claims: PackClaim[]; unknowns: Unknown[]; coverage: { total: number; verified: number; claimed: number; contradiction: number; unresolved: number }; evidenceCount: number };
```
- [ ] Builder rules: a program with upgrade authority classified `dao-governance-account` or `native-treasury-pda` → path `[program, authority, governance, realm]`, status `verified`; `squads-*` → path to the Squads account, status `verified` with note "multisig members not read"; `pda-no-account` → status `unresolved`, note "authority has no on-chain account; identity unknown"; `upgradeable: false` → statement "immutable program" `verified`. Claims attached to a subject: if the chain result agrees with every claim → `verified`; if claims disagree with each other or with the chain → `contradiction` with the chain result stated first. Treasury accounts: owner classification + balance statement. Council mint: supply and decimals statement vs the docs claim ("exactly 5, zero decimals").
- [ ] Packet HTML: header (realm, slot range, offline, evidence count), the research question, a controller table (subject · role · authority · kind · path · status · slot), statements, claims table (verbatim, source, retrieved, checkable, status), unknowns queue, coverage line. Reuse the review packet's CSS variables and light theme.
- [ ] CLI: `linchpin pack packs/marinade/pack.json [--record|--offline] [--out out/pack-marinade]` writes `packet.json`, `packet.html`, `evidence.jsonl`. `pack.json`: `{ "pack": "marinade", "registry": "packs/marinade/registry.json", "docsCapture": "packs/marinade/sources/marinade-docs-capture-2026-10-05.json", "title": "Marinade control and supply map" }`.
- [ ] Run offline against the recorded fixtures; paste the coverage line.

### Task A5: Contradictions and unknowns are first-class

- [ ] Encode the governance-page vs contract-page upgrade-authority claims per program from the registry; the builder marks each program's status from the chain result and keeps both claim texts visible.
- [ ] Unknowns: seed from the registry (`551FBX…` identity; SAM revenue accounts; page-layout ambiguity of the council labels) plus any `unresolved` path; each unknown has a `firstSeen` date.
- [ ] Tests: a synthetic program whose two claims disagree and whose chain authority is a DAO governance account → `contradiction` with note naming the agreeing claim.

### Task A6: Tests, README, review

- [ ] `bun test` all green; `bun run typecheck`; offline pack run.
- [ ] README: a "Protocol Pack (Slice A)" section: what it answers, what it does not (no flows yet), how to run offline.
- [ ] Claude reviews every controller path against the fixtures; zero wrong attributions is the gate for merging `protocol-pack` into `main` after Demo Day.

## 4. Acceptance (Slice A)

- Every row has evidence ids and a slot; the packet replays offline from `fixtures/marinade-pack`.
- Upgrade authorities of all ten registry programs classified; contradictions shown, not resolved by assumption.
- MNDE supply statement with the cap claim's status and the implied pre-burn supply.
- Council mint statement (expected: supply 5, decimals 0) verified or marked.
- Unknowns queue non-empty and honest.

## 5. Out of scope (Slice B/C)

Flow legs and the 30-day ledger; the `reward_fee` read from the liquid-staking state (anchor layout) is attempted only if a maintained layout is at hand, otherwise it stays a claim; VSR registrar parsing (record raw; parse later); labelling of unknown recipients; Neo4j/Cypher; LLM extraction.

## Log
- 2026-10-05 — Plan written by Claude after the Researcher Pack review and Peter's decisions; registry and docs capture committed to the `protocol-pack` branch. (Claude)
- 2026-10-05 — A1–A2 done (Codex; 77 tests), fixtures/marinade-pack recorded (59); Native proxy authority corrected to DAO-controlled (native treasury PDA). A3–A5 dispatched. (Claude)
