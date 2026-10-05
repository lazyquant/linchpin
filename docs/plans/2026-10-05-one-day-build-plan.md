---
tags: [project/quantrin-ledger, project/hackathon, hackathon, solana, governance, marinade, linchpin, build-plan, project/current]
date: 2026-10-05
updated: 2026-10-05
status: active
type: implementation-plan
related: ["[[Solana Governance Impact Graph — Marinade Hackathon Priority (Oct 2026)]]", "[[Quantrin Ledger — Scope, Stack and Build Plan (Oct 2026)]]", "[[Hackathon Home]]", "[[Submission Checklist]]"]
project: "[[Quantrin Project Home]]"
project_role: current
---

# Linchpin — One-Day Build Plan: Governance Review Demo (Oct 2026)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this project the implementing agent is **Codex**, dispatched task by task from Claude's session; Claude reviews between tasks (D-2026-10-04-3, D-2026-10-05-8).

**Goal:** By Tuesday 6 Oct 2026, 21:00 CEST, a CLI called `linchpin` turns one real Marinade Realms proposal (MIP-14 burn) into a reproducible review packet that keeps **claimed**, **decoded**, **simulated** and **observed** apart, shows the control path from treasury account to governance, runs offline from committed fixtures, and treats a signaling proposal (the MIP-14 opinion vote) as a clean "no executable payload" control. Demo Day is Wednesday 7 Oct, 14:00.

**Architecture:** One TypeScript package run with Bun. A recording RPC client turns every chain read into an evidence record and a replayable fixture. A governance reader parses raw SPL Governance accounts with `@solana/spl-governance`; a narrow SPL Token decoder turns instruction bytes into typed effects; a receipt module reconciles the finalized execution transaction with the decoded payload; a simulation module runs `simulateTransaction` as an explicitly labelled *conditional preview*; a packet module renders JSON plus a static HTML page with the graph path. No server, no database, no LLM in the loop.

**Tech Stack:** Bun 1.4.2 (runtime, test runner), TypeScript 5, `@solana/web3.js` 1.99.0, `@solana/spl-governance` 0.3.28, `@solana/spl-token` 0.4.15, `bs58` 6.0.0. Public mainnet RPC by default (`https://api.mainnet-beta.solana.com`); an optional Helius key only raises rate limits.

---

## 0. Decisions this plan implements (all by Peter, 2026-10-05 in chat with Claude)

| Decision | Content |
|---|---|
| D-2026-10-05-5 | First demo case: the **MIP-14 execution proposal**, full loop. Control: the **MIP-14 opinion proposal** (five options, no instructions). MIP-21 and BONK after Demo Day. |
| D-2026-10-05-6 | Hackathon slice stack: **TypeScript only** (Bun + web3.js 1.x + spl-governance + spl-token), static HTML packet. The Python/LangGraph core (D-2026-10-02-1, still proposed) returns for the capstone. |
| D-2026-10-05-7 | Name: **Linchpin**, "the dependency engine for protocol economics and tokenomics"; governance review is its first application. Repository `lazyquant/linchpin`, private, Apache-2.0; judges and `nicolepcx` added later. |
| D-2026-10-05-8 | Codex implements task by task through Claude's session; Claude reviews between tasks. Agentic OS is not used for the build. |

**Out of scope for this day:** MIP-21, BonkDAO, Neo4j, LangGraph, Python core, voting-power anomalies, any UI beyond a static HTML packet, program-upgrade analysis, arbitrary instruction decoding, a DAO crawler.

## 1. Facts the code can rely on (verified by Claude on public RPC, 2026-10-05, slots 453647619–453651973)

| Item | Value |
|---|---|
| Governance program (Marinade's own deployment) | `GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs`, logs `VERSION:"3.1.1"`, SDK program version **3** |
| Realm | `899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo` "Marinade DAO"; community mint `MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey` (9 decimals); council mint `6MGwpuJ5YE1c8jJaF8FKurQdDJeYRf1adX76dovkXxRs`; realm authority `FsrqQfLGdFVtySSSsyZJUzVBA9bvGZSKyhp7nsJCqgJe` |
| **Case A** proposal | `EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1` · name on chain `MIP-14: Burn 30% of MNDE Total Supply` · descriptionLink = forum thread 1909 · state 5 Completed · single option "Approve", voteResult 1, instructionsCount 1, instructionsExecutedCount 1 |
| Case A timeline (unix s, UTC) | draftAt 1756713988 (2025-09-01 08:06:28) · votingAt 1756713989 · votingCompletedAt 1757059589 (2025-09-05 08:06:29) · executingAt = closedAt 1757059783 (2025-09-05 08:09:43) |
| Case A votes (raw governing-token units) | Approve 36775169908704254 · deny 10129969187 · veto 0 · maxVoteWeight 999998206916761061 |
| Case A governance | `8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq`; governedAccount `CztPbF2e93qGyJxuY7Hs93wi32VxuR9cijeqMb11vcAb`; config baseVotingTime 259200, votingCoolOffTime 86400, minInstructionHoldUpTime 0, minCommunityTokensToCreateProposal 200000000000000 |
| Case A native treasury PDA | `B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG` = `getNativeTreasuryAddress(program, governance)`; off-curve, system-owned, 0.200051075 SOL. **It is the burn authority.** |
| Case A treasury token account | `GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi`; owner `B56RWQ…`; mint MNDE; balance **153600023536334850** raw at slot 453651973 |
| Case A proposal transaction | `FuEvwcsYVAPuubGaHDfLZBh6UjVDtiB3en5VUg7sUKjG` (option 0, index 0); holdUpTime 0; executedAt 1757059783; executionStatus 1 (Success); 1 instruction: program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, accounts [`GR1LBT…` w, `MNDE…` w, `B56RWQ…` signer], data hex **`0800009e1869d02904`** = Burn, amount **300000000000000000** raw = 300,000,000 MNDE |
| Case A execution receipt | signature `3w6j5Pc2yoEuK6BERjKxdZQaBvztk6ZantyhUSqz16qYbNsTWvpUkP38jrAm6bs2a94biXq4G8nBLtuERNnkWZkv`, slot 364780050, blockTime 1757059783, no error, fee 380000; top-level programs ComputeBudget ×2, governance `ExecuteTransaction`, then `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` (an assertion-guard program, not an economic effect, must appear as "unsupported program in the same transaction"); inner Token `Burn`; `GR1LBT…` pre **438930393.329018999** → post **138930393.329018999** MNDE (delta exactly −300,000,000); fee payer `3rL9kgavDB2rdAjSsX8Yz91tToiF7fhAHx3Qgn4JLGEk` |
| Current MNDE supply | 699997047681352988 raw at slot 453647619 (the forum claims 1,000,000,000 pre-burn; pre-burn supply is **not captured**) |
| **Case B** (control) proposal | `Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp` · name `MIP-14: Burn 0–50% of MNDE Total Supply` · multi-choice, 5 options (Burn 50 %, 40 %, 30 % ← winner voteResult 1, 20 %, No Burn), **instructionsCount 0 on every option** · governance `23xVZXQrHAZ4rm4nWKAM5eTLeUFmstbs42KF21PA4Ayo` · votingAt 1755780344 (2025-08-21), votingCompletedAt 1756125944 |
| Simulation, historical payload today | `VersionedTransaction` (legacy message), payer `B56RWQ…`, `sigVerify:false`, `replaceRecentBlockhash:true` → `InstructionError [0, {Custom: 1}]`, log `Error: insufficient funds` (balance 153.6 M < 300 M) |
| Simulation, labelled fixture (burn 1 MNDE = 1000000000 raw, same accounts) | success, 131 CU, post token balance 153600022536334850, post mint supply 699997046681352988 |
| Listing | `getProposalsByGovernance(conn, program, 8z6A4q…)` → 49 proposals in 133 ms on public RPC (so listing works without Helius) |

The read-only spike scripts that produced these numbers are committed in the repository under `scripts/spike/` (`spike.ts`, `sim.ts`); Tasks 1–6 move their logic into the package. Evidence discipline: every number above is "verified on chain 2026-10-05" except the pre-burn supply (forum claim, unverified).

## 2. Timeline (CEST)

| When | What | Who |
|---|---|---|
| Mon 5 Oct 20:00–23:00 | Tasks 0–3 (scaffold, evidence/RPC, reader, decoder) | Codex, Claude reviews |
| Tue 6 Oct 09:00–13:00 | Tasks 4–6 (effects, receipt, simulation) | Codex |
| Tue 13:00–14:00 | Peter: Helius key (optional), Demo Day registration, Marinade track opt-in | Peter |
| Tue 14:00–18:00 | Tasks 7–10 (claims, graph, packet, CLI + offline fixtures) | Codex |
| Tue 18:00–21:00 | Tasks 11–12 (control and failure cases, README, demo script); pitch draft | Codex, Claude, Peter |
| Wed 7 Oct 09:00–12:00 | Dry runs offline ×3, fixes only, rehearse to 3 minutes | Peter + Claude |
| Wed 14:00 | Demo Day | Peter |

**Division of labour (added 2026-10-05 20:20 CEST):** Codex's sandbox has no network and cannot write outside the repository, so Claude runs every step that installs packages or records live RPC fixtures (Task 0 setup; the `--record` steps of Tasks 2, 5, 6 and 10) and commits the results; Codex writes code and tests against the committed fixtures.

**Stop rule:** at 18:00 Tuesday, whatever is green is the demo. Fixtures captured in Task 10 make the demo independent of RPC and Wi-Fi.

## 3. File structure (repository `~/linchpin`, GitHub `lazyquant/linchpin`)

```
linchpin/
  package.json                 bun scripts: linchpin, test, typecheck, demo
  tsconfig.json
  README.md                    what it is, how to run, how to read a packet (Task 12)
  LICENSE                      Apache-2.0 (created with the repo)
  cases/
    mip-14.json                case A definition + claims
    mip-14-opinion.json        case B definition (control)
  fixtures/<case-id>/*.json    recorded RPC responses (committed in Task 10)
  out/                         generated packets (gitignored)
  src/
    cli.ts                     review | demo | doctor
    config.ts                  RPC url, offline flag, program id, paths
    chain/rpc.ts               RecordingRpc: evidence + record/replay around Connection
    chain/evidence.ts          Evidence type, sha256, canonical JSON
    chain/token-layout.ts      SPL Token account/mint byte layouts (no deps)
    governance/reader.ts       readProposalBundle(): realm, governance, proposal, transactions, treasury, token accounts, mints
    governance/decode.ts       decodeInstruction(): SPL Token legacy + Token-2022 same layouts; unknown → unsupported
    governance/effects.ts      effectsFromDecoded(): SupplyChange, TreasuryMovement, ControlChange, Unsupported
    governance/receipt.ts      findExecutionReceipt(), reconcileReceipt()
    governance/simulate.ts     simulateConditionalPreview(), fixtureBurn()
    governance/claims.ts       loadClaims(), coverage()
    graph/model.ts             Node, Edge, Basis types
    graph/build.ts             buildGraph(), mermaid(), controlPath()
    review/checks.ts           deterministic checks and the five separate dimensions
    review/packet.ts           buildPacket() JSON + renderHtml()
  tests/
    decode.test.ts  effects.test.ts  receipt.test.ts  simulate.test.ts  claims.test.ts  graph.test.ts  packet.test.ts  rpc.test.ts
  docs/
    plans/2026-10-05-one-day-build-plan.md   copy of this note
    demo-script.md                            the 3-minute flow (Task 12)
```

**Basis vocabulary (used everywhere, never collapsed):** `claimed` · `decoded` · `simulated` · `observed` · `unknown`.

## 4. Environment setup (once, on Peter's Mac)

```bash
cd ~/linchpin
bun init -y >/dev/null
bun add @solana/web3.js@1.99.0 @solana/spl-governance@0.3.28 @solana/spl-token@0.4.15 bs58@6.0.0
bun add -d typescript@5 @types/node@22 @types/bun
```

`package.json` scripts (replace the generated block):

```json
{
  "name": "linchpin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "linchpin": "bun run src/cli.ts",
    "demo": "bun run src/cli.ts demo --offline",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["bun-types", "node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore` additions: `out/`, `.env`, `*.local`.

Environment variables (optional): `LINCHPIN_RPC_URL` (default public mainnet), `LINCHPIN_OFFLINE=1` (same as `--offline`). Never commit a key.

---

## Task 0: Scaffold and smoke test

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (append), `src/config.ts`, `src/cli.ts` (stub)
- Create: `docs/plans/2026-10-05-one-day-build-plan.md` (copy of this note, exported by Claude)

- [ ] **Step 1: Run the environment setup from section 4** and commit the lockfile.

- [ ] **Step 2: Write `src/config.ts`**

```ts
import { PublicKey } from "@solana/web3.js";

export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const MARINADE_GOVERNANCE_PROGRAM = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs");
export const MARINADE_PROGRAM_VERSION = 3; // verified 2026-10-05: program logs VERSION:"3.1.1"

export type RunOptions = { rpcUrl: string; offline: boolean; record: boolean; outDir: string; fixturesDir: string };

export function runOptions(partial: Partial<RunOptions> = {}): RunOptions {
  return {
    rpcUrl: partial.rpcUrl ?? process.env.LINCHPIN_RPC_URL ?? DEFAULT_RPC_URL,
    offline: partial.offline ?? process.env.LINCHPIN_OFFLINE === "1",
    record: partial.record ?? false,
    outDir: partial.outDir ?? "out",
    fixturesDir: partial.fixturesDir ?? "fixtures",
  };
}
```

- [ ] **Step 3: Write a stub `src/cli.ts`** that prints usage for `review`, `demo`, `doctor` and exits 0. Run `bun run linchpin` and confirm the usage text prints.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold linchpin (bun, web3.js 1.99, spl-governance 0.3.28)"
```

---

## Task 1: Evidence records and a recording RPC client

**Files:**
- Create: `src/chain/evidence.ts`, `src/chain/rpc.ts`, `src/chain/token-layout.ts`
- Test: `tests/rpc.test.ts`

- [ ] **Step 1: Write `src/chain/evidence.ts`**

```ts
import { createHash } from "node:crypto";

export type Evidence = {
  id: string;            // sha256(method + canonical params + responseSha256)
  method: string;
  params: unknown;
  slot: number | null;   // context slot when the RPC returns one
  retrievedAt: string;   // ISO-8601 UTC
  rpcUrl: string;
  responseSha256: string;
  source: "rpc" | "fixture";
};

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString()
    : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v);
}

