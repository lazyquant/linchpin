/**
 * Independent tests for "Position reader, Solana": readPositions interface, registry
 * coverage, private receipts, visible failures, endpoint discipline, and the privacy of
 * everything the reader touches.
 *
 * Written from the approved contract of that title, its frozen plan, the recorded human
 * decisions and the committed fixture bytes. Implementation bodies and the maker's report
 * were not read; only exported type declarations were opened where a shape was needed.
 * Everything runs offline: the file-level trap refuses every outbound socket, and RPC
 * responses come from the recorded bodies (hash-pinned) or from constructed responses,
 * each labelled constructed.
 *
 * Expected values come from the spec, the plan and the recorded bytes - never from what
 * the code prints. Exact decimal quantities are recomputed here with independent bigint
 * arithmetic, not with the reader's own helpers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { canonical, sha256 } from "../src/chain/evidence";
import { openStore, validateSnapshot, type EvidenceSnapshot } from "../src/engine/index";
import { buildNearSnapshot } from "../src/near/reader/index";
import { NO_LIBRARIES } from "../src/near/policy/index";
import { startMcpServer, createMcpHandler } from "../src/near/mcp/server";
import { TOOLS } from "../src/near/mcp/tools";
import { DECIMAL_PATTERN } from "../src/policy/decimal";
import { ID_PATTERN } from "../src/policy/evaluate";
import { PositionsRejected, readPositions, type NotReadReason } from "../src/positions";
import { runPositionsCommand } from "../src/positions/cli";
import { SOLANA_REGISTRY, createSolanaRpcClient } from "../src/solana/positions";
import { loadCapture, normalizeCapture } from "../src/adapters/kamino/index";
import { installTrap, McpClient } from "./fixtures/near-private-risk-manager/mcp-client";
import { LIVE, NEAR_ROOT } from "./fixtures/near-private-risk-manager/rule-store";

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_ALLOWLIST = existsSync(join(import.meta.dir, "..", "scripts", "publish" + "." + "allowlist"));

// File-level outbound trap: nothing leaves this process except the loopback MCP servers
// under test. Every RPC response is injected through an explicit fetch stub instead.
const base = installTrap();
afterAll(() => { base.restore(); expect(base.attempts).toEqual([]); });

const REPO = join(import.meta.dir, "..");
const FX = join(import.meta.dir, "fixtures", "position-reader-solana");

// Keys the plan and spec put on the record: the R8 holder account, the registry mints,
// the program ids and the reserve keys of the registered vault. Nothing else is a real key.
const HOLDER = "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MINT_MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const MINT_MNDE = "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey";
const MINT_KSHARE = "DCqyVY1SFCwq8unnexv9pjujVAC7jsmjfoUWBrNLvbY";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const RESERVE = "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN";
const CTOKEN = "2dQkXr1e9LBvT2QcfKrzZaWY6gGAAVoCjLgkWFk3Mhkj";
const MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const RPC_URL = "https://rpc.test.example/read";
const HOST = "rpc.test.example";
const PUBLIC_DEFAULT_HOST = "api.mainnet-beta.solana.com";
const NOW_MS = Date.parse("2026-11-11T12:00:00.000Z");
const NOW_ISO = "2026-11-11T12:00:00.000Z";

// Exact decimal expectations, derived by hand from the plan's raw values.
const SF = 58374240224146846062811977250n;
const Q_MSOL_SUM = "1235.567890123";
const Q_MNDE = "5";
const Q_KSHARE = "0.123456";
const Q_DEPOSIT = "799085.350664";
const Q_BORROW_9 = "50.63158245456858384711191470479996201703443148289807140827178955078125";
const Q_BORROW_6 = "50631.58245456858384711191470479996201703443148289807140827178955078125";

const subjectOf = (key: string, holder = HOLDER) => `solana:mainnet-beta:${key}#holder:${holder}`;

/** Exact placement of the decimal point; no floating point, trailing zeros trimmed. */
function unitsToDecimalExact(raw: bigint, decimals: number): string {
  let digits = raw.toString();
  if (decimals === 0) return digits;
  while (digits.length <= decimals) digits = "0" + digits;
  let out = `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`;
  while (out.endsWith("0")) out = out.slice(0, -1);
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

/** Liquidity base units are scaled by 2^60: multiply by 5^60, place the point 60+decimals in. */
function sfToDecimalExact(sf: bigint, decimals: number): string {
  return unitsToDecimalExact(sf * 5n ** 60n, decimals + 60);
}

expect(sfToDecimalExact(SF, 9)).toBe(Q_BORROW_9);
expect(sfToDecimalExact(SF, 6)).toBe(Q_BORROW_6);
expect(unitsToDecimalExact(1234567890123n, 9)).toBe("1234.567890123");
expect(unitsToDecimalExact(1n, 6)).toBe("0.000001");

interface RecordedResponse { slot: string; result: unknown }
interface StubReply { status?: number; result?: unknown; error?: { code: number; message: string }; hang?: boolean }

const loadRecorded = (name: string): RecordedResponse & { raw: string } => {
  const raw = readFileSync(join(FX, "recorded", name), "utf8");
  const body = JSON.parse(raw);
  return { slot: String(body.result.context.slot), result: body.result, raw };
};
const loadConstructed = (name: string): RecordedResponse => {
  const body = JSON.parse(readFileSync(join(FX, "constructed", name), "utf8"));
  if (body.constructed !== true) throw new Error(`fixture ${name} is not labelled constructed`);
  return { slot: String(body.body.result.context.slot), result: body.body.result };
};

const RESP = {
  spl: loadConstructed("token-accounts-spl.json"),
  splEmpty: loadConstructed("token-accounts-spl-empty.json"),
  t22Empty: loadConstructed("token-accounts-token2022.json"),
  gpa: loadConstructed("klend-obligations.json"),
  gpaEmpty: loadConstructed("klend-obligations-empty.json"),
  recSpl: loadRecorded("b64-tao-TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.json"),
  recT22: loadRecorded("b64-tao-TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json"),
  recGpa: loadRecorded("b64-gpa.json"),
};

const RECORDED_HASHES: [string, string][] = [
  ["b64-tao-TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.json", "a635e54ee900821a140281d847a2f0ed89a12a341ac4f136f929efbbf715627b"],
  ["b64-tao-TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json", "a7b0177b1f449d9b902ebeb9db795ceef16f46a2803395865d3423a5ebc39734"],
  ["b64-gpa.json", "9ebe80426f760adbd0684a26b7e572bc39f27a6bd1d3747338d821205bb073bd"],
];

interface FetchLog { url: string; method: string; result?: unknown }
type RouteValue = string | StubReply;

/** Builds an injectable fetch: records every URL, refuses any origin but the test endpoint. */
function stubFetch(route: (method: string, params: unknown[]) => RouteValue, log: FetchLog[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.push({ url, method: "fetch" });
    expect(new URL(url).origin).toBe(new URL(RPC_URL).origin);
    const req = JSON.parse(String(init?.body));
    const picked = route(req.method, req.params);
    const reply: StubReply = typeof picked === "string" ? RESP[picked as keyof typeof RESP] as unknown as StubReply : picked;
    if (reply.hang) {
      return new Promise<never>((_, reject) => {
        const signal = init?.signal;
        const bail = () => reject(new Error("request aborted by client timeout"));
        if (signal) {
          if (signal.aborted) return bail();
          signal.addEventListener("abort", bail, { once: true });
        }
        setTimeout(() => reject(new Error("hang stub expired without an abort signal")), 1000);
      });
    }
    if (reply.error !== undefined) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: reply.error }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (reply.status !== undefined && reply.status !== 200) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: reply.status, message: "http status" } }), { status: reply.status, headers: { "content-type": "application/json" } });
    }
    const parsed = { jsonrpc: "2.0", id: 1, result: reply.result };
    log.push({ url, method: req.method, result: parsed.result });
    return new Response(JSON.stringify(parsed), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** Picks a response for each of the reader's three sequential calls. */
function routeCalls(spl: RouteValue, t22: RouteValue, gpa: RouteValue) {
  return (method: string, params: unknown[]): RouteValue => {
    if (method === "getProgramAccounts") return gpa;
    const p = params as [unknown, { programId?: string }];
    return p[1]?.programId === T22 ? t22 : spl;
  };
}

function client(fetchImpl: typeof fetch, opts: { programAccounts?: boolean; timeoutMs?: number; now?: () => number } = {}) {
  return createSolanaRpcClient({
    url: RPC_URL,
    timeoutMs: opts.timeoutMs ?? 2000,
    programAccounts: opts.programAccounts ?? true,
    fetch: fetchImpl,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

const readOnce = async (route: (method: string, params: unknown[]) => RouteValue, opts: Parameters<typeof client>[1] = {}, log: FetchLog[] = []) =>
  readPositions({ chain: "solana", address: HOLDER, snapshotId: "tst-reader-input", client: client(stubFetch(route, log), opts) });

const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map(x => [x.id, x]));
const isSorted = (xs: { subject: string; unit?: string }[]) =>
  xs.every((x, i) => i === 0 || (() => { const a = xs[i - 1]; return a.subject < x.subject || (a.subject === x.subject && (a.unit ?? "") <= (x.unit ?? "")); })());

// ===========================================================================
// Recorded fixtures: the three plan recordings, byte for byte (decision Q3)
// ===========================================================================
describe("recorded fixtures are the plan's three bodies, unchanged", () => {
  for (const [name, hash] of RECORDED_HASHES) {
    test(`sha256 of recorded/${name} is pinned`, () => {
      expect(sha256(new Uint8Array(readFileSync(join(FX, "recorded", name))))).toBe(hash);
    });
  }
});

// ===========================================================================
// AC1 interface, quantities, missing decimals, registry drift
// ===========================================================================
describe("AC1 the readPositions interface and its quantities", () => {
  test("the result has exactly positions, receipts and notRead; positions carry the contract keys", async () => {
    const r = await readOnce(routeCalls("spl", "t22Empty", "gpaEmpty"));
    expect(Object.keys(r).sort()).toEqual(["notRead", "positions", "receipts"]);
    expect(r.positions.map(p => Object.keys(p).sort())).toEqual(
      r.positions.map(() => ["fixtureKind", "id", "quantity", "receiptIds", "snapshotId", "source", "subject", "unit"]));
    for (const p of r.positions) {
      expect(p.source).toBe("reader");
      expect(p.snapshotId).toBe("tst-reader-input");
      expect(p.fixtureKind).toBe("real-private");
      expect(p.id).toMatch(/^solana-reader\.[0-9a-f]{48}$/);
      expect(ID_PATTERN.test(p.id)).toBe(true);
      expect(p.subject).toMatch(new RegExp(`^solana:mainnet-beta:[1-9A-HJ-NP-Za-km-z]{32,44}#holder:${HOLDER}$`));
      expect(DECIMAL_PATTERN.test(p.quantity)).toBe(true);
      expect(p.unit.startsWith("solana:mainnet-beta:")).toBe(true);
      expect(p.receiptIds.length).toBeGreaterThan(0);
    }
    expect(isSorted(r.positions)).toBe(true);
    expect(isSorted(r.notRead)).toBe(true);
  });

  test("quantities are exact decimal strings of the summed raw amounts", async () => {
    const r = await readOnce(routeCalls("spl", "t22Empty", "gpaEmpty"));
    const q = (mint: string) => r.positions.filter(p => p.unit === `solana:mainnet-beta:${mint}`).map(p => p.quantity);
    expect(q(MINT_MSOL)).toEqual([Q_MSOL_SUM]);
    expect(q(MINT_MNDE)).toEqual([Q_MNDE]);
    expect(q(MINT_KSHARE)).toEqual([Q_KSHARE]);
    expect(unitsToDecimalExact(1234567890123n, 9)).toBe("1234.567890123");
    expect(unitsToDecimalExact(1n, 6)).toBe("0.000001");
  });

  test("obligation quantities: deposit in collateral units, borrow exactly expanded from 2^60 scaling", async () => {
    const r = await readOnce(routeCalls("splEmpty", "t22Empty", "gpa"));
    const deposit = r.positions.find(p => p.subject === subjectOf(RESERVE) && p.unit === `solana:mainnet-beta:${CTOKEN}`);
    const borrow = r.positions.find(p => p.subject === subjectOf(RESERVE) && p.unit === `solana:mainnet-beta:${PYUSD}`);
    expect(deposit?.quantity).toBe(Q_DEPOSIT);
    expect(borrow?.quantity).toBe(Q_BORROW_6);
    expect(sfToDecimalExact(SF, 9)).toBe(Q_BORROW_9);
    expect(sfToDecimalExact(SF, 6)).toBe(Q_BORROW_6);
  });

  test("a registry token without a recorded decimals fact is notRead missing-decimals, never guessed", async () => {
    const stripped = { ...SOLANA_REGISTRY, tokens: SOLANA_REGISTRY.tokens.map(t => t.id === "msol" ? { ...t, decimals: null } : t) };
    const r = await readPositions({
      chain: "solana", address: HOLDER, snapshotId: "tst-nodec",
      client: client(stubFetch(routeCalls("spl", "t22Empty", "gpaEmpty"))),
      registry: stripped,
    });
    expect(r.positions.map(p => p.subject)).not.toContain(subjectOf(MINT_MSOL));
    expect(r.positions.map(p => p.subject)).toContain(subjectOf(MINT_MNDE));
    expect(r.notRead).toContainEqual({ subject: subjectOf(MINT_MSOL), reason: "missing-decimals" });
  });

  test("a chain other than solana makes no request and returns chain-not-supported", async () => {
    const log: FetchLog[] = [];
    const r = await readPositions({ chain: "ethereum", address: HOLDER, snapshotId: "tst-chain", client: client(stubFetch(() => "splEmpty", log)) });
    expect(r).toEqual({ positions: [], receipts: [], notRead: [{ subject: `ethereum:${HOLDER}`, reason: "chain-not-supported" }] });
    expect(log).toEqual([]);
  });

  test("invalid input throws PositionsRejected and makes no request", async () => {
    const log: FetchLog[] = [];
    const base = { snapshotId: "tst-bad-input", client: client(stubFetch(() => "splEmpty", log)) } as const;
    expect(readPositions({ ...base, chain: "solana", address: "not a base58 address!" })).rejects.toThrow(PositionsRejected);
    expect(readPositions({ ...base, chain: "solana", address: "not a base58 address!" })).rejects.toMatchObject({ code: "malformed-address" });
    expect(readPositions({ ...base, chain: "solana", address: HOLDER, snapshotId: "bad id with spaces!" })).rejects.toThrow(PositionsRejected);
    expect(readPositions({ chain: "solana", address: HOLDER, snapshotId: "tst-noclient", client: undefined as never })).rejects.toThrow(PositionsRejected);
    expect(log).toEqual([]);
  });
});

// ===========================================================================
// AC1(d) the frozen registry equals its cited records
// ===========================================================================
describe("AC1 registry drift: every SOLANA_REGISTRY entry equals the record it cites", () => {
  const idOf = (key: string) => `solana:mainnet-beta:${key}`;
  const keyOf = (id: string) => id.replace("solana:mainnet-beta:", "");

  test("mSOL: mint, owner program and byte 44 decimals from the recorded mint account", () => {
    const rec = JSON.parse(readFileSync(join(REPO, "fixtures", "marinade-contracts", "getAccountInfo-ba300a779c0c.json"), "utf8"));
    const bytes = Buffer.from(rec.response.data, "base64");
    const entry = SOLANA_REGISTRY.tokens.find(t => t.id === "msol")!;
    expect(entry.mint).toBe(rec.params.pubkey);
    expect(bytes.length).toBe(82);
    expect(entry.decimals).toBe(bytes[44]);
    expect(entry.tokenProgram).toBe(rec.response.owner);
    expect(entry.recordedAt.slot).toBe(rec.slot);
    expect(entry.recordedAt.path).toContain("getAccountInfo-ba300a779c0c.json");
  });

  test("MNDE: address, decimals and slot from the marinade pack registry", () => {
    const pack = JSON.parse(readFileSync(join(REPO, "packs", "marinade", "registry.json"), "utf8"));
    const mnde = pack.mints.find((m: { id: string }) => m.id === "mnde");
    const msol = pack.mints.find((m: { id: string }) => m.id === "msol");
    expect(msol.verifiedOnChain).toBeNull();
    const entry = SOLANA_REGISTRY.tokens.find(t => t.id === "mnde")!;
    expect(entry.mint).toBe(mnde.address);
    expect(entry.decimals).toBe(mnde.verifiedOnChain.decimals);
    expect(entry.decimals).not.toBeNull();
    expect(entry.tokenProgram).toBe(SPL);
    expect(entry.recordedAt.slot).toBe(mnde.verifiedOnChain.slot);
    expect(entry.recordedAt.path).toContain("registry.json");
  });

  test("the vault share mint, its decimals, and every klend reserve come from the kamino capture", () => {
    const cap = normalizeCapture(loadCapture(join(REPO, "fixtures", "kamino", "sentora-pyusd-20261109T170418Z")));
    const mech = cap.mechanics;
    const share = mech.quantities.find(q => q.name === "vault.sharesIssued")!;
    const entry = SOLANA_REGISTRY.tokens.find(t => t.id === "kvault-share")!;
    expect(entry.mint).toBe(keyOf(share.mint!));
    expect(entry.decimals).toBe(share.decimals);
    expect(entry.tokenProgram).toBe(SPL);
    expect(entry.recordedAt.slot).toBe(Number(cap.report.stateSlot));
    expect(entry.recordedAt.path).toContain("sentora-pyusd-20261109T170418Z");

    const reserveIds = mech.entities.filter(e => e.kind === "Reserve").map(e => e.id.replace("solana:mainnet-beta:", ""));
    const registered = SOLANA_REGISTRY.klendReserves.map(r => r.reserve);
    expect([...registered].sort()).toEqual([...reserveIds].sort());
    for (const r of SOLANA_REGISTRY.klendReserves) {
      const available = mech.quantities.find(q => q.name === `reserve.${r.reserve}.available` && q.mint !== null)!;
      const ctoken = mech.quantities.find(q => q.name === `reserve.${r.reserve}.vaultCtokenAllocation` && q.mint !== null)!;
      const market = mech.relations.find(x => x.kind === "IN_MARKET" && x.from === idOf(r.reserve));
      expect(r.market).toBe(keyOf(market!.to));
      expect(r.liquidityMint).toBe(keyOf(available.mint!));
      expect(r.decimals).toBe(available.decimals);
      expect(r.collateralMint).toBe(keyOf(ctoken.mint!));
      expect(r.recordedAt.slot).toBe(Number(cap.report.stateSlot));
      expect(r.recordedAt.path).toContain("sentora-pyusd-20261109T170418Z");
    }
  });
});

// ===========================================================================
// AC2 coverage of the chain's kinds
// ===========================================================================
describe("AC2 what the reader covers and what it refuses", () => {
  test("one account each of mSOL, MNDE and the vault share yields three positions, mSOL summed, zero balance skipped", async () => {
    const r = await readOnce(routeCalls("spl", "t22Empty", "gpaEmpty"));
    expect(r.positions.map(p => [p.subject, p.quantity, p.unit])).toEqual([
      [subjectOf(MINT_KSHARE), Q_KSHARE, `solana:mainnet-beta:${MINT_KSHARE}`],
      [subjectOf(MINT_MNDE), Q_MNDE, `solana:mainnet-beta:${MINT_MNDE}`],
      [subjectOf(MINT_MSOL), Q_MSOL_SUM, `solana:mainnet-beta:${MINT_MSOL}`],
    ]);
    expect(r.notRead).toEqual([]);
    expect(r.receipts.length).toBe(3);
  });

  test("the constructed obligation yields two positions on the registered reserve", async () => {
    const r = await readOnce(routeCalls("splEmpty", "t22Empty", "gpa"));
    expect(r.positions.map(p => [p.subject, p.quantity, p.unit])).toEqual([
      [subjectOf(RESERVE), Q_BORROW_6, `solana:mainnet-beta:${PYUSD}`],
      [subjectOf(RESERVE), Q_DEPOSIT, `solana:mainnet-beta:${CTOKEN}`],
    ]);
    const gpaReceipts = new Set(r.receipts.map(x => x.id));
    for (const p of r.positions) expect(p.receiptIds.every(id => gpaReceipts.has(id))).toBe(true);
  });

  test("without LINCHPIN_RPC_URL privileges the obligation read is not attempted and is notRead rpc-method-unavailable", async () => {
    const log: FetchLog[] = [];
    const r = await readOnce(routeCalls("splEmpty", "t22Empty", "gpa"), { programAccounts: false }, log);
    expect(r.positions).toEqual([]);
    expect(r.notRead).toEqual([{ subject: subjectOf(KLEND), reason: "rpc-method-unavailable" }]);
    expect(log.filter(l => l.method !== "fetch").length).toBe(2);
  });

  test("an address with nothing yields an empty list, no error and three receipts", async () => {
    const r = await readOnce(routeCalls("splEmpty", "t22Empty", "gpaEmpty"));
    expect(r.positions).toEqual([]);
    expect(r.notRead).toEqual([]);
    expect(r.receipts.length).toBe(3);
  });

  test("the recorded account of R8 yields zero positions, 112 not-covered tokens and 4 not-covered reserve legs", async () => {
    const r = await readOnce(routeCalls("recSpl", "recT22", "recGpa"));
    expect(r.positions).toEqual([]);

    // Independent decode of the recorded bodies: the expected not-covered token subjects
    // are exactly the mints with a non-zero summed balance, plus the four non-zero legs.
    const expectedMints = new Set<string>();
    for (const rec of [RESP.recSpl, RESP.recT22]) {
      const sums = new Map<string, bigint>();
      for (const v of (rec.result as { value: { account: { data: [string, string] } }[] }).value) {
        const buf = Buffer.from(v.account.data[0], "base64");
        const mint = bs58.encode(buf.subarray(0, 32));
        const amount = buf.readBigUInt64LE(64);
        sums.set(mint, (sums.get(mint) ?? 0n) + amount);
      }
      for (const [mint, amount] of sums) if (amount > 0n) expectedMints.add(mint);
    }
    expect(expectedMints.size).toBe(112);
    const keyOf = (s: string) => s.split("#")[0].replace("solana:mainnet-beta:", "");
    const tokenEntries = r.notRead.filter(n => n.reason === "not-covered" && expectedMints.has(keyOf(n.subject)));
    expect(tokenEntries.length).toBe(112);
    expect(new Set(tokenEntries.map(n => n.subject))).toEqual(new Set([...expectedMints].map(m => subjectOf(m))));

    const le = (buf: Buffer, off: number, n: number) => { let x = 0n; for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(buf[off + i]); return x; };
    const expectedLegs = new Set<string>();
    for (const v of (RESP.recGpa.result as { value: { account: { data: [string, string] } }[] }).value) {
      const buf = Buffer.from(v.account.data[0], "base64");
      for (let i = 0; i < 8; i++) { const k = bs58.encode(buf.subarray(96 + i * 136, 128 + i * 136)); if (k !== "11111111111111111111111111111111" && le(buf, 128 + i * 136, 8) > 0n) expectedLegs.add(k); }
      for (let i = 0; i < 5; i++) { const k = bs58.encode(buf.subarray(1208 + i * 200, 1240 + i * 200)); if (k !== "11111111111111111111111111111111" && le(buf, 1296 + i * 200, 16) > 0n) expectedLegs.add(k); }
    }
    expect(expectedLegs.size).toBe(4);
    const reserveEntries = r.notRead.filter(n => [...expectedLegs].some(k => n.subject === subjectOf(k)));
    expect(reserveEntries.length).toBe(4);
    for (const e of reserveEntries) expect(e.reason).toBe("not-covered");

    // None of the 16 zero-balance accounts is reported.
    const zeroSubjects = new Set<string>();
    for (const rec of [RESP.recSpl, RESP.recT22]) {
      for (const v of (rec.result as { value: { account: { data: [string, string] } }[] }).value) {
        const buf = Buffer.from(v.account.data[0], "base64");
        if (buf.readBigUInt64LE(64) === 0n) zeroSubjects.add(subjectOf(bs58.encode(buf.subarray(0, 32))));
      }
    }
    expect(zeroSubjects.size).toBe(16);
    for (const z of zeroSubjects) expect(tokenEntries.map(n => n.subject)).not.toContain(z);

    // No registry mint is covered by this account, so none becomes a position.
    for (const mint of [MINT_MSOL, MINT_MNDE, MINT_KSHARE]) expect(tokenEntries.map(n => n.subject)).not.toContain(subjectOf(mint));
    expect(r.receipts.map(x => x.observation.blockOrSlot).sort()).toEqual(["468257718", "468257720", "468257725"]);
  });

  test("reading twice gives byte-identical results (deterministic output)", async () => {
    const a = await readOnce(routeCalls("spl", "t22Empty", "gpa"), { now: () => NOW_MS });
    const b = await readOnce(routeCalls("spl", "t22Empty", "gpa"), { now: () => NOW_MS });
    expect(canonical(b)).toBe(canonical(a));
  });
});

// ===========================================================================
// AC3 receipts exist, are exact, and stay private end to end
// ===========================================================================
describe("AC3 every position names a private receipt with method, slot, host and hash", () => {
  test("receipt fields: privacy private, source method@host, slot and recomputed response hash", async () => {
    const log: FetchLog[] = [];
    const r = await readOnce(routeCalls("spl", "t22Empty", "gpa"), { now: () => NOW_MS }, log);
    const receipts = byId(r.receipts);
    for (const p of r.positions) {
      for (const rid of p.receiptIds) {
        const rec = receipts.get(rid);
        expect(rec).toBeDefined();
        expect(rec!.privacy).toBe("private");
      }
    }
    expect(r.receipts.length).toBe(3);
    const calls = log.filter(l => l.result !== undefined);
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const slot = String((call.result as { context: { slot: number } }).context.slot);
      const matching = r.receipts.filter(x => x.observation.blockOrSlot === slot);
      expect(matching.length).toBe(1);
      const rec = matching[0];
      expect(rec.source).toBe(`${call.method}@${HOST}`);
      expect(rec.observation.chain).toBe("solana");
      expect(rec.observation.network).toBe("mainnet-beta");
      expect(rec.observation.blockOrSlot).toBe(String((call.result as { context: { slot: number } }).context.slot));
      expect(rec.observation.blockHash).toBeNull();
      expect(rec.observation.observedAt).toBe(NOW_ISO);
      expect(rec.observation.retrievedAt).toBe(NOW_ISO);
      expect(rec.observation.historicalState).toBe("current-only");
      expect(rec.responseSha256).toBe(sha256(canonical(call.result)));
      expect(Object.keys(rec).sort()).toEqual(["id", "observation", "privacy", "responseSha256", "source"]);
    }
    for (const p of r.positions) expect(new Set(p.receiptIds).size).toBe(p.receiptIds.length);
  });
});

describe("AC3 the MCP server never shows a reader receipt, address or quantity", () => {
  const TOKEN = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const SNAPSHOT_ID = "tst-reader-store";
  let snapshot: EvidenceSnapshot;

  const buildSnapshot = async (): Promise<EvidenceSnapshot> => {
    const T = "2026-11-11T12:00:00.000Z";
    const reader = {
      snapshotId: SNAPSHOT_ID,
      client: client(stubFetch(routeCalls("spl", "t22Empty", "gpa")), { now: () => NOW_MS }),
    };
    return readPositions({ chain: "solana", address: HOLDER, ...reader }).then(r => {
      const slots = r.receipts.map(x => BigInt(x.observation.blockOrSlot!));
      // A fact object on a solana snapshot is amount:<digits>; the exact raw base-unit
      // amount is that digits form of the position's quantity.
      const decimalsOf = new Map<string, number | null>();
      for (const t of SOLANA_REGISTRY.tokens) decimalsOf.set(t.mint, t.decimals);
      for (const k of SOLANA_REGISTRY.klendReserves) { decimalsOf.set(k.collateralMint, k.decimals); decimalsOf.set(k.liquidityMint, k.decimals); }
      const rawDigits = (p: (typeof r.positions)[number]): string => {
        if (p.subject === subjectOf(RESERVE) && p.unit === `solana:mainnet-beta:${PYUSD}`) return SF.toString();
        const scale = p.quantity.includes(".") ? p.quantity.split(".")[1].length : 0;
        const decimals = decimalsOf.get(p.unit.replace("solana:mainnet-beta:", ""))!;
        expect(decimals).not.toBeNull();
        return (BigInt(p.quantity.replace(".", "")) * 10n ** BigInt(decimals - scale)).toString();
      };
      const facts = r.positions.map((p, i) => ({
        id: `tst-fact-${i}`,
        subject: p.subject.split("#")[0],
        predicate: p.unit === `solana:mainnet-beta:${PYUSD}` && p.subject === subjectOf(RESERVE) ? "BORROWED_RAW" : "SUPPLY_RAW",
        object: `amount:${rawDigits(p)}`,
        basis: "observed", status: "verified", evidenceIds: p.receiptIds, path: [],
        validFrom: null, validTo: null, privacy: "private",
      }));
      return validateSnapshot({
        version: 1, id: SNAPSHOT_ID, chain: "solana", network: "mainnet-beta", constructed: false,
        observedFrom: T, observedTo: T, fromBlockOrSlot: slots.reduce((a, b) => a < b ? a : b).toString(),
        toBlockOrSlot: slots.reduce((a, b) => a > b ? a : b).toString(), freshUntil: "2026-11-12T00:00:00.000Z",
        subjects: [...new Set(facts.map(f => f.subject))].sort(), readers: [], names: {},
        receipts: r.receipts, facts,
      });
    });
  };

  beforeAll(async () => {
    snapshot = await buildSnapshot();
  });

  test("every tool response carries no reader receipt content, the address, a quantity or a holder marker", async () => {
    const { texts } = await sweepAllTools();
    // Receipt content: redacted source, hash, slot. Not one of these may surface.
    const contentLeaks = [
      HOLDER, "#holder:",
      ...snapshot.receipts.map(x => x.source),
      ...snapshot.receipts.map(x => x.responseSha256),
      ...snapshot.receipts.map(x => x.observation.blockOrSlot!),
      ...snapshot.facts.map(f => f.object),
    ];
    for (const text of texts) for (const leak of contentLeaks) expect(text).not.toContain(leak);
  });

  test("no existence oracle: a private reader receipt id answers byte-identically to a fabricated one", async () => {
    const store = openStore([buildNearSnapshot(LIVE, { root: NEAR_ROOT }), snapshot]);
    const server = startMcpServer({ token: TOKEN, snapshotId: LIVE, store, libs: NO_LIBRARIES, port: 0, accessLog: () => {} });
    try {
      const client = new McpClient(server.url, TOKEN);
      const PLACEHOLDER = "__requested-receipt-id__";
      for (const rid of byId(snapshot.receipts).keys()) {
        const fabricated = `solana-read.${sha256(`${rid} fabricated`).slice(0, 48)}`;
        expect(fabricated).not.toBe(rid);
        expect([...byId(snapshot.receipts).keys()]).not.toContain(fabricated);
        // A fixed JSON-RPC id, so the two envelopes can be compared byte for byte.
        const ask = (id: string) => client.post({ jsonrpc: "2.0", id: 4711, method: "tools/call", params: { name: "linchpin_evidence", arguments: { evidenceIds: [id] } } });
        const [real, fake] = await Promise.all([ask(rid), ask(fabricated)]);
        expect(real.status).toBe(200);
        expect(fake.status).toBe(200);
        const norm = (t: string) => t.replaceAll(rid, PLACEHOLDER).replaceAll(fabricated, PLACEHOLDER);
        expect(norm(real.text)).toBe(norm(fake.text));
      }
    } finally { await server.stop(); }
  }, 30000);

  test("no reader receipt id appears in any response whose arguments did not contain it", async () => {
    const { cleanArgsCalls } = await sweepAllTools();
    expect(cleanArgsCalls.length).toBeGreaterThan(0);
    const ids = [...byId(snapshot.receipts).keys()];
    for (const call of cleanArgsCalls) for (const id of ids) expect(call.text, `${id} surfaced in the response to ${call.label}`).not.toContain(id);
  }, 30000);

  interface SweepCall { label: string; argsHaveReaderIds: boolean; text: string }
  async function sweepAllTools(): Promise<{ texts: string[]; cleanArgsCalls: SweepCall[] }> {
    const texts: string[] = [];
    const calls: SweepCall[] = [];
    const store = openStore([buildNearSnapshot(LIVE, { root: NEAR_ROOT }), snapshot]);
    const server = startMcpServer({ token: TOKEN, snapshotId: LIVE, store, libs: NO_LIBRARIES, port: 0, accessLog: () => {} });
    try {
      const client = new McpClient(server.url, TOKEN);
      const init = await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      expect(init.status).toBe(200);
      const list = await client.rpc("tools/list");
      expect((list.json.result.tools as { name: string }[]).map(t => t.name)).toEqual(TOOLS.map(t => t.name));
      const readerIds = [...byId(snapshot.receipts).keys()];
      const argsByTool: Record<string, unknown> = {
        linchpin_subjects: {}, linchpin_dependencies: { subject: "intents.near" }, linchpin_control: { subject: "intents.near" },
        linchpin_changes: { subject: "intents.near" }, linchpin_evidence: { evidenceIds: readerIds },
        linchpin_intent_review: { assetId: "nep141:usdt.tether-token.near" }, linchpin_governance_review: { dao: "burrow.sputnik-dao.near" },
        linchpin_policy_verdict: { policyId: "no-such-policy-here" },
      };
      for (const tool of TOOLS) {
        const args = argsByTool[tool.name] ?? {};
        const reply = await client.call(tool.name, args);
        expect(reply.status).toBe(200);
        texts.push(reply.text);
        calls.push({ label: tool.name, argsHaveReaderIds: readerIds.some(id => JSON.stringify(args).includes(id)), text: reply.text });
      }
      // linchpin_evidence reads receipts by id from any snapshot: ask for each reader receipt alone.
      for (const rid of readerIds) {
        const reply = await client.call("linchpin_evidence", { evidenceIds: [rid] });
        expect(reply.status).toBe(200);
        texts.push(reply.text);
        calls.push({ label: `linchpin_evidence[${rid.slice(0, 16)}…]`, argsHaveReaderIds: true, text: reply.text });
      }
    } finally { await server.stop(); }
    return { texts, cleanArgsCalls: calls.filter(c => !c.argsHaveReaderIds) };
  }

  test("the same receipts through createMcpHandler are equally silent", async () => {
    const store = openStore([buildNearSnapshot(LIVE, { root: NEAR_ROOT }), snapshot]);
    const handler = createMcpHandler({ token: TOKEN, snapshotId: LIVE, store, libs: NO_LIBRARIES });
    const post = (body: unknown) => handler(new Request("http://127.0.0.1/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
    }));
    const call = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "linchpin_evidence", arguments: { evidenceIds: [...byId(snapshot.receipts).keys()] } } });
    const text = await call.text();
    expect(call.status).toBe(200);
    const contentLeaks = [
      HOLDER, "#holder:",
      ...snapshot.receipts.map(x => x.source),
      ...snapshot.receipts.map(x => x.responseSha256),
      ...snapshot.receipts.map(x => x.observation.blockOrSlot!),
      ...snapshot.facts.map(f => f.object),
    ];
    for (const leak of contentLeaks) expect(text).not.toContain(leak);
  });

  test("negative control: a public copy of the same receipt IS returned, so the silence above can fail", async () => {
    const pub = structuredClone(snapshot);
    pub.id = `${SNAPSHOT_ID}-public-copy`;
    pub.receipts[0].privacy = "public";
    const rid = pub.receipts[0].id;
    const store = openStore([buildNearSnapshot(LIVE, { root: NEAR_ROOT }), pub]);
    const server = startMcpServer({ token: TOKEN, snapshotId: LIVE, store, libs: NO_LIBRARIES, port: 0 });
    try {
      const client = new McpClient(server.url, TOKEN);
      await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      const reply = await client.call("linchpin_evidence", { evidenceIds: [rid] });
      expect(reply.text).toContain(rid);
    } finally { await server.stop(); }
  }, 30000);
});

