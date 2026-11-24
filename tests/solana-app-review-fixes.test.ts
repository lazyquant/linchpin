/**
 * Independent regression tests for the reviewed repair of the Solana app after its run was
 * archived. Three behaviors, each against the approved contracts only:
 *   1. private terms of an in-process positions read never reach an optional answers handler
 *      (AC11, AC12): literal, JSON-escaped, nested and decoded-numeric forms are refused 422
 *      before the handler runs; malformed JSON is refused; a benign question passes;
 *   2. a read's known times survive into the drawn data (S8, S14): a live-shaped read keeps its
 *      observation time in the position row asOf, the read meta capturedAt and the sheet's
 *      position-read time, and a live sheet never claims the read has no retrieval time; replayed
 *      reads with no historical time keep null, never today's time or epoch zero;
 *   3. the explorer's shown-of-total edge count (S6, S7, K8) equals the edge rows actually drawn
 *      after focus, step and layer filtering, gap edges included, while the total stays the full
 *      input count.
 * Every expected value here is derived from committed fixtures, public interfaces or the recorded
 * contract decisions - never from an implementation printout.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { join } from "node:path";
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";

import { instantiateV2 } from "../src/ui/templates-v2";
import { explorerModel } from "../src/ui/explorer-model";
import type { GraphResult, UiNode } from "../src/ui/types";

import { loadApp } from "../src/apps/solana/load";
import { PREFIX, type AppData, type ReadData } from "../src/apps/solana/model";
import { sheetSurface, defaultView } from "../src/apps/solana/surfaces";
import { render, resolverOver } from "../src/apps/solana/compose";
import { startServer } from "../src/apps/solana/server";
import { startApp } from "../src/apps/solana/app";
import { IDS } from "../src/apps/solana/chrome";

const ROOT = join(import.meta.dir, "..");
const LONG = 300_000;
const SVG_NS = "http://www.w3.org/2000/svg";

/** bun:test of this checkout takes the timeout as the third argument; the long tests say it inline. */
const testT = (name: string, options: { timeout: number }, fn: () => unknown): void => {
  test(name, fn as () => void, options.timeout);
};

// ---- offline trap for the whole file ----
const realFetch = globalThis.fetch;
const hits = { foreignFetch: 0, websocket: 0, connect: 0, net: 0 };
let restores: (() => void)[] = [];
const loopback = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
};

beforeAll(() => {
  process.chdir(ROOT);
  const spy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!loopback(url)) {
      hits.foreignFetch++;
      throw new Error(`offline: non-loopback fetch trapped (${url})`);
    }
    return realFetch(input as string, init);
  }) as typeof fetch);
  restores.push(() => spy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    constructor() {
      hits.websocket++;
      throw new Error("offline: WebSocket trapped");
    }
  };
  restores.push(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });
  const box = Bun as unknown as { connect: unknown };
  const realConnect = box.connect;
  box.connect = (): never => {
    hits.connect++;
    throw new Error("offline: Bun.connect trapped");
  };
  restores.push(() => {
    box.connect = realConnect;
  });
  for (const mod of [netNamespace, netDefault, httpModule, httpsModule] as unknown as Record<string, unknown>[]) {
    for (const name of ["connect", "createConnection", "request", "get"]) {
      if (typeof mod[name] !== "function") continue;
      const trap = (): never => {
        hits.net++;
        throw new Error("offline: node:net/http(s) trapped");
      };
      try {
        const s = spyOn(mod as Record<string, () => unknown>, name as string).mockImplementation(trap as never);
        restores.push(() => s.mockRestore());
      } catch {
        const real = mod[name];
        try {
          mod[name] = trap;
          restores.push(() => {
            mod[name] = real;
          });
        } catch {
          /* read-only export */
        }
      }
    }
  }
});

afterAll(() => {
  for (const restore of restores) restore();
  restores = [];
  expect(hits).toEqual({ foreignFetch: 0, websocket: 0, connect: 0, net: 0 });
});

// ---- shared data, loaded once ----
let data: AppData;
beforeAll(async () => {
  const loaded = await loadApp(undefined, {});
  data = loaded.data;
}, LONG);

// ---- walking drawn kit trees ----
const textOf = (node: UiNode): string => (node.text ?? "") + node.children.map(textOf).join("");

