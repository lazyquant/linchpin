import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDryQuoteRequest,
  buildRouteEvidence,
  classifyAsset,
  dryQuoteRequestSha256,
  fetchDryQuote,
  findBannedWords,
  intentReviewJson,
  loadIntentContext,
  loadQuoteNotRecorded,
  loadRouteRules,
  loadTokenList,
  ONECLICK_QUOTE_URL,
  ORIGIN_IS_NOT_BACKING_TEXT,
  quoteFacts,
  renderIntentMarkdown,
  reviewIntent,
  validateQuoteFacts,
  verifyQuoteRecord,
} from "../src/near/intents/index";
import type { OmftRouteEvidence, RouteRuleSet } from "../src/near/intents/index";
import { buildIntentSnapshot } from "../src/near/intents/index";
import { openStore, validateSnapshot } from "../src/engine/queries/index";
import { buildNearSnapshot, liveSnapshotIds, nearReads } from "../src/near/reader/index";
import { run as cliRun } from "../src/near/cli/intent";

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_ALLOWLIST = existsSync(join(import.meta.dir, "..", "scripts", "publish" + "." + "allowlist"));

// ---------------------------------------------------------------------------
// 026-near-intent-review — tester node. Offline only: fetch is trapped.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    throw new Error("network disabled in near-intent-review tests");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(fetchCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Shared offline context (loaded once; loadIntentContext does no network I/O).
// ---------------------------------------------------------------------------
const REPO = join(import.meta.dir, "..");
const ONCLICK = join(REPO, "fixtures", "near", "oneclick");
const INTENTS_DIR = join(REPO, "fixtures", "near", "near-2026-11-09", "intents");

const USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const PENGU = "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near";
const WRAP = "nep141:wrap.near";
const POA_CONTROL = "nep141:eth.omft.near";
const CONFLICT_TOKEN = "nep141:sol-1f00bb36e75cfc8e1274c1507cc3054f5b3f3ce1.omft.near";
const ZEC = "nep141:zec.omft.near";
const HOT = "nep245:v2_1.omni.hot.tg:56_11111111111111111111";
const WNAR_1CS = "1cs_v1:sol:spl:3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG";
const RHEA = "1cs_v1:sol:spl:8SMMso8Muv8d6i4WmMDthKt6TN1ysN6937sx3DKLXZqB";

let ctxCache: ReturnType<typeof loadIntentContext> | null = null;
function ctx() {
  if (!ctxCache) ctxCache = loadIntentContext();
  return ctxCache;
}
let rulesCache: RouteRuleSet | null = null;
function rules(): RouteRuleSet {
  if (!rulesCache) rulesCache = loadRouteRules();
  return rulesCache;
}
let evidenceCache: Record<string, OmftRouteEvidence> | null = null;
function routeEvidence(): Record<string, OmftRouteEvidence> {
  if (!evidenceCache) {
    const records = JSON.parse(readFileSync(join(INTENTS_DIR, "route-reads.json"), "utf8")) as Parameters<typeof buildRouteEvidence>[0];
    evidenceCache = buildRouteEvidence(records, rules());
  }
  return evidenceCache;
}
function classify(id: string) {
  return classifyAsset(id, rules(), routeEvidence());
}

// ---------------------------------------------------------------------------
// AC2 — route family classification
// ---------------------------------------------------------------------------
describe("AC2 classification", () => {
  test("one test per family", () => {
    expect(classify(CONFLICT_TOKEN.replace("sol-1f00bb36e75cfc8e1274c1507cc3054f5b3f3ce1", "sol-5ce3bf3a31af18be40ba30f721101b4341690186")).family).toBe("omni_bridge"); // decision-1 on-chain, see below
    expect(classify(HOT).family).toBe("hot_bridge");
    expect(classify(HOT).rule).toBe("nep245-hot");
    expect(classify(PENGU).family).toBe("omni_bridge");
    expect(classify(PENGU).rule).toBe("nep141-omdep");
    expect(classify(WRAP).family).toBe("near_withdrawal");
    expect(classify(WRAP).rule).toBe("nep141-near");
  });

  test("1cs_v1 is undocumented with missing-coverage", () => {
    const c = classify(WNAR_1CS);
    expect(c.family).toBe("undocumented");
    expect(c.rule).toBe("1cs-v1");
    expect(c.reason).toMatchObject({ code: "missing-coverage", subject: null });
    expect(c.reason && c.reason.ref).toBe(`1cs-v1:${WNAR_1CS}`);
  });

  test("malformed ids give family null and missing-subject", () => {
    for (const id of ["nep141:", "nep141:Bad_Acct", "nep245:v2_1.omni.hot.tg", "foo:bar", ""]) {
      const c = classify(id);
      expect(c.parsed).toBeNull();
      expect(c.family).toBeNull();
      expect(c.rule).toBeNull();
      expect(c.reason).toMatchObject({ code: "missing-subject", subject: null, ref: id });
    }
  });

  test("NEP-245 off the HOT contract is undocumented", () => {
    const c = classify("nep245:other.near:1");
    expect(c.family).toBe("undocumented");
    expect(c.rule).toBe("nep245-other");
    expect(c.reason).toMatchObject({ code: "missing-coverage" });
  });

  test("the committed token list reproduces the planned counts", () => {
    const tokens = loadTokenList();
    expect(tokens).toHaveLength(205);
    expect(tokens.filter(t => t.blockchain === "sol")).toHaveLength(22);
    // peter-decision-1 supersedes I2 for `.omft.near`: the rule table alone leaves every
    // `.omft.near` token undetermined until chain evidence decides. The unchanged rules
    // must still reproduce the planned totals (29 near / 36 hot / 9 omdep-omni / 25 undocumented).
    const tableOnly: Record<string, number> = {};
    for (const t of tokens) {
      const c = classifyAsset(t.assetId, rules());
      tableOnly[c.family ?? "undetermined-table"] = (tableOnly[c.family ?? "undetermined-table"] ?? 0) + 1;
    }
    expect(tableOnly).toEqual({ near_withdrawal: 29, hot_bridge: 36, omni_bridge: 9, undocumented: 25, "undetermined-table": 106 });
    // With the recorded route reads, every chain-classified `.omft.near` resolves except
    // zec (controller not read) and tokens without reads.
    const withChain: Record<string, number> = {};
    const undetermined: string[] = [];
    for (const t of tokens) {
      const f = classify(t.assetId).family;
      withChain[f ?? "null"] = (withChain[f ?? "null"] ?? 0) + 1;
      if (!f) undetermined.push(t.assetId);
    }
    expect(withChain).toEqual({ near_withdrawal: 29, poa_bridge: 2, omni_bridge: 24, hot_bridge: 36, undocumented: 25, null: 89 });
    expect(undetermined.every(id => id.endsWith(".omft.near"))).toBe(true);
    // Solana: 22 = 13 omft + 5 omdep + 4 1cs_v1 (token-list composition).
    const sol = tokens.filter(t => t.blockchain === "sol");
    expect(sol.filter(t => t.assetId.endsWith(".omft.near"))).toHaveLength(13);
    expect(sol.filter(t => t.assetId.endsWith(".omdep.near"))).toHaveLength(5);
    expect(sol.filter(t => t.assetId.startsWith("1cs_v1:"))).toHaveLength(4);
  });

  test("sdkVersion and ruleSetSha256 are non-empty and stable", () => {
    const a = classify(WRAP);
    const b = classifyAsset(WRAP, loadRouteRules());
    expect(a.sdkVersion).toBe("0.95.0");
    expect(a.ruleSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ruleSetSha256).toBe(b.ruleSetSha256);
  });
});