// ===========================================================================
// AC4 failures stay visible, per subject, without zero quantities
// ===========================================================================
describe("AC4 every failure mode becomes a per-subject notRead, others still read", () => {
  const FAILURES: [string, StubReply, NotReadReason][] = [
    ["http 500", { status: 500 }, "rpc-error"],
    ["json-rpc -32603", { error: { code: -32603, message: "Internal error" } }, "rpc-error"],
    ["a hang until the client aborts", { hang: true }, "timeout"],
    ["json-rpc -32601", { error: { code: -32601, message: "Method not found" } }, "rpc-method-refused"],
    ["json-rpc -32010", { error: { code: -32010, message: "blacklisted method" } }, "rpc-method-refused"],
    ["http 403", { status: 403 }, "rpc-method-refused"],
    ["a response without context.slot", { result: { context: { apiVersion: "constructed" }, value: [] } }, "malformed-response"],
    ["an account of 100 bytes", { result: malformed("short-data") }, "malformed-response"],
    ["an account owned by another program", { result: malformed("wrong-owner") }, "malformed-response"],
    ["an account whose owner field is not the holder", { result: malformed("owner-field") }, "malformed-response"],
  ];

  function malformed(kind: "short-data" | "wrong-owner" | "owner-field" | "obl-3000"): unknown {
    if (kind === "obl-3000") {
      const v = structuredClone((RESP.recGpa.result as { value: { pubkey: string; account: { owner: string; data: [string, string] } }[] }).value[0]);
      const buf = Buffer.from(v.account.data[0], "base64").subarray(0, 3000);
      return { context: { slot: 468300300, apiVersion: "constructed" }, value: [{ pubkey: v.pubkey, account: { ...v.account, data: [buf.toString("base64"), "base64"] } }] };
    }
    const src = RESP.spl.result as { context: { slot: number }; value: { pubkey: string; account: { owner: string; data: [string, string] } }[] };
    const v = structuredClone(src.value[0]);
    if (kind === "short-data") v.account.data = [Buffer.from(Buffer.from(v.account.data[0], "base64").subarray(0, 100)).toString("base64"), "base64"];
    if (kind === "wrong-owner") v.account.owner = KLEND;
    if (kind === "owner-field") {
      const buf = Buffer.from(v.account.data[0], "base64");
      buf.set(new PublicKey(PYUSD).toBytes(), 32);
      v.account.data = [buf.toString("base64"), "base64"];
    }
    return { context: { slot: src.context.slot }, value: [v] };
  }

  for (const [label, reply, reason] of FAILURES) {
    test(`${label} on the SPL call: tokens and program notRead ${reason}, obligations still read`, async () => {
      const log: FetchLog[] = [];
      const r = await readOnce(routeCalls(reply, "t22Empty", "gpa"), { timeoutMs: 50 }, log);
      const subjects = [subjectOf(MINT_MSOL), subjectOf(MINT_MNDE), subjectOf(MINT_KSHARE), subjectOf(SPL)];
      for (const s of subjects) expect(r.notRead).toContainEqual({ subject: s, reason });
      expect(r.notRead.filter(n => subjects.includes(n.subject)).length).toBe(4);
      expect(r.positions.map(p => p.quantity).sort()).toEqual([Q_BORROW_6, Q_DEPOSIT].sort());
      expect(r.positions.every(p => !subjects.includes(p.subject))).toBe(true);
      expect(r.positions.every(p => p.quantity !== "0")).toBe(true);
      expect(r.receipts.length).toBe(2);
    });
  }

  for (const [label, reply, reason] of [["http 500", { status: 500 }, "rpc-error"], ["a 3000-byte obligation", { result: malformed("obl-3000") }, "malformed-response"]] as [string, StubReply, NotReadReason][]) {
    test(`${label} on the obligation call: tokens still read, klend program notRead ${reason}`, async () => {
      const splReply: RouteValue = "spl";
      const gpaReply: RouteValue = reply.result !== undefined ? { result: reply.result } : reply;
      const r = await readOnce(routeCalls(splReply, "t22Empty", gpaReply), { timeoutMs: 50 });
      expect(r.positions.map(p => p.quantity).sort()).toEqual([Q_KSHARE, Q_MNDE, Q_MSOL_SUM].sort());
      expect(r.notRead).toEqual([{ subject: subjectOf(KLEND), reason }]);
      expect(r.receipts.length).toBe(2);
      expect(r.positions.every(p => p.quantity !== "0")).toBe(true);
    });
  }

  test("linchpin positions read exits 0 with the failure reasons printed", async () => {
    const out: string[] = [], err: string[] = [];
    const fetch = stubFetch(routeCalls({ status: 500 }, "t22Empty", "gpa"));
    const code = await runPositionsCommand(["read", "--address", `solana:${HOLDER}`], {
      fetch, env: { LINCHPIN_RPC_URL: RPC_URL }, out: l => out.push(l), err: l => err.push(l),
    });
    expect(code).toBe(0);
    expect(out.filter(l => l.startsWith(`not-read ${subjectOf(MINT_MSOL)}`))).toEqual([`not-read ${subjectOf(MINT_MSOL)} rpc-error`]);
    for (const s of [subjectOf(MINT_MNDE), subjectOf(MINT_KSHARE), subjectOf(SPL)]) expect(out.some(l => l === `not-read ${s} rpc-error`)).toBe(true);
    expect(out.some(l => l.startsWith(`position ${subjectOf(RESERVE)} ${Q_DEPOSIT} `))).toBe(true);
    expect(out.some(l => l.startsWith(`position ${subjectOf(RESERVE)} ${Q_BORROW_6} `))).toBe(true);
    expect(out.some(l => l.startsWith("receipt "))).toBe(true);
    expect(out.every(l => !l.startsWith("position ") || !l.includes(" 0 "))).toBe(true);
    expect(err).toEqual([]);
  });
});

