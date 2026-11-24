/**
 * Independent tests for the risk desk v2, written from its approved specification and
 * the public type contracts only. Every expected value comes from the specification,
 * from a settled decision, or — for the five sha256 pins near the end — from the built
 * surfaces, as the plan's step table provides. The desk is driven over HTTP and through
 * its public exports; no implementation body was relied on.
 *
 * Offline: a trap refuses every fetch, socket and WebSocket that does not address an
 * in-process server this file started (all on 127.0.0.1), and the file asserts zero
 * trapped attempts. One further loopback origin is registered per test where the spec
 * itself demands a connection that must fail (a closed port); it is still loopback.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, mkdtempSync, statSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";

import { runDeskCommand } from "../src/desk/cli";
import { startDesk } from "../src/desk/server";
import { loadDeskState, parseDeskAddress, type DeskDeps, type DeskState } from "../src/desk/state";
import { buildSurface, MARK_OF_OUTCOME } from "../src/desk/surfaces";
import { SENTENCE_TEMPLATES, sentenceFor } from "../src/desk/sentences";
import { answerSegments, idResolver } from "../src/desk/answer";
import { answerTree } from "../src/desk/chrome";
import { DESK_STRINGS, DESK_TEXT } from "../src/desk/strings";
import { ruleSubjects } from "../src/near/private/watch";
import { nearChain } from "../src/near/private/chains";
import { findNearBannedWords } from "../src/near/private/render";
import { NEAR_POLICY_KINDS } from "../src/near/policy/registry";
import { run as runNearPolicyCli } from "../src/near/cli/policy";
import { canonical } from "../src/chain/evidence";
import { validateSurface, receiptResolver } from "../src/ui/validate";
import { interpret } from "../src/ui/interpret";
import { treeToHtml } from "../src/ui/html";
import { mount } from "../src/ui/mount";
import { graphResult } from "../src/ui/adapters";
import type { A2uiMessage, GraphResult, GraphMark, ResultRow, UiNode } from "../src/ui/types";
import type { Outcome } from "../src/policy/types";
import type { ReadResult } from "../src/positions/types";
import bookCanary from "./fixtures/near-risk-desk-v2/book-canary.json";
import bookRejected from "./fixtures/near-risk-desk-v2/book-rejected.json";

/* ------------------------------------------------------------------ */
/* Offline trap (AC13)                                                 */
/* ------------------------------------------------------------------ */

const trappedAttempts: string[] = [];
const allowedOrigins = new Set<string>();
const trapRestores: (() => void)[] = [];

function allowOrigin(origin: string): void {
  allowedOrigins.add(origin);
}

beforeAll(() => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.hostname === "127.0.0.1" && allowedOrigins.has(url.origin)) {
      return realFetch(input as Parameters<typeof realFetch>[0], { ...(init as RequestInit | undefined), keepalive: false });
    }
    trappedAttempts.push(`fetch ${url.host}${url.pathname}`);
    throw new Error(`offline trap: fetch to ${url.host} is not an in-process server of this test file`);
  }) as typeof fetch;
  trapRestores.push(() => { globalThis.fetch = realFetch; });
  const refuse = (label: string) => (): never => { trappedAttempts.push(label); throw new Error(`offline trap: ${label} is refused`); };
  const realConnect = Bun.connect;
  (Bun as unknown as { connect: unknown }).connect = refuse("Bun.connect");
  trapRestores.push(() => { (Bun as unknown as { connect: unknown }).connect = realConnect; });
  const spy = (target: Record<string, unknown>, key: string, label: string) => {
    if (typeof target[key] !== "function") return;
    const original = target[key];
    target[key] = refuse(label) as unknown;
    trapRestores.push(() => { target[key] = original; });
  };
  spy(net as unknown as Record<string, unknown>, "connect", "net.connect");
  spy(net as unknown as Record<string, unknown>, "createConnection", "net.createConnection");
  spy(http as unknown as Record<string, unknown>, "request", "http.request");
  spy(https as unknown as Record<string, unknown>, "request", "https.request");
  const realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class { constructor() { trappedAttempts.push("WebSocket"); throw new Error("offline trap: WebSocket"); } };
  trapRestores.push(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket; });
});

afterAll(() => {
  for (const restore of trapRestores) restore();
  expect(trappedAttempts).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const HOSTILE = "<img src=x onerror=alert(1)>";

/** Encodes synthetic public-key bytes, or generates an on-curve key at run time. */
function generatedSolanaAddress(rawPublicKey?: Uint8Array): string {
  const raw = rawPublicKey ?? (() => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ type: "spki", format: "der" }) as Uint8Array;
    return der.subarray(der.length - 32);
  })();
  return bs58.encode(raw);
}

describe("generated Solana address encoding", () => {
  for (const leadingZeros of [0, 1, 2, 32]) {
    test(`preserves ${leadingZeros} leading zero bytes and remains a valid desk address`, () => {
      const raw = new Uint8Array(32).fill(1);
      raw.fill(0, 0, leadingZeros);
      const address = generatedSolanaAddress(raw);
      expect([...bs58.decode(address)]).toEqual([...raw]);
      expect(address.startsWith("1".repeat(leadingZeros))).toBe(true);
      expect(parseDeskAddress(`solana:${address}`)).toEqual({ chain: "solana", address });
    });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port: number = server.port ?? 0;
    server.stop(true);
    resolve(port);
  });
}

async function waitFor(predicate: () => unknown, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("deadline passed");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function textOf(node: UiNode): string {
  return (node.text ?? "") + node.children.map(textOf).join("");
}

function findAll(node: UiNode, pred: (n: UiNode) => boolean): UiNode[] {
  const out: UiNode[] = [];
  const walk = (n: UiNode): void => { if (pred(n)) out.push(n); for (const c of n.children) walk(c); };
  walk(node);
  return out;
}

/**
 * The first string that holds one of the canaries while not sitting on a node whose id
 * names a position. Strings on `position:`-prefixed nodes are the map's allowed place.
 */
function canaryOutsidePositionNodes(value: unknown, canaries: string[], ancestors: unknown[] = []): string | null {
  if (typeof value === "string") {
    if (canaries.some((c) => value.includes(c))) {
      const node = [...ancestors].reverse().find((a) => a !== null && typeof a === "object" && "id" in (a as object));
      const id = (node as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id.startsWith("position:")) return value;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const bad = canaryOutsidePositionNodes(v, canaries, [...ancestors, value]); if (bad !== null) return bad; }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) { const bad = canaryOutsidePositionNodes(v, canaries, [...ancestors, value]); if (bad !== null) return bad; }
    return null;
  }
  return null;
}

/** Every string sitting anywhere inside a JSON value, with the path that holds it. */
function stringsWithValue(value: unknown, path: string[] = [], out: { path: string[]; text: string }[] = []): { path: string[]; text: string }[] {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => stringsWithValue(v, [...path, String(i)], out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) stringsWithValue(v, [...path, k], out);
  return out;
}

function modelResults(messages: A2uiMessage[]): Record<string, Record<string, unknown>> {
  for (const m of messages) {
    if ("updateDataModel" in m) {
      const value = m.updateDataModel.value as { results?: unknown } | null;
      if (value && typeof value === "object" && value.results && typeof value.results === "object") {
        const results = value.results as Record<string, Record<string, unknown>>;
        if (!Array.isArray(results)) return results;
        const keyed: Record<string, Record<string, unknown>> = {};
        for (const r of results as unknown as Record<string, unknown>[]) keyed[String(r.resultId)] = r;
        return keyed;
      }
    }
  }
  return {};
}

function resultOf(messages: A2uiMessage[], resultId: string): Record<string, unknown> | null {
  return modelResults(messages)[resultId] ?? null;
}

function rowsOf(result: Record<string, unknown> | null): ResultRow[] {
  return (result?.rows as ResultRow[] | undefined) ?? [];
}

function notesOf(result: Record<string, unknown> | null): string[] {
  return (result?.coverageNotes as string[] | undefined) ?? [];
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** The fake in-process document the kit's own tests mount against. */
function fakeDocumentHost(): { host: Record<string, unknown>; createdTags: string[]; calls: string[] } {
  const createdTags: string[] = [];
  const calls: string[] = [];
  const makeFakeElement = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(), attrs: {} as Record<string, string>, childNodes: [] as unknown[],
      setAttribute(name: string, value: string) { calls.push(`setAttribute:${name}`); (el.attrs as Record<string, string>)[name] = value; },
      append(...kids: unknown[]) { calls.push("append"); (el.childNodes as unknown[]).push(...kids); },
      replaceChildren(...kids: unknown[]) { calls.push("replaceChildren"); (el.childNodes as unknown[]).push(...kids); },
    };
    Object.defineProperty(el, "innerHTML", { set() { calls.push("innerHTML"); }, get() { return ""; } });
    Object.defineProperty(el, "outerHTML", { set() { calls.push("outerHTML"); }, get() { return ""; } });
    Object.defineProperty(el, "textContent", { set(v: unknown) { calls.push("textContent"); el.storedText = v; }, get() { return el.storedText ?? ""; } });
    return el;
  };
  const documentFake: Record<string, unknown> = {
    createElement(tag: string) { createdTags.push(tag); calls.push(`createElement:${tag}`); return makeFakeElement(tag); },
    createElementNS(ns: string, tag: string) { createdTags.push(tag); calls.push(`createElementNS:${tag}`); return makeFakeElement(tag); },
  };
  const host = makeFakeElement("div");
  host.ownerDocument = documentFake;
  return { host, createdTags, calls };
}