export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

export function fixtureKey(method: string, params: unknown): string {
  return `${method}-${sha256(canonical(params)).slice(0, 12)}`;
}
```

- [ ] **Step 2: Write `src/chain/token-layout.ts`** (SPL Token byte layouts, used by reader, effects and simulation)

```ts
import { PublicKey } from "@solana/web3.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export type TokenAccountState = { mint: string; owner: string; amountRaw: bigint };
export type MintState = { supplyRaw: bigint; decimals: number; mintAuthority: string | null; freezeAuthority: string | null };

export function parseTokenAccount(data: Uint8Array): TokenAccountState {
  const b = Buffer.from(data);
  if (b.length < 165) throw new Error(`token account too short: ${b.length}`);
  return { mint: new PublicKey(b.subarray(0, 32)).toBase58(), owner: new PublicKey(b.subarray(32, 64)).toBase58(), amountRaw: b.readBigUInt64LE(64) };
}

export function parseMint(data: Uint8Array): MintState {
  const b = Buffer.from(data);
  if (b.length < 82) throw new Error(`mint too short: ${b.length}`);
  const mintAuthority = b.readUInt32LE(0) === 1 ? new PublicKey(b.subarray(4, 36)).toBase58() : null;
  const freezeAuthority = b.readUInt32LE(46) === 1 ? new PublicKey(b.subarray(50, 82)).toBase58() : null;
  return { supplyRaw: b.readBigUInt64LE(36), decimals: b[44], mintAuthority, freezeAuthority };
}

export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n; const v = neg ? -raw : raw;
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
```

- [ ] **Step 3: Write `src/chain/rpc.ts`** (every read goes through here; `record` writes fixtures, `offline` reads them)

```ts
import { Connection, PublicKey, VersionedTransaction, type AccountInfo, type SimulateTransactionConfig, type SimulatedTransactionResponse, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, fixtureKey, sha256, type Evidence } from "./evidence";
import type { RunOptions } from "../config";

type Recorded<T> = { value: T; evidence: Evidence };

export class RecordingRpc {
  readonly connection: Connection;
  readonly evidence: Evidence[] = [];
  constructor(readonly opts: RunOptions, readonly caseId: string) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
  }
  private fixturePath(key: string) { return join(this.opts.fixturesDir, this.caseId, `${key}.json`); }

  /** Run one RPC call through evidence capture and record/replay. `serialize`/`revive` keep fixtures JSON-safe. */
  private async call<T>(method: string, params: unknown, live: () => Promise<{ value: T; slot: number | null }>, serialize: (v: T) => unknown, revive: (j: any) => T): Promise<Recorded<T>> {
    const key = fixtureKey(method, params);
    const path = this.fixturePath(key);
    if (this.opts.offline) {
      if (!existsSync(path)) throw new Error(`offline: fixture missing for ${method} → ${path}`);
      const fx = JSON.parse(readFileSync(path, "utf8"));
      const value = revive(fx.response);
      const evidence: Evidence = { id: sha256(`${method}${canonical(params)}${fx.responseSha256}`), method, params, slot: fx.slot, retrievedAt: fx.retrievedAt, rpcUrl: fx.rpcUrl, responseSha256: fx.responseSha256, source: "fixture" };
      this.evidence.push(evidence);
      return { value, evidence };
    }
    const { value, slot } = await live();
    const response = serialize(value);
    const responseSha256 = sha256(canonical(response));
    const retrievedAt = new Date().toISOString();
    const evidence: Evidence = { id: sha256(`${method}${canonical(params)}${responseSha256}`), method, params, slot, retrievedAt, rpcUrl: this.opts.rpcUrl, responseSha256, source: "rpc" };
    this.evidence.push(evidence);
    if (this.opts.record) {
      mkdirSync(join(this.opts.fixturesDir, this.caseId), { recursive: true });
      writeFileSync(path, JSON.stringify({ method, params, slot, retrievedAt, rpcUrl: this.opts.rpcUrl, responseSha256, response }, null, 1));
    }
    return { value, evidence };
  }

  getAccountInfo(pubkey: PublicKey): Promise<Recorded<AccountInfo<Buffer> | null>> {
    return this.call("getAccountInfo", { pubkey: pubkey.toBase58() },
      async () => { const r = await this.connection.getAccountInfoAndContext(pubkey); return { value: r.value, slot: r.context.slot }; },
      (v) => v && { ...v, owner: v.owner.toBase58(), data: v.data.toString("base64") },
      (j) => j && { ...j, owner: new PublicKey(j.owner), data: Buffer.from(j.data, "base64") });
  }

  getBalance(pubkey: PublicKey): Promise<Recorded<number>> {
    return this.call("getBalance", { pubkey: pubkey.toBase58() },
      async () => { const r = await this.connection.getBalanceAndContext(pubkey); return { value: r.value, slot: r.context.slot }; }, (v) => v, (j) => j);
  }

  getSignaturesForAddress(pubkey: PublicKey, limit = 50): Promise<Recorded<ConfirmedSignatureInfo[]>> {
    return this.call("getSignaturesForAddress", { pubkey: pubkey.toBase58(), limit },
      async () => ({ value: await this.connection.getSignaturesForAddress(pubkey, { limit }), slot: null }), (v) => v, (j) => j);
  }

  getTransaction(signature: string): Promise<Recorded<VersionedTransactionResponse | null>> {
    return this.call("getTransaction", { signature },
      async () => ({ value: await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }), slot: null }),
      (v) => v && JSON.parse(JSON.stringify(v)), (j) => j);  // fixtures keep the raw JSON shape; consumers only read meta/logs/balances
  }

  simulate(tx: VersionedTransaction, config: SimulateTransactionConfig): Promise<Recorded<SimulatedTransactionResponse>> {
    const message = Buffer.from(tx.message.serialize()).toString("base64");
    return this.call("simulateTransaction", { message, config: { ...config, accounts: config.accounts } },
      async () => { const r = await this.connection.simulateTransaction(tx, config); return { value: r.value, slot: r.context.slot }; }, (v) => v, (j) => j);
  }

  /** Append the evidence log for this run. */
  flushEvidence(outDir: string) {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, "evidence.jsonl");
    appendFileSync(path, this.evidence.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return path;
  }
}
```

- [ ] **Step 4: Write `tests/rpc.test.ts`** (record to a temp fixtures dir with a fake `live`, then replay offline and compare ids)

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { parseMint, parseTokenAccount, formatUnits } from "../src/chain/token-layout";

describe("RecordingRpc", () => {
  test("records a fixture and replays it offline with the same evidence id", async () => {
    const fixturesDir = mkdtempSync(join(tmpdir(), "linchpin-fx-"));
    const pk = new PublicKey("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi");
    const recorder = new RecordingRpc(runOptions({ record: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "t");
    // stub the live connection: a fake token account of 165 bytes
    const data = Buffer.alloc(165); data.writeBigUInt64LE(5n, 64);
    (recorder.connection as any).getAccountInfoAndContext = async () => ({ context: { slot: 42 }, value: { data, owner: pk, executable: false, lamports: 1, rentEpoch: 0 } });
    const live = await recorder.getAccountInfo(pk);
    expect(live.evidence.slot).toBe(42);
    const replayer = new RecordingRpc(runOptions({ offline: true, fixturesDir, rpcUrl: "http://127.0.0.1:1" }), "t");
    const replay = await replayer.getAccountInfo(pk);
    expect(replay.evidence.id).toBe(live.evidence.id);
    expect(replay.evidence.source).toBe("fixture");
    expect(parseTokenAccount(replay.value!.data).amountRaw).toBe(5n);
  });
  test("offline without a fixture fails loudly", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true, fixturesDir: mkdtempSync(join(tmpdir(), "linchpin-empty-")), rpcUrl: "http://127.0.0.1:1" }), "t");
    await expect(rpc.getBalance(new PublicKey("11111111111111111111111111111111"))).rejects.toThrow(/fixture missing/);
  });
});

describe("token layout", () => {
  test("parses mint supply and decimals; formats units", () => {
    const m = Buffer.alloc(82); m.writeUInt32LE(0, 0); m.writeBigUInt64LE(699997047681352988n, 36); m[44] = 9;
    const mint = parseMint(m);
    expect(mint.decimals).toBe(9);
    expect(formatUnits(mint.supplyRaw, 9)).toBe("699,997,047.681352988");
    expect(formatUnits(-300000000000000000n, 9)).toBe("-300,000,000");
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/rpc.test.ts`
Expected: 3 pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(chain): evidence records, recording/replaying RPC client, token layouts"
```

---

## Task 2: Governance reader (raw accounts → typed bundle with evidence)

**Files:**
- Create: `src/governance/reader.ts`
- Test: `tests/reader.test.ts` (runs live once to record `fixtures/mip-14/`, then offline; see Step 4)

- [ ] **Step 1: Write `src/governance/reader.ts`**

```ts
import { PublicKey } from "@solana/web3.js";
import { GovernanceAccountParser, Governance, Proposal, ProposalTransaction, Realm, getNativeTreasuryAddress, getProposalTransactionAddress, ProposalState, type ProgramAccount } from "@solana/spl-governance";
import type { RecordingRpc } from "../chain/rpc";
import { parseMint, parseTokenAccount, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, type MintState, type TokenAccountState } from "../chain/token-layout";

export type RawInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; dataHex: string };
export type ProposalTx = { address: string; optionIndex: number; index: number; holdUpTime: number; executedAt: number | null; executionStatus: number; instructions: RawInstruction[]; evidenceId: string };

export type ProposalBundle = {
  programId: string; programVersion: number;
  proposal: { address: string; name: string; descriptionLink: string; state: number; stateName: string; governance: string; governingTokenMint: string;
    options: { label: string; voteWeightRaw: string; voteResult: number; instructionsCount: number; instructionsExecutedCount: number }[];
    denyVoteWeightRaw: string | null; vetoVoteWeightRaw: string | null; draftAt: number | null; votingAt: number | null; votingCompletedAt: number | null; executingAt: number | null; closedAt: number | null; evidenceId: string };
  governance: { address: string; realm: string; governedAccount: string; nativeTreasury: string; baseVotingTime: number; votingCoolOffTime: number; minInstructionHoldUpTime: number; evidenceId: string };
  realm: { address: string; name: string; communityMint: string; councilMint: string | null; authority: string | null; evidenceId: string };
  transactions: ProposalTx[];
  tokenAccounts: Record<string, TokenAccountState & { slot: number | null; evidenceId: string }>;
  mints: Record<string, MintState & { slot: number | null; evidenceId: string }>;
};

