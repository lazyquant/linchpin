/**
 * The default of the desk page: a long table or list of a view is drawn folded, inside a native disclosure that
 * starts closed, and nothing the kit drew is left out of it.
 * 1. The rule on small trees: where the limit is, what the summary line holds, what is never folded.
 * 2. The rule on the page the look is taken from (the synthetic book on the constructed snapshot, compared with the
 *    recorded one): every edge, rule, change and unknown of the surfaces is still in the tree, with its evidence.
 * Offline: no server is started and no connection is opened; the state is loaded from committed fixtures.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { FOLD_OVER_ROWS, viewTree } from "../src/desk/chrome";
import { loadDeskState, type DeskState } from "../src/desk/state";
import { DESK_STRINGS } from "../src/desk/strings";
import { buildPositionsSurface, buildSurface, DESK_VIEWS } from "../src/desk/surfaces";
import { treeToHtml } from "../src/ui/html";
import { interpret } from "../src/ui/interpret";
import type { A2uiMessage, GraphResult, ResultSet, SurfaceTree, UiNode } from "../src/ui/types";

/* ---------- helpers ---------- */

const classes = (node: UiNode): string[] => (node.attrs.class ?? "").split(/\s+/).filter(Boolean);
const has = (node: UiNode, name: string): boolean => classes(node).includes(name);
const isFold = (node: UiNode): boolean => node.tag === "details" && has(node, "desk-fold");
const textOf = (node: UiNode): string => (node.text ?? "") + node.children.map(textOf).join("");

/** Every node with the chain of nodes above it, in document order. */
function walk(root: UiNode): { node: UiNode; above: UiNode[] }[] {
  const out: { node: UiNode; above: UiNode[] }[] = [];
  const visit = (node: UiNode, above: UiNode[]): void => {
    out.push({ node, above });
    for (const child of node.children) visit(child, [...above, node]);
  };
  visit(root, []);
  return out;
}

const find = (root: UiNode, pred: (node: UiNode) => boolean): UiNode[] => walk(root).filter(({ node }) => pred(node)).map(({ node }) => node);
const folds = (root: UiNode): UiNode[] => find(root, isFold);
const inFold = (root: UiNode, target: UiNode): boolean => walk(root).some(({ node, above }) => node === target && above.some(isFold));

/** The summary lines the desk adds for a table or a list the kit drew without a label of its own. */
const isAddedSummary = (node: UiNode): boolean => node.tag === "summary" && has(node, "desk-fold-summary") && node.text === DESK_STRINGS.foldRows;

/** Every text of a tree in document order, without the summary lines the desk adds. */
function texts(root: UiNode): string[] {
  const out: string[] = [];
  const visit = (node: UiNode): void => {
    if (isAddedSummary(node)) return;
    if (node.text !== undefined && node.text !== "") out.push(node.text);
    node.children.forEach(visit);
  };
  visit(root);
  return out;
}

const node = (tag: string, className: string, children: UiNode[] = [], text?: string): UiNode =>
  (text === undefined ? { tag, attrs: { class: className }, children } : { tag, attrs: { class: className }, children, text });
const surface = (children: UiNode[]): SurfaceTree => ({ surfaceId: "test", deleted: false, root: node("main", "lk-surface", children), errors: [] });

function kitTable(rows: number): UiNode {
  return node("table", "lk-table", [
    node("thead", "", [node("tr", "", [node("th", "", [], "rule")])]),
    node("tbody", "", Array.from({ length: rows }, (_, at) => node("tr", "lk-row", [node("td", "", [], `row-${at}`)]))),
  ]);
}
const kitList = (className: string, items: number): UiNode => node("ul", className, Array.from({ length: items }, (_, at) => node("li", "lk-row", [], `item-${at}`)));
const kitLabel = (word: string, count: number): UiNode => node("p", "lk-list-label", [node("span", "lk-count", [], String(count))], word);

/* ---------- the rule ---------- */