/* ------------------------------------------------------------------ */
/* Reader doubles                                                      */
/* ------------------------------------------------------------------ */

const emptyReader = async (): Promise<ReadResult> => ({ positions: [], receipts: [], notRead: [] });

function baseDeps(overrides: Partial<DeskDeps> = {}): DeskDeps {
  return { readPositions: emptyReader, env: {}, now: () => Date.now(), ...overrides };
}

function readerResultFor(address: string, id: string, receiptId: string): ReadResult {
  return {
    positions: [{ id, subject: `solana:mainnet-beta:${address}#holder:fakesol`, quantity: "3", unit: "solana:mainnet-beta:fakesolmint", snapshotId: "desk-reader.test", source: "reader", fixtureKind: "synthetic", receiptIds: [receiptId] }],
    receipts: [{ id: receiptId, source: "in-process test double", responseSha256: "ab".repeat(32), observation: { chain: "solana", network: "mainnet-beta", blockOrSlot: "31415926", blockHash: null, observedAt: "2026-11-09T00:00:00Z", retrievedAt: "2026-11-09T00:00:00Z", historicalState: "pinned" }, privacy: "private" }],
    notRead: [],
  };
}

async function serve(state: DeskState, deps: DeskDeps, opts: { testHooks?: Record<string, unknown>; log?: (line: string) => void } = {}) {
  const server = await startDesk({ state, deps, port: 0, testHooks: opts.testHooks as never, log: opts.log });
  allowOrigin(server.origin);
  return server;
}

const authHeaders = (server: { token: string; origin: string }, extra: Record<string, string> = {}): Record<string, string> =>
  ({ "x-desk-token": server.token, origin: server.origin, ...extra });

/* ------------------------------------------------------------------ */
/* Shared fixtures built once                                          */
/* ------------------------------------------------------------------ */

let syntheticState: DeskState;
let cliStdout = "";
let cliVerdict: { rules: { ruleId: string; outcome: Outcome; factIds: string[]; receiptIds: string[] }[] };
let main: Awaited<ReturnType<typeof startDesk>>;
const readerReceiptId = "nr-test-reader-receipt-0001";

beforeAll(async () => {
  syntheticState = await loadDeskState({ policy: "quantrin-near-v1", addresses: [] }, baseDeps());

  const origLog = console.log;
  const lines: string[] = [];
  console.log = ((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }) as typeof console.log;
  try {
    const cliExit = await runNearPolicyCli(["quantrin-near-v1", "--json", "--offline"]);
    expect(cliExit).toBe(0);
  } finally {
    console.log = origLog;
  }
  cliStdout = lines.join("\n").trim();
  cliVerdict = JSON.parse(cliStdout);

  main = await serve(syntheticState, baseDeps());
}, 300_000);

/* ------------------------------------------------------------------ */
/* AC1 — loopback only, private routes guarded                          */
/* ------------------------------------------------------------------ */