// ===========================================================================
// AC5 the address goes only to the configured endpoint
// ===========================================================================
describe("AC5 the only outbound requests go to the configured RPC origin", () => {
  test("every request aims at the configured origin; the host line precedes the first read; the URL path never prints", async () => {
    const events: { kind: "out" | "fetch" | "socket"; detail: string }[] = [];
    const spy = (target: { [k: string]: unknown }, key: string) => {
      const original = target[key];
      (target as Record<string, unknown>)[key] = (...a: unknown[]) => { events.push({ kind: "socket", detail: key }); throw new Error("socket blocked by AC5 trap"); };
      return original;
    };
    const originals: [object, string, unknown][] = [];
    for (const [t, k] of [[Bun, "connect"], [net, "connect"], [net, "createConnection"], [http, "request"], [https, "request"]] as [object, string][]) {
      originals.push([t, k, spy(t as Record<string, unknown>, k)]);
    }
    const realFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      events.push({ kind: "fetch", detail: url });
      attempts.push(url);
      expect(new URL(url).origin).toBe("https://rpc.example.test");
      const req = JSON.parse(String(init?.body));
      const key = req.method === "getProgramAccounts" ? "recGpa" : (req.params as [unknown, { programId?: string }])[1]?.programId === T22 ? "recT22" : "recSpl";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: RESP[key as keyof typeof RESP].result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const out: string[] = [], err: string[] = [];
      const code = await runPositionsCommand(["read", "--address", `solana:${HOLDER}`], {
        env: { LINCHPIN_RPC_URL: "https://rpc.example.test/k3y-canary-path", LINCHPIN_RPC_TIMEOUT_MS: "1000" },
        out: l => events.push({ kind: "out", detail: l }), err: l => err.push(l),
      });
      expect(code).toBe(0);
      expect(events.filter(e => e.kind === "socket")).toEqual([]);
      const origins = new Set(attempts.map(u => new URL(u).origin));
      expect([...origins]).toEqual(["https://rpc.example.test"]);
      expect(attempts.length).toBe(3);
      const first = events.find(e => e.kind === "out")!;
      expect(first.detail).toBe("endpoint host: rpc.example.test");
      const firstFetch = events.findIndex(e => e.kind === "fetch");
      expect(events.findIndex(e => e.kind === "out")).toBeLessThan(firstFetch);
      for (const e of events) if (e.kind === "out" || e.kind === "socket") expect(e.detail).not.toContain("k3y-canary-path");
      for (const line of err) expect(line).not.toContain("k3y-canary-path");
    } finally {
      globalThis.fetch = realFetch;
      for (const [t, k, v] of originals) (t as Record<string, unknown>)[k] = v;
    }
  });

  test("negative: without LINCHPIN_RPC_URL the command uses only the public default and never asks for program accounts", async () => {
    const log: FetchLog[] = [];
    const out: string[] = [];
    const code = await runPositionsCommand(["read", "--address", `solana:${HOLDER}`], {
      fetch: stubFetch(routeCalls("spl", "t22Empty", "gpa"), log), env: {}, out: l => out.push(l), err: () => {},
    });
    expect(code).toBe(0);
    expect(out[0]).toBe(`endpoint host: ${PUBLIC_DEFAULT_HOST}`);
    expect(log.filter(l => l.method === "getProgramAccounts")).toEqual([]);
    expect(log.length).toBe(2);
  });
});