const num = (v: any): number | null => (v == null ? null : Number(v.toString()));

export async function readProposalBundle(rpc: RecordingRpc, programId: PublicKey, programVersion: number, proposalPk: PublicKey): Promise<ProposalBundle> {
  const pInfo = await rpc.getAccountInfo(proposalPk);
  if (!pInfo.value) throw new Error(`proposal account not found: ${proposalPk.toBase58()}`);
  if (!pInfo.value.owner.equals(programId)) throw new Error(`proposal owner ${pInfo.value.owner.toBase58()} is not the expected governance program`);
  const proposal = GovernanceAccountParser(Proposal)(proposalPk, pInfo.value) as ProgramAccount<Proposal>;
  const a: any = proposal.account;

  const gInfo = await rpc.getAccountInfo(a.governance);
  if (!gInfo.value) throw new Error("governance account not found");
  const governance = GovernanceAccountParser(Governance)(a.governance, gInfo.value) as ProgramAccount<Governance>;
  const ga: any = governance.account;
  const rInfo = await rpc.getAccountInfo(ga.realm);
  if (!rInfo.value) throw new Error("realm account not found");
  const realm = GovernanceAccountParser(Realm)(ga.realm, rInfo.value) as ProgramAccount<Realm>;
  const ra: any = realm.account;
  const nativeTreasury = await getNativeTreasuryAddress(programId, a.governance);

  const transactions: ProposalTx[] = [];
  const options: any[] = a.options ?? [];
  for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
    const count = Number(options[optionIndex].instructionsCount ?? 0);
    for (let index = 0; index < count; index++) {
      const txPk = await getProposalTransactionAddress(programId, programVersion, proposalPk, optionIndex, index);
      const tInfo = await rpc.getAccountInfo(txPk);
      if (!tInfo.value) continue; // a missing transaction account stays visible as count > transactions.length
      const ptx = GovernanceAccountParser(ProposalTransaction)(txPk, tInfo.value) as ProgramAccount<ProposalTransaction>;
      const ta: any = ptx.account;
      transactions.push({ address: txPk.toBase58(), optionIndex, index, holdUpTime: Number(ta.holdUpTime), executedAt: num(ta.executedAt), executionStatus: Number(ta.executionStatus), evidenceId: tInfo.evidence.id,
        instructions: (ta.instructions ?? []).map((ix: any) => ({ programId: ix.programId.toBase58(), accounts: ix.accounts.map((m: any) => ({ pubkey: m.pubkey.toBase58(), isSigner: !!m.isSigner, isWritable: !!m.isWritable })), dataHex: Buffer.from(ix.data).toString("hex") })) });
    }
  }

  // Capture every token account and mint the instructions touch (owner → control edge; balance → share; decimals → units)
  const tokenAccounts: ProposalBundle["tokenAccounts"] = {}; const mints: ProposalBundle["mints"] = {};
  const touched = new Set<string>(transactions.flatMap((t) => t.instructions.flatMap((ix) => ix.accounts.map((m) => m.pubkey))));
  touched.add(a.governingTokenMint.toBase58());
  for (const addr of touched) {
    const info = await rpc.getAccountInfo(new PublicKey(addr));
    if (!info.value) continue;
    const owner = info.value.owner;
    if (!(owner.equals(TOKEN_PROGRAM) || owner.equals(TOKEN_2022_PROGRAM))) continue;
    if (info.value.data.length >= 165) tokenAccounts[addr] = { ...parseTokenAccount(info.value.data), slot: info.evidence.slot, evidenceId: info.evidence.id };
    else if (info.value.data.length >= 82) mints[addr] = { ...parseMint(info.value.data), slot: info.evidence.slot, evidenceId: info.evidence.id };
  }

  return {
    programId: programId.toBase58(), programVersion,
    proposal: { address: proposalPk.toBase58(), name: a.name, descriptionLink: a.descriptionLink, state: Number(a.state), stateName: ProposalState[a.state], governance: a.governance.toBase58(), governingTokenMint: a.governingTokenMint.toBase58(),
      options: options.map((o: any) => ({ label: o.label, voteWeightRaw: o.voteWeight.toString(), voteResult: Number(o.voteResult), instructionsCount: Number(o.instructionsCount), instructionsExecutedCount: Number(o.instructionsExecutedCount) })),
      denyVoteWeightRaw: a.denyVoteWeight?.toString() ?? null, vetoVoteWeightRaw: a.vetoVoteWeight?.toString() ?? null,
      draftAt: num(a.draftAt), votingAt: num(a.votingAt), votingCompletedAt: num(a.votingCompletedAt), executingAt: num(a.executingAt), closedAt: num(a.closedAt), evidenceId: pInfo.evidence.id },
    governance: { address: a.governance.toBase58(), realm: ga.realm.toBase58(), governedAccount: ga.governedAccount.toBase58(), nativeTreasury: nativeTreasury.toBase58(), baseVotingTime: Number(ga.config.baseVotingTime), votingCoolOffTime: Number(ga.config.votingCoolOffTime), minInstructionHoldUpTime: Number(ga.config.minInstructionHoldUpTime), evidenceId: gInfo.evidence.id },
    realm: { address: ga.realm.toBase58(), name: ra.name, communityMint: ra.communityMint.toBase58(), councilMint: ra.config?.councilMint?.toBase58() ?? null, authority: ra.authority?.toBase58() ?? null, evidenceId: rInfo.evidence.id },
    transactions, tokenAccounts, mints,
  };
}
```

- [ ] **Step 2: Write `tests/reader.test.ts`** (offline against `fixtures/mip-14`; the fixtures are recorded in Step 3)

```ts
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";

const MIP14 = new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");

