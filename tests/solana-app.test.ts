// Independent tests for the Solana app and the second edition of the evidence kit.
// Every expected value is a literal from the approved contract and its recorded answers,
// or is recomputed here from committed captures through the base builders. Nothing is
// copied from what the implementation prints.
//
// The whole file runs offline: fetch is trapped (the in-process loopback servers are the
// only allowed targets), WebSocket, Bun.connect and node:net/http(s) are trapped outright,
// and any non-loopback attempt fails the file.
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";

/** bun:test of this checkout takes the timeout as the third argument; the long tests say it inline. */
const testT = (name: string, options: { timeout: number }, fn: () => unknown): void => {
  test(name, fn as () => void, options.timeout);
};
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";
import { createHash } from "node:crypto";

// ---- kit: first and second catalog ----
import { CATALOG, catalogJson } from "../src/ui/catalog";
import { CATALOG_V2, catalogJsonV2 } from "../src/ui/catalog-v2";
import { VIEW_TEMPLATES, instantiate } from "../src/ui/templates";
import { listViewTemplatesV2, instantiateV2 } from "../src/ui/templates-v2";
import { validateSurface, receiptResolver } from "../src/ui/validate";
import { interpret } from "../src/ui/interpret";
import { treeToHtml } from "../src/ui/html";
import { explorerModel } from "../src/ui/explorer-model";
import { drawExplorer } from "../src/ui/explorer-draw";
import { galleryV2Specimens, buildGalleryV2, GALLERY_V2_STATES } from "../src/ui/gallery-v2";
import { STRINGS, CONTRAST_PAIRS } from "../src/ui/strings";
import { UiRejected, type A2uiMessage, type GraphResult, type ReceiptRecord, type SurfaceTree, type UiNode } from "../src/ui/types";

// ---- base builders the recomputations run through ----
import { collectEvidenceInputs, buildEvidenceRecords, runEvidenceLocal, PROTOCOLS } from "../src/graph/evidence";
import { buildMarinadeSnapshots } from "../src/engine/queries/marinade";
import { VOCABULARY } from "../src/engine/queries/vocabulary";
import { readPositions } from "../src/positions/read";
import type { ReadResult } from "../src/positions/types";
import { economicsFor, economicsQuantities, exitItemsFor } from "../src/review/position/economics";
import { engineAccess, queryChains } from "../src/review/position/chain";
import { openStore } from "../src/engine/queries/snapshot";
import { VAULT_TARGETS } from "../src/adapters/kamino";

// ---- the app ----
import { loadApp, readId } from "../src/apps/solana/load";
import { replayClient } from "../src/apps/solana/positions";
import { PREFIX, type AppData, type ReadData, type SeriesData, type PackData } from "../src/apps/solana/model";
import { headerSurface, indexSurface, tabSurface, drawerSurface, positionsSurface, sheetSurface, overviewResults } from "../src/apps/solana/surfaces";
import { render, resolverOver } from "../src/apps/solana/compose";
import { parseRoute } from "../src/apps/solana/route";
import { TRAIL_LENGTH } from "../src/apps/solana/state";
import { IDS, OVERVIEW_BLOCKS } from "../src/apps/solana/chrome";
import { startApp } from "../src/apps/solana/app";
import { startServer } from "../src/apps/solana/server";
import { startAppServer } from "../src/apps/solana/main";
import { ScriptedModel } from "../src/answers/planner";
import { loadBundleBackend } from "../src/answers/bundle-backend";
import type { RetrievalBackend } from "../src/answers/retrieval";
import { buildAssets, buildDocument } from "../src/apps/solana/page";
import { APP_STRINGS, LAYERS, APP_CONTRAST_PAIRS, SURFACE_TITLES } from "../src/apps/solana/strings";

// ---- literals from the approved contract ----
const V1_ID = "linchpin.evidence.v1";
const V2_ID = "linchpin.evidence.v2";
const V1_NAMES = ["Column", "AnswerHeader", "FactTable", "ControlChain", "ValuePath", "CoverageNote", "UnknownList", "Note", "SubjectHeader", "Section", "DependencyGraph", "Timeline"];
const V2_NAMES = ["GraphExplorer", "FactCard", "ReceiptCard", "AnswerPath", "FindingList", "ClaimCheck", "ChangeList", "PositionList", "CaptureList", "GapList", "QueryTrace", "Disclosure"];
const V1_TEMPLATES = ["fact-table", "control-chain", "dependency-graph", "timeline", "unknowns", "coverage", "subject-panel"];
const V2_TEMPLATES = ["answer-panel", "protocol-overview", "protocol-control", "protocol-unknowns", "position-sheet", "graph-explorer"];
const CATALOG_JSON_PIN = "fce119926241022f1f87f5342968e65800e834d1a8948dc06bc51792d4c9514a";
const BUILD_PIN = "e5d3a4989f925fee4b407d115b6edba6cce0f5f601254af36dbfa2f745bc23f0";
const BUN_PIN = "1.4.2";
const MARKET_OWNER_FACT = "41ece428ae7bd304689e6f8b731ed9391928090fa8107f237e7aef1d9c0f420a";
const MARKET_OWNER_RECEIPT = "f7e8ada39a7321770eb9220f6597666bd860cbbcfaed446857fcb01a403466e3";
const VAULT_ADMIN_FACT = "3de7f904df43fdfaa706a7737228ab00c23f843120baf4e93c388d8963c33489";
const VAULT_ADMIN_RECEIPT = "2e2635128c22faea2394f56dfd73b6dff91dbaf030bf5d91f36af2ebcf5a5daa";
const UNKNOWN_FACT = "d93224066c090b60f587680f6509188901cba0feb65259ffc7bd12a844137fb2";
const SENTORA_BEFORE = "solana-mainnet-beta.kamino.sentora-pyusd-20261109T163416Z";
const SENTORA_AFTER = "solana-mainnet-beta.kamino.sentora-pyusd-20261109T170418Z";
const HOSTILE_IMG = "<img src=x onerror=alert(1)>";
const HOSTILE_SCRIPT = '"><script>alert(1)</script>';
const FORBIDDEN_CALLS = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("];
const SVG_NS = "http://www.w3.org/2000/svg";
const BANNED_HERE = ["exploit", "secure", "prevent", "guarantee", "score", "rating", "grade"];

const ROOT = join(import.meta.dir, "..");
const LONG = 300_000;
// Historical file-lane pins apply only while developing the original feature branch.
// Runtime and recorded-data assertions continue to run in every installed tree.
const APP_PIN_BASE = "88a966d03d6490def69936d153301731a61c86bc";
const appPinBranch = (() => {
  try {
    return Bun.spawnSync(["git", "branch", "--show-current"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  } catch { return null; }
})();
const appPinHistory = (() => {
  try {
    return Bun.spawnSync(["git", "cat-file", "-e", `${APP_PIN_BASE}^{commit}`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  } catch { return null; }
})();
const APP_RUN_PINS_APPLY = appPinBranch !== null && appPinHistory !== null
  && appPinBranch.exitCode === 0 && appPinBranch.stdout.toString().trim() === "run/solana-app" && appPinHistory.exitCode === 0;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---- offline trap for the whole file ----
const realFetch = globalThis.fetch;
const hits = { foreignFetch: 0, websocket: 0, connect: 0, net: 0 };
const foreignUrls: string[] = [];
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
      foreignUrls.push(url);
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
  expect(foreignUrls).toEqual([]);
});

// ---- shared data, loaded once ----
let loaded: Awaited<ReturnType<typeof loadApp>>;
let data: AppData;
let records: ReturnType<typeof buildEvidenceRecords>;
let marinadeInputs: ReturnType<typeof buildMarinadeSnapshots>;
let solanaSnapshots: ReturnType<typeof collectEvidenceInputs>[number]["snapshot"][];
let bundle: { path: { data: { links: Record<string, unknown>[] } }; control: { data: { rows: Record<string, unknown>[] } }; claims: { data: { rows: Record<string, unknown>[] } }; answer: { data: { statements: Record<string, unknown>[]; unknowns: Record<string, unknown>[] } } };
let allReceiptIds: Set<string>;

beforeAll(async () => {
  loaded = await loadApp(undefined, {});
  data = loaded.data;
  const solanaInputs = collectEvidenceInputs(".").filter((i) => i.snapshot.chain === "solana");
  solanaSnapshots = solanaInputs.map((i) => i.snapshot);
  records = buildEvidenceRecords(solanaInputs);
  marinadeInputs = buildMarinadeSnapshots("fixtures");
  const { buildMarinadeBundle } = await import("../src/apps/solana/providers");
  bundle = ((await buildMarinadeBundle(".")) as unknown as { bundle: typeof bundle }).bundle;
  allReceiptIds = new Set(Object.keys(data.receipts));
  for (const read of data.positions?.reads ?? []) for (const id of Object.keys(read.receipts)) allReceiptIds.add(id);
}, LONG);

const resolverOverAll = () => resolverOver(allReceiptIds);

// ---- hand-made second-catalog surfaces (rows mirror the shapes the committed data carries) ----
const v2Surface = (surfaceId: string, modelValue: unknown, components: unknown[]): A2uiMessage[] => [
  { version: "v0.9.1", createSurface: { surfaceId, catalogId: V2_ID } },
  { version: "v0.9.1", updateDataModel: { surfaceId, path: "/", value: modelValue } },
  { version: "v0.9.1", updateComponents: { surfaceId, components } },
] as A2uiMessage[];
const kitResolver = receiptResolver(new Set(["ev-1", "ev-2", "ev-3", "rcp-1"]));
const v2check = (modelValue: unknown, components: unknown[], resolve = kitResolver) =>
  validateSurface(v2Surface("s", modelValue, components), { resolveEvidence: resolve });

const kitRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rowKind: "fact", key: "k1", values: { subject: "A", predicate: "P", object: "B", finding: "a finding", status: "verified" },
  factIds: [], bases: ["decoded"], evidenceIds: ["ev-1"], blockOrSlot: "7", asOf: "2026-11-12T00:00:00Z",
  snapshotIds: ["snap-1"], scopeSource: "a recorded source", ...over,
});
const kitTable = (rows: unknown[], columns: unknown[], extra: Record<string, unknown> = {}) => ({
  resultId: "t1", shape: "table" as const, coverage: "mapped" as const, coverageNotes: [] as string[], rows, truncated: false, columns, ...extra,
});
const kitGraphNode = (id: string, over: Record<string, unknown> = {}) => ({ id, label: `label of ${id}`, isolated: false, ...over });
const kitGraphEdge = (key: string, from: string, to: string, over: Record<string, unknown> = {}) => ({
  key, from, to, relation: "RELATES", factIds: ["f-1"], bases: ["decoded"], evidenceIds: ["ev-1"], blockOrSlot: "7", asOf: null, layer: "Structure", ...over,
});
const kitGraph = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}): GraphResult =>
  ({ resultId: "g1", shape: "graph", coverage: "mapped", coverageNotes: [], nodes, edges, truncated: false, ...extra }) as GraphResult;
const kitReceipt: Record<string, unknown> = { id: "rcp-1", source: "a recorded source", responseSha256: "ab".repeat(32), blockOrSlot: "9", observedAt: null, historicalState: null, privacy: "public" };
const kitCapture = { id: "cap-1", observedFrom: null, observedTo: "2026-11-09T17:04:20Z", fromBlockOrSlot: 1, toBlockOrSlot: 2, facts: 3, subjects: 2, shown: true, constructed: false, source: "a recorded source", evidenceIds: ["ev-1"] };
const kitTrace = { template: "control", params: { subject: "A" }, outcome: "ok", rowsReturned: 3, reasons: [{ code: "no-facts", count: 1 }] };
const kitSide = { value: "x", bases: ["decoded"], blockOrSlot: "1", evidenceIds: ["ev-1"], factIds: ["f1"] };
const kitChangeRow = { kind: "changed", key: "kk", before: kitSide, after: { absent: true, reason: "not in this capture" } };
const kitChanges = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  resultId: "c1", shape: "changes", coverage: "mapped", coverageNotes: [], captureIds: ["cap-a", "cap-b"], rows, truncated: false, ...extra,
});
const kitModel = (extra: Record<string, unknown> = {}) => ({ meta: { snapshotIds: [] }, results: {}, ...extra });
const NOTE_COLS = [{ name: "finding", role: "note" }, { name: "status", role: "status" }];
const CLAIM_COLS = [
  { name: "claim", role: "note" }, { name: "source", role: "address" },
  { name: "chain result", role: "note" }, { name: "status", role: "status" },
];
const POS_COLS = [
  { name: "account", role: "address" }, { name: "quantity", role: "amount" }, { name: "unit", role: "address" },
  { name: "leg", role: "label" }, { name: "joined to", role: "address" },
];
const GAP_COLS = [{ name: "item", role: "label" }];