// ---- a hand-made document for the page (no DOM package; only the members the page uses) ----
type Ev = { preventDefault: () => void; stopPropagation?: () => void; key?: string; currentTarget?: unknown };
class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  kids: FakeElement[] = [];
  ownText: string | null = null;
  parent: FakeElement | null = null;
  listeners = new Map<string, ((e: Ev) => void)[]>();
  doc: FakeDocument;
  value = "";
  constructor(tag: string, doc: FakeDocument) {
    this.tag = tag;
    this.doc = doc;
    (this as unknown as { ownerDocument: FakeDocument }).ownerDocument = doc;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "id") this.doc.register(value, this);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  append(...kids: FakeElement[]): void {
    for (const k of kids) {
      k.parent = this;
      this.kids.push(k);
    }
  }
  replaceChildren(...kids: FakeElement[]): void {
    for (const k of this.kids) k.parent = null;
    this.kids = [];
    this.append(...kids);
  }
  get textContent(): string {
    return (this.ownText ?? "") + this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    this.ownText = v;
    for (const k of this.kids) k.parent = null;
    this.kids = [];
  }
  addEventListener(type: string, fn: (e: Ev) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: Ev = { preventDefault() {}, stopPropagation() {} }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ ...event, currentTarget: this });
  }
  focus(): void {
    this.doc.active = this;
  }
  walk(): FakeElement[] {
    return [this, ...this.kids.flatMap((k) => k.walk())];
  }
  attr(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  byAttr(name: string, value?: string): FakeElement[] {
    return this.walk().filter((el) => (value === undefined ? el.attrs.has(name) : el.attr(name) === value));
  }
  classed(cls: string): FakeElement[] {
    return this.walk().filter((el) => (el.attr("class") ?? "").split(/\s+/).includes(cls));
  }
}
class FakeDocument {
  registry = new Map<string, FakeElement>();
  active: FakeElement | null = null;
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createElementNS(ns: string, tag: string): FakeElement {
    if (ns !== SVG_NS) throw new Error(`unexpected namespace ${ns}`);
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement {
    let el = this.registry.get(id);
    if (!el) {
      el = new FakeElement("div", this);
      this.register(id, el);
    }
    return el;
  }
  register(id: string, el: FakeElement): void {
    this.registry.set(id, el);
  }
  addEventListener(_type: string, _fn: (e: Ev) => void): void {}
}
function makeHarness(): { doc: FakeDocument; location: { hash: string }; setHash(hash: string): void; env(record: Record<string, unknown>): Record<string, unknown> } {
  const doc = new FakeDocument();
  const location = { hash: "#/protocols" };
  const handlers: (() => void)[] = [];
  const sessionStorage = new Map<string, string>();
  const base = {
    document: doc,
    location,
    addEventListener: (type: string, handler: () => void) => {
      if (type === "hashchange") handlers.push(handler);
    },
    sessionStorage: {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => void sessionStorage.set(key, value),
    },
  };
  return {
    doc,
    location,
    setHash(hash: string) {
      location.hash = hash;
      for (const fn of [...handlers]) fn();
    },
    env(record: Record<string, unknown>) {
      return { ...base, ...record };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1 - private terms never reach the answers handler                    */
/* ------------------------------------------------------------------ */
describe("private terms of a read never reach the answers handler", () => {
  // A holder address shaped like a mainnet address but not any account this repo records.
  const ADDR = "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFx";
  const QTY = "739172635";
  const PID = "pos-regression-0007";
  const UNIT = `${PREFIX}2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`;
  const escapeJson = (text: string): string =>
    [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

  /** One valid reply line set, over a receipt the app holds, so a forwarded ask returns 200. */
  const validReply = (): Response => {
    const realReceipt = Object.keys(data.receipts)[0];
    const messages = instantiateV2("answer-panel", {
      surfaceId: "asked",
      meta: { title: "A recorded answer", snapshotIds: [] },
      results: [
        {
          resultId: "t1", shape: "table", coverage: "mapped", coverageNotes: [], truncated: false,
          columns: [{ name: "subject", role: "subject" }],
          rows: [{
            rowKind: "fact", key: "k1", values: { subject: "S", predicate: "P", object: "O" },
            factIds: [], bases: ["decoded"], evidenceIds: [realReceipt], blockOrSlot: "7",
            asOf: null, snapshotIds: ["snap-1"],
          }],
        },
      ],
      receipts: {},
    });
    const lines = messages.map((m) => JSON.stringify(m));
    return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

  testT("literal, escaped, nested and decoded private terms are refused before the handler runs", { timeout: LONG }, async () => {
    let calls = 0;
    let lastBody = "";
    const server = await startServer({
      port: 0,
      data: { ...data, mode: "served", positions: null, ask: { enabled: true } },
      live: true,
      rpcUrl: "http://127.0.0.1:1",
      deps: {
        readPositions: (async () => ({
          positions: [{
            id: PID, subject: `${PREFIX}${ADDR}#holder:${ADDR}`, quantity: QTY, unit: UNIT,
            snapshotId: "solana-reader.live", source: "reader", fixtureKind: "synthetic", receiptIds: [],
          }],
          receipts: [],
          notRead: [],
        })) as never,
      },
      answers: async (request: Request) => {
        calls++;
        lastBody = await request.text();
        return validReply();
      },
    } as never);
    try {
      const headers = { "content-type": "application/json", "x-app-token": server.token, origin: server.origin };
      // The read must have been returned by this process first, so its terms are remembered.
      const warm = await realFetch(`${server.origin}/api/positions`, {
        method: "POST", headers,
        body: JSON.stringify({ source: "live", address: ADDR }),
      });
      expect(warm.status).toBe(200);

      const ask = (rawBody: string) => realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: rawBody });
      const refusedCases: [string, string][] = [
        ["the holder address, literal", JSON.stringify({ question: `tell me about ${ADDR}` })],
        ["the position id, literal", JSON.stringify({ question: `what is ${PID}?` })],
        ["the quantity, literal digits", JSON.stringify({ question: `is ${QTY} large?` })],
        ["the holder address, unicode-escaped", `{"question":"tell me about ${escapeJson(ADDR)}"}`],
        ["the quantity, unicode-escaped digits", `{"question":"is ${escapeJson(QTY)} large?"}`],
        ["the holder address in a nested value", JSON.stringify({ question: "who is this?", context: { account: ADDR } })],
        ["the position id as a nested key", `{"question":"who is this?","${PID}":{"n":1}}`],
        ["the quantity as a decoded number", JSON.stringify({ question: "how much is held?", amount: 739172635 })],
        ["the quantity as an exponent-form number", `{"question":"how much is held?","amount":7.39172635e8}`],
        ["the quantity escaped inside a nested value", `{"question":"who is this?","deep":{"v":"${escapeJson(QTY)}"}}`],
      ];
      for (const [label, rawBody] of refusedCases) {
        const reply = await ask(rawBody);
        expect(reply.status, label).toBe(422);
        const body = (await reply.json()) as { error?: unknown };
        expect(typeof body.error === "string" && body.error.length > 0, label).toBe(true);
        expect(calls, `${label}: the handler must not be called`).toBe(0);
      }
      // Malformed JSON is refused as well, again before the handler.
      const malformed = await ask('{"question":');
      expect(malformed.status).toBeGreaterThanOrEqual(400);
      expect(malformed.status).toBeLessThan(500);
      expect(calls).toBe(0);

      // A benign question reaches the handler once and its reply comes back.
      const benignQuestion = "which protocols does this build cover?";
      const benign = await ask(JSON.stringify({ question: benignQuestion }));
      expect(benign.status).toBe(200);
      expect(calls).toBe(1);
      expect(lastBody).toContain(benignQuestion);

      // A different, longer number is not the remembered whole-number token: it passes too.
      const longer = await ask(JSON.stringify({ question: "is 1739172635 a large amount?", amount: 1739172635 }));
      expect(longer.status, "a longer number that merely contains the quantity must not be refused").not.toBe(422);
      expect(longer.status).toBe(200);
      expect(calls).toBe(2);
      expect(lastBody).toContain("1739172635");
    } finally {
      await server.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2 - a read's known times survive into the drawn data                 */
/* ------------------------------------------------------------------ */
describe("a read's known times survive into the drawn data", () => {
  // The replayed reads are of the one public account the contract names.
  const replayAddress = (): string => {
    const address = data.replayAddress;
    expect(typeof address === "string" && address.length > 0).toBe(true);
    return address as string;
  };
  const servedData = (): AppData => ({ ...data, mode: "served", positions: null });
  const positionReadRows = (read: ReadData): { values: Record<string, unknown> }[] =>
    read.sheets.flatMap((sheet) => {
      const observations = sheet.results.observations as { rows?: { values: Record<string, unknown> }[] } | undefined;
      return (observations?.rows ?? []).filter((r) => r.values.observation === "position read");
    });
  const drawnSheetText = (read: ReadData, ordinal: number): string => {
    const messages = sheetSurface({ ...data, mode: "served", positions: null }, read, ordinal);
    expect(messages, `sheet ${ordinal}`).not.toBeNull();
    const known = new Set([...Object.keys(data.receipts), ...Object.keys(read.receipts)]);
    const out = render(messages!, resolverOver(known));
    expect(out.ok, JSON.stringify(out.ok ? [] : out.codes)).toBe(true);
    return out.ok ? textOf(out.tree.root) : "";
  };

  testT("a live-shaped read keeps its observation time in the row, the read meta and the sheet", { timeout: LONG }, async () => {
    const address = replayAddress();
    const observed = "2026-11-09T16:34:16Z";
    const retrieved = "2026-11-09T17:04:20Z";
    expect(observed).not.toBe(retrieved);
    const server = await startServer({
      port: 0,
      data: servedData(),
      live: true,
      rpcUrl: "http://127.0.0.1:1",
      deps: {
        readPositions: (async () => ({
          positions: [{
            id: "pos-live-time-1",
            subject: `${PREFIX}${address}#holder:${address}`,
            quantity: "12.5",
            unit: `${PREFIX}2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`,
            snapshotId: "solana-reader.live",
            source: "reader",
            fixtureKind: "synthetic",
            receiptIds: ["rcp-live-time-1"],
          }],
          receipts: [{
            id: "rcp-live-time-1",
            source: "in-process test double",
            responseSha256: "ab".repeat(32),
            observation: {
              chain: "solana", network: "mainnet-beta", blockOrSlot: "468300101", blockHash: null,
              observedAt: observed, retrievedAt: retrieved, historicalState: "current-only",
            },
            privacy: "private",
          }],
          notRead: [],
        })) as never,
      },
    } as never);
    try {
      const reply = await realFetch(`${server.origin}/api/positions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-token": server.token, origin: server.origin },
        body: JSON.stringify({ source: "live", address }),
      });
      expect(reply.status).toBe(200);
      const read = (await reply.json()) as ReadData;
      expect(read.source).toBe("live");
      // The actual known time survives in all three sinks; none is nulled, none is today.
      expect(read.meta.capturedAt).toBe(observed);
      expect(read.list.rows.length).toBeGreaterThan(0);
      for (const row of read.list.rows) expect(row.asOf, "position row asOf").toBe(observed);
      const readRows = positionReadRows(read);
      expect(readRows.length).toBeGreaterThan(0);
      for (const row of readRows) expect(row.values.time, "the sheet's position-read time").toBe(observed);
      // The drawn sheet shows the time and never claims the read has no retrieval time.
      const text = drawnSheetText(read, 1);
      expect(text).toContain(observed);
      expect(text).not.toContain("not a retrieval time");
    } finally {
      await server.stop();
    }
  });

  testT("replayed reads with no historical time keep null in every sink", { timeout: LONG }, async () => {
    const address = replayAddress();
    const server = await startServer({ port: 0, data: servedData() });
    try {
      for (const source of ["recorded", "constructed"] as const) {
        const reply = await realFetch(`${server.origin}/api/positions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-app-token": server.token, origin: server.origin },
          body: JSON.stringify({ source, address }),
        });
        expect(reply.status, source).toBe(200);
        const read = (await reply.json()) as ReadData;
        expect(read.source).toBe(source);
        expect(read.meta.capturedAt, `${source} capturedAt`).toBe(null);
        for (const row of read.list.rows) {
          expect(row.asOf, `${source} row asOf`).toBe(null);
          expect(row.blockOrSlot, `${source} row keeps its slot`).not.toBe(null);
        }
        for (const row of positionReadRows(read)) expect(row.values.time, `${source} sheet position-read time`).toBe(null);
        if (read.sheets.length > 0) {
          // The drawn sheet states the absence honestly instead of inventing a time.
          const text = drawnSheetText(read, 1);
          expect(text).toContain("not recorded");
          expect(text).toContain("not a retrieval time");
        }
      }
    } finally {
      await server.stop();
    }
  });

  test("the statically loaded replayed reads keep null times as well", () => {
    for (const read of data.positions?.reads ?? []) {
      expect(read.meta.capturedAt, `${read.source} capturedAt`).toBe(null);
      for (const row of read.list.rows) expect(row.asOf, `${read.source} row asOf`).toBe(null);
      for (const row of positionReadRows(read)) expect(row.values.time, `${read.source} sheet position-read time`).toBe(null);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3 - the explorer's shown-of-total counts what is drawn               */
/* ------------------------------------------------------------------ */
describe("the explorer's shown-of-total counts the edges actually drawn", () => {
  const pack = () => data.packs.find((p) => p.id === "kamino-lend")!;
  const series = () => pack().series.find((s) => s.id === "main-market")!;
  const graph = (): GraphResult => series().results.graph as unknown as GraphResult;

  /** Edge rows the drawing actually holds: distinct edge ids inside the drawn edge text list. */
  const drawnEdgeIds = (main: FakeElement): string[] => {
    const rows = main
      .classed("lk-explorer-edges")
      .flatMap((list) => list.walk())
      .filter((el) => el.attr("data-lk-select") === "edge" && el.attr("data-lk-id"));
    return [...new Set(rows.map((el) => el.attr("data-lk-id") as string))];
  };
  const cutLabel = (main: FakeElement): { shown: number; total: number } => {
    const texts = main.classed("lk-cut").map((el) => (el.textContent ?? "").trim());
    const matching = texts.filter((t) => /^\d+ of \d+$/.test(t));
    expect(matching, "exactly one shown-of-total line on the dependencies tab").toHaveLength(1);
    const [shown, total] = matching[0].split(" of ").map(Number);
    return { shown, total };
  };
  /** The rows the model contract holds for a view: drawn edges plus drawn gap ends. */
  const seamRows = (view: { focus: string; steps: number; layers: string[]; expanded: string[] }): { rows: number; gap: number } => {
    const model = explorerModel(graph(), view) as unknown as { edges: unknown[]; gapEdges: unknown[] };
    return { rows: model.edges.length + model.gapEdges.length, gap: model.gapEdges.length };
  };
  const clickButton = (main: FakeElement, act: string, arg: string): void => {
    const button = main.walk().find((el) => el.attr("data-act") === act && el.attr("data-arg") === arg);
    expect(button, `${act} ${arg}`).toBeDefined();
    button!.dispatch("click");
  };
  const checkState = (main: FakeElement, view: { focus: string; steps: number; layers: string[]; expanded: string[] }, inputEdges: number): void => {
    const counted = drawnEdgeIds(main);
    const label = cutLabel(main);
    const seam = seamRows(view);
    expect(seam.gap === 0 || seam.rows > seam.gap).toBe(true);
    expect(label.shown, `shown for focus ${view.focus}, steps ${view.steps}, layers ${view.layers.join("+")}`).toBe(counted.length);
    expect(counted.length, "the label counts what the drawing holds, per the model contract").toBe(seam.rows);
    expect(label.total, "the total stays the full input count").toBe(inputEdges);
    expect(counted.length, "the drawn subset is strictly smaller than the full input").toBeLessThan(inputEdges);
  };

  testT("over focus, step and layer states the label equals the drawn rows and the total stays the input", { timeout: LONG }, () => {
    const inputEdges = graph().edges.length;
    expect(inputEdges).toBeGreaterThan(100);
    if (typeof graph().total === "number") expect(graph().total).toBe(inputEdges);

    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/protocols/kamino-lend/main-market/dependencies");
    app.draw();
    const main = () => harness.doc.getElementById(IDS.main);

    const view = defaultView(series()) as { focus: string; steps: number; layers: string[]; expanded: string[] };
    let current = { focus: view.focus, steps: view.steps, layers: [...view.layers], expanded: [...view.expanded] };
    checkState(main(), current, inputEdges);

    // Two steps: more edges and, on this graph, drawn gap ends - the old count left the gap ends out.
    clickButton(main(), "steps", "2");
    current = { ...current, steps: 2 };
    app.draw();
    expect(seamRows(current).gap, "this state must exercise gap ends").toBeGreaterThan(0);
    checkState(main(), current, inputEdges);

    clickButton(main(), "steps", "1");
    current = { ...current, steps: 1 };
    app.draw();
    checkState(main(), current, inputEdges);

    // Control only: every other layer toggled off.
    for (const layer of ["Structure", "Pricing", "Code"]) {
      clickButton(main(), "layer", layer);
      current = { ...current, layers: current.layers.filter((l) => l !== layer) };
    }
    app.draw();
    checkState(main(), current, inputEdges);

    // Choosing a node refocuses; the label follows the new focus.
    const target = main()
      .byAttr("data-lk-select", "node")
      .map((el) => el.attr("data-lk-id") as string)
      .find((id) => id && id !== current.focus);
    expect(target).toBeDefined();
    main()
      .byAttr("data-lk-select", "node")
      .find((el) => el.attr("data-lk-id") === target)!
      .dispatch("click");
    expect(harness.location.hash).toContain("?focus=");
    harness.setHash(harness.location.hash);
    app.draw();
    current = { ...current, focus: target! };
    checkState(main(), current, inputEdges);
  });
});
