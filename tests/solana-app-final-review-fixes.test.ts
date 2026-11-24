/**
 * Independent regression tests for the final repairs to the Solana app and its kit, over the
 * approved Solana app contract (K5, K8, AC3, AC4, AC8, AC9, AC14) and the
 * recorded repair decisions of the app's final review (R1 to R3). Three behaviors:
 *
 *   R1  the explorer drawing retains every ordinary model edge, even when two edges share the
 *       same endpoint boxes and layer; each stays selectable by its own edge id with its own
 *       relation, parallel edges get distinct drawn paths, self-loops get nondegenerate visible
 *       paths, folded groups may bundle, gap ends survive, and no fact or evidence id is
 *       invented or dropped;
 *   R2  a CoverageNote describes notes, never arbitrary result rows: no row total is shown for
 *       unrelated notes (including accidental equal lengths), a shown-of-total appears only
 *       where every displayed note is exactly the full note text of a corresponding coverage
 *       row in the same order, and that count stays correct - the overview's routed coverage
 *       rows keep the overview count;
 *   R3  a real bind failure keeps its truthful port-bind diagnosis and exits 1; every other
 *       startup failure exits 1 with a generic truthful diagnosis that does not blame the port
 *       and never returns arbitrary exception text, checked with a synthetic private detail
 *       canary.
 *
 * Every expected value is derived from the approved contract and the recorded decisions, or is
 * recomputed from committed fixtures - never from what an implementation prints. The file runs
 * offline: fetch outside the loopback, WebSocket, Bun.connect and node:net/http(s) are trapped,
 * and the afterAll hook fails the file on any trapped attempt. These are regression tests for
 * review; they record no verdict.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";

/** bun:test of this checkout takes the timeout as the third argument; the long tests say it inline. */
const testT = (name: string, options: { timeout: number }, fn: () => unknown): void => {
  test(name, fn as () => void, options.timeout);
};
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as netNamespace from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";

import { explorerModel, groupId } from "../src/ui/explorer-model";
import { drawExplorer } from "../src/ui/explorer-draw";
import { instantiate } from "../src/ui/templates";
import { validateSurface, receiptResolver } from "../src/ui/validate";
import { interpret } from "../src/ui/interpret";
import type { A2uiMessage, GraphEdge, GraphResult, ResultSet, UiNode } from "../src/ui/types";

import { loadApp } from "../src/apps/solana/load";
import { run, parseArgs } from "../src/apps/solana/main";
import type { AppData, PackData, SeriesData } from "../src/apps/solana/model";
import { tabSurface, overviewResults } from "../src/apps/solana/surfaces";
import { render, resolverOver } from "../src/apps/solana/compose";
import { startApp } from "../src/apps/solana/app";
import { IDS } from "../src/apps/solana/chrome";

const ROOT = join(import.meta.dir, "..");
const LONG = 300_000;
const CANARY = "LK-PRIVATE-DETAIL:/home/private/meeting-notes/request-body.txt";
// The committed-data parallel-edge example the recorded decisions name: the Kamino Lend mint
// whose MINT_AUTHORITY and FREEZE_AUTHORITY both point at the same authority in Control.
const MINT = "solana:mainnet-beta:27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";

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
  // node:net keeps createServer (the in-process loopback helpers and the bind squatter use it);
  // its outbound members, and http(s) outright, are trapped.
  for (const mod of [netNamespace, httpModule, httpsModule] as unknown as Record<string, unknown>[]) {
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

// ---- shared loaded data ----
let data: AppData;
beforeAll(async () => {
  const loaded = await loadApp(undefined, {});
  data = loaded.data;
}, LONG);

// ---- walking drawn kit trees ----
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
const classesOf = (n: UiNode): string[] => (n.attrs.class ?? "").split(/\s+/).filter(Boolean);
const selectable = (root: UiNode, kind: string): { id: string; node: UiNode }[] =>
  findAll(root, (n) => n.attrs["data-lk-select"] === kind && n.attrs["data-lk-id"] !== undefined).map((n) => ({ id: n.attrs["data-lk-id"], node: n }));
const evidenceChips = (root: UiNode): string[] =>
  findAll(root, (n) => classesOf(n).includes("lk-evidence-id")).map((n) => n.text ?? "");
const distinctPaths = (root: UiNode): string[] =>
  [...new Set(findAll(root, (n) => n.tag === "path" && typeof n.attrs.d === "string" && n.attrs.d !== "").map((n) => n.attrs.d))];

// ---- synthetic graph builders (shapes from the published result model) ----
const gNode = (id: string, over: Record<string, unknown> = {}) => ({ id, label: `label of ${id}`, isolated: false, ...over });
const gEdge = (key: string, from: string, to: string, relation: string, over: Record<string, unknown> = {}): GraphEdge =>
  ({ key, from, to, relation, factIds: [`fact-${key}`], bases: ["decoded"], evidenceIds: [`evidence-${key}`], blockOrSlot: "7", asOf: null, layer: "Structure", ...over }) as GraphEdge;
const gGraph = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}): GraphResult =>
  ({ resultId: "g1", shape: "graph", coverage: "mapped", coverageNotes: [], nodes, edges, truncated: false, ...extra }) as unknown as GraphResult;