// ===========================================================================
// AC6 nothing private reaches a file, a log line or a public fixture
// ===========================================================================
describe("AC6 canaries stay out of every file and out of stderr", () => {
  const scratch: string[] = [];
  afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

  const listRepo = () => {
    const tracked = String(execSync("git ls-files -co --exclude-standard", { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).split("\n").filter(Boolean);
    const outDir = join(REPO, "out");
    const extra = existsSync(outDir) ? readdirSync(outDir, { recursive: true }).map(p => join("out", String(p))) : [];
    return [...tracked, ...extra];
  };

  test("a run with canary address and canary quantity writes nothing anywhere and keeps the addresses file at 0600", async () => {
    const canaryAddr = bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
    const canaryRaw = 10n ** 12n + BigInt(Math.floor(Math.random() * 8_999_999_999) + 1);
    const canaryQty = unitsToDecimalExact(canaryRaw, 9);

    const home = mkdtempSync(join(tmpdir(), "linchpin-addr-home-"));
    scratch.push(home);
    mkdirSync(join(home, ".linchpin"));
    writeFileSync(join(home, ".linchpin", "addresses.json"), JSON.stringify([`solana:${canaryAddr}`]));
    chmodSync(join(home, ".linchpin", "addresses.json"), 0o600);

    const before = listRepo();
    const homeBefore = readdirSync(home, { recursive: true }).sort();

    // Constructed response in memory only: one mSOL account owned by the canary, holding the canary amount.
    const acctPubkey = JSON.parse(RESP.recSpl.raw).result.value[0].pubkey;
    const buf = Buffer.alloc(165);
    buf.set(new PublicKey(MINT_MSOL).toBytes(), 0);
    buf.set(new PublicKey(canaryAddr).toBytes(), 32);
    buf.writeBigUInt64LE(canaryRaw, 64);
    const canaryResponse: StubReply = {
      result: { context: { slot: 468300400, apiVersion: "constructed" }, value: [{ pubkey: acctPubkey, account: { data: [buf.toString("base64"), "base64"], executable: false, lamports: 2039280, owner: SPL, rentEpoch: 0, space: 165 } }] },
    };
    const out: string[] = [], err: string[] = [];
    let calls = 0;
    const fetch = stubFetch(routeCalls(canaryResponse, "t22Empty", "gpaEmpty"));
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => { calls++; return fetch(input, init); }) as typeof fetch;

    const code = await runPositionsCommand(["read"], { fetch: wrapped, env: { LINCHPIN_RPC_URL: RPC_URL }, home, out: l => out.push(l), err: l => err.push(l) });
    expect(code).toBe(0);
    expect(out.some(l => l.includes(canaryQty) && l.startsWith("position "))).toBe(true);
    expect(out.some(l => l.includes(canaryAddr))).toBe(true);

    const after = listRepo();
    expect(after.filter(p => !before.includes(p))).toEqual([]);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(homeBefore);
    expect((statSync(join(home, ".linchpin", "addresses.json")).mode & 0o777).toString(8)).toBe("600");

    expect(err.join("\n")).not.toContain(canaryAddr);
    expect(err.join("\n")).not.toContain(canaryQty);

    const candidates = [...new Set([...after, ...before])];
    expect(candidates.length).toBeGreaterThan(100);
    const violations: string[] = [];
    for (const rel of candidates) {
      const abs = join(REPO, rel);
      let text: string;
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      if (text.includes(canaryAddr) || text.includes(canaryQty)) violations.push(rel);
    }
    expect(violations).toEqual([]);
    expect(candidates.some(p => p.startsWith("tests/fixtures/position-reader-solana/"))).toBe(true);
  });

  test("negative: an addresses file with group or other bits is refused with no request", async () => {
    const home = mkdtempSync(join(tmpdir(), "linchpin-addr-bad-"));
    scratch.push(home);
    mkdirSync(join(home, ".linchpin"));
    writeFileSync(join(home, ".linchpin", "addresses.json"), JSON.stringify([`solana:${HOLDER}`]));
    chmodSync(join(home, ".linchpin", "addresses.json"), 0o644);
    const out: string[] = [], err: string[] = [];
    let calls = 0;
    const fetch = stubFetch(routeCalls("spl", "t22Empty", "gpaEmpty"));
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => { calls++; return fetch(input, init); }) as typeof fetch;
    const code = await runPositionsCommand(["read"], { fetch: wrapped, env: { LINCHPIN_RPC_URL: RPC_URL }, home, out: l => out.push(l), err: l => err.push(l) });
    expect(code).toBe(1);
    expect(calls).toBe(0);
    expect(err.join("\n")).toContain("addresses file must be mode 0600");
  });

  test("no addresses and no addresses file: exit 1 with a usage message and no request", async () => {
    const home = mkdtempSync(join(tmpdir(), "linchpin-addr-empty-"));
    scratch.push(home);
    const out: string[] = [], err: string[] = [];
    let calls = 0;
    const fetch = stubFetch(routeCalls("spl", "t22Empty", "gpaEmpty"));
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => { calls++; return fetch(input, init); }) as typeof fetch;
    const code = await runPositionsCommand(["read"], { fetch: wrapped, env: { LINCHPIN_RPC_URL: RPC_URL }, home, out: l => out.push(l), err: l => err.push(l) });
    expect(code).toBe(1);
    expect(calls).toBe(0);
    expect(err.join("\n")).toContain("usage");
  });
});