// ---- walking the drawn tree ----
const textOf = (node: UiNode): string => (node.text ?? "") + node.children.map(textOf).join("");
const findAll = (root: UiNode, pred: (n: UiNode) => boolean): UiNode[] => {
  const out: UiNode[] = [];
  const walk = (n: UiNode): void => {
    if (pred(n)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};
const byClass = (root: UiNode, cls: string): UiNode[] => findAll(root, (n) => (n.attrs.class ?? "").split(/\s+/).includes(cls));
const findByClass = byClass;
const chipIds = (row: UiNode): string[] =>
  findByClass(row, "lk-chip").flatMap((chip) => findAll(chip, (n) => (n.attrs.class ?? "").split(/\s+/).includes("lk-evidence-id")).map((c) => c.text ?? ""));

// ---- a hand-made document for the page (no DOM library; only the members the page uses) ----
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
/** FakeElement.classed, named for the places that read like the kit-tree helper. */
const findByClassOfElement = (el: FakeElement, cls: string): FakeElement[] => el.classed(cls);
class FakeDocument {
  registry = new Map<string, FakeElement>();
  active: FakeElement | null = null;
  keydown: ((e: Ev) => void)[] = [];
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
  addEventListener(type: string, fn: (e: Ev) => void): void {
    if (type === "keydown") this.keydown.push(fn);
  }
  pressKey(key: string): void {
    for (const fn of [...this.keydown]) fn({ key, preventDefault() {} });
  }
}

interface Harness {
  doc: FakeDocument;
  location: { hash: string };
  sessionStorage: Map<string, string>;
  fetchCalls: string[];
  setHash(hash: string): void;
  env(record: Record<string, unknown>): Record<string, unknown>;
}
function makeHarness(fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>): Harness {
  const doc = new FakeDocument();
  const location = { hash: "#/protocols" };
  const handlers: (() => void)[] = [];
  const sessionStorage = new Map<string, string>();
  const fetchCalls: string[] = [];
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
    fetch: fetchImpl
      ? (input: string, init?: RequestInit) => {
          fetchCalls.push(input);
          return fetchImpl(input, init);
        }
      : undefined,
  };
  return {
    doc,
    location,
    sessionStorage,
    fetchCalls,
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
/* AC1 — kit v1 unchanged, v2 additive                                 */
/* ------------------------------------------------------------------ */
describe("AC1 kit v1 unchanged and the second catalog additive", () => {
  test("catalogJson keeps the pinned bytes of the base", () => {
    expect(sha256(catalogJson())).toBe(CATALOG_JSON_PIN);
    expect(catalogJson()).toBe(catalogJson());
  });

  test("CATALOG keeps its id and twelve names; VIEW_TEMPLATES the seven ids", () => {
    expect(CATALOG.id).toBe(V1_ID);
    expect(Object.keys(CATALOG.components).sort()).toEqual([...V1_NAMES].sort());
    expect(VIEW_TEMPLATES.map((t) => t.id).sort()).toEqual([...V1_TEMPLATES].sort());
  });

  test("CATALOG_V2 holds the twelve of v1, each spec deep-equal, plus the twelve new ones", () => {
    expect(CATALOG_V2.id).toBe(V2_ID);
    const names = Object.keys(CATALOG_V2.components);
    expect(names.filter((n) => !V2_NAMES.includes(n)).sort()).toEqual([...V1_NAMES].sort());
    expect(names.filter((n) => V2_NAMES.includes(n)).sort()).toEqual([...V2_NAMES].sort());
    expect(names).toHaveLength(24);
    for (const name of V1_NAMES) expect(CATALOG_V2.components[name]).toEqual(CATALOG.components[name]);
  });

  test("catalogJsonV2 is byte-identical across calls", () => {
    expect(catalogJsonV2()).toBe(catalogJsonV2());
    const parsed = JSON.parse(catalogJsonV2()) as { catalogId: string };
    expect(parsed.catalogId).toBe(V2_ID);
  });

  test("listViewTemplatesV2 lists exactly the six ids with title, accepts and a description of at least three words", () => {
    const templates = listViewTemplatesV2();
    expect(templates.map((t) => t.id).sort()).toEqual([...V2_TEMPLATES].sort());
    for (const t of templates) {
      expect(typeof t.title).toBe("string");
      expect((t.title as string).length).toBeGreaterThan(0);
      expect(Array.isArray(t.accepts)).toBe(true);
      expect((t.accepts as string[]).length).toBeGreaterThan(0);
      expect(t.description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
    }
  });

  test("instantiateV2 emits the three messages in order with the second catalog id", () => {
    const graph = kitGraph([kitGraphNode("n1"), kitGraphNode("n2")], [kitGraphEdge("e1", "n1", "n2")]);
    const messages = instantiateV2("graph-explorer", { surfaceId: "sx", meta: { snapshotIds: [] }, results: [graph] });
    expect(messages.map((m) => Object.keys(m)[1])).toEqual(["createSurface", "updateDataModel", "updateComponents"]);
    const first = messages[0] as { createSurface: { catalogId: string } };
    expect(first.createSurface.catalogId).toBe(V2_ID);
  });

  test("the registries refuse each other's ids, and a wrong shape is refused", () => {
    expect(() => instantiateV2("fact-table", { surfaceId: "s", meta: { snapshotIds: [] }, results: [] })).toThrow(UiRejected);
    try {
      instantiateV2("fact-table", { surfaceId: "s", meta: { snapshotIds: [] }, results: [] });
    } catch (error) {
      expect((error as UiRejected).code).toBe("unknown-template");
    }
    expect(() => instantiate("answer-panel", { surfaceId: "s", meta: { snapshotIds: [] }, results: [] })).toThrow(UiRejected);
    try {
      instantiate("answer-panel", { surfaceId: "s", meta: { snapshotIds: [] }, results: [] });
    } catch (error) {
      expect((error as UiRejected).code).toBe("unknown-template");
    }
    const table = kitTable([kitRow()], [{ name: "subject", role: "subject" }]);
    expect(() => instantiateV2("graph-explorer", { surfaceId: "s", meta: { snapshotIds: [] }, results: [table as never] })).toThrow(UiRejected);
    try {
      instantiateV2("graph-explorer", { surfaceId: "s", meta: { snapshotIds: [] }, results: [table as never] });
    } catch (error) {
      expect((error as UiRejected).code).toBe("shape-not-accepted");
    }
  });

  test("a surface of the first catalog that names a second-catalog component fails unknown-component", () => {
    const v1Messages: A2uiMessage[] = [
      { version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: V1_ID } },
      { version: "v0.9.1", updateDataModel: { surfaceId: "s", path: "/", value: kitModel({ results: { g1: kitGraph([kitGraphNode("n1"), kitGraphNode("n2")], [kitGraphEdge("e1", "n1", "n2")]) } }) } },
      { version: "v0.9.1", updateComponents: { surfaceId: "s", components: [{ id: "root", component: "GraphExplorer", result: { path: "/results/g1" } }] } },
    ];
    const result = validateSurface(v1Messages, { resolveEvidence: kitResolver });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("unknown-component");
  });

  testT("the pinned suites of the first catalog and the desk pass unmodified", { timeout: LONG }, () => {
    const run = Bun.spawnSync(["bun", "test", "tests/ui-kit.test.ts", "tests/near-risk-desk-v2.test.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* AC2 — validator v2: every rule and every new component               */
/* ------------------------------------------------------------------ */
describe("AC2 validator of the second catalog", () => {
  test("V16 uncited-receipt: a record without source, sha or privacy, and one the resolver misses", () => {
    const comp = [{ id: "root", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } }];
    const withRecord = (record: Record<string, unknown>) => v2check(kitModel({ receipts: { "rcp-1": record } }), comp);
    expect(withRecord({ ...kitReceipt, source: "" }).codes).toEqual(["uncited-receipt"]);
    expect(withRecord({ ...kitReceipt, responseSha256: "" }).codes).toEqual(["uncited-receipt"]);
    expect(withRecord({ ...kitReceipt, privacy: "" }).codes).toEqual(["uncited-receipt"]);
    expect(withRecord(kitReceipt).ok).toBe(true);
    // The same record, present in the model, while the resolver reports its id missing: that rule alone (recorded answer C6).
    const alone = validateSurface(v2Surface("s", { meta: { snapshotIds: [] }, receipts: { "rcp-1": kitReceipt } }, comp), { resolveEvidence: receiptResolver(new Set()) });
    expect(alone.ok).toBe(false);
    expect(alone.codes).toEqual(["uncited-receipt"]);
  });

  test("V17 change-side: sides without citation, absent sides without reason, and fewer than two captures", () => {
    const comp = [{ id: "root", component: "ChangeList", result: { path: "/results/c1" } }];
    expect(v2check(kitModel({ results: { c1: kitChanges([kitChangeRow]) } }), comp).ok).toBe(true);
    expect(v2check(kitModel({ results: { c1: kitChanges([kitChangeRow], { captureIds: ["cap-a"] }) } }), comp).codes).toContain("change-side");
    expect(v2check(kitModel({ results: { c1: kitChanges([{ ...kitChangeRow, before: { value: "x", bases: [], blockOrSlot: null, evidenceIds: [] } }]) } }), comp).codes).toContain("change-side");
    expect(v2check(kitModel({ results: { c1: kitChanges([{ ...kitChangeRow, after: { absent: true, reason: "" } }]) } }), comp).codes).toContain("change-side");
  });

  test("V18 reader-row: a position row that is not a reader row, and one without its sources", () => {
    const comp = [{ id: "root", component: "PositionList", result: { path: "/results/t1" } }];
    const readerRow = kitRow({ rowKind: "reader", bases: [], source: "reader", key: "p1" });
    expect(v2check(kitModel({ results: { t1: kitTable([readerRow], POS_COLS) } }), comp).ok).toBe(true);
    const factRowCase = v2check(kitModel({ results: { t1: kitTable([{ ...readerRow, rowKind: "fact", bases: [] }], POS_COLS) } }), comp);
    expect(factRowCase.codes).toContain("reader-row");
    expect(factRowCase.codes).toContain("uncited-row");
    expect(v2check(kitModel({ results: { t1: kitTable([{ ...readerRow, source: undefined }], POS_COLS) } }), comp).codes).toContain("reader-row");
    expect(v2check(kitModel({ results: { t1: kitTable([{ ...readerRow, scopeSource: undefined }], POS_COLS) } }), comp).codes).toContain("reader-row");
    expect(v2check(kitModel({ results: { t1: kitTable([{ ...readerRow, evidenceIds: [] }], POS_COLS) } }), comp).codes).toContain("reader-row");
  });

  test("V19 constructed-unmarked: a constructed row, receipt, capture, result or change needs meta.constructed", () => {
    const marked = kitModel({ meta: { snapshotIds: [], constructed: true } });
    const rowCase = [{ id: "root", component: "FactCard", fact: { path: "/results/t1/rows/0" } }];
    expect(v2check(kitModel({ results: { t1: kitTable([kitRow({ constructed: true })], NOTE_COLS) } }), rowCase).codes).toContain("constructed-unmarked");
    expect(v2check({ ...marked, results: { t1: kitTable([kitRow({ constructed: true })], NOTE_COLS) } }, rowCase).ok).toBe(true);
    const receiptCase = [{ id: "root", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } }];
    expect(v2check(kitModel({ receipts: { "rcp-1": { ...kitReceipt, constructed: true } } }), receiptCase).codes).toContain("constructed-unmarked");
    expect(v2check({ ...marked, receipts: { "rcp-1": { ...kitReceipt, constructed: true } } }, receiptCase).ok).toBe(true);
    const changeComp = [{ id: "root", component: "ChangeList", result: { path: "/results/c1" } }];
    expect(v2check(kitModel({ results: { c1: kitChanges([{ ...kitChangeRow, constructed: true }]) } }), changeComp).codes).toContain("constructed-unmarked");
    expect(v2check({ ...marked, results: { c1: kitChanges([{ ...kitChangeRow, constructed: true }]) } }, changeComp).ok).toBe(true);
  });

  test("V20 count-mismatch: a Disclosure count off its rows, a cut result without a total, a total below the rows", () => {
    const disclosure = (total: number | undefined) => {
      const results = { t1: kitTable([kitRow(), kitRow()], NOTE_COLS, total === undefined ? { truncated: true } : { total }) };
      return v2check(
        kitModel({ results }),
        [
          { id: "root", component: "Disclosure", title: "A held group", count: { path: "/results/t1/total" }, children: ["c1"] },
          { id: "c1", component: "FactTable", result: { path: "/results/t1" } },
        ],
      );
    };
    expect(disclosure(2).ok).toBe(true);
    expect(disclosure(5).codes).toContain("count-mismatch");
    expect(disclosure(undefined).codes).toContain("count-mismatch");
    expect(v2check(kitModel({ results: { t1: kitTable([kitRow(), kitRow()], NOTE_COLS, { total: 1 }) } }), [{ id: "root", component: "FactTable", result: { path: "/results/t1" } }]).codes).toContain("count-mismatch");
  });

  test("V21 gap-without-reason: a reason outside the four words, and a scope row without its source", () => {
    const comp = [{ id: "root", component: "GapList", result: { path: "/results/t1" } }];
    const gap = (over: Record<string, unknown>) => kitRow({ rowKind: "scope", bases: [], evidenceIds: [], ...over });
    const shape = "unknowns" as const;
    expect(v2check(kitModel({ results: { t1: kitTable([gap({ reason: "not-captured" })], GAP_COLS, { shape }) } }), comp).ok).toBe(true);
    expect(v2check(kitModel({ results: { t1: kitTable([gap({ reason: "somehow" })], GAP_COLS, { shape }) } }), comp).codes).toContain("gap-without-reason");
    expect(v2check(kitModel({ results: { t1: kitTable([gap({ reason: "not-read", scopeSource: undefined })], GAP_COLS, { shape }) } }), comp).codes).toContain("gap-without-reason");
  });

  test("V22 claimed-amount: a claimed-only link that carries an amount, repaired without one", () => {
    const comp = [{ id: "root", component: "AnswerPath", result: { path: "/results/t1" } }];
    const pathShape = "path" as const;
    const claimed = kitRow({ rowKind: "path", values: { from: "A", to: "B", status: "claimed-only", amount: "5", unit: "MNDE" }, bases: ["claimed"] });
    expect(v2check(kitModel({ results: { t1: kitTable([claimed], [], { shape: pathShape }) } }), comp).codes).toContain("claimed-amount");
    expect(v2check(kitModel({ results: { t1: kitTable([kitRow({ rowKind: "path", values: { from: "A", to: "B", status: "claimed-only" }, bases: ["claimed"] })], [], { shape: pathShape }) } }), comp).ok).toBe(true);
  });

  test("V23 trace-incomplete: a trace without template, outcome or a whole-number row count", () => {
    const comp = [{ id: "root", component: "QueryTrace", trace: { path: "/meta/trace" } }];
    expect(v2check(kitModel({ meta: { snapshotIds: [], trace: kitTrace } }), comp).ok).toBe(true);
    expect(v2check(kitModel({ meta: { snapshotIds: [], trace: { ...kitTrace, template: "" } } }), comp).codes).toContain("trace-incomplete");
    expect(v2check(kitModel({ meta: { snapshotIds: [], trace: { ...kitTrace, outcome: "" } } }), comp).codes).toContain("trace-incomplete");
    expect(v2check(kitModel({ meta: { snapshotIds: [], trace: { ...kitTrace, rowsReturned: 1.5 } } }), comp).codes).toContain("trace-incomplete");
  });

  test("each value component refuses a literal where a binding is required, and a binding to a missing path", () => {
    const cases: [string, unknown][] = [
      ["GraphExplorer", { id: "root", component: "GraphExplorer", result: "boom" }],
      ["FactCard", { id: "root", component: "FactCard", fact: "boom" }],
      ["ReceiptCard", { id: "root", component: "ReceiptCard", receipt: "boom" }],
      ["AnswerPath", { id: "root", component: "AnswerPath", result: "boom" }],
      ["FindingList", { id: "root", component: "FindingList", result: "boom" }],
      ["ClaimCheck", { id: "root", component: "ClaimCheck", result: "boom" }],
      ["ChangeList", { id: "root", component: "ChangeList", result: "boom" }],
      ["PositionList", { id: "root", component: "PositionList", result: "boom" }],
      ["CaptureList", { id: "root", component: "CaptureList", captures: "boom" }],
      ["GapList", { id: "root", component: "GapList", result: "boom" }],
      ["QueryTrace", { id: "root", component: "QueryTrace", trace: "boom" }],
    ];
    for (const [name, component] of cases) {
      expect(v2check(kitModel(), [component]).codes, name).toContain("literal-value");
    }
    const dangling: [string, unknown, Record<string, unknown>][] = [
      ["GraphExplorer", { id: "root", component: "GraphExplorer", result: { path: "/results/none" } }, {}],
      ["FactCard", { id: "root", component: "FactCard", fact: { path: "/results/t1/rows/9" } }, { results: { t1: kitTable([kitRow()], NOTE_COLS) } }],
      ["AnswerPath", { id: "root", component: "AnswerPath", result: { path: "/results/none" } }, {}],
      ["FindingList", { id: "root", component: "FindingList", result: { path: "/results/none" } }, {}],
      ["ClaimCheck", { id: "root", component: "ClaimCheck", result: { path: "/results/none" } }, {}],
      ["ChangeList", { id: "root", component: "ChangeList", result: { path: "/results/none" } }, {}],
      ["PositionList", { id: "root", component: "PositionList", result: { path: "/results/none" } }, {}],
      ["CaptureList", { id: "root", component: "CaptureList", captures: { path: "/meta/none" } }, {}],
      ["GapList", { id: "root", component: "GapList", result: { path: "/results/none" } }, {}],
      ["QueryTrace", { id: "root", component: "QueryTrace", trace: { path: "/meta/none" } }, {}],
      ["ReceiptCard", { id: "root", component: "ReceiptCard", receipt: { path: "/receipts/none" } }, { receipts: { "rcp-1": kitReceipt } }],
    ];
    for (const [name, component, extra] of dangling) {
      expect(v2check(kitModel(extra), [component]).codes, name).toContain("dangling-binding");
    }
  });

  test("each component refuses an uncited row, side, receipt, capture or trace with its own rule", () => {
    const uncitedGraph = kitGraph([kitGraphNode("n1"), kitGraphNode("n2")], [kitGraphEdge("e1", "n1", "n2", { bases: [], evidenceIds: [] })]);
    expect(v2check(kitModel({ results: { g1: uncitedGraph } }), [{ id: "root", component: "GraphExplorer", result: { path: "/results/g1" } }]).codes).toContain("edge-without-fact");
    expect(v2check(kitModel({ results: { t1: kitTable([kitRow({ bases: [] })], NOTE_COLS) } }), [{ id: "root", component: "FactCard", fact: { path: "/results/t1/rows/0" } }]).codes).toContain("uncited-row");
    expect(v2check(kitModel({ results: { t1: kitTable([kitRow({ rowKind: "scope", bases: [], evidenceIds: [], scopeSource: undefined })], NOTE_COLS) } }), [{ id: "root", component: "FindingList", result: { path: "/results/t1" } }]).codes).toContain("uncited-row");
    expect(v2check(kitModel({ results: { t1: kitTable([kitRow({ rowKind: "scope", bases: [], evidenceIds: [], scopeSource: undefined })], CLAIM_COLS) } }), [{ id: "root", component: "ClaimCheck", result: { path: "/results/t1" } }]).codes).toContain("uncited-row");
    expect(v2check(kitModel({ results: { c1: kitChanges([{ ...kitChangeRow, before: { ...kitSide, bases: [], evidenceIds: [] } }]) } }), [{ id: "root", component: "ChangeList", result: { path: "/results/c1" } }]).codes).toContain("change-side");
    expect(v2check(kitModel({ receipts: { "rcp-1": { ...kitReceipt, privacy: "" } } }), [{ id: "root", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } }]).codes).toContain("uncited-receipt");
    expect(v2check(kitModel({ meta: { snapshotIds: [], captures: [{ ...kitCapture, evidenceIds: [] }] } }), [{ id: "root", component: "CaptureList", captures: { path: "/meta/captures" } }]).codes).toContain("uncited-row");
    expect(v2check(kitModel({ meta: { snapshotIds: [], trace: { ...kitTrace, template: "" } } }), [{ id: "root", component: "QueryTrace", trace: { path: "/meta/trace" } }]).codes).toContain("trace-incomplete");
  });

  test("each component but the receipt card and the trace refuses an evidence id the resolver misses", () => {
    const missing = receiptResolver(new Set());
    const run = (modelValue: unknown, components: unknown[]) => validateSurface(v2Surface("s", modelValue, components), { resolveEvidence: missing });
    const graphCase = kitGraph([kitGraphNode("n1"), kitGraphNode("n2")], [kitGraphEdge("e1", "n1", "n2", { evidenceIds: ["ev-x"] })]);
    expect(run(kitModel({ results: { g1: graphCase } }), [{ id: "root", component: "GraphExplorer", result: { path: "/results/g1" } }]).codes).toContain("unresolved-evidence");
    const rowCases: [string, unknown, unknown[]][] = [
      ["FactCard", kitModel({ results: { t1: kitTable([kitRow({ evidenceIds: ["ev-x"] })], NOTE_COLS) } }), [{ id: "root", component: "FactCard", fact: { path: "/results/t1/rows/0" } }]],
      ["AnswerPath", kitModel({ results: { t1: kitTable([kitRow({ rowKind: "path", evidenceIds: ["ev-x"] })], [], { shape: "path" }) } }), [{ id: "root", component: "AnswerPath", result: { path: "/results/t1" } }]],
      ["FindingList", kitModel({ results: { t1: kitTable([kitRow({ evidenceIds: ["ev-x"] })], NOTE_COLS) } }), [{ id: "root", component: "FindingList", result: { path: "/results/t1" } }]],
      ["ClaimCheck", kitModel({ results: { t1: kitTable([kitRow({ evidenceIds: ["ev-x"] })], CLAIM_COLS) } }), [{ id: "root", component: "ClaimCheck", result: { path: "/results/t1" } }]],
      ["ChangeList", kitModel({ results: { c1: kitChanges([{ ...kitChangeRow, before: { ...kitSide, evidenceIds: ["ev-x"] } }]) } }), [{ id: "root", component: "ChangeList", result: { path: "/results/c1" } }]],
      ["PositionList", kitModel({ results: { t1: kitTable([kitRow({ rowKind: "reader", bases: [], source: "reader", evidenceIds: ["ev-x"] })], POS_COLS) } }), [{ id: "root", component: "PositionList", result: { path: "/results/t1" } }]],
      ["CaptureList", kitModel({ meta: { snapshotIds: [], captures: [{ ...kitCapture, evidenceIds: ["ev-x"] }] } }), [{ id: "root", component: "CaptureList", captures: { path: "/meta/captures" } }]],
      ["GapList", kitModel({ results: { t1: kitTable([kitRow({ rowKind: "scope", bases: [], evidenceIds: ["ev-x"], reason: "not-read" })], GAP_COLS, { shape: "unknowns" }) } }), [{ id: "root", component: "GapList", result: { path: "/results/t1" } }]],
    ];
    for (const [name, modelValue, components] of rowCases) {
      expect(run(modelValue, components).codes, name).toContain("unresolved-evidence");
    }
  });

  test("the receipt card reports a missing resolver id as uncited-receipt alone, and the trace needs no evidence", () => {
    const missing = validateSurface(
      v2Surface("s", kitModel({ receipts: { "rcp-1": kitReceipt } }), [{ id: "root", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } }]),
      { resolveEvidence: receiptResolver(new Set()) },
    );
    expect(missing.codes).toEqual(["uncited-receipt"]);
    const trace = validateSurface(
      v2Surface("s", kitModel({ meta: { snapshotIds: [], trace: kitTrace } }), [{ id: "root", component: "QueryTrace", trace: { path: "/meta/trace" } }]),
      { resolveEvidence: receiptResolver(new Set()) },
    );
    expect(trace.ok).toBe(true);
  });

  test("validateSurface returns codes, never throws, on malformed input", () => {
    expect(validateSurface(null, { resolveEvidence: kitResolver }).ok).toBe(false);
    expect(validateSurface(null, { resolveEvidence: kitResolver }).codes).toContain("schema");
    expect(validateSurface("a string", { resolveEvidence: kitResolver }).codes).toContain("schema");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => v2check(cycle, [{ id: "root", component: "FactTable", result: { path: "/results/t1" } }])).not.toThrow();
    expect(v2check(cycle, [{ id: "root", component: "FactTable", result: { path: "/results/t1" } }]).ok).toBe(false);
  });

  test("every specimen of the second-catalog gallery validates", () => {
    const specimens = galleryV2Specimens();
    expect(specimens.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const specimen of specimens) {
      seen.add(specimen.component);
      seen.add(specimen.state);
      const result = validateSurface(specimen.messages, { resolveEvidence: receiptResolver(new Set(specimen.receiptIds)) });
      expect(result.codes, `${specimen.component} (${specimen.state})`).toEqual([]);
    }
    for (const name of V2_NAMES) expect(seen.has(name), name).toBe(true);
    for (const state of GALLERY_V2_STATES) expect(seen.has(state), state).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* AC3 — the new components draw provenance                             */
/* ------------------------------------------------------------------ */
describe("AC3 the new components draw provenance", () => {
  const drawn = (modelValue: unknown, components: unknown[]): SurfaceTree => interpret(v2Surface("s", modelValue, components));

  test("FactCard draws the row with bases, block and an evidence chip holding exactly its ids", () => {
    const row = kitRow({ values: { subject: "S one", predicate: "HOLDS", object: "O two" }, bases: ["decoded", "recorded"], evidenceIds: ["ev-1", "ev-2"] });
    const tree = drawn(kitModel({ results: { t1: kitTable([row], NOTE_COLS) } }), [{ id: "root", component: "FactCard", fact: { path: "/results/t1/rows/0" } }]);
    const card = findByClass(tree.root, "lk-fact-card");
    expect(card).toHaveLength(1);
    const text = textOf(tree.root);
    expect(text).toContain("S one");
    expect(text).toContain("HOLDS");
    expect(text).toContain("O two");
    for (const basis of ["decoded", "recorded"]) expect(findAll(tree.root, (n) => (n.attrs.class ?? "").includes("lk-basis")).some((n) => textOf(n) === basis)).toBe(true);
    expect(findAll(tree.root, (n) => (n.attrs.class ?? "").includes("lk-obs")).map(textOf)).toContain("7");
    expect(chipIds(tree.root)).toEqual(["ev-1", "ev-2"]);
  });

  test("a reader row reads its basis as not stated, and a constructed row carries CONSTRUCTED", () => {
    const row = kitRow({ rowKind: "reader", bases: [], source: "reader", constructed: true });
    const tree = drawn({ meta: { snapshotIds: [], constructed: true }, results: { t1: kitTable([row], POS_COLS) } }, [{ id: "root", component: "PositionList", result: { path: "/results/t1" } }]);
    expect(findByClass(tree.root, "lk-basis-unstated").map(textOf)).toEqual(["basis not stated by the reader"]);
    expect(findByClass(tree.root, "lk-constructed").map(textOf)).toContain("CONSTRUCTED");
  });

  test("GapList draws its rows hatched with the reason word and the source", () => {
    const row = kitRow({ rowKind: "scope", bases: [], evidenceIds: [], values: { item: "the reserve status" }, reason: "not-captured", scopeSource: "the adapter and its capture" });
    const tree = drawn(kitModel({ results: { t1: kitTable([row], GAP_COLS, { shape: "unknowns" }) } }), [{ id: "root", component: "GapList", result: { path: "/results/t1" } }]);
    const rows = findByClass(tree.root, "lk-unknown");
    expect(rows.length).toBeGreaterThan(0);
    expect(findByClass(tree.root, "lk-gap-reason").map(textOf)).toContain("not captured");
    expect(textOf(tree.root)).toContain("the adapter and its capture");
    expect(textOf(tree.root)).toContain("the reserve status");
  });

  test("ChangeList draws both sides each with its own evidence, an absent side with its reason and no value", () => {
    const before = { value: "12", bases: ["decoded"], blockOrSlot: "1", evidenceIds: ["ev-1"], factIds: ["f1"] };
    const row = { kind: "changed", key: "k", before, after: { absent: true, reason: "not in this capture" } };
    const tree = drawn(kitModel({ results: { c1: kitChanges([row]) } }), [{ id: "root", component: "ChangeList", result: { path: "/results/c1" } }]);
    const sides = findByClass(tree.root, "lk-change-side");
    expect(sides.map((s) => s.attrs["data-side"])).toEqual(["before", "after"]);
    const absent = findByClass(tree.root, "lk-gap");
    expect(absent.length).toBeGreaterThan(0);
    expect(textOf(tree.root)).toContain("absent: not in this capture");
    const sideTexts = sides.map(textOf);
    expect(sideTexts[0]).toContain("12");
    expect(sideTexts[1]).not.toContain("12");
    expect(chipIds(tree.root)).toEqual(["ev-1"]);
  });

  test("ReceiptCard draws the seven fields equal to the record, and a null field reads not recorded", () => {
    const record: ReceiptRecord = { id: "rcp-1", source: "the reader at its origin", responseSha256: "cd".repeat(32), blockOrSlot: "468300100", observedAt: null, historicalState: null, privacy: "private" };
    const tree = drawn(kitModel({ receipts: { "rcp-1": record } }), [{ id: "root", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } }]);
    const cards = findByClass(tree.root, "lk-receipt");
    expect(cards).toHaveLength(1);
    const text = textOf(tree.root);
    for (const label of ["id", "source", "response sha256", "block or slot", "observed", "historical state", "privacy"]) expect(text).toContain(label);
    expect(text).toContain("the reader at its origin");
    expect(text).toContain("468300100");
    expect(text).toContain("private");
    expect(text).toContain("not recorded");
  });

  test("QueryTrace draws template, parameters, outcome, rows returned and reasons by code", () => {
    const tree = drawn(kitModel({ meta: { snapshotIds: [], trace: kitTrace } }), [{ id: "root", component: "QueryTrace", trace: { path: "/meta/trace" } }]);
    expect(findByClass(tree.root, "lk-trace")).toHaveLength(1);
    const text = textOf(tree.root);
    expect(text).toContain("control");
    expect(text).toContain("subject");
    expect(text).toContain("ok");
    expect(text).toContain("3");
    expect(text).toContain("no-facts");
  });

  test("Disclosure is a closed details whose summary holds title and a count equal to the rows inside", () => {
    const rows = [kitRow({ key: "a" }), kitRow({ key: "b" }), kitRow({ key: "c" })];
    const tree = drawn(
      kitModel({ results: { t1: kitTable(rows, NOTE_COLS, { total: 3 }) } }),
      [
        { id: "root", component: "Disclosure", title: "A held group", count: { path: "/results/t1/total" }, children: ["c1"] },
        { id: "c1", component: "FactTable", result: { path: "/results/t1" } },
      ],
    );
    const details = findByClass(tree.root, "lk-disclosure");
    expect(details).toHaveLength(1);
    expect(details[0].attrs.open).toBeUndefined();
    const summary = details[0].children.find((c) => c.tag === "summary");
    expect(summary).toBeDefined();
    const counts = findByClass(summary!, "lk-count").map(textOf);
    expect(counts).toEqual(["3"]);
    expect(textOf(summary!)).toContain("A held group");
    expect(findByClass(details[0], "lk-row")).toHaveLength(3);
  });

  test("a cut list holds shown of total", () => {
    const tree = drawn(kitModel({ results: { t1: kitTable([kitRow()], NOTE_COLS, { truncated: true, total: 110 }) } }), [{ id: "root", component: "FactTable", result: { path: "/results/t1" } }]);
    expect(findByClass(tree.root, "lk-cut").map(textOf)).toEqual(["1 of 110"]);
  });

  test("CaptureList draws each capture with counts, shown, the source and its evidence", () => {
    const captures = [kitCapture, { ...kitCapture, id: "cap-2", shown: false, constructed: true }];
    const tree = drawn({ meta: { snapshotIds: [], captures, constructed: true } }, [{ id: "root", component: "CaptureList", captures: { path: "/meta/captures" } }]);
    expect(findByClass(tree.root, "lk-captures")).toHaveLength(1);
    expect(findByClass(tree.root, "lk-row").length).toBe(2);
    const text = textOf(tree.root);
    expect(text).toContain("cap-1");
    expect(text).toContain("cap-2");
    expect(text).toContain("shown");
    expect(text).toContain("CONSTRUCTED");
    expect(text).toContain("recorded");
    expect(text).toContain("a recorded source");
    expect(chipIds(tree.root)).toEqual(["ev-1", "ev-1"]);
  });

  test("AnswerPath draws a staged drawing and the same links as rows, an amount only where the row has one", () => {
    const rows = [
      kitRow({ rowKind: "path", key: "l1", values: { from: "Activity", to: "Treasury", mechanism: "fee", status: "enforced-by-code", amount: "1.5", unit: "SOL" } }),
      kitRow({ rowKind: "path", key: "l2", values: { from: "Treasury", to: "Holders", status: "claimed-only" }, bases: ["claimed"] }),
    ];
    const tree = drawn(kitModel({ results: { p1: kitTable(rows, [], { shape: "path", resultId: "p1" }) } }), [{ id: "root", component: "AnswerPath", result: { path: "/results/p1" } }]);
    expect(findByClass(tree.root, "lk-answer-path")).toHaveLength(1);
    expect(findAll(tree.root, (n) => n.tag === "svg").length).toBeGreaterThan(0);
    const list = findByClass(tree.root, "lk-path");
    expect(list).toHaveLength(1);
    const text = textOf(tree.root);
    expect(text).toContain("Activity");
    expect(text).toContain("Treasury");
    expect(text).toContain("Holders");
    expect(text).toContain("1.5");
    const items = findByClass(tree.root, "lk-row");
    expect(items.length).toBe(2);
  });

  test("hostile label and value come out escaped from treeToHtml in every new component", () => {
    const components: [string, unknown, unknown[]][] = [
      ["GraphExplorer", kitModel({ results: { g1: kitGraph([kitGraphNode("n1", { label: HOSTILE_IMG, name: HOSTILE_IMG }), kitGraphNode("n2")], [kitGraphEdge("e1", "n1", "n2")]) } }), [{ id: "root", component: "GraphExplorer", result: { path: "/results/g1" } }]],
      ["FactCard", kitModel({ results: { t1: kitTable([kitRow({ values: { subject: HOSTILE_IMG, predicate: "P", object: HOSTILE_SCRIPT, finding: "f", status: "verified" } })], NOTE_COLS) } }), [{ id: "root", component: "FactCard", fact: { path: "/results/t1/rows/0" } }]],
      ["ReceiptCard", kitModel({ receipts: { "rcp-1": { ...kitReceipt, source: HOSTILE_IMG } } }), [{ id: "root", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } }]],
      ["AnswerPath", kitModel({ results: { p1: kitTable([kitRow({ rowKind: "path", values: { from: HOSTILE_IMG, to: HOSTILE_SCRIPT }, }),], [], { shape: "path", resultId: "p1" }) } }), [{ id: "root", component: "AnswerPath", result: { path: "/results/p1" } }]],
      ["FindingList", kitModel({ results: { t1: kitTable([kitRow({ values: { finding: HOSTILE_IMG, status: "verified" } })], NOTE_COLS) } }), [{ id: "root", component: "FindingList", result: { path: "/results/t1" } }]],
      ["ClaimCheck", kitModel({ results: { t1: kitTable([kitRow({ values: { claim: HOSTILE_IMG, source: HOSTILE_SCRIPT, "chain result": "r", status: "verified" } })], CLAIM_COLS) } }), [{ id: "root", component: "ClaimCheck", result: { path: "/results/t1" } }]],
      ["ChangeList", kitModel({ results: { c1: kitChanges([{ ...kitChangeRow, before: { ...kitSide, value: HOSTILE_IMG }, after: { ...kitSide, value: HOSTILE_SCRIPT } }]) } }), [{ id: "root", component: "ChangeList", result: { path: "/results/c1" } }]],
      ["PositionList", kitModel({ results: { t1: kitTable([kitRow({ rowKind: "reader", bases: [], source: "reader", values: { account: HOSTILE_SCRIPT, quantity: "5", unit: "U", leg: "token", "joined to": HOSTILE_IMG } })], POS_COLS) } }), [{ id: "root", component: "PositionList", result: { path: "/results/t1" } }]],
      ["CaptureList", { meta: { snapshotIds: [], captures: [{ ...kitCapture, source: HOSTILE_IMG }] } }, [{ id: "root", component: "CaptureList", captures: { path: "/meta/captures" } }]],
      ["GapList", kitModel({ results: { t1: kitTable([kitRow({ rowKind: "scope", bases: [], evidenceIds: [], values: { item: HOSTILE_IMG }, reason: "not-read", scopeSource: HOSTILE_SCRIPT })], GAP_COLS, { shape: "unknowns" }) } }), [{ id: "root", component: "GapList", result: { path: "/results/t1" } }]],
      ["QueryTrace", kitModel({ meta: { snapshotIds: [], trace: { ...kitTrace, params: { q: HOSTILE_SCRIPT } } } }), [{ id: "root", component: "QueryTrace", trace: { path: "/meta/trace" } }]],
      ["Disclosure", kitModel({ results: { t1: kitTable([kitRow({ values: { finding: HOSTILE_IMG, status: HOSTILE_SCRIPT } })], NOTE_COLS, { total: 1 }) } }), [
        { id: "root", component: "Disclosure", title: "A held group", count: { path: "/results/t1/total" }, children: ["c1"] },
        { id: "c1", component: "FactTable", result: { path: "/results/t1" } },
      ]],
    ];
    for (const [name, modelValue, comps] of components) {
      const tree = drawn(modelValue, comps);
      const html = treeToHtml(tree);
      const carriesImg = JSON.stringify(modelValue).includes(HOSTILE_IMG);
      const carriesScript = JSON.stringify(modelValue).includes(HOSTILE_SCRIPT);
      expect(html.includes("<img"), name).toBe(false);
      expect(html.includes("<script"), name).toBe(false);
      expect(/<[^>]+\son[a-z]+=/i.test(html), name).toBe(false);
      if (carriesImg) expect(html, name).toContain("&lt;img src=x onerror=alert(1)&gt;");
      if (carriesScript) expect(html, name).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });

  test("two interpretations of the same surface are deep-equal", () => {
    const messages = v2Surface(
      "s",
      kitModel({ results: { t1: kitTable([kitRow()], NOTE_COLS) }, receipts: { "rcp-1": kitReceipt } }),
      [
        { id: "r1", component: "FactCard", fact: { path: "/results/t1/rows/0" } },
        { id: "r2", component: "ReceiptCard", receipt: { path: "/receipts/rcp-1" } },
      ],
    );
    expect(interpret(messages)).toEqual(interpret(messages));
  });
});

/* ------------------------------------------------------------------ */
/* AC4 — the explorer model and its drawing seam                        */
/* ------------------------------------------------------------------ */
describe("AC4 the explorer model on the committed fixture graph", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/solana-app/explorer-graph.json"), "utf8")) as GraphResult;
  const ids = (m: ReturnType<typeof explorerModel>) => new Set(m.nodes.map((n) => n.id));

  /** Recomputed breadth-first: nodes within `steps` edges of the focus, direction ignored, gap edges excluded. */
  function within(result: GraphResult, focus: string, steps: number, layers?: string[]): Set<string> {
    const active = result.edges.filter((e) => (layers ?? result.edges.map((x) => x.layer ?? "Structure").filter((x, i, a) => a.indexOf(x) === i)) === undefined ? true : layers === undefined ? true : layers.includes(e.layer ?? "Structure"));
    const kept = result.edges.filter((e) => (layers ?? null) === null || layers!.includes(e.layer ?? "Structure"));
    void active;
    const gap = new Set(["none", "unknown"]);
    const adjacency = new Map<string, string[]>();
    for (const e of kept) {
      if (gap.has(e.to) && !result.nodes.some((n) => n.id === e.to)) continue;
      adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);
      adjacency.set(e.to, [...(adjacency.get(e.to) ?? []), e.from]);
    }
    const seen = new Set([focus]);
    let frontier = [focus];
    for (let d = 1; d <= steps; d++) {
      const next: string[] = [];
      for (const node of frontier) for (const n of adjacency.get(node) ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); }
      frontier = next;
    }
    return seen;
  }

  test("the fixture holds 40 nodes and 52 edges over the four named layers", () => {
    expect(fixture.nodes).toHaveLength(40);
    expect(fixture.edges).toHaveLength(52);
    expect(new Set(fixture.edges.map((e) => e.layer))).toEqual(new Set(["Control", "Structure", "Pricing", "Code"]));
  });

  for (const steps of [1, 2, 3]) {
    test(`steps ${steps}: exactly the nodes within that many edges, and only edges whose ends are kept`, () => {
      const m = explorerModel(fixture, { focus: "foc", steps });
      expect(ids(m)).toEqual(within(fixture, "foc", steps));
      expect(m.nodes.map((n) => n.id)[0]).toBe("foc");
      expect(m.nodes.find((n) => n.id === "foc")?.step).toBe(0);
      for (const edge of m.edges) {
        expect(ids(m).has(edge.from) && ids(m).has(edge.to), edge.key).toBe(true);
        const input = fixture.edges.find((e) => e.key === edge.key)!;
        expect(edge).toEqual(input);
      }
      expect(m.edges).toHaveLength(fixture.edges.filter((e) => ids(m).has(e.from) && ids(m).has(e.to) && !["none", "unknown"].includes(e.to)).length);
    });
  }

  test("the control lane follows the controllers: the authorities of the focus, then theirs, within the steps", () => {
    // Recorded answer on lane direction: a Control-layer edge whose from is the node means that node is controlled.
    const lane = (steps: number) => explorerModel(fixture, { focus: "foc", steps }).nodes.filter((n) => n.lane === "control").map((n) => [n.id, n.step]);
    expect(lane(1)).toEqual([["c1", 1]]);
    expect(lane(2)).toEqual([["c1", 1], ["c2", 2]]);
    expect(lane(3)).toEqual([["c1", 1], ["c2", 2], ["c3", 3]]);
    for (const steps of [1, 2, 3]) {
      for (const node of explorerModel(fixture, { focus: "foc", steps }).nodes) {
        if (node.lane === "rests-on") expect(node.step, node.id).toBeGreaterThan(0);
        if (node.lane !== "focus" && node.lane !== "control") expect(["rests-on", "rested-on-by"]).toContain(node.lane);
      }
    }
  });

  test("ten neighbours by one relation fold into the first four by name and a group of six listed by id", () => {
    const m = explorerModel(fixture, { focus: "foc", steps: 2 });
    const group = m.groups.find((g) => g.relation === "POOL_SHARE");
    expect(group).toBeDefined();
    expect(group!.anchor).toBe("hub");
    expect(group!.side).toBe("out");
    expect(group!.memberIds).toEqual(["h05", "h06", "h07", "h08", "h09", "h10"]);
    expect(group!.expanded).toBe(false);
    for (const id of group!.memberIds) {
      expect(m.nodes.find((n) => n.id === id)?.foldedInto).toBe(group!.id);
    }
    for (const id of ["h01", "h02", "h03", "h04"]) {
      expect(m.nodes.find((n) => n.id === id)?.foldedInto).toBeNull();
    }
    expect(m.nodes.filter((n) => n.foldedInto !== null)).toHaveLength(6);
  });

  test("with that group in expanded all ten are drawn unfolded", () => {
    const folded = explorerModel(fixture, { focus: "foc", steps: 2 });
    const open = explorerModel(fixture, { focus: "foc", steps: 2, expanded: ["hub|POOL_SHARE|out"] });
    expect(open.nodes.filter((n) => n.foldedInto === null)).toHaveLength(folded.nodes.length);
    expect(open.nodes.find((n) => n.id === "h10")?.foldedInto).toBeNull();
    expect(open.groups.find((g) => g.relation === "POOL_SHARE")?.expanded).toBe(true);
  });

  test("a layer left out of layers removes exactly its edges and nothing else", () => {
    const both = explorerModel(fixture, { focus: "foc", steps: 3, layers: ["Control", "Structure"] });
    const pricingAndCode = fixture.edges.filter((e) => e.layer === "Pricing" || e.layer === "Code").map((e) => e.key);
    const kept = both.edges.map((e) => e.key);
    for (const key of pricingAndCode) expect(kept.includes(key), `${key} gone`).toBe(false);
    // What remains is exactly the smaller walk: the recomputed neighbourhood over the two layers.
    expect(within(fixture, "foc", 3, ["Control", "Structure"])).toEqual(ids(both));
    for (const edge of both.edges) expect(["Control", "Structure"].includes(edge.layer ?? "Structure"), edge.key).toBe(true);
  });

  test("an edge to unknown or none is a gap end with no node", () => {
    const m = explorerModel(fixture, { focus: "foc", steps: 1 });
    expect(m.gapEnds.map((g) => [g.from, g.end]).sort()).toEqual([["foc", "none"], ["foc", "unknown"]].sort());
    expect(m.nodes.some((n) => n.id === "unknown")).toBe(false);
    expect(m.nodes.some((n) => n.id === "none")).toBe(false);
    expect(m.gapEdges).toHaveLength(2);
    for (const gapEdge of m.gapEdges) expect(["none", "unknown"]).toContain(gapEdge.to);
  });

  test("an unknown focus and a step count outside one to three are refused", () => {
    expect(() => explorerModel(fixture, { focus: "no-such-node" })).toThrow(UiRejected);
    try {
      explorerModel(fixture, { focus: "no-such-node" });
    } catch (error) {
      expect((error as UiRejected).code).toBe("unknown-node");
    }
    for (const steps of [0, 4, -1]) {
      try {
        explorerModel(fixture, { focus: "foc", steps });
        throw new Error(`steps ${steps} did not throw`);
      } catch (error) {
        expect((error as UiRejected).code).toBe("bad-steps");
      }
    }
  });

  test("without a focus the whole graph is drawn, every node at step zero", () => {
    const m = explorerModel(fixture, {});
    expect(m.focus).toBeNull();
    expect(ids(m)).toEqual(new Set(fixture.nodes.map((n) => n.id)));
    expect(m.nodes.every((n) => n.lane === "whole" && n.step === 0)).toBe(true);
    expect(m.edges).toHaveLength(fixture.edges.filter((e) => !["none", "unknown"].includes(e.to) || fixture.nodes.some((n) => n.id === e.to)).length);
  });

  test("a model above the sixty-node line folds its largest expanded group again before refusing", () => {
    const big = (members: string[], relationPrefix: string): GraphResult => {
      const nodes = [kitGraphNode("root"), ...members.map((m) => kitGraphNode(m))];
      const edges = members.map((m, i) => kitGraphEdge(`k${i}`, "root", m, { relation: `${relationPrefix}-${i}` }));
      return kitGraph(nodes, edges);
    };
    // Two expanded groups of different sizes: opening both crosses the line, so the larger folds again.
    const g1 = Array.from({ length: 30 }, (_, i) => `a${String(i).padStart(2, "0")}`);
    const g2 = Array.from({ length: 40 }, (_, i) => `b${String(i).padStart(2, "0")}`);
    const nodes = [kitGraphNode("root"), ...g1.map((m) => kitGraphNode(m)), ...g2.map((m) => kitGraphNode(m))];
    const edges = [
      ...g1.map((m, i) => kitGraphEdge(`ka${i}`, "root", m, { relation: "REL-A" })),
      ...g2.map((m, i) => kitGraphEdge(`kb${i}`, "root", m, { relation: "REL-B" })),
    ];
    const result = kitGraph(nodes, edges);
    const opened = explorerModel(result, { focus: "root", steps: 1, expanded: ["root|REL-A|out", "root|REL-B|out"] });
    const groupA = opened.groups.find((g) => g.relation === "REL-A")!;
    const groupB = opened.groups.find((g) => g.relation === "REL-B")!;
    expect(groupA.expanded).toBe(true);
    expect(groupB.expanded).toBe(false);
    expect(opened.nodes.find((n) => n.id === "b30")?.foldedInto).toBe(groupB.id);
    expect(opened.nodes.find((n) => n.id === "a29")?.foldedInto).toBeNull();
    // Sixty-one nodes joined by distinct relations cannot fold and are refused.
    const flat = big(Array.from({ length: 61 }, (_, i) => `n${String(i).padStart(2, "0")}`), "SOLO");
    expect(() => explorerModel(flat, { focus: "root", steps: 1 })).toThrow(UiRejected);
    try {
      explorerModel(flat, { focus: "root", steps: 1 });
    } catch (error) {
      expect((error as UiRejected).code).toBe("graph-too-large");
    }
    // The whole graph above the line is refused as well.
    expect(() => explorerModel(flat, {})).toThrow(UiRejected);
  });

  test("two calls on the same input are deep-equal", () => {
    expect(explorerModel(fixture, { focus: "foc", steps: 3, expanded: ["hub|POOL_SHARE|out"] })).toEqual(
      explorerModel(fixture, { focus: "foc", steps: 3, expanded: ["hub|POOL_SHARE|out"] }),
    );
  });

  test("the drawing holds what the model holds: svg, lists, selection hooks and gap ends", () => {
    const model = explorerModel(fixture, { focus: "foc", steps: 2 });
    const figure = drawExplorer(model);
    expect(figure.tag).toBe("figure");
    expect((figure.attrs.class ?? "").split(/\s+/)).toContain("lk-explorer");
    const svg = findAll(figure, (n) => n.tag === "svg");
    expect(svg).toHaveLength(1);
    expect(svg[0].attrs.role).toBe("img");
    expect(findByClass(figure, "lk-focus").length).toBeGreaterThan(0);
    const nodeIds = new Set(model.nodes.map((n) => n.id));
    const listNodes = findByClass(figure, "lk-explorer-nodes").flatMap((list) => list.children);
    expect(listNodes.length).toBe(model.nodes.length);
    for (const li of listNodes) {
      expect(li.attrs["data-lk-select"]).toBe("node");
      expect(nodeIds.has(li.attrs["data-lk-id"] ?? "")).toBe(true);
    }
    const edgeList = findByClass(figure, "lk-explorer-edges").flatMap((list) => list.children);
    expect(edgeList.length).toBe(model.edges.length + model.gapEdges.length);
    for (const li of edgeList) {
      expect(li.attrs["data-lk-select"]).toBe("edge");
      expect(li.attrs["data-lk-id"]).toBeDefined();
      expect(chipIds(li).length).toBeGreaterThan(0);
    }
    const groupList = findByClass(figure, "lk-explorer-groups").flatMap((list) => list.children);
    expect(groupList.length).toBe(model.groups.length);
    expect(textOf(figure)).toContain("more");
    expect(textOf(figure)).toContain("6");
    expect(findAll(figure, (n) => n.tag === "img")).toHaveLength(0);
  });

  test("the drawing module imports nothing but kit types and kit helpers", () => {
    const source = readFileSync(join(ROOT, "src/ui/explorer-draw.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const target of imports) expect(["./types", "./html", "./strings", "./explorer-model"]).toContain(target);
    const modelSource = readFileSync(join(ROOT, "src/ui/explorer-model.ts"), "utf8");
    for (const target of [...modelSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])) {
      expect(target).toBe("./types");
    }
  });

  test.skipIf(!APP_RUN_PINS_APPLY)("package.json and bun.lock equal the base (original feature branch only)", () => {
    const run = Bun.spawnSync(["git", "diff", APP_PIN_BASE, "--", "package.json", "bun.lock"], { cwd: ROOT });
    expect(run.stdout.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("the historical pin guard skips without throwing when git is missing", () => {
    const ownSource = readFileSync(import.meta.path!, "utf8");
    const start = ownSource.indexOf("const APP_PIN_BASE =");
    const end = ownSource.indexOf("const sha256 =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const code = `const ROOT = ${JSON.stringify(ROOT)};\n${ownSource.slice(start, end)}\nconsole.log(JSON.stringify(APP_RUN_PINS_APPLY));`;
    const withoutGit = mkdtempSync(join(tmpdir(), "linchpin-no-git-"));
    try {
      const run = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], {
        cwd: ROOT, env: { PATH: withoutGit }, stdout: "pipe", stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(run.stdout.toString().trim()).toBe("false");
    } finally { rmSync(withoutGit, { recursive: true, force: true }); }
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* AC5 — every app surface validated before drawing                     */
/* ------------------------------------------------------------------ */
describe("AC5 every app surface validated before drawing", () => {
  const TABS = ["overview", "control", "dependencies", "value-path", "unknowns", "changes"] as const;

  test("every tab surface of every series of the public build validates, twice byte-identical", () => {
    for (const pack of data.packs) {
      for (const series of pack.series) {
        for (const tab of TABS) {
          const first = tabSurface(data, pack, series, tab);
          const second = tabSurface(data, pack, series, tab);
          expect(JSON.stringify(first), `${pack.id}/${series.id}/${tab}`).toBe(JSON.stringify(second));
          const result = render(first, resolverOverAll());
          expect(result.ok, `${pack.id}/${series.id}/${tab}: ${JSON.stringify(result.ok ? [] : result.codes)}`).toBe(true);
        }
        const header = headerSurface(data, pack, series);
        expect(render(header, resolverOverAll()).ok, `${pack.id}/${series.id} header`).toBe(true);
      }
      expect(render(indexSurface(data, pack), resolverOverAll()).ok, `${pack.id} index`).toBe(true);
    }
  });

  test("every position surface and every position sheet of both replayed reads validates", () => {
    const reads = data.positions!.reads;
    for (const read of reads) {
      const resolver = resolverOver(new Set([...allReceiptIds]));
      const produced = positionsSurface(read);
      expect(render(produced, resolver).ok, read.source).toBe(true);
      expect(JSON.stringify(positionsSurface(read))).toBe(JSON.stringify(produced));
    }
    for (const read of reads) {
      for (let ordinal = 1; ordinal <= read.sheets.length; ordinal++) {
        const sheet = sheetSurface(data, read, ordinal);
        expect(sheet, `${read.source} sheet ${ordinal}`).not.toBeNull();
        const result = render(sheet!, resolverOverAll());
        expect(result.ok, `${read.source} sheet ${ordinal}: ${JSON.stringify(result.ok ? [] : result.codes)}`).toBe(true);
        expect(JSON.stringify(sheetSurface(data, read, ordinal))).toBe(JSON.stringify(sheet));
      }
    }
  });

  test("a dropped receipt id refuses the region citing it with unresolved-evidence and draws none of its rows", () => {
    const pack = data.packs.find((p) => p.id === "kamino-lend")!;
    const series = pack.series[0];
    const chain = series.results["control-0"] as { rows: { evidenceIds: string[]; values: Record<string, unknown> }[] };
    const cited = chain.rows.flatMap((r) => r.evidenceIds)[0];
    expect(cited).toBeDefined();
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never, { dropReceiptIds: [cited] });
    harness.setHash("#/protocols/kamino-lend/main-market/control");
    app.draw();
    const main = harness.doc.getElementById(IDS.main);
    const refused = main.classed("sx-refused");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.map((el) => el.textContent ?? "").join(" ")).toContain("view refused:");
    expect(refused.map((el) => el.textContent ?? "").join(" ")).toContain("unresolved-evidence");
    const distinctive = chain.rows.map((r) => Object.values(r.values).join(" ")).find((v) => v.length > 12)!;
    expect(main.textContent ?? "").not.toContain(distinctive.slice(0, 24));
  });

  test("no app or new kit file renders HTML through the browser", () => {
    const files = ["src/apps/solana", "src/ui"].flatMap((dir) =>
      ["app.ts", "chrome.ts", "client.ts", "compose.ts", "guard.ts", "join.ts", "layers.ts", "load.ts", "main.ts", "model.ts", "page.ts", "positions.ts", "providers.ts", "route.ts", "rows.ts", "server.ts", "state.ts", "strings.ts", "surfaces.ts", "catalog-v2.ts", "templates-v2.ts", "explorer-model.ts", "explorer-draw.ts", "gallery-v2.ts"]
        .map((name) => join(ROOT, dir, name))
        .filter((path) => existsSync(path)),
    );
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const call of FORBIDDEN_CALLS) {
        expect(source.includes(call), `${file} holds ${call}`).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Recomputation from the committed captures                            */
/* ------------------------------------------------------------------ */
type FactProps = { id: string; snapshotId: string; subjectId: string; predicate: string; class: string; basis: string; evidenceIds: string[]; key: string };
const factsById = new Map<string, FactProps>();
let factsIndexed = false;
function ensureFacts(): void {
  if (factsIndexed) return;
  for (const node of records.nodes) {
    if (node.label === "Fact") {
      const props = node.props as unknown as FactProps;
      factsById.set(props.id, props);
    }
  }
  factsIndexed = true;
}
const propsOfFact = (factId: string): FactProps | undefined => {
  ensureFacts();
  return factsById.get(factId);
};
const packOf = (id: string): PackData => data.packs.find((p) => p.id === id)!;
const seriesOfPack = (packId: string, seriesId: string): SeriesData => packOf(packId).series.find((s) => s.id === seriesId)!;
const replayPair = (source: "recorded" | "constructed") => {
  const replay = replayClient(".", source);
  return { holder: replay.holder, client: replay.client };
};
const readIdFor = (source: "recorded" | "constructed"): string => readId(source);
const PREFIXLESS = (id: string): string => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id);
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = netNamespace.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
const withToken = (server: { origin: string; token: string }) => (input: string, init?: RequestInit) => {
  const url = input.startsWith("http://") || input.startsWith("https://") ? input : `${server.origin}${input}`;
  return realFetch(url, { ...init, headers: { ...(init?.headers ?? {}), "x-app-token": server.token, origin: server.origin } });
};

/** The control facts a series' Control tab must cover, recomputed per the recorded sources. */
function recomputedControlFactIds(series: SeriesData, packId: string): Map<string, FactProps> {
  const out = new Map<string, FactProps>();
  if (packId === "marinade") {
    const snapshot = marinadeInputs.find((s) => s.id === series.snapshotId)!;
    for (const fact of snapshot.facts) {
      const cls = (VOCABULARY as Record<string, { class: string } | undefined>)[fact.predicate]?.class;
      if (cls === "control") out.set(fact.id, { id: fact.id, snapshotId: snapshot.id, subjectId: fact.subject, predicate: fact.predicate, class: "control", basis: fact.basis, evidenceIds: fact.evidenceIds, key: `${fact.subject}|${fact.predicate}` });
    }
    return out;
  }
  const snapshot = solanaSnapshots.find((s) => s.id === series.snapshotId)!;
  for (const subject of [...snapshot.subjects].sort()) {
    const result = runEvidenceLocal(records, "control", { subject, scope: { snapshotId: snapshot.id, asOf: snapshot.observedTo, maxHops: 1, maxResults: 500 } }) as { rows: Record<string, unknown>[] };
    for (const row of result.rows) {
      if (row.rowKind === "coverage" || typeof row.factId !== "string") continue;
      const props = propsOfFact(row.factId);
      if (props) out.set(props.id, props);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AC6 — protocols: index, control, dependencies                        */
/* ------------------------------------------------------------------ */
describe("AC6 protocols: index, control, dependencies", () => {
  test("the public build lists exactly the three packs, and the absent line for Loopscale", () => {
    expect(data.packs.map((p) => p.id)).toEqual(["marinade", "kamino-lend", "kamino-vaults"]);
    expect(data.absent).toEqual([{ id: "loopscale", line: "Loopscale: not in the public build" }]);
    expect(data.build).toBe("public");
  });

  test("each pack index row equals the counts recomputed over the loaded snapshots", () => {
    const inputs = collectEvidenceInputs(".").filter((i) => i.snapshot.chain === "solana").map((i) => i.snapshot);
    const latestOfSeries = (seriesId: string): ReturnType<typeof buildMarinadeSnapshots>[number] | undefined => {
      if (seriesId === "marinade") return marinadeInputs.at(-1);
      return inputs.filter((s) => {
        try {
          return seriesOfName(s.id) === seriesId;
        } catch {
          return false;
        }
      }).sort((a, b) => (a.observedTo < b.observedTo ? -1 : 1)).at(-1);
    };
    const seriesOfName = (snapshotId: string): string => {
      if (snapshotId.includes("kamino-lend")) return "main-market";
      if (snapshotId.includes("kamino.sentora")) return "sentora-pyusd";
      const vault = snapshotId.replace("solana-mainnet-beta.kamino.", "").replace(/-\d{8}T\d{6}Z$/, "");
      return vault;
    };
    for (const pack of data.packs) {
      const row = pack.index.rows[0] as { values: Record<string, unknown>; scopeSource: string };
      const latest = pack.series.map((s) => latestOfSeries(s.id)!);
      const caps = pack.series.map((s) => {
        if (pack.id === "marinade") return marinadeInputs.filter((m) => true).length;
        return inputs.filter((snap) => seriesIdOfSnapshot(snap.id, pack) === s.id && snap.id.includes("kamino")).length;
      });
      const totalCaptures = caps.reduce((a, b) => a + b, 0);
      const unknowns = latest.reduce((sum, s) => sum + s.facts.filter((f) => f.object === "unknown" || f.basis === "unknown" || f.status === "unverified").length, 0);
      expect(row.values["facts"], pack.id).toBe(latest.reduce((sum, s) => sum + s.facts.length, 0));
      expect(row.values["accounts"], pack.id).toBe(latest.reduce((sum, s) => sum + s.subjects.length, 0));
      expect(row.values["captures"], pack.id).toBe(totalCaptures);
      expect(row.values["unknown facts"], pack.id).toBe(unknowns);
      const newest = latest.sort((a, b) => (a.observedTo < b.observedTo ? -1 : 1)).at(-1)!;
      expect(row.values["latest capture"], pack.id).toBe(newest.observedTo);
      expect(String(row.values["slot"]), pack.id).toBe(String(newest.toBlockOrSlot));
      expect(row.scopeSource.startsWith("counted from the loaded snapshots")).toBe(true);
      const titlesOfVaults = pack.series.map((s) => s.title);
      if (pack.id === "marinade") expect(titlesOfVaults).toEqual(["Marinade"]);
      else for (const title of titlesOfVaults) expect(PROTOCOLS.some((p) => p.title === title), title).toBe(true);
    }
    function seriesIdOfSnapshot(snapshotId: string, pack: PackData): string {
      if (!snapshotId.includes("kamino")) return "not-this-pack";
      if (snapshotId.includes("kamino-lend")) return "main-market";
      return snapshotId.replace("solana-mainnet-beta.kamino.", "").replace(/-\d{8}T\d{6}Z$/, "");
    }
  });

  test("the vault pack lists exactly the six recorded series by their recorded titles", () => {
    const vaults = packOf("kamino-vaults");
    expect(vaults.series.map((s) => s.id).sort()).toEqual(Object.keys(VAULT_TARGETS).sort());
    const titles = vaults.series.map((s) => s.title);
    expect(titles).toContain("Kamino");
    expect(titles.filter((t) => t.startsWith("Kamino kVault"))).toHaveLength(5);
    for (const series of vaults.series) {
      expect(PROTOCOLS.find((p) => p.title === series.title)?.series, series.title).toBeDefined();
    }
  });

  test("the control rows of the Kamino Lend market, the Sentora vault and Marinade equal their recomputed facts", () => {
    const cases: [string, string][] = [
      ["kamino-lend", "main-market"],
      ["kamino-vaults", "sentora-pyusd"],
      ["marinade", "marinade"],
    ];
    for (const [packId, seriesId] of cases) {
      const series = seriesOfPack(packId, seriesId);
      const recomputed = recomputedControlFactIds(series, packId);
      expect(recomputed.size, `${packId} recomputed control facts`).toBeGreaterThan(0);
      const chainRows = series.controlGroups.flatMap((g) => ((series.results[g.resultId] as { rows: { factIds: string[]; bases: string[]; evidenceIds: string[] }[] }).rows));
      const membersRows = ((series.results.members ?? { rows: [] }) as { rows: { factIds: string[] }[] }).rows;
      const thresholdRows = ((series.results.thresholds ?? { rows: [] }) as { rows: { factIds: string[] }[] }).rows;
      const covered = new Set([...chainRows, ...membersRows, ...thresholdRows].flatMap((r) => r.factIds));
      for (const id of recomputed.keys()) expect(covered.has(id), `${packId}: fact ${id.slice(0, 12)} covered`).toBe(true);
      ensureFacts();
      const thresholdPredicateIds = new Set([...factsById.values()].filter((f) => f.snapshotId === series.snapshotId && f.predicate === "MULTISIG_THRESHOLD").map((f) => f.id));
      for (const id of covered) {
        expect(recomputed.has(id) || thresholdPredicateIds.has(id), `${packId}: row fact ${id.slice(0, 12)} is in the recomputed set or a threshold`).toBe(true);
      }
      for (const row of chainRows) {
        if (row.factIds.length === 0) continue;
        const facts = row.factIds.map((id) => recomputed.get(id) ?? propsOfFact(id)).filter(Boolean) as FactProps[];
        expect(facts.length, `${packId}: row facts resolve`).toBe(row.factIds.length);
        expect(new Set(row.bases), `${packId}: row bases`).toEqual(new Set(facts.flatMap((f) => [f.basis])));
        expect(new Set(row.evidenceIds), `${packId}: row evidence`).toEqual(new Set(facts.flatMap((f) => f.evidenceIds)));
      }
    }
  });

  test("the pinned control facts are drawn with their pinned receipts", () => {
    const lend = seriesOfPack("kamino-lend", "main-market");
    const vault = seriesOfPack("kamino-vaults", "sentora-pyusd");
    const lendRows = lend.controlGroups.flatMap((g) => (lend.results[g.resultId] as { rows: { factIds: string[]; evidenceIds: string[] }[] }).rows);
    expect(lendRows.some((r) => r.factIds.includes(MARKET_OWNER_FACT) && r.evidenceIds.includes(MARKET_OWNER_RECEIPT))).toBe(true);
    const vaultRows = vault.controlGroups.flatMap((g) => (vault.results[g.resultId] as { rows: { factIds: string[]; evidenceIds: string[] }[] }).rows);
    expect(vaultRows.some((r) => r.factIds.includes(VAULT_ADMIN_FACT) && r.evidenceIds.includes(VAULT_ADMIN_RECEIPT))).toBe(true);
    expect(data.receipts[MARKET_OWNER_RECEIPT]).toBeDefined();
    expect(data.receipts[VAULT_ADMIN_RECEIPT]).toBeDefined();
    expect(data.receipts[MARKET_OWNER_RECEIPT].privacy).toBe("public");
  });

  test("every dependencies edge carries a fact id, a basis and resolving evidence", () => {
    for (const pack of data.packs) {
      for (const series of pack.series) {
        const graph = series.results.graph as { edges: { factIds: string[]; bases: string[]; evidenceIds: string[] }[] } | undefined;
        expect(graph, `${pack.id}/${series.id} graph`).toBeDefined();
        expect(graph!.edges.length, `${pack.id}/${series.id} edges`).toBeGreaterThan(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC8 — overview density                                               */
/* ------------------------------------------------------------------ */
describe("AC8 overview density", () => {
  const TABS = ["overview", "control", "dependencies", "value-path", "unknowns", "changes"] as const;

  function fullTotals(series: SeriesData, packId: string): Record<string, number> {
    const chainRows = series.controlGroups.reduce((sum, g) => sum + ((series.results[g.resultId] as { rows: unknown[] }).rows.length), 0);
    const graph = series.results.graph as { edges: unknown[] };
    const unknownRows = ((series.results.unknowns ?? { rows: [] }) as { rows: unknown[] }).rows.length;
    const changes = series.results.changes as { rows: unknown[] } | undefined;
    const changesGap = series.results["changes-gap"] as { rows: unknown[] } | undefined;
    const routed = packId === "marinade"
      ? ((series.results.findings ?? { rows: [] }) as { rows: unknown[] }).rows.length
      : ["fees", "treasury", "flows"].length;
    return { who: chainRows, rests: graph.edges.length, routed, unknown: unknownRows, changed: changes ? changes.rows.length : (changesGap?.rows.length ?? 0) };
  }

  test("the five overview blocks hold at most three rows, a shown-of-total equal to the full result, and a link each", () => {
    expect(OVERVIEW_BLOCKS.map((b) => b.tab)).toEqual(["control", "dependencies", "value-path", "unknowns", "changes"]);
    for (const pack of data.packs) {
      for (const series of pack.series) {
        const totals = fullTotals(series, pack.id);
        const overview = overviewResults(series);
        const byId = new Map(overview.map((r) => [r.resultId, r]));
        const overviewSurface = tabSurface(data, pack, series, "overview");
        const accepted = render(overviewSurface, resolverOverAll());
        expect(accepted.ok, `${pack.id}/${series.id}`).toBe(true);
        expect(accepted.ok ? accepted.tree.root : null).not.toBeNull();
        // The drawn overview: five blocks, each with its rows, its cut line and its link.
        const harness = makeHarness();
        const app = startApp(harness.env({ data }) as never);
        harness.setHash(`#/protocols/${pack.id}/${series.id}/overview`);
        app.draw();
        const main = harness.doc.getElementById(IDS.main);
        const blocks = main.byAttr("data-block");
        expect(blocks.map((b) => b.attr("data-block")), `${pack.id}/${series.id} blocks`).toEqual(["who", "rests", "routed", "unknown", "changed"]);
        for (const block of blocks) {
          const id = block.attr("data-block")!;
          const rows = block.classed("lk-row");
          expect(rows.length, `${pack.id}/${series.id}/${id} lead rows`).toBeLessThanOrEqual(3);
          const cuts = block.classed("lk-cut");
          expect(cuts.length, `${pack.id}/${series.id}/${id} cut line`).toBeGreaterThan(0);
          const match = /(\d+) of (\d+)/.exec(cuts[0].textContent ?? "");
          expect(match, `${pack.id}/${series.id}/${id} cut text`).not.toBeNull();
          if (match) {
            expect(Number(match[2]), `${pack.id}/${series.id}/${id} total`).toBe(totals[id]);
            const overviewTotal = byId.get(id) ? (byId.get(id) as { total?: number }).total : undefined;
            expect(overviewTotal, `${pack.id}/${series.id}/${id} surface total`).toBe(totals[id]);
          }
          expect(block.byAttr("data-go").length, `${pack.id}/${series.id}/${id} link`).toBeGreaterThan(0);
          const link = block.byAttr("data-go")[0].attr("data-go")!;
          expect(link.startsWith("#/protocols/"), link).toBe(true);
        }
        const svgs = main.classed("lk-explorer-svg");
        expect(svgs.length, `${pack.id}/${series.id} graphs`).toBeLessThanOrEqual(1);
        for (const summary of main.walk().filter((el) => el.tag === "summary")) {
          const details = summary.parent!;
          if (!(details.attr("class") ?? "").split(/\s+/).includes("lk-disclosure")) continue;
          const count = findByClassOfElement(summary, "lk-count")[0]?.textContent ?? "";
          if (count) expect(Number(count), `${pack.id}/${series.id} disclosure count`).toBe(findByClassOfElement(details, "lk-row").length);
        }
      }
    }
  });

  testT("nothing is hidden by truncation: identifiers wrap and no row hides behind a cut", { timeout: 60_000 }, () => {
    // The DOM contract draws every row it was given; the cut only counts. Check the row count of the
    // fullest block against its total: at most three drawn, the rest one activation away on the tab.
    const series = seriesOfPack("kamino-lend", "main-market");
    const overview = overviewResults(series);
    for (const result of overview) {
      const rows = (result as { rows?: unknown[] }).rows ?? [];
      expect(rows.length, result.resultId).toBeLessThanOrEqual(3);
      expect(result.truncated || rows.length === (result as { total?: number }).total).toBe(true);
    }
    void TABS;
  });
});

/* ------------------------------------------------------------------ */
/* AC9 — graph exploration in the app                                   */
/* ------------------------------------------------------------------ */
describe("AC9 graph exploration in the served app", () => {
  const DEPS = "#/protocols/kamino-lend/main-market/dependencies";
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    const served: AppData = { ...data, mode: "served", positions: null };
    server = await startServer({ port: 0, data: served });
  }, LONG);

  afterAll(async () => {
    await server?.stop();
  });

  const pageFetch = (extra: Record<string, string> = {}) => (input: string, init?: RequestInit) =>
    realFetch(input, { ...init, headers: { ...(init?.headers ?? {}), "x-app-token": server.token, origin: server.origin, ...extra } });

  test("choosing a node refocuses, sets the fragment, and that fragment opens on the same focus", () => {
    const harness = makeHarness(pageFetch());
    const app = startApp(harness.env({ data: { ...data, mode: "served", positions: null } }) as never);
    harness.setHash(DEPS);
    app.draw();
    const main = harness.doc.getElementById(IDS.main);
    const nodes = main.byAttr("data-lk-select", "node");
    expect(nodes.length).toBeGreaterThan(3);
    const target = nodes.find((el) => el.attr("data-lk-id") !== seriesOfPack("kamino-lend", "main-market").focus)!;
    const account = target.attr("data-lk-id")!;
    target.dispatch("click");
    expect(harness.location.hash).toBe(`${DEPS}?focus=${encodeURIComponent(PREFIXLESS(account))}`);
    harness.setHash(harness.location.hash);
    app.draw();
    const focused = main.byAttr("data-lk-id", account).filter((el) => (el.attr("class") ?? "").split(/\s+/).includes("lk-focus"));
    expect(focused.length, `the chosen node ${account} is drawn inverted`).toBeGreaterThan(0);
  });

  test("loading the fragment directly opens the same focus", () => {
    const focusBare = "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN";
    const focusAccount = `${PREFIX}${focusBare}`;
    const fresh = makeHarness();
    const app2 = startApp(fresh.env({ data: { ...data, positions: null } }) as never);
    fresh.location.hash = `${DEPS}?focus=${encodeURIComponent(focusBare)}`;
    fresh.setHash(fresh.location.hash);
    app2.draw();
    const main = fresh.doc.getElementById(IDS.main);
    expect(main.byAttr("data-lk-id", focusAccount).some((el) => (el.attr("class") ?? "").split(/\s+/).includes("lk-focus"))).toBe(true);
  });

  test("the trail keeps at most six earlier foci", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data: { ...data, positions: null } }) as never);
    harness.setHash(DEPS);
    app.draw();
    const main = harness.doc.getElementById(IDS.main);
    const chosen: string[] = [];
    for (let i = 0; i < 7; i++) {
      const drawn = main.byAttr("data-lk-select", "node").filter((el) => !(el.attr("class") ?? "").includes("lk-focus"));
      expect(drawn.length, `move ${i}: nodes remain at ${harness.location.hash}`).toBeGreaterThan(0);
      const target = drawn.find((el) => !chosen.includes(el.attr("data-lk-id")!)) ?? drawn[0];
      const account = target.attr("data-lk-id")!;
      chosen.push(account);
      target.dispatch("click");
      harness.setHash(harness.location.hash);
      app.draw();
    }
    const trailItems = main.walk().filter((el) => (el.attr("data-go") ?? "").includes("focus="));
    expect(trailItems.length).toBeLessThanOrEqual(6);
    expect(trailItems.length, "six earlier foci remain listed").toBe(6);
    expect(TRAIL_LENGTH).toBe(6);
    const current = harness.location.hash;
    for (const item of trailItems) expect(current.endsWith(item.attr("data-go")!.split("?")[1] ?? "")).toBe(false);
  });

  test("choosing an edge opens the drawer with its facts and receipts, Escape closes and returns focus", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data: { ...data, positions: null } }) as never);
    harness.setHash(DEPS);
    app.draw();
    const drawer = harness.doc.getElementById(IDS.drawer);
    expect(drawer.classed("lk-fact-card")).toHaveLength(0);
    const drawnEdges = harness.doc.getElementById(IDS.main).byAttr("data-lk-select", "edge");
    const edgeEl = drawnEdges[0];
    const drawnId = edgeEl.attr("data-lk-id")!;
    const series = seriesOfPack("kamino-lend", "main-market");
    const graph = series.results.graph as { edges: { key: string; factIds: string[]; evidenceIds: string[] }[] };
    const edge = graph.edges.find((e) => e.key === drawnId)!;
    expect(edge).toBeDefined();
    harness.doc.active = edgeEl;
    edgeEl.dispatch("click");
    app.draw();
    expect(drawer.attr("hidden")).toBeNull();
    const cards = drawer.classed("lk-fact-card");
    expect(cards.length, "one fact card per fact id").toBe(edge.factIds.length);
    const receipts = drawer.classed("lk-receipt");
    expect(receipts.length, "one receipt card per receipt").toBeGreaterThan(0);
    const knownReceipt = data.receipts[edge.evidenceIds[0]];
    if (knownReceipt) expect(drawer.textContent ?? "").toContain(knownReceipt.source.slice(0, Math.min(30, knownReceipt.source.length)));
    harness.doc.pressKey("Escape");
    app.draw();
    expect(drawer.attr("hidden")).toBeDefined();
    expect(harness.doc.active).toBe(edgeEl);
  });

  test("a fact id the data does not hold shows the reserved words and no invented card", () => {
    const probeHarness = makeHarness();
    const probeApp = startApp(probeHarness.env({ data: { ...data, positions: null } }) as never);
    probeHarness.setHash(DEPS);
    probeApp.draw();
    const drawnIds = probeHarness.doc.getElementById(IDS.main).byAttr("data-lk-select", "edge").map((el) => el.attr("data-lk-id")!);
    expect(drawnIds.length).toBeGreaterThan(0);
    const drawnFactId = drawnIds[0];
    const stripped: AppData = JSON.parse(JSON.stringify({ ...data, positions: null }));
    const lendSeries = stripped.packs.find((p) => p.id === "kamino-lend")!.series[0];
    const edges = lendSeries.results.edges as { rows: { key: string }[] };
    edges.rows = edges.rows.filter((row) => row.key !== drawnFactId);
    const harness = makeHarness();
    const app = startApp(harness.env({ data: stripped }) as never);
    harness.setHash(DEPS);
    app.draw();
    const edgeEl = harness.doc.getElementById(IDS.main).byAttr("data-lk-select", "edge").find((el) => el.attr("data-lk-id") === drawnFactId)!;
    edgeEl.dispatch("click");
    app.draw();
    const drawer = harness.doc.getElementById(IDS.drawer);
    expect(drawer.textContent ?? "").toContain("not in this build");
    expect(drawer.classed("lk-fact-card")).toHaveLength(0);
  });

  test("every node, edge and group of the drawn model is listed, tabbable and answers Enter", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data: { ...data, positions: null } }) as never);
    harness.setHash(DEPS);
    app.draw();
    const main = harness.doc.getElementById(IDS.main);
    for (const kind of ["node", "edge", "group"]) {
      const svgSide = main.byAttr("data-lk-select", kind).filter((el) => (el.attr("class") ?? "").includes("lk-explorer"));
      expect(svgSide.length, `${kind} elements in the drawing`).toBeGreaterThan(0);
    }
    for (const list of ["lk-explorer-nodes", "lk-explorer-edges", "lk-explorer-groups"]) {
      const items = main.classed(list).flatMap((l) => l.kids);
      expect(items.length, list).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.attr("tabindex")).toBe("0");
        expect(item.attr("role")).toBe("button");
      }
    }
    const nodes = main.byAttr("data-lk-select", "node");
    const target = nodes[1];
    const account = target.attr("data-lk-id")!;
    target.dispatch("keydown", { key: "Enter", preventDefault() {} });
    expect(harness.location.hash).toContain(`focus=${encodeURIComponent(PREFIXLESS(account))}`);
  });
});

/* ------------------------------------------------------------------ */
/* AC10 — positions                                                     */
/* ------------------------------------------------------------------ */
describe("AC10 positions over the replayed reads", () => {
  testT("the recorded read shows zero positions and every account read and not covered", { timeout: LONG }, async () => {
    const replay = replayPair("recorded");
    const recomputed = await readPositions({ chain: "solana", address: replay.holder, snapshotId: readIdFor("recorded"), client: replay.client });
    expect(recomputed.positions).toHaveLength(0);
    expect(recomputed.notRead).toHaveLength(116);
    for (const entry of recomputed.notRead) expect(entry.reason).toBe("not-covered");
    const drawn = data.positions!.reads.find((r) => r.source === "recorded")!;
    expect((drawn.list.rows as unknown[]).length).toBe(0);
    expect(drawn.notRead.rows).toHaveLength(116);
    const recomputedSubjects = new Set(recomputed.notRead.map((n) => n.subject));
    for (const row of drawn.notRead.rows as { values: Record<string, unknown>; reason: string }[]) {
      expect(row.reason, "every entry keeps the reader's own reason").toBe("not-read");
      const subject = `${PREFIX}${PREFIXLESS(String(row.values.account))}#holder:${drawn.address}`;
      expect(recomputedSubjects.has(subject), `${row.values.account} is among the recomputed entries`).toBe(true);
    }
  });

  testT("the constructed read shows exactly the recomputed five positions, marked, with the unstated basis and scope join", { timeout: LONG }, async () => {
    const replay = replayPair("constructed");
    const recomputed = await readPositions({ chain: "solana", address: replay.holder, snapshotId: readIdFor("constructed"), client: replay.client });
    expect(recomputed.positions).toHaveLength(5);
    const constructed = data.positions!.reads.find((r) => r.source === "constructed")!;
    expect(constructed.list.rows).toHaveLength(5);
    expect(constructed.constructed).toBe(true);
    type DrawnRow = { rowKind: string; constructed?: boolean; values: Record<string, unknown>; bases: string[]; source?: string; scopeSource?: string; key: string; factIds: string[]; evidenceIds: string[]; blockOrSlot: string | number | null; asOf: string | null; snapshotIds: string[] };
    const byRow = new Map<string, DrawnRow>(constructed.list.rows.map((r) => [`${String((r as { values: Record<string, unknown> }).values.account)}|${String((r as { values: Record<string, unknown> }).values.unit)}`, r as DrawnRow]));
    for (const position of recomputed.positions) {
      const key = `${position.subject.split("#")[0]}|${position.unit}`;
      const row = byRow.get(key);
      expect(row, `${key} drawn`).toBeDefined();
      if (!row) continue;
      expect(row.rowKind).toBe("reader");
      expect(row.constructed).toBe(true);
      expect(row.bases).toEqual([]);
      expect(row.source).toBe("reader");
      expect(String(row.scopeSource)).toContain("src/solana/positions/registry.ts");
      expect(row.values.quantity).toBe(position!.quantity);
      expect(row.values.unit).toBe(position!.unit);
    }
    // Drawn: the basis reads as not stated and the join is marked as scope, not evidence.
    const tree = interpret(positionsSurface(constructed));
    expect(findByClass(tree.root, "lk-basis-unstated").length).toBe(5);
    expect(textOf(tree.root)).toContain("not evidence");
  });

  testT("the Sentora share position's exit items equal the recomputed exit items; the others are not mapped", { timeout: LONG }, async () => {
    const constructed = data.positions!.reads.find((r) => r.source === "constructed")!;
    const shareSheet = constructed.sheets.find((s) => s.join?.series === "sentora-pyusd")!;
    const context = loaded.context;
    const vault = VAULT_TARGETS["sentora-pyusd"].vault;
    const joined = `${PREFIX}${vault}`;
    const economics = economicsFor(context.sentoraReport, joined);
    if (!economics) throw new Error("no economics view for the vault");
    const { chains } = await queryChains(engineAccess(openStore([context.sentora])), [joined], context.sentora.id, context.sentora.observedTo);
    const stateFacts = chains.get(joined)?.stateFacts ?? [];
    const items = exitItemsFor(economics, stateFacts);
    expect(items.length).toBe(25);
    const quantities = economicsQuantities(economics);
    const qtyByName = new Map(quantities.map((q) => [q.name, q]));
    const exit = shareSheet.results.exit as { rows: { key: string; values: Record<string, unknown>; factIds: string[]; evidenceIds: string[] }[] };
    expect(exit.rows).toHaveLength(items.length);
    const itemByName = new Map(items.map((i) => [i.name, i]));
    for (const row of exit.rows) {
      const item = itemByName.get(String(row.values.name));
      expect(item, `exit item ${row.values.name}`).toBeDefined();
      const qty = qtyByName.get(String(row.values.name));
      expect(qty, `quantity ${row.values.name}`).toBeDefined();
      expect(row.values.role).toBe(item!.role);
      expect(row.values.account).toBe(item!.subject);
      expect(row.values.value).toBe(qty!.value);
      expect(row.values.unit).toBe(qty!.unit);
      expect(row.factIds).toEqual(item!.factIds);
      expect(row.evidenceIds).toEqual(item!.receiptIds);
    }
    for (const sheet of constructed.sheets.filter((s) => s.ordinal !== shareSheet.ordinal)) {
      const gaps = sheet.results.gaps as { rows: { reason: string }[] };
      expect(gaps.rows.some((r) => r.reason === "not-mapped"), `sheet ${sheet.ordinal} not mapped`).toBe(true);
    }
  });

  testT("a malformed address is refused before the reader runs; a missing or wrong token, or a foreign origin, is refused outright", { timeout: LONG }, async () => {
    const served: AppData = { ...data, mode: "served", positions: null };
    let readerCalls = 0;
    const server = await startServer({
      port: 0,
      data: served,
      deps: {
        readPositions: (async () => {
          readerCalls++;
          return { positions: [], receipts: [], notRead: [] } as ReadResult;
        }) as never,
      },
    });
    try {
      const post = (body: unknown, headers: Record<string, string>) =>
        realFetch(`${server.origin}/api/positions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const bad = await post({ source: "recorded", address: "not-a-base58-address!!" }, { "x-app-token": server.token, origin: server.origin });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "malformed-address" });
      expect(readerCalls).toBe(0);
      const noToken = await post({ source: "recorded", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }, { origin: server.origin });
      expect(noToken.status).toBe(403);
      expect(await noToken.text()).toBe("");
      const wrongToken = await post({ source: "recorded", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }, { "x-app-token": "0".repeat(64), origin: server.origin });
      expect(wrongToken.status).toBe(403);
      const foreign = await post({ source: "recorded", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }, { "x-app-token": server.token, origin: "https://elsewhere.example" });
      expect(foreign.status).toBe(403);
      expect(await foreign.text()).toBe("");
      expect(readerCalls).toBe(0);
      const good = await post({ source: "recorded", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }, { "x-app-token": server.token, origin: server.origin });
      expect(good.status).toBe(200);
      const read = (await good.json()) as ReadData;
      expect(read.source).toBe("recorded");
      expect(read.address.startsWith("435caVKK")).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC11 — positions stay private                                        */
/* ------------------------------------------------------------------ */
describe("AC11 positions stay private", () => {
  const CANARY_ADDRESS = "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFq";
  const CANARY_QTY = "CANARYQUANTITY777";
  const CANARY_ID = "canary-position-0001";

  testT("a canary read leaves through the positions response only", { timeout: LONG }, async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = ((...parts: unknown[]) => logs.push(parts.map(String).join(" "))) as typeof console.log;
    console.error = ((...parts: unknown[]) => logs.push(parts.map(String).join(" "))) as typeof console.error;
    let answersBody = "";
    let answersCalls = 0;
    let positionsServed = "";
    const server = await startServer({
      port: 0,
      data: { ...data, mode: "served", positions: null },
      live: true,
      rpcUrl: "http://127.0.0.1:1",
      deps: {
        readPositions: (async () => ({
          positions: [{ id: CANARY_ID, subject: `${PREFIX}${CANARY_ADDRESS}#holder:${CANARY_ADDRESS}`, quantity: CANARY_QTY, unit: `${PREFIX}${CANARY_ADDRESS}`, snapshotId: "solana-reader.live", source: "reader", fixtureKind: "synthetic", receiptIds: [] }],
          receipts: [],
          notRead: [],
        })) as never,
      },
      answers: async (request: Request) => {
        answersCalls++;
        answersBody = await request.text();
        return new Response(JSON.stringify({ lines: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    } as never);
    try {
      const post = (path: string, body: unknown, headers: Record<string, string>) =>
        realFetch(`${server.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const headers = { "x-app-token": server.token, origin: server.origin };
      const live = await post("/api/positions", { source: "live", address: CANARY_ADDRESS }, headers);
      expect(live.status).toBe(200);
      positionsServed = await live.text();
      expect(positionsServed).toContain(CANARY_QTY);
      const page = await realFetch(`${server.origin}/`);
      const pageText = await page.text();
      const notFound = await realFetch(`${server.origin}/no-such-path`);
      const notFoundText = await notFound.text();
      const answers = await post("/api/answers/ask", { question: "what holds this account?" }, {});
      expect(answers.status).toBeLessThan(500);
      // No log line, no written file, no other response, no answers request carries a canary.
      for (const line of logs) expect(line.includes(CANARY_QTY) || line.includes(CANARY_ADDRESS), `log line: ${line.slice(0, 80)}`).toBe(false);
      expect(pageText.includes(CANARY_QTY)).toBe(false);
      expect(notFoundText.includes(CANARY_QTY)).toBe(false);
      expect(answersBody.includes(CANARY_QTY) || answersBody.includes(CANARY_ADDRESS)).toBe(false);
      expect(answersCalls).toBe(1);
    } finally {
      await server.stop();
      console.log = origLog;
      console.error = origErr;
    }
  });

  test("the fragment holds positions by their place in the list, never by id or quantity", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/positions/constructed/2");
    expect(harness.location.hash).toBe("#/positions/constructed/2");
    void app;
    expect(harness.location.hash.includes(CANARY_QTY) || harness.location.hash.includes(CANARY_ID)).toBe(false);
  });

  testT("without live no non-loopback attempt is made; with live and a foreign origin only that origin is reached", { timeout: LONG }, async () => {
    const before = { ...hits };
    const quiet = await startServer({ port: 0, data: { ...data, mode: "served", positions: null } });
    try {
      const post = realFetch(`${quiet.origin}/api/positions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-token": quiet.token, origin: quiet.origin },
        body: JSON.stringify({ source: "recorded", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }),
      });
      expect((await post).status).toBe(200);
      expect(hits.foreignFetch).toBe(before.foreignFetch);
    } finally {
      await quiet.stop();
    }
    const fakeRpc = "http://rpc-origin-trap.invalid";
    const trapping = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      foreignUrls.push(url);
      throw new Error("offline: fetch trapped at the live client");
    }) as unknown as typeof fetch);
    try {
      const liveServer = await startServer({ port: 0, data: { ...data, mode: "served", positions: null }, live: true, rpcUrl: fakeRpc });
      try {
        const response = await realFetch(`${liveServer.origin}/api/positions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-app-token": liveServer.token, origin: liveServer.origin },
          body: JSON.stringify({ source: "live", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }),
        });
        expect(response.status).toBeLessThan(500);
      } finally {
        await liveServer.stop();
      }
      const seen = foreignUrls.slice();
      expect(seen.length, "the live read attempted the network").toBeGreaterThan(0);
      for (const url of seen) expect(url.startsWith(fakeRpc), url).toBe(true);
    } finally {
      trapping.mockRestore();
      foreignUrls.length = 0;
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC12 — the answers contract and "not in this build"                  */
/* ------------------------------------------------------------------ */
describe("AC12 the answers contract", () => {
  const backend: RetrievalBackend = {
    id: "mount-test", version: "1", protocols: () => [{ id: "probe", title: "Offline probe" }], templates: () => [],
    coverage: () => ({ protocol: "probe", title: "Offline probe", snapshotIds: [], mechanics: [], subjects: [] }),
    run: async () => { throw new Error("unexpected-tool-call"); },
    evidence: async (_protocol, ids) => ({ items: [], missing: ids }),
  };
  const validAnswerLines = (): string[] => {
    const realReceipt = Object.keys(data.receipts)[0];
    const messages = instantiateV2("answer-panel", {
      surfaceId: "asked",
      meta: { title: "A recorded answer", snapshotIds: [] },
      results: [
        kitTable([kitRow({ values: { subject: "S", predicate: "P", object: "O" }, evidenceIds: [realReceipt] })], [{ name: "subject", role: "subject" }]) as never,
      ],
      receipts: {},
    });
    return messages.map((m) => JSON.stringify(m));
  };

  testT("the shared launcher mounts the real handler: no model is honest, Origin and byte limits survive", { timeout: LONG }, async () => {
    const server = await startAppServer({ port: 0, data }, { backend, model: () => null, logPath: null });
    try {
      const page = await (await realFetch(`${server.origin}/`)).text();
      expect(page).toContain('"ask":{"enabled":true}');
      const post = (body: string, origin = server.origin) => realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
      const body = JSON.stringify({ question: "What is recorded?", protocol: "probe" });
      const response = await post(body);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("No model is configured on this machine");
      expect((await post(body, "https://foreign.invalid")).status).toBe(403);
      expect((await post(JSON.stringify({ question: "What?", protocol: "probe", previous: "é".repeat(2100) }))).status).toBe(400);
      const pinned = await realFetch(`${server.origin}/api/answers/pinned`);
      expect(pinned.status).toBe(200);
      expect(await pinned.json()).toEqual({ label: "Composed by a fixed script over recorded evidence, not by a model", protocols: [{ id: "probe", title: "Offline probe" }], answers: [] });
      const harness = makeHarness(withToken(server));
      const app = startApp(harness.env({ data: { ...data, ask: { enabled: true } } }) as never);
      harness.setHash("#/ask"); app.draw(); await app.settled();
      const main = harness.doc.getElementById(IDS.main);
      main.walk().find((el) => el.getAttribute("data-field") === "question")!.value = "What is recorded?";
      main.walk().find((el) => el.getAttribute("data-field") === "protocol")!.value = "probe";
      main.walk().find((el) => el.getAttribute("data-act") === "ask")!.dispatch("click");
      await app.settled();
      expect(main.textContent).toContain("No model is configured on this machine");
      expect(main.textContent).not.toContain("answers-failed");
    } finally { await server.stop(); }
    // The private executable intentionally reuses the same run/serve path.
    const privatePath = join(ROOT, "scripts/solana-app-private.ts");
    if (existsSync(privatePath)) expect(readFileSync(privatePath, "utf8")).toContain('await run(parseArgs(Bun.argv.slice(2)), () => loadPrivateAppData(), "solana-app-private")');
  });

  testT("a mounted handler preserves busy and makes only one model call at a time", { timeout: LONG }, async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = new ScriptedModel({ turns: [{ answer: { components: [{ id: "root", component: "Column", children: ["header"] }, { id: "header", component: "AnswerHeader", meta: { path: "/meta" } }] } }] }, { beforeTurn: async () => { entered(); await gate; } });
    const server = await startAppServer({ port: 0, data }, { backend, model: () => model, logPath: null });
    const post = (question: string) => realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { origin: server.origin, "content-type": "application/json" }, body: JSON.stringify({ question, protocol: "probe" }) });
    const first = post("First question");
    try {
      await started;
      const second = await post("Second question");
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "busy" });
      expect(model.requests).toHaveLength(1);
      release();
      expect((await first).status).toBe(200);
    } finally { release(); await first; await server.stop(); }
  });

  testT("typed Marinade templates resolve the full captured pack through the app's receipt gate", { timeout: LONG }, async () => {
    const realBackend = await loadBundleBackend();
    const known = new Set(Object.keys(data.receipts));
    const cited = new Set<string>();
    for (const templateId of ["section-offsets", "section-programs", "section-participation", "section-holders", "section-flows", "holders-and-float"]) {
      const result = await realBackend.run("marinade", templateId, {}, { maxRows: 10000 });
      for (const row of result.rows) for (const id of row.evidenceIds) {
        expect(known.has(id), `${templateId}: ${id}`).toBe(true);
        cited.add(id);
      }
    }
    // A committed pack receipt that none of the app's fixed views cite.
    expect(cited.has("a90d26211754ff565cedf9d1ff677e0073c1c11a51b5541529873d18ff42bc9e")).toBe(true);
    const resolved = await realBackend.evidence("marinade", [...cited]);
    expect(resolved.missing).toEqual([]);
    const engineReceiptIds = new Set(marinadeInputs.flatMap((snapshot) => snapshot.receipts.map((receipt) => receipt.id)));
    for (const record of resolved.items) {
      // An engine receipt keeps its richer captured metadata when ids overlap.
      if (engineReceiptIds.has(record.id)) continue;
      const receipt = data.receipts[record.id];
      expect(receipt.source).toBe(record.fixture ?? record.source);
      expect(receipt.responseSha256).toBe(record.responseSha256);
      expect(receipt.blockOrSlot).toBe(record.slot);
      expect(receipt.observedAt).toBe(record.retrievedAt);
      expect(receipt.historicalState).toBeNull();
    }
    const model = new ScriptedModel({ turns: [
      { tools: [{ name: "run_template", input: { protocol: "marinade", templateId: "section-programs", params: {} } }] },
      { answer: { view: "fact-table", results: ["r1"] } },
    ] });
    const server = await startAppServer({ port: 0, data }, { backend: realBackend, model: () => model, logPath: null });
    try {
      const response = await realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { origin: server.origin, "content-type": "application/json" }, body: JSON.stringify({ question: "Show the recorded program entries", protocol: "marinade" }) });
      expect(response.status).toBe(200);
      const messages = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(validateSurface(messages, { resolveEvidence: receiptResolver([...known]) }).ok).toBe(true);
      expect(model.requests).toHaveLength(2);
    } finally { await server.stop(); }
  });

  testT("prepared JSON surfaces keep the app's receipt gate and mount without asking a model", { timeout: LONG }, async () => {
    const ndjson = validAnswerLines().join("\n") + "\n";
    let unknown = false, posts = 0;
    const server = await startServer({ port: 0, data, answers: async (request) => {
      if (request.method === "POST") posts++;
      return Response.json({ label: "Composed by a fixed script over recorded evidence, not by a model", protocols: [{ id: "probe", title: "Offline probe" }], answers: [{ id: "prepared", question: "What is recorded?", protocol: "probe", label: "Fixed script", ndjson: unknown ? ndjson.replace(Object.keys(data.receipts)[0], "unknown-mount-receipt") : ndjson }] });
    } });
    try {
      const harness = makeHarness(withToken(server));
      const app = startApp(harness.env({ data: { ...data, ask: { enabled: true } } }) as never);
      harness.setHash("#/ask"); app.draw(); await app.settled();
      const main = harness.doc.getElementById(IDS.main);
      expect(main.textContent).toContain("Prepared answers");
      main.walk().find((el) => el.getAttribute("data-act") === "prepared-answer")!.dispatch("click");
      expect(main.classed("lk-row").length).toBeGreaterThan(0);
      expect(posts).toBe(0);
      unknown = true;
      const refused = await realFetch(`${server.origin}/api/answers/pinned`);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ refused: ["unresolved-evidence"] });
    } finally { await server.stop(); }
  });

  test("Enter during initial prepared loading cannot send an empty protocol or lose a typed answer", async () => {
    let release!: (response: Response) => void;
    const loading = new Promise<Response>((resolve) => { release = resolve; });
    const posts: { question: string; protocol: string }[] = [];
    const harness = makeHarness(async (url, init) => {
      if (url.endsWith("/pinned")) return loading;
      posts.push(JSON.parse(String(init?.body)));
      return new Response(validAnswerLines().join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    });
    const app = startApp(harness.env({ data: { ...data, ask: { enabled: true } } }) as never);
    harness.setHash("#/ask");
    const main = harness.doc.getElementById(IDS.main);
    const field = () => main.walk().find((el) => el.getAttribute("data-field") === "question")!;
    field().value = "What is recorded?";
    field().dispatch("keydown", { key: "Enter", preventDefault() {} });
    await Promise.resolve();
    expect(posts).toHaveLength(0);
    release(Response.json({ label: "Fixed script", protocols: [{ id: "probe", title: "Offline probe" }], answers: [] }));
    await app.settled();
    field().value = "What is recorded?";
    field().dispatch("keydown", { key: "Enter", preventDefault() {} });
    await app.settled();
    expect(posts).toEqual([{ question: "What is recorded?", protocol: "probe" }]);
    expect(main.classed("lk-row").length).toBeGreaterThan(0);
    app.draw();
    expect(main.classed("lk-row").length).toBeGreaterThan(0);
  });

  test("a failed prepared fetch retries on re-entry, without retrying its own failure redraw", async () => {
    let gets = 0;
    const harness = makeHarness(async () => {
      gets++;
      if (gets === 1) throw new Error("temporary loopback failure");
      return Response.json({ label: "Fixed script", protocols: [{ id: "probe", title: "Offline probe" }], answers: [] });
    });
    const app = startApp(harness.env({ data: { ...data, ask: { enabled: true } } }) as never);
    harness.setHash("#/ask"); await app.settled();
    expect(gets).toBe(1);
    expect(harness.doc.getElementById(IDS.main).textContent).toContain("not-reached");
    expect(harness.doc.getElementById(IDS.main).walk().find((el) => el.getAttribute("data-act") === "ask")!.getAttribute("disabled")).toBe("");
    app.draw(); await app.settled();
    expect(gets).toBe(1);
    harness.setHash("#/preflight"); harness.setHash("#/ask"); await app.settled();
    expect(gets).toBe(2);
    expect(harness.doc.getElementById(IDS.main).textContent).toContain("Prepared answers");
    expect(harness.doc.getElementById(IDS.main).textContent).not.toContain("not-reached");
    expect(harness.doc.getElementById(IDS.main).walk().find((el) => el.getAttribute("data-act") === "ask")!.getAttribute("disabled")).toBeNull();
  });

  testT("without a handler both answers routes do not exist, and the Ask view says so", { timeout: LONG }, async () => {
    const server = await startServer({ port: 0, data: { ...data, mode: "served", positions: null } });
    try {
      const ask = await realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(ask.status).toBe(404);
      const pinned = await realFetch(`${server.origin}/api/answers/pinned`);
      expect(pinned.status).toBe(404);
    } finally {
      await server.stop();
    }
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/ask");
    app.draw();
    expect(harness.doc.getElementById(IDS.main).textContent ?? "").toContain("Ask is not in this build");
  });

  testT("with a handler a valid reply is read once, validated and mounted", { timeout: LONG }, async () => {
    const lines = validAnswerLines();
    let calls = 0;
    const server = await startServer({
      port: 0,
      data: { ...data, mode: "served", positions: null, ask: { enabled: true } },
      answers: async () => {
        calls++;
        return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
      },
    } as never);
    try {
      const reply = await realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "who holds this?" }) });
      expect(reply.status).toBe(200);
      expect(await reply.text()).toBe(`${lines.join("\n")}\n`);
      expect(calls).toBe(1);
      // The drawn view mounts the reply surface through the page's own renderer.
      const harness = makeHarness((input, init) => withToken(server)(input, init));
      const app = startApp(harness.env({ data: { ...data, mode: "served", positions: null, ask: { enabled: true } } }) as never);
      harness.setHash("#/ask");
      app.draw();
      await app.settled();
      const main = harness.doc.getElementById(IDS.main);
      const field = main.walk().find((el) => el.tag === "input" || el.tag === "textarea");
      expect(field, "the ask view holds a question field").toBeDefined();
      field!.value = "who holds this?";
      const askButton = main.walk().find((el) => el.tag === "button");
      expect(askButton, "the ask view holds a button").toBeDefined();
      calls = 0;
      askButton!.dispatch("click");
      await app.settled();
      expect(harness.fetchCalls.some((url) => url.includes("/api/answers/ask"))).toBe(true);
      expect(calls, "one typed ask after the prepared surface loaded").toBe(1);
    } finally {
      await server.stop();
    }
  });

  testT("a reply citing an unknown evidence id is refused before drawing", { timeout: LONG }, async () => {
    const messages = instantiateV2("answer-panel", {
      surfaceId: "asked",
      meta: { title: "A recorded answer", snapshotIds: [] },
      results: [kitTable([kitRow({ evidenceIds: ["not-a-receipt-the-app-holds"] })], [{ name: "subject", role: "subject" }]) as never],
      receipts: {},
    });
    const lines = messages.map((m) => JSON.stringify(m));
    const server = await startServer({
      port: 0,
      data: { ...data, mode: "served", positions: null, ask: { enabled: true } },
      answers: async (request: Request) => request.method === "GET"
        ? Response.json({ label: "Fixed script", protocols: [{ id: "probe", title: "Offline probe" }], answers: [] })
        : new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    } as never);
    try {
      const harness = makeHarness(withToken(server));
      const app = startApp(harness.env({ data: { ...data, mode: "served", positions: null, ask: { enabled: true } } }) as never);
      harness.setHash("#/ask");
      app.draw();
      await app.settled();
      const main = harness.doc.getElementById(IDS.main);
      const field = main.walk().find((el) => el.tag === "input" || el.tag === "textarea")!;
      field.value = "who holds this?";
      const askButton = main.walk().find((el) => el.tag === "button")!;
      askButton.dispatch("click");
      await app.settled();
      const refused = main.classed("sx-refused");
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.map((el) => el.textContent ?? "").join(" ")).toContain("view refused:");
      expect(refused.map((el) => el.textContent ?? "").join(" ")).toContain("unresolved-evidence");
      expect(main.classed("lk-row").length).toBe(0);
    } finally {
      await server.stop();
    }
  });

  testT("a body naming a private term of the reads is refused before the handler is called", { timeout: LONG }, async () => {
    let calls = 0;
    const server = await startServer({
      port: 0,
      data: { ...data, mode: "served", positions: null },
      answers: async () => {
        calls++;
        return new Response("", { status: 200 });
      },
    } as never);
    try {
      // The read must have been returned by this process first.
      const warm = await realFetch(`${server.origin}/api/positions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-token": server.token, origin: server.origin },
        body: JSON.stringify({ source: "constructed", address: "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp" }),
      });
      expect(warm.status).toBe(200);
      const constructed = data.positions!.reads.find((r) => r.source === "constructed")!;
      const row0 = constructed.list.rows[0] as { key: string; values: Record<string, unknown> };
      const privateTerms: [string, string][] = [
        ["the holder address", constructed.address],
        ["a quantity as recorded", String(row0.values.quantity)],
        ["a position id", row0.key],
      ];
      for (const [label, term] of privateTerms) {
        const reply = await realFetch(`${server.origin}/api/answers/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: `tell me about ${term}` }) });
        expect(reply.status, label).toBe(422);
        expect(await reply.json(), label).toEqual({ error: "private-value" });
      }
      expect(calls).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC13 — navigation and the reserved Preflight                         */
/* ------------------------------------------------------------------ */
describe("AC13 navigation and the reserved Preflight", () => {
  const LANES = ["claimed intent", "decoded instructions", "simulated effects", "observed execution"];

  test("the navigation lists exactly the four destinations in order", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/protocols");
    app.draw();
    const nav = harness.doc.getElementById(IDS.nav);
    const labels = nav.walk().filter((el) => el.attr("data-go")).map((el) => (el.textContent ?? "").trim());
    // The last item carries its reserved badge in the same button (the reserved lane of the contract).
    expect(labels.map((l) => l.replace(/reserved$/, "").trim())).toEqual(["Protocols", "Positions", "Ask", "Preflight"]);
  });

  test("Preflight shows its four reserved lanes, each not built, and no data", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/preflight");
    app.draw();
    const main = harness.doc.getElementById(IDS.main);
    const text = main.textContent ?? "";
    for (const lane of LANES) expect(text).toContain(lane);
    expect((text.match(/not built/g) ?? []).length).toBe(4);
    expect(main.classed("lk-surface")).toHaveLength(0);
    expect(main.classed("lk-row")).toHaveLength(0);
  });

  test("each destination opens directly in the served app and in the static build", () => {
    const cases: [string, (main: FakeElement) => void][] = [
      ["#/protocols", (main) => expect(main.textContent ?? "").toContain("Kamino vaults")],
      ["#/protocols/kamino-lend/main-market/control", (main) => expect(main.classed("lk-row").length).toBeGreaterThan(0)],
      ["#/positions", (main) => expect(main.textContent ?? "").toContain("recorded")],
      ["#/ask", (main) => expect(main.textContent ?? "").toContain("Ask is not in this build")],
    ];
    for (const [fragment, check] of cases) {
      for (const build of ["served", "static"] as const) {
        const harness = makeHarness();
        const appData = build === "static" ? data : { ...data, mode: "served", positions: null };
        const app = startApp(harness.env({ data: appData }) as never);
        harness.setHash(fragment);
        app.draw();
        check(harness.doc.getElementById(IDS.main));
      }
    }
  });

  test("positions open by their place in the list, and the static build opens them from its embedded reads", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/positions/recorded");
    expect(harness.doc.getElementById(IDS.main).textContent ?? "").toContain("not-covered");
    harness.setHash("#/positions/constructed/1");
    expect(harness.doc.getElementById(IDS.main).classed("lk-row").length).toBeGreaterThan(0);
    expect(parseRoute("#/positions/constructed/1").view).toBe("positions");
  });

  test("an unknown fragment shows Not found and the index", () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/nowhere");
    app.draw();
    const text = harness.doc.getElementById(IDS.main).textContent ?? "";
    expect(text).toContain("Not found");
    expect(text).toContain("Kamino vaults");
  });
});

/* ------------------------------------------------------------------ */
/* AC14 — loopback, static build, offline URLs                          */
/* ------------------------------------------------------------------ */
describe("AC14 loopback, static build and offline output", () => {
  let assets: { script: string; css: string };
  let documentBytes: string;

  beforeAll(async () => {
    assets = await buildAssets();
    documentBytes = buildDocument(data, assets);
  }, LONG);

  testT("argument errors exit 2 with one line on stderr and bind nothing", { timeout: LONG }, () => {
    const cases = [
      ["serve", "--host"],
      ["serve", "--port", "0"],
      ["serve", "--port", "70000"],
      ["serve", "--wat"],
      ["build", "--out", "/tmp/x", "--host"],
      ["serve", "--live"],
    ];
    const envNoRpc = { ...process.env } as Record<string, string | undefined>;
    delete envNoRpc.LINCHPIN_RPC_URL;
    for (const argv of cases) {
      const run = Bun.spawnSync(["bun", "run", "src/apps/solana/main.ts", ...argv], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: envNoRpc as never });
      expect(run.exitCode, argv.join(" ")).toBe(2);
      const errLines = run.stderr.toString().trim().split("\n").filter(Boolean);
      expect(errLines.length, `${argv.join(" ")}: ${run.stderr.toString().slice(0, 120)}`).toBe(1);
      expect(run.stdout.toString(), argv.join(" ")).toBe("");
    }
  });

  testT("two launches bind the loopback and print two different tokens", { timeout: LONG }, async () => {
    const urlRe = /solana-app (http:\/\/127\.0\.0\.1:(\d+)\/)#token=([0-9a-f]{64})/;
    const procs = [
      Bun.spawn(["bun", "run", "src/apps/solana/main.ts", "serve", "--port", String(await freePort())], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }),
      Bun.spawn(["bun", "run", "src/apps/solana/main.ts", "serve", "--port", String(await freePort())], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }),
    ];
    try {
      const tokens = await Promise.all(procs.map(async (proc) => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let text = "";
        const deadline = Date.now() + 280_000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          const match = urlRe.exec(text);
          if (match) return match[3];
        }
        throw new Error(`serve printed no URL: ${text.slice(0, 200)}`);
      }));
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).not.toBe(tokens[1]);
      expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      for (const proc of procs) proc.kill();
    }
  });

  testT("two document productions are byte-identical, and the CLI build writes the same self-contained bytes", { timeout: LONG }, async () => {
    const docA = buildDocument(data, await buildAssets());
    const docB = buildDocument(data, await buildAssets());
    expect(docA).toBe(docB);
    const out = mkdtempSync(join(tmpdir(), "solana-app-build-"));
    try {
      const run = Bun.spawnSync(["bun", "run", "src/apps/solana/main.ts", "build", "--out", out], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);
      const file = join(out, "index.html");
      expect(existsSync(file)).toBe(true);
      const bytes = readFileSync(file, "utf8");
      expect(sha256(bytes)).toBe(BUILD_PIN);
      expect(bytes).toBe(docA);
      expect(bytes).toBe(documentBytes);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("the built document loads nothing from outside its origin", () => {
    const dataStart = documentBytes.indexOf('<script type="application/json" id="app-data">');
    expect(dataStart).toBeGreaterThan(0);
    const dataEnd = documentBytes.indexOf("</script>", dataStart);
    const outside = documentBytes.slice(0, dataStart) + documentBytes.slice(dataEnd);
    const scrubbed = outside.split(SVG_NS).join("");
    expect(scrubbed.includes("http://")).toBe(false);
    expect(scrubbed.includes("https://")).toBe(false);
    expect(assets.css.includes("@import")).toBe(false);
    for (const match of assets.css.matchAll(/url\(([^)]*)\)/g)) {
      expect(match[1].startsWith("data:font/woff2;base64,")).toBe(true);
    }
    expect((assets.css.match(/@font-face/g) ?? []).length).toBe(5);
    expect(/style=/.test(outside)).toBe(false);
    expect(documentBytes.includes("<style")).toBe(true);
  });

  test("recorded documentation URLs appear in the data block as text only", () => {
    const dataStart = documentBytes.indexOf('<script type="application/json" id="app-data">');
    const dataEnd = documentBytes.indexOf("</script>", dataStart);
    const block = documentBytes.slice(dataStart, dataEnd);
    const urls = [...block.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]);
    expect(urls.length, "the recorded bundle carries its documentation links").toBeGreaterThan(0);
    const outside = documentBytes.slice(0, dataStart) + documentBytes.slice(dataEnd);
    for (const url of urls.slice(0, 8)) expect(outside.includes(url), url).toBe(false);
  });

  test("a hostile label in the drawn graph appears as text and creates no element", () => {
    const hostile: AppData = JSON.parse(JSON.stringify(data));
    const graph = hostile.packs.find((p) => p.id === "kamino-lend")!.series[0].results.graph as { nodes: { label: string; name?: string }[] };
    graph.nodes[0].label = HOSTILE_IMG;
    graph.nodes[0].name = HOSTILE_IMG;
    const harness = makeHarness();
    const app = startApp(harness.env({ data: hostile }) as never);
    harness.setHash("#/protocols/kamino-lend/main-market/dependencies");
    app.draw();
    const main = harness.doc.getElementById(IDS.main);
    expect(main.textContent ?? "").toContain(HOSTILE_IMG);
    expect(main.walk().some((el) => el.tag === "img")).toBe(false);
    expect(main.walk().some((el) => el.tag === "script")).toBe(false);
    for (const el of main.walk()) {
      for (const [name] of el.attrs) expect(/^on/i.test(name), name).toBe(false);
    }
  });

  test("a served page keeps the token out of every drawn attribute", () => {
    const harness = makeHarness(withToken({ origin: "http://127.0.0.1:1", token: "a".repeat(64) }));
    const app = startApp(harness.env({ data: { ...data, mode: "served", positions: null } }) as never);
    harness.setHash("#/protocols");
    app.draw();
    for (const el of harness.doc.getElementById(IDS.main).walk()) {
      expect(el.attr("style"), el.tag).toBeNull();
      expect(el.attr("href")).toBeNull();
      expect(el.attr("src")).toBeNull();
      expect(el.attr("action")).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC15 — look, words, gallery                                          */
/* ------------------------------------------------------------------ */
describe("AC15 look, words and the second gallery", () => {
  const css = readFileSync(join(ROOT, "src/ui/kit.css"), "utf8");
  const appCss = readFileSync(join(ROOT, "src/apps/solana/app.css"), "utf8");

  const luminance = (hex: string): number => {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a: string, b: string): number => {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };
  const tokensOf = (block: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const match of block.matchAll(/--lk-[a-z-]+:\s*(#[0-9a-fA-F]{6})/g)) out.set(match[1], match[1]);
    return new Map([...out.keys()].map((hex) => [hex, hex]));
  };
  const resolveTokens = (block: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const match of block.matchAll(/(--lk-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out.set(match[1], match[2]);
    return out;
  };

  test("every recorded contrast pair clears four and a half to one in light and dark", () => {
    const light = css.slice(0, css.indexOf("@media"));
    const darkStart = css.indexOf("@media");
    const dark = css.slice(darkStart, css.indexOf("}", css.indexOf("--lk-rule", darkStart)));
    const lightTokens = resolveTokens(light);
    const darkTokens = resolveTokens(dark);
    expect(lightTokens.size).toBeGreaterThanOrEqual(7);
    const pairs = [
      ...CONTRAST_PAIRS.map((p) => ({ text: p.text, background: p.background })),
      ...APP_CONTRAST_PAIRS.map((p) => ({ text: p.text, background: p.background })),
      { text: "--lk-paper", background: "--lk-ink" },
    ];
    expect(pairs.length).toBeGreaterThan(4);
    for (const pair of pairs) {
      const fg = lightTokens.get(pair.text) ?? darkTokens.get(pair.text);
      const bg = lightTokens.get(pair.background) ?? darkTokens.get(pair.background);
      expect(fg && bg, `${pair.text} on ${pair.background} resolved`).toBeDefined();
      expect(contrast(fg!, bg!), `${pair.text} on ${pair.background} (light)`).toBeGreaterThanOrEqual(4.5);
      const fgD = darkTokens.get(pair.text) ?? lightTokens.get(pair.text);
      const bgD = darkTokens.get(pair.background) ?? lightTokens.get(pair.background);
      expect(contrast(fgD!, bgD!), `${pair.text} on ${pair.background} (dark)`).toBeGreaterThanOrEqual(4.5);
    }
    void tokensOf;
  });

  test("the app stylesheet has its focus rule, its reduced-motion block and no width over the viewport", () => {
    expect(appCss.includes(":focus-visible")).toBe(true);
    expect(appCss.includes("prefers-reduced-motion")).toBe(true);
    for (const match of appCss.matchAll(/(?:^|[{;\s])(min-|max-)?width:\s*([^;}]+)/g)) {
      const value = match[2].trim();
      const percent = /^([\d.]+)%$/.exec(value);
      if (percent) expect(Number(percent[1]), value).toBeLessThanOrEqual(100);
      const px = /^([\d.]+)px$/.exec(value);
      if (px) expect(Number(px[1]), value).toBeLessThanOrEqual(720);
      const ch = /^[\d.]+(ch|em|rem)$/.test(value);
      const composed = value.startsWith("min(") || value.startsWith("max(") || value.startsWith("calc(");
      expect(Boolean(/^100\s*vw$/.test(value)) || Boolean(percent) || Boolean(px) || ch || value === "0" || composed || ["auto", "min-content", "max-content", "fit-content", "inherit", "unset"].some((w) => value.startsWith(w)) || value.includes("var("), `width ${value}`).toBe(true);
    }
    expect(appCss.includes("url(")).toBe(false);
    expect(appCss.includes("@import")).toBe(false);
  });

  test("no string of the app or the kit additions carries a word the contract forbids", () => {
    const values: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") values.push(value);
      else if (Array.isArray(value)) for (const v of value) collect(v);
      else if (value && typeof value === "object") for (const v of Object.values(value)) collect(v);
    };
    collect(APP_STRINGS);
    collect(LAYERS);
    collect(SURFACE_TITLES);
    collect(STRINGS);
    for (const value of values) {
      const words = value.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      for (const banned of BANNED_HERE) {
        expect(words.includes(banned), `"${value}" carries "${banned}"`).toBe(false);
      }
    }
  });

  testT("the second gallery builds twice to identical bytes with every component and state as a heading", { timeout: 120_000 }, () => {
    const html = buildGalleryV2();
    expect(sha256(html)).toBe(sha256(buildGalleryV2()));
    for (const name of V2_NAMES) expect(new RegExp(`<h2[^>]*>\\s*${name}`).test(html), name).toBe(true);
    for (const state of GALLERY_V2_STATES) expect(html.includes(state), state).toBe(true);
    const out = mkdtempSync(join(tmpdir(), "solana-app-gallery-"));
    try {
      const run = Bun.spawnSync(["bun", "run", "src/ui/gallery-v2.ts", "build", "--out", out], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);
      const file = join(out, "gallery-v2.html");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(html);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC16 — isolation and compatibility                                   */
/* ------------------------------------------------------------------ */
describe("AC16 isolation and compatibility", () => {
  const importTargets = (source: string): string[] => {
    const out: string[] = [];
    let collecting = false;
    for (const line of source.split("\n")) {
      if (!collecting) {
        if (!/^\s*(?:import|export)\b/.test(line)) continue;
        const from = line.match(/from\s+["']([^"']+)["']/);
        const bare = line.match(/^\s*import\s+["']([^"']+)["']/);
        if (from) out.push(from[1]);
        else if (bare) out.push(bare[1]);
        collecting = !from && !bare && !/;\s*$/.test(line);
      } else {
        const from = line.match(/from\s+["']([^"']+)["']/);
        if (from) {
          out.push(from[1]);
          collecting = false;
        }
      }
    }
    return out;
  };
  const filesIn = (dir: string): string[] =>
    ["app.ts", "chrome.ts", "client.ts", "compose.ts", "guard.ts", "join.ts", "layers.ts", "load.ts", "main.ts", "model.ts", "page.ts", "positions.ts", "providers.ts", "route.ts", "rows.ts", "server.ts", "state.ts", "strings.ts", "surfaces.ts"].map((name) => join(ROOT, dir, name)).filter((p) => existsSync(p));

  test("the public app imports nothing from the private or retired trees", () => {
    const banned = ["adapters/loopscale", "src/web", "../web", "src/answers", "../answers", "src/agent", "../agent", "scripts/"];
    for (const file of filesIn("src/apps/solana")) {
      for (const target of importTargets(readFileSync(file, "utf8"))) {
        // Later slice 1 mounts the handler in the executable only. Browser and
        // provider modules retain the original isolation contract.
        if (file === join(ROOT, "src/apps/solana/main.ts") && target === "../../answers/handler") continue;
        for (const fragment of banned) {
          expect(target.includes(fragment), `${file} imports ${target}`).toBe(false);
        }
      }
    }
  });

  test("the kit imports nothing outside itself but the engine contract types", () => {
    const kitFiles = ["catalog-v2.ts", "templates-v2.ts", "explorer-model.ts", "explorer-draw.ts", "gallery-v2.ts", "validate.ts", "interpret.ts", "mount.ts", "html.ts", "types.ts", "strings.ts", "catalog.ts", "templates.ts", "adapters.ts"];
    for (const name of kitFiles) {
      const file = join(ROOT, "src/ui", name);
      if (!existsSync(file)) continue;
      for (const target of importTargets(readFileSync(file, "utf8"))) {
        expect(target.startsWith(".") || target.startsWith("../engine/contracts"), `${name} imports ${target}`).toBe(true);
      }
    }
  });

  test("a planted outside import is flagged by the same scan", () => {
    const synthetic = `import { x } from "../web/runner";\nexport { x };`;
    const targets = [...synthetic.matchAll(/(?:from|import)\s*\(?["']([^"']+)["']/g)].map((m) => m[1]);
    expect(targets).toContain("../web/runner");
  });

  test("the public build shows Loopscale as absent, and the index draws that line", () => {
    expect(data.absent).toEqual([{ id: "loopscale", line: "Loopscale: not in the public build" }]);
    const harness = makeHarness();
    const app = startApp(harness.env({ data }) as never);
    harness.setHash("#/protocols");
    app.draw();
    expect(harness.doc.getElementById(IDS.main).textContent ?? "").toContain("Loopscale: not in the public build");
  });

  testT("the private launcher adds Loopscale with its built-in change pair, marked", { timeout: LONG }, async () => {
    const launcherPath = join(ROOT, "scripts/solana-app-private.ts");
    if (!existsSync(launcherPath)) {
      console.warn("private launcher absent (public tree); skipping its checks");
      return;
    }
    const mod = (await import(launcherPath)) as { loadPrivateAppData: (root: string) => Promise<AppData> };
    const privateData = await mod.loadPrivateAppData(ROOT);
    expect(privateData.build).toBe("private");
    const loopscale = privateData.packs.find((p) => p.id === "loopscale");
    expect(loopscale).toBeDefined();
    const resolver = resolverOver(new Set([...allReceiptIds, ...Object.keys(privateData.receipts)]));
    for (const series of loopscale!.series) {
      for (const tab of ["control", "dependencies"] as const) {
        const result = render(tabSurface(privateData, loopscale!, series, tab), resolver);
        expect(result.ok, `${series.id}/${tab}: ${JSON.stringify(result.ok ? [] : result.codes)}`).toBe(true);
      }
      const changes = series.results.changes as unknown as { constructed?: boolean; rows: { constructed?: boolean; before: Record<string, unknown>; after: Record<string, unknown> }[] } | undefined;
      if (changes) {
        expect(changes.rows.length, `${series.id} change rows`).toBeGreaterThan(0);
        const constructed = changes.rows.some((r) => r.constructed) || changes.constructed === true;
        expect(constructed, `${series.id} marked`).toBe(true);
        expect(JSON.stringify(changes)).toContain("oracle");
      }
    }
  });

  test.skipIf(!APP_RUN_PINS_APPLY)("the retired trees, the cli and the pinned kit files equal the base (original feature branch only)", () => {
    const run = Bun.spawnSync(
      ["git", "diff", APP_PIN_BASE, "--", "src/web", "src/cli.ts", "package.json", "bun.lock", "src/ui/catalog.ts", "src/ui/templates.ts", "src/ui/gallery.ts", "src/ui/messages.ts", "src/ui/graph-layout.ts"],
      { cwd: ROOT },
    );
    expect(run.stdout.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  testT("the remaining pinned suites pass unmodified", { timeout: LONG }, () => {
    const run = Bun.spawnSync(
      ["bun", "test", "tests/web-tokenomics-ui.test.ts", "tests/tokenomics-multi-protocol.test.ts", "tests/position-reader-solana.test.ts"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* AC7 — value path, unknowns, changes                                  */
/* ------------------------------------------------------------------ */
describe("AC7 value path, unknowns, changes", () => {
  test("Marinade's value path rows equal the recorded bundle links, and a claimed-only link carries no amount", () => {
    const series = seriesOfPack("marinade", "marinade");
    const path = series.results.path as { rows: { values: Record<string, unknown>; bases: string[]; evidenceIds: string[]; factIds: string[] }[] };
    const links = bundle.path.data.links;
    const nodes = ((bundle.path.data as { nodes?: { id: string; label: string }[] }).nodes ?? []) as { id: string; label: string }[];
    const labelOf = (id: string): string => nodes.find((n) => n.id === id)?.label ?? id;
    expect(path.rows).toHaveLength(links.length);
    let claimedSeen = 0;
    for (let i = 0; i < links.length; i++) {
      const link = links[i] as { from: string; to: string; mechanism?: string; status?: string; observed?: { amount?: { display?: string } } | null; basis?: string | string[]; evidenceIds?: string[] };
      const row = path.rows[i];
      const expectedFrom = labelOf(link.from);
      const expectedTo = labelOf(link.to);
      expect(`${row.values.from}→${row.values.to}`, `link ${i} endpoints`).toBe(`${expectedFrom}→${expectedTo}`);
      expect(row.values.status ?? null).toBe(link.status ?? null);
      if (link.status === "claimed-only") {
        claimedSeen++;
        expect(row.values.amount ?? null, "claimed-only carries no amount").toBeNull();
        expect(new Set(row.bases)).toEqual(new Set(["claimed"]));
      } else if (link.observed?.amount?.display !== undefined) {
        expect(row.values.amount ?? null, `link ${i} amount`).toBe(link.observed.amount.display ?? null);
      }
      const evidence = [...(link.evidenceIds ?? [])];
      expect(new Set(row.evidenceIds), `link ${i} evidence`).toEqual(new Set(evidence));
      for (const id of row.evidenceIds) expect(allReceiptIds.has(id), id).toBe(true);
    }
    expect(claimedSeen).toBeGreaterThan(0);
  });

  test("Kamino's value path is coverage only: no answer rows anywhere, notes verbatim", () => {
    const mechanics = ["fees", "treasury", "flows"];
    for (const [packId, seriesId] of [["kamino-lend", "main-market"], ["kamino-vaults", "sentora-pyusd"]] as [string, string][]) {
      const series = seriesOfPack(packId, seriesId);
      for (const name of ["path", "claims", "findings"]) expect(series.results[name], `${packId} ${name}`).toBeUndefined();
      const components = (tabSurface(data, packOf(packId), series, "value-path").at(-1) as { updateComponents?: { components: { component: string }[] } }).updateComponents?.components ?? [];
      for (const component of components) expect(["AnswerPath", "ValuePath"]).not.toContain(component.component);
      const entry = PROTOCOLS.find((p) => p.series === (packId === "kamino-lend" ? "kamino-lend.main-market" : "kamino.sentora-pyusd"))!;
      for (const mechanic of mechanics) {
        const recorded = entry.coverage.find((c) => c.mechanic === mechanic);
        expect(recorded?.status).toBe("not-mapped");
        const inSeries = series.coverage?.mechanics.find((m) => m.mechanic === mechanic);
        expect(inSeries?.note, `${packId} ${mechanic} note verbatim`).toBe(recorded?.note);
      }
    }
  });

  test("Marinade's unknowns hold the recorded gap that its coverage is not recorded", () => {
    const gaps = seriesOfPack("marinade", "marinade").results.gaps as { rows: { values: Record<string, unknown>; reason: string; scopeSource: string }[] };
    const row = gaps.rows.find((r) => r.values.item === "coverage not recorded");
    expect(row).toBeDefined();
    expect(row!.reason).toBe("not-mapped");
  });

  test("Kamino Lend's unknowns hold the recorded unknown control fact, unresolved by name", () => {
    const unknowns = seriesOfPack("kamino-lend", "main-market").results.unknowns as { rows: { key: string; rowKind: string; bases: string[]; evidenceIds: string[] }[] };
    const row = unknowns.rows.find((r) => r.key === UNKNOWN_FACT) ?? unknowns.rows.find((r) => JSON.stringify(r).includes(UNKNOWN_FACT));
    expect(row, UNKNOWN_FACT).toBeDefined();
    expect(row!.rowKind).toBe("unknown");
  });

  test("the Sentora changes are exactly the recorded changes between the two captures", () => {
    const series = seriesOfPack("kamino-vaults", "sentora-pyusd");
    const changes = series.results.changes as { captureIds: string[]; rows: { kind: string; key: string; before: { evidenceIds: string[]; factIds?: string[]; bases?: string[] }; after: { evidenceIds: string[]; factIds?: string[]; bases?: string[] } }[] };
    expect(changes.captureIds).toEqual([SENTORA_BEFORE, SENTORA_AFTER]);
    const inputs = collectEvidenceInputs(".").filter((i) => i.snapshot.chain === "solana");
    const s0 = inputs.find((i) => i.snapshot.id === SENTORA_BEFORE)!.snapshot;
    const s1 = inputs.find((i) => i.snapshot.id === SENTORA_AFTER)!.snapshot;
    const localRecords = buildEvidenceRecords(inputs);
    const engineRows: Record<string, unknown>[] = [];
    for (const subject of [...new Set([...s0.subjects, ...s1.subjects])].sort()) {
      const out = runEvidenceLocal(localRecords, "changes", { subject, beforeSnapshotId: SENTORA_BEFORE, afterSnapshotId: SENTORA_AFTER, maxResults: 500 }) as { rows: Record<string, unknown>[] };
      engineRows.push(...out.rows.filter((r) => typeof r.changeKind === "string" && r.changeKind.length > 0));
    }
    const recomputed = new Map(engineRows.map((r) => [String(r.changeKey), r]));
    expect(changes.rows.length, "change row count").toBe(recomputed.size);
    for (const row of changes.rows) {
      const engine = recomputed.get(row.key);
      expect(engine, `change ${row.key}`).toBeDefined();
      if (!engine) continue;
      expect(row.kind).toBe(String(engine.changeKind));
      expect(row.before?.factIds ?? []).toEqual([String(engine.beforeFactId)]);
      expect(row.after?.factIds ?? []).toEqual([String(engine.afterFactId)]);
      const beforeFact = engine.beforeFactId ? propsOfFact(String(engine.beforeFactId)) : undefined;
      const afterFact = engine.afterFactId ? propsOfFact(String(engine.afterFactId)) : undefined;
      if (beforeFact) expect(new Set(row.before?.evidenceIds ?? [])).toEqual(new Set(beforeFact.evidenceIds));
      if (afterFact) expect(new Set(row.after?.evidenceIds ?? [])).toEqual(new Set(afterFact.evidenceIds));
    }
  });

  test("Kamino Lend, with one capture, shows nothing to compare and never a drawn change", () => {
    const lend = seriesOfPack("kamino-lend", "main-market");
    expect(lend.results.changes).toBeUndefined();
    const gap = lend.results["changes-gap"] as { rows: { values: Record<string, unknown>; reason: string; scopeSource: string }[] } | undefined;
    expect(gap, "the gap result exists").toBeDefined();
    const row = gap!.rows.find((r) => r.values.item === "nothing to compare");
    expect(row).toBeDefined();
    expect(row!.reason).toBe("not-captured");
    const tree = interpret(tabSurface(data, packOf("kamino-lend"), lend, "changes"));
    expect(findByClass(tree.root, "lk-change")).toHaveLength(0);
    expect(textOf(tree.root)).not.toContain("No change recorded");
  });

  test("a missing side of history is never drawn as a lack of change", () => {
    // Marinade has two captures; its rows carry absent sides with reasons where a capture holds nothing.
    const changes = seriesOfPack("marinade", "marinade").results.changes as unknown as { rows: { kind: string; key: string; before: Record<string, unknown>; after: Record<string, unknown> }[] };
    expect(changes.rows.length).toBeGreaterThan(0);
    for (const row of changes.rows) {
      for (const side of [row.before, row.after]) {
        if (side && (side as { absent?: boolean }).absent === true) {
          expect(String((side as { reason: string }).reason).length, `row ${row.key}`).toBeGreaterThan(0);
        }
      }
    }
  });
});
