/**
 * Acceptance tests for the shared UI kit (catalog, renderer, validator, templates,
 * adapters, graph layout, stylesheet, gallery). Independent of implementation bodies:
 * every expected value comes from the approved specification, the plan's public
 * contract section and the recorded decisions -- never from what the code prints.
 *
 * Everything runs offline: fetch, WebSocket, Bun.connect and node:net are trapped
 * for the whole file, and the hit count must be zero at the end.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import * as netNamespace from "node:net";
import netDefault from "node:net";

import { CATALOG, catalogJson } from "../src/ui/catalog";
import { STRINGS, CLASSES, ADVICE_WORDS, TEXT_RULE_WORDS, RATING_WORDS, CONTRAST_PAIRS } from "../src/ui/strings";
import {
  A2UI_VERSION, createSurface, updateDataModel, updateComponents, deleteSurface, pointerGet,
} from "../src/ui/messages";
import { validateSurface, receiptResolver } from "../src/ui/validate";
import { interpret } from "../src/ui/interpret";
import { treeToHtml, escapeHtml } from "../src/ui/html";
import { mount } from "../src/ui/mount";
import { standalonePage, KIT_CSS } from "../src/ui/page";
import { VIEW_TEMPLATES, listViewTemplates, instantiate } from "../src/ui/templates";
import { factsToResult, graphResult } from "../src/ui/adapters";
import { layoutGraph, MAX_GRAPH_NODES } from "../src/ui/graph-layout";
import { buildGallery, GALLERY_STATES } from "../src/ui/gallery";
import { UiRejected } from "../src/ui/types";
import type {
  A2uiComponent, A2uiMessage, GraphResult, ResultSet,
  ResultRow, SurfaceMeta, UiNode,
} from "../src/ui/types";
import type { Fact, EvidenceReceipt } from "../src/engine/contracts";
import { BANNED_WORDS } from "../src/engine/render";
import { buildNearSnapshot } from "../src/near/reader/index";
import type { EvidenceSnapshot } from "../src/engine/queries/index";
import galleryData from "../src/ui/gallery-data.json";

const REPO_ROOT = join(import.meta.dir, "..");

/* ------------------------------------------------------------------ */
/* Offline trap for the whole file                                     */
/* ------------------------------------------------------------------ */

const hits = { fetch: 0, websocket: 0, connect: 0, net: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
const restores: (() => void)[] = [];

beforeAll(() => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((): Response => {
    hits.fetch++; throw trapError("fetch");
  }) as unknown as typeof fetch);
  restores.push(() => fetchSpy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    constructor() { hits.websocket++; throw trapError("WebSocket"); }
  };
  restores.push(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWebSocket; });
  const realConnect = (Bun as unknown as { connect: unknown }).connect;
  (Bun as unknown as { connect: unknown }).connect = (): never => { hits.connect++; throw trapError("Bun.connect"); };
  restores.push(() => { (Bun as unknown as { connect: unknown }).connect = realConnect; });
  for (const mod of [netNamespace, netDefault] as unknown as Record<string, unknown>[]) {
    for (const name of ["connect", "createConnection"]) {
      if (typeof mod[name] !== "function") continue;
      try {
        const spy = spyOn(mod as Record<string, unknown>, name).mockImplementation(((): never => {
          hits.net++; throw trapError("node:net");
        }) as unknown as never);
        restores.push(() => spy.mockRestore());
      } catch {
        const real = mod[name];
        mod[name] = (): never => { hits.net++; throw trapError("node:net"); };
        restores.push(() => { mod[name] = real; });
      }
    }
  }
});

afterAll(() => {
  for (const restore of restores) restore();
  expect(hits).toEqual({ fetch: 0, websocket: 0, connect: 0, net: 0 });
});

/* ------------------------------------------------------------------ */
/* Small tree helpers (the tree is plain objects)                      */
/* ------------------------------------------------------------------ */