// ---------------------------------------------------------------------------
// On-chain `.omft.near` classification (peter-decision-1, binding)
// ---------------------------------------------------------------------------
describe("decision-1 on-chain omft classification", () => {
  test("Solana USDC is omni_bridge migrated from poa, with controller, mapping and relayer evidence", () => {
    const c = classify(USDC);
    expect(c.family).toBe("omni_bridge");
    expect(c.migrated_from).toBe("poa");
    expect(c.rule).toBe("nep141-omft");
    expect(c.reason).toBeNull();
    const ev = routeEvidence()[USDC.replace("nep141:", "")];
    expect(ev.controller?.value).toBe("omni.bridge.near");
    expect(ev.controller?.receipt.observation.blockOrSlot).not.toBeNull();
    expect(ev.mapping?.value).toBe("sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(ev.sourceMetadata && typeof ev.sourceMetadata.value === "object").toBe(true);
    expect(ev.withdrawRelayer).not.toBeNull();
    expect(ev.withdrawRelayer?.basis).toBe("decoded");
  });

  test("the unmigrated PoA control token is poa_bridge (owner_get = omft.near)", () => {
    const c = classify(POA_CONTROL);
    expect(c.family).toBe("poa_bridge");
    expect(c.migrated_from).toBeUndefined();
    const ev = routeEvidence()[POA_CONTROL.replace("nep141:", "")];
    expect(ev.owner?.value).toBe("omft.near");
    expect(ev.mapping?.value ?? null).toBeNull();
  });

  test("sol-1f00bb is poa_bridge with a conflict against the SDK migration table", () => {
    const c = classify(CONFLICT_TOKEN);
    expect(c.family).toBe("poa_bridge");
    expect(c.sdkMigration?.listed).toBe(true);
    expect(c.sdkMigration?.conflict).toBe(true);
    expect(c.reason).toMatchObject({ code: "conflict", subject: `near:mainnet:${CONFLICT_TOKEN.replace("nep141:", "")}` });
    const ev = routeEvidence()[CONFLICT_TOKEN.replace("nep141:", "")];
    expect(ev.owner?.value).toBe("omft.near");
    expect(ev.mapping?.value ?? null).toBeNull();
  });

  test("zec is undetermined", () => {
    const c = classify(ZEC);
    expect(c.family).toBeNull();
    expect(c.reason?.ref).toBe("undetermined");
  });

  test("the SDK 0.95.0 table is pinned by sha256 in the route-rule fixture", () => {
    const fixture = JSON.parse(readFileSync(join(ONCLICK, "route-rules.json"), "utf8")) as RouteRuleSet;
    expect(fixture.sdkVersion).toBe("0.95.0");
    expect(fixture.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.sourceSha256).toBe("0d2d4ad9210972538d098b918caefabca54e37f79a599d37e9d07c8dfce0a5e3");
    expect(fixture.migrations).toHaveLength(17);
    expect(fixture.migrations?.some(m => m.token.includes("1f00bb"))).toBe(true);
    const c = classify(USDC);
    expect(c.sdkMigration?.sha256).toBe(fixture.sourceSha256);
  });

  test("the review renders route evidence with the migration provenance", () => {
    const md = renderIntentMarkdown(reviewIntent({ kind: "asset", assetId: USDC }, ctx()));
    expect(md).toContain("migrated_from: poa");
    expect(md).toContain("omni.bridge.near");
    expect(md).toContain("sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(md).toContain("withdraw");
  });
});

// ---------------------------------------------------------------------------
// AC1 — dry quote, tested offline only (peter-decision-2: no live quotes).
// All 1Click bodies here are SYNTHETIC, written by the tester; they are never
// presented as a recorded quote.
// ---------------------------------------------------------------------------
type FakeInit = { method?: string; headers?: Record<string, string>; body?: string };
function syntheticBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    correlationId: "corr-synthetic-1",
    timestamp: "2026-11-09T21:00:00.000Z",
    signature: "ed25519-synthetic-signature",
    quote: { amountIn: "1000000", amountOut: "999000", minAmountOut: "990000", timeEstimate: "60", refundFee: "1", withdrawFee: "2" },
    ...extra,
  };
}
function fakeFetchOf(body: unknown, status = 200, calls: { n: number; url: string; init?: FakeInit }[] = []) {
  return (async (url: string | URL | Request, init?: FakeInit) => {
    calls.push({ n: calls.length + 1, url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "oneclick-test-"));
}
const REQUEST = buildDryQuoteRequest({ originAsset: USDC, destinationAsset: USDC_NEAR, amount: "1000000" });

describe("AC1 dry quote (offline, synthetic responses)", () => {
  test("the request builder sends dry:true and never a depositAddress or deadline", () => {
    expect(REQUEST.dry).toBe(true);
    expect(Object.keys(REQUEST).sort()).toEqual([
      "amount", "depositType", "destinationAsset", "dry", "originAsset", "recipient",
      "recipientType", "refundTo", "refundType", "slippageTolerance", "swapType",
    ]);
    expect(JSON.stringify(REQUEST)).not.toContain("deadline");
    expect(JSON.stringify(REQUEST)).not.toContain("depositAddress");
    expect(REQUEST.swapType).toBe("EXACT_INPUT");
    expect(REQUEST.slippageTolerance).toBe(100);
    expect(REQUEST.depositType).toBe("ORIGIN_CHAIN");
    expect(REQUEST.refundType).toBe("ORIGIN_CHAIN");
    expect(REQUEST.recipientType).toBe("DESTINATION_CHAIN");
    expect(REQUEST.refundTo).toBe("11111111111111111111111111111111"); // sol placeholder from the token list
    expect(REQUEST.recipient).toBe("0".repeat(64)); // near placeholder
    expect(buildDryQuoteRequest({ originAsset: WRAP, destinationAsset: USDC, amount: "7" }).recipient)
      .toBe("11111111111111111111111111111111");
  });

  test("amount validation (PC6): invalid amounts throw before fetch", () => {
    for (const amount of ["0", "-1", "1.5", "", "12abc", "1e3"]) {
      expect(() => buildDryQuoteRequest({ originAsset: USDC, destinationAsset: WRAP, amount })).toThrow();
    }
    expect(fetchCalls).toBe(0);
  });

  test("malformed or unknown-chain assets throw before fetch", () => {
    expect(() => buildDryQuoteRequest({ originAsset: "nep141:", destinationAsset: WRAP, amount: "1" })).toThrow();
    // An unknown chain in the token list throws naming that chain (plan: `no placeholder format for <chain>`).
    expect(() =>
      buildDryQuoteRequest(
        { originAsset: USDC, destinationAsset: WRAP, amount: "1" },
        [
          { assetId: USDC, decimals: 6, blockchain: "sol", symbol: "USDC" },
          { assetId: WRAP, decimals: 24, blockchain: "dogechain", symbol: "NEAR" },
        ],
      ),
    ).toThrow(/no placeholder format for dogechain/);
    // A token absent from the list throws before any fetch as well.
    expect(() => buildDryQuoteRequest({ originAsset: USDC, destinationAsset: WRAP, amount: "1" }, [])).toThrow();
    expect(fetchCalls).toBe(0);
  });

  test("record mode: exactly one POST to the 1Click URL, body equals the built request, X-API-Key sent", async () => {
    const root = tempRoot();
    const calls: { n: number; url: string; init?: FakeInit }[] = [];
    const res = await fetchDryQuote(REQUEST, {
      mode: "record", root, apiKey: "test-key-0",
      fetch: fakeFetchOf(syntheticBody(), 200, calls),
      now: () => new Date("2026-11-09T21:00:00.000Z"),
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ONECLICK_QUOTE_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers?.["X-API-Key"]).toBe("test-key-0");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual(REQUEST);
    const file = join(root, `${dryQuoteRequestSha256(REQUEST)}.json`);
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record.requestSha256).toBe(dryQuoteRequestSha256(REQUEST));
    expect(record.response.signature).toBeDefined();
    expect(record.response.correlationId).toBeDefined();
    expect(record.response.timestamp).toBeDefined();
    expect(record.response.quote.amountIn).toBeDefined();
    expect(record.response.quote.amountOut).toBeDefined();
    expect(record.response.quote.minAmountOut).toBeDefined();
    expect(record.response.quote.timeEstimate).toBeDefined();
    // no key, no header name, no endpoint path in the stored fixture
    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain("test-key-0");
    expect(stored).not.toContain("X-API-Key");
    expect(stored).not.toContain("/v0/");
    expect(record.authenticated).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("record mode without a key: no X-API-Key header, authenticated false", async () => {
    const root = tempRoot();
    const calls: { n: number; url: string; init?: FakeInit }[] = [];
    const res = await fetchDryQuote(REQUEST, {
      mode: "record", root, apiKey: null,
      fetch: fakeFetchOf(syntheticBody(), 200, calls),
      now: () => new Date("2026-11-09T21:00:00.000Z"),
    });
    expect(res.ok).toBe(true);
    expect(calls[0].init?.headers?.["X-API-Key"]).toBeUndefined();
    const record = JSON.parse(readFileSync(join(root, `${dryQuoteRequestSha256(REQUEST)}.json`), "utf8"));
    expect(record.authenticated).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("record mode yields one claimed fact per figure with the 1Click receipt", async () => {
    const root = tempRoot();
    const res = await fetchDryQuote(REQUEST, {
      mode: "record", root, apiKey: null,
      fetch: fakeFetchOf(syntheticBody()),
      now: () => new Date("2026-11-09T21:00:00.000Z"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.source).toBe("oneclick:1click.chaindefuser.com");
    expect(res.receipt.privacy).toBe("public");
    expect(res.facts).toHaveLength(6); // amountIn, amountOut, minAmountOut, timeEstimate, refundFee, withdrawFee
    for (const f of res.facts) {
      expect(f.basis).toBe("claimed");
      expect(f.status).toBe("unverified");
      expect(f.privacy).toBe("public");
      expect(f.subject).toBe(`near:mainnet:intents.near#quote:${dryQuoteRequestSha256(REQUEST).slice(0, 40)}`);
    expect(f.evidenceIds).toEqual([res.receipt.id]);
    }
    validateQuoteFacts(res.facts, [res.receipt]);
    expect(quoteFacts(JSON.parse(readFileSync(join(root, `${dryQuoteRequestSha256(REQUEST)}.json`), "utf8")), res.receipt))
      .toEqual(res.facts);
    rmSync(root, { recursive: true, force: true });
  });

  test("offline replay of the stored synthetic record verifies and yields the same facts", async () => {
    const root = tempRoot();
    const stored = await fetchDryQuote(REQUEST, {
      mode: "record", root, apiKey: null,
      fetch: fakeFetchOf(syntheticBody()),
      now: () => new Date("2026-11-09T21:00:00.000Z"),
    });
    expect(stored.ok).toBe(true);
    const replay = await fetchDryQuote(REQUEST, { mode: "offline", root });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.correlationId).toBe("corr-synthetic-1");
    expect(replay.signature).toBe("ed25519-synthetic-signature");
    expect(replay.timestamp).toBe("2026-11-09T21:00:00.000Z");
    expect(replay.facts.map(f => f.id)).toEqual(stored.ok ? stored.facts.map(f => f.id) : []);
    rmSync(root, { recursive: true, force: true });
  });

  test("a response containing depositAddress is rejected with conflict and nothing stored", async () => {
    const root = tempRoot();
    const calls: { n: number; url: string; init?: FakeInit }[] = [];
    const res = await fetchDryQuote(REQUEST, {
      mode: "record", root,
      fetch: fakeFetchOf(syntheticBody({ quote: { amountIn: "1", amountOut: "1", minAmountOut: "1", timeEstimate: "1", depositAddress: "live-deposit-address" } }), 200, calls),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("deposit-address-present");
    expect(res.reasons.some(r => r.code === "conflict")).toBe(true);
    expect(readdirSync(root)).toHaveLength(0);
    expect(fetchCalls).toBe(0);
  });

  test("a response containing deadline is rejected with conflict and nothing stored", async () => {
    const root = tempRoot();
    const res = await fetchDryQuote(REQUEST, {
      mode: "record", root,
      fetch: fakeFetchOf({ ...syntheticBody(), deadline: "2030-01-01T00:00:00.000Z" }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("deadline-present");
    expect(res.reasons.some(r => r.code === "conflict")).toBe(true);
    expect(readdirSync(root)).toHaveLength(0);
  });

  test("missing signature is invalid-response and nothing stored", async () => {
    const root = tempRoot();
    const body = syntheticBody();
    delete (body as Record<string, unknown>).signature;
    const res = await fetchDryQuote(REQUEST, { mode: "record", root, fetch: fakeFetchOf(body) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid-response");
    expect(readdirSync(root)).toHaveLength(0);
  });

  test("offline with no fixture is missing-evidence", async () => {
    const root = tempRoot();
    const res = await fetchDryQuote(REQUEST, { mode: "offline", root });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("missing-fixture");
    expect(res.reasons).toEqual([{ code: "missing-evidence", subject: null, ref: dryQuoteRequestSha256(REQUEST) }]);
    rmSync(root, { recursive: true, force: true });
  });

  test("record when the fixture exists is already-recorded with zero fetch calls", async () => {
    const root = tempRoot();
    let n = 0;
    const counting = (async (...a: Parameters<typeof fetch>) => { n += 1; return fakeFetchOf(syntheticBody())(...a); }) as unknown as typeof fetch;
    await fetchDryQuote(REQUEST, { mode: "record", root, fetch: counting });
    const before = n;
    const res = await fetchDryQuote(REQUEST, { mode: "record", root, fetch: counting });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("already-recorded");
    expect(n).toBe(before);
    expect(fetchCalls).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("a tampered responseSha256 throws on verification", async () => {
    const root = tempRoot();
    await fetchDryQuote(REQUEST, { mode: "record", root, fetch: fakeFetchOf(syntheticBody()) });
    const file = join(root, `${dryQuoteRequestSha256(REQUEST)}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.responseSha256 = "0".repeat(64);
    expect(() => verifyQuoteRecord(record)).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("forbidden request fields are rejected before persistence", async () => {
    const tampered: Record<string, unknown> = { ...REQUEST, deadline: "2030-01-01T00:00:00.000Z" };
    expect(() => verifyQuoteRecord({
      version: 1, requestSha256: dryQuoteRequestSha256(REQUEST), request: tampered as unknown as typeof REQUEST,
      endpointHost: "1click.chaindefuser.com", authenticated: false, retrievedAt: "2026-11-09T21:00:00.000Z",
      httpStatus: 200, responseSha256: dryQuoteRequestSha256(syntheticBody() as unknown as typeof REQUEST), response: syntheticBody(),
    } as never)).toThrow();
    const extraField: Record<string, unknown> = { ...REQUEST, depositMemo: "x" };
    expect(() => verifyQuoteRecord({
      version: 1, requestSha256: dryQuoteRequestSha256(REQUEST), request: extraField as unknown as typeof REQUEST,
      endpointHost: "1click.chaindefuser.com", authenticated: false, retrievedAt: "2026-11-09T21:00:00.000Z",
      httpStatus: 200, responseSha256: "0".repeat(64), response: syntheticBody(),
    } as never)).toThrow();
  });

  test("quote facts are validated strictly (negative)", () => {
    const root = tempRoot();
    return fetchDryQuote(REQUEST, { mode: "record", root, fetch: fakeFetchOf(syntheticBody()) }).then(res => {
      if (!res.ok) throw new Error("expected ok");
      const record = JSON.parse(readFileSync(join(root, `${dryQuoteRequestSha256(REQUEST)}.json`), "utf8"));
      const receipt = res.receipt;
      const bad = quoteFacts(record, receipt).map(f => ({ ...f, basis: "observed" as const }));
      expect(() => validateQuoteFacts(bad, [receipt])).toThrow();
      const orphan = quoteFacts(record, receipt).map(f => ({ ...f, evidenceIds: ["nr:nonexistent"] }));
      expect(() => validateQuoteFacts(orphan, [receipt])).toThrow();
      rmSync(root, { recursive: true, force: true });
    });
  });

  test("no committed quote fixture carries a deposit address key", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith(".json")) files.push(p);
      }
    })(ONCLICK);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const key of ["depositAddress", "depositMemo", "chainDepositAddresses"]) {
        expect(text).not.toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// peter-decision-2 — the quote section reads "not recorded", citing the 400
// ---------------------------------------------------------------------------
describe("decision-2 quote not recorded", () => {
  test("the recorded HTTP 400 attempt is the evidence, with its request hash", () => {
    const q = loadQuoteNotRecorded();
    expect(q.status).toBe("not recorded");
    expect(q.reason).toContain("HTTP 400");
    expect(q.reason).toContain("deadline");
    expect(q.reason).toContain("not sent by decision");
    expect(q.attempt).not.toBeNull();
    expect(q.attempt?.httpStatus).toBe(400);
    expect(q.attempt?.cause).toBe("deadline-required");
    expect(q.attempt?.requestSha256).toBe("921d0759e61c57e0da5b9c5351cc34008bc7fb706854b2b37905e221f3bf1fee");
    expect(q.attempt?.requestSha256).toBe(dryQuoteRequestSha256(REQUEST));
  });

  test("asset reviews render the not-recorded section citing the 400", () => {
    const md = renderIntentMarkdown(reviewIntent({ kind: "asset", assetId: WRAP }, ctx()));
    expect(md).toContain("not recorded");
    expect(md).toContain("1Click requires a deadline for dry quotes (HTTP 400, recorded 2026-11-09); not sent by decision");
    expect(md).toContain("request sha256 921d0759e61c57e0da5b9c5351cc34008bc7fb706854b2b37905e221f3bf1fee");
    expect(md).not.toContain("/v0/");
  });

  test("a synthetic quote-mode review marks figures claimed and the signature unverified", async () => {
    // Synthetic only; never presented as recorded (decision-2 §2).
    const root = tempRoot();
    const stored = await fetchDryQuote(REQUEST, { mode: "record", root, fetch: fakeFetchOf(syntheticBody()) });
    expect(stored.ok).toBe(true);
    const replay = await fetchDryQuote(REQUEST, { mode: "offline", root });
    expect(replay.ok).toBe(true);
    if (!replay.ok || !stored.ok) return;
    const r = reviewIntent({ kind: "quote", quote: replay }, ctx());
    expect(r.quote).not.toBeNull();
    expect(r.quote?.signatureVerified).toBe(false);
    expect(r.quote?.factIds).toHaveLength(6);
    expect(r.input).toMatchObject({ kind: "quote", originAsset: USDC, destinationAsset: USDC_NEAR, amount: "1000000" });
    for (const id of r.quote?.factIds ?? []) {
      const f = r.facts.find(x => x.id === id);
      expect(f?.basis).toBe("claimed");
      expect(f?.status).toBe("unverified");
    }
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Raw read helpers — expected control counts are derived from the raw reads,
// never from literals (plan C7).
// ---------------------------------------------------------------------------
type AclValue = { super_admins: string[]; roles: Record<string, { grantees: string[] }> };
function rawAcl(account: string): AclValue {
  const hit = nearReads("near-2026-11-09").find(account, "call_function", "acl_get_permissioned_accounts");
  if (!hit) throw new Error(`no raw acl read for ${account}`);
  return JSON.parse(JSON.stringify(hit.value)) as AclValue;
}
function rawCouncil(): { members: string[]; threshold: number } {
  const hit = nearReads("near-2026-11-09").find("intents.sputnik-dao.near", "call_function", "get_policy");
  if (!hit) throw new Error("no raw policy read");
  const role = (hit.value as { roles: { name: string; kind: Record<string, string[]> | string; vote_policy?: Record<string, { threshold?: string; weight_kind?: string }> }[] })
    .roles.find(r => r.name === "council");
  if (!role) throw new Error("no council role in the raw policy");
  const kind = role.kind;
  const members = typeof kind === "string" ? [] : (kind.Group ?? []);
  const thresholds = Object.values(role.vote_policy ?? {}).map(v => v.threshold);
  const distinct = [...new Set(thresholds)];
  return { members, threshold: distinct.length === 1 ? Number(distinct[0]) : NaN };
}
function rawParticipants(): unknown[] {
  const hit = nearReads("near-2026-11-09").find("v1.signer", "call_function", "state");
  if (!hit) throw new Error("no raw mpc read");
  const v = hit.value as { Running?: { parameters?: { participants?: { participants?: unknown[] } } } };
  const list = v.Running?.parameters?.participants?.participants;
  if (!Array.isArray(list)) throw new Error("unexpected raw mpc state shape");
  return list;
}
function implicitAccounts(accounts: string[]): string[] {
  return accounts.filter(a => /^[0-9a-f]{64}$/.test(a));
}
function hopSubjects(review: { chain: { subject: string | null }[] }): Set<string | null> {
  return new Set(review.chain.map(h => h.subject));
}
const IMPLICIT_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// AC3 — dependencies of a route (per leg, PC3)
// ---------------------------------------------------------------------------
describe("AC3 dependency chain", () => {
  test("USDC (omni, migrated): common hops then bridge family, ordered", () => {
    const r = reviewIntent({ kind: "asset", assetId: USDC }, ctx());
    const roles = r.chain.filter(h => h.role !== "offchain" && h.role !== "asset").map(h => h.role);
    expect(roles).toEqual(["verifier", "controller", "dao", "factory", "relay", "bridge", "bridge-dao", "bridge-ops", "mpc", "origin-artefact"]);
    const byRole = (role: string) => r.chain.find(h => h.role === role);
    expect(byRole("verifier")?.subject).toBe("near:mainnet:intents.near");
    expect(byRole("controller")?.subject).toBe("near:mainnet:ctl-intents.near");
    expect(byRole("dao")?.subject).toBe("near:mainnet:intents.sputnik-dao.near");
    expect(byRole("factory")?.subject).toBe("near:mainnet:sputnik-dao.near");
    expect(byRole("bridge")?.subject).toBe("near:mainnet:omni.bridge.near");
    expect(byRole("bridge-dao")?.subject).toBe("near:mainnet:rainbowbridge.sputnik-dao.near");
    expect(byRole("bridge-ops")?.subject).toBe("near:mainnet:bridge-ops.near");
    expect(byRole("mpc")?.subject).toBe("near:mainnet:v1.signer");
  });

  test("PENGU (omdep): factory omdep.near, bridge omni, mpc v1.signer", () => {
    const r = reviewIntent({ kind: "asset", assetId: PENGU }, ctx());
    // PENGU traverses the verifier DAO factory (sputnik) and the token factory (omdep)
    const bySubject = (role: string, subject: string) => r.chain.find(h => h.role === role && h.subject === subject);
    expect(bySubject("factory", "near:mainnet:sputnik-dao.near")).toBeDefined();
    expect(bySubject("factory", "near:mainnet:omdep.near")).toBeDefined();
    expect(bySubject("bridge", "near:mainnet:omni.bridge.near")).toBeDefined();
    expect(bySubject("bridge-dao", "near:mainnet:rainbowbridge.sputnik-dao.near")).toBeDefined();
    expect(bySubject("bridge-ops", "near:mainnet:bridge-ops.near")).toBeDefined();
    expect(bySubject("mpc", "near:mainnet:v1.signer")).toBeDefined();
    expect(bySubject("origin-artefact", "near:mainnet:omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe")).toBeDefined();
  });

  test("every hop names its facts; every factId and receiptId resolves", () => {
    for (const asset of [USDC, PENGU, WRAP, HOT, WNAR_1CS, RHEA, ZEC, POA_CONTROL, CONFLICT_TOKEN]) {
      const r = reviewIntent({ kind: "asset", assetId: asset }, ctx());
      for (const hop of r.chain) {
        expect(hop.factIds.length + hop.reasons.length).toBeGreaterThan(0); // never both empty
        for (const factId of hop.factIds) expect(r.facts.some(f => f.id === factId)).toBe(true);
        for (const receiptId of hop.receiptIds) expect(r.receipts.some(x => x.id === receiptId)).toBe(true);
      }
      expect(hopSubjects(r).has("near:mainnet:intents.near")).toBe(true);
      expect(r.receipts.every(x => x.observation.chain === "near" && x.observation.network === "mainnet")).toBe(true);
    }
  });

  test("off-chain documents appear as their own hops", () => {
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const offIds = r.chain.filter(h => h.role === "offchain").map(h => h.subject?.replace("near:mainnet:intents.near#offchain:", ""));
    expect(offIds).toContain("solver-class");
    expect(offIds).toContain("message-bus");
    expect(offIds).toContain("operator-terms");
  });

  test("a quote review traverses per leg: origin leg first, then the destination leg (PC3)", async () => {
    const root = tempRoot();
    const stored = await fetchDryQuote(REQUEST, { mode: "record", root, fetch: fakeFetchOf(syntheticBody()) });
    expect(stored.ok).toBe(true);
    const replay = await fetchDryQuote(REQUEST, { mode: "offline", root });
    expect(replay.ok).toBe(true);
    const r = reviewIntent({ kind: "quote", quote: replay as Extract<typeof replay, { ok: true }> }, ctx());
    expect(r.families).toEqual(["omni_bridge", "near_withdrawal"]);
    expect(r.legs).toHaveLength(2);
    expect(r.legs.map(l => l.side)).toEqual(["origin", "destination"]);
    const assetSubjects = r.chain.filter(h => h.role === "asset").map(h => h.subject);
    expect(assetSubjects[0]).toBe(`near:mainnet:${USDC.replace("nep141:", "")}`);
    expect(assetSubjects).toContain(`near:mainnet:${USDC_NEAR.replace("nep141:", "")}`);
    const originLegEnd = r.chain.findIndex(h => h.subject === `near:mainnet:${USDC_NEAR.replace("nep141:", "")}`);
    expect(originLegEnd).toBeGreaterThan(0);
    // destination asset hop comes after the origin family hops
    expect(r.chain.slice(0, originLegEnd).some(h => h.role === "mpc")).toBe(true);
    for (const hop of r.chain) for (const factId of hop.factIds) expect(r.facts.some(f => f.id === factId)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("negative: dropping the bridge facts leaves the bridge hop missing-subject and the review partial", () => {
    const snap = buildIntentSnapshot("near-2026-11-09");
    const facts = snap.facts.filter(f => !f.subject.includes("omft.near") && !f.subject.includes("bridge-mng") && !f.subject.includes("int-mnt-dao"));
    const subjects = [...new Set(facts.map(f => f.subject))];
    const readers = snap.readers.map(rr => ({ ...rr, subjects: rr.subjects.filter(s => subjects.includes(s)) }));
    const store = openStore([{ ...snap, facts, subjects, readers }]);
    const filteredCtx = { ...ctx(), store, snapshotId: snap.id };
    const r = reviewIntent({ kind: "asset", assetId: POA_CONTROL }, filteredCtx);
    const bridge = r.chain.find(h => h.role === "bridge");
    expect(bridge?.subject).toBe("near:mainnet:omft.near");
    expect(bridge?.reasons.some(x => x.code === "missing-subject" && x.subject === "near:mainnet:omft.near")).toBe(true);
    expect(r.outcome).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// AC4 — control of a route (counts derived from raw reads)
// ---------------------------------------------------------------------------
describe("AC4 control section", () => {
  test("intents.near upgrade is ctl-intents.near, 0.4.5 since 2026-10-07", () => {
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const row = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "upgrade");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("fact");
    expect(row?.holders).toEqual(["near:mainnet:ctl-intents.near"]);
    expect(row?.count).toBe(rawAcl("intents.near").roles.Upgrader.grantees.length);
    expect(row?.detail).toContain("0.4.5");
    expect(row?.detail).toContain("2026-10-07");
  });

  test("pause count and holders equal the raw PauseManager grantees", () => {
    const raw = rawAcl("intents.near").roles.PauseManager.grantees;
    expect(raw).toHaveLength(7); // 6 implicit + pm.bridge.near (real snapshot)
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const row = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "pause" && c.kind === "fact");
    expect(row?.count).toBe(raw.length);
    expect([...(row?.holders ?? [])].sort()).toEqual(raw.map(g => `near:mainnet:${g}`).sort());
    expect(row?.detail).toContain("paused false");
    expect(row?.detail).toContain("UnpauseManager 0");
    expect(row?.detail).toContain(`PauseManager ${raw.length}`);
  });

  test("freeze equals the raw locker count; Unlocker empty is a count-0 fact", () => {
    const raw = rawAcl("intents.near").roles.UnrestrictedAccountLocker.grantees;
    expect(raw).toHaveLength(2);
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const freeze = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "freeze" && c.kind === "fact" && c.count === raw.length);
    expect([...(freeze?.holders ?? [])].sort()).toEqual(raw.map(g => `near:mainnet:${g}`).sort());
    expect(freeze?.detail).toContain(`UnrestrictedAccountLocker: ${raw.length}`);
    const unlocker = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "freeze" && c.count === 0);
    expect(unlocker?.kind).toBe("fact");
    expect(unlocker?.detail).toContain("UnrestrictedAccountUnlocker");
  });

  test("resuming is interpretation-only on the DAO, citing at least three facts", () => {
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const row = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "pause" && c.kind === "interpretation");
    expect(row).toBeDefined();
    expect(row?.detail).toContain("No account holds UnpauseManager");
    expect(row?.detail).toContain("no full-access key");
    expect(row?.factIds.length).toBeGreaterThanOrEqual(3);
    for (const id of row?.factIds ?? []) expect(r.facts.some(f => f.id === id)).toBe(true);
  });

  test("grant-roles is the council size from the raw policy read", () => {
    const raw = rawCouncil();
    expect(raw.members).toHaveLength(5);
    expect(raw.threshold).toBe(3);
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const row = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "grant-roles");
    expect(row?.detail).toContain(`${raw.threshold} of ${raw.members.length}`);
  });

  test("execution-delay rows cite the raw get_policy receipt", () => {
    const idx = nearReads("near-2026-11-09");
    const hit = idx.find("intents.sputnik-dao.near", "call_function", "get_policy");
    if (!hit) throw new Error("no get_policy read");
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const row = r.control.find(c => c.subject === "near:mainnet:intents.sputnik-dao.near" && c.power === "execution-delay");
    expect(row?.kind).toBe("fact");
    expect(row?.receiptIds).toContain(hit.receipt.id);
    expect(row?.factIds).toHaveLength(0); // a read-backed row, not a store fact
  });

  test("omni: sign-withdrawals is threshold 11 with 16 participants = the raw read", () => {
    const raw = rawParticipants();
    expect(raw).toHaveLength(16);
    for (const asset of [USDC, PENGU]) {
      const r = reviewIntent({ kind: "asset", assetId: asset }, ctx());
      const row = r.control.find(c => c.subject === "near:mainnet:v1.signer" && c.power === "sign-withdrawals");
      expect(row).toBeDefined();
      expect(row?.count).toBe(raw.length);
      expect(row?.detail).toContain("11");
    }
  });

  test("poa: sign-withdrawals is the TokenDepositer holders", () => {
    const r = reviewIntent({ kind: "asset", assetId: POA_CONTROL }, ctx());
    const row = r.control.find(c => c.subject === "near:mainnet:omft.near" && c.power === "sign-withdrawals");
    expect(row).toBeDefined();
    expect(row?.count).toBe(rawAcl("omft.near").roles.TokenDepositer.grantees.length);
    expect(row?.holders).toEqual(rawAcl("omft.near").roles.TokenDepositer.grantees.map(g => `near:mainnet:${g}`));
  });

  test("hot: sign-withdrawals is unknown-controller", () => {
    const r = reviewIntent({ kind: "asset", assetId: HOT }, ctx());
    const row = r.control.find(c => c.power === "sign-withdrawals");
    expect(row?.reasons.some(x => x.code === "unknown-controller" && x.ref === "hot-validator-identities")).toBe(true);
  });

  test("negative: extending a constructed base throws", () => {
    expect(() => buildIntentSnapshot("near-constructed-intents-locker-added", {})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC5 — what changed (real pair pending 2026-11-13; constructed pair here)
// ---------------------------------------------------------------------------
describe("AC5 changes", () => {
  test("with one live snapshot the review shows pair null and the reason", () => {
    expect(liveSnapshotIds()).toEqual(["near-2026-11-09"]);
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    expect(r.changes.pair).toBeNull();
    expect(r.unknowns.some(u => u.code === "missing-history" && u.ref === "live-snapshot-pair")).toBe(true);
  });

  test("the upgrade log is an ascending dated version list including 0.4.4 and 0.4.5", () => {
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const versions = r.changes.versions;
    expect(versions.some(v => v.version === "0.4.4" && v.at === "2026-10-02T20:31:42.189Z")).toBe(true);
    expect(versions.some(v => v.version === "0.4.5" && v.at === "2026-10-07T19:53:17.418Z")).toBe(true);
    const times = versions.map(v => Date.parse(v.at));
    for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    expect(versions.every(v => !v.version.includes("@current"))).toBe(true);
  });

  test("on-chain history for the chain subjects is present and ordered", () => {
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const history = r.changes.history;
    expect(history.map(h => h.subject)).toContain("near:mainnet:intents.near");
    const intentsHistory = history.find(h => h.subject === "near:mainnet:intents.near");
    expect(intentsHistory).toBeDefined();
    const at = (intentsHistory?.events ?? []).map(e => Date.parse(e.at));
    for (let i = 1; i < at.length; i += 1) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1]);
  });

  test("MPC: 16 participants = the raw read = the mpc-participant fact count", () => {
    const r = reviewIntent({ kind: "asset", assetId: USDC }, ctx());
    expect(r.changes.mpc.participants).toBe(rawParticipants().length);
    expect(r.changes.mpc.participants).toBe(16);
    const factCount = r.facts.filter(f => f.predicate === "mpc-participant").length;
    expect(r.changes.mpc.participants).toBe(factCount);
    expect(r.changes.mpc.threshold).toBe("11");
    const md = renderIntentMarkdown(r);
    expect(md.toLowerCase()).not.toContain("parser");
  });

  test("the constructed pair shows one added locker grantee, labelled constructed", () => {
    const pairCtx = loadIntentContext({ before: "near-2026-11-09", after: "near-constructed-intents-locker-added" });
    expect(pairCtx.change).toMatchObject({ before: "near-2026-11-09", after: "near-constructed-intents-locker-added", constructed: true });
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, pairCtx);
    expect(r.changes.pair).toEqual({ before: "near-2026-11-09", after: "near-constructed-intents-locker-added", constructed: true });
    expect(r.changes.changes).toHaveLength(1);
    const change = r.changes.changes[0];
    expect(change.kind).toBe("added");
    expect(change.subject).toContain("#role:UnrestrictedAccountLocker");
    expect(JSON.stringify(change.after ?? null)).toContain("near:mainnet:linchpin-constructed-locker.near");
    const md = renderIntentMarkdown(r);
    const section = md.split("## What changed")[1]?.split(/^## /m)[0] ?? "";
    expect(section.toLowerCase()).toContain("constructed");
  });
});

// ---------------------------------------------------------------------------
// AC6 — origin is not backing
// ---------------------------------------------------------------------------
describe("AC6 origin is not backing", () => {
  test("1cs and poa reviews carry the fixed text with the right custody facts", () => {
    for (const [asset, wants] of [
      [WNAR_1CS, ["MINT_AUTHORITY", "FREEZE_AUTHORITY"]],
      [RHEA, [] as string[]],
      [USDC, ["UPGRADE_AUTHORITY", "mpc-threshold"]],
      [POA_CONTROL, ["token-depositer"]],
      [CONFLICT_TOKEN, ["token-depositer", "CONTROLLED_BY"]],
    ] as [string, string[]][]) {
      const r = reviewIntent({ kind: "asset", assetId: asset }, ctx());
      expect(r.origin.text).toBe(ORIGIN_IS_NOT_BACKING_TEXT);
      const labels = r.origin.has.map(h => h.label).join(" | ");
      for (const want of wants) expect(labels).toContain(want);
      expect(r.origin.lacks.some(l => l.code === "missing-coverage" && l.ref === "origin-chain-balance-not-read")).toBe(true);
      for (const haves of r.origin.has) {
        for (const factId of haves.factIds) expect(r.facts.some(f => f.id === factId)).toBe(true);
      }
    }
  });

  test("the vault contradiction shows as a conflict in lacks, never as a class claim", () => {
    const r = reviewIntent({ kind: "asset", assetId: WNAR_1CS }, ctx());
    expect(r.origin.lacks.some(l => l.code === "conflict" && l.ref === "report:solana-class-2026-10-22")).toBe(true);
    const r2 = reviewIntent({ kind: "asset", assetId: CONFLICT_TOKEN }, ctx());
    expect(r2.origin.lacks.some(l => l.code === "unknown-controller" && l.ref === "treasury-controller")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6 — banned-word probes (negative): a broken findBannedWords must fail here
// ---------------------------------------------------------------------------
describe("AC6 banned-word probes", () => {
  const WORDS = ["backed", "redeemable", "safe", "equivalent"] as const;

  function shippedRenders(): [string, string][] {
    return [
      [WRAP, renderIntentMarkdown(reviewIntent({ kind: "asset", assetId: WRAP }, ctx()))],
      [USDC, renderIntentMarkdown(reviewIntent({ kind: "asset", assetId: USDC }, ctx()))],
      ["sample", readFileSync(join(REPO, "fixtures", "near", "samples", "intent-review.md"), "utf8")],
    ];
  }

  test("each planted word on an ordinary line is reported by findBannedWords", () => {
    for (const [name, md] of shippedRenders()) {
      expect(findBannedWords(md)).toEqual([]);
      for (const word of WORDS) {
        expect(findBannedWords(`${md}${word}\n`)).toEqual([word]);
      }
    }
  });

  test("each planted word on a quoted line is ignored", () => {
    for (const [name, md] of shippedRenders()) {
      for (const word of WORDS) {
        expect(findBannedWords(`${md}> ${word}\n`)).toEqual([]);
      }
    }
  });

  test("planted in offchain[].summary, the JSON text reports it and clean JSON reports none", () => {
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    expect(r.offchain.length).toBeGreaterThan(0);
    for (const word of WORDS) {
      const copy = JSON.parse(intentReviewJson(r)) as { offchain: { summary: string }[] };
      copy.offchain[0].summary = `${copy.offchain[0].summary} ${word}`;
      const json = JSON.stringify(copy, null, 2) + "\n";
      expect(findBannedWords(json)).toEqual([word]);
    }
  });
});

// ---------------------------------------------------------------------------
// AC7 — honest unknowns and outcome
// ---------------------------------------------------------------------------
describe("AC7 unknowns and outcome", () => {
  test("implicit-account role holders surface as missing-subject, not inferred", () => {
    const acl = rawAcl("intents.near").roles;
    const implicit = [...implicitAccounts(acl.PauseManager.grantees), ...implicitAccounts(acl.UnrestrictedAccountLocker.grantees)];
    expect(implicit.length).toBeGreaterThanOrEqual(7);
    expect(implicit.length).toBeLessThan(10);
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const reasons = new Map(r.unknowns.filter(u => u.code === "missing-subject").map(u => [u.subject, u]));
    for (const account of implicit) {
      const subject = `near:mainnet:${account}`;
      if (hopSubjects(r).has(subject)) continue; // only when the review hops for it
      expect(reasons.has(subject)).toBe(true);
    }
    expect(reasons.size).toBeGreaterThanOrEqual(1);
  });

  test("the named families each carry their own query reason", () => {
    const codesWithRef = (asset: string) => {
      const r = reviewIntent({ kind: "asset", assetId: asset }, ctx());
      return r.unknowns.filter(u => u.ref).map(u => `${u.code}:${u.ref}`);
    };
    expect(codesWithRef(PENGU)).toContain("missing-coverage:omni-solana-derivation-path");
    expect(codesWithRef(HOT)).toContain("unknown-controller:hot-validator-identities");
    expect(codesWithRef(WNAR_1CS)).toContain("missing-coverage:1cs_v1-semantics");
    expect(codesWithRef(RHEA)).toContain("missing-evidence:reported:rhea-mint-authority");
  });

  test("zec is undetermined, with the reason on the token subject", () => {
    const r = reviewIntent({ kind: "asset", assetId: ZEC }, ctx());
    expect(r.unknowns.some(u => u.ref === "undetermined" && u.subject === `near:mainnet:${ZEC.replace("nep141:", "")}`)).toBe(true);
  });

  test("every review of a live asset is partial (PC2: unknowns carry only query reasons)", () => {
    for (const asset of [USDC, PENGU, WRAP, HOT, WNAR_1CS, RHEA, ZEC, POA_CONTROL, CONFLICT_TOKEN]) {
      const r = reviewIntent({ kind: "asset", assetId: asset }, ctx());
      expect(r.outcome).toBe("partial");
      expect(r.unknowns.some(u => u.code === "missing-coverage" && u.ref === "origin-chain-balance-not-read")).toBe(false);
    }
  });

  test("negative: a fully filled synthetic context gives complete; removing the verifier gives unknown", () => {
    const snap = buildIntentSnapshot("near-2026-11-09");
    const base = buildNearSnapshot("near-2026-11-09");
    const baseFacts = base.facts.filter(f => f.predicate !== "proposal" && !String(f.object).includes("proposals"));
    const baseB = { ...base, facts: baseFacts, subjects: base.subjects.filter(s => baseFacts.some(f => f.subject === s)) };
    const probe = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    const missingSubjects = [...new Set(probe.unknowns.filter(u => u.code === "missing-subject" && u.subject).map(u => u.subject))].filter((s): s is string => s !== null);
    expect(missingSubjects.length).toBe(8); // implicit role holders, filled below
    const facts = snap.facts
      .filter(f => f.basis !== "reported") // reported basis emits missing-coverage on its own
      .filter(f => f.predicate !== "proposal")
      .filter(f => !(f.subject === `near:mainnet:${WRAP.replace("nep141:", "")}` && f.predicate === "owned-by" && f.object === "unknown"));
    const receipts = [...snap.receipts];
    const anchor = receipts[0].observation.observedAt;
    const mkReceipt = (id: string, source: string) => ({
      id, source, responseSha256: "1".repeat(64), privacy: "public" as const,
      observation: { chain: "near" as const, network: "mainnet" as const, blockOrSlot: null, blockHash: null, observedAt: anchor, retrievedAt: anchor, historicalState: "current-only" as const },
    });
    const synthOffchain = [...ctx().offchain];
    for (const target of ["shield", "incident-2026-09-29"]) {
      const rid = `doc:synthetic-${target.slice(0, 16)}`;
      receipts.push(mkReceipt(rid, `document:synthetic-${target.slice(0, 12)}`));
      facts.push({
        id: `nf:synthetic:${target.slice(0, 24)}`, subject: `near:mainnet:intents.near#offchain:${target}`, predicate: "claimed-document",
        object: `https://synthetic.invalid/${target}|1${"0".repeat(63)}|2026-11-09T19:32:56.448Z`,
        basis: "claimed", status: "unverified", evidenceIds: [rid], path: [], validFrom: null, validTo: null, privacy: "public",
      });
      synthOffchain.push({
        id: target as never, subject: `near:mainnet:intents.near#offchain:${target}`, title: target,
        url: `https://synthetic.invalid/${target}`, sha256: "1".repeat(64), retrievedAt: "2026-11-09T19:32:56.448Z",
        summary: `synthetic doc ${target}`, factId: `nf:synthetic:${target.slice(0, 24)}`, receiptId: rid,
      });
    }
    missingSubjects.forEach((_s, i) => receipts.push(mkReceipt(`nr:synthetic-implicit-${i}`, "synthetic:implicit-account")));
    missingSubjects.forEach((s, i) => facts.push({
      id: `nf:synthetic:implicit-${i}`, subject: s, predicate: "CONTROLLED_BY", object: "unknown",
      basis: "observed", status: "verified", evidenceIds: [`nr:synthetic-implicit-${i}`], path: [], validFrom: null, validTo: null, privacy: "public",
    }));
    facts.push({
      id: "nf:synthetic:wrap-owner", subject: `near:mainnet:${WRAP.replace("nep141:", "")}`, predicate: "owned-by", object: "pm.bridge.near",
      basis: "observed", status: "verified", evidenceIds: ["nr:synthetic-implicit-0"], path: [], validFrom: null, validTo: null, privacy: "public",
    });
    const mkSide = (factsOfStore: typeof facts) => {
      const localSubjects = [...new Set(factsOfStore.map(f => f.subject))];
      const localReaders = snap.readers.map(rr => ({ ...rr, subjects: rr.subjects.filter(s => localSubjects.includes(s)) }));
      return { ...snap, facts: factsOfStore, receipts, subjects: localSubjects, readers: localReaders };
    };
    const snapB = mkSide(facts);
    const snapB2 = { ...snapB, id: `${snap.id}-synthetic-b` };
    const mkCtx = (factsOfStore: typeof facts) => {
      const b = mkSide(factsOfStore);
      const b2 = { ...b, id: `${snap.id}-synthetic-b` };
      return {
        ...ctx(), offchain: synthOffchain,
        store: openStore([baseB, b, b2]),
        change: { before: snapB.id, after: `${snap.id}-synthetic-b`, constructed: false },
      };
    };
    const complete = reviewIntent({ kind: "asset", assetId: WRAP }, mkCtx(facts));
    expect(complete.outcome).toBe("complete");
    expect(complete.unknowns).toEqual([]);
    // dropping the verifier facts leaves the verifier hop without facts -> unknown
    const withoutVerifier = facts.filter(f => f.subject !== "near:mainnet:intents.near" && !f.subject.startsWith("near:mainnet:intents.near#"));
    const u = reviewIntent({ kind: "asset", assetId: WRAP }, mkCtx(withoutVerifier));
    expect(u.outcome).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// AC8 — CLI and report
// ---------------------------------------------------------------------------
describe("AC8 CLI", () => {
  let stdoutBackup: typeof console.log;
  let stderrBackup: typeof console.error;
  function capture() {
    let out = "";
    let err = "";
    stdoutBackup = console.log;
    stderrBackup = console.error;
    console.log = (...a: unknown[]) => { out += a.join(" ") + "\n"; };
    console.error = (...a: unknown[]) => { err += a.join(" ") + "\n"; };
    return { restore: () => { console.log = stdoutBackup; console.error = stderrBackup; }, get out() { return out; }, get err() { return err; } };
  }
  function outDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cli-ac8-"));
    return join(dir, name);
  }

  test("asset-only case exits 0, writes byte-identical files, equals the committed sample", async () => {
    const dir = outDir("wrap");
    expect(await cliRun(["--asset", WRAP, "--offline", "--out", dir])).toBe(0);
    const md = join(dir, "intent-review.md");
    const js = join(dir, "intent-review.json");
    expect(existsSync(md)).toBe(true);
    expect(existsSync(js)).toBe(true);
    expect(readFileSync(md, "utf8").split("\n")[0]).toBe("# Intent review · nep141:wrap.near");
    const json = JSON.parse(readFileSync(js, "utf8")) as { reviewer: string; outcome: string; version: number };
    expect(json.reviewer).toBe("near-intent-review/1");
    expect(json.version).toBe(1);
    // committed sample is the same render, byte for byte
    const sample = readFileSync(join(REPO, "fixtures", "near", "samples", "intent-review.md"), "utf8");
    expect(readFileSync(md, "utf8")).toBe(sample);
    // second run: identical files
    const beforeMd = readFileSync(md, "utf8");
    const beforeJson = readFileSync(js, "utf8");
    expect(await cliRun(["--asset", WRAP, "--offline", "--out", dir])).toBe(0);
    expect(readFileSync(md, "utf8")).toBe(beforeMd);
    expect(readFileSync(js, "utf8")).toBe(beforeJson);
  });

  test("a malformed asset renders outcome unknown and exits 0", async () => {
    const dir = outDir("malformed");
    const cap = capture();
    let code: number;
    try { code = await cliRun(["--asset", "nep141:", "--offline", "--out", dir]); } finally { cap.restore(); }
    expect(code).toBe(0);
    expect(cap.out).toContain("outcome unknown");
    expect(cap.out).toContain("missing-subject");
    expect(JSON.parse(readFileSync(join(dir, "intent-review.json"), "utf8")).outcome).toBe("unknown");
  });

  test("misused flags give exit 1 and usage on stderr, never an asset review", async () => {
    for (const args of [
      ["--record", "--offline", "--asset", WRAP],
      ["--from", WRAP, "--to", WRAP],
      ["--asset", WRAP, "--bogus"],
    ]) {
      const cap = capture();
      let code: number;
      try { code = await cliRun(args); } finally { cap.restore(); }
      expect(code).toBe(1);
      expect(cap.err.length).toBeGreaterThan(0);
      expect(cap.out).toBe("");
    }
  });

  test("quote forms without a recorded fixture are refused offline (decision-2: no live quotes)", async () => {
    for (const args of [
      ["--from", USDC, "--to", USDC_NEAR, "--amount", "1000000", "--offline", "--out", outDir("usdc")],
      ["--from", PENGU, "--to", WRAP, "--amount", "1000000000", "--offline", "--out", outDir("pengu")],
    ]) {
      const cap = capture();
      let code: number;
      try { code = await cliRun(args); } finally { cap.restore(); }
      expect(code).toBe(1);
      expect(cap.err).toContain("missing-fixture");
      expect(cap.out).toBe("");
    }
  });

  test("CLI markdown output carries no endpoint path and no banned words", async () => {
    const dir = outDir("clean");
    const cap = capture();
    let code: number;
    try { code = await cliRun(["--asset", USDC, "--offline", "--out", dir]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const md = join(dir, "intent-review.md");
    const text = readFileSync(md, "utf8");
    expect(text).not.toContain("/v0/");
    expect(findBannedWords(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC9 — conventions: markers, secrets, no key/header
// ---------------------------------------------------------------------------
describe("AC9 conventions", () => {
  function* walk(dir: string): IterableIterator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else yield p;
    }
  }

  test.skipIf(!DEV_ALLOWLIST)("no forbidden marker of the publish allowlist in this run's files", () => {
    const allowlistFile = join(REPO, "scripts", "publish" + "." + "allowlist");
    const allowlistText = readFileSync(allowlistFile, "utf8");
    const start = allowlistText.indexOf("[forbidden]");
    expect(start).toBeGreaterThan(0);
    const markers = allowlistText.slice(start).split("\n").slice(1).map(l => l.trim()).filter(Boolean);
    expect(markers.length).toBeGreaterThan(10);
    const targets: string[] = [
      join(REPO, "src", "near", "intents"),
      join(REPO, "src", "near", "cli", "intent.ts"),
      join(REPO, "fixtures", "near", "oneclick"),
      join(REPO, "fixtures", "near", "near-2026-11-09", "intents"),
      join(REPO, "fixtures", "near", "samples"),
      join(import.meta.dir, "near-intent-review.test.ts"),
    ];
    expect(targets.every(t => existsSync(t))).toBe(true);
    const collect = (path: string): string[] => {
      if (require("node:fs").statSync(path).isDirectory()) return [...walk(path)];
      return [path];
    };
    const seen: string[] = [];
    for (const target of targets) {
      for (const file of collect(target)) {
        const text = readFileSync(file, "utf8");
        for (const marker of markers) {
          if (text.includes(marker)) seen.push(`${file}: ${marker}`);
        }
      }
    }
    expect(seen).toEqual([]);
  });

  test("fixtures hold no key, no auth header, no endpoint path outside the recorded url fields", () => {
    const hit: string[] = [];
    const dropField = (key: string, drop: string[]) => drop.includes(key);
    const scanUrlJson = (file: string, urlFields: string[], dropFields: string[]) => {
      const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const clean = (v: unknown, key: string, path: string): unknown => {
        if (dropField(key, dropFields) || urlFields.includes(key)) return "<allowed>";
        if (Array.isArray(v)) return v.map(x => clean(x, key, `${path}[]`));
        if (v && typeof v === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = clean(val, k, `${path}.${k}`);
          return out;
        }
        if (typeof v === "string" && v.includes("http")) return "<string>";
        return v;
      };
      const rest = JSON.stringify(clean(data, "", "root"));
      for (const needle of ["://", "/v0/", "x-api-key", "authorization", "bearer", "apikey"]) {
        if (rest.toLowerCase().includes(needle.toLowerCase())) hit.push(`${file}: ${needle}`);
      }
    };
    const oneClickDir = join(REPO, "fixtures", "near", "oneclick");
    for (const file of readdirSync(oneClickDir)) {
      const text = readFileSync(join(oneClickDir, file), "utf8");
      for (const needle of ["//", "/v0/", "x-api-key", "authorization", "bearer", "apikey", "test-key-0"]) {
        if (text.toLowerCase().includes(needle.toLowerCase())) hit.push(`${oneClickDir}/${file}: ${needle}`);
      }
    }
    const intentsDir = join(REPO, "fixtures", "near", "near-2026-11-09", "intents");
    for (const file of readdirSync(intentsDir).filter(f => f.endsWith(".json"))) {
      scanUrlJson(join(intentsDir, file), ["url", "finalUrl"], ["response"]);
    }
    for (const file of readdirSync(join(intentsDir, "reads")).filter(f => f.endsWith(".json"))) {
      scanUrlJson(join(intentsDir, "reads", file), ["url", "finalUrl"], ["response"]);
    }
    expect(hit).toEqual([]);
  });

  test("rendered outputs carry document urls only in the off-chain section, never /v0/ or a key", () => {
    for (const asset of [USDC, PENGU, WRAP]) {
      const r = reviewIntent({ kind: "asset", assetId: asset }, ctx());
      const md = renderIntentMarkdown(r);
      expect(md).not.toContain("/v0/");
      for (const needle of ["x-api-key", "authorization", "bearer", "apikey"]) expect(md.toLowerCase()).not.toContain(needle);
      const offIdx = md.indexOf("## Off-chain, permissioned");
      const nextIdx = md.indexOf("\n## ", offIdx + 1);
      let before = offIdx === -1 ? md : md.slice(0, offIdx) + (nextIdx === -1 ? "" : md.slice(nextIdx));
      // The route-evidence section quotes the on-chain recorded source metadata verbatim
      // (its own repo/rev links); urls there are recorded content, not rendered links.
      const reIdx = before.indexOf("## Route evidence");
      if (reIdx !== -1) {
        const reNext = before.indexOf("\n## ", reIdx + 1);
        before = before.slice(0, reIdx) + (reNext === -1 ? "" : before.slice(reNext));
      }
      expect(before).not.toContain("://");
      // json: strip the url fields of the offchain entries and the strings that quote them
      const json = JSON.parse(intentReviewJson(r)) as Record<string, unknown>;
      expect(JSON.stringify(json.offchain)).toContain("https://");
      const stripped = JSON.stringify(json).replace(/"url":"[^"]*"/g, "\"url\":\"\"");
      for (const needle of ["/v0/", "x-api-key", "authorization", "bearer", "apikey"]) expect(stripped.toLowerCase()).not.toContain(needle);
    }
  });

  test("the committed sample is the wrap.near render and carries the summary header lines", () => {
    const sample = readFileSync(join(REPO, "fixtures", "near", "samples", "intent-review.md"), "utf8");
    expect(findBannedWords(sample)).toEqual([]);
    const r = reviewIntent({ kind: "asset", assetId: WRAP }, ctx());
    expect(renderIntentMarkdown(r)).toBe(sample);
    const head = sample.split("\n").slice(0, 10);
    expect(head[0]).toBe("# Intent review · nep141:wrap.near");
    expect(head.some(l => l.startsWith("route family"))).toBe(true);
    expect(head.some(l => l.startsWith("verifier"))).toBe(true);
    expect(head.some(l => l.startsWith("unknowns"))).toBe(true);
    expect(head.some(l => l.startsWith("snapshot"))).toBe(true);
  });
});