describe("readProposalBundle (offline fixtures)", () => {
  test("MIP-14: one burn instruction, treasury owned by the governance's native treasury", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, MIP14);
    expect(b.proposal.name).toBe("MIP-14: Burn 30% of MNDE Total Supply");
    expect(b.proposal.stateName).toBe("Completed");
    expect(b.realm.name).toBe("Marinade DAO");
    expect(b.governance.nativeTreasury).toBe("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
    expect(b.transactions).toHaveLength(1);
    const ix = b.transactions[0].instructions[0];
    expect(ix.programId).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(ix.dataHex).toBe("0800009e1869d02904");
    expect(b.tokenAccounts["GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi"].owner).toBe(b.governance.nativeTreasury);
    expect(b.mints["MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"].decimals).toBe(9);
  });
});
```

- [ ] **Step 3: Record the fixtures once, live** (temporary script `scripts/record.ts`; the CLI replaces it in Task 10)

```ts
// scripts/record.ts
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
const [caseId, proposal] = process.argv.slice(2);
const rpc = new RecordingRpc(runOptions({ record: true }), caseId);
const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
console.log(JSON.stringify({ name: b.proposal.name, transactions: b.transactions.length, evidence: rpc.evidence.length }, null, 1));
```

Run:
```bash
bun run scripts/record.ts mip-14 EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1
bun run scripts/record.ts mip-14-opinion Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp
```
Expected: `transactions: 1` for mip-14 and `transactions: 0` for mip-14-opinion; `fixtures/mip-14/*.json` appear.

- [ ] **Step 4: Run the test offline**

Run: `bun test tests/reader.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Commit** (fixtures included; they are public chain data)

```bash
git add -A && git commit -m "feat(governance): reader for realm, governance, proposal, transactions, treasury accounts with evidence"
```

---

## Task 3: SPL Token instruction decoder

**Files:**
- Create: `src/governance/decode.ts`
- Test: `tests/decode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { decodeInstruction } from "../src/governance/decode";
const acc = (pubkey: string, isSigner = false, isWritable = true) => ({ pubkey, isSigner, isWritable });

describe("decodeInstruction", () => {
  test("MIP-14 burn: discriminator 8, amount 3e17 raw", () => {
    const d = decodeInstruction({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "0800009e1869d02904", accounts: [acc("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi"), acc("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"), acc("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG", true, false)] });
    expect(d.kind).toBe("burn");
    if (d.kind !== "burn") throw new Error();
    expect(d.amountRaw).toBe(300000000000000000n);
    expect(d.source).toBe("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi");
    expect(d.mint).toBe("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey");
    expect(d.authority).toBe("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
    expect(d.decoderVersion).toBe("spl-token-legacy@1");
  });
  test("transferChecked: amount then decimals", () => {
    const d = decodeInstruction({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "0c" + "e803000000000000" + "06", accounts: [acc("S"), acc("M"), acc("D"), acc("A", true)] });
    expect(d).toMatchObject({ kind: "transfer", amountRaw: 1000n, decimals: 6, source: "S", mint: "M", destination: "D", authority: "A" });
  });
  test("setAuthority is a control change", () => {
    const d = decodeInstruction({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "06" + "00" + "01" + "11".repeat(32), accounts: [acc("M"), acc("A", true)] });
    expect(d).toMatchObject({ kind: "setAuthority", authorityType: "mintTokens", target: "M", currentAuthority: "A" });
  });
  test("unknown program stays unsupported, never guessed", () => {
    const d = decodeInstruction({ programId: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", dataHex: "00", accounts: [] });
    expect(d.kind).toBe("unsupported");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/decode.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write `src/governance/decode.ts`**

```ts
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../chain/token-layout";
import type { RawInstruction } from "./reader";

export const DECODER_VERSION = "spl-token-legacy@1";
export type Decoded =
  | { kind: "burn"; program: string; amountRaw: bigint; decimals: number | null; source: string; mint: string; authority: string; decoderVersion: string }
  | { kind: "transfer"; program: string; amountRaw: bigint; decimals: number | null; source: string; mint: string | null; destination: string; authority: string; decoderVersion: string }
  | { kind: "mintTo"; program: string; amountRaw: bigint; decimals: number | null; mint: string; destination: string; authority: string; decoderVersion: string }
  | { kind: "setAuthority"; program: string; authorityType: string; target: string; currentAuthority: string; newAuthority: string | null; decoderVersion: string }
  | { kind: "unsupported"; program: string; reason: string; dataHex: string; decoderVersion: string };

const AUTHORITY_TYPES = ["mintTokens", "freezeAccount", "accountOwner", "closeAccount"];
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);

export function decodeInstruction(ix: RawInstruction): Decoded {
  const program = ix.programId;
  const isToken = program === TOKEN_PROGRAM.toBase58() || program === TOKEN_2022_PROGRAM.toBase58();
  const data = Buffer.from(ix.dataHex, "hex");
  const a = (i: number) => ix.accounts[i]?.pubkey ?? "";
  if (!isToken) return { kind: "unsupported", program, reason: "program not supported by this decoder", dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  if (data.length < 1) return { kind: "unsupported", program, reason: "empty data", dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  const tag = data[0];
  try {
    switch (tag) {
      case 3: return { kind: "transfer", program, amountRaw: u64(data, 1), decimals: null, source: a(0), mint: null, destination: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 12: return { kind: "transfer", program, amountRaw: u64(data, 1), decimals: data[9], source: a(0), mint: a(1), destination: a(2), authority: a(3), decoderVersion: DECODER_VERSION };
      case 8: return { kind: "burn", program, amountRaw: u64(data, 1), decimals: null, source: a(0), mint: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 15: return { kind: "burn", program, amountRaw: u64(data, 1), decimals: data[9], source: a(0), mint: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 7: return { kind: "mintTo", program, amountRaw: u64(data, 1), decimals: null, mint: a(0), destination: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 14: return { kind: "mintTo", program, amountRaw: u64(data, 1), decimals: data[9], mint: a(0), destination: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 6: {
        const authorityType = AUTHORITY_TYPES[data[1]] ?? `type:${data[1]}`;
        const newAuthority = data[2] === 1 ? new PublicKey(data.subarray(3, 35)).toBase58() : null;
        return { kind: "setAuthority", program, authorityType, target: a(0), currentAuthority: a(1), newAuthority, decoderVersion: DECODER_VERSION };
      }
      default: return { kind: "unsupported", program, reason: `token instruction ${tag} not supported`, dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
    }
  } catch (e) {
    return { kind: "unsupported", program, reason: `malformed data: ${(e as Error).message}`, dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  }
}
```

- [ ] **Step 4: Run the tests** → `bun test tests/decode.test.ts` → 4 pass.

- [ ] **Step 5: Commit** → `git commit -am "feat(governance): narrow SPL Token decoder (burn, transfer, mintTo, setAuthority; unknown stays unsupported)"`

---

## Task 4: Effects from decoded instructions and captured state

**Files:**
- Create: `src/governance/effects.ts`
- Test: `tests/effects.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { effectsFromDecoded } from "../src/governance/effects";

describe("effectsFromDecoded", () => {
  const state = { tokenAccounts: { GR: { mint: "MNDE", owner: "B56", amountRaw: 153600023536334850n, slot: 453651973, evidenceId: "e-ta" } }, mints: { MNDE: { supplyRaw: 699997047681352988n, decimals: 9, mintAuthority: null, freezeAuthority: null, slot: 453651973, evidenceId: "e-mint" } } };
  test("burn → supply change and treasury movement with exact units and dated shares", () => {
    const fx = effectsFromDecoded([{ kind: "burn", program: "Tok", amountRaw: 300000000000000000n, decimals: null, source: "GR", mint: "MNDE", authority: "B56", decoderVersion: "v" }], state, { nativeTreasury: "B56" });
    const supply = fx.find((e) => e.type === "supplyChange")!; const move = fx.find((e) => e.type === "treasuryMovement")!;
    expect(supply.basis).toBe("decoded");
    expect(supply.detail).toMatchObject({ mint: "MNDE", deltaRaw: "-300000000000000000", display: "-300,000,000", shareOfSupplyAtCapture: "42.8573%" });
    expect(move.detail).toMatchObject({ asset: "MNDE", amountDisplay: "300,000,000", source: "GR", destination: null, sourceOwner: "B56", sourceIsGovernanceTreasury: true, shareOfSourceBalanceAtCapture: "195.3125%" });
    expect(move.flags).toContain("exceeds-current-balance");
  });
  test("unsupported stays an explicit unknown effect", () => {
    const fx = effectsFromDecoded([{ kind: "unsupported", program: "X", reason: "r", dataHex: "00", decoderVersion: "v" }], state, { nativeTreasury: "B56" });
    expect(fx[0]).toMatchObject({ type: "unknown", basis: "unknown" });
  });
});
```

- [ ] **Step 2: Write `src/governance/effects.ts`**

```ts
import { formatUnits } from "../chain/token-layout";
import type { Decoded } from "./decode";
import type { ProposalBundle } from "./reader";

export type Basis = "claimed" | "decoded" | "simulated" | "observed" | "unknown";
export type Effect = { id: string; type: "supplyChange" | "treasuryMovement" | "controlChange" | "mint" | "unknown"; basis: Basis; detail: Record<string, unknown>; flags: string[]; evidenceIds: string[] };

const pct = (num: bigint, den: bigint) => den === 0n ? "n/a" : `${(Number((num * 1_000_000n) / den) / 10_000).toFixed(4)}%`;

export function effectsFromDecoded(decoded: Decoded[], state: Pick<ProposalBundle, "tokenAccounts" | "mints">, ctx: { nativeTreasury: string }): Effect[] {
  const out: Effect[] = [];
  decoded.forEach((d, i) => {
    const id = `fx-${i}`;
    if (d.kind === "unsupported") { out.push({ id, type: "unknown", basis: "unknown", detail: { program: d.program, reason: d.reason, dataHex: d.dataHex }, flags: ["unsupported-instruction"], evidenceIds: [] }); return; }
    if (d.kind === "setAuthority") { out.push({ id, type: "controlChange", basis: "decoded", detail: { target: d.target, authorityType: d.authorityType, from: d.currentAuthority, to: d.newAuthority }, flags: ["control-change"], evidenceIds: [] }); return; }
    const mintAddr = d.kind === "transfer" ? (d.mint ?? state.tokenAccounts[d.source]?.mint ?? null) : d.mint;
    const mint = mintAddr ? state.mints[mintAddr] : undefined;
    const decimals = d.decimals ?? mint?.decimals ?? null;
    const display = decimals == null ? `${d.amountRaw} raw (decimals unknown)` : formatUnits(d.amountRaw, decimals);
    const evidenceIds = [mint?.evidenceId, state.tokenAccounts[(d as any).source]?.evidenceId].filter(Boolean) as string[];
    if (d.kind === "burn" || d.kind === "mintTo") {
      const delta = d.kind === "burn" ? -d.amountRaw : d.amountRaw;
      out.push({ id: `${id}-supply`, type: d.kind === "burn" ? "supplyChange" : "mint", basis: "decoded", flags: [], evidenceIds,
        detail: { mint: mintAddr, deltaRaw: delta.toString(), display: decimals == null ? `${delta} raw` : formatUnits(delta, decimals), shareOfSupplyAtCapture: mint ? pct(d.amountRaw, mint.supplyRaw) : "unknown", supplyAtCaptureRaw: mint?.supplyRaw.toString() ?? null, captureSlot: mint?.slot ?? null, note: "share uses the supply captured at the given slot, not the pre-execution supply" } });
    }
    if (d.kind === "burn" || d.kind === "transfer") {
      const src = state.tokenAccounts[d.source];
      const flags: string[] = [];
      if (src && d.amountRaw > src.amountRaw) flags.push("exceeds-current-balance");
      if (d.kind === "transfer" && !state.tokenAccounts[d.destination]) flags.push("destination-not-captured");
      out.push({ id: `${id}-move`, type: "treasuryMovement", basis: "decoded", flags, evidenceIds,
        detail: { asset: mintAddr, amountRaw: d.amountRaw.toString(), amountDisplay: display, source: d.source, destination: d.kind === "transfer" ? d.destination : null, sourceOwner: src?.owner ?? null, sourceIsGovernanceTreasury: src?.owner === ctx.nativeTreasury, sourceBalanceAtCaptureRaw: src?.amountRaw.toString() ?? null, shareOfSourceBalanceAtCapture: src ? pct(d.amountRaw, src.amountRaw) : "unknown", captureSlot: src?.slot ?? null } });
    }
  });
  return out;
}
```

- [ ] **Step 3: Run** `bun test tests/effects.test.ts` → 2 pass. (If the percentage strings differ in the last digit, fix the test to the computed value and note it in the commit; the arithmetic is integer-based.)

- [ ] **Step 4: Commit** → `git commit -am "feat(governance): typed effects with exact units, dated shares and explicit unknowns"`

---

## Task 5: Execution receipt and reconciliation (observed basis)

**Files:**
- Create: `src/governance/receipt.ts`
- Test: `tests/receipt.test.ts` (uses `fixtures/mip-14/getTransaction-*.json` recorded in Step 3)

- [ ] **Step 1: Write `src/governance/receipt.ts`**

```ts
import { PublicKey } from "@solana/web3.js";
import type { RecordingRpc } from "../chain/rpc";
import type { Decoded } from "./decode";
import type { ProposalTx } from "./reader";

export type Receipt = { signature: string; slot: number; blockTime: number | null; success: boolean; programsInvoked: string[]; innerPrograms: string[]; governanceExecuteLogged: boolean; tokenBalances: { account: string; mint: string; owner: string | null; preRaw: string; postRaw: string; deltaRaw: string }[]; logs: string[]; evidenceIds: string[] };
export type Reconciliation = { status: "matched" | "mismatch" | "not-executed" | "receipt-not-found"; expectedDeltaRaw: string | null; observedDeltaRaw: string | null; account: string | null; notes: string[] };

const key = (tx: any, i: number): string => { const k = tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys; const list = [...(k ?? []).map((x: any) => (typeof x === "string" ? x : x.pubkey ?? x)), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])]; return String(list[i]); };

export async function findExecutionReceipt(rpc: RecordingRpc, ptx: ProposalTx): Promise<Receipt | null> {
  if (ptx.executedAt == null) return null;
  const sigs = await rpc.getSignaturesForAddress(new PublicKey(ptx.address), 50);
  const candidates = sigs.value.filter((s) => !s.err && s.blockTime != null && s.blockTime >= ptx.executedAt! - 5 && s.blockTime <= ptx.executedAt! + 5).sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  for (const c of candidates) {
    const tx = await rpc.getTransaction(c.signature);
    const t: any = tx.value; if (!t) continue;
    const logs: string[] = t.meta?.logMessages ?? [];
    const governanceExecuteLogged = logs.some((l) => l.includes("GOVERNANCE-INSTRUCTION: ExecuteTransaction"));
    if (!governanceExecuteLogged) continue;
    const top = (t.transaction.message.compiledInstructions ?? t.transaction.message.instructions ?? []).map((ci: any) => key(t, ci.programIdIndex));
    const inner = (t.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions.map((x: any) => key(t, x.programIdIndex)));
    const pre: any[] = t.meta?.preTokenBalances ?? []; const post: any[] = t.meta?.postTokenBalances ?? [];
    const tokenBalances = pre.map((p) => { const q = post.find((x) => x.accountIndex === p.accountIndex); const preRaw = BigInt(p.uiTokenAmount.amount); const postRaw = BigInt(q?.uiTokenAmount.amount ?? "0"); return { account: key(t, p.accountIndex), mint: p.mint, owner: p.owner ?? null, preRaw: preRaw.toString(), postRaw: postRaw.toString(), deltaRaw: (postRaw - preRaw).toString() }; });
    return { signature: c.signature, slot: t.slot, blockTime: t.blockTime ?? null, success: t.meta?.err == null, programsInvoked: [...new Set(top)], innerPrograms: [...new Set(inner)], governanceExecuteLogged, tokenBalances, logs: logs.slice(0, 60), evidenceIds: [sigs.evidence.id, tx.evidence.id] };
  }
  return null;
}

export function reconcileReceipt(decoded: Decoded[], ptx: ProposalTx, receipt: Receipt | null): Reconciliation {
  if (ptx.executedAt == null) return { status: "not-executed", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["proposal transaction has no executedAt; nothing to observe"] };
  if (!receipt) return { status: "receipt-not-found", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transaction with GOVERNANCE-INSTRUCTION: ExecuteTransaction found near executedAt"] };
  const d = decoded.find((x) => x.kind === "burn" || x.kind === "transfer");
  if (!d || (d.kind !== "burn" && d.kind !== "transfer")) return { status: "mismatch", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no decoded token movement to reconcile"] };
  const expected = -d.amountRaw;
  const row = receipt.tokenBalances.find((b) => b.account === d.source);
  const notes: string[] = [];
  if (!receipt.success) notes.push("execution transaction failed on chain");
  if (!row) return { status: "mismatch", expectedDeltaRaw: expected.toString(), observedDeltaRaw: null, account: d.source, notes: [...notes, "source account has no token balance change in the receipt"] };
  const matched = receipt.success && BigInt(row.deltaRaw) === expected && receipt.innerPrograms.includes(d.program);
  const extras = receipt.programsInvoked.filter((p) => !["ComputeBudget111111111111111111111111111111"].includes(p) && p !== d.program && !p.startsWith("GovMaiH") && !p.startsWith("GovER5"));
  if (extras.length) notes.push(`other programs in the same transaction (not economic effects, kept visible): ${extras.join(", ")}`);
  return { status: matched ? "matched" : "mismatch", expectedDeltaRaw: expected.toString(), observedDeltaRaw: row.deltaRaw, account: d.source, notes };
}
```

- [ ] **Step 2: Write `tests/receipt.test.ts`** (offline)

```ts
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { findExecutionReceipt, reconcileReceipt } from "../src/governance/receipt";

describe("MIP-14 receipt (offline fixtures)", () => {
  test("finds the ExecuteTransaction receipt and reconciles exactly -300,000,000 MNDE", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1"));
    const ptx = b.transactions[0];
    const receipt = await findExecutionReceipt(rpc, ptx);
    expect(receipt?.signature).toBe("3w6j5Pc2yoEuK6BERjKxdZQaBvztk6ZantyhUSqz16qYbNsTWvpUkP38jrAm6bs2a94biXq4G8nBLtuERNnkWZkv");
    expect(receipt?.slot).toBe(364780050);
    expect(receipt?.innerPrograms).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const rec = reconcileReceipt(ptx.instructions.map(decodeInstruction), ptx, receipt);
    expect(rec.status).toBe("matched");
    expect(rec.observedDeltaRaw).toBe("-300000000000000000");
    expect(rec.notes.join(" ")).toContain("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  });
});
```

- [ ] **Step 3: Record the receipt fixtures live** (extend `scripts/record.ts` to call `findExecutionReceipt` for every transaction with `executedAt`), run it for `mip-14`, then run `bun test tests/receipt.test.ts` → 1 pass. If the account-key helper returns `undefined` for the treasury account, print `Object.keys(tx.transaction.message)` from the fixture and adjust `key()` to the recorded shape; the fixture is the contract.

- [ ] **Step 4: Commit** → `git commit -am "feat(governance): execution receipt lookup and exact reconciliation (observed basis)"`

---

## Task 6: Simulation as a labelled conditional preview

**Files:**
- Create: `src/governance/simulate.ts`
- Test: `tests/simulate.test.ts`

- [ ] **Step 1: Write `src/governance/simulate.ts`**

```ts
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createBurnInstruction } from "@solana/spl-token";
import type { RecordingRpc } from "../chain/rpc";
import { sha256 } from "../chain/evidence";
import { parseMint, parseTokenAccount, TOKEN_PROGRAM } from "../chain/token-layout";
import type { RawInstruction } from "./reader";

export type SimulationRun = {
  id: string; kind: "historical-payload" | "fixture"; mode: "conditional-preview"; label: string;
  assumptions: string[]; feePayer: string; config: { sigVerify: false; replaceRecentBlockhash: true; commitment: "confirmed" };
  messageSha256: string; contextSlot: number | null; success: boolean; error: unknown; unitsConsumed: number | null; logs: string[];
  postState: { tokenAccounts: Record<string, string>; mintSupplies: Record<string, string> }; evidenceIds: string[];
};

export function toTransactionInstruction(ix: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.dataHex, "hex") });
}

/** A fixture that reuses the proposal's accounts but burns one whole token (10^decimals raw). Always labelled; never confused with the payload. */
export function fixtureBurn(source: PublicKey, mint: PublicKey, authority: PublicKey, decimals: number): TransactionInstruction {
  return createBurnInstruction(source, mint, authority, 10n ** BigInt(decimals), [], TOKEN_PROGRAM);
}