describe("AC1 loopback and token", () => {
  const urlRe = /desk (http:\/\/127\.0\.0\.1:\d+\/)#token=([0-9a-f]+)/;

  async function launchUntilUrl(argv: string[]): Promise<{ url: string; token: string; code: number }> {
    const ac = new AbortController();
    const outs: string[] = [];
    const errs: string[] = [];
    const done = runDeskCommand(argv, { out: (l) => outs.push(l), err: (l) => errs.push(l), env: {}, readPositions: emptyReader, now: () => Date.now(), signal: ac.signal });
    await waitFor(() => outs.some((l) => urlRe.test(l)), 120_000);
    const match = urlRe.exec(outs.join("\n"))!;
    const origin = match[1].replace(/\/$/, "");
    allowOrigin(origin);
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    ac.abort();
    const code = await done;
    return { url: match[1], token: match[2], code };
  }

  test("two launches bind the loopback, print URLs and give two fresh tokens of at least 128 bits", async () => {
    const portA = await freePort();
    const portB = await freePort();
    const a = await launchUntilUrl(["quantrin-near-v1", "--port", String(portA)]);
    const b = await launchUntilUrl(["quantrin-near-v1", "--port", String(portB)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(a.token.length).toBeGreaterThanOrEqual(64);
    expect(b.token.length).toBeGreaterThanOrEqual(64);
    expect(a.token).not.toBe(b.token);
  }, 180_000);

  test("--host is refused with exit 2 and one stderr line, loopback or not", async () => {
    for (const host of ["0.0.0.0", "127.0.0.1"]) {
      const errs: string[] = [];
      const code = await runDeskCommand(["quantrin-near-v1", "--host", host], { err: (l) => errs.push(l), env: {}, readPositions: emptyReader, now: () => Date.now() });
      expect(code).toBe(2);
      expect(errs).toHaveLength(1);
      expect(errs[0].length).toBeGreaterThan(0);
    }
  }, 60_000);

  test("every private route refuses a request without the launch token, with a wrong token, a foreign Host or a foreign Origin, and a POST without Origin, each with an empty 403 body", async () => {
    const routes = ["/api/desk/verdict", "/api/desk/surface/verdict", "/api/desk/surface/map", "/api/desk/surface/words", "/api/desk/surface/changes", "/api/desk/surface/unknowns", "/api/desk/positions", "/api/desk/agent"];
    for (const route of routes) {
      const cases: [Record<string, string>][] = [
        [{}],
        [{ "x-desk-token": "0".repeat(64) }],
        [{ "x-desk-token": main.token, host: "example.test" }],
        [{ "x-desk-token": main.token, origin: "http://example.test" }],
      ];
      for (const [headers] of cases) {
        const res = await fetch(`${main.origin}${route}`, { headers });
        expect(res.status, `${route} ${JSON.stringify(headers)}`).toBe(403);
        expect(await res.text()).toBe("");
      }
      const post = await fetch(`${main.origin}/api/desk/addresses`, { method: "POST", headers: { "x-desk-token": main.token, "content-type": "application/json" }, body: "{}" });
      expect(post.status).toBe(403);
      expect(await post.text()).toBe("");
    }
  }, 120_000);

  test("the launch server answers its own token and refuses the missing one", async () => {
    const port = await freePort();
    const ac = new AbortController();
    const outs: string[] = [];
    const done = runDeskCommand(["quantrin-near-v1", "--port", String(port)], { out: (l) => outs.push(l), env: {}, readPositions: emptyReader, now: () => Date.now(), signal: ac.signal });
    await waitFor(() => outs.some((l) => urlRe.test(l)), 120_000);
    const match = urlRe.exec(outs.join("\n"))!;
    const origin = match[1].replace(/\/$/, "");
    allowOrigin(origin);
    expect((await fetch(`${origin}/api/desk/verdict`, { headers: { "x-desk-token": match[2] } })).status).toBe(200);
    expect((await fetch(`${origin}/api/desk/verdict`)).status).toBe(403);
    ac.abort();
    expect(await done).toBe(0);
  }, 180_000);

  test("GET / returns the page without the token and without book values, addresses, holder suffixes or units", async () => {
    for (const path of ["/", "/desk.js", "/desk.css"]) {
      const res = await fetch(`${main.origin}${path}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(main.token);
      expect(body).not.toContain("syn-burrow-usdt");
      expect(body).not.toContain("syn-intents-usdc");
      expect(body).not.toContain("syn-intents-sol-usdc");
      expect(body).not.toContain("syn-stake");
      expect(body).not.toContain("synthetic-owner-a");
      expect(body).not.toContain("synthetic-owner-b");
      expect(body).not.toContain("synthetic-owner-c");
      expect(body).not.toContain("nep141:usdt.tether-token.near");
      expect(body).not.toContain("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
      expect(body).not.toContain("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near");
      expect(body).not.toContain("contract.main.burrow.near");
      expect(body).not.toContain("astro-stakers.poolv1.near");
    }
    const page = await (await fetch(`${main.origin}/`)).text();
    for (const quantity of ["1250.5", "42.125", "800", "500"]) {
      expect(page, `the page holds the quantity ${quantity}`).not.toContain(quantity);
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC2 — failure before serving                                        */
/* ------------------------------------------------------------------ */

describe("AC2 failure before any port is bound", () => {
  const rejectionCases: { argv: string[]; cause: RegExp }[] = [
    { argv: ["no-such-policy-xyz"], cause: /policy/ },
    { argv: ["quantrin-near-v1", "--snapshot", "no-such-snapshot"], cause: /unknown-snapshot/ },
    { argv: ["quantrin-near-v1", "--positions", "tests/fixtures/near-risk-desk-v2/book-rejected.json"], cause: /positions-file-rejected/ },
    { argv: ["quantrin-near-v1", "--address", "abc"], cause: /malformed-address/ },
    { argv: ["quantrin-near-v1", "--port", "0"], cause: /port/ },
    { argv: ["quantrin-near-v1", "--port", "65536"], cause: /port/ },
  ];

  test("each refused launch exits 2 with exactly one stderr line naming the cause", async () => {
    for (const { argv, cause } of rejectionCases) {
      const errs: string[] = [];
      const code = await runDeskCommand(argv, { err: (l) => errs.push(l), env: {}, readPositions: emptyReader, now: () => Date.now() });
      expect(code, JSON.stringify(argv)).toBe(2);
      expect(errs, JSON.stringify(argv)).toHaveLength(1);
      expect(errs[0], JSON.stringify(argv)).toMatch(cause);
    }
  }, 120_000);

  test("the requested port of a refused launch is free, and a valid launch then binds it", async () => {
    const port = await freePort();
    allowOrigin(`http://127.0.0.1:${port}`);
    const errs: string[] = [];
    const code = await runDeskCommand(
      ["quantrin-near-v1", "--positions", "tests/fixtures/near-risk-desk-v2/book-rejected.json", "--port", String(port)],
      { err: (l) => errs.push(l), env: {}, readPositions: emptyReader, now: () => Date.now() },
    );
    expect(code).toBe(2);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/positions-file-rejected/);
    let refused = false;
    try { await fetch(`http://127.0.0.1:${port}/`); } catch { refused = true; }
    expect(refused, "the refused launch must not hold the port").toBe(true);

    const ac = new AbortController();
    const outs: string[] = [];
    const done = runDeskCommand(["quantrin-near-v1", "--port", String(port)], { out: (l) => outs.push(l), env: {}, readPositions: emptyReader, now: () => Date.now(), signal: ac.signal });
    await waitFor(() => outs.length > 0, 120_000);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    ac.abort();
    expect(await done).toBe(0);
  }, 180_000);
});

/* ------------------------------------------------------------------ */
/* AC3 — verdict equals the CLI                                        */
/* ------------------------------------------------------------------ */

describe("AC3 verdict equals the CLI", () => {
  test("the surface's rule rows hold the CLI's rule ids and outcomes, rule for rule, in order", async () => {
    const res = await fetch(`${main.origin}/api/desk/surface/verdict`, { headers: authHeaders(main) });
    expect(res.status).toBe(200);
    const messages: A2uiMessage[] = await res.json();
    const rules = resultOf(messages, "rules");
    expect(rules).not.toBeNull();
    const rows = rowsOf(rules);
    const surfacePairs = rows.map((r) => [r.key, r.values.outcome]);
    const cliPairs = cliVerdict.rules.map((r) => [r.ruleId, r.outcome]);
    expect(surfacePairs).toEqual(cliPairs);
    for (const id of ["rhea-dao-open-funds", "usdc-route-family"]) {
      expect(rows.some((r) => r.key === id), `${id} must stay in the surface`).toBe(true);
    }
    const flipped = cliPairs.map((p) => [...p]);
    flipped[0][1] = flipped[0][1] === "within-policy" ? "outside-policy" : "within-policy";
    expect(flipped).not.toEqual(surfacePairs);
  }, 60_000);

  test("GET /api/desk/verdict returns JSON whose canonical form equals the CLI stdout", async () => {
    const res = await fetch(`${main.origin}/api/desk/verdict`, { headers: authHeaders(main) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(canonical(JSON.parse(body))).toBe(cliStdout);
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC4 — every view is a valid kit surface                             */
/* ------------------------------------------------------------------ */

describe("AC4 valid kit surfaces", () => {
  const snapshotReceiptIds = (): string[] =>
    syntheticState.snapshotIds.flatMap((id) => (syntheticState.store.snapshot(id)?.receipts ?? []).map((r) => r.id));

  test("each of the five views validates against the kit with the snapshot's receipts, names the catalog, and is byte-identical on a second call", async () => {
    for (const view of ["verdict", "map", "words", "changes", "unknowns"]) {
      const first = await fetch(`${main.origin}/api/desk/surface/${view}`, { headers: authHeaders(main) });
      expect(first.status, view).toBe(200);
      const bodyA = await first.text();
      const messages: A2uiMessage[] = JSON.parse(bodyA);
      const validation = validateSurface(messages, { resolveEvidence: receiptResolver(snapshotReceiptIds()) });
      expect(validation.ok, `${view}: ${JSON.stringify(validation.findings)}`).toBe(true);
      const create = messages.find((m) => "createSurface" in m) as { createSurface: { catalogId: string; surfaceId: string } } | undefined;
      expect(create).toBeDefined();
      expect(create!.createSurface.catalogId).toBe("linchpin.evidence.v1");
      expect(create!.createSurface.surfaceId).toBe(`desk-${view}`);
      const second = await fetch(`${main.origin}/api/desk/surface/${view}`, { headers: authHeaders(main) });
      expect(await second.text()).toBe(bodyA);
    }
  }, 120_000);

  test("an unknown view name is 404", async () => {
    const res = await fetch(`${main.origin}/api/desk/surface/no-such-view`, { headers: authHeaders(main) });
    expect(res.status).toBe(404);
  }, 30_000);

  test("with a receipt removed from what the view may cite, the view citing it is refused with unresolved-evidence and no messages", async () => {
    const cited = cliVerdict.rules.flatMap((r) => r.receiptIds)[0];
    expect(cited).toBeDefined();
    const hooked = await serve(syntheticState, baseDeps(), { testHooks: { missingReceiptIds: [cited] } });
    try {
      const res = await fetch(`${hooked.origin}/api/desk/surface/verdict`, { headers: authHeaders(hooked) });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("view-refused");
      expect(body.codes).toContain("unresolved-evidence");
      expect(JSON.stringify(body)).not.toContain("createSurface");
      expect((await fetch(`${hooked.origin}/api/desk/verdict`, { headers: authHeaders(hooked) })).status).toBe(200);
    } finally {
      await hooked.stop();
    }
  }, 60_000);

  test("no file under src/desk uses a DOM sink or eval", () => {
    const root = join(import.meta.dir, "..", "src", "desk");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const sinks of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
      for (const file of files) expect(readFileSync(file, "utf8"), `${file} holds ${sinks}`).not.toContain(sinks);
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* AC5 — dependency map                                                */
/* ------------------------------------------------------------------ */

/** The spec's outcome order and the mark each outcome draws, read from the spec, not from the code. */
const OUTCOME_ORDER: Outcome[] = ["outside-policy", "undetermined", "within-policy"];
const MARK_FOR_OUTCOME: Record<string, GraphMark> = {
  "outside-policy": "attention",
  "undetermined": "undetermined",
  "within-policy": "clear",
  "no-rule": "unmarked",
};

describe("AC5 dependency map", () => {
  let mapMessages: A2uiMessage[];
  let tree: ReturnType<typeof interpret>;

  beforeAll(async () => {
    const res = await fetch(`${main.origin}/api/desk/surface/map`, { headers: authHeaders(main) });
    expect(res.status).toBe(200);
    mapMessages = await res.json();
    tree = interpret(mapMessages);
  }, 60_000);

  test("the outcome-to-mark table the test checks against is the one the spec and O-V1 fix", () => {
    expect(MARK_OF_OUTCOME as Record<string, GraphMark>).toEqual(MARK_FOR_OUTCOME);
  }, 30_000);

  test("one graph result per NEAR position, in book order, with the chain's subjects and the position node", () => {
    expect(syntheticState.positions.length).toBe(4);
    for (let i = 0; i < syntheticState.positions.length; i++) {
      const entry = syntheticState.positions[i];
      const graph = resultOf(mapMessages, `pos-${i}`) as unknown as GraphResult | null;
      expect(graph, `pos-${i}`).not.toBeNull();
      expect(graph!.shape).toBe("graph");
      const positionNodeId = `position:${entry.position.id}`;
      const nodeIds = graph!.nodes.map((n) => n.id);
      expect(nodeIds).toContain(positionNodeId);
      if (entry.root !== null) {
        const chain = nearChain(syntheticState.store, syntheticState.snapshotId, entry.root);
        const expected = new Set([...chain.controls.map((c) => c.subject), positionNodeId]);
        expect(new Set(nodeIds)).toEqual(expected);
      }
      const positionNode = graph!.nodes.find((n) => n.id === positionNodeId)!;
      expect(positionNode.label.endsWith("private: not sent to the agent")).toBe(true);
      expect(positionNode.isolated).toBe(true);
      expect(positionNode.mark).toBeUndefined();
    }
  }, 120_000);

  test("every edge carries exactly one fact id that resolves, and no edge exists without a fact", () => {
    const receiptIds = syntheticState.snapshotIds.flatMap((id) => (syntheticState.store.snapshot(id)?.receipts ?? []).map((r) => r.id));
    const resolves = receiptResolver(receiptIds);
    for (let i = 0; i < syntheticState.positions.length; i++) {
      const entry = syntheticState.positions[i];
      const graph = resultOf(mapMessages, `pos-${i}`) as unknown as GraphResult;
      const factIds = new Set<string>();
      if (entry.root !== null) {
        const chain = nearChain(syntheticState.store, syntheticState.snapshotId, entry.root);
        for (const f of chain.facts) factIds.add(f.id);
      }
      for (const edge of graph.edges) {
        expect(edge.factIds, `pos-${i} edge ${edge.key}`).toHaveLength(1);
        expect(factIds.has(edge.factIds[0]), `edge ${edge.key} names no fact of the chain`).toBe(true);
        expect(edge.evidenceIds.length).toBeGreaterThan(0);
        expect(resolves(edge.evidenceIds).missing, `edge ${edge.key} evidence`).toEqual([]);
      }
      if (graph.edges.length > 0) {
        const mutated = structuredClone(graph);
        mutated.edges[0].factIds = [];
        expect(() => {
          expect(mutated.edges[0].factIds).toHaveLength(1);
          expect(factIds.has(mutated.edges[0].factIds[0])).toBe(true);
        }, "the edge check must bite on a graph whose edge lost its fact").toThrow();
      }
    }
  }, 120_000);

  test("each chain node carries the worst outcome of the rules naming it, drawn as a word as well as a mark", () => {
    const outcomeOf = new Map(cliVerdict.rules.map((r) => [r.ruleId, r.outcome]));
    const drawnWords: string[] = [];
    for (const el of findAll(tree.root, (n) => (n.attrs?.class ?? "").includes("lk-mark-word"))) drawnWords.push(...(el.text ?? "").split(" · "));
    for (const el of findAll(tree.root, (n) => n.tag === "span" && (n.attrs?.class ?? "").includes("lk-mark") && !(n.attrs?.class ?? "").includes("lk-mark-"))) drawnWords.push(el.text ?? "");
    const errors = tree.errors;
    expect(errors).toEqual([]);

    let checkedNodes = 0;
    for (let i = 0; i < syntheticState.positions.length; i++) {
      const entry = syntheticState.positions[i];
      const graph = resultOf(mapMessages, `pos-${i}`) as unknown as GraphResult;
      for (const node of graph.nodes) {
        const expectedWords: string[] = [];
        if (!node.id.startsWith("position:")) {
          const outcomes: Outcome[] = [];
          for (const rule of syntheticState.policy.rules) {
            if (ruleSubjects(rule).includes(node.id)) {
              const outcome = outcomeOf.get(rule.id);
              if (outcome) outcomes.push(outcome);
            }
          }
          const worst = OUTCOME_ORDER.find((o) => outcomes.includes(o)) ?? "no-rule";
          expectedWords.push(MARK_FOR_OUTCOME[worst]);
        }
        const marks: string[] = node.mark === undefined ? [] : Array.isArray(node.mark) ? node.mark : [node.mark];
        for (const word of expectedWords) expect(marks, `${node.id}`).toContain(word);
        for (const mark of marks) expect(Object.values(MARK_FOR_OUTCOME) as string[], `${node.id} mark`).toContain(mark);
        checkedNodes++;
      }
    }
    expect(checkedNodes).toBeGreaterThan(0);

    const expectedWordMultiset = syntheticState.positions.flatMap((entry, i) => {
      const graph = resultOf(mapMessages, `pos-${i}`) as unknown as GraphResult;
      return graph.nodes.filter((n) => !n.id.startsWith("position:")).flatMap((n): string[] => (n.mark === undefined ? [] : Array.isArray(n.mark) ? n.mark : [n.mark]));
    }).sort();
    const svgWords = findAll(tree.root, (n) => (n.attrs?.class ?? "").includes("lk-mark-word")).flatMap((n) => (n.text ?? "").split(" · ")).sort();
    const listWords = findAll(tree.root, (n) => n.tag === "span" && (n.attrs?.class ?? "").split(/\s+/).includes("lk-mark")).map((n) => n.text ?? "").sort();
    expect(svgWords).toEqual(expectedWordMultiset);
    expect(listWords).toEqual(expectedWordMultiset);
  }, 120_000);

  test("a subject no rule names carries unmarked", () => {
    const outcomeOf = new Map(cliVerdict.rules.map((r) => [r.ruleId, r.outcome]));
    const graph = resultOf(mapMessages, "pos-0") as unknown as GraphResult;
    const unmarked = graph.nodes.filter((n) => {
      if (n.id.startsWith("position:")) return false;
      return !syntheticState.policy.rules.some((rule) => ruleSubjects(rule).includes(n.id) && outcomeOf.has(rule.id));
    });
    expect(unmarked.length).toBeGreaterThan(0);
    for (const node of unmarked) expect((node.mark === undefined ? [] : Array.isArray(node.mark) ? node.mark : [node.mark]) as string[]).toContain("unmarked");
  }, 60_000);

  test("an uncovered position draws the position node, its root, partial coverage and the missing-subject note", () => {
    const index = syntheticState.positions.findIndex((p) => p.root === "near:mainnet:astro-stakers.poolv1.near");
    expect(index).toBeGreaterThanOrEqual(0);
    const graph = resultOf(mapMessages, `pos-${index}`) as unknown as GraphResult;
    expect(graph.coverage).toBe("partial");
    expect(notesOf(graph as unknown as Record<string, unknown>).join(" ")).toContain("missing-subject");
    expect(graph.nodes.map((n) => n.id)).toEqual([`position:${syntheticState.positions[index].position.id}`, "near:mainnet:astro-stakers.poolv1.near"]);
  }, 60_000);

  test("a book with no NEAR position yields the no-position note", async () => {
    const address = generatedSolanaAddress();
    const state = await loadDeskState({ policy: "quantrin-near-v1", addresses: [`solana:${address}`] }, baseDeps({
      readPositions: async (input) => readerResultFor(input.address, "sol-only-pos", readerReceiptId),
    }));
    const server = await serve(state, baseDeps());
    try {
      const res = await fetch(`${server.origin}/api/desk/surface/map`, { headers: authHeaders(server) });
      expect(res.status).toBe(200);
      const messages: A2uiMessage[] = await res.json();
      const graph = resultOf(messages, "map") as unknown as GraphResult | null;
      expect(graph).not.toBeNull();
      expect(graph!.nodes).toHaveLength(0);
      expect(notesOf(graph as unknown as Record<string, unknown>).join(" ")).toContain("No NEAR position in this book");
      expect(textOf(interpret(messages).root)).toContain("No NEAR position in this book");
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("interpret refuses a mark that is not one of the five words", () => {
    const mutated = structuredClone(mapMessages) as A2uiMessage[];
    for (const m of mutated) {
      if ("updateDataModel" in m) {
        const value = m.updateDataModel.value as { results?: Record<string, { nodes?: { mark?: unknown }[] }> };
        for (const result of Object.values(value.results ?? {})) {
          for (const node of result.nodes ?? []) if (node.mark !== undefined) node.mark = "bogus";
        }
      }
    }
    const badTree = interpret(mutated);
    expect(badTree.errors.map((e) => e.code)).toContain("unknown-mark");
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC6 — plain words                                                   */
/* ------------------------------------------------------------------ */

describe("AC6 plain words", () => {
  test("every rule kind of the NEAR policy registry has an outside-policy and an undetermined template", () => {
    expect([...Object.keys(SENTENCE_TEMPLATES)].sort()).toEqual([...NEAR_POLICY_KINDS].sort());
    for (const kind of NEAR_POLICY_KINDS) {
      expect(SENTENCE_TEMPLATES[kind], kind).toBeDefined();
      expect(SENTENCE_TEMPLATES[kind]["outside-policy"], `${kind}/outside-policy`).toBeDefined();
      expect(SENTENCE_TEMPLATES[kind]["undetermined"], `${kind}/undetermined`).toBeDefined();
    }
  }, 30_000);

  for (const kind of NEAR_POLICY_KINDS) {
    test(`kind ${kind}: every value in both sentences comes from the rule's parameters, reasons or facts, and no other digit appears`, () => {
      for (const outcome of ["outside-policy", "undetermined"] as const) {
        const template = SENTENCE_TEMPLATES[kind][outcome];
        const placeholders = [...template.text.matchAll(/\{(param\.[A-Za-z0-9_.-]+|reason\.subject|reason\.ref|fact\.object)\}/g)].map((m) => m[1]);
        const params: Record<string, unknown> = {};
        for (const p of placeholders) if (p.startsWith("param.")) params[p.slice("param.".length)] = `value-of-${p.slice("param.".length)}`;
        const rule = { id: `${kind}-probe`, kind, params };
        const reasons = [{ code: template.codes[0] ?? "probe-code", subject: "subject-example", ref: "ref-example" }];
        const facts = [{ object: "object-example" }];
        const sentence = sentenceFor(rule, { outcome, reasons }, facts);
        const expected = template.text.replace(/\{(param\.[A-Za-z0-9_.-]+|reason\.subject|reason\.ref|fact\.object)\}/g, (_, p: string) =>
          p.startsWith("param.") ? String(params[p.slice("param.".length)]) : p === "reason.subject" ? "subject-example" : p === "reason.ref" ? "ref-example" : "object-example");
        expect(sentence.text, `${kind}/${outcome}`).toBe(expected);
        expect(sentence.text, `${kind}/${outcome} leftover placeholder`).not.toContain("{");
        const sources = [...Object.values(params).map(String), "subject-example", "ref-example", "object-example"];
        for (const value of sentence.values) expect(sources, `${kind}/${outcome} value ${value.value}`).toContain(value.value);
        let stripped = sentence.text;
        for (const value of sentence.values) stripped = stripped.split(value.value).join("");
        expect(stripped, `${kind}/${outcome} digits outside the values`).not.toMatch(/[0-9]/);
      }
    }, 30_000);
  }

  test("a reason code with no template shows the code itself as the sentence", () => {
    const kind = [...NEAR_POLICY_KINDS][0];
    const sentence = sentenceFor({ id: "x", kind, params: {} }, { outcome: "outside-policy", reasons: [{ code: "no-template-for-this-code", subject: null, ref: null }] }, []);
    expect(sentence.text).toBe("no-template-for-this-code");
  }, 30_000);

  test("summary rows name the positions, give the per-chain outside-policy count, and hold no score, rating, grade, risk level, percent or ratio", async () => {
    const res = await fetch(`${main.origin}/api/desk/surface/verdict`, { headers: authHeaders(main) });
    const messages: A2uiMessage[] = await res.json();
    const summary = resultOf(messages, "summary");
    expect(summary).not.toBeNull();
    const outcomeOf = new Map(cliVerdict.rules.map((r) => [r.ruleId, r.outcome]));
    const bookRoots = syntheticState.positions.map((p) => p.root);
    for (const row of rowsOf(summary)) {
      const sentence = String(row.values.sentence ?? "");
      const root = String(row.values.chain ?? "");
      expect(bookRoots, `summary row for ${root}`).toContain(root);
      expect(sentence).toContain(root);
      expect(sentence).not.toContain("%");
      expect(sentence).not.toMatch(/\d\s*\/\s*\d/);
      for (const word of ["score", "rating", "grade", "risk level"]) expect(sentence.toLowerCase()).not.toContain(word);
      const chain = nearChain(syntheticState.store, syntheticState.snapshotId, root);
      const chainNodes = new Set(chain.controls.map((c) => c.subject));
      const outside = cliVerdict.rules.filter((r) => r.outcome === "outside-policy" && syntheticState.policy.rules.some((spec) => spec.id === r.ruleId && ruleSubjects(spec).some((s) => chainNodes.has(s)))).length;
      const positions = bookRoots.filter((r) => r === root).length;
      for (const digit of sentence.match(/\d+/g) ?? []) {
        expect([String(positions), String(outside)], `sentence digits of ${root}: ${sentence}`).toContain(digit);
      }
    }
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* AC7 — changes                                                       */
/* ------------------------------------------------------------------ */

describe("AC7 changes", () => {
  test("with --before equal to the snapshot, both change results are empty and each shows No change recorded", async () => {
    const state = await loadDeskState({ policy: "quantrin-near-v1", snapshot: "near-2026-11-09", before: "near-2026-11-09", addresses: [] }, baseDeps());
    const server = await serve(state, baseDeps());
    try {
      const res = await fetch(`${server.origin}/api/desk/surface/changes`, { headers: authHeaders(server) });
      expect(res.status).toBe(200);
      const messages: A2uiMessage[] = await res.json();
      for (const id of ["dependency-changed", "position-changed"]) {
        const result = resultOf(messages, id);
        expect(result, id).not.toBeNull();
        expect(rowsOf(result)).toHaveLength(0);
        expect(notesOf(result).join(" ")).toContain("No change recorded");
      }
      expect(textOf(interpret(messages).root)).toContain("No change recorded");
      const mapRes = await fetch(`${server.origin}/api/desk/surface/map`, { headers: authHeaders(server) });
      const mapMessages: A2uiMessage[] = await mapRes.json();
      for (const result of Object.values(modelResults(mapMessages))) {
        for (const node of (result.nodes as { mark?: unknown }[] | undefined) ?? []) {
          const drawn = node.mark === undefined ? "" : JSON.stringify(node.mark);
          expect(drawn).not.toContain("changed");
        }
      }
    } finally {
      await server.stop();
    }
  }, 300_000);

  test("with the tester's one-rule policy on the constructed snapshot, exactly one dependency-changed row marked constructed, and the locker node carries changed as well as its outcome", async () => {
    const state = await loadDeskState(
      { policy: "tests/fixtures/near-risk-desk-v2/policy-locker-watch.json", snapshot: "near-constructed-intents-locker-added", before: "near-2026-11-09", addresses: [] },
      baseDeps(),
    );
    const server = await serve(state, baseDeps());
    try {
      const changes = await (await fetch(`${server.origin}/api/desk/surface/changes`, { headers: authHeaders(server) })).json() as A2uiMessage[];
      const dependency = resultOf(changes, "dependency-changed");
      expect(dependency).not.toBeNull();
      const rows = rowsOf(dependency);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].values.label)).toContain("constructed");
      expect(resultOf(changes, "position-changed")).not.toBeNull();

      const mapMessages = await (await fetch(`${server.origin}/api/desk/surface/map`, { headers: authHeaders(server) })).json() as A2uiMessage[];
      let found = false;
      for (const result of Object.values(modelResults(mapMessages))) {
        for (const node of ((result.nodes as { id: string; mark?: unknown }[] | undefined) ?? [])) {
          if (node.id === "near:mainnet:intents.near#role:UnrestrictedAccountLocker") {
            found = true;
            const marks = Array.isArray(node.mark) ? node.mark : [node.mark];
            expect(marks).toContain("changed");
            expect(marks).toContain("attention");
          }
        }
      }
      expect(found, "the locker role node must be in the constructed map").toBe(true);
    } finally {
      await server.stop();
    }
  }, 300_000);

  test("without --before the changes view says no earlier snapshot was given and no node carries changed", async () => {
    const res = await fetch(`${main.origin}/api/desk/surface/changes`, { headers: authHeaders(main) });
    expect(res.status).toBe(200);
    const messages: A2uiMessage[] = await res.json();
    expect(resultOf(messages, "dependency-changed")).toBeNull();
    expect(textOf(interpret(messages).root)).toContain("No earlier snapshot given");
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC8 — position sources and unknowns                                 */
/* ------------------------------------------------------------------ */

describe("AC8 position sources and unknowns", () => {
  const solAddress = generatedSolanaAddress();
  const typedAddress = generatedSolanaAddress();

  test("an injected reader answers a flag address and the positions route names the reader source with chain, block and host", async () => {
    const state = await loadDeskState({ policy: "quantrin-near-v1", addresses: [`solana:${solAddress}`] }, baseDeps({
      readPositions: async (input) => readerResultFor(input.address, "sol-flag-pos", readerReceiptId),
    }));
    const server = await serve(state, baseDeps());
    try {
      const pos = await (await fetch(`${server.origin}/api/desk/positions`, { headers: authHeaders(server) })).json();
      expect(pos.book).toBe("none");
      const entry = pos.positions.find((p: { id: string }) => p.id === "sol-flag-pos");
      expect(entry).toBeDefined();
      expect(entry.source).toEqual({ kind: "reader", chain: "solana", block: "31415926", host: pos.readerHost });
      expect(typeof pos.readerHost).toBe("string");
      expect(pos.readerHost.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("an address typed on the page joins the synthetic book in memory, is served, and appears in no log line and no file the test wrote", async () => {
    const logs: string[] = [];
    const state = await loadDeskState({ policy: "quantrin-near-v1", addresses: [] }, baseDeps());
    const server = await serve(state, baseDeps({ readPositions: async (input) => readerResultFor(input.address, "sol-typed-pos", readerReceiptId) }), { log: (l) => logs.push(l) });
    const tempDir = mkdtempSync(join(tmpdir(), "desk-test-"));
    const bookPath = join(tempDir, "book.json");
    await Bun.write(bookPath, JSON.stringify(bookCanary));
    try {
      const typed = await fetch(`${server.origin}/api/desk/addresses`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ address: `solana:${typedAddress}` }) });
      expect(typed.status).toBe(200);
      expect(await typed.json()).toEqual({ ok: true });
      const pos = await (await fetch(`${server.origin}/api/desk/positions`, { headers: authHeaders(server) })).json();
      expect(pos.book).toBe("synthetic");
      expect(pos.positions).toHaveLength(5);
      const typedEntry = pos.positions.find((p: { id: string }) => p.id === "sol-typed-pos");
      expect(typedEntry).toBeDefined();
      expect(typedEntry.source.kind).toBe("reader");
      expect(typedEntry.source.chain).toBe("solana");

      for (const line of logs) expect(line, "a log line holds the typed address").not.toContain(typedAddress);
      const written = readdirSync(tempDir).map((name) => readFileSync(join(tempDir, name), "utf8"));
      for (const text of written) expect(text, "a file written during the test holds the typed address").not.toContain(typedAddress);
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("a positions file gives manual positions under book file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "desk-test-"));
    const bookPath = join(tempDir, "book.json");
    await Bun.write(bookPath, JSON.stringify(bookCanary));
    const state = await loadDeskState({ policy: "quantrin-near-v1", positionsFile: bookPath, addresses: [] }, baseDeps());
    const server = await serve(state, baseDeps());
    try {
      const pos = await (await fetch(`${server.origin}/api/desk/positions`, { headers: authHeaders(server) })).json();
      expect(pos.book).toBe("file");
      expect(pos.positions.length).toBe(2);
      for (const entry of pos.positions) expect(entry.source).toEqual({ kind: "manual" });
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("the synthetic book is the source when no address and no file is given", async () => {
    const pos = await (await fetch(`${main.origin}/api/desk/positions`, { headers: authHeaders(main) })).json();
    expect(pos.book).toBe("synthetic");
    for (const entry of pos.positions) expect(entry.source).toEqual({ kind: "manual" });
  }, 60_000);

  test("a malformed typed address is 400 without echoing the input", async () => {
    const state = await loadDeskState({ policy: "quantrin-near-v1", addresses: [] }, baseDeps());
    const server = await serve(state, baseDeps());
    try {
      const bad = await fetch(`${server.origin}/api/desk/addresses`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ address: "abc" }) });
      expect(bad.status).toBe(400);
      const body = await bad.text();
      expect(body).toContain("malformed-address");
      expect(body).not.toContain("abc");
      const malformed = await fetch(`${server.origin}/api/desk/addresses`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: "{not json" });
      expect(malformed.status).toBe(400);
    } finally {
      await server.stop();
    }
  }, 180_000);

  test("the unknowns surface holds the unreadable near address, a reader error, the uncovered position, the undetermined rule and the chain without a review, with their reasons and never the address", async () => {
    const failingSol = generatedSolanaAddress();
    const state = await loadDeskState(
      { policy: "quantrin-near-v1", addresses: ["near:desknear.near", `solana:${solAddress}`, `solana:${failingSol}`] },
      baseDeps({
        readPositions: async (input) => {
          if (input.chain === "near") return { positions: [], receipts: [], notRead: [{ subject: input.address, reason: "chain-not-supported" }] };
          if (input.address === failingSol) { const error = new Error("desk reader double failed"); (error as unknown as { code: string }).code = "desk-fake-failure"; throw error; }
          return readerResultFor(input.address, "sol-unk-pos", readerReceiptId);
        },
      }),
    );
    const server = await serve(state, baseDeps());
    try {
      const messages = await (await fetch(`${server.origin}/api/desk/surface/unknowns`, { headers: authHeaders(server) })).json() as A2uiMessage[];
      const drawn = textOf(interpret(messages).root);
      const unknowns = resultOf(messages, "unknowns");
      expect(unknowns).not.toBeNull();
      const rows = rowsOf(unknowns);
      const itemOf = (fragment: string) => rows.find((r) => String(r.values.item ?? "").includes(fragment));

      const nearRow = itemOf("address 1, chain near");
      expect(nearRow).toBeDefined();
      expect(String(nearRow!.values.reason)).toContain("not read: no reader for this chain");

      const errorRow = itemOf(`address 3, chain solana`);
      expect(errorRow).toBeDefined();
      expect(String(errorRow!.values.reason)).toMatch(/^reader error: /);
      expect(String(errorRow!.values.reason)).not.toContain(failingSol);

      expect(itemOf("address 2, chain solana"), "a successfully read address is not an unknown").toBeUndefined();
      expect(drawn).toContain("no dependency review for this chain yet");
      expect(drawn).toContain("rhea-oracle-controller");
      const flattened = JSON.stringify(messages);
      expect(flattened).not.toContain(solAddress);
      expect(flattened).not.toContain(failingSol);
      expect(flattened).not.toContain("desknear.near");
    } finally {
      await server.stop();
    }
  }, 300_000);

  test("the synthetic book's uncovered position appears in the unknowns surface with its reason", async () => {
    const messages = await (await fetch(`${main.origin}/api/desk/surface/unknowns`, { headers: authHeaders(main) })).json() as A2uiMessage[];
    const rows = rowsOf(resultOf(messages, "unknowns"));
    const astro = rows.find((r) => String(r.values.item ?? "") === "near:mainnet:astro-stakers.poolv1.near");
    expect(astro).toBeDefined();
    expect(String(astro!.values.reason)).toContain("missing-subject");
  }, 60_000);

  test("an empty unknowns view shows None recorded", () => {
    const emptyState = {
      policy: { policyId: "empty-probe", subjects: [], rules: [] },
      libs: syntheticState.libs,
      store: syntheticState.store,
      snapshotId: syntheticState.snapshotId,
      before: null,
      snapshotIds: syntheticState.snapshotIds,
      review: { publicVerdict: { policyId: "empty-probe", outcome: "within-policy", evaluatedAt: "2026-11-09T00:00:00Z", rules: [] }, unknowns: [] },
      watch: null,
      book: "synthetic" as const,
      readerHost: "in-process",
      readerClient: {},
      addresses: [],
      positions: [],
      privateReceipts: [],
    } as unknown as DeskState;
    const messages = buildSurface("unknowns", emptyState);
    expect(notesOf(resultOf(messages, "unknowns")).join(" ")).toContain("None recorded");
    expect(textOf(interpret(messages).root)).toContain("None recorded");
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC9 — text, words, assets                                           */
/* ------------------------------------------------------------------ */

describe("AC9 text, words, assets", () => {
  let mapMessages: A2uiMessage[];
  let positionsMessages: A2uiMessage[];

  beforeAll(async () => {
    const state = await loadDeskState({ policy: "quantrin-near-v1", addresses: ["near:desknear.near"] }, baseDeps({
      readPositions: async (input) => ({
        positions: [{ id: HOSTILE, subject: "near:mainnet:intents.near#holder:hostileholderx", quantity: "1", unit: "near", snapshotId: "desk-reader.test", source: "reader", fixtureKind: "synthetic", receiptIds: [readerReceiptId] }],
        receipts: [{ id: readerReceiptId, source: "in-process test double", responseSha256: "cd".repeat(32), observation: { chain: "near", network: "mainnet", blockOrSlot: "223810432", blockHash: null, observedAt: "2026-11-09T00:00:00Z", retrievedAt: "2026-11-09T00:00:00Z", historicalState: "pinned" }, privacy: "private" }],
        notRead: [],
      }),
    }));
    const server = await serve(state, baseDeps());
    try {
      mapMessages = await (await fetch(`${server.origin}/api/desk/surface/map`, { headers: authHeaders(server) })).json();
      const positionsRes = await fetch(`${server.origin}/api/desk/positions`, { headers: authHeaders(server) });
      const positionsBody = await positionsRes.json();
      positionsMessages = positionsBody.surface;
      expect(positionsMessages).toBeDefined();
    } finally {
      await server.stop();
    }
  }, 300_000);

  test("the hostile position id is literal text in the map and the positions strip, with no img element anywhere", () => {
    for (const [name, messages] of [["map", mapMessages], ["positions", positionsMessages]] as const) {
      const drawn = interpret(messages);
      expect(textOf(drawn.root), name).toContain(HOSTILE);
      expect(findAll(drawn.root, (n) => n.tag === "img"), `${name}: an img element was drawn`).toEqual([]);
      const html = treeToHtml(drawn);
      expect(html, name).not.toContain("<img");
      expect(html, name).toContain("&lt;img src=x onerror=alert(1)&gt;");
      const { host, createdTags } = fakeDocumentHost();
      mount(drawn, host as unknown as Element);
      expect(createdTags, name).not.toContain("img");
      expect(createdTags, name).not.toContain("script");
    }
  }, 120_000);

  test("no fixed label, template or page word is one findNearBannedWords rejects, and the check bites", () => {
    const labels: string[] = [];
    for (const value of Object.values(DESK_STRINGS)) labels.push(typeof value === "function" ? "probe" : String(value));
    labels.push(DESK_TEXT.summary(2, "root.example", 1), DESK_TEXT.summaryUncovered(1, "root.example"), DESK_TEXT.addressItem(1, "chain"), DESK_TEXT.notRead("reason"), DESK_TEXT.readerError("code"), DESK_TEXT.explainQuestion("rule", ["subject"]), DESK_TEXT.changesTitle("before"), DESK_TEXT.policyTitle("policy"), DESK_TEXT.morePositions(2), DESK_TEXT.positionsListed(2), DESK_TEXT.positionsOnRoot(2), DESK_TEXT.chainItem("chain"), DESK_TEXT.ruleItem("rule"));
    for (const kind of Object.keys(SENTENCE_TEMPLATES)) for (const outcome of ["outside-policy", "undetermined"] as const) labels.push(SENTENCE_TEMPLATES[kind][outcome].text);
    for (const label of labels) expect(findNearBannedWords(label), JSON.stringify(label)).toEqual([]);
    expect(findNearBannedWords("please exit now")).toEqual(["exit"]);
  }, 60_000);

  test("the page and its assets request nothing outside their own origin", async () => {
    const svgNamespace = "http://www.w3.org/2000/svg";
    for (const path of ["/", "/desk.js", "/desk.css"]) {
      const text = await (await fetch(`${main.origin}${path}`)).text();
      expect(text, `${path} @import`).not.toContain("@import");
      expect(text, `${path} url(`).not.toContain("url(");
      let scrubbed = text.split(svgNamespace).join("");
      scrubbed = scrubbed.split(main.origin).join("");
      expect(scrubbed, `${path} outside URL`).not.toMatch(/https?:/);
    }
  }, 60_000);

  test("the banned-word scan bites on a desk label holding one", () => {
    expect(findNearBannedWords("this is a safe rule")).toEqual(["safe"]);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* The fake IronClaw                                                   */
/* ------------------------------------------------------------------ */

interface FakeRequest { method: string; path: string; authorization: string | null; body: string }

function makeFakeIronclaw() {
  const requests: FakeRequest[] = [];
  const config = { delayMs: 0, status: 200, payload: {
    id: "resp_fake_1",
    output: [
      { type: "function_call", name: "linchpin_review" },
      { type: "message", content: [{ type: "output_text", text: "plain answer text" }] },
    ],
  } as unknown };
  let hold: (() => void) | null = null;
  let holdOpen = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 255,
    async fetch(req) {
      requests.push({ method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get("authorization"), body: await req.text() });
      if (config.delayMs) await new Promise((r) => setTimeout(r, config.delayMs));
      if (holdOpen) await new Promise<void>((resolve) => { hold = resolve; });
      return Response.json(config.payload, { status: config.status });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    server, origin, requests, config,
    get holding() { return holdOpen; },
    holdOpenNow() { holdOpen = true; },
    release() { holdOpen = false; hold?.(); hold = null; },
    async stop() { await server.stop(true); },
  };
}

const AGENT_TOKEN = "desk-test-agent-token-0123456789abcdef";

/* ------------------------------------------------------------------ */
/* AC10 — agent panel forwards only the question                        */
/* ------------------------------------------------------------------ */

describe("AC10 agent panel", () => {
  let fake: ReturnType<typeof makeFakeIronclaw>;
  let server: Awaited<ReturnType<typeof startDesk>>;

  beforeAll(async () => {
    fake = makeFakeIronclaw();
    allowOrigin(fake.origin);
    server = await serve(syntheticState, baseDeps({ env: { LINCHPIN_IRONCLAW_URL: fake.origin, LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }));
  }, 120_000);

  afterAll(async () => {
    await server.stop();
    await fake.stop();
  });

  test("GET /api/desk/agent reports the enabled panel", async () => {
    const agent = await (await fetch(`${server.origin}/api/desk/agent`, { headers: authHeaders(server) })).json();
    expect(agent).toEqual({ enabled: true, reason: null, text: null });
  }, 30_000);

  test("one ask sends exactly one request with the question, the fixed fields and the bearer, and nothing else", async () => {
    expect(fake.requests).toHaveLength(0);
    const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question: "What does intents-locker-max require?" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.heading).toBe("unchecked summary");
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/v1/responses");
    expect(request.authorization).toBe(`Bearer ${AGENT_TOKEN}`);
    const sent = JSON.parse(request.body);
    expect(Object.keys(sent).sort()).toEqual(["input", "model", "stream"]);
    expect(sent.input).toBe("What does intents-locker-max require?");
    expect(sent.model).toBe("default");
    expect(sent.stream).toBe(false);
  }, 60_000);

  test("explain further sends only the rule id and its public subject", async () => {
    fake.requests.length = 0;
    const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ explain: { ruleId: "intents-locker-max" } }) });
    expect(res.status).toBe(200);
    const sent = JSON.parse(fake.requests[0].body);
    expect(Object.keys(sent).sort()).toEqual(["input", "model", "stream"]);
    expect(sent.input).toBe("Explain rule intents-locker-max on near:mainnet:intents.near#role:UnrestrictedAccountLocker.");
  }, 60_000);

  test("the previous response id is forwarded when given", async () => {
    // Self-contained: an ask first, so this server process has issued resp_fake_1
    // whatever ran before (the server accepts only ids it issued).
    const first = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question: "first question" }) });
    expect(first.status).toBe(200);
    expect((await first.json()).responseId).toBe("resp_fake_1");
    fake.requests.length = 0;
    const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question: "follow up", previousResponseId: "resp_fake_1" }) });
    expect(res.status).toBe(200);
    const sent = JSON.parse(fake.requests[0].body);
    expect(Object.keys(sent).sort()).toEqual(["input", "model", "previous_response_id", "stream"]);
    expect(sent.previous_response_id).toBe("resp_fake_1");
  }, 60_000);

  test("an unknown explain rule id is 400 and nothing is sent", async () => {
    fake.requests.length = 0;
    const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ explain: { ruleId: "no-such-rule-id" } }) });
    expect(res.status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  }, 60_000);

  test("the bearer token appears in no response, asset, log line or error body", async () => {
    const seen: string[] = [];
    for (const path of ["/", "/desk.js", "/desk.css", "/api/desk/verdict", "/api/desk/surface/verdict", "/api/desk/positions", "/api/desk/agent"]) {
      const res = await fetch(`${server.origin}${path}`, { headers: authHeaders(server) });
      seen.push(await res.text());
    }
    const errorRes = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question: "q" }) });
    seen.push(await errorRes.text());
    for (const text of seen) expect(text, "the token leaked").not.toContain(AGENT_TOKEN);
  }, 60_000);

  test("a non-loopback URL disables the panel, no request is sent, and the other routes still answer", async () => {
    const disabled = await serve(syntheticState, baseDeps({ env: { LINCHPIN_IRONCLAW_URL: "http://192.0.2.1:3000", LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }));
    try {
      const agent = await (await fetch(`${disabled.origin}/api/desk/agent`, { headers: authHeaders(disabled) })).json();
      expect(agent.enabled).toBe(false);
      expect(agent.text).toBe("IronClaw panel: not demonstrated");
      expect(agent.reason).toBe("url-not-loopback");
      const ask = await fetch(`${disabled.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(disabled, { "content-type": "application/json" }), body: JSON.stringify({ question: "q" }) });
      expect(ask.status).toBe(503);
      const body = await ask.json();
      expect(body.enabled).toBe(false);
      expect(body.text).toBe("IronClaw panel: not demonstrated");
      expect((await fetch(`${disabled.origin}/api/desk/verdict`, { headers: authHeaders(disabled) })).status).toBe(200);
    } finally {
      await disabled.stop();
    }
  }, 60_000);

  test("a missing token disables the panel and asks get 503", async () => {
    const disabled = await serve(syntheticState, baseDeps({}));
    try {
      const agent = await (await fetch(`${disabled.origin}/api/desk/agent`, { headers: authHeaders(disabled) })).json();
      expect(agent.enabled).toBe(false);
      expect(agent.reason).toBe("token-missing");
      expect(agent.text).toBe("IronClaw panel: not demonstrated");
      expect((await fetch(`${disabled.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(disabled, { "content-type": "application/json" }), body: JSON.stringify({ question: "q" }) })).status).toBe(503);
    } finally {
      await disabled.stop();
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC11 — outgoing guard, canary                                       */
/* ------------------------------------------------------------------ */

describe("AC11 outgoing guard and canaries", () => {
  const FLAG_ADDRESS_CANARY = "cnryacctk3v9h2m1q9w8e7r5t4y3u2i6o1pasdf";
  const TYPED_ADDRESS_CANARY = "cnrytypk5w2m8b4v7c1n2r3y4t5y6p7e8";
  const QUANTITY_CANARY = "73519.000284731";
  const SUFFIX_CANARY = "cnryhold-z7k3m1q9";
  const ID_CANARY = "cnry-pos-k3v9h2m1";
  const CANARIES = [FLAG_ADDRESS_CANARY, TYPED_ADDRESS_CANARY, QUANTITY_CANARY, SUFFIX_CANARY, ID_CANARY];
  const canariesIn = (text: string): string[] => CANARIES.filter((c) => text.includes(c));

  let fake: ReturnType<typeof makeFakeIronclaw>;
  let server: Awaited<ReturnType<typeof startDesk>>;
  let logs: string[];
  let tempDir: string;

  beforeAll(async () => {
    fake = makeFakeIronclaw();
    allowOrigin(fake.origin);
    tempDir = mkdtempSync(join(tmpdir(), "desk-test-"));
    await Bun.write(join(tempDir, "book.json"), JSON.stringify(bookCanary));
    logs = [];
    const state = await loadDeskState(
      { policy: "quantrin-near-v1", positionsFile: join(tempDir, "book.json"), addresses: [`deskchain:${FLAG_ADDRESS_CANARY}`] },
      baseDeps({ env: { LINCHPIN_IRONCLAW_URL: fake.origin, LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }),
    );
    server = await serve(state, baseDeps({ env: { LINCHPIN_IRONCLAW_URL: fake.origin, LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }), { log: (l) => logs.push(l) });
  }, 300_000);

  afterAll(async () => {
    await server.stop();
    await fake.stop();
  });

  test("a typed canary address joins the book", async () => {
    const typed = await fetch(`${server.origin}/api/desk/addresses`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ address: `deskchain2:${TYPED_ADDRESS_CANARY}` }) });
    expect(typed.status).toBe(200);
  }, 60_000);

  test("a question holding any canary gets 422 and the fake receives nothing", async () => {
    const questions = [
      `What is the balance of deskchain:${FLAG_ADDRESS_CANARY}?`,
      `Show the history of deskchain2:${TYPED_ADDRESS_CANARY}`,
      `Why is ${QUANTITY_CANARY} the recorded quantity?`,
      `Who controls ${SUFFIX_CANARY}?`,
      `Explain position ${ID_CANARY}`,
    ];
    for (const question of questions) {
      const before = fake.requests.length;
      const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question }) });
      expect(res.status, question).toBe(422);
      expect(await res.json()).toEqual({ error: "private-value" });
      expect(fake.requests.length).toBe(before);
    }
  }, 120_000);

  test("after every route and three clean questions, no canary reaches the fake, a log line, or any response outside the positions route, the map's position nodes and the private receipts", async () => {
    const responses: { path: string; body: string }[] = [];
    for (const path of ["/", "/desk.js", "/desk.css", "/api/desk/verdict", "/api/desk/surface/verdict", "/api/desk/surface/map", "/api/desk/surface/words", "/api/desk/surface/changes", "/api/desk/surface/unknowns", "/api/desk/positions", "/api/desk/agent"]) {
      const res = await fetch(`${server.origin}${path}`, { headers: authHeaders(server) });
      expect(res.status, path).toBe(200);
      responses.push({ path, body: await res.text() });
    }
    for (const question of ["What does rule intents-locker-max require?", "Which dependencies does the review name?", "Summarize the verdict please."]) {
      const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question }) });
      expect(res.status, question).toBe(200);
      responses.push({ path: "/api/desk/ask", body: await res.text() });
    }

    for (const request of fake.requests) expect(canariesIn(`${request.path} ${request.body}`), "fake IronClaw request").toEqual([]);
    for (const line of logs) expect(canariesIn(line), "desk log line").toEqual([]);
    for (const { path, body } of responses) {
      if (path === "/api/desk/positions") continue;
      if (path === "/api/desk/surface/map") {
        const leak = canaryOutsidePositionNodes(JSON.parse(body), CANARIES);
        expect(leak, "canary outside a position node in the map").toBeNull();
        continue;
      }
      expect(canariesIn(body), `${path} leaks a canary`).toEqual([]);
    }
  }, 120_000);

  test("a clean question passes, so the guard is not refusing everything", async () => {
    const res = await fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify({ question: "Which findings does the desk show?" }) });
    expect(res.status).toBe(200);
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* AC12 — agent answers shown honestly                                 */
/* ------------------------------------------------------------------ */

describe("AC12 agent answers shown honestly", () => {
  let fake: ReturnType<typeof makeFakeIronclaw>;
  let server: Awaited<ReturnType<typeof startDesk>>;
  let factId: string;

  beforeAll(async () => {
    fake = makeFakeIronclaw();
    allowOrigin(fake.origin);
    server = await serve(syntheticState, baseDeps({ env: { LINCHPIN_IRONCLAW_URL: fake.origin, LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }), {});
    factId = cliVerdict.rules.flatMap((r) => r.factIds)[0];
    expect(factId).toBeDefined();
  }, 120_000);

  afterAll(async () => {
    await server.stop();
    await fake.stop();
  });

  const ask = (body: unknown) =>
    fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(server, { "content-type": "application/json" }), body: JSON.stringify(body) });

  test("output text is drawn as text, a resolving id as a reference, an unresolvable id struck through", async () => {
    const invented = `nf:near-2026-11-09:${"f".repeat(40)}`;
    const resolves = idResolver(syntheticState);
    expect(resolves(factId)).toBe(true);
    expect(resolves(invented)).toBe(false);
    fake.config.payload = { id: "resp_script", output: [{ type: "message", content: [{ type: "output_text", text: `<script>alert(1)</script> see ${factId} and ${invented}` }] }] };
    const res = await ask({ question: "show me the ids" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.responseId).toBe("resp_script");
    expect(body.heading).toBe("unchecked summary");
    const textSegments = body.segments.filter((s: { text?: string }) => typeof s.text === "string");
    expect(textSegments.some((s: { text: string }) => s.text.includes("<script>alert(1)</script>"))).toBe(true);
    expect(body.segments).toContainEqual({ id: factId, resolves: true });
    expect(body.segments).toContainEqual({ id: invented, resolves: false });

    const html = treeToHtml(answerTree(body));
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(factId);
    expect(html).toContain("desk-ref");
    expect(html).toContain("not in this snapshot");
  }, 120_000);

  test("tool calls are listed by name, or reported as not reported", async () => {
    fake.config.payload = { id: "resp_tools", output: [{ type: "function_call", name: "linchpin_review" }, { type: "message", content: [{ type: "output_text", text: "done" }] }] };
    const withCalls = await (await ask({ question: "q1" })).json();
    expect(withCalls.toolCalls).toEqual(["linchpin_review"]);
    expect(textOf(answerTree(withCalls))).toContain("linchpin_review");

    fake.config.payload = { id: "resp_nocalls", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] };
    const withoutCalls = await (await ask({ question: "q2" })).json();
    expect(withoutCalls.toolCalls).toBeNull();
    expect(textOf(answerTree(withoutCalls))).toContain("tool calls not reported");
  }, 120_000);

  test("a 401, an unreachable base and a timeout each give a visible error naming the cause, with no answer text", async () => {
    fake.config.status = 401;
    fake.config.payload = { error: "no" };
    const unauthorized = await ask({ question: "q" });
    expect(unauthorized.status).toBe(502);
    const unauthorizedBody = await unauthorized.json();
    expect(unauthorizedBody.error.cause).toBe("unauthorized");
    expect(JSON.stringify(unauthorizedBody)).not.toContain("segments");

    const closedPort = await freePort();
    allowOrigin(`http://127.0.0.1:${closedPort}`);
    const unreachableServer = await serve(syntheticState, baseDeps({ env: { LINCHPIN_IRONCLAW_URL: `http://127.0.0.1:${closedPort}`, LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }), {});
    try {
      const unreachable = await fetch(`${unreachableServer.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(unreachableServer, { "content-type": "application/json" }), body: JSON.stringify({ question: "q" }) });
      expect(unreachable.status).toBe(502);
      const unreachableBody = await unreachable.json();
      expect(unreachableBody.error.cause).toBe("unreachable");
      expect(JSON.stringify(unreachableBody)).not.toContain("segments");
    } finally {
      await unreachableServer.stop();
    }

    fake.config.status = 200;
    fake.config.delayMs = 1500;
    const slow = await serve(syntheticState, baseDeps({ env: { LINCHPIN_IRONCLAW_URL: fake.origin, LINCHPIN_IRONCLAW_TOKEN: AGENT_TOKEN } }), { testHooks: { ironclawTimeoutMs: 200 } });
    try {
      const timeout = await fetch(`${slow.origin}/api/desk/ask`, { method: "POST", headers: authHeaders(slow, { "content-type": "application/json" }), body: JSON.stringify({ question: "q" }) });
      expect(timeout.status).toBe(504);
      const timeoutBody = await timeout.json();
      expect(timeoutBody.error.cause).toBe("timeout");
      expect(JSON.stringify(timeoutBody)).not.toContain("segments");
    } finally {
      await slow.stop();
      fake.config.delayMs = 0;
    }
  }, 180_000);

  test("a second ask while one is running gets 409", async () => {
    fake.config.status = 200;
    fake.config.payload = { id: "resp_held", output: [{ type: "message", content: [{ type: "output_text", text: "held answer" }] }] };
    fake.holdOpenNow();
    const first = ask({ question: "the held question" });
    await new Promise((r) => setTimeout(r, 400));
    const second = await ask({ question: "the overlapping question" });
    expect(second.status).toBe(409);
    fake.release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    await firstRes.text();
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* AC13 — replay, isolation, compatibility                             */
/* ------------------------------------------------------------------ */

describe("AC13 pinned surfaces", () => {
  // The five hashes below were taken from the built surfaces of this run's synthetic
  // book server, as the plan's step table provides for the tester; they are the one
  // place where an expected value comes from the build rather than from the spec text.
  const PINS: Record<string, string> = {
    verdict: "ce111af29af7aac28e390bf1a89b19ba0940ce4b73f5b82e8fb25b64d4b377e0",
    map: "c1ef87b5280d6ee99ebe1cf78f7dc128abd8651845bba9a3ec67ce9d0705ab61",
    words: "31eadf7a46caa3098c98030b345daa405039022620de38f82d2c72ba79840b28",
    changes: "862f68dc2c9232afb038cf024f83e5372d5de4b8289155e41df695a3037d12fb",
    unknowns: "3109c03565571683a64e268c93fc4506bcbf13baa0e8c961b8a7368f4dbfc0ca",
  };

  for (const [view, pin] of Object.entries(PINS)) {
    test(`the ${view} surface of the synthetic book is byte-stable and matches its pin`, async () => {
      const res = await fetch(`${main.origin}/api/desk/surface/${view}`, { headers: authHeaders(main) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(sha256(body)).toBe(pin);
    }, 60_000);
  }

  test("the trap held: every socket attempt went to an in-process loopback server", () => {
    expect(trappedAttempts).toEqual([]);
  }, 30_000);
});