function classesOf(node: UiNode): string[] {
  const raw = node.attrs?.class ?? "";
  return raw.split(/\s+/).filter(Boolean);
}
function hasClass(node: UiNode, cls: string): boolean {
  return classesOf(node).includes(cls);
}
function findAll(node: UiNode, pred: (n: UiNode) => boolean): UiNode[] {
  const out: UiNode[] = [];
  const walk = (n: UiNode): void => {
    if (pred(n)) out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}
function textOf(node: UiNode): string {
  return (node.text ?? "") + node.children.map(textOf).join("");
}
/** Nodes paired with their parent, for the cell-mark checks of the tree contract. */
function withParents(node: UiNode, parent: UiNode | null = null): { node: UiNode; parent: UiNode | null }[] {
  const out: { node: UiNode; parent: UiNode | null }[] = [{ node, parent }];
  for (const child of node.children) out.push(...withParents(child, node));
  return out;
}

/* ------------------------------------------------------------------ */
/* Shared fixture builders (hand-built, from the public contract)      */
/* ------------------------------------------------------------------ */

const SID = "surface-under-test";
const CATALOG_ID = "linchpin.evidence.v1";

function msgCreate(surfaceId = SID): A2uiMessage {
  return { version: "v0.9.1", createSurface: { surfaceId, catalogId: CATALOG_ID } };
}
function msgModel(surfaceId: string, value: unknown): A2uiMessage {
  return { version: "v0.9.1", updateDataModel: { surfaceId, path: "/", value } };
}
function msgComponents(surfaceId: string, components: A2uiComponent[]): A2uiMessage {
  return { version: "v0.9.1", updateComponents: { surfaceId, components } };
}

function makeMeta(over: Partial<SurfaceMeta> = {}): SurfaceMeta {
  return { subjectId: "near:mainnet:intents.near", snapshotIds: ["snap-fixture"], ...over };
}

function makeRow(over: Partial<ResultRow> = {}): ResultRow {
  return {
    rowKind: "fact", key: "row-1",
    values: { label: "a value" },
    factIds: ["fact-1"], bases: ["observed"], evidenceIds: ["ev-1"],
    blockOrSlot: "223810509", asOf: "2026-11-09T19:31:30.348Z", snapshotIds: [],
    ...over,
  };
}

function makeTableResult(resultId = "r1", over: Partial<ResultSet> = {}): ResultSet {
  return {
    resultId, shape: "table",
    columns: [{ name: "label", role: "value" }],
    coverage: "mapped", coverageNotes: [],
    rows: [makeRow()], truncated: false,
    ...over,
  };
}

function makeChainResult(resultId = "c1"): ResultSet {
  return {
    resultId, shape: "chain",
    columns: [
      { name: "target", role: "address" }, { name: "instruction", role: "instruction" },
      { name: "role", role: "role" }, { name: "authority", role: "address" },
      { name: "controller", role: "address" },
    ],
    coverage: "mapped", coverageNotes: [],
    rows: [makeRow({
      key: "chain-1", factIds: ["fact-c1"], evidenceIds: ["ev-c1"],
      values: { target: "target-a", instruction: "do the thing", role: "updater", authority: "auth-a", controller: "ctrl-a" },
    })],
    truncated: false,
  };
}

function makeUnknownsResult(resultId = "u1"): ResultSet {
  return {
    resultId, shape: "unknowns",
    columns: [{ name: "label", role: "label" }],
    coverage: "mapped", coverageNotes: [],
    rows: [makeRow({
      rowKind: "unknown", key: "unk-1", factIds: ["fact-u1"],
      bases: ["unknown"], evidenceIds: ["ev-u1"], values: { label: "who may pause" },
    })],
    truncated: false,
  };
}

function makeGraphResult(resultId = "g1", over: Partial<GraphResult> = {}): GraphResult {
  const nodes = [
    { id: "n1", label: "node one", isolated: false },
    { id: "n2", label: "node two", isolated: false },
  ];
  const edges = [
    { key: "e1", from: "n1", to: "n2", relation: "controls", factIds: ["fact-g1"], bases: ["observed"], evidenceIds: ["ev-g1"], blockOrSlot: "223810509", asOf: null },
  ];
  return { resultId, shape: "graph", coverage: "mapped", coverageNotes: [], nodes, edges, truncated: false, ...over };
}

const alwaysResolve = (): { missing: string[] } => ({ missing: [] });

/** The valid base surface of the per-rule tests: a panel skeleton with one cited table. */
function baseSurface(): A2uiMessage[] {
  return [
    msgCreate(),
    msgModel(SID, { meta: makeMeta(), results: { r1: makeTableResult() } }),
    msgComponents(SID, [
      { id: "root", component: "Column", children: ["t1"] },
      { id: "t1", component: "FactTable", result: { path: "/results/r1" } },
    ]),
  ];
}

/** A valid graph surface: one DependencyGraph over a two-node, one-edge result. */
function graphSurface(result?: GraphResult): A2uiMessage[] {
  return [
    msgCreate(),
    msgModel(SID, { meta: makeMeta(), results: { g1: result ?? makeGraphResult() } }),
    msgComponents(SID, [
      { id: "root", component: "Column", children: ["g1"] },
      { id: "g1", component: "DependencyGraph", result: { path: "/results/g1" } },
    ]),
  ];
}

/** A one-table surface with a custom row set, drawn without validation. */
function oneTableSurface(rows: ResultRow[]): A2uiMessage[] {
  return [
    msgCreate(),
    msgModel(SID, { meta: makeMeta(), results: { r1: makeTableResult("r1", { rows }) } }),
    msgComponents(SID, [
      { id: "root", component: "Column", children: ["t1"] },
      { id: "t1", component: "FactTable", result: { path: "/results/r1" } },
    ]),
  ];
}

function expectRejected(fn: () => unknown, code: string): UiRejected {
  let caught: unknown = null;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(UiRejected);
  const rejected = caught as UiRejected;
  expect(rejected.code).toBe(code);
  return rejected;
}

/* ------------------------------------------------------------------ */
/* Snapshot (computed in the tests; only the planner's counted numbers */
/* are asserted literally)                                             */
/* ------------------------------------------------------------------ */

let snapshot: EvidenceSnapshot;

beforeAll(() => {
  snapshot = buildNearSnapshot("near-2026-11-09", { root: join(REPO_ROOT, "fixtures", "near") });
});

const SUBJECT = "near:mainnet:intents.near";
/** The counts and the block the plan fixes by hand; everything else is computed. */
const SUBJECT_FACT_COUNT = 27;
const HOLDS_ROLE_COUNT = 12;
const HOLDS_ROLE_BLOCK = "223810509";

function subjectFacts(): Fact[] {
  return snapshot.facts.filter((f) => f.subject === SUBJECT);
}
function citedReceiptIds(rows: { evidenceIds: string[] }[]): string[] {
  return [...new Set(rows.flatMap((r) => r.evidenceIds))];
}

/* ------------------------------------------------------------------ */
/* AC1 -- Catalog                                                      */
/* ------------------------------------------------------------------ */

describe("AC1 catalog", () => {
  /** The eight approved components with their prop names and binding kinds, copied from the approved catalogue table of the agent-answer specification. */
  const APPROVED: Record<string, { name: string; kind: "B" | "L" | "children"; required: boolean; maxLength?: number }[]> = {
    Column: [{ name: "children", kind: "children", required: true }],
    AnswerHeader: [{ name: "meta", kind: "B", required: true }],
    FactTable: [
      { name: "result", kind: "B", required: true },
      { name: "columns", kind: "L", required: false },
      { name: "title", kind: "L", required: false, maxLength: 80 },
    ],
    ControlChain: [{ name: "result", kind: "B", required: true }],
    ValuePath: [{ name: "result", kind: "B", required: true }],
    CoverageNote: [
      { name: "result", kind: "B", required: false },
      { name: "coverage", kind: "B", required: false },
    ],
    UnknownList: [{ name: "result", kind: "B", required: true }],
    Note: [{ name: "text", kind: "L", required: true, maxLength: 280 }],
  };
  const ADDED = ["DependencyGraph", "Section", "SubjectHeader", "Timeline"];

  test("T-AC1a: id and exactly the twelve component names", () => {
    expect(CATALOG.id).toBe(CATALOG_ID);
    const names = Object.keys(CATALOG.components).sort();
    expect(names).toEqual([...Object.keys(APPROVED), ...ADDED].sort());
    expect(Object.isFrozen(CATALOG)).toBe(true);
    for (const spec of Object.values(CATALOG.components)) {
      for (const prop of Object.values(spec.props)) {
        expect(["B", "L", "children"]).toContain(prop.kind);
      }
    }
  });

  test("T-AC1b: the eight approved components keep their prop names, binding kinds and required flags", () => {
    for (const [name, expectedProps] of Object.entries(APPROVED)) {
      const spec = CATALOG.components[name];
      expect(spec, `component ${name}`).toBeDefined();
      const got = Object.keys(spec.props).sort();
      const want = expectedProps.map((p) => p.name).sort();
      expect(got, `props of ${name}`).toEqual(want);
      for (const expected of expectedProps) {
        const prop = spec.props[expected.name];
        expect(prop.kind, `${name}.${expected.name} kind`).toBe(expected.kind);
        if (expected.required) expect(prop.required, `${name}.${expected.name} required`).toBe(true);
        if (expected.maxLength !== undefined) expect(prop.maxLength, `${name}.${expected.name} maxLength`).toBe(expected.maxLength);
      }
    }
  });

  test("T-AC1c: catalogJson is stable and carries catalogId, components and instructions", () => {
    const a = catalogJson();
    const b = catalogJson();
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as { catalogId: string; components: Record<string, unknown>; instructions: unknown };
    expect(parsed.catalogId).toBe(CATALOG_ID);
    expect(Object.keys(parsed.components).sort()).toEqual(Object.keys(CATALOG.components).sort());
    expect(Array.isArray(parsed.instructions)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* AC2 -- Messages from a view template                                */
/* ------------------------------------------------------------------ */

describe("AC2 templates produce messages", () => {
  const meta = makeMeta();

  function instantiation(): A2uiMessage[] {
    return instantiate("subject-panel", {
      surfaceId: SID, meta,
      results: [makeTableResult("r1"), makeChainResult("c1"), makeUnknownsResult("u1")],
    });
  }

  test("T-AC2a: three messages in order, versioned, one flat root, values bound, data model unchanged", () => {
    const messages = instantiation();
    expect(messages).toHaveLength(3);
    expect(messages[0]!.version).toBe(A2UI_VERSION);
    expect(A2UI_VERSION).toBe("v0.9.1");
    expect("createSurface" in messages[0]!).toBe(true);
    expect("updateDataModel" in messages[1]!).toBe(true);
    expect("updateComponents" in messages[2]!).toBe(true);

    for (const message of messages) {
      const keys = Object.keys(message).filter((k) => k !== "version");
      expect(keys).toHaveLength(1);
      const body = (message as Record<string, unknown>)[keys[0]!] as Record<string, unknown>;
      expect(body.surfaceId).toBe(SID);
    }
    const created = messages[0] as { createSurface: { catalogId: string } };
    expect(created.createSurface.catalogId).toBe(CATALOG_ID);

    // flat list, unique ids, exactly one root
    const components = (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components;
    expect(Array.isArray(components)).toBe(true);
    const ids = components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "root")).toHaveLength(1);
    for (const component of components) {
      expect(typeof component.id).toBe("string");
      expect(typeof component.component).toBe("string");
    }

    // every binding prop is exactly { path }, children are ids or {path, componentId}
    for (const component of components) {
      const spec = CATALOG.components[component.component];
      expect(spec, `catalog entry for ${component.component}`).toBeDefined();
      for (const [prop, value] of Object.entries(component)) {
        if (prop === "id" || prop === "component") continue;
        const propSpec = spec.props[prop];
        expect(propSpec, `prop ${component.component}.${prop} is in the catalog`).toBeDefined();
        if (propSpec.kind === "B") {
          expect(Object.keys(value as Record<string, unknown>)).toEqual(["path"]);
          expect(typeof (value as { path: unknown }).path).toBe("string");
        } else if (propSpec.kind === "children") {
          const ok = Array.isArray(value) ||
            (typeof value === "object" && value !== null &&
              typeof (value as { path?: unknown }).path === "string" && typeof (value as { componentId?: unknown }).componentId === "string");
          expect(ok, `children prop of ${component.id}`).toBe(true);
        }
      }
    }

    // the data model holds meta and each result unchanged (deep equality)
    const model = (messages[1] as { updateDataModel: { path: string; value: unknown } }).updateDataModel;
    expect(model.path).toBe("/");
    const value = model.value as { meta: unknown; results: Record<string, unknown> };
    expect(value.meta).toEqual(meta);
    expect(value.results.r1).toEqual(makeTableResult("r1"));
    expect(value.results.c1).toEqual(makeChainResult("c1"));
    expect(value.results.u1).toEqual(makeUnknownsResult("u1"));
    expect(Object.keys(value.results).sort()).toEqual(["c1", "r1", "u1"]);
    expect("coverage" in value).toBe(false);

    // subject-panel shape: header, then one Section per result, unknowns last
    const sections = components.filter((c) => c.component === "Section");
    expect(sections).toHaveLength(3);
    expect(components.some((c) => c.component === "SubjectHeader")).toBe(true);
    const sectionResultOrder: string[] = [];
    for (const section of sections) {
      const childId = (section.children as string[])[0]!;
      const valueComponent = components.find((c) => c.id === childId)!;
      const bound = (valueComponent as unknown as { result: { path: string } }).result.path;
      sectionResultOrder.push(bound.replace("/results/", ""));
    }
    expect(sectionResultOrder).toEqual(["r1", "c1", "u1"]);
  });

  test("T-AC2b: the instantiation passes the validator", () => {
    const messages = instantiation();
    const resolver = receiptResolver(citedReceiptIds([
      ...makeTableResult("r1").rows, ...makeChainResult("c1").rows, ...makeUnknownsResult("u1").rows,
    ]));
    const verdict = validateSurface(messages, { resolveEvidence: resolver });
    expect(verdict.ok).toBe(true);
    expect(verdict.codes).toEqual([]);
  });

  test("T-AC2c: unknown template and shape-not-accepted are refused", () => {
    expectRejected(() => instantiate("no-such-template", { surfaceId: SID, meta, results: [] }), "unknown-template");
    expectRejected(() => instantiate("control-chain", { surfaceId: SID, meta, results: [makeTableResult("r1")] }), "shape-not-accepted");
  });

  test("further instantiation refusals named by the plan: result-count, duplicate-result, bad-result-id", () => {
    expectRejected(() => instantiate("fact-table", { surfaceId: SID, meta, results: [makeTableResult("r1"), makeTableResult("r2")] }), "result-count");
    expectRejected(() => instantiate("fact-table", { surfaceId: SID, meta, results: [makeTableResult("same-id"), makeTableResult("same-id")] }), "duplicate-result");
    expectRejected(() => instantiate("fact-table", { surfaceId: SID, meta, results: [makeTableResult("bad id!")] }), "bad-result-id");
  });

  test("listViewTemplates lists the seven template ids with title, accepts and a description", () => {
    const expected = ["fact-table", "control-chain", "dependency-graph", "timeline", "unknowns", "coverage", "subject-panel"];
    expect(listViewTemplates().map((t) => t.id)).toEqual(expected);
    for (const entry of listViewTemplates()) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.split(/\s+/).length).toBeGreaterThanOrEqual(3);
      expect(entry.accepts.length).toBeGreaterThan(0);
    }
    expect(VIEW_TEMPLATES).toHaveLength(expected.length);
  });

  test("message builders carry the version and pointerGet reads the model", () => {
    expect(createSurface("x").version).toBe("v0.9.1");
    expect(updateDataModel("x", "/a", 1).version).toBe("v0.9.1");
    expect(updateComponents("x", []).version).toBe("v0.9.1");
    expect(deleteSurface("x").version).toBe("v0.9.1");
    expect(pointerGet({ a: { b: 7 } }, "/a/b")).toBe(7);
    expect(pointerGet({ a: 1 }, "/missing")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* AC3 -- Validator: every rule                                        */
/* ------------------------------------------------------------------ */

describe("AC3 validator rules", () => {
  function codesOf(messages: unknown, resolveEvidence = alwaysResolve): string[] {
    return validateSurface(messages, { resolveEvidence }).codes;
  }

  test("base surface is valid", () => {
    const verdict = validateSurface(baseSurface(), { resolveEvidence: alwaysResolve });
    expect(verdict.ok).toBe(true);
    expect(verdict.codes).toEqual([]);
  });

  test("T-AC3-V1 schema: a message with a wrong catalogId gives exactly schema", () => {
    const messages = baseSurface();
    (messages[0] as { createSurface: { catalogId: string } }).createSurface.catalogId = "someone.elses.v1";
    expect(codesOf(messages)).toEqual(["schema"]);
  });

  test("T-AC3-V2 unknown-component: an unlisted component gives exactly unknown-component", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components
      .push({ id: "t2", component: "Sparkline" });
    expect(codesOf(messages)).toEqual(["unknown-component"]);
  });

  test("T-AC3-V3 literal-value: a literal where a binding is required", () => {
    const messages = baseSurface();
    const components = (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components;
    components[1]!.result = "r1" as unknown as { path: string };
    expect(codesOf(messages)).toEqual(["literal-value"]);
  });

  test("T-AC3-V4 dangling-binding: a binding to a missing path", () => {
    const messages = baseSurface();
    const components = (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components;
    components[1]!.result = { path: "/results/missing" };
    expect(codesOf(messages)).toEqual(["dangling-binding"]);
  });

  test("T-AC3-V5 uncited-row: a fact row with empty evidenceIds", () => {
    const messages = baseSurface();
    const model = (messages[1] as { updateDataModel: { value: { results: Record<string, ResultSet> } } }).updateDataModel.value;
    model.results.r1!.rows[0]!.evidenceIds = [];
    expect(codesOf(messages)).toEqual(["uncited-row"]);
  });

  test("T-AC3-V6 unresolved-evidence: an id the resolver reports missing", () => {
    const messages = baseSurface();
    const verdict = validateSurface(messages, { resolveEvidence: (ids) => ({ missing: ids }) });
    expect(verdict.codes).toEqual(["unresolved-evidence"]);
  });

  test("T-AC3-V7 advice-word: Note.text containing 'safe'", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components
      .push({ id: "t3", component: "Note", text: "This is safe to use" });
    expect(codesOf(messages)).toEqual(["advice-word"]);
  });

  test("T-AC3-V8 number-in-text: Note.text containing a digit", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components
      .push({ id: "t3", component: "Note", text: "Recorded on day 1" });
    expect(codesOf(messages)).toEqual(["number-in-text"]);
  });

  test("T-AC3-V9 text-too-long: Note.text over 280 characters", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components
      .push({ id: "t3", component: "Note", text: "x".repeat(281) });
    expect(codesOf(messages)).toEqual(["text-too-long"]);
  });

  test("T-AC3-V10 missing-coverage-note: a not-mapped result nothing binds", () => {
    const messages = baseSurface();
    const model = (messages[1] as { updateDataModel: { value: { results: Record<string, unknown> } } }).updateDataModel.value;
    model.results.r2 = makeTableResult("r2", { coverage: "not-mapped", rows: [] });
    expect(codesOf(messages)).toEqual(["missing-coverage-note"]);
  });

  test("T-AC3-V11 not-mapped-as-fact: a not-mapped result bound to a CoverageNote and to a FactTable", () => {
    const messages = baseSurface();
    const model = (messages[1] as { updateDataModel: { value: { results: Record<string, unknown> } } }).updateDataModel.value;
    model.results.r2 = makeTableResult("r2", { coverage: "not-mapped", rows: [] });
    const components = (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components;
    components.push({ id: "t4", component: "CoverageNote", result: { path: "/results/r2" } });
    components.push({ id: "t5", component: "FactTable", result: { path: "/results/r2" } });
    expect(codesOf(messages)).toEqual(["not-mapped-as-fact"]);

    // repaired: only the CoverageNote binds it
    const repaired = structuredClone(messages);
    const repairedComponents = (repaired[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components;
    repairedComponents.splice(repairedComponents.findIndex((c) => c.id === "t5"), 1);
    const verdict = validateSurface(repaired, { resolveEvidence: alwaysResolve });
    expect(verdict.ok).toBe(true);
    expect(verdict.codes).toEqual([]);
  });

  test("T-AC3-V12 structure: a duplicate component id", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components
      .push({ id: "t1", component: "Note", text: "another" });
    expect(codesOf(messages)).toEqual(["structure"]);
  });

  test("T-AC3-V13 forbidden-action: an action prop reports forbidden-action alone (precedence)", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components[1]!
      .action = { handler: "x" };
    expect(codesOf(messages)).toEqual(["forbidden-action"]);
  });

  test("T-AC3-V14 edge-without-fact: a graph edge with empty bases reports edge-without-fact, not uncited-row", () => {
    const graph = makeGraphResult();
    graph.edges[0]!.bases = [];
    expect(codesOf(graphSurface(graph))).toEqual(["edge-without-fact"]);
    // repaired: the edge carries its basis again
    graph.edges[0]!.bases = ["observed"];
    expect(codesOf(graphSurface(graph))).toEqual([]);
  });

  test("T-AC3-V15 section-title: a Section title with a digit reports section-title alone", () => {
    const messages = baseSurface();
    (messages[2] as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components
      .push({ id: "t6", component: "Section", title: "Group 2", children: ["t1"] });
    expect(codesOf(messages)).toEqual(["section-title"]);
  });

  test("malformed input never throws: null, a string, two message keys, a cycle", () => {
    expect(validateSurface(null, { resolveEvidence: alwaysResolve }).codes).toContain("schema");
    expect(validateSurface(null, { resolveEvidence: alwaysResolve }).ok).toBe(false);
    expect(validateSurface("not an array", { resolveEvidence: alwaysResolve }).codes).toContain("schema");

    const twoKeys: unknown = {
      version: "v0.9.1",
      createSurface: { surfaceId: SID, catalogId: CATALOG_ID },
      updateComponents: { surfaceId: SID, components: [] },
    };
    expect(validateSurface(twoKeys, { resolveEvidence: alwaysResolve }).codes).toContain("schema");

    const cyclic: A2uiMessage[] = [
      msgCreate(),
      msgModel(SID, { meta: makeMeta(), results: {} }),
      msgComponents(SID, [
        { id: "root", component: "Column", children: ["t1"] },
        { id: "t1", component: "Column", children: ["root"] },
      ]),
    ];
    expect(validateSurface(cyclic, { resolveEvidence: alwaysResolve }).codes).toContain("structure");
  });
});

/* ------------------------------------------------------------------ */
/* AC4 -- Interpretation (tree contract)                               */
/* ------------------------------------------------------------------ */

describe("AC4 interpretation", () => {
  /** A subject-panel surface over the snapshot's subject, one table result per predicate group. */
  function nearPanel(): { messages: A2uiMessage[]; results: ResultSet[] } {
    const facts = subjectFacts();
    expect(facts).toHaveLength(SUBJECT_FACT_COUNT);
    const predicates = [...new Set(facts.map((f) => f.predicate))];
    const results: ResultSet[] = predicates.map((predicate) => {
      const group = facts.filter((f) => f.predicate === predicate);
      const built = factsToResult(group, snapshot.receipts, {
        id: predicate, shape: "table", snapshotIds: ["near-2026-11-09"],
      });
      expect(built.skipped).toEqual([]);
      return built.result;
    });
    const messages = instantiate("subject-panel", {
      surfaceId: SID, meta: makeMeta({ snapshotIds: ["near-2026-11-09"] }), results,
    });
    const resolver = receiptResolver(citedReceiptIds(results.flatMap((r) => r.rows)));
    const verdict = validateSurface(messages, { resolveEvidence: resolver });
    expect(verdict.ok).toBe(true);
    expect(verdict.codes).toEqual([]);
    return { messages, results };
  }

  test("T-AC4a: one h1, one main, one section per result, and every row carries value, bases, block and chip", () => {
    const { messages, results } = nearPanel();
    const tree = interpret(messages);
    expect(tree.errors).toEqual([]);
    expect(tree.root.tag).toBe("main");
    expect(hasClass(tree.root, CLASSES.surface)).toBe(true);

    const h1s = findAll(tree.root, (n) => n.tag === "h1");
    expect(h1s).toHaveLength(1);
    // SubjectHeader draws h1 = meta.title ?? meta.subjectId; no title given here
    expect(textOf(h1s[0]!)).toBe(SUBJECT);

    const sections = findAll(tree.root, (n) => n.tag === "section");
    expect(sections).toHaveLength(results.length);

    // rows appear in result order: the n-th lk-row of section i is the n-th row of result i
    for (let i = 0; i < results.length; i++) {
      const rows = findAll(sections[i]!, (n) => hasClass(n, CLASSES.row));
      const resultRows = results[i]!.rows;
      expect(rows.length, `section ${i} (${results[i]!.resultId}) row count`).toBe(resultRows.length);
      for (let j = 0; j < resultRows.length; j++) {
        const node = rows[j]!;
        const row = resultRows[j]!;
        const flat = textOf(node);
        for (const [name, cell] of Object.entries(row.values)) {
          if (cell === null) continue; // drawn as the kit's not-recorded wording; value absent by contract
          expect(flat, `cell ${name} of ${row.key}`).toContain(String(cell));
        }
        const basisNodes = findAll(node, (n) => hasClass(n, CLASSES.basis));
        expect(basisNodes.map(textOf)).toEqual(row.bases);
        const obsNodes = findAll(node, (n) => hasClass(n, CLASSES.observation));
        expect(obsNodes.length).toBeGreaterThanOrEqual(1);
        expect(textOf(obsNodes[0]!)).toContain(String(row.blockOrSlot));
        const chip = findAll(node, (n) => n.tag === "details" && hasClass(n, CLASSES.chip));
        expect(chip).toHaveLength(1);
        const ids = findAll(chip[0]!, (n) => hasClass(n, CLASSES.evidenceId));
        expect(ids.map(textOf)).toEqual(row.evidenceIds);
      }
    }
  });

  test("T-AC4b: a row without evidence ids shows 'no evidence' and no chip", () => {
    const tree = interpret(oneTableSurface([makeRow({ evidenceIds: [] })]));
    const row = findAll(tree.root, (n) => hasClass(n, CLASSES.row))[0]!;
    const marks = findAll(row, (n) => hasClass(n, CLASSES.noEvidence));
    expect(marks).toHaveLength(1);
    expect(textOf(marks[0]!)).toBe("no evidence");
    expect(findAll(row, (n) => hasClass(n, CLASSES.chip))).toHaveLength(0);
  });

  test("T-AC4c: an unknown row carries the hatching class and the word 'unknown'", () => {
    const tree = interpret(oneTableSurface([
      makeRow({ rowKind: "unknown", key: "unk", values: { label: "something" }, bases: ["observed"] }),
    ]));
    const row = findAll(tree.root, (n) => hasClass(n, CLASSES.row) && hasClass(n, CLASSES.unknown));
    expect(row).toHaveLength(1);
    expect(textOf(row[0]!)).toContain("unknown");
  });

  test("cell marks: a cell valued 'unknown' carries lk-unknown and a cell valued 'none' carries lk-none, on the cell or its single value element", () => {
    const tree = interpret(oneTableSurface([
      makeRow({ key: "k-unk", values: { label: "unknown" } }),
      makeRow({ key: "k-none", values: { label: "none" } }),
      makeRow({ key: "k-plain", values: { label: "plain" } }),
    ]));
    const rows = findAll(tree.root, (n) => hasClass(n, CLASSES.row));
    expect(rows).toHaveLength(3);

    // The class sits on the cell's value node -- either the table cell itself or its
    // single value element. A cell where neither carries the class is refused.
    const cellMarked = (rowNode: UiNode, value: string, cls: string): boolean => {
      const candidates = withParents(rowNode).filter(({ node }) => node !== rowNode && textOf(node) === value);
      return candidates.some(({ node, parent }) =>
        hasClass(node, cls) || (parent !== null && parent !== rowNode && hasClass(parent, cls)));
    };
    expect(cellMarked(rows[0]!, "unknown", CLASSES.unknown)).toBe(true);
    expect(cellMarked(rows[1]!, "none", CLASSES.none)).toBe(true);
    // the plain cell carries neither mark
    expect(cellMarked(rows[2]!, "plain", CLASSES.unknown)).toBe(false);
    expect(cellMarked(rows[2]!, "plain", CLASSES.none)).toBe(false);
    // none and unknown are different marks
    expect(cellMarked(rows[0]!, "unknown", CLASSES.none)).toBe(false);
    expect(cellMarked(rows[1]!, "none", CLASSES.unknown)).toBe(false);
  });

  test("scope row: scope wording, no basis node, no chip", () => {
    const tree = interpret(oneTableSurface([
      makeRow({ rowKind: "scope", key: "s1", scopeSource: "curated registry", bases: [], evidenceIds: [] }),
    ]));
    const row = findAll(tree.root, (n) => hasClass(n, CLASSES.row))[0]!;
    const scopes = findAll(row, (n) => hasClass(n, CLASSES.scope));
    expect(scopes).toHaveLength(1);
    expect(textOf(scopes[0]!)).toBe("Linchpin scope: curated registry; not evidence");
    expect(findAll(row, (n) => hasClass(n, CLASSES.basis))).toHaveLength(0);
    expect(findAll(row, (n) => hasClass(n, CLASSES.chip))).toHaveLength(0);
  });

  test("T-AC4d: an unsupported component becomes the fixed box, one error, no prop value reaches the tree", () => {
    const SENTINEL = "SENTINEL-secret-value";
    const messages: A2uiMessage[] = [
      msgCreate(),
      msgModel(SID, { meta: makeMeta(), results: { r1: makeTableResult() } }),
      msgComponents(SID, [
        { id: "root", component: "Column", children: ["t1", "u9"] },
        { id: "t1", component: "FactTable", result: { path: "/results/r1" } },
        { id: "u9", component: "Sparkline", data: SENTINEL },
      ]),
    ];
    const tree = interpret(messages);
    const boxes = findAll(tree.root, (n) => hasClass(n, CLASSES.unsupported));
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.tag).toBe("div");
    expect(textOf(boxes[0]!)).toBe(STRINGS.unsupported);
    expect(tree.errors).toHaveLength(1);
    expect(tree.errors[0]!.code).toBe("unknown-component");
    expect(tree.errors[0]!.componentId).toBe("u9");
    expect(JSON.stringify(tree)).not.toContain(SENTINEL);
  });
});

/* ------------------------------------------------------------------ */
/* AC5 -- Text stays text                                              */
/* ------------------------------------------------------------------ */

const HOSTILE_VALUE = "<img src=x onerror=alert(1)>";
const HOSTILE_LABEL = '"><script>alert(1)</script>';
const ESCAPED_VALUE = "&lt;img src=x onerror=alert(1)&gt;";
const ESCAPED_LABEL = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;";

/** A surface whose data model holds the hostile value and the hostile column label. */
function hostileSurface(): A2uiMessage[] {
  const result = makeTableResult("rh", {
    columns: [{ name: HOSTILE_LABEL, role: "value" }],
    rows: [makeRow({ key: "h1", values: { [HOSTILE_LABEL]: HOSTILE_VALUE } })],
  });
  return [
    msgCreate(),
    msgModel(SID, { meta: makeMeta(), results: { rh: result } }),
    msgComponents(SID, [
      { id: "root", component: "Column", children: ["t1"] },
      { id: "t1", component: "FactTable", result: { path: "/results/rh" } },
    ]),
  ];
}

interface Parsed {
  imgs: number; scripts: number; scriptTypes: (string | null)[]; scriptIds: (string | null)[];
  styleAttrs: number; onAttrs: string[]; htmlLang: string | null; htmlCount: number;
  mainCount: number; titleText: string; styleText: string; styleCount: number;
  h2s: string[]; h3s: string[]; metaCharset: number; metaViewport: number; classes: string[];
}

async function parseHtml(html: string): Promise<Parsed> {
  const p: Parsed = {
    imgs: 0, scripts: 0, scriptTypes: [], scriptIds: [], styleAttrs: 0, onAttrs: [],
    htmlLang: null, htmlCount: 0, mainCount: 0, titleText: "", styleText: "", styleCount: 0,
    h2s: [], h3s: [], metaCharset: 0, metaViewport: 0, classes: [],
  };
  let titleChunks: string[] = [];
  let styleChunks: string[] = [];
  let h2Buf: { text: string } | null = null;
  let h3Buf: { text: string } | null = null;
  await new HTMLRewriter()
    .on("html", { element(el) { p.htmlCount++; p.htmlLang = el.getAttribute("lang"); } })
    .on("main", { element() { p.mainCount++; } })
    .on("img", { element() { p.imgs++; } })
    .on("script", {
      element(el) {
        p.scripts++;
        p.scriptTypes.push(el.getAttribute("type"));
        p.scriptIds.push(el.getAttribute("id"));
      },
    })
    .on("title", {
      element() { titleChunks = []; },
      text(t) { titleChunks.push(t.text); },
    })
    .on("style", {
      element() { p.styleCount++; styleChunks = []; },
      text(t) { styleChunks.push(t.text); },
    })
    .on("h2", {
      element(el) {
        h2Buf = { text: "" };
        el.onEndTag(() => { if (h2Buf) { p.h2s.push(h2Buf.text); h2Buf = null; } });
      },
      text(t) { if (h2Buf) h2Buf.text += t.text; },
    })
    .on("h3", {
      element(el) {
        h3Buf = { text: "" };
        el.onEndTag(() => { if (h3Buf) { p.h3s.push(h3Buf.text); h3Buf = null; } });
      },
      text(t) { if (h3Buf) h3Buf.text += t.text; },
    })
    .on("[style]", { element() { p.styleAttrs++; } })
    .on("meta", {
      element(el) {
        if (el.getAttribute("charset") !== null) p.metaCharset++;
        if (el.getAttribute("name") === "viewport") p.metaViewport++;
      },
    })
    .on("*", {
      element(el) {
        for (const attr of el.attributes) {
          if (attr[0]!.startsWith("on")) p.onAttrs.push(`${el.tagName}:${attr[0]}`);
          if (attr[0] === "class") p.classes.push(...attr[1]!.split(/\s+/).filter(Boolean));
        }
      },
    })
    .transform(new Response(html))
    .text();
  // The heading buffers are cleared by their onEndTag closures during the transform;
  // a buffer left set would mean the element never closed, which the counts would show.
  p.titleText = titleChunks.join("");
  p.styleText = styleChunks.join("");
  return p;
}

const noRemoteRefs = (html: string): void => {
  expect(html).not.toContain("http:");
  expect(html).not.toContain("https:");
  expect(html).not.toContain("@import");
  expect(html).not.toContain("url(");
};

describe("AC5 text stays text", () => {
  test("T-AC5a: hostile value and label come out escaped only", async () => {
    const html = treeToHtml(interpret(hostileSurface()));
    expect(html).toContain(ESCAPED_VALUE);
    expect(html).toContain(ESCAPED_LABEL);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    const parsed = await parseHtml(html);
    expect(parsed.imgs).toBe(0);
    expect(parsed.scripts).toBe(0);
    expect(parsed.onAttrs).toEqual([]);
  });

  test("T-AC5b: the drawn panel and its standalone page add no script, no URL, no style attribute", async () => {
    const facts = subjectFacts();
    const predicates = [...new Set(facts.map((f) => f.predicate))];
    const results: ResultSet[] = predicates.map((predicate) =>
      factsToResult(facts.filter((f) => f.predicate === predicate), snapshot.receipts, {
        id: predicate, shape: "table", snapshotIds: ["near-2026-11-09"],
      }).result,
    );
    const messages = instantiate("subject-panel", {
      surfaceId: SID, meta: makeMeta({ snapshotIds: ["near-2026-11-09"] }), results,
    });

    const drawn = treeToHtml(interpret(messages));
    const parsed = await parseHtml(drawn);
    expect(parsed.scripts).toBe(0);
    expect(parsed.imgs).toBe(0);
    expect(parsed.styleAttrs).toBe(0);
    expect(parsed.onAttrs).toEqual([]);
    noRemoteRefs(drawn);

    const resolver = receiptResolver(citedReceiptIds(results.flatMap((r) => r.rows)));
    const page = standalonePage(messages, { title: "Panel", lang: "en", resolveEvidence: resolver });
    const pageParsed = await parseHtml(page);
    expect(pageParsed.scripts).toBe(1);
    expect(pageParsed.scriptTypes[0]).toBe("application/json");
    expect(pageParsed.scriptIds[0]).toBe("lk-messages");
    expect(pageParsed.imgs).toBe(0);
    expect(pageParsed.styleAttrs).toBe(0);
    expect(pageParsed.onAttrs).toEqual([]);
    noRemoteRefs(page);
  });

  test("T-AC5c: a hand-made tree with script, onclick and style loses all three", async () => {
    const hostile: UiNode = {
      tag: "div", attrs: { onclick: "x()", style: "color:red" }, text: "t",
      children: [{ tag: "script", attrs: {}, text: "bad()", children: [] }],
    };
    const html = treeToHtml(hostile);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style=");
    const parsed = await parseHtml(html);
    expect(parsed.scripts).toBe(0);
    expect(parsed.onAttrs).toEqual([]);
    expect(parsed.styleAttrs).toBe(0);
  });

  test("escapeHtml escapes every markup character", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(ESCAPED_VALUE);
    expect(escapeHtml(HOSTILE_LABEL)).toBe(ESCAPED_LABEL);
    expect(escapeHtml("a&b")).toContain("&amp;");
  });

  test("T-AC5d: mount builds the tree with element creation and textContent only", () => {
    const calls: string[] = [];
    const makeFakeElement = (tag: string): Record<string, unknown> => {
      const el: Record<string, unknown> = {
        tagName: tag.toUpperCase(), attrs: {} as Record<string, string>,
        childNodes: [] as unknown[],
        setAttribute(name: string, value: string) { calls.push(`setAttribute:${name}`); (el.attrs as Record<string, string>)[name] = value; },
        append(...kids: unknown[]) { calls.push("append"); (el.childNodes as unknown[]).push(...kids); },
        replaceChildren(...kids: unknown[]) { calls.push("replaceChildren"); (el.childNodes as unknown[]).push(...kids); },
      };
      Object.defineProperty(el, "innerHTML", { set() { calls.push("innerHTML"); }, get() { return ""; } });
      Object.defineProperty(el, "outerHTML", { set() { calls.push("outerHTML"); }, get() { return ""; } });
      Object.defineProperty(el, "textContent", {
        set(v: unknown) { calls.push("textContent"); el.storedText = v; },
        get() { return el.storedText ?? ""; },
      });
      return el;
    };
    const documentFake: Record<string, unknown> = {
      createElement(tag: string) { calls.push(`createElement:${tag}`); return makeFakeElement(tag); },
      createElementNS(ns: string, tag: string) { calls.push(`createElementNS:${tag}`); return makeFakeElement(tag); },
    };
    const host = makeFakeElement("div");
    host.ownerDocument = documentFake;

    const tree: UiNode = {
      tag: "div", attrs: { class: "x" },
      text: HOSTILE_VALUE,
      children: [{ tag: "p", attrs: {}, text: "plain", children: [] }],
    };
    mount(tree, host as unknown as Element);

    const allowed: RegExp[] = ["createElement", "createElementNS", "setAttribute", "textContent", "append", "replaceChildren"]
      .map((c) => new RegExp(`^${c}(?::|$)`));
    const unexpected = [...new Set(calls.filter((c) => !allowed.some((re) => re.test(c))))];
    expect(unexpected, "only creation, attributes, text and append may be used").toEqual([]);
    expect(calls.some((c) => c.startsWith("createElement:"))).toBe(true);
    expect(calls).toContain("textContent");
    // no img or script element was ever created; the hostile value arrived as text
    expect(calls.some((c) => /^createElementNS?:img/.test(c))).toBe(false);
    expect(calls.some((c) => /^createElementNS?:script/.test(c))).toBe(false);
    const createdTags = calls.filter((c) => c.startsWith("createElement:")).map((c) => c.split(":")[1]);
    expect(createdTags).not.toContain("img");
    expect(createdTags).not.toContain("script");
    const createdDivs = (host.childNodes as Record<string, unknown>[]).filter((n) => n.tagName === "DIV");
    expect(createdDivs.some((n) => n.storedText === HOSTILE_VALUE), "hostile value set as textContent").toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* AC6 -- Standalone page                                              */
/* ------------------------------------------------------------------ */

describe("AC6 standalone page", () => {
  const PAGE_TITLE = "Evidence panel";

  function pageOf(messages: A2uiMessage[]): string {
    return standalonePage(messages, { title: PAGE_TITLE, lang: "en", resolveEvidence: alwaysResolve });
  }

  test("T-AC6a: one html lang, one title, inline stylesheet, static tree, messages block that parses back", async () => {
    const messages = hostileSurface(); // hostile strings included, as the criterion asks
    const page = pageOf(messages);

    expect(page.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(true);
    const parsed = await parseHtml(page);
    expect(parsed.htmlCount).toBe(1);
    expect(parsed.htmlLang).toBe("en");
    expect(parsed.titleText).toBe(PAGE_TITLE);
    expect(parsed.mainCount).toBe(1);
    expect(parsed.styleCount).toBe(1);
    expect(parsed.styleText).toBe(KIT_CSS);
    expect(parsed.metaCharset).toBeGreaterThanOrEqual(1);
    expect(parsed.metaViewport).toBe(1);
    expect(parsed.scripts).toBe(1);
    expect(parsed.scriptTypes[0]).toBe("application/json");
    expect(parsed.scriptIds[0]).toBe("lk-messages");

    const openTag = `<script type="application/json" id="lk-messages">`;
    const start = page.indexOf(openTag);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = page.indexOf("</script>", start);
    const block = page.slice(start + openTag.length, end);
    expect(JSON.parse(block)).toEqual(messages);

    // the hostile literals are not live markup anywhere in the page
    expect(page).toContain(ESCAPED_VALUE);
    expect(page).not.toContain("<img");
  });

  test("T-AC6b: an invalid surface throws UiRejected with the validator's codes and returns nothing", () => {
    const messages = baseSurface();
    const model = (messages[1] as { updateDataModel: { value: { results: Record<string, ResultSet> } } }).updateDataModel.value;
    model.results.r1!.rows[0]!.evidenceIds = [];
    const expected = validateSurface(messages, { resolveEvidence: alwaysResolve });
    expect(expected.ok).toBe(false);
    let caught: unknown = null;
    try { pageOf(messages); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(UiRejected);
    const rejected = caught as UiRejected;
    expect(rejected.code).toBe("invalid-surface");
    expect(rejected.codes).toEqual(expected.codes);
    expect(rejected.codes).toEqual(["uncited-row"]);
  });

  test("T-AC6c: two calls with the same input are byte-identical", () => {
    const messages = hostileSurface();
    expect(pageOf(messages)).toBe(pageOf(messages));
  });

  test("a bad lang is refused", () => {
    expectRejected(() => standalonePage(baseSurface(), {
      title: "t", lang: "not a lang!!", resolveEvidence: alwaysResolve,
    }), "bad-lang");
  });
});

/* ------------------------------------------------------------------ */
/* AC7 -- Adapters                                                     */
/* ------------------------------------------------------------------ */

describe("AC7 adapters", () => {
  test("T-AC7a: the holds-role facts become one row each with their own provenance", () => {
    const holds = subjectFacts().filter((f) => f.predicate === "holds-role");
    expect(holds).toHaveLength(HOLDS_ROLE_COUNT);
    const { result, skipped } = factsToResult(holds, snapshot.receipts, { id: "holds-role", shape: "table" });
    expect(skipped).toEqual([]);
    expect(result.resultId).toBe("holds-role");
    expect(result.rows).toHaveLength(HOLDS_ROLE_COUNT);
    expect(result.coverage).toBe("mapped");
    expect(result.truncated).toBe(false);
    expect(result.columns.map((c) => c.name)).toEqual(["subject", "predicate", "object", "status"]);
    const receiptById = new Map(snapshot.receipts.map((r) => [r.id, r]));
    for (let i = 0; i < holds.length; i++) {
      const fact = holds[i]!;
      const row = result.rows[i]!;
      expect(row.key).toBe(fact.id);
      expect(row.factIds).toEqual([fact.id]);
      expect(row.bases).toEqual([fact.basis]);
      expect(row.evidenceIds).toEqual(fact.evidenceIds);
      expect(row.evidenceIds.length).toBeGreaterThanOrEqual(1);
      const receipt = receiptById.get(row.evidenceIds[0]!)!;
      expect(String(row.blockOrSlot)).toBe(String(receipt.observation.blockOrSlot));
      expect(String(row.blockOrSlot)).toBe(HOLDS_ROLE_BLOCK);
      expect(typeof row.blockOrSlot).toBe("string");
      expect(row.asOf).toBe(receipt.observation.observedAt);
      expect(row.rowKind).toBe("fact");
      expect(row.snapshotIds).toEqual([]);
    }
  });

  test("T-AC7b: a fact whose evidence id has no receipt is skipped with missing-receipt", () => {
    const holds = subjectFacts().filter((f) => f.predicate === "holds-role");
    const orphan: Fact = { ...holds[0]!, id: "synthetic-orphan", evidenceIds: ["nr:no-such-receipt"] };
    const { result, skipped } = factsToResult([...holds, orphan], snapshot.receipts, { id: "x", shape: "table" });
    expect(result.rows).toHaveLength(HOLDS_ROLE_COUNT);
    expect(result.rows.map((r) => r.key)).not.toContain("synthetic-orphan");
    expect(skipped).toEqual([{ factId: "synthetic-orphan", reason: "missing-receipt", evidenceIds: ["nr:no-such-receipt"] }]);
  });

  test("a fact with empty evidenceIds still becomes a row (it has no missing receipt)", () => {
    const holds = subjectFacts().filter((f) => f.predicate === "holds-role");
    const bare: Fact = { ...holds[0]!, id: "synthetic-bare", evidenceIds: [] };
    const { result, skipped } = factsToResult([...holds, bare], snapshot.receipts, { id: "x", shape: "table" });
    expect(skipped).toEqual([]);
    expect(result.rows).toHaveLength(HOLDS_ROLE_COUNT + 1);
    const bareRow = result.rows.find((r) => r.key === "synthetic-bare")!;
    expect(bareRow.evidenceIds).toEqual([]);
  });

  test("T-AC7c: graphResult makes one edge per relation fact and marks unmentioned nodes isolated", () => {
    const node = (id: string): { id: string; label?: string } => ({ id, label: `label of ${id}` });
    const fact = (id: string, subject: string, object: string): Fact => ({
      id, subject, object, predicate: "relates-to", basis: "observed", status: "verified",
      evidenceIds: ["ev-x"], path: [], validFrom: null, validTo: null, privacy: "public",
    });
    const facts = [fact("f1", "A", "B"), fact("f2", "A", "B"), fact("f3", "B", "A")];
    const { result, skipped } = graphResult([node("A"), node("B"), node("C")], facts);
    expect(result.shape).toBe("graph");
    expect(result.resultId).toBe("graph");
    expect(result.edges).toHaveLength(3);
    expect(result.edges.map((e) => e.key)).toEqual(["f1", "f2", "f3"]);
    for (const edge of result.edges) {
      expect(edge.factIds).toEqual([edge.key]);
      expect(edge.relation).toBe("relates-to");
      expect(edge.blockOrSlot).toBeNull();
      expect(edge.asOf).toBeNull();
    }
    expect(skipped).toEqual([]);
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    expect(byId.get("C")!.isolated).toBe(true);
    expect(byId.get("A")!.isolated).toBe(false);
    expect(byId.get("B")!.isolated).toBe(false);
  });

  test("T-AC7d: a fact whose object is not a node makes no edge and is not-a-relation", () => {
    const fact = (id: string, subject: string, object: string): Fact => ({
      id, subject, object, predicate: "relates-to", basis: "observed", status: "verified",
      evidenceIds: ["ev-x"], path: [], validFrom: null, validTo: null, privacy: "public",
    });
    const { result, skipped } = graphResult([{ id: "A" }, { id: "B" }], [fact("f1", "A", "outside")]);
    expect(result.edges).toHaveLength(0);
    expect(skipped).toEqual([{ factId: "f1", reason: "not-a-relation" }]);
  });

  test("edge provenance comes from receipts when given", () => {
    const fact = (id: string, subject: string, object: string, ev: string): Fact => ({
      id, subject, object, predicate: "relates-to", basis: "observed", status: "verified",
      evidenceIds: [ev], path: [], validFrom: null, validTo: null, privacy: "public",
    });
    const receipt: EvidenceReceipt = {
      id: "ev-x", source: "test-fixture", responseSha256: "0".repeat(64),
      observation: {
        chain: "near", network: "mainnet", blockOrSlot: "123", blockHash: null,
        observedAt: "2026-11-09T00:00:00Z", retrievedAt: "2026-11-09T00:00:00Z", historicalState: "pinned",
      },
      privacy: "public",
    };
    const { result } = graphResult([{ id: "A" }, { id: "B" }], [fact("f1", "A", "B", "ev-x")], { receipts: [receipt] });
    expect(result.edges[0]!.blockOrSlot).toBe("123");
    expect(result.edges[0]!.asOf).toBe("2026-11-09T00:00:00Z");
  });
});

/* ------------------------------------------------------------------ */
/* AC8 -- Graph component                                              */
/* ------------------------------------------------------------------ */

describe("AC8 graph component", () => {
  function ac8Graph(): GraphResult {
    const nodes = ["n1", "n2", "n3", "n4", "n5", "n6"].map((id) => ({ id, label: `label ${id}`, isolated: false }));
    const edge = (key: string, from: string, to: string, relation: string, bases: string[]): GraphResult["edges"][number] => ({
      key, from, to, relation, factIds: [`fact-${key}`], bases, evidenceIds: ["ev-g"], blockOrSlot: "223810509", asOf: null,
    });
    const edges = [
      edge("e1", "n1", "n2", "controls", ["observed"]),
      edge("e2", "n1", "n3", "verifies", ["observed", "decoded"]),
      edge("e3", "n2", "n4", "holds", ["observed"]),
      edge("e4", "n3", "n4", "holds", ["claimed"]),
      edge("e5", "n4", "n5", "moves", ["observed"]),
      edge("e6", "n5", "n6", "reports", ["observed"]),
      edge("e7", "n6", "n2", "reviews", ["unknown"]),
    ];
    return { resultId: "g1", shape: "graph", coverage: "mapped", coverageNotes: [], nodes, edges, truncated: false };
  }

  function ac8Surface(): A2uiMessage[] {
    return [
      msgCreate(),
      msgModel(SID, { meta: makeMeta(), results: { g1: ac8Graph() } }),
      msgComponents(SID, [
        { id: "root", component: "Column", children: ["g1"] },
        { id: "g1", component: "DependencyGraph", result: { path: "/results/g1" } },
      ]),
    ];
  }

  test("T-AC8a: svg has 6 node groups and 7 paths, titles carry relation and bases, lists match, boxes disjoint, layout deterministic", () => {
    const graph = ac8Graph();
    const tree = interpret(ac8Surface());
    const svg = findAll(tree.root, (n) => n.tag === "svg");
    expect(svg).toHaveLength(1);
    expect(svg[0]!.attrs.viewBox).toBeDefined();
    expect(svg[0]!.attrs.role).toBe("img");
    expect(svg[0]!.attrs["aria-label"]).toBeDefined();
    expect(svg[0]!.attrs.xmlns).toBeUndefined();

    const groups = findAll(svg[0]!, (n) => n.tag === "g" && hasClass(n, CLASSES.graphNode));
    expect(groups).toHaveLength(6);
    const paths = findAll(svg[0]!, (n) => n.tag === "path" && hasClass(n, CLASSES.graphEdge));
    expect(paths).toHaveLength(graph.edges.length);

    // each path's title names its relation and every basis
    for (const edge of graph.edges) {
      const matching = paths.filter((p) => {
        const title = p.children.find((c) => c.tag === "title");
        const text = title ? textOf(title) : "";
        return text.includes(edge.relation) && edge.bases.every((b) => text.includes(b));
      });
      expect(matching.length, `a path title for ${edge.key}`).toBeGreaterThanOrEqual(1);
    }
    for (const path of paths) {
      expect(path.children.some((c) => c.tag === "title"), "every path carries a title").toBe(true);
    }

    // node rectangles: one per group, numeric, pairwise disjoint
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const group of groups) {
      const rect = group.children.find((c) => c.tag === "rect");
      expect(rect, "node group has a rect").toBeDefined();
      const x = Number(rect!.attrs.x); const y = Number(rect!.attrs.y);
      const w = Number(rect!.attrs.width); const h = Number(rect!.attrs.height);
      expect([x, y, w, h].every((n) => Number.isFinite(n))).toBe(true);
      rects.push({ x, y, w, h });
      expect(group.children.some((c) => c.tag === "title"), "node group carries the full id as title").toBe(true);
    }
    expect(rects).toHaveLength(6);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!; const b = rects[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `boxes ${i} and ${j} overlap`).toBe(false);
      }
    }

    // the text lists beside the svg: same nodes, same edges
    const nodeLists = findAll(tree.root, (n) => n.tag === "ul" && classesOf(n).includes("lk-graph-nodes"));
    expect(nodeLists).toHaveLength(1);
    const nodeItems = findAll(nodeLists[0]!, (n) => n.tag === "li");
    expect(nodeItems).toHaveLength(6);
    for (const node of graph.nodes) {
      expect(nodeItems.some((li) => textOf(li).includes(node.id)), `node list has ${node.id}`).toBe(true);
    }
    const edgeLists = findAll(tree.root, (n) => n.tag === "ul" && classesOf(n).includes("lk-graph-edges"));
    expect(edgeLists).toHaveLength(1);
    const edgeRows = findAll(edgeLists[0]!, (n) => n.tag === "li" && hasClass(n, CLASSES.row));
    expect(edgeRows).toHaveLength(graph.edges.length);

    // determinism: layout twice, draw twice
    expect(layoutGraph(graph)).toEqual(layoutGraph(graph));
    expect(treeToHtml(tree)).toBe(treeToHtml(tree));
  });

  test("T-AC8b: 61 nodes are refused, 60 are not", () => {
    expect(MAX_GRAPH_NODES).toBe(60);
    const big = makeGraphResult("big", {
      nodes: Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, isolated: true })),
      edges: [],
    });
    expectRejected(() => layoutGraph(big), "graph-too-large");
    expectRejected(() => interpret(graphSurface(big)), "graph-too-large");

    const okGraph = makeGraphResult("ok", {
      nodes: Array.from({ length: MAX_GRAPH_NODES }, (_, i) => ({ id: `n${i}`, label: `n${i}`, isolated: true })),
      edges: [],
    });
    expect(layoutGraph(okGraph).nodes).toHaveLength(MAX_GRAPH_NODES);
    const tree = interpret(graphSurface(okGraph));
    expect(tree.errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* AC9 -- Contrast and style rules                                     */
/* ------------------------------------------------------------------ */

interface CssBlock { selector: string; inner: string; start: number; end: number; children: CssBlock[] }

function parseCssBlocks(css: string, from = 0, to = css.length): CssBlock[] {
  const blocks: CssBlock[] = [];
  let i = from;
  while (i < to) {
    const open = css.indexOf("{", i);
    if (open < 0 || open >= to) break;
    const selector = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < to && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const inner = css.slice(open + 1, j - 1);
    const children = inner.includes("{") ? parseCssBlocks(css, open + 1, j - 1) : [];
    blocks.push({ selector, inner, start: i, end: j, children });
    i = j;
  }
  return blocks;
}

function parseDeclarations(inner: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of inner.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16) / 255);
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
function contrast(a: string, b: string): number {
  const la = luminance(a); const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("AC9 contrast and style rules", () => {
  const cssPath = join(REPO_ROOT, "src", "ui", "kit.css");
  const css = readFileSync(cssPath, "utf8");
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = parseCssBlocks(stripped);
  const flatSelector = (s: string) => s.replace(/\s+/g, " ");
  const mediaDark = blocks.find((b) => /@media[^{]*prefers-color-scheme\s*:\s*dark/.test(b.selector));
  const lightTop = blocks.find((b) => flatSelector(b.selector) === ":root");
  const darkTop = mediaDark?.children.find((b) => flatSelector(b.selector) === ":root");
  const themeLight = blocks.find((b) => flatSelector(b.selector) === ".lk-theme-light");
  const themeDark = blocks.find((b) => flatSelector(b.selector) === ".lk-theme-dark");
  const tokenBlocks = [lightTop, darkTop, themeLight, themeDark].filter((b): b is CssBlock => b !== undefined);

  test("the four token blocks exist, hold only --lk-* tokens, hex tokens are six-digit, light equals light and dark equals dark", () => {
    expect(tokenBlocks, "all four token blocks found").toHaveLength(4);
    const maps = tokenBlocks.map((b) => parseDeclarations(b.inner));
    expect(maps[0]!.size).toBeGreaterThan(0);
    for (const map of maps) {
      for (const [key, value] of map) {
        expect(key.startsWith("--lk-"), `token ${key} is namespaced`).toBe(true);
        if (value.startsWith("#")) expect(value, `${key} six-digit hex`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
    expect(maps[0]).toEqual(maps[2]);
    expect(maps[1]).toEqual(maps[3]);
  });

  test("the contrast calculator is checked on known pairs first", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeLessThan(4.5);
  });

  test("T-AC9a: every declared text/background pair reaches 4.5:1 in light and in dark", () => {
    expect(CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(1);
    const lightTokens = parseDeclarations(lightTop!.inner);
    const darkTokens = parseDeclarations(darkTop!.inner);
    for (const pair of CONTRAST_PAIRS) {
      expect(lightTokens.has(pair.text), `${pair.text} defined in light`).toBe(true);
      expect(lightTokens.has(pair.background), `${pair.background} defined in light`).toBe(true);
      expect(darkTokens.has(pair.text), `${pair.text} defined in dark`).toBe(true);
      expect(darkTokens.has(pair.background), `${pair.background} defined in dark`).toBe(true);
      const inLight = contrast(lightTokens.get(pair.text)!, lightTokens.get(pair.background)!);
      const inDark = contrast(darkTokens.get(pair.text)!, darkTokens.get(pair.background)!);
      expect(inLight, `${pair.text} on ${pair.background} in light`).toBeGreaterThanOrEqual(4.5);
      expect(inDark, `${pair.text} on ${pair.background} in dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("T-AC9b: colour lives only in the token blocks; text colours are declared pairs", () => {
    // remove the four token blocks by their spans, then look for stray colour literals
    let cut = "";
    let pos = 0;
    for (const span of [...tokenBlocks].sort((a, b) => a.start - b.start)) {
      cut += stripped.slice(pos, span.start);
      pos = span.end;
    }
    cut += stripped.slice(pos);
    const colourLiterals = cut.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/g) ?? [];
    expect(colourLiterals, "no colour outside the token blocks").toEqual([]);

    const pairTexts = new Set(CONTRAST_PAIRS.map((p) => p.text));
    const problems: string[] = [];
    const walkColors = (list: CssBlock[]): void => {
      for (const block of list) {
        if (!tokenBlocks.includes(block)) {
          for (const m of block.inner.matchAll(/(^|[;{])\s*color\s*:\s*([^;{}]+);/g)) {
            const value = m[2]!.trim();
            const varMatch = value.match(/^var\((--lk-[a-zA-Z0-9-]+)\)$/);
            if (!varMatch) problems.push(`colour declaration not a kit token: ${value}`);
            else if (!pairTexts.has(varMatch[1]!)) problems.push(`${varMatch[1]!} is not a declared text token`);
          }
        }
        walkColors(block.children);
      }
    };
    walkColors(blocks);
    expect(problems).toEqual([]);
  });

  test("T-AC9c: no import, no url, sane widths, focus rule, motion rules, label stacking, wrapping identifiers", () => {
    expect(stripped).not.toContain("@import");
    expect(stripped).not.toContain("url(");
    expect(css).not.toContain("@font-face");
    expect(css.toLowerCase()).not.toContain("</style");
    expect(css).not.toContain("shadow");
    expect(css).toMatch(/:focus-visible/);

    // widths: none over 100%, none in px on a table rule
    const widthDecls: { prop: string; value: string; selectors: string }[] = [];
    const walkWidths = (list: CssBlock[], ancestry: string[]): void => {
      for (const block of list) {
        const chain = [...ancestry, block.selector].join(" ");
        for (const m of block.inner.matchAll(/(^|[;{])\s*(min-width|max-width|width)\s*:\s*([^;{}]+);/g)) {
          const prop = m[2]!;
          if (prop === "width" || prop === "min-width") widthDecls.push({ prop, value: m[3]!.trim(), selectors: chain });
        }
        walkWidths(block.children, [...ancestry, block.selector]);
      }
    };
    walkWidths(blocks, []);
    for (const decl of widthDecls) {
      const pct = decl.value.match(/^([\d.]+)%$/);
      if (pct) expect(parseFloat(pct[1]!), `width ${decl.value} within 100%`).toBeLessThanOrEqual(100);
    }
    // pixel widths are banned on table rules; decorative marks elsewhere are the kit's choice
    for (const decl of widthDecls.filter((d) => /table|lk-table/.test(d.selectors))) {
      expect(/px/.test(decl.value), `no px width on a table: ${decl.value} on ${decl.selectors}`).toBe(false);
    }

    expect((stripped.match(/@media[^{]*prefers-reduced-motion/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(stripped).toMatch(/@media[^{]*prefers-reduced-motion\s*:\s*reduce/);
    const motionOutside: string[] = [];
    const walkMotion = (list: CssBlock[], inMotionMedia: boolean): void => {
      for (const block of list) {
        const isMotionMedia = /@media[^{]*prefers-reduced-motion/.test(block.selector);
        if (!isMotionMedia && !inMotionMedia) {
          for (const m of block.inner.matchAll(/(^|[;{])\s*(animation|transition)[a-z-]*\s*:/g)) {
            motionOutside.push(m[2]!);
          }
        }
        walkMotion(block.children, inMotionMedia || isMotionMedia);
      }
    };
    walkMotion(blocks, false);
    expect(motionOutside, "animation/transition only inside prefers-reduced-motion").toEqual([]);

    expect(css).toMatch(/attr\(\s*data-label\s*\)/);
    expect(stripped).toMatch(/@media[^{]*max-width\s*:\s*480px/);
    expect(stripped).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(stripped).not.toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(stripped).toMatch(/max-width\s*:\s*72ch/);
  });

  test("T-AC9d: kit strings, class names and stylesheet classes carry no rating or advice word; the advice list holds every engine banned word", () => {
    const lowered = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (const [key, value] of Object.entries(STRINGS)) {
      if (typeof value !== "string") continue;
      for (const word of [...lowered(key), ...lowered(value)]) {
        expect(RATING_WORDS.includes(word), `rating word in ${key}: ${word}`).toBe(false);
        expect(ADVICE_WORDS.includes(word), `advice word in ${key}: ${word}`).toBe(false);
      }
    }
    for (const value of Object.values(CLASSES)) {
      for (const part of value.split("-")) {
        expect(RATING_WORDS.includes(part), `class ${value}`).toBe(false);
      }
    }
    for (const selector of stripped.match(/\.lk-[a-zA-Z0-9-]+/g) ?? []) {
      for (const part of selector.slice(1).split("-")) {
        expect(RATING_WORDS.includes(part), `selector ${selector}`).toBe(false);
      }
    }
    for (const banned of BANNED_WORDS) {
      expect(ADVICE_WORDS.includes(banned), `engine banned word ${banned} is in the kit's list`).toBe(true);
    }
    // the text-rule words: the engine list plus exploit, "risk score" and the absence words
    for (const word of [...BANNED_WORDS, "exploit", "risk score", "none", "no", "zero", "nothing", "absent", "empty"]) {
      expect(TEXT_RULE_WORDS.includes(word), `text-rule word ${word}`).toBe(true);
    }
  });

  test("STRINGS fixed members hold their contract wording", () => {
    expect(STRINGS.unsupported).toBe("component not supported");
    expect(STRINGS.noEvidence).toBe("no evidence");
    expect(STRINGS.unknown).toBe("unknown");
    expect(STRINGS.none).toBe("none");
    expect(STRINGS.notMapped).toBe("not mapped");
    expect(STRINGS.partlyMapped).toBe("partly mapped");
    expect(STRINGS.constructed).toBe("CONSTRUCTED");
    expect(STRINGS.recorded).toBe("Recorded evidence; not refreshed from chain");
    expect(STRINGS.scopeTemplate).toBe("Linchpin scope: {source}; not evidence");
    expect(STRINGS.scope("reg")).toBe("Linchpin scope: reg; not evidence");
  });

  test("CLASSES hold their contract values", () => {
    expect(CLASSES.surface).toBe("lk-surface");
    expect(CLASSES.row).toBe("lk-row");
    expect(CLASSES.unknown).toBe("lk-unknown");
    expect(CLASSES.none).toBe("lk-none");
    expect(CLASSES.basis).toBe("lk-basis");
    expect(CLASSES.observation).toBe("lk-obs");
    expect(CLASSES.chip).toBe("lk-chip");
    expect(CLASSES.evidenceId).toBe("lk-evidence-id");
    expect(CLASSES.noEvidence).toBe("lk-no-evidence");
    expect(CLASSES.scope).toBe("lk-scope");
    expect(CLASSES.unsupported).toBe("lk-unsupported");
    expect(CLASSES.graphNode).toBe("lk-graph-node");
    expect(CLASSES.graphEdge).toBe("lk-graph-edge");
    expect(CLASSES.constructed).toBe("lk-constructed");
    expect(CLASSES.themeLight).toBe("lk-theme-light");
    expect(CLASSES.themeDark).toBe("lk-theme-dark");
  });
});

/* ------------------------------------------------------------------ */
/* AC10 -- Gallery                                                     */
/* ------------------------------------------------------------------ */

describe("AC10 gallery", () => {
  const galleryScript = join("src", "ui", "gallery.ts");

  function build(dir: string): { exit: number; path: string } {
    const proc = Bun.spawnSync(["bun", "run", galleryScript, "build", "--out", dir], {
      cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
    });
    return { exit: proc.exitCode, path: join(dir, "gallery.html") };
  }

  test("T-AC10a: the build command exits 0 and writes gallery.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-kit-gallery-a-"));
    const built = build(dir);
    expect(built.exit).toBe(0);
    expect(existsSync(built.path)).toBe(true);
    expect(readFileSync(built.path, "utf8").length).toBeGreaterThan(0);
  });

  test("T-AC10b: every component name is an h2, every state an h3, both themes present, page passes the text checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-kit-gallery-b-"));
    const built = build(dir);
    expect(built.exit).toBe(0);
    const html = readFileSync(built.path, "utf8");

    const parsed = await parseHtml(html);
    for (const name of Object.keys(CATALOG.components)) {
      expect(parsed.h2s, `h2 for ${name}`).toContain(name);
    }
    expect(GALLERY_STATES).toEqual(["filled", "long identifiers", "empty", "none", "unknown", "not mapped", "constructed", "unsupported component"]);
    for (const state of GALLERY_STATES) {
      expect(parsed.h3s, `h3 for state ${state}`).toContain(state);
    }

    expect(parsed.classes).toContain(CLASSES.themeLight);
    expect(parsed.classes).toContain(CLASSES.themeDark);

    // the text checks of the drawn-output criterion, applied to the gallery file
    expect(parsed.scripts).toBe(0);
    expect(parsed.imgs).toBe(0);
    expect(parsed.styleAttrs).toBe(0);
    expect(parsed.onAttrs).toEqual([]);
    noRemoteRefs(html);
  });

  test("T-AC10c: two builds are byte-identical", () => {
    const dirA = mkdtempSync(join(tmpdir(), "ui-kit-gallery-c1-"));
    const dirB = mkdtempSync(join(tmpdir(), "ui-kit-gallery-c2-"));
    const a = build(dirA); const b = build(dirB);
    expect(a.exit).toBe(0); expect(b.exit).toBe(0);
    expect(readFileSync(a.path).equals(readFileSync(b.path))).toBe(true);
  });

  test("T-AC10d: the gallery data equals the snapshot, fact by fact and receipt by receipt", () => {
    const data = galleryData as unknown as { snapshotId: string; subject: string; facts: Fact[]; receipts: EvidenceReceipt[] };
    expect(data.snapshotId).toBe("near-2026-11-09");
    expect(data.subject).toBe(SUBJECT);
    expect(data.facts).toHaveLength(50);
    expect(data.receipts).toHaveLength(8);
    const factsById = new Map(snapshot.facts.map((f) => [f.id, f]));
    const receiptsById = new Map(snapshot.receipts.map((r) => [r.id, r]));
    for (const fact of data.facts) {
      const original = factsById.get(fact.id);
      expect(original, `fact ${fact.id} exists in the snapshot`).toBeDefined();
      expect(fact).toEqual(original!);
    }
    for (const receipt of data.receipts) {
      const original = receiptsById.get(receipt.id);
      expect(original, `receipt ${receipt.id} exists in the snapshot`).toBeDefined();
      expect(receipt).toEqual(original!);
    }
    // the states the specification names are really in the data
    expect(data.facts.some((f) => f.object.length >= 48)).toBe(true);
    expect(data.facts.some((f) => f.object === "none")).toBe(true);
    expect(data.facts.some((f) => f.object === "unknown" || f.basis === "unknown")).toBe(true);
  });

  test("an unknown argument exits 2 and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-kit-gallery-neg-"));
    const proc = Bun.spawnSync(["bun", "run", galleryScript, "build", "--out", dir, "--bogus"], {
      cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("buildGallery returns the document without a subprocess", () => {
    const document = buildGallery();
    expect(document.length).toBeGreaterThan(0);
    expect(document).toContain(CLASSES.themeLight);
    expect(document).toContain(CLASSES.themeDark);
  });
});

/* ------------------------------------------------------------------ */
/* AC11 -- Isolation and network-free code                             */
/* ------------------------------------------------------------------ */

interface ImportRef { spec: string; isTypeOnly: boolean }

function scanImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?[\w*\s{},$]*?\s*from\s*["']([^"']+)["']/g)) {
    refs.push({ spec: m[2]!, isTypeOnly: m[1] !== undefined });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) refs.push({ spec: m[1]!, isTypeOnly: false });
  for (const m of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) refs.push({ spec: m[1]!, isTypeOnly: false });
  return refs;
}

function violationsFor(spec: string, isTypeOnly: boolean, fromFile: string): string | null {
  const uiDir = join(REPO_ROOT, "src", "ui");
  if (spec === "../engine/contracts") {
    return isTypeOnly ? null : "engine import must be a type-only import";
  }
  if (spec.startsWith(".")) {
    const target = resolvePath(dirname(fromFile), spec);
    const insideUi = (target + "/").startsWith(uiDir + "/");
    if (!insideUi) return `relative import leaves the kit: ${spec}`;
    return null;
  }
  return `non-relative import: ${spec}`;
}

describe("AC11 isolation", () => {
  test("T-AC11a probe: the scanner flags a builtin, a cross-tree import and a value engine import", () => {
    expect(scanImports(`import { readFileSync } from "node:fs";`).map((r) => r.spec)).toEqual(["node:fs"]);
    const anywhere = join(REPO_ROOT, "src", "ui", "probe.ts");
    const near = scanImports(`import { buildNearSnapshot } from "../near/reader/index";`);
    expect(violationsFor(near[0]!.spec, near[0]!.isTypeOnly, anywhere), "cross-tree import flagged").not.toBeNull();
    const engineValue = scanImports(`import { Fact } from "../engine/contracts";`);
    expect(engineValue[0]!.isTypeOnly).toBe(false);
    expect(violationsFor(engineValue[0]!.spec, engineValue[0]!.isTypeOnly, anywhere), "value engine import flagged").not.toBeNull();
    const engineType = scanImports(`import type { Fact } from "../engine/contracts";`);
    expect(engineType[0]!.isTypeOnly).toBe(true);
    expect(violationsFor(engineType[0]!.spec, engineType[0]!.isTypeOnly, anywhere)).toBeNull();
  });

  test("every import in every kit file stays inside the kit, or is a type import of the engine contracts", () => {
    const uiDir = join(REPO_ROOT, "src", "ui");
    const files = readdirSync(uiDir).filter((f) => f.endsWith(".ts")).map((f) => join(uiDir, f));
    expect(files.length).toBeGreaterThanOrEqual(10);
    const problems: string[] = [];
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const refs = scanImports(readFileSync(file, "utf8"));
      graph.set(file, []);
      for (const ref of refs) {
        const problem = violationsFor(ref.spec, ref.isTypeOnly, file);
        if (problem) problems.push(`${file}: ${problem} (${ref.spec})`);
        else if (ref.spec.startsWith(".")) graph.get(file)!.push(resolvePath(dirname(file), ref.spec));
      }
    }
    expect(problems, "import rule").toEqual([]);

    // mount and everything it imports must not pull in the page, the gallery or the
    // stylesheet, so a consumer can bundle it for a browser
    const forbiddenForMount = ["page.ts", "gallery.ts", "kit.css"].map((f) => join(uiDir, f));
    const seen = new Set<string>([join(uiDir, "mount.ts")]);
    const queue = [join(uiDir, "mount.ts")];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of graph.get(current) ?? []) {
        expect(forbiddenForMount.includes(next), `mount pulls in ${next}`).toBe(false);
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Regressions: Timeline order, citation members, wrapping node labels */
/* ------------------------------------------------------------------ */

describe("Timeline order", () => {
  /** The time texts a Timeline draws, top to bottom, for a table whose `when` column holds the given values. */
  function drawnTimes(times: unknown[]): string[] {
    const rows = times.map((when, at) => makeRow({ key: `row-${at}`, values: { when, label: `entry ${at}` } as ResultRow["values"] }));
    const result = makeTableResult("r1", { columns: [{ name: "when", role: "time" }, { name: "label", role: "value" }], rows });
    const tree = interpret([
      msgCreate(),
      msgModel(SID, { meta: makeMeta(), results: { r1: result } }),
      msgComponents(SID, [
        { id: "root", component: "Column", children: ["tl"] },
        { id: "tl", component: "Timeline", result: { path: "/results/r1" } },
      ]),
    ]);
    expect(tree.errors).toEqual([]);
    return findAll(tree.root, (n) => hasClass(n, "lk-time")).map((n) => textOf(findAll(n, (m) => hasClass(m, "lk-value"))[0]!));
  }

  test("numbers are ordered by value, not as text", () => {
    expect(drawnTimes([10, 2])).toEqual(["2", "10"]);
    expect(drawnTimes([2, 10])).toEqual(["2", "10"]);
  });

  test("numeric strings are ordered by value and drawn as given", () => {
    expect(drawnTimes(["10", "9"])).toEqual(["9", "10"]);
    expect(drawnTimes(["9", "10"])).toEqual(["9", "10"]);
    expect(drawnTimes(["223810509", "99999999", "1000000000"])).toEqual(["99999999", "223810509", "1000000000"]);
    // leading zeros and the string form survive: the value is read for ordering only
    expect(drawnTimes(["010", "9"])).toEqual(["9", "010"]);
  });

  test("numbers and numeric strings order together; whole numbers beyond double precision keep their order", () => {
    expect(drawnTimes(["10", 9, "8"])).toEqual(["8", "9", "10"]);
    expect(drawnTimes(["9007199254740993", "9007199254740992"])).toEqual(["9007199254740992", "9007199254740993"]);
  });

  test("ISO dates are ordered by instant, whatever their offset or precision", () => {
    expect(drawnTimes(["2026-11-09T19:31:30.348Z", "2026-11-09", "2026-11-09T20:00:00+02:00"]))
      .toEqual(["2026-11-09", "2026-11-09T20:00:00+02:00", "2026-11-09T19:31:30.348Z"]);
  });

  test("classes keep a fixed order: numbers, dates, other text by code unit, then a row with no time", () => {
    expect(drawnTimes([null, "later", "2026-11-09T00:00:00Z", "", "earlier", 7]))
      .toEqual(["7", "2026-11-09T00:00:00Z", "earlier", "later", STRINGS.notRecorded, STRINGS.notRecorded]);
  });

  test("equal times keep the order of the rows", () => {
    const rows = [makeRow({ key: "a", values: { when: "5", label: "first" } }), makeRow({ key: "b", values: { when: 5, label: "second" } as ResultRow["values"] }), makeRow({ key: "c", values: { when: "4", label: "third" } })];
    const result = makeTableResult("r1", { columns: [{ name: "when", role: "time" }, { name: "label", role: "value" }], rows });
    const tree = interpret([
      msgCreate(),
      msgModel(SID, { meta: makeMeta(), results: { r1: result } }),
      msgComponents(SID, [{ id: "root", component: "Column", children: ["tl"] }, { id: "tl", component: "Timeline", result: { path: "/results/r1" } }]),
    ]);
    const entries = findAll(tree.root, (n) => n.tag === "li" && hasClass(n, CLASSES.row)).map(textOf);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("third");
    expect(entries[1]).toContain("first");
    expect(entries[2]).toContain("second");
  });
});

describe("citation lists hold non-empty strings only", () => {
  type Model = { results: Record<string, { rows: Record<string, unknown>[]; edges: Record<string, unknown>[] }> };
  const modelOf = (messages: A2uiMessage[]): Model => (messages[1] as unknown as { updateDataModel: { value: Model } }).updateDataModel.value;

  /** Validate with a resolver that knows every id and records what it was asked. */
  function validated(messages: A2uiMessage[]): { codes: string[]; asked: string[][] } {
    const asked: string[][] = [];
    const verdict = validateSurface(messages, { resolveEvidence: (ids) => { asked.push([...ids]); return { missing: [] }; } });
    return { codes: verdict.codes, asked };
  }

  /** The evidence ids a drawn surface shows, in order. */
  function drawnEvidenceIds(messages: A2uiMessage[]): string[] {
    return findAll(interpret(messages).root, (n) => hasClass(n, CLASSES.evidenceId)).map(textOf);
  }

  for (const [name, bad] of [["a number", [123]], ["an empty string", [""]], ["null", [null]], ["an object", [{ id: "ev-1" }]], ["a good id beside a number", ["ev-1", 7]]] as const) {
    test(`a row whose evidenceIds holds ${name} is uncited-row`, () => {
      const messages = baseSurface();
      modelOf(messages).results.r1!.rows[0]!.evidenceIds = [...bad];
      expect(validated(messages).codes).toEqual(["uncited-row"]);
    });

    test(`a row whose bases holds ${name === "a good id beside a number" ? "a good basis beside a number" : name} is uncited-row`, () => {
      const messages = baseSurface();
      modelOf(messages).results.r1!.rows[0]!.bases = bad[0] === "ev-1" ? ["observed", 7] : [...bad];
      expect(validated(messages).codes).toEqual(["uncited-row"]);
    });

    test(`a graph edge whose evidenceIds holds ${name} is edge-without-fact, not uncited-row`, () => {
      const messages = graphSurface();
      modelOf(messages).results.g1!.edges[0]!.evidenceIds = [...bad];
      expect(validated(messages).codes).toEqual(["edge-without-fact"]);
    });

    test(`a graph edge whose bases holds ${name === "a good id beside a number" ? "a good basis beside a number" : name} is edge-without-fact`, () => {
      const messages = graphSurface();
      modelOf(messages).results.g1!.edges[0]!.bases = bad[0] === "ev-1" ? ["observed", 7] : [...bad];
      expect(validated(messages).codes).toEqual(["edge-without-fact"]);
    });
  }

  test("a number among the evidence ids is not dropped before resolution: the resolver is asked for it as drawn", () => {
    const rowSurface = baseSurface();
    modelOf(rowSurface).results.r1!.rows[0]!.evidenceIds = [123];
    expect(validated(rowSurface).asked).toEqual([["123"]]);
    expect(drawnEvidenceIds(rowSurface)).toEqual(["123"]);

    const edgeSurface = graphSurface();
    modelOf(edgeSurface).results.g1!.edges[0]!.evidenceIds = [123];
    expect(validated(edgeSurface).asked).toEqual([["123"]]);
    expect(drawnEvidenceIds(edgeSurface)).toEqual(["123"]);

    // and a resolver that does not know it reports it too
    const verdict = validateSurface(rowSurface, { resolveEvidence: receiptResolver(["ev-1"]) });
    expect(verdict.ok).toBe(false);
    expect(verdict.codes).toEqual(["uncited-row", "unresolved-evidence"]);
  });

  test("a valid table surface resolves exactly the ids it draws", () => {
    const messages = oneTableSurface([
      makeRow({ key: "a", evidenceIds: ["ev-1", "ev-2"] }),
      makeRow({ key: "b", evidenceIds: ["ev-2", "ev-3"] }),
    ]);
    const { codes, asked } = validated(messages);
    expect(codes).toEqual([]);
    expect(asked).toEqual([["ev-1", "ev-2", "ev-3"]]);
    expect([...new Set(drawnEvidenceIds(messages))]).toEqual(asked[0]!);
  });

  test("a valid graph surface resolves exactly the ids it draws", () => {
    const graph = makeGraphResult();
    graph.edges[0]!.evidenceIds = ["ev-g1", "ev-g2"];
    const messages = graphSurface(graph);
    const { codes, asked } = validated(messages);
    expect(codes).toEqual([]);
    expect(asked).toEqual([["ev-g1", "ev-g2"]]);
    expect(drawnEvidenceIds(messages)).toEqual(asked[0]!);
  });
});

describe("graph node labels wrap", () => {
  test("the node label of the graph's text list wraps at any character", () => {
    const block = /\.lk-node-label\s*\{([^}]*)\}/.exec(KIT_CSS);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    expect(block![1]).not.toMatch(/white-space:\s*nowrap|text-overflow/);
  });
});