export async function simulateConditionalPreview(rpc: RecordingRpc, args: { kind: SimulationRun["kind"]; label: string; instructions: TransactionInstruction[]; feePayer: PublicKey; watch: { tokenAccounts: PublicKey[]; mints: PublicKey[] }; assumptions: string[] }): Promise<SimulationRun> {
  const message = new TransactionMessage({ payerKey: args.feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: args.instructions }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  const addresses = [...args.watch.tokenAccounts, ...args.watch.mints].map((p) => p.toBase58());
  const config = { sigVerify: false as const, replaceRecentBlockhash: true as const, commitment: "confirmed" as const, accounts: { encoding: "base64" as const, addresses } };
  const res = await rpc.simulate(tx, config);
  const v: any = res.value;
  const postState = { tokenAccounts: {} as Record<string, string>, mintSupplies: {} as Record<string, string> };
  (v.accounts ?? []).forEach((acct: any, i: number) => {
    if (!acct?.data?.[0]) return;
    const data = Buffer.from(acct.data[0], "base64"); const addr = addresses[i];
    if (i < args.watch.tokenAccounts.length) postState.tokenAccounts[addr] = parseTokenAccount(data).amountRaw.toString();
    else postState.mintSupplies[addr] = parseMint(data).supplyRaw.toString();
  });
  const messageSha256 = sha256(Buffer.from(message.serialize()));
  return { id: `sim-${messageSha256.slice(0, 12)}`, kind: args.kind, mode: "conditional-preview", label: args.label, assumptions: args.assumptions, feePayer: args.feePayer.toBase58(), config: { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }, messageSha256, contextSlot: res.evidence.slot, success: v.err == null, error: v.err ?? null, unitsConsumed: v.unitsConsumed ?? null, logs: v.logs ?? [], postState, evidenceIds: [res.evidence.id] };
}

export const PREVIEW_ASSUMPTIONS = [
  "signature verification disabled (sigVerify=false): the governance native-treasury PDA is marked as signer, which an ordinary transaction cannot do",
  "the recent blockhash is replaced by the RPC node; the run is not submittable",
  "state is the cluster's current state at contextSlot, not the pre-execution state of the historical proposal",
  "a successful preview does not prove that governance currently permits execution or that a vote has passed",
];
```

- [ ] **Step 2: Write `tests/simulate.test.ts`** (offline, fixtures recorded in Step 3; two runs with known outcomes)

```ts
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { fixtureBurn, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS } from "../src/governance/simulate";

const GR = new PublicKey("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi"), MNDE = new PublicKey("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"), B56 = new PublicKey("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
const payload = { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "0800009e1869d02904", accounts: [{ pubkey: GR.toBase58(), isSigner: false, isWritable: true }, { pubkey: MNDE.toBase58(), isSigner: false, isWritable: true }, { pubkey: B56.toBase58(), isSigner: true, isWritable: false }] };

describe("conditional preview (offline fixtures)", () => {
  test("historical payload fails today with insufficient funds and says so", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const run = await simulateConditionalPreview(rpc, { kind: "historical-payload", label: "MIP-14 payload against current state", instructions: [toTransactionInstruction(payload)], feePayer: B56, watch: { tokenAccounts: [GR], mints: [MNDE] }, assumptions: PREVIEW_ASSUMPTIONS });
    expect(run.success).toBe(false);
    expect(JSON.stringify(run.error)).toContain("Custom");
    expect(run.logs.join("\n")).toContain("insufficient funds");
  });
  test("labelled fixture burn of 1 MNDE succeeds and reports post state", async () => {
    const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
    const run = await simulateConditionalPreview(rpc, { kind: "fixture", label: "fixture: burn 1 MNDE from the same treasury account", instructions: [fixtureBurn(GR, MNDE, B56, 9)], feePayer: B56, watch: { tokenAccounts: [GR], mints: [MNDE] }, assumptions: PREVIEW_ASSUMPTIONS });
    expect(run.success).toBe(true);
    expect(BigInt(run.postState.tokenAccounts[GR.toBase58()])).toBeGreaterThan(0n);
    expect(run.kind).toBe("fixture");
  });
});
```

- [ ] **Step 3: Record both simulations live** (extend `scripts/record.ts`: after the receipt, run the two previews with `record: true`), then `bun test tests/simulate.test.ts` → 2 pass. Note: the fee payer must hold lamports; `B56RWQ…` holds 0.2 SOL (verified). If the fixture ever fails with a fee-payer error, use `getBalance` to pick the first funded of [native treasury, governance].

- [ ] **Step 4: Commit** → `git commit -am "feat(governance): conditional-preview simulation with explicit assumptions; historical payload vs labelled fixture"`

---

## Task 7: Claims and coverage (claimed basis)

**Files:**
- Create: `cases/mip-14.json`, `cases/mip-14-opinion.json`, `src/governance/claims.ts`
- Test: `tests/claims.test.ts`

- [ ] **Step 1: Write `cases/mip-14.json`** (claims only from captured text; the forum quote must be copied verbatim from the first post of thread 1909 with the retrieval time; if the page cannot be fetched, keep only the on-chain names)

```json
{
  "caseId": "mip-14",
  "title": "Marinade MIP-14 execution proposal: burn 300,000,000 MNDE",
  "programId": "GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs",
  "programVersion": 3,
  "proposal": "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1",
  "relatedProposals": [{ "role": "signaling (opinion vote)", "address": "Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp" }],
  "claims": [
    { "id": "c1", "text": "MIP-14: Burn 30% of MNDE Total Supply", "source": "on-chain proposal name", "sourceRef": "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1", "retrievedAt": "2026-10-05", "kind": "percentOfSupply", "percent": 30 },
    { "id": "c2", "text": "MIP-14: Burn 0–50% of MNDE Total Supply", "source": "on-chain name of the signaling proposal", "sourceRef": "Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp", "retrievedAt": "2026-10-05", "kind": "range" },
    { "id": "c3", "text": "<verbatim sentence from the forum first post that states the amount or percentage>", "source": "forum", "sourceRef": "https://forum.marinade.finance/t/mip-14-burn-5-50-of-mnde-total-supply/1909", "retrievedAt": "<ISO time when Codex copied it>", "kind": "amount", "amountDisplay": "<as written>" }
  ],
  "fixture": { "burnOneToken": true },
  "notes": ["Pre-burn total supply is a forum claim (1,000,000,000 MNDE) and is not captured on chain in this slice."]
}
```

`cases/mip-14-opinion.json`: same shape with `proposal` = `Cxzr7L…`, `claims` = the c2 line only, `"fixture": { "burnOneToken": false }`.

- [ ] **Step 2: Write the failing test `tests/claims.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { coverage } from "../src/governance/claims";
const burn = { id: "fx-0-supply", type: "supplyChange" as const, basis: "decoded" as const, flags: [], evidenceIds: [], detail: { mint: "MNDE", deltaRaw: "-300000000000000000", display: "-300,000,000", shareOfSupplyAtCapture: "42.8573%" } };
describe("coverage", () => {
  test("a 30% claim is covered by a 300M burn only under the claimed 1B pre-burn supply, and that is said", () => {
    const c = coverage([{ id: "c1", text: "Burn 30% of MNDE Total Supply", source: "on-chain proposal name", sourceRef: "x", retrievedAt: "2026-10-05", kind: "percentOfSupply", percent: 30 }], [burn], { decimals: 9, claimedPreSupplyRaw: 1000000000000000000n });
    expect(c[0]).toMatchObject({ claimId: "c1", status: "covered-under-assumption" });
    expect(c[0].note).toContain("1,000,000,000");
  });
  test("no effects → claim unmatched, not contradicted", () => {
    const c = coverage([{ id: "c2", text: "Burn 0–50%", source: "s", sourceRef: "x", retrievedAt: "2026-10-05", kind: "range" }], [], { decimals: 9, claimedPreSupplyRaw: null });
    expect(c[0].status).toBe("no-executable-effect");
  });
  test("an effect nobody claimed is an omission", () => {
    const c = coverage([], [burn], { decimals: 9, claimedPreSupplyRaw: null });
    expect(c.find((x) => x.claimId === null)?.status).toBe("omitted-from-claims");
  });
});
```

- [ ] **Step 3: Write `src/governance/claims.ts`**

```ts
import { readFileSync } from "node:fs";
import { formatUnits } from "../chain/token-layout";
import type { Effect } from "./effects";

export type Claim = { id: string; text: string; source: string; sourceRef: string; retrievedAt: string; kind: "percentOfSupply" | "amount" | "range" | "text"; percent?: number; amountDisplay?: string };
export type CaseFile = { caseId: string; title: string; programId: string; programVersion: number; proposal: string; relatedProposals?: { role: string; address: string }[]; claims: Claim[]; fixture: { burnOneToken: boolean }; notes?: string[] };
export type Coverage = { claimId: string | null; effectId: string | null; status: "covered" | "covered-under-assumption" | "contradicted" | "no-executable-effect" | "omitted-from-claims" | "unchecked"; note: string };

export const loadCase = (path: string): CaseFile => JSON.parse(readFileSync(path, "utf8"));

export function coverage(claims: Claim[], effects: Effect[], ctx: { decimals: number; claimedPreSupplyRaw: bigint | null }): Coverage[] {
  const out: Coverage[] = [];
  const movements = effects.filter((e) => e.type === "supplyChange" || e.type === "treasuryMovement" || e.type === "mint");
  for (const c of claims) {
    if (movements.length === 0) { out.push({ claimId: c.id, effectId: null, status: "no-executable-effect", note: "the proposal carries no decoded token effect; the claim is signaling only" }); continue; }
    const e = movements[0]; const amount = BigInt(String(e.detail.deltaRaw ?? e.detail.amountRaw)); const abs = amount < 0n ? -amount : amount;
    if (c.kind === "percentOfSupply" && c.percent != null) {
      if (ctx.claimedPreSupplyRaw) {
        const impliedPct = Number((abs * 1_000_000n) / ctx.claimedPreSupplyRaw) / 10_000;
        const ok = Math.abs(impliedPct - c.percent) < 0.01;
        out.push({ claimId: c.id, effectId: e.id, status: ok ? "covered-under-assumption" : "contradicted", note: `${formatUnits(abs, ctx.decimals)} is ${impliedPct.toFixed(2)}% of the claimed pre-burn supply ${formatUnits(ctx.claimedPreSupplyRaw, ctx.decimals)} (supply claim unverified); on-chain pre-execution supply not captured` });
      } else out.push({ claimId: c.id, effectId: e.id, status: "unchecked", note: "percentage claims need a pre-execution supply; none captured or claimed" });
      continue;
    }
    if (c.kind === "amount" && c.amountDisplay) {
      const digits = c.amountDisplay.replace(/[^0-9]/g, "");
      const ok = digits.length > 0 && formatUnits(abs, ctx.decimals).replace(/[^0-9]/g, "").startsWith(digits);
      out.push({ claimId: c.id, effectId: e.id, status: ok ? "covered" : "contradicted", note: ok ? `decoded amount ${formatUnits(abs, ctx.decimals)} matches the stated amount` : `decoded amount ${formatUnits(abs, ctx.decimals)} differs from the stated ${c.amountDisplay}` });
      continue;
    }
    out.push({ claimId: c.id, effectId: e.id, status: "unchecked", note: "free-text or range claim; shown for the reviewer, not machine-checked" });
  }
  const claimedEffectIds = new Set(out.map((o) => o.effectId).filter(Boolean));
  for (const e of movements) if (!claimedEffectIds.has(e.id)) out.push({ claimId: null, effectId: e.id, status: "omitted-from-claims", note: "decoded effect not mentioned by any captured claim; review, do not assume intent" });
  return out;
}
```

- [ ] **Step 4: Run** `bun test tests/claims.test.ts` → 3 pass. **Step 5: Commit** → `git commit -am "feat(governance): claims file and coverage (covered / under-assumption / contradicted / omitted)"`

---

## Task 8: Graph and control path

**Files:**
- Create: `src/graph/model.ts`, `src/graph/build.ts`
- Test: `tests/graph.test.ts`

- [ ] **Step 1: Write `src/graph/model.ts`**

```ts
import type { Basis } from "../governance/effects";
export type NodeType = "Realm" | "Governance" | "NativeTreasury" | "TokenAccount" | "Mint" | "Proposal" | "ProposalTransaction" | "Instruction" | "Effect" | "SimulationRun" | "ExecutionReceipt" | "Claim" | "Mechanism" | "Program";
export type GNode = { id: string; type: NodeType; label: string; props?: Record<string, unknown> };
export type GEdge = { from: string; to: string; type: string; basis: Basis; evidenceIds: string[]; props?: Record<string, unknown> };
export type Graph = { nodes: GNode[]; edges: GEdge[] };
```

- [ ] **Step 2: Write `src/graph/build.ts`**

```ts
import type { ProposalBundle } from "../governance/reader";
import type { Decoded } from "../governance/decode";
import type { Effect } from "../governance/effects";
import type { Receipt } from "../governance/receipt";
import type { SimulationRun } from "../governance/simulate";
import type { Claim } from "../governance/claims";
import type { Graph, GNode, GEdge } from "./model";

export function buildGraph(b: ProposalBundle, decoded: Decoded[], effects: Effect[], receipt: Receipt | null, sims: SimulationRun[], claims: Claim[]): Graph {
  const nodes = new Map<string, GNode>(); const edges: GEdge[] = [];
  const add = (n: GNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
  const realm = add({ id: `realm:${b.realm.address}`, type: "Realm", label: b.realm.name });
  const gov = add({ id: `gov:${b.governance.address}`, type: "Governance", label: `Governance ${b.governance.address.slice(0, 6)}…` });
  const treasury = add({ id: `treasury:${b.governance.nativeTreasury}`, type: "NativeTreasury", label: `Native treasury ${b.governance.nativeTreasury.slice(0, 6)}…` });
  const prop = add({ id: `proposal:${b.proposal.address}`, type: "Proposal", label: b.proposal.name, props: { state: b.proposal.stateName } });
  edges.push({ from: gov, to: realm, type: "BELONGS_TO", basis: "observed", evidenceIds: [b.governance.evidenceId] });
  edges.push({ from: treasury, to: gov, type: "TREASURY_OF", basis: "observed", evidenceIds: [b.governance.evidenceId], props: { derivation: "getNativeTreasuryAddress(program, governance)" } });
  edges.push({ from: prop, to: gov, type: "PROPOSED_IN", basis: "observed", evidenceIds: [b.proposal.evidenceId] });
  for (const [addr, ta] of Object.entries(b.tokenAccounts)) {
    const n = add({ id: `ta:${addr}`, type: "TokenAccount", label: `Token account ${addr.slice(0, 6)}…`, props: { balanceRaw: ta.amountRaw.toString(), slot: ta.slot } });
    const ownerId = ta.owner === b.governance.nativeTreasury ? treasury : add({ id: `acct:${ta.owner}`, type: "NativeTreasury", label: `Owner ${ta.owner.slice(0, 6)}…` });
    edges.push({ from: n, to: ownerId, type: "OWNED_BY", basis: "observed", evidenceIds: [ta.evidenceId] });
    edges.push({ from: n, to: add({ id: `mint:${ta.mint}`, type: "Mint", label: `Mint ${ta.mint.slice(0, 6)}…` }), type: "OF_MINT", basis: "observed", evidenceIds: [ta.evidenceId] });
  }
  for (const [addr, m] of Object.entries(b.mints)) add({ id: `mint:${addr}`, type: "Mint", label: `Mint ${addr.slice(0, 6)}…`, props: { supplyRaw: m.supplyRaw.toString(), decimals: m.decimals, slot: m.slot } });
  b.transactions.forEach((t, ti) => {
    const tx = add({ id: `ptx:${t.address}`, type: "ProposalTransaction", label: `Transaction ${t.optionIndex}/${t.index}`, props: { executedAt: t.executedAt, executionStatus: t.executionStatus } });
    edges.push({ from: prop, to: tx, type: "HAS_TRANSACTION", basis: "observed", evidenceIds: [t.evidenceId] });
    t.instructions.forEach((ix, ii) => {
      const d = decoded[ti + ii];
      const ins = add({ id: `ix:${t.address}:${ii}`, type: "Instruction", label: d.kind === "unsupported" ? `Unsupported (${ix.programId.slice(0, 6)}…)` : d.kind, props: { program: ix.programId } });
      edges.push({ from: tx, to: ins, type: "CONTAINS_INSTRUCTION", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "burn" || d.kind === "transfer") edges.push({ from: ins, to: `ta:${d.source}`, type: "DEBITS", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "burn") edges.push({ from: ins, to: `mint:${d.mint}`, type: "BURNS_FROM", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "transfer") edges.push({ from: ins, to: add({ id: `ta:${d.destination}`, type: "TokenAccount", label: `Token account ${d.destination.slice(0, 6)}…` }), type: "CREDITS", basis: "decoded", evidenceIds: [t.evidenceId] });
    });
  });
  for (const e of effects) {
    const n = add({ id: `effect:${e.id}`, type: "Effect", label: `${e.type}: ${String(e.detail.display ?? e.detail.amountDisplay ?? e.detail.reason ?? "")}`, props: e.detail });
    const ixId = [...nodes.keys()].find((k) => k.startsWith("ix:")); if (ixId) edges.push({ from: ixId, to: n, type: "PRODUCES", basis: e.basis, evidenceIds: e.evidenceIds });
    const mech = add({ id: e.type === "supplyChange" || e.type === "mint" ? "mech:supply" : e.type === "treasuryMovement" ? "mech:treasury" : "mech:control", type: "Mechanism", label: e.type === "supplyChange" || e.type === "mint" ? "Token supply" : e.type === "treasuryMovement" ? "DAO treasury" : "Control" });
    edges.push({ from: n, to: mech, type: "AFFECTS", basis: e.basis, evidenceIds: e.evidenceIds });
  }
  if (receipt) { const r = add({ id: `receipt:${receipt.signature}`, type: "ExecutionReceipt", label: `Execution ${receipt.signature.slice(0, 8)}… @${receipt.slot}` }); for (const e of effects) edges.push({ from: r, to: `effect:${e.id}`, type: receipt.success ? "CONFIRMS" : "FAILS", basis: "observed", evidenceIds: receipt.evidenceIds }); }
  for (const s of sims) { const n = add({ id: `sim:${s.id}`, type: "SimulationRun", label: `${s.kind}: ${s.success ? "success" : "failed"}` }); for (const e of effects) edges.push({ from: n, to: `effect:${e.id}`, type: "PREVIEWS", basis: "simulated", evidenceIds: s.evidenceIds, props: { kind: s.kind } }); }
  for (const c of claims) { const n = add({ id: `claim:${c.id}`, type: "Claim", label: c.text.slice(0, 60) }); edges.push({ from: n, to: prop, type: "DESCRIBES", basis: "claimed", evidenceIds: [], props: { source: c.source } }); }
  return { nodes: [...nodes.values()], edges };
}

/** The control path the demo follows: token account → treasury PDA → governance → realm. */
export function controlPath(g: Graph, tokenAccount: string): string[] {
  const path = [`ta:${tokenAccount}`]; let cur = path[0];
  for (const t of ["OWNED_BY", "TREASURY_OF", "BELONGS_TO"]) { const e = g.edges.find((x) => x.from === cur && x.type === t); if (!e) break; path.push(e.to); cur = e.to; }
  return path;
}

export function mermaid(g: Graph): string {
  const esc = (s: string) => s.replace(/"/g, "'");
  const id = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  return ["flowchart LR", ...g.nodes.map((n) => `  ${id(n.id)}["${esc(n.type)}: ${esc(n.label)}"]`), ...g.edges.map((e) => `  ${id(e.from)} -- ${e.type} (${e.basis}) --> ${id(e.to)}`)].join("\n");
}
```

- [ ] **Step 3: Write `tests/graph.test.ts`** (offline bundle → path exists; every edge has a basis; mermaid non-empty)

```ts
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { effectsFromDecoded } from "../src/governance/effects";
import { buildGraph, controlPath, mermaid } from "../src/graph/build";

test("MIP-14 graph has the treasury → governance → realm control path", async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true }), "mip-14");
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey("EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1"));
  const decoded = b.transactions.flatMap((t) => t.instructions.map(decodeInstruction));
  const g = buildGraph(b, decoded, effectsFromDecoded(decoded, b, { nativeTreasury: b.governance.nativeTreasury }), null, [], []);
  expect(controlPath(g, "GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi")).toEqual(["ta:GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi", "treasury:B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG", "gov:8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq", "realm:899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo"]);
  expect(g.edges.every((e) => ["claimed", "decoded", "simulated", "observed", "unknown"].includes(e.basis))).toBe(true);
  expect(mermaid(g)).toContain("flowchart LR");
});
```

- [ ] **Step 4: Run** → 1 pass. **Step 5: Commit** → `git commit -am "feat(graph): evidence-bearing graph, control path and mermaid export"`

---

## Task 9: Checks, review packet (JSON + HTML)

**Files:**
- Create: `src/review/checks.ts`, `src/review/packet.ts`
- Test: `tests/packet.test.ts`

- [ ] **Step 1: Write `src/review/checks.ts`**

```ts
import type { ProposalBundle } from "../governance/reader";
import type { Effect } from "../governance/effects";
import type { Reconciliation } from "../governance/receipt";
import type { SimulationRun } from "../governance/simulate";
import type { Coverage } from "../governance/claims";

export type Dimension = "description_matches_effects" | "execution_eligible" | "simulation_result" | "execution_status" | "policy_result";
export type CheckRow = { check: string; result: string; basis: string; needsReview: boolean };
export type Dimensions = Record<Dimension, string>;

export function dimensions(b: ProposalBundle, effects: Effect[], cov: Coverage[], sims: SimulationRun[], rec: Reconciliation): Dimensions {
  const hasPayload = b.transactions.some((t) => t.instructions.length > 0);
  const contradicted = cov.some((c) => c.status === "contradicted"); const omitted = cov.some((c) => c.status === "omitted-from-claims");
  const executed = b.transactions.some((t) => t.executedAt != null);
  const now = Math.floor(Date.now() / 1000);
  return {
    description_matches_effects: !hasPayload ? "no executable payload: signaling only" : contradicted ? "contradiction: review" : omitted ? "omission: effects not mentioned by captured claims" : cov.some((c) => c.status === "covered" || c.status === "covered-under-assumption") ? "covered (see assumptions)" : "unchecked",
    execution_eligible: !hasPayload ? "not applicable" : executed ? "already executed (historical)" : b.proposal.stateName === "Succeeded" ? `eligible after hold-up ${b.transactions[0]?.holdUpTime ?? "?"} s` : `not eligible: state ${b.proposal.stateName} at ${new Date(now * 1000).toISOString()}`,
    simulation_result: sims.length === 0 ? "not run" : sims.map((s) => `${s.kind}: ${s.success ? "success" : "failed"} (conditional preview @${s.contextSlot})`).join("; "),
    execution_status: rec.status === "matched" ? "observed: receipt matches decoded effect" : rec.status === "not-executed" ? "not executed" : rec.status,
    policy_result: "no policy configured: human review required",
  };
}

export function checks(b: ProposalBundle, effects: Effect[], cov: Coverage[], rec: Reconciliation): CheckRow[] {
  const rows: CheckRow[] = [];
  const move = effects.find((e) => e.type === "treasuryMovement"); const supply = effects.find((e) => e.type === "supplyChange" || e.type === "mint"); const control = effects.find((e) => e.type === "controlChange"); const unknown = effects.filter((e) => e.type === "unknown");
  rows.push({ check: "Treasury movement", result: move ? `${move.detail.amountDisplay} ${String(move.detail.asset).slice(0, 6)}… from ${String(move.detail.source).slice(0, 6)}… (${move.detail.sourceIsGovernanceTreasury ? "governance treasury" : "owner " + String(move.detail.sourceOwner).slice(0, 6) + "…"}) to ${move.detail.destination ?? "burn"}; ${move.detail.shareOfSourceBalanceAtCapture} of source balance at slot ${move.detail.captureSlot}` : "none decoded", basis: move ? move.basis : "decoded", needsReview: !!move && (move.flags.length > 0) });
  rows.push({ check: "Supply change", result: supply ? `${supply.detail.display} (${supply.detail.shareOfSupplyAtCapture} of supply at slot ${supply.detail.captureSlot})` : "none decoded", basis: supply ? supply.basis : "decoded", needsReview: false });
  rows.push({ check: "Claim coverage", result: cov.length ? cov.map((c) => `${c.claimId ?? "(uncaptured)"}: ${c.status}`).join("; ") : "no claims captured", basis: "claimed vs decoded", needsReview: cov.some((c) => c.status === "contradicted" || c.status === "omitted-from-claims" || c.status === "unchecked") });
  rows.push({ check: "Control change", result: control ? `${control.detail.authorityType} on ${String(control.detail.target).slice(0, 6)}…: ${control.detail.from} → ${control.detail.to}` : "none decoded", basis: "decoded", needsReview: !!control });
  rows.push({ check: "Unknown / unsupported", result: unknown.length ? unknown.map((u) => `${String(u.detail.program).slice(0, 8)}…: ${u.detail.reason}`).join("; ") : "none", basis: "unknown", needsReview: unknown.length > 0 });
  rows.push({ check: "Execution conditions", result: `state ${b.proposal.stateName}; hold-up ${b.transactions[0]?.holdUpTime ?? "n/a"} s; voting ${b.governance.baseVotingTime} s + cool-off ${b.governance.votingCoolOffTime} s; council veto path not evaluated in this slice`, basis: "observed", needsReview: false });
  rows.push({ check: "Observed execution", result: rec.status === "matched" ? `matched: ${rec.observedDeltaRaw} raw on ${String(rec.account).slice(0, 6)}…` : rec.status, basis: "observed", needsReview: rec.status === "mismatch" });
  rows.push({ check: "Economic consequence", result: supply ? "token supply mechanism affected; mSOL backing is a separate relationship and is not affected by an MNDE burn" : move ? "treasury composition changes; downstream dependencies not mapped in this slice" : "none supported", basis: "research assumption", needsReview: true });
  return rows;
}
```

- [ ] **Step 2: Write `src/review/packet.ts`** (JSON packet + a dependency-free HTML page; mermaid source is embedded in a `<details>` and rendered via CDN only when online)

```ts
import { sha256 } from "../chain/evidence";
import type { ProposalBundle } from "../governance/reader";
import type { Decoded } from "../governance/decode";
import type { Effect } from "../governance/effects";
import type { Receipt, Reconciliation } from "../governance/receipt";
import type { SimulationRun } from "../governance/simulate";
import type { Claim, Coverage } from "../governance/claims";
import type { Graph } from "../graph/model";
import { mermaid, controlPath } from "../graph/build";
import { checks, dimensions, type CheckRow, type Dimensions } from "./checks";

export type Packet = { caseId: string; title: string; generatedAt: string; offline: boolean; bindingSha256: string; proposal: ProposalBundle["proposal"]; governance: ProposalBundle["governance"]; realm: ProposalBundle["realm"]; claimed: Claim[]; decoded: Decoded[]; effects: Effect[]; simulated: SimulationRun[]; observed: { receipt: Receipt | null; reconciliation: Reconciliation }; coverage: Coverage[]; checks: CheckRow[]; dimensions: Dimensions; controlPath: string[]; graph: Graph; evidenceCount: number; reviewDecision: { status: "not-recorded"; note: string } };

export function bindingHash(b: ProposalBundle): string {
  return sha256(JSON.stringify(b.transactions.map((t) => ({ a: t.address, i: t.instructions.map((ix) => [ix.programId, ix.accounts, ix.dataHex]) }))));
}

export function buildPacket(args: { caseId: string; title: string; offline: boolean; bundle: ProposalBundle; decoded: Decoded[]; effects: Effect[]; sims: SimulationRun[]; receipt: Receipt | null; reconciliation: Reconciliation; claims: Claim[]; coverage: Coverage[]; graph: Graph; evidenceCount: number }): Packet {
  const b = args.bundle; const firstTa = Object.keys(b.tokenAccounts)[0];
  return { caseId: args.caseId, title: args.title, generatedAt: new Date().toISOString(), offline: args.offline, bindingSha256: bindingHash(b), proposal: b.proposal, governance: b.governance, realm: b.realm, claimed: args.claims, decoded: args.decoded, effects: args.effects, simulated: args.sims, observed: { receipt: args.receipt, reconciliation: args.reconciliation }, coverage: args.coverage, checks: checks(b, args.effects, args.coverage, args.reconciliation), dimensions: dimensions(b, args.effects, args.coverage, args.sims, args.reconciliation), controlPath: firstTa ? controlPath(args.graph, firstTa) : [], graph: args.graph, evidenceCount: args.evidenceCount, reviewDecision: { status: "not-recorded", note: "a human records approve / reject / needs-work against bindingSha256; a changed payload invalidates it" } };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const ts = (t: number | null) => (t == null ? "—" : new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC");

export function renderHtml(p: Packet): string {
  const col = (title: string, basis: string, body: string) => `<section class="col ${basis}"><h2>${title}<small>${basis}</small></h2>${body}</section>`;
  const claimed = p.claimed.length ? `<ul>${p.claimed.map((c) => `<li>“${esc(c.text)}” <span class="src">${esc(c.source)} · ${esc(c.retrievedAt)}</span></li>`).join("")}</ul>` : "<p>No claims captured.</p>";
  const decoded = p.decoded.length ? `<ul>${p.decoded.map((d) => `<li><b>${esc(d.kind)}</b> ${d.kind === "unsupported" ? esc(d.reason) : esc(JSON.stringify({ ...d, amountRaw: (d as any).amountRaw?.toString?.() }))}</li>`).join("")}</ul>` + `<ul>${p.effects.map((e) => `<li>${esc(e.type)}: ${esc(e.detail.display ?? e.detail.amountDisplay ?? e.detail.reason)} ${e.flags.length ? `<em>[${esc(e.flags.join(", "))}]</em>` : ""}</li>`).join("")}</ul>` : "<p>No executable payload: this proposal is signaling only. Execution is unverified by definition.</p>";
  const simulated = p.simulated.length ? p.simulated.map((s) => `<div class="sim ${s.success ? "ok" : "fail"}"><b>${esc(s.kind)}</b> · ${s.success ? "success" : "failed"} · slot ${s.contextSlot} · ${esc(s.label)}<details><summary>assumptions and logs</summary><ul>${s.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul><pre>${esc(s.logs.join("\n"))}</pre>${s.error ? `<pre>${esc(JSON.stringify(s.error))}</pre>` : ""}</details></div>`).join("") : "<p>Not simulated.</p>";
  const r = p.observed.receipt; const rec = p.observed.reconciliation;
  const observed = r ? `<p><b>${esc(rec.status)}</b> · tx <code>${esc(r.signature)}</code> · slot ${r.slot} · ${ts(r.blockTime)}</p><ul>${r.tokenBalances.map((b) => `<li>${esc(b.account.slice(0, 8))}… ${esc(b.preRaw)} → ${esc(b.postRaw)} (Δ ${esc(b.deltaRaw)})</li>`).join("")}</ul>${rec.notes.length ? `<ul class="notes">${rec.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}` : `<p>${esc(rec.status)}: ${esc(rec.notes.join("; "))}</p>`;
  const checksHtml = `<table><tr><th>Check</th><th>Result</th><th>Basis</th><th>Review</th></tr>${p.checks.map((c) => `<tr class="${c.needsReview ? "review" : ""}"><td>${esc(c.check)}</td><td>${esc(c.result)}</td><td>${esc(c.basis)}</td><td>${c.needsReview ? "needs review" : "—"}</td></tr>`).join("")}</table>`;
  const dims = `<table>${Object.entries(p.dimensions).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
  const path = p.controlPath.length ? `<ol class="path">${p.controlPath.map((n) => `<li>${esc(p.graph.nodes.find((x) => x.id === n)?.label ?? n)}</li>`).join("")}</ol>` : "<p>No token account in the payload; no control path.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Linchpin review · ${esc(p.title)}</title>
<style>:root{--bg:#0f1115;--fg:#e8e8e8;--mut:#9aa0a6;--claimed:#c9a227;--decoded:#4f8ef7;--simulated:#a66bff;--observed:#2fb673;--unknown:#777}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}h1{margin:0 0 4px}.sub{color:var(--mut);margin-bottom:20px}.cols{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.col{border:1px solid #2a2f3a;border-radius:10px;padding:12px;min-height:160px}.col h2{font-size:15px;margin:0 0 8px;display:flex;justify-content:space-between}.col h2 small{font-weight:400;color:var(--mut)}.claimed h2{color:var(--claimed)}.decoded h2{color:var(--decoded)}.simulated h2{color:var(--simulated)}.observed h2{color:var(--observed)}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #2a2f3a;vertical-align:top}tr.review td{background:#2a2316}code,pre{font:12px/1.4 ui-monospace,monospace;word-break:break-all;white-space:pre-wrap}.sim{border-left:3px solid var(--simulated);padding:6px 10px;margin:6px 0}.sim.fail{border-color:#e05555}.src{color:var(--mut);font-size:12px}.path li{margin:4px 0}.notes{color:var(--mut)}footer{color:var(--mut);margin-top:24px;font-size:12px}@media(max-width:900px){.cols{grid-template-columns:1fr}}</style></head><body>
<h1>${esc(p.title)}</h1><div class="sub">${esc(p.realm.name)} · proposal <code>${esc(p.proposal.address)}</code> · state ${esc(p.proposal.stateName)} · voting ${ts(p.proposal.votingAt)} → ${ts(p.proposal.votingCompletedAt)} · executed ${ts(p.proposal.executingAt)} · ${p.offline ? "offline replay" : "live"} · ${p.evidenceCount} evidence records · binding <code>${esc(p.bindingSha256.slice(0, 16))}…</code></div>
<div class="cols">${col("Claimed", "claimed", claimed)}${col("Decoded", "decoded", decoded)}${col("Simulated", "simulated", simulated)}${col("Observed", "observed", observed)}</div>
<h2>Control path</h2>${path}
<h2>Checks</h2>${checksHtml}
<h2>Review dimensions (kept separate)</h2>${dims}
<h2>Review decision</h2><p>${esc(p.reviewDecision.status)} — ${esc(p.reviewDecision.note)}</p>
<details><summary>Graph (mermaid source)</summary><pre class="mermaid">${esc(mermaid(p.graph))}</pre></details>
<footer>Generated ${esc(p.generatedAt)} by Linchpin. A simulation is a conditional preview, not proof of authorization or safety. Historical proposals are shown under today's state unless a receipt is present.</footer>
<script>if(navigator.onLine){const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";s.onload=()=>mermaid.initialize({startOnLoad:true,theme:"dark"});document.body.appendChild(s)}</script>
</body></html>`;
}
```

- [ ] **Step 3: Write `tests/packet.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "../src/config";
import { readProposalBundle } from "../src/governance/reader";
import { decodeInstruction } from "../src/governance/decode";
import { effectsFromDecoded } from "../src/governance/effects";
import { reconcileReceipt } from "../src/governance/receipt";
import { coverage } from "../src/governance/claims";
import { buildGraph } from "../src/graph/build";
import { buildPacket, renderHtml } from "../src/review/packet";

async function packetFor(caseId: string, proposal: string) {
  const rpc = new RecordingRpc(runOptions({ offline: true }), caseId);
  const b = await readProposalBundle(rpc, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION, new PublicKey(proposal));
  const decoded = b.transactions.flatMap((t) => t.instructions.map(decodeInstruction));
  const effects = effectsFromDecoded(decoded, b, { nativeTreasury: b.governance.nativeTreasury });
  const rec = b.transactions[0] ? reconcileReceipt(decoded, b.transactions[0], null) : { status: "not-executed" as const, expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transactions"] };
  const cov = coverage([], effects, { decimals: 9, claimedPreSupplyRaw: null });
  return buildPacket({ caseId, title: caseId, offline: true, bundle: b, decoded, effects, sims: [], receipt: null, reconciliation: rec, claims: [], coverage: cov, graph: buildGraph(b, decoded, effects, null, [], []), evidenceCount: rpc.evidence.length });
}

describe("packet", () => {
  test("MIP-14 packet renders all four bases and a binding hash", async () => {
    const p = await packetFor("mip-14", "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1");
    const html = renderHtml(p);
    for (const s of ["Claimed", "Decoded", "Simulated", "Observed", "Control path", p.bindingSha256.slice(0, 16)]) expect(html).toContain(s);
    expect(p.controlPath).toHaveLength(4);
  });
  test("the opinion proposal is a clean no-payload control", async () => {
    const p = await packetFor("mip-14-opinion", "Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp");
    expect(p.dimensions.description_matches_effects).toContain("no executable payload");
    expect(p.dimensions.execution_eligible).toBe("not applicable");
    expect(renderHtml(p)).toContain("signaling only");
  });
});
```

- [ ] **Step 4: Run** `bun test tests/packet.test.ts` → 2 pass. **Step 5: Commit** → `git commit -am "feat(review): deterministic checks, separate dimensions, JSON packet and static HTML"`

---

## Task 10: CLI, end-to-end run, committed fixtures

**Files:**
- Modify: `src/cli.ts`
- Delete: `scripts/record.ts` (its job moves into `review --record`)

- [ ] **Step 1: Write `src/cli.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getGovernanceProgramVersion } from "@solana/spl-governance";
import { runOptions, MARINADE_GOVERNANCE_PROGRAM, MARINADE_PROGRAM_VERSION } from "./config";
import { RecordingRpc } from "./chain/rpc";
import { readProposalBundle } from "./governance/reader";
import { decodeInstruction } from "./governance/decode";
import { effectsFromDecoded } from "./governance/effects";
import { findExecutionReceipt, reconcileReceipt } from "./governance/receipt";
import { fixtureBurn, simulateConditionalPreview, toTransactionInstruction, PREVIEW_ASSUMPTIONS } from "./governance/simulate";
import { coverage, loadCase } from "./governance/claims";
import { buildGraph } from "./graph/build";
import { buildPacket, renderHtml } from "./review/packet";

const args = process.argv.slice(2); const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

async function review(casePath: string) {
  const c = loadCase(casePath);
  const opts = runOptions({ offline: flag("offline"), record: flag("record"), outDir: opt("out", join("out", c.caseId)) });
  const rpc = new RecordingRpc(opts, c.caseId);
  const programId = new PublicKey(c.programId);
  const bundle = await readProposalBundle(rpc, programId, c.programVersion, new PublicKey(c.proposal));
  const decoded = bundle.transactions.flatMap((t) => t.instructions.map(decodeInstruction));
  const effects = effectsFromDecoded(decoded, bundle, { nativeTreasury: bundle.governance.nativeTreasury });
  const ptx = bundle.transactions[0] ?? null;
  const receipt = ptx ? await findExecutionReceipt(rpc, ptx) : null;
  const reconciliation = ptx ? reconcileReceipt(decoded, ptx, receipt) : { status: "not-executed" as const, expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no proposal transactions"] };
  const sims = [];
  if (ptx && ptx.instructions.length) {
    const treasury = new PublicKey(bundle.governance.nativeTreasury);
    const tokenAccounts = Object.keys(bundle.tokenAccounts).map((k) => new PublicKey(k)); const mints = Object.keys(bundle.mints).map((k) => new PublicKey(k));
    sims.push(await simulateConditionalPreview(rpc, { kind: "historical-payload", label: `${c.caseId} payload against current state`, instructions: ptx.instructions.map(toTransactionInstruction), feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: PREVIEW_ASSUMPTIONS }));
    const d = decoded.find((x) => x.kind === "burn");
    if (c.fixture.burnOneToken && d && d.kind === "burn") sims.push(await simulateConditionalPreview(rpc, { kind: "fixture", label: "fixture: burn 1 whole token from the same treasury account (not the historical payload)", instructions: [fixtureBurn(new PublicKey(d.source), new PublicKey(d.mint), new PublicKey(d.authority), bundle.mints[d.mint]?.decimals ?? 9)], feePayer: treasury, watch: { tokenAccounts, mints }, assumptions: [...PREVIEW_ASSUMPTIONS, "amount replaced by one whole token so the preview can succeed under current balances"] }));
  }
  const decimals = bundle.mints[bundle.proposal.governingTokenMint]?.decimals ?? 9;
  const cov = coverage(c.claims, effects, { decimals, claimedPreSupplyRaw: 1000000000n * 10n ** BigInt(decimals) });
  const graph = buildGraph(bundle, decoded, effects, receipt, sims, c.claims);
  const packet = buildPacket({ caseId: c.caseId, title: c.title, offline: opts.offline, bundle, decoded, effects, sims, receipt, reconciliation, claims: c.claims, coverage: cov, graph, evidenceCount: rpc.evidence.length });
  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "packet.json"), JSON.stringify(packet, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  writeFileSync(join(opts.outDir, "packet.html"), renderHtml(packet));
  writeFileSync(join(opts.outDir, "graph.json"), JSON.stringify(graph, null, 1));
  const evidencePath = rpc.flushEvidence(opts.outDir);
  console.log(`${c.caseId}: ${packet.dimensions.execution_status} · ${sims.map((s) => `${s.kind}=${s.success ? "ok" : "fail"}`).join(" ") || "no simulation"} · ${rpc.evidence.length} evidence → ${join(opts.outDir, "packet.html")} (${evidencePath})`);
}

async function doctor() {
  const opts = runOptions({}); const rpc = new RecordingRpc(opts, "doctor");
  const v = await getGovernanceProgramVersion(rpc.connection, MARINADE_GOVERNANCE_PROGRAM);
  console.log(JSON.stringify({ rpcUrl: opts.rpcUrl, program: MARINADE_GOVERNANCE_PROGRAM.toBase58(), programVersionLive: v, programVersionPinned: MARINADE_PROGRAM_VERSION, ok: v === MARINADE_PROGRAM_VERSION }));
}

if (cmd === "review" && args[1]) await review(args[1]);
else if (cmd === "demo") { for (const c of ["cases/mip-14.json", "cases/mip-14-opinion.json"]) await review(c); }
else if (cmd === "doctor") await doctor();
else { console.log("usage: linchpin review <case.json> [--offline] [--record] [--out dir] | linchpin demo [--offline] | linchpin doctor"); process.exit(cmd ? 1 : 0); }
```

- [ ] **Step 2: Record everything live once and commit the fixtures**

```bash
rm -rf fixtures/mip-14 fixtures/mip-14-opinion
bun run linchpin review cases/mip-14.json --record
bun run linchpin review cases/mip-14-opinion.json --record
bun test
git add -A && git commit -m "feat(cli): review/demo/doctor; recorded fixtures for MIP-14 and the opinion control"
```
Expected: `mip-14: observed: receipt matches decoded effect · historical-payload=fail fixture=ok · N evidence → out/mip-14/packet.html`; all tests pass.

- [ ] **Step 3: Prove the offline demo works with networking off**

```bash
LINCHPIN_RPC_URL=http://127.0.0.1:1 bun run demo && open out/mip-14/packet.html out/mip-14-opinion/packet.html
```
Expected: both packets render; the header says "offline replay". Commit nothing new unless something changed.

---

## Task 11: Failure cases that must show honestly

**Files:**
- Create: `tests/failure-cases.test.ts`, `fixtures/synthetic/` (hand-written bundles, clearly named synthetic)

- [ ] **Step 1: Write tests that build packets from synthetic bundles** covering spec §7 cases 1, 4, 5 and 6: (1) no payload → "no executable payload" (already covered by the opinion proposal, assert again here from a synthetic bundle); (4) an instruction from an unknown program → `Unknown / unsupported` row `needsReview: true` and an `unknown` effect; (5) a payload change → a different `bindingSha256` for the same proposal address; (6) the historical proposal under today's state → the `historical-payload` simulation failed while `execution_status` is `observed: receipt matches decoded effect` (from the real fixtures). Build the synthetic bundles by loading the MIP-14 offline bundle and editing `transactions[0].instructions` in memory; no new RPC fixtures are needed.

- [ ] **Step 2: Run the whole suite** → `bun test` → all green. **Step 3: Commit** → `git commit -am "test: failure cases 1, 4, 5, 6 from the governance spec"`

---

## Task 12: README, demo script, pitch and dry run

**Files:**
- Create: `README.md` (replace the generated one), `docs/demo-script.md`
- Vault: `Hackathon/Partners and Pitch/Demo Day Pitch — Linchpin (Oct 2026).md` (Claude drafts, Peter edits)

- [ ] **Step 1: README** sections: what Linchpin is (one paragraph, the dependency-engine framing from D-2026-10-05-7), what the demo shows, run instructions (`bun install`, `bun run demo`, `open out/mip-14/packet.html`), how to read a packet (the four bases, the control path, the dimensions), what it does not claim (simulation ≠ authorization; today's state ≠ pre-state; no policy engine), roadmap (MIP-21, transfers with destination history, voter-weight checks, Python core), licence.

- [ ] **Step 2: `docs/demo-script.md`**, the 3-minute flow from spec §7, timed:
  1. 0:00 Problem (20 s): proposals move treasuries and supply; intent, payload, simulation and execution are judged separately or not at all.
  2. 0:20 Open `out/mip-14/packet.html`: claim column (30 % burn) vs decoded column (Burn 300,000,000 MNDE from the governance's own treasury account).
  3. 0:50 Control path: token account → native treasury PDA → governance → Marinade DAO. "Who can pull this lever."
  4. 1:20 Simulated: the historical payload fails today (insufficient funds, honest label); the labelled fixture succeeds with assumptions listed.
  5. 1:50 Observed: the execution receipt, exactly −300,000,000, plus the unrelated assertion program kept visible.
  6. 2:20 Control: the opinion proposal packet says "no executable payload: signaling only".
  7. 2:40 What's next: MIP-21 treasury exchange, dependency map to mSOL and protocol fees, pilot with one DAO.
  Rehearse offline twice; the third run is the recording for Colosseum later.

- [ ] **Step 3: Tag** → `git tag v0.1-demo && git push --tags && git push`

- [ ] **Step 4: Wednesday 09:00–12:00**: dry runs, fix only what breaks the script, no new features.

---

## 5. Risks and fallbacks (from `memory/bugs-and-risks.md`, updated for this plan)

| Risk | Mitigation in this plan |
|---|---|
| R1 time | Stop rule Tue 18:00; fixtures from Task 10 make the demo offline; the packet is a static file |
| R3 simulation over-claims | `conditional-preview` label, assumptions list, separate `simulated` basis, failed historical replay shown as such |
| R4 SDK layouts | Program version pinned to 3 and checked by `linchpin doctor`; parsing from raw captured bytes |
| R5 RPC limits | Record once; replay offline; optional `LINCHPIN_RPC_URL` with a Helius key |
| New: public RPC history pruning | The execution receipt is in `fixtures/mip-14`; if `getTransaction` ever returns null live, the offline fixture still carries the evidence hash and retrieval time |
| New: Codex dispatch friction | If the codex plugin stalls, Peter runs the same task prompts in his own Codex session in `~/linchpin`; the plan is the contract either way |

## 6. Not part of this plan (explicitly)

Agentic OS tasks (cockpit only), Neo4j, LangGraph, Python core, MIP-21, BONK, voter-weight analysis, a web server, authentication, a hosted demo, the logo (after Demo Day, before the Colosseum submission), Colosseum videos (after Demo Day).

## Log

- 2026-10-05 — Plan written by Claude from the project memory, two read-only spikes on public RPC and Peter's four decisions. Next: Task 0 dispatched to Codex. (Claude)