describe("the fold rule", () => {
  test("a table at the limit stays open; one row more is folded, closed, behind a summary that counts its rows", () => {
    const short = kitTable(FOLD_OVER_ROWS);
    const long = kitTable(FOLD_OVER_ROWS + 1);
    const view = viewTree(surface([node("section", "lk-section", [short]), node("section", "lk-section", [long])]));

    expect(inFold(view, short)).toBe(false);
    const [fold, ...others] = folds(view);
    expect(others).toEqual([]);
    expect(fold.attrs).toEqual({ class: "desk-fold" });
    expect(fold.attrs.open).toBeUndefined();
    expect(fold.children).toHaveLength(2);
    const [summary, body] = fold.children;
    expect(summary.tag).toBe("summary");
    expect(summary.text).toBe(DESK_STRINGS.foldRows);
    expect(summary.children.map((child) => [classes(child), child.text])).toEqual([[["lk-count"], String(FOLD_OVER_ROWS + 1)]]);
    // The folded node is the kit's own node, not a copy and not a cut.
    expect(body).toBe(long);
  });

  test("a graph list takes the kit's label as its summary line; the label is not drawn twice", () => {
    const nodesLabel = kitLabel("Nodes", 9);
    const nodes = kitList("lk-graph-nodes", 9);
    const edgesLabel = kitLabel("Edges", 8);
    const edges = kitList("lk-graph-edges", 8);
    const view = viewTree(surface([node("figure", "lk-graph", [node("div", "lk-graph-frame", [node("svg", "lk-graph-svg")]), nodesLabel, nodes, edgesLabel, edges])]));

    const found = folds(view);
    expect(found.map((fold) => fold.children[1])).toEqual([nodes, edges]);
    expect(found.map((fold) => [fold.children[0].tag, fold.children[0].text, textOf(fold.children[0])])).toEqual([["summary", "Nodes", "Nodes9"], ["summary", "Edges", "Edges8"]]);
    expect(found.map((fold) => fold.children[0].children[0])).toEqual([nodesLabel.children[0], edgesLabel.children[0]]);
    expect(find(view, (item) => item.tag === "p" && has(item, "lk-list-label"))).toEqual([]);
    expect(texts(view)).toEqual(["Nodes", "9", ...nodes.children.map((item) => item.text!), "Edges", "8", ...edges.children.map((item) => item.text!)]);
  });

  test("a short graph list keeps its label and stays open; an empty edge list keeps its note", () => {
    const label = kitLabel("Nodes", 2);
    const nodes = kitList("lk-graph-nodes", 2);
    const edgesLabel = kitLabel("Edges", 0);
    const empty = node("p", "lk-empty", [], "No edges in this result");
    const edges = kitList("lk-graph-edges", 0);
    const figure = node("figure", "lk-graph", [label, nodes, edgesLabel, empty, edges]);
    const view = viewTree(surface([figure]));
    expect(folds(view)).toEqual([]);
    expect(view.children[0].children).toEqual([label, nodes, edgesLabel, empty, edges]);
  });

  test("the list of unknowns folds like a table; a drawing, a note and a short list of another kind never fold", () => {
    const unknowns = kitList("lk-unknowns", FOLD_OVER_ROWS + 1);
    const drawing = node("svg", "lk-graph-svg", Array.from({ length: 40 }, () => node("g", "lk-graph-node")));
    const note = node("aside", "lk-coverage", [node("p", "lk-coverage-note", [], "a note")]);
    const buttons = kitList("desk-buttons", 40);
    const view = viewTree(surface([unknowns, drawing, note, buttons]));
    expect(folds(view).map((fold) => fold.children[1])).toEqual([unknowns]);
    expect(view.children.slice(1)).toEqual([drawing, note, buttons]);
  });

  test("the tree the kit drew is left as it was", () => {
    const long = kitTable(FOLD_OVER_ROWS + 3);
    const tree = surface([node("section", "lk-section", [long])]);
    const before = JSON.stringify(tree);
    viewTree(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });

  test("the stylesheet gives the summary line a pointer, a sign for each state, and hides nothing of an open fold", async () => {
    const css = await Bun.file(new URL("../src/desk/desk.css", import.meta.url)).text();
    expect(css).toMatch(/\.desk-fold-summary \{[^}]*cursor: pointer;/);
    expect(css).toMatch(/\.desk-fold-summary::before \{[^}]*content: "\+";/);
    expect(css).toMatch(/\.desk-fold\[open\] > \.desk-fold-summary::before \{[^}]*content: "\\2212";/);
    // No rule of the desk takes a fold, its summary or its content off the page. The one thing hidden is the
    // browser's own triangle, which the sign replaces.
    let checked = 0;
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!selector.includes("desk-fold") || selector === ".desk-fold-summary::-webkit-details-marker") continue;
      checked++;
      expect(rule[2], selector).not.toMatch(/display:\s*none|visibility:\s*hidden|max-height|overflow:\s*hidden/);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/* ---------- the page the look is taken from ---------- */

function resultsOf(messages: A2uiMessage[]): Record<string, ResultSet | GraphResult> {
  for (const message of messages) {
    if ("updateDataModel" in message) {
      const value = message.updateDataModel.value as { results?: Record<string, ResultSet | GraphResult> } | null;
      if (value?.results) return value.results;
    }
  }
  return {};
}

describe("the synthetic book, folded", () => {
  let state: DeskState;
  const messages: Record<string, A2uiMessage[]> = {};
  const drawn: Record<string, SurfaceTree> = {};
  const views: Record<string, UiNode> = {};
  const names = [...DESK_VIEWS, "positions"] as const;

  beforeAll(async () => {
    state = await loadDeskState(
      { policy: "quantrin-near-v1", snapshot: "near-constructed-intents-locker-added", before: "near-2026-11-09", addresses: [] },
      { readPositions: async () => ({ positions: [], receipts: [], notRead: [] }), env: {}, now: () => 0 },
    );
    for (const name of names) {
      messages[name] = name === "positions" ? buildPositionsSurface(state) : buildSurface(name, state);
      drawn[name] = interpret(messages[name]);
      expect(drawn[name].errors, name).toEqual([]);
      views[name] = viewTree(drawn[name]);
    }
  }, 600_000);

  test("every view holds every text the kit drew, in the same order, and every row the kit drew, as the same node", () => {
    for (const name of names) {
      expect(texts(views[name]), name).toEqual(texts(drawn[name].root));
      const kept = new Set(walk(views[name]).map(({ node: item }) => item));
      const rows = find(drawn[name].root, (item) => item.tag === "tr" || item.tag === "li");
      expect(rows.length, name).toBeGreaterThan(0);
      for (const row of rows) expect(kept.has(row), `${name}: a row of the kit's tree is not in the view`).toBe(true);
      // Every evidence chip of the kit is still there: a fold adds a disclosure and removes none.
      const chips = (root: UiNode): number => find(root, (item) => item.tag === "details" && has(item, "lk-chip")).length;
      expect(chips(views[name]), name).toBe(chips(drawn[name].root));
    }
  }, 60_000);

  test("every fold is a closed native disclosure: details without open, a summary first, one folded node", () => {
    let seen = 0;
    for (const name of names) {
      for (const fold of folds(views[name])) {
        seen++;
        expect(Object.keys(fold.attrs), name).toEqual(["class"]);
        expect(fold.children.map((child) => child.tag)[0], name).toBe("summary");
        expect(fold.children, name).toHaveLength(2);
        expect(textOf(fold.children[0]), name).toMatch(/^[A-Za-z]+[0-9]+$/);
      }
      const html = treeToHtml(views[name]);
      expect(html, name).not.toMatch(/<details[^>]*\sopen/);
    }
    expect(seen).toBeGreaterThan(0);
    expect(treeToHtml(views.map)).toContain('<details class="desk-fold"><summary class="lk-list-label desk-fold-summary">');
  }, 60_000);

  test("map: each long edge list is folded and still holds every edge of its position, with its relation and its evidence ids", () => {
    const results = resultsOf(messages.map);
    const lists = find(views.map, (item) => item.tag === "ul" && has(item, "lk-graph-edges"));
    const graphs = state.positions.map((_, at) => results[`pos-${at}`] as GraphResult | undefined).filter((graph): graph is GraphResult => graph !== undefined);
    expect(graphs.length).toBe(lists.length);
    expect(graphs.length).toBeGreaterThan(0);
    let folded = 0;
    let edges = 0;
    graphs.forEach((graph, at) => {
      const list = lists[at];
      expect(list.children, `pos-${at}`).toHaveLength(graph.edges.length);
      expect(inFold(views.map, list), `pos-${at}`).toBe(graph.edges.length > FOLD_OVER_ROWS);
      if (graph.edges.length > FOLD_OVER_ROWS) {
        folded++;
        const fold = folds(views.map).find((item) => item.children[1] === list)!;
        expect(textOf(fold.children[0])).toBe(`Edges${graph.edges.length}`);
      }
      graph.edges.forEach((edge, n) => {
        edges++;
        const row = list.children[n];
        expect(find(row, (item) => has(item, "lk-id")).map((item) => item.text), `pos-${at} edge ${edge.key}`).toEqual([edge.from, edge.to]);
        expect(find(row, (item) => has(item, "lk-relation")).map((item) => item.text)).toEqual([edge.relation]);
        expect(find(row, (item) => has(item, "lk-basis")).map((item) => item.text)).toEqual(edge.bases);
        expect(edge.evidenceIds.length).toBeGreaterThan(0);
        expect(find(row, (item) => has(item, "lk-evidence-id")).map((item) => item.text)).toEqual(edge.evidenceIds);
        expect(find(row, (item) => has(item, "lk-obs")).map((item) => item.text)).toEqual([String(edge.blockOrSlot ?? edge.asOf)]);
      });
    });
    expect(folded).toBeGreaterThan(0);
    expect(edges).toBeGreaterThan(FOLD_OVER_ROWS);
  }, 60_000);

  test("map: every drawing and every mark word in it stays open, and so does the legend", () => {
    const frames = find(views.map, (item) => has(item, "lk-graph-frame"));
    expect(frames.length).toBe(state.positions.length);
    for (const frame of frames) expect(inFold(views.map, frame)).toBe(false);
    const words = find(views.map, (item) => has(item, "lk-mark-word"));
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(inFold(views.map, word)).toBe(false);
    const legend = find(views.map, (item) => item.tag === "table")[0];
    expect(legend.children[1].children).toHaveLength(5);
    expect(inFold(views.map, legend)).toBe(false);
    // A long node list is folded like a long edge list; its marks are the ones the drawing shows.
    for (const list of find(views.map, (item) => item.tag === "ul" && has(item, "lk-graph-nodes"))) {
      expect(inFold(views.map, list)).toBe(list.children.length > FOLD_OVER_ROWS);
    }
  }, 60_000);

  test("verdict: the outcome and the summary stay open; the rule rows are folded, every rule with its outcome", () => {
    const results = resultsOf(messages.verdict);
    const tables = find(views.verdict, (item) => item.tag === "table");
    expect(tables).toHaveLength(3);
    const [outcome, summary, rules] = tables;
    expect(textOf(outcome)).toContain(state.review.publicVerdict.outcome);
    expect(inFold(views.verdict, outcome)).toBe(false);
    expect(inFold(views.verdict, summary)).toBe(false);
    const ruleRows = (results.rules as ResultSet).rows;
    expect(ruleRows.length).toBeGreaterThan(FOLD_OVER_ROWS);
    expect(inFold(views.verdict, rules)).toBe(true);
    const drawnRows = rules.children[1].children;
    expect(drawnRows).toHaveLength(ruleRows.length);
    ruleRows.forEach((row, at) => {
      const cells = drawnRows[at].children.map(textOf);
      expect(cells.slice(0, 3)).toEqual([DESK_STRINGS.colRule, DESK_STRINGS.colKind, DESK_STRINGS.colOutcome].map((column) => String(row.values[column])));
      expect(find(drawnRows[at], (item) => has(item, "lk-evidence-id")).map((item) => item.text)).toEqual(row.evidenceIds);
    });
    expect(textOf(folds(views.verdict)[0].children[0])).toBe(`${DESK_STRINGS.foldRows}${ruleRows.length}`);
  }, 60_000);

  test("words, changes, unknowns: a result longer than the limit is folded with every row; a shorter one is open", () => {
    const cases: [string, string, (root: UiNode) => UiNode[]][] = [
      ["words", "words", (root) => find(root, (item) => item.tag === "table")],
      ["changes", "dependency-changed", (root) => find(root, (item) => item.tag === "table")],
      ["unknowns", "unknowns", (root) => find(root, (item) => item.tag === "ul" && has(item, "lk-unknowns"))],
      ["positions", "positions", (root) => find(root, (item) => item.tag === "table")],
    ];
    const foldedViews: string[] = [];
    for (const [view, resultId, pick] of cases) {
      const rows = (resultsOf(messages[view])[resultId] as ResultSet).rows;
      const [holder] = pick(views[view]);
      expect(holder, view).toBeDefined();
      const drawnRows = holder.tag === "table" ? holder.children[1].children : holder.children;
      expect(drawnRows, view).toHaveLength(rows.length);
      expect(inFold(views[view], holder), view).toBe(rows.length > FOLD_OVER_ROWS);
      if (rows.length > FOLD_OVER_ROWS) foldedViews.push(view);
      rows.forEach((row, at) => {
        for (const value of Object.values(row.values)) if (typeof value === "string" && value !== "") expect(textOf(drawnRows[at]), `${view} row ${row.key}`).toContain(value);
        expect(find(drawnRows[at], (item) => has(item, "lk-evidence-id")).map((item) => item.text), `${view} row ${row.key}`).toEqual(row.evidenceIds);
      });
    }
    expect(foldedViews).toEqual(["words", "changes", "unknowns"]);
  }, 60_000);
});