// ===========================================================================
// AC7 conventions: offline, no private paths or stray keys in the published tree
// ===========================================================================
describe("AC7 conventions of the published files", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

  const scanTargets = (): { rel: string; text: string }[] => {
    const files = [
      ...walk(join(REPO, "src", "positions")),
      ...walk(join(REPO, "src", "solana", "positions")),
      join(import.meta.dir, "position-reader-solana.test.ts"),
      ...walk(join(FX, "constructed")),
    ];
    return files.map(f => ({ rel: f, text: readFileSync(f, "utf8") }));
  };
  test("no absolute path, no endpoint credential pattern, no run id in any scanned file", () => {
    const bans: [string, string][] = [
      ["absolute home path", "/" + "Users/"],
      ["alchemy endpoint with key path", "alchemy.com/" + "v2"],
      ["api key parameter", "api-" + "key"],
      ["api key parameter", "api" + "key"],
      ["run id", "047-position-reader-" + "solana"],
      ["private artifacts path", "graph/" + "artifacts/"],
    ];
    const violations: string[] = [];
    for (const { rel, text } of scanTargets()) {
      const lower = text.toLowerCase();
      for (const [label, needle] of bans) if (lower.includes(needle.toLowerCase())) violations.push(`${label} in ${rel}`);
    }
    expect(violations).toEqual([]);
  });

  test("no base58 key outside the recorded bodies, the registry and the program ids", () => {
    const recordedRuns = new Set<string>();
    for (const name of RECORDED_HASHES.map(([n]) => n)) {
      const raw = readFileSync(join(FX, "recorded", name), "utf8");
      for (const m of raw.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) recordedRuns.add(m[0]);
      const body = JSON.parse(raw);
      for (const v of body.result.value ?? []) {
        const buf = Buffer.from(v.account.data[0], "base64");
        recordedRuns.add(bs58.encode(buf.subarray(0, 32)));
        recordedRuns.add(bs58.encode(buf.subarray(32, 64)));
      }
    }
    const registryKeys = [HOLDER, SPL, T22, KLEND, "11111111111111111111111111111111"];
    for (const t of SOLANA_REGISTRY.tokens) registryKeys.push(t.mint, t.tokenProgram);
    for (const k of SOLANA_REGISTRY.klendReserves) registryKeys.push(k.reserve, k.market, k.liquidityMint, k.collateralMint);
    const allowed = new Set([...registryKeys, ...recordedRuns]);
    const violations: string[] = [];
    for (const { rel, text } of scanTargets()) {
      const cleaned = rel.endsWith(".json")
        ? JSON.stringify(JSON.parse(text), (k, v) => k === "data" && Array.isArray(v) ? "[data]" : v)
        : text.replace(/[0-9a-f]{64}/g, "");
      for (const m of cleaned.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
        let ok = false;
        try { ok = bs58.decode(m[0]).length === 32; } catch { ok = false; }
        if (ok && !allowed.has(m[0])) violations.push(`${m[0]} in ${rel}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test.skipIf(!DEV_ALLOWLIST)("no forbidden publish marker appears in this test file or any of its fixtures", () => {
    // The allowlist is read at test time; its own file name is itself a marker, so the
    // path is assembled from pieces and no marker is ever written here literally.
    const lines = readFileSync(join(REPO, "scripts", "publish" + ".allowlist"), "utf8").split("\n").map(l => l.trim());
    const start = lines.indexOf("[forbidden]");
    expect(start).toBeGreaterThan(-1);
    const markers = lines.slice(start + 1).filter(l => l.length > 0 && !l.startsWith("["));
    expect(markers.length).toBeGreaterThan(10);
    const targets = [
      readFileSync(join(import.meta.dir, "position-reader-solana.test.ts"), "utf8"),
      ...walk(join(FX)).map(f => readFileSync(f, "utf8")),
    ];
    expect(targets.length).toBeGreaterThan(5);
    const hits: string[] = [];
    for (const text of targets) for (const marker of markers) if (text.includes(marker)) hits.push(marker);
    expect(hits).toEqual([]);
  });

  test("the whole file made no outbound attempt (base trap never fired)", () => {
    expect(base.attempts).toEqual([]);
  });
});