/* ------------------------------------------------------------------ */
/* R1 - the explorer keeps every ordinary edge                          */
/* ------------------------------------------------------------------ */
describe("R1: the explorer drawing retains every ordinary edge", () => {
  /** Two edges over the same endpoint boxes and the same layer, the case the repair is about. */
  const parallelGraph = (): GraphResult =>
    gGraph(
      [gNode("auth-a"), gNode("mint-b")],
      [
        gEdge("par-one", "auth-a", "mint-b", "MINT_AUTHORITY", { layer: "Control" }),
        gEdge("par-two", "auth-a", "mint-b", "FREEZE_AUTHORITY", { layer: "Control" }),
      ],
    );

  test("parallel same-layer edges are each kept, drawn and separately selectable", () => {
    const graph = parallelGraph();
    const model = explorerModel(graph, {}) as unknown as { edges: GraphEdge[] };
    expect(model.edges.map((e) => e.key).sort()).toEqual(["par-one", "par-two"]);
    for (const edge of graph.edges) {
      expect(model.edges.find((e) => e.key === edge.key), `${edge.key} stays the input edge`).toBe(edge);
      expect(model.edges.find((e) => e.key === edge.key)?.factIds, `${edge.key} keeps its fact ids`).toEqual(edge.factIds);
      expect(model.edges.find((e) => e.key === edge.key)?.evidenceIds, `${edge.key} keeps its evidence ids`).toEqual(edge.evidenceIds);
    }
    const drawn = drawExplorer(model as never);
    const ids = selectable(drawn, "edge").map((s) => s.id);
    expect(new Set(ids), "each parallel edge is selectable by its own id").toEqual(new Set(["par-one", "par-two"]));
    // Each keeps its own relation title in the drawn text list.
    const rows = selectable(drawn, "edge").filter((s) => classesOf(s.node).includes("lk-row"));
    for (const edge of graph.edges) {
      const own = rows.filter((r) => r.id === edge.key);
      expect(own.length, `${edge.key} has a text row`).toBeGreaterThan(0);
      expect(textOf(own[0].node), `${edge.key} row holds its relation`).toContain(edge.relation);
    }
    // Distinct drawn paths: identical endpoint boxes must not share one pointer target.
    const paths = distinctPaths(drawn);
    expect(paths.length, "one distinct path per drawn edge").toBe(2);
    // No evidence id invented or dropped; the model edges stay the input edges, so the
    // fact ids of each parallel edge are intact (the drawing cites evidence; the drawer
    // opens fact cards over the model's fact ids).
    const chips = [...new Set(evidenceChips(drawn))];
    expect(chips.sort()).toEqual(["evidence-par-one", "evidence-par-two"]);
  });

  test("two interpretations and two models of the same input are deep-equal", () => {
    const graph = parallelGraph();
    const a = explorerModel(graph, {}) as unknown as Record<string, unknown>;
    const b = explorerModel(graph, {}) as unknown as Record<string, unknown>;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(drawExplorer(a as never))).toBe(JSON.stringify(drawExplorer(b as never)));
  });

  test("a self-loop keeps a nondegenerate visible path and stays selectable", () => {
    const graph = gGraph([gNode("loop-a")], [gEdge("self-one", "loop-a", "loop-a", "OWNED_BY")]);
    const model = explorerModel(graph, {}) as unknown as { edges: GraphEdge[] };
    expect(model.edges.map((e) => e.key)).toEqual(["self-one"]);
    expect(model.edges[0], "the self-loop stays the input edge").toBe(graph.edges[0]);
    const drawn = drawExplorer(model as never);
    const ids = selectable(drawn, "edge").map((s) => s.id);
    expect(new Set(ids), "the self-loop is selectable by its own id").toContain("self-one");
    const paths = distinctPaths(drawn);
    expect(paths.length, "one distinct path for the one edge").toBe(1);
    // Nondegenerate: the path spans space in both dimensions instead of collapsing to a point.
    const numbers = (paths[0].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const xs = numbers.filter((_, at) => at % 2 === 0);
    const ys = numbers.filter((_, at) => at % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs), "the path spans x").toBeGreaterThan(0);
    expect(Math.max(...ys) - Math.min(...ys), "the path spans y").toBeGreaterThan(0);
  });

  test("edges over the same boxes in different layers all survive with their own layer mark", () => {
    const graph = gGraph(
      [gNode("multi-a"), gNode("multi-b")],
      [
        gEdge("mix-structure", "multi-a", "multi-b", "RESTS_ON", { layer: "Structure" }),
        gEdge("mix-control", "multi-a", "multi-b", "OWNED_BY", { layer: "Control" }),
      ],
    );
    const model = explorerModel(graph, {}) as unknown as { edges: GraphEdge[] };
    expect(model.edges.map((e) => e.key).sort()).toEqual(["mix-control", "mix-structure"]);
    const drawn = drawExplorer(model as never);
    const ids = new Set(selectable(drawn, "edge").map((s) => s.id));
    expect(ids).toEqual(new Set(["mix-structure", "mix-control"]));
    // Each edge's own layer mark: the drawing marks the svg group, the text row carries the rest.
    const marks = selectable(drawn, "edge").flatMap((s) => classesOf(s.node));
    expect(marks, "the structure edge carries its layer").toContain("lk-layer-structure");
    expect(marks, "the control edge carries its layer").toContain("lk-layer-control");
  });

  test("edges that end at none or unknown stay gap ends with their own ids and citations", () => {
    const graph = gGraph(
      [gNode("gap-a")],
      [
        gEdge("gap-none", "gap-a", "none", "PRICED_BY", { to: "none" as never }),
        gEdge("gap-unknown", "gap-a", "unknown", "HELD_BY", { to: "unknown" as never }),
      ],
    );
    const model = explorerModel(graph, {}) as unknown as { edges: GraphEdge[]; gapEdges: GraphEdge[]; gapEnds: { edgeKey: string; end: string }[] };
    expect(model.edges, "no ordinary edge is invented for a gap end").toEqual([]);
    expect(model.gapEdges.map((e) => e.key).sort()).toEqual(["gap-none", "gap-unknown"]);
    for (const edge of graph.edges) expect(model.gapEdges.find((e) => e.key === edge.key), `${edge.key} stays the input edge`).toBe(edge);
    expect(model.gapEnds.map((g) => g.end).sort()).toEqual(["none", "unknown"]);
    const drawn = drawExplorer(model as never);
    const ids = new Set(selectable(drawn, "edge").map((s) => s.id));
    expect(ids, "both gap edges are drawn under their own ids").toEqual(new Set(["gap-none", "gap-unknown"]));
    const text = textOf(drawn);
    expect(text).toContain("none");
    expect(text).toContain("unknown");
    expect([...new Set(evidenceChips(drawn))].sort()).toEqual(["evidence-gap-none", "evidence-gap-unknown"]);
  });

  testT("a folded group bundles only beyond the first four by name and drops nothing", { timeout: 60_000 }, () => {
    const graph = gGraph(
      [gNode("hub"), ...Array.from({ length: 10 }, (_, i) => gNode(`leaf-${i}`))],
      Array.from({ length: 10 }, (_, i) => gEdge(`fold-${i}`, "hub", `leaf-${i}`, "RESTS_ON")),
    );
    const id = groupId("hub", "RESTS_ON", "out");
    const folded = explorerModel(graph, { focus: "hub", steps: 1 }) as unknown as {
      edges: GraphEdge[]; groups: { id: string; memberIds: string[]; expanded: boolean }[]; nodes: { id: string; foldedInto: string | null }[];
    };
    expect(folded.edges, "folding drops no edge from the model").toHaveLength(10);
    expect(folded.groups).toHaveLength(1);
    expect(folded.groups[0].id).toBe(id);
    expect(folded.groups[0].memberIds, "the members beyond the first four by name").toEqual(["leaf-4", "leaf-5", "leaf-6", "leaf-7", "leaf-8", "leaf-9"]);
    const drawn = drawExplorer(folded as never);
    expect(selectable(drawn, "group").map((s) => s.id), "the folded group is drawn and activatable").toContain(id);
    expect(findAll(drawn, (n) => classesOf(n).includes("lk-edge-bundle")).length, "the folded bundle mark is drawn").toBeGreaterThan(0);
    // Expanding the group restores every neighbour and every edge; nothing was lost.
    const expanded = explorerModel(graph, { focus: "hub", steps: 1, expanded: [id] }) as unknown as {
      edges: GraphEdge[]; nodes: { id: string; foldedInto: string | null }[];
    };
    expect(expanded.edges).toHaveLength(10);
    expect(expanded.nodes.every((n) => n.foldedInto === null), "no node stays folded once the group is expanded").toBe(true);
    expect(new Set(selectable(drawExplorer(expanded as never), "edge").map((s) => s.id)), "all ten edges drawn under their own ids")
      .toEqual(new Set(graph.edges.map((e) => e.key)));
  });

  test("negative control: a single edge draws exactly one selectable edge over one path", () => {
    const graph = gGraph([gNode("solo-a"), gNode("solo-b")], [gEdge("only-one", "solo-a", "solo-b", "RESTS_ON")]);
    const model = explorerModel(graph, {}) as unknown as { edges: GraphEdge[] };
    expect(model.edges).toHaveLength(1);
    const drawn = drawExplorer(model as never);
    expect(new Set(selectable(drawn, "edge").map((s) => s.id))).toEqual(new Set(["only-one"]));
    expect(distinctPaths(drawn)).toHaveLength(1);
    expect([...new Set(evidenceChips(drawn))]).toEqual(["evidence-only-one"]);
  });

  testT("committed data: the Kamino Lend mint keeps both authority edges to one controller", { timeout: 60_000 }, () => {
    const pack = data.packs.find((p) => p.id === "kamino-lend")!;
    const series = pack.series.find((s) => s.id === "main-market")!;
    const graph = series.results.graph as unknown as GraphResult;
    const authorities = graph.edges.filter((e) => e.from === MINT && (e.relation === "MINT_AUTHORITY" || e.relation === "FREEZE_AUTHORITY"));
    // Precondition from the committed capture: two authority edges, one target, both Control.
    expect(authorities.map((e) => e.relation).sort()).toEqual(["FREEZE_AUTHORITY", "MINT_AUTHORITY"]);
    expect(new Set(authorities.map((e) => e.to)).size, "both authorities name the same controller").toBe(1);
    expect(new Set(authorities.map((e) => e.layer))).toEqual(new Set(["Control"]));

    const model = explorerModel(graph, { focus: MINT, steps: 1 }) as unknown as { edges: GraphEdge[] };
    for (const edge of authorities) {
      expect(model.edges.find((e) => e.key === edge.key), `${edge.relation} stays the committed edge`).toBe(edge);
      expect(model.edges.find((e) => e.key === edge.key)?.factIds, `${edge.relation} keeps its fact ids`).toEqual(edge.factIds);
    }
    const drawn = drawExplorer(model as never);
    const ids = new Set(selectable(drawn, "edge").map((s) => s.id));
    for (const edge of authorities) expect(ids, `${edge.relation} is selectable by its own id`).toContain(edge.key);
    // Each of the drawn edges owns one distinct path, so the two same-box authority edges
    // cannot hide each other's pointer target.
    expect(distinctPaths(drawn).length, "one distinct path per drawn edge").toBeGreaterThanOrEqual(model.edges.length);
    const rows = selectable(drawn, "edge").filter((s) => classesOf(s.node).includes("lk-row"));
    for (const edge of authorities) {
      const own = rows.filter((r) => r.id === edge.key);
      expect(own.length, `${edge.relation} has a text row`).toBeGreaterThan(0);
      expect(textOf(own[0].node), `${edge.relation} row holds its relation`).toContain(edge.relation);
    }
    const known = new Set(graph.edges.flatMap((e) => e.evidenceIds));
    for (const chip of evidenceChips(drawn)) expect(known.has(chip), `no invented evidence id (${chip})`).toBe(true);
    for (const edge of authorities) for (const id of edge.evidenceIds) expect(textOf(drawn), `${id} is not dropped`).toContain(id);
  });
});

/* ------------------------------------------------------------------ */
/* R2 - coverage notes describe notes, not result rows                  */
/* ------------------------------------------------------------------ */
describe("R2: a CoverageNote never shows a row total for unrelated notes", () => {
  const resolver = receiptResolver(new Set(["ev-1"]));
  const factRow = (key: string): Record<string, unknown> => ({
    rowKind: "fact", key, values: { subject: "subject A", predicate: "predicate P", object: "object B" },
    factIds: [], bases: ["decoded"], evidenceIds: ["ev-1"], blockOrSlot: "7", asOf: null, snapshotIds: ["snap-1"],
  });
  const COVCOLS = [{ name: "mechanic", role: "label" }, { name: "note", role: "note" }];
  /** A coverage row whose note cell is exactly its text, the shape the committed routed rows hold. */
  const covRow = (note: string): Record<string, unknown> => ({
    rowKind: "coverage", key: note, values: { mechanic: note.split(" ").slice(-2).join(" "), note },
    factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: ["snap-1"],
  });
  const result = (rows: unknown[], notes: string[], extra: Record<string, unknown> = {}): ResultSet =>
    ({ resultId: "t1", shape: "table", coverage: "partial", coverageNotes: notes, rows, truncated: false,
       columns: [{ name: "subject", role: "subject" }, { name: "predicate", role: "label" }, { name: "object", role: "address" }], ...extra }) as unknown as ResultSet;

  /** Draws one CoverageNote over one result through the second catalog and reports what it shows. */
  const draw = (one: ResultSet): { text: string; coverage: string; valid: boolean; codes: string[] } => {
    const messages = [
      { version: "v0.9.1", createSurface: { surfaceId: "s", catalogId: "linchpin.evidence.v2" } },
      { version: "v0.9.1", updateDataModel: { surfaceId: "s", path: "/", value: { meta: { snapshotIds: [] }, results: { t1: one } } } },
      { version: "v0.9.1", updateComponents: { surfaceId: "s", components: [
        { id: "root", component: "Column", children: ["c-0"] },
        { id: "c-0", component: "CoverageNote", result: { path: "/results/t1" } },
      ] } },
    ] as unknown as A2uiMessage[];
    const checked = validateSurface(messages, { resolveEvidence: resolver });
    const tree = interpret(messages);
    const coverage = findAll(tree.root, (n) => classesOf(n).includes("lk-coverage")).map(textOf).join("\n");
    return { text: textOf(tree.root), coverage, valid: checked.ok, codes: checked.codes };
  };
  const countMarks = (text: string): string[] => text.match(/\d+ of \d+/g) ?? [];

  const NOTES = ["coverage note one about mechanics and members", "coverage note two about captures and owners"];

  test("a valid partial result with two notes shows the notes verbatim and no row count", () => {
    const drawn = draw(result(Array.from({ length: 25 }, (_, i) => factRow(`k${i}`)), NOTES));
    expect(drawn.valid, JSON.stringify(drawn.codes)).toBe(true);
    expect(drawn.coverage).toContain(NOTES[0]);
    expect(drawn.coverage).toContain(NOTES[1]);
    expect(countMarks(drawn.text), "no shown-of-total stands for the two notes over 25 rows").toEqual([]);
    expect(drawn.text).not.toContain("2 of 25");
  });

  test("accidental equal lengths, mismatched text, wrong order and half a match all stay uncounted", () => {
    const cases: [string, ResultSet, string[]][] = [
      ["two notes over two unrelated fact rows", result([factRow("a"), factRow("b")], NOTES), NOTES],
      ["two coverage rows whose note cells differ", result([covRow("something else entirely"), covRow(NOTES[1])], NOTES, { columns: COVCOLS }), NOTES],
      ["matching coverage rows in the wrong order", result([covRow(NOTES[1]), covRow(NOTES[0])], NOTES, { columns: COVCOLS }), NOTES],
      ["one matched note of two", result([covRow(NOTES[0]), factRow("x")], NOTES), NOTES],
      ["coverage rows with no notes at all", result([covRow(NOTES[0]), covRow(NOTES[1])], [], { columns: COVCOLS }), []],
    ];
    for (const [label, one, shownNotes] of cases) {
      const drawn = draw(one);
      expect(drawn.valid, `${label}: ${JSON.stringify(drawn.codes)}`).toBe(true);
      expect(countMarks(drawn.text), `${label}: no row total may stand for the notes`).toEqual([]);
      if (shownNotes.includes(NOTES[0])) {
        expect(drawn.coverage, `${label}: notes drawn verbatim`).toContain(NOTES[0]);
        expect(drawn.coverage).toContain(NOTES[1]);
      }
      for (const missing of NOTES.filter((n) => !shownNotes.includes(n))) {
        expect(drawn.coverage.includes(missing), `${label}: a note with no note record is not invented`).toBe(false);
      }
    }
  });

  test("the one-to-one representation keeps a correct shown-of-total, cut or not", () => {
    // Every displayed note is exactly the full note text of a corresponding coverage row, in order.
    const whole = draw(result([covRow(NOTES[0]), covRow(NOTES[1])], NOTES, { columns: COVCOLS }));
    expect(whole.valid).toBe(true);
    expect(whole.coverage).toContain(NOTES[0]);
    expect(whole.coverage).toContain(NOTES[1]);
    expect(countMarks(whole.coverage), "an uncut one-to-one pair counts 2 of its 2 rows when the cut result carries its total").toEqual([]);
    const cut = draw(result([covRow(NOTES[0]), covRow(NOTES[1])], NOTES, { columns: COVCOLS, truncated: true, total: 7 }));
    expect(countMarks(cut.coverage), "a cut one-to-one pair counts 2 of its 7 rows").toEqual(["2 of 7"]);
    // The same shape with anything but an exact ordered match draws no count at all.
    const cutMismatch = draw(result([covRow("other text"), covRow(NOTES[1])], NOTES, { columns: COVCOLS, truncated: true, total: 7 }));
    expect(countMarks(cutMismatch.text), "a cut but unmatched pair stays uncounted").toEqual([]);
  });

  test("v1 compatibility: the first catalog's coverage template draws the same way", () => {
    const messages = instantiate("coverage", {
      surfaceId: "s1",
      meta: { snapshotIds: ["snap-1"] },
      results: [result(Array.from({ length: 25 }, (_, i) => factRow(`v${i}`)), NOTES)],
    });
    const checked = validateSurface(messages, { resolveEvidence: resolver });
    expect(checked.ok, JSON.stringify(checked.codes)).toBe(true);
    const tree = interpret(messages);
    const text = textOf(tree.root);
    expect(text).toContain(NOTES[0]);
    expect(text).toContain(NOTES[1]);
    expect(countMarks(text), "the v1 coverage template shows no row total for the notes").toEqual([]);
    expect(text).not.toContain("2 of 25");
  });

  testT("committed data: the value-path tab carries its notes verbatim and no borrowed row count", { timeout: LONG }, () => {
    const pack = data.packs.find((p) => p.id === "kamino-lend")!;
    const series = pack.series.find((s) => s.id === "main-market")!;
    const known = new Set(Object.keys(data.receipts));
    for (const read of data.positions?.reads ?? []) for (const id of Object.keys(read.receipts)) known.add(id);
    const messages = tabSurface(data, pack, series, "value-path");
    expect(messages).not.toBeNull();
    const out = render(messages!, resolverOver(known));
    expect(out.ok, JSON.stringify(out.ok ? [] : out.codes)).toBe(true);
    const text = out.ok ? textOf(out.tree.root) : "";
    // The recorded notes of the mechanics the adapters do not map, verbatim (AC7).
    const routed = (overviewResults(series) as unknown as ResultSet[]).find((r) => r.resultId === "routed")!;
    expect(routed.coverageNotes.length, "the committed routed notes exist").toBeGreaterThan(0);
    for (const note of routed.coverageNotes) expect(text, `note drawn verbatim: ${note.slice(0, 40)}...`).toContain(note);
    // No row total anywhere on this tab: its notes are not result rows.
    expect(countMarks(text), "no shown-of-total borrows the count of unrelated rows").toEqual([]);
  });
});

describe("R2: the overview keeps the count of its routed coverage rows", () => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  type Ev = { preventDefault: () => void; stopPropagation?: () => void; key?: string };
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
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
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

  testT("every routed and unknown block counts its own full result and draws its notes in order", { timeout: LONG }, () => {
    for (const pack of data.packs) {
      for (const series of pack.series) {
        const overview = overviewResults(series) as unknown as (ResultSet & { total?: number })[];
        const byId = new Map(overview.map((r) => [r.resultId, r]));
        const doc = new FakeDocument();
        const location = { hash: `#/protocols/${pack.id}/${series.id}/overview` };
        const handlers: (() => void)[] = [];
        const app = startApp({
          document: doc,
          location,
          addEventListener: (type: string, handler: () => void) => {
            if (type === "hashchange") handlers.push(handler);
          },
          sessionStorage: { getItem: () => null, setItem: () => {} },
          data,
        } as never);
        location.hash = `#/protocols/${pack.id}/${series.id}/overview`;
        for (const fn of [...handlers]) fn();
        app.draw();
        const main = doc.getElementById(IDS.main);
        for (const blockId of ["routed", "unknown"] as const) {
          const block = main.walk().find((el) => el.attr("data-block") === blockId);
          expect(block, `${pack.id}/${series.id}/${blockId} block exists`).toBeDefined();
          const one = byId.get(blockId)!;
          expect(one, `${pack.id}/${series.id}/${blockId} overview result exists`).toBeDefined();
          const rows = one.rows as { rowKind?: string; values?: Record<string, unknown> }[];
          const cuts = block!.classed("lk-cut").map((el) => el.textContent ?? "").filter((t) => /\d+ of \d+/.test(t));
          expect(cuts.length, `${pack.id}/${series.id}/${blockId} has one count line`).toBeGreaterThan(0);
          const expected = `${rows.length} of ${typeof one.total === "number" ? one.total : rows.length}`;
          expect(cuts[0].match(/\d+ of \d+/)?.[0], `${pack.id}/${series.id}/${blockId} count equals its own full result`).toBe(expected);
          if (blockId === "routed") {
            // Where the routed rows are the notes themselves (Kamino family: coverage rows
            // whose note cell is the note), every drawn note is its row's own note text, in
            // order; the count line stays the rows' count.
            const drawnNotes = block!.classed("lk-coverage-note").map((el) => el.textContent ?? "");
            const drawnRows = block!.classed("lk-row").map((el) => el.textContent ?? "");
            const notes = one.coverageNotes;
            const representable = notes.length === rows.length;
            expect(drawnNotes.length + drawnRows.length, `${pack.id}/${series.id}/routed draws its rows or its notes`).toBe(rows.length);
            if (representable) {
              rows.forEach((row, at) => {
                expect(row.rowKind, `${pack.id}/${series.id}/routed row ${at} kind`).toBe("coverage");
                const drawn = drawnNotes.length > 0 ? drawnNotes[at] : drawnRows[at];
                expect(drawn, `${pack.id}/${series.id}/routed note ${at} holds its note in order`).toContain(notes[at]);
              });
            }
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* R3 - truthful startup diagnoses                                      */
/* ------------------------------------------------------------------ */
describe("R3: startup failures diagnose truthfully and exit 1", () => {
  const ADDRESS = "435caVKK3he5pABWSadbpRbmBJQtfCzs9pbBB5b4zcFp";
  const minimalData = (): AppData => ({
    version: 1, build: "public", mode: "served", packs: [], absent: [], receipts: {},
    positions: null, replayAddress: ADDRESS, live: false, ask: { enabled: false },
  });
  const envNoRpc = { ...process.env } as Record<string, string | undefined>;
  delete envNoRpc.LINCHPIN_RPC_URL;
  const PROBE = "tests/fixtures/solana-app-final-review-fixes/startup-probe.ts";

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = netNamespace.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { port: number };
        server.close(() => resolve(address.port));
      });
      server.on("error", reject);
    });

  /** Runs `run` with console.error captured; restores the capture however the call ends. */
  const captureErrors = async (fn: () => Promise<unknown>): Promise<{ lines: string[]; value: unknown; threw: unknown }> => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
    let value: unknown;
    let threw: unknown;
    try {
      value = await fn();
    } catch (e) {
      threw = e;
    } finally {
      console.error = orig;
    }
    return { lines, value, threw };
  };
  const diagnosis = (lines: string[]): string[] => lines.filter((l) => !l.includes("reading the committed captures"));

  testT("a healthy build returns 0 and writes its self-contained file", { timeout: LONG }, async () => {
    const out = mkdtempSync(join(tmpdir(), "solana-app-final-build-"));
    try {
      const { lines, value, threw } = await captureErrors(() => run({ command: "build", out }, async () => data));
      expect(threw, `a healthy build must not throw: ${String(threw).slice(0, 200)}`).toBeUndefined();
      expect(value, "the build command exits 0").toBe(0);
      const file = join(out, "index.html");
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size, "the built file is nonempty").toBeGreaterThan(1000);
      expect(diagnosis(lines).length, "no diagnosis line on success").toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a server-start failure that is not a bind returns 1 with a generic diagnosis, not a port blame", async () => {
    const port = await freePort();
    const { lines, value, threw } = await captureErrors(() => run({ command: "serve", port, live: false }, async () => ({ junk: true }) as unknown as AppData));
    expect(threw, `run must return, not throw: ${String(threw).slice(0, 200)}`).toBeUndefined();
    expect(value, "the failed serve exits 1").toBe(1);
    const told = diagnosis(lines);
    expect(told.length, `exactly one diagnosis line: ${JSON.stringify(lines)}`).toBe(1);
    expect(told[0], "the diagnosis does not blame the port").not.toContain("port");
    expect(told[0]).not.toContain(String(port));
    expect(lines.join("\n"), "no stack frames in the output").not.toContain("    at ");
  });

  test("a rejected load returns 1 with the generic diagnosis and never the exception text", async () => {
    const port = await freePort();
    const boom = Object.assign(new Error(`synthetic load failure ${CANARY}`), { code: "ENOENT" });
    const { lines, value, threw } = await captureErrors(() => run({ command: "serve", port, live: false }, async () => {
      throw boom;
    }));
    expect(threw, `run must return, not throw, on a rejected load: ${String(threw)}`).toBeUndefined();
    expect(value, "the failed startup exits 1").toBe(1);
    const told = diagnosis(lines);
    expect(told.length, `exactly one diagnosis line: ${JSON.stringify(lines)}`).toBe(1);
    expect(told[0], "the diagnosis does not blame the port").not.toContain("port");
    expect(lines.join("\n"), "the private detail canary never reaches the operator").not.toContain(CANARY);
    expect(lines.join("\n"), "no stack frames in the output").not.toContain("    at ");
  });

  testT("a fresh subprocess over a really occupied port keeps the truthful port-bind diagnosis", { timeout: LONG }, () => {
    let stopped = false;
    const squatter = netNamespace.createServer();
    squatter.listen(0, "127.0.0.1");
    const port = (squatter.address() as { port: number }).port;
    try {
      const proc = Bun.spawnSync(["bun", "run", PROBE, "bind", String(port)], {
        cwd: ROOT, stdout: "pipe", stderr: "pipe", env: envNoRpc as never, timeout: 120_000,
      });
      expect(proc.exitCode, `the bind failure exits 1 (stderr: ${proc.stderr.toString().slice(0, 200)})`).toBe(1);
      const lines = proc.stderr.toString().trim().split("\n");
      expect(lines.length, `exactly the reading line and one diagnosis: ${JSON.stringify(lines)}`).toBe(2);
      expect(lines[1], "the diagnosis names the bind truthfully").toContain("port");
      expect(lines[1], "the diagnosis names the port it could not bind").toContain(String(port));
      expect(proc.stderr.toString()).not.toContain("    at ");
    } finally {
      if (!stopped) squatter.close();
    }
  });

  testT("a fresh subprocess build whose assets fail exits 1 with a generic diagnosis and no arbitrary text", { timeout: LONG }, async () => {
    const out = mkdtempSync(join(tmpdir(), "solana-app-final-probe-"));
    try {
      const proc = Bun.spawnSync(["bun", "run", PROBE, "build-fail", out], {
        cwd: ROOT, stdout: "pipe", stderr: "pipe", env: envNoRpc as never, timeout: 120_000,
      });
      expect(proc.exitCode, `the failed build exits 1 (stderr: ${proc.stderr.toString().slice(0, 300)})`).toBe(1);
      const stderr = proc.stderr.toString();
      expect(stderr, "the private detail canary never reaches the operator").not.toContain(CANARY);
      expect(stderr, "no stack frames in the output").not.toContain("    at ");
      const told = stderr.trim().split("\n").filter((l) => l.trim() !== "" && !l.includes("reading the committed captures"));
      expect(told.length, `exactly one generic diagnosis line: ${JSON.stringify(stderr)}`).toBeGreaterThanOrEqual(1);
      expect(told.join("\n"), "a failed build must not blame a port").not.toContain("port");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
