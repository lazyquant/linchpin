// Independent tests for the html-flowchart spec (AC1 to AC12), written from the spec, the
// gate-1 decisions (Q1, Q2, PC1) and the exported types, not from the implementation.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  FLOWCHART_STYLE_CSS,
  FLOWCHART_VIEWER_JS,
  FlowchartError,
  generateFlowchartHtml,
  hashFlowchartModel,
  loadFlowchartViewerCore,
  renderFlowchartHtml,
  toFlowchartModel,
  validateFlowchartHtml,
  type FlowchartInput,
  type FlowchartMark,
  type FlowchartModel,
  type FlowchartPresentation,
  type FlowchartProblem,
  type FlowchartProblemCode,
  type FlowchartSequence,
  type FlowchartViewState,
} from "../src/flowchart/index";
import * as dom from "./fixtures/html-flowchart/dom";
import {
  EVIL,
  canonicalJson,
  cmpEdge,
  cmpStr,
  deepFreeze,
  evidenceModel,
  hostileModel,
  independentHash,
  rehash,
  viewerModel,
  withoutHash,
} from "./fixtures/html-flowchart/models";

const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "tests", "fixtures", "html-flowchart");
const GRAPH_PATH = join(FIX, "graph.json");
const GRAPH = JSON.parse(readFileSync(GRAPH_PATH, "utf8"));
const CLI_TIMEOUT = 60_000;
const BASES = ["claimed", "reported", "decoded", "simulated", "observed", "derived", "unknown"] as const;
const VERIFICATIONS = ["verified", "unverified", "conflicting", "unresolved"] as const;
const PROBLEM_CODES = ["document", "active-content", "model-missing", "model-schema", "model-hash", "model-dangling", "render-mismatch", "source-invalid", "source-mismatch"];

const input = (graph: unknown): FlowchartInput => ({ source: "evidence-graph", graph });
const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------------------------------------
// Helpers

const MODEL_RE = /<script type="application\/json" id="linchpin-flowchart-model">([\s\S]*?)<\/script>/;

function modelBlock(html: string): string {
  const m = MODEL_RE.exec(html);
  if (!m) throw new Error("no model block");
  return m[1]!;
}

function modelOf(html: string): FlowchartModel {
  return JSON.parse(modelBlock(html));
}

/** Replace the model block; with `rehashIt`, recompute sha256 first (the mutation table's "rehashed"). */
function withModel(html: string, edit: (m: FlowchartModel) => void, rehashIt: boolean): string {
  const m = modelOf(html);
  edit(m);
  if (rehashIt) m.sha256 = hashFlowchartModel(withoutHash(m));
  const block = JSON.stringify(m).replace(/</g, "\\u003c");
  const out = html.replace(MODEL_RE, (_all, _inner) => `<script type="application/json" id="linchpin-flowchart-model">${block}</script>`);
  expect(out).not.toBe(html);
  return out;
}

/** Replace the first occurrence of `from` (which must occur) with `to`, never interpreting `$`. */
function sub(html: string, from: string, to: string, at = 0): string {
  const i = html.indexOf(from, at);
  if (i < 0) throw new Error(`mutation anchor not found: ${from.slice(0, 80)}`);
  return html.slice(0, i) + to + html.slice(i + from.length);
}

/** Remove from the start of `startMarker` through the first `endMarker` after it. */
function cut(html: string, startMarker: string, endMarker: string): string {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error(`cut anchor not found: ${startMarker}`);
  const j = html.indexOf(endMarker, i);
  if (j < 0) throw new Error(`cut end not found: ${endMarker}`);
  return html.slice(0, i) + html.slice(j + endMarker.length);
}

/** Apply `edit` to the start tag that begins with `startOfTag`. */
function editStartTag(html: string, startOfTag: string, edit: (tag: string) => string): string {
  const i = html.indexOf(startOfTag);
  if (i < 0) throw new Error(`start tag not found: ${startOfTag}`);
  const j = html.indexOf(">", i);
  const tag = html.slice(i, j);
  const next = edit(tag);
  expect(next).not.toBe(tag);
  return html.slice(0, i) + next + html.slice(j);
}

function changeOneLetter(html: string, block: string): string {
  const start = html.indexOf(block);
  expect(start).toBeGreaterThanOrEqual(0);
  for (let k = Math.floor(block.length / 2); k < block.length; k++) {
    const ch = block[k]!;
    if (/[a-z]/.test(ch)) {
      const repl = ch === "q" ? "x" : "q";
      return html.slice(0, start + k) + repl + html.slice(start + k + 1);
    }
  }
  throw new Error("no letter to change");
}

function expectProblem(problems: FlowchartProblem[], code: FlowchartProblemCode, ...includes: string[]) {
  const withCode = problems.filter((p) => p.code === code);
  if (withCode.length === 0) throw new Error(`expected a ${code} problem, got ${JSON.stringify(problems).slice(0, 600)}`);
  if (includes.length) {
    const ok = withCode.some((p) => includes.every((s) => p.detail.includes(s)));
    if (!ok) throw new Error(`expected a ${code} problem naming ${JSON.stringify(includes)}, got ${JSON.stringify(withCode).slice(0, 600)}`);
  }
}

function expectFlowchartError(fn: () => unknown, code: FlowchartProblemCode, ...includes: string[]): FlowchartError {
  let returned: unknown = "nothing thrown";
  try {
    returned = fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FlowchartError);
    const err = e as FlowchartError;
    expect(Array.isArray(err.problems)).toBe(true);
    expectProblem(err.problems, code, ...includes);
    return err;
  }
  throw new Error(`expected FlowchartError ${code}, but the call returned ${String(returned).slice(0, 200)}`);
}

const sha256hex = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const sha256b64 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("base64");

function expectedPolicy(): string {
  return `default-src 'none'; script-src 'sha256-${sha256b64(FLOWCHART_VIEWER_JS)}'; style-src 'sha256-${sha256b64(FLOWCHART_STYLE_CSS)}'; base-uri 'none'; form-action 'none'`;
}

function policyOf(p: dom.Parsed): string {
  const metas = p.all.filter((e) => e.tag === "meta" && dom.has(e, "http-equiv"));
  expect(metas.length).toBe(1);
  return dom.attr(metas[0]!, "content")!;
}

function sequenceLine(seq: FlowchartSequence | null): string {
  if (seq === null) return "No sequence";
  if (seq === "observed-execution") return "Sequence: observed-execution";
  return `Sequence: ${seq} (reading order, not an observed execution)`;
}

const FORBIDDEN_ELEMENTS = ["link", "iframe", "frame", "object", "embed", "img", "image", "audio", "video", "source", "base", "form", "input", "a", "use", "foreignobject"];
const FORBIDDEN_ATTRS = ["src", "href", "xlink:href", "srcset", "action", "formaction", "style", "hidden", "display", "visibility", "opacity"];

/** H1, H2 and H7, checked with the independent reader. */
function checkFrame(html: string, model: FlowchartModel) {
  // H1
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  expect(html.split("<!").length - 1).toBe(1);
  expect(html.includes("<?")).toBe(false);
  const p = dom.parse(html);
  expect(p.errors).toEqual([]);
  const heads = dom.tagsOf(p, "head");
  expect(heads.length).toBe(1);
  const firstInHead = dom.childEls(heads[0]!)[0]!;
  expect(firstInHead.tag).toBe("meta");
  expect(firstInHead.attrs).toEqual([["charset", "utf-8"]]);
  expect(html).toContain('<meta charset="utf-8">');
  const titles = dom.tagsOf(p, "title");
  expect(titles.length).toBe(1);
  expect(dom.text(titles[0]!)).toBe(model.title);

  // H2
  const scripts = dom.tagsOf(p, "script");
  expect(scripts.length).toBe(2);
  expect([...scripts[0]!.attrs].sort()).toEqual([["id", "linchpin-flowchart-model"], ["type", "application/json"]]);
  expect(scripts[1]!.attrs).toEqual([["id", "linchpin-flowchart-viewer"]]);
  expect(dom.text(scripts[1]!)).toBe(FLOWCHART_VIEWER_JS);
  const styles = dom.tagsOf(p, "style");
  expect(styles.length).toBe(1);
  expect(dom.text(styles[0]!)).toBe(FLOWCHART_STYLE_CSS);
  const metas = p.all.filter((e) => e.tag === "meta" && dom.has(e, "http-equiv"));
  expect(metas.length).toBe(1);
  expect(dom.attr(metas[0]!, "http-equiv")).toBe("Content-Security-Policy");
  expect(dom.attr(metas[0]!, "content")).toBe(expectedPolicy());
  const pos = (e: dom.El) => p.all.indexOf(e);
  expect(pos(metas[0]!)).toBeLessThan(pos(styles[0]!));
  expect(pos(metas[0]!)).toBeLessThan(pos(scripts[0]!));
  expect(pos(scripts[0]!)).toBeLessThan(pos(scripts[1]!));
  for (const e of p.all) {
    expect(FORBIDDEN_ELEMENTS).not.toContain(e.tag);
    for (const [n] of e.attrs) {
      expect(FORBIDDEN_ATTRS).not.toContain(n);
      expect(n.startsWith("on")).toBe(false);
    }
  }

  // H7
  const label = new Map(model.nodes.map((n) => [n.id, n.label]));
  for (const g of p.all.filter((e) => dom.has(e, "data-node-id"))) {
    expect(dom.attr(g, "tabindex")).toBe("0");
    expect(dom.attr(g, "aria-label")).toBe(label.get(dom.attr(g, "data-node-id")!)!);
  }
  const edgeById = new Map(model.edges.map((e) => [e.id, e]));
  for (const g of p.all.filter((e) => dom.has(e, "data-edge-id"))) {
    const e = edgeById.get(dom.attr(g, "data-edge-id")!)!;
    expect(dom.attr(g, "tabindex")).toBe("0");
    expect(dom.attr(g, "aria-label")).toBe(`${label.get(e.from)} ${e.relation} ${label.get(e.to)}`);
  }
  const aside = dom.oneById(p, "linchpin-flowchart-inspector");
  expect(aside.tag).toBe("aside");
  expect(dom.attr(aside, "aria-live")).toBe("polite");
  expect(dom.text(aside)).toBe("Select a node or an edge");
  for (const id of ["linchpin-flowchart-prev", "linchpin-flowchart-next"]) {
    const b = dom.oneById(p, id);
    expect(b.tag).toBe("button");
    expect(dom.attr(b, "type")).toBe("button");
    if (model.nodes.length === 0 && model.steps.length === 0) expect(dom.has(b, "disabled")).toBe(true);
    if (model.steps.length > 0) expect(dom.has(b, "disabled")).toBe(false);
  }
  return p;
}

/** H3 to H6, checked with the independent reader. */
function checkChart(html: string, model: FlowchartModel) {
  const p = dom.parse(html);
  expect(p.errors).toEqual([]);

  // H3 (Q1: every < is the JSON escape <, nothing else changed)
  const raw = modelBlock(html);
  expect(raw.includes("<")).toBe(false);
  expect(raw).toBe(JSON.stringify(JSON.parse(raw)).replace(/</g, "\\u003c"));
  const parsed = JSON.parse(raw);
  expect(parsed).toEqual(model);
  expect(Object.keys(parsed).sort()).toEqual(["edges", "nodes", "notes", "schema", "sequence", "sha256", "source", "steps", "title"]);
  for (const n of parsed.nodes) expect(Object.keys(n).sort()).toEqual(["id", "kind", "label"]);
  for (const e of parsed.edges) expect(Object.keys(e).sort()).toEqual(["basis", "evidenceIds", "from", "id", "relation", "sourceId", "to", "verification"]);
  for (const s of parsed.steps) expect(Object.keys(s).sort()).toEqual(["edgeIds", "id", "nodeIds", "title"]);
  expect(parsed.sha256).toBe(independentHash(parsed));

  // H4
  const svgs = p.all.filter((e) => e.tag === "svg");
  const chartSvg = svgs.filter((e) => dom.attr(e, "id") === "linchpin-flowchart");
  expect(chartSvg.length).toBe(1);
  const svg = chartSvg[0]!;
  expect(dom.has(svg, "viewbox")).toBe(true);
  const inSvg = new Set(dom.descendants(svg));
  const nodeEls = p.all.filter((e) => dom.has(e, "data-node-id"));
  const edgeEls = p.all.filter((e) => dom.has(e, "data-edge-id"));
  expect(nodeEls.length).toBe(model.nodes.length);
  expect(edgeEls.length).toBe(model.edges.length);
  const label = new Map(model.nodes.map((n) => [n.id, n.label]));
  for (const n of model.nodes) {
    const gs = nodeEls.filter((e) => dom.attr(e, "data-node-id") === n.id);
    expect(gs.length).toBe(1);
    const g = gs[0]!;
    expect(g.tag).toBe("g");
    expect(inSvg.has(g)).toBe(true);
    expect(dom.attr(g, "data-kind")).toBe(n.kind);
    const rects = dom.descendants(g).filter((e) => e.tag === "rect");
    expect(rects.length).toBe(1);
    for (const a of ["x", "y", "width", "height"]) {
      const v = dom.attr(rects[0]!, a);
      expect(v).toBeDefined();
      expect(Number.isFinite(Number(v))).toBe(true);
    }
    const texts = dom.descendants(g).filter((e) => e.tag === "text").map(dom.text);
    expect(texts).toContain(n.label);
  }
  for (const e of model.edges) {
    const gs = edgeEls.filter((el) => dom.attr(el, "data-edge-id") === e.id);
    expect(gs.length).toBe(1);
    const g = gs[0]!;
    expect(g.tag).toBe("g");
    expect(inSvg.has(g)).toBe(true);
    expect(dom.attr(g, "data-from")).toBe(e.from);
    expect(dom.attr(g, "data-to")).toBe(e.to);
    expect(dom.attr(g, "data-relation")).toBe(e.relation);
    expect(dom.attr(g, "data-basis")).toBe(e.basis ?? "none");
    expect(dom.attr(g, "data-verification")).toBe(e.verification ?? "none");
    expect(dom.attr(g, "data-evidence-count")).toBe(String(e.evidenceIds.length));
    expect(dom.descendants(g).filter((x) => x.tag === "path").length).toBe(1);
    const word = e.basis ?? "not evidence";
    const texts = dom.descendants(g).filter((x) => x.tag === "text").map(dom.text);
    expect(texts.some((t) => t.includes(e.relation) && t.includes(word))).toBe(true);
  }

  // H5
  const nodeTable = dom.oneById(p, "linchpin-flowchart-nodes");
  expect(nodeTable.tag).toBe("table");
  const nodeRows = p.all.filter((e) => dom.has(e, "data-node-row"));
  expect(nodeRows.length).toBe(model.nodes.length);
  const inNodeTable = new Set(dom.descendants(nodeTable));
  for (const n of model.nodes) {
    const rows = nodeRows.filter((r) => dom.attr(r, "data-node-row") === n.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.tag).toBe("tr");
    expect(inNodeTable.has(rows[0]!)).toBe(true);
    expect(dom.childEls(rows[0]!).filter((c) => c.tag === "td").map(dom.text)).toEqual([n.id, n.kind, n.label]);
  }
  const edgeTable = dom.oneById(p, "linchpin-flowchart-edges");
  expect(edgeTable.tag).toBe("table");
  const edgeRows = p.all.filter((e) => dom.has(e, "data-edge-row"));
  expect(edgeRows.length).toBe(model.edges.length);
  const inEdgeTable = new Set(dom.descendants(edgeTable));
  for (const e of model.edges) {
    const rows = edgeRows.filter((r) => dom.attr(r, "data-edge-row") === e.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.tag).toBe("tr");
    expect(inEdgeTable.has(rows[0]!)).toBe(true);
    expect(dom.childEls(rows[0]!).filter((c) => c.tag === "td").map(dom.text)).toEqual([
      e.id,
      label.get(e.from)!,
      e.relation,
      label.get(e.to)!,
      e.basis ?? "not evidence",
      e.verification ?? "not stated",
      e.evidenceIds.length ? e.evidenceIds.join(", ") : "no evidence",
      e.sourceId ?? "none",
    ]);
  }

  // H6
  const src = dom.oneById(p, "linchpin-flowchart-source");
  expect(src.tag).toBe("p");
  expect(dom.text(src)).toBe(model.source);
  const seq = dom.oneById(p, "linchpin-flowchart-sequence");
  expect(seq.tag).toBe("p");
  expect(dom.text(seq)).toBe(sequenceLine(model.sequence));
  const ol = dom.oneById(p, "linchpin-flowchart-steps");
  expect(ol.tag).toBe("ol");
  const stepItems = dom.childEls(ol).filter((c) => dom.has(c, "data-step-id"));
  expect(p.all.filter((e) => dom.has(e, "data-step-id")).length).toBe(model.steps.length);
  expect(stepItems.map((li) => dom.attr(li, "data-step-id"))).toEqual(model.steps.map((s) => s.id));
  model.steps.forEach((s, k) => {
    const li = stepItems[k]!;
    expect(li.tag).toBe("li");
    const t = dom.text(li);
    expect(t).toContain(s.title);
    for (const id of s.nodeIds) expect(t).toContain(label.get(id)!);
  });
  const ul = dom.oneById(p, "linchpin-flowchart-notes");
  expect(ul.tag).toBe("ul");
  const noteItems = dom.childEls(ul).filter((c) => dom.has(c, "data-note"));
  expect(p.all.filter((e) => dom.has(e, "data-note")).length).toBe(model.notes.length);
  expect(noteItems.map((li) => li.tag)).toEqual(model.notes.map(() => "li"));
  expect(noteItems.map(dom.text)).toEqual(model.notes);
  return p;
}

/** AC4 geometry: rects inside the viewBox, positive size, node rects pairwise disjoint. No widths pinned (PC1). */
function checkGeometry(html: string, model: FlowchartModel) {
  const p = dom.parse(html);
  const svg = p.all.find((e) => e.tag === "svg" && dom.attr(e, "id") === "linchpin-flowchart")!;
  const vb = dom.attr(svg, "viewbox")!.trim().split(/[\s,]+/).map(Number);
  expect(vb.length).toBe(4);
  for (const v of vb) expect(Number.isFinite(v)).toBe(true);
  const [vx, vy, vw, vh] = vb as [number, number, number, number];
  expect(vw).toBeGreaterThan(0);
  expect(vh).toBeGreaterThan(0);
  const box = (r: dom.El) => ({ x: Number(dom.attr(r, "x")), y: Number(dom.attr(r, "y")), w: Number(dom.attr(r, "width")), h: Number(dom.attr(r, "height")) });
  for (const r of dom.descendants(svg).filter((e) => e.tag === "rect")) {
    const b = box(r);
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
    expect(b.x).toBeGreaterThanOrEqual(vx);
    expect(b.y).toBeGreaterThanOrEqual(vy);
    expect(b.x + b.w).toBeLessThanOrEqual(vx + vw);
    expect(b.y + b.h).toBeLessThanOrEqual(vy + vh);
  }
  const nodeRects = model.nodes.map((n) => {
    const g = p.all.find((e) => dom.attr(e, "data-node-id") === n.id)!;
    return { id: n.id, ...box(dom.descendants(g).find((e) => e.tag === "rect")!) };
  });
  for (let i = 0; i < nodeRects.length; i++)
    for (let j = i + 1; j < nodeRects.length; j++) {
      const a = nodeRects[i]!;
      const b = nodeRects[j]!;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) throw new Error(`node rects overlap: ${a.id} and ${b.id}`);
    }
}

// ---------------------------------------------------------------------------------------------
// Shared documents

const fixtureModel = () => toFlowchartModel(input(clone(GRAPH)), "Fixture chart");

function edgeIdOf(m: FlowchartModel, from: string, relation: string, basis?: string): string {
  const e = m.edges.find((x) => x.from === from && x.relation === relation && (basis === undefined || x.basis === basis));
  if (!e) throw new Error(`no edge ${from} ${relation}`);
  return e.id;
}

/** D2: the fixture's projection with steps, notes and sequence plan-order, rehashed. */
function stepsModel(): FlowchartModel {
  const m = clone(toFlowchartModel(input(clone(GRAPH)), "Steps chart"));
  m.sequence = "plan-order";
  m.steps = [
    { id: "step-1", title: "Open the proposal", nodeIds: ["node:a"], edgeIds: [] },
    { id: "step-2", title: "Proposal to governance", nodeIds: ["node:a", "node:b"], edgeIds: [edgeIdOf(m, "node:a", "PROPOSED_IN")] },
    { id: "step-3", title: "Governance controls the claim", nodeIds: ["node:b", "node:c"], edgeIds: m.edges.filter((e) => e.from === "node:b").map((e) => e.id) },
  ];
  m.notes = ["First note: <care> & \"quotes\"", "Second note"];
  return rehash(m);
}

const TMP = mkdtempSync(join(tmpdir(), "lp-html-flowchart-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const r = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, LINCHPIN_RPC_URL: "http://127.0.0.1:1", ...env },
  });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  return { code: r.exitCode, out, err, all: `${out}\n${err}` };
}

const CASES = ["mip-14", "mip-14-opinion", "bonk-bip76"] as const;
const reviewed: Record<string, { dir: string; graph: any; code: number | null; output: string }> = {};
function review(name: (typeof CASES)[number]) {
  if (!reviewed[name]) {
    const dir = join(TMP, "cases", name);
    const r = cli(["review", `cases/${name}.json`, "--offline", "--out", dir]);
    const graphPath = join(dir, "graph.json");
    reviewed[name] = { dir, code: r.code, output: r.all, graph: existsSync(graphPath) ? JSON.parse(readFileSync(graphPath, "utf8")) : null };
  }
  return reviewed[name]!;
}

beforeAll(() => {
  for (const c of CASES) review(c);
}, 120_000);

// ---------------------------------------------------------------------------------------------
// AC1

describe("AC1 exact, closed projection", () => {
  function expectedProjection(graph: any, title: string): FlowchartModel {
    const nodes = graph.nodes.map((n: any) => ({ id: n.id, kind: n.type, label: n.label })).sort((a: any, b: any) => cmpStr(a.id, b.id));
    const edges = graph.edges
      .map((e: any) => ({ from: e.from, to: e.to, relation: e.type, basis: e.basis, verification: null, evidenceIds: [...e.evidenceIds], sourceId: null }))
      .sort(cmpEdge)
      .map((e: any, i: number) => ({ id: `e${i + 1}`, ...e }));
    const body = { schema: "linchpin.flowchart/1" as const, source: "evidence-graph" as const, title, nodes, edges, sequence: null, steps: [], notes: [] };
    return { ...body, sha256: createHash("sha256").update(Buffer.from(canonicalJson(body), "utf8")).digest("hex") };
  }

  test("fixture graph projects exactly, with order, ids, nulls and hash", () => {
    const before = clone(GRAPH);
    const graph = clone(GRAPH);
    const m = toFlowchartModel(input(graph), "Fixture chart");
    expect(graph).toEqual(before);
    expect(m).toEqual(expectedProjection(GRAPH, "Fixture chart"));
    expect(m.nodes.length).toBe(GRAPH.nodes.length);
    expect(m.edges.length).toBe(GRAPH.edges.length);
    // duplicate source edges stay two
    expect(m.edges.filter((e) => e.from === "node:ab" && e.relation === "BELONGS_TO").length).toBe(2);
    expect(m.edges.map((e) => e.id)).toEqual(m.edges.map((_, i) => `e${i + 1}`));
    // mixed case and prefixes sort by code unit
    expect(m.nodes.map((n) => n.id)).toEqual(["iso:x", "loop:z", "node:B", "node:a", "node:ab", "node:b", "node:c", "node:ñ"]);
    // evidence ids join is the tie-breaker: "ev10" before "ev2"
    const ctrl = m.edges.filter((e) => e.relation === "CONTROLS");
    expect(ctrl.map((e) => e.evidenceIds[0])).toEqual(["ev10", "ev2"]);
    // basis is a tie-breaker before evidence: observed before unknown
    expect(m.edges.filter((e) => e.relation === "TREASURY_OF").map((e) => e.basis)).toEqual(["observed", "unknown"]);
    for (let i = 1; i < m.edges.length; i++) expect(cmpEdge(m.edges[i - 1]!, m.edges[i]!)).toBeLessThanOrEqual(0);
    for (const e of m.edges) {
      expect(e.verification).toBeNull();
      expect(e.sourceId).toBeNull();
    }
    expect(m.sequence).toBeNull();
    expect(m.steps).toEqual([]);
    expect(m.notes).toEqual([]);
    expect(JSON.stringify(m).includes("props")).toBe(false);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.sha256).toBe(hashFlowchartModel(withoutHash(m)));
    expect(m.sha256).toBe(sha256hex(canonicalJson(withoutHash(m))));
  });

  test("hashFlowchartModel equals an independent SHA-256 on hand-built models", () => {
    for (const m of [hostileModel(EVIL), evidenceModel(), viewerModel(), stepsModel()]) {
      expect(hashFlowchartModel(withoutHash(m))).toBe(independentHash(withoutHash(m)));
    }
  });

  test("counterexample: the hash changes when any field changes", () => {
    const m = clone(fixtureModel());
    const h = hashFlowchartModel(withoutHash(m));
    m.edges[0]!.evidenceIds = [...m.edges[0]!.evidenceIds, "extra"];
    expect(hashFlowchartModel(withoutHash(m))).not.toBe(h);
  });

  test("deep-frozen input does not throw and is not changed", () => {
    const frozen = deepFreeze(clone(GRAPH));
    const m = toFlowchartModel(input(frozen), "Frozen");
    expect(m.edges.length).toBe(GRAPH.edges.length);
    expect(frozen).toEqual(GRAPH);
  });

  test("recorded mip-14 projects exactly", () => {
    const r = review("mip-14");
    expect(r.code).toBe(0);
    const before = clone(r.graph);
    const m = toFlowchartModel(input(r.graph), "mip-14");
    expect(r.graph).toEqual(before);
    expect(m).toEqual(expectedProjection(r.graph, "mip-14"));
  });

  const small = () => ({
    nodes: [
      { id: "n:1", type: "Realm", label: "One" },
      { id: "n:2", type: "Mint", label: "Two" },
      { id: "n:3", type: "Claim", label: "Three" },
    ],
    edges: [
      { from: "n:1", to: "n:2", type: "HAS", basis: "observed", evidenceIds: ["ev"] },
      { from: "n:3", to: "n:2", type: "SAYS", basis: "claimed", evidenceIds: [] },
    ],
  });

  test("small valid graph projects (base for the invalid cases)", () => {
    expect(toFlowchartModel(input(small()), "t").edges.length).toBe(2);
  });

  const invalid: [string, () => unknown, string[]][] = [
    ["graph null", () => null, []],
    ["graph 5", () => 5, []],
    ["graph array", () => [], []],
    ["graph string", () => "graph", []],
    ["nodes only", () => ({ nodes: [] }), []],
    ["edges only", () => ({ edges: [] }), []],
    ["nodes not an array", () => ({ nodes: {}, edges: [] }), []],
    ["edges not an array", () => ({ nodes: [], edges: {} }), []],
    ["duplicate node id", () => { const g = small(); g.nodes.push({ id: "n:2", type: "Mint", label: "Again" }); return g; }, ["n:2"]],
    ["edge endpoint not a node (to)", () => { const g = small(); g.edges[0]!.to = "n:404"; return g; }, ["n:404"]],
    ["edge endpoint not a node (from)", () => { const g = small(); g.edges[1]!.from = "n:405"; return g; }, ["n:405"]],
    ["basis verified", () => { const g: any = small(); g.edges[1].basis = "verified"; return g; }, ["n:3"]],
    ["basis null", () => { const g: any = small(); g.edges[1].basis = null; return g; }, ["n:3"]],
    ["basis missing", () => { const g: any = small(); delete g.edges[1].basis; return g; }, ["n:3"]],
    ["node label missing", () => { const g: any = small(); delete g.nodes[2].label; return g; }, ["n:3"]],
    ["node label numeric", () => { const g: any = small(); g.nodes[2].label = 7; return g; }, ["n:3"]],
    ["node type missing", () => { const g: any = small(); delete g.nodes[1].type; return g; }, ["n:2"]],
    ["edge type missing", () => { const g: any = small(); delete g.edges[1].type; return g; }, ["n:3"]],
    ["edge type numeric", () => { const g: any = small(); g.edges[1].type = 3; return g; }, ["n:3"]],
    ["evidenceIds entry numeric", () => { const g: any = small(); g.edges[1].evidenceIds = ["ok", 9]; return g; }, ["n:3"]],
    ["evidenceIds missing", () => { const g: any = small(); delete g.edges[1].evidenceIds; return g; }, ["n:3"]],
    ["node entry null", () => { const g: any = small(); g.nodes.push(null); return g; }, []],
    ["edge entry null", () => { const g: any = small(); g.edges.push(null); return g; }, []],
  ];
  for (const [name, make, ids] of invalid) {
    test(`source-invalid: ${name}`, () => {
      expectFlowchartError(() => toFlowchartModel(input(make()), "t"), "source-invalid", ...ids);
    });
  }

  test("source-invalid: numeric node id is named by position or value", () => {
    const g: any = small();
    g.nodes[0].id = 4242;
    const err = expectFlowchartError(() => toFlowchartModel(input(g), "t"), "source-invalid");
    expect(err.problems.some((p) => p.code === "source-invalid" && (p.detail.includes("nodes[") || p.detail.includes("4242")))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// AC2

describe("AC2 deterministic, self-contained document", () => {
  test("same model gives byte-identical output; clock and randomness do not matter", () => {
    const m = stepsModel();
    const a = renderFlowchartHtml(m);
    const b = renderFlowchartHtml(m);
    expect(b).toBe(a);
    const realRandom = Math.random;
    try {
      setSystemTime(new Date("2001-01-01T00:00:00Z"));
      Math.random = () => 0.123456;
      expect(renderFlowchartHtml(m)).toBe(a);
      process.env.LP_FLOWCHART_PROBE = "env-probe-value";
      expect(renderFlowchartHtml(clone(m))).toBe(a);
    } finally {
      setSystemTime();
      Math.random = realRandom;
      delete process.env.LP_FLOWCHART_PROBE;
    }
    for (const leak of [process.cwd(), homedir(), ROOT, tmpdir()]) expect(a.includes(leak)).toBe(false);
  });

  test("render does not mutate the model", () => {
    const m = deepFreeze(stepsModel());
    const before = clone(m);
    renderFlowchartHtml(m);
    expect(m).toEqual(before);
  });

  test("H1, H2, H7 hold on documents with and without steps", () => {
    for (const m of [fixtureModel(), stepsModel(), hostileModel(EVIL), evidenceModel(), viewerModel(), viewerModel(false)]) {
      checkFrame(renderFlowchartHtml(m), m);
    }
  });

  test("two different models carry identical viewer, stylesheet and policy, equal to the constants", () => {
    const p1 = dom.parse(renderFlowchartHtml(fixtureModel()));
    const p2 = dom.parse(renderFlowchartHtml(hostileModel(EVIL)));
    const viewer = (p: dom.Parsed) => dom.text(dom.tagsOf(p, "script")[1]!);
    const style = (p: dom.Parsed) => dom.text(dom.tagsOf(p, "style")[0]!);
    expect(viewer(p1)).toBe(viewer(p2));
    expect(viewer(p1)).toBe(FLOWCHART_VIEWER_JS);
    expect(style(p1)).toBe(style(p2));
    expect(style(p1)).toBe(FLOWCHART_STYLE_CSS);
    expect(policyOf(p1)).toBe(policyOf(p2));
    expect(policyOf(p1)).toBe(expectedPolicy());
  });

  test("empty model renders a valid document whose chart area says No nodes", () => {
    const m = toFlowchartModel(input({ nodes: [], edges: [] }), "Empty");
    expect(m.nodes).toEqual([]);
    expect(m.edges).toEqual([]);
    const html = renderFlowchartHtml(m);
    expect(validateFlowchartHtml(html)).toEqual([]);
    const p = checkFrame(html, m);
    checkChart(html, m);
    const svg = p.all.find((e) => e.tag === "svg" && dom.attr(e, "id") === "linchpin-flowchart")!;
    expect(dom.text(svg.parent!)).toContain("No nodes");
    // counterexample: a non-empty chart does not say it
    const p2 = dom.parse(renderFlowchartHtml(fixtureModel()));
    const svg2 = p2.all.find((e) => e.tag === "svg" && dom.attr(e, "id") === "linchpin-flowchart")!;
    expect(dom.text(svg2.parent!)).not.toContain("No nodes");
  });
});

// ---------------------------------------------------------------------------------------------
// AC3

describe("AC3 untrusted text stays text", () => {
  const PLAIN = "plain";
  test("the hostile string in every text position creates no element or attribute", () => {
    const evil = hostileModel(EVIL);
    const twin = hostileModel(PLAIN);
    const html = renderFlowchartHtml(evil);
    const plain = renderFlowchartHtml(twin);
    expect(validateFlowchartHtml(html)).toEqual([]);
    const pe = dom.parse(html);
    expect(pe.errors).toEqual([]);
    expect(dom.shape(pe)).toEqual(dom.shape(dom.parse(plain)));
    expect(html.split("<!").length - 1).toBe(1);
    expect(html.split("</script>").length - 1).toBe(2);
    expect(html.toLowerCase().split("</script").length - 1).toBe(2);
    expect(html.toLowerCase().split("</style").length - 1).toBe(1);
    expect(html.toLowerCase().split("<img").length - 1).toBe(0);
    // the model block round-trips to the exact original strings
    expect(modelOf(html)).toEqual(evil);
    expect(modelBlock(html)).toContain("\\u003c");
    // text positions show the string as text
    checkFrame(html, evil);
    checkChart(html, evil);
    expect(html).toContain(`<title>${EVIL.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")} title</title>`);
  });

  test("validator returns [] for the hostile document and a hostile title via generate", () => {
    const g = { nodes: [{ id: `${EVIL}n`, type: `${EVIL}t`, label: `${EVIL}l` }], edges: [{ from: `${EVIL}n`, to: `${EVIL}n`, type: `${EVIL}r`, basis: "unknown", evidenceIds: [`${EVIL}e`] }] };
    const html = generateFlowchartHtml(input(g), `${EVIL}title`);
    expect(validateFlowchartHtml(html)).toEqual([]);
    expect(validateFlowchartHtml(html, input(g))).toEqual([]);
    expect(modelOf(html).title).toBe(`${EVIL}title`);
    expect(modelOf(html).nodes[0]!.label).toBe(`${EVIL}l`);
  });
});

// ---------------------------------------------------------------------------------------------
// AC4

describe("AC4 the chart shows the model one to one", () => {
  test("fixture graph (cycle, self-loop, isolated node, parallel and duplicate edges)", () => {
    const m = fixtureModel();
    const html = renderFlowchartHtml(m);
    expect(validateFlowchartHtml(html)).toEqual([]);
    checkChart(html, m);
    checkGeometry(html, m);
  });

  test("hand-built model with three steps and two notes", () => {
    const m = stepsModel();
    expect(m.steps.length).toBe(3);
    expect(m.notes.length).toBe(2);
    const html = renderFlowchartHtml(m);
    expect(validateFlowchartHtml(html)).toEqual([]);
    checkChart(html, m);
    checkGeometry(html, m);
  });

  test("hostile, evidence and viewer models", () => {
    for (const m of [hostileModel(EVIL), evidenceModel(), viewerModel(), viewerModel(false)]) {
      const html = renderFlowchartHtml(m);
      expect(validateFlowchartHtml(html)).toEqual([]);
      checkChart(html, m);
      checkGeometry(html, m);
    }
  });

  for (const c of CASES) {
    test(`recorded case ${c}`, () => {
      const r = review(c);
      expect(r.code).toBe(0);
      const m = toFlowchartModel(input(r.graph), c);
      const html = renderFlowchartHtml(m);
      expect(validateFlowchartHtml(html)).toEqual([]);
      checkChart(html, m);
      checkGeometry(html, m);
    });
  }

  test("many nodes with long labels do not overlap", () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${String(i).padStart(2, "0")}`, type: "Thing", label: `${"Long label ".repeat(i % 7)}${i}` }));
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id, type: "NEXT", basis: "observed", evidenceIds: [] }));
    const m = toFlowchartModel(input({ nodes, edges }), "Many");
    const html = renderFlowchartHtml(m);
    expect(validateFlowchartHtml(html)).toEqual([]);
    checkChart(html, m);
    checkGeometry(html, m);
  });
});

// ---------------------------------------------------------------------------------------------
// AC5

describe("AC5 basis, verification and evidence are never promoted", () => {
  test("every basis and null, every verification and null, evidence words", () => {
    const m = evidenceModel();
    expect(new Set(m.edges.map((e) => e.basis))).toEqual(new Set([...BASES, null]));
    expect(new Set(m.edges.map((e) => e.verification))).toEqual(new Set([...VERIFICATIONS, null]));
    const html = renderFlowchartHtml(m);
    expect(validateFlowchartHtml(html)).toEqual([]);
    const p = dom.parse(html);
    const label = new Map(m.nodes.map((n) => [n.id, n.label]));
    for (const e of m.edges) {
      const g = p.all.find((x) => dom.attr(x, "data-edge-id") === e.id)!;
      expect(dom.attr(g, "data-basis")).toBe(e.basis ?? "none");
      expect(dom.attr(g, "data-verification")).toBe(e.verification ?? "none");
      expect(dom.attr(g, "data-evidence-count")).toBe(String(e.evidenceIds.length));
      const words = dom.descendants(g).filter((x) => x.tag === "text").map(dom.text).join(" ");
      expect(words).toContain(e.basis ?? "not evidence");
      const row = p.all.find((x) => dom.attr(x, "data-edge-row") === e.id)!;
      const cells = dom.childEls(row).filter((c) => c.tag === "td").map(dom.text);
      expect(cells.slice(4)).toEqual([
        e.basis ?? "not evidence",
        e.verification ?? "not stated",
        e.evidenceIds.length ? e.evidenceIds.join(", ") : "no evidence",
        e.sourceId ?? "none",
      ]);
      expect(cells[1]).toBe(label.get(e.from)!);
    }
    const none = m.edges.find((e) => e.evidenceIds.length === 0)!;
    expect(html).toContain(`data-edge-id="${none.id}"`);
    expect(p.all.find((x) => dom.attr(x, "data-edge-id") === none.id)!.attrs).toContainEqual(["data-evidence-count", "0"]);
  });

  test("unknown, unresolved and no-evidence edges are drawn like an observed edge", () => {
    const m = evidenceModel();
    const p = dom.parse(renderFlowchartHtml(m));
    const groupOf = (id: string) => p.all.find((x) => dom.attr(x, "data-edge-id") === id)!;
    const observed = groupOf(m.edges.find((e) => e.basis === "observed")!.id);
    const shapeOf = (g: dom.El) => ({
      tag: g.tag,
      attrs: g.attrs.map(([n]) => n),
      children: dom.descendants(g).map((d) => `${d.tag}[${d.attrs.map(([n]) => n).join(",")}]`),
      parent: g.parent,
    });
    const targets = [
      m.edges.find((e) => e.basis === "unknown")!,
      m.edges.find((e) => e.verification === "unresolved")!,
      m.edges.find((e) => e.evidenceIds.length === 0 && e.basis !== null)!,
    ];
    for (const e of targets) {
      const g = groupOf(e.id);
      expect(g).toBeDefined();
      for (const bad of ["hidden", "display", "style", "visibility", "opacity"]) expect(dom.has(g, bad)).toBe(false);
      expect(dom.descendants(g).filter((d) => d.tag === "path").length).toBe(1);
      const s = shapeOf(g);
      const o = shapeOf(observed);
      expect(s.tag).toBe(o.tag);
      expect(s.attrs).toEqual(o.attrs);
      expect(s.children).toEqual(o.children);
      expect(s.parent).toBe(o.parent);
      // not nested inside, and not containing, another edge group
      expect(dom.descendants(g).some((d) => dom.has(d, "data-edge-id"))).toBe(false);
    }
  });

  const SEQUENCES: (FlowchartSequence | null)[] = ["plan-order", "explanation", "decoded-transaction", "observed-execution", "simulation", "constructed-example", null];
  for (const seq of SEQUENCES) {
    test(`sequence line for ${seq}`, () => {
      const m = clone(viewerModel(seq !== null));
      m.sequence = seq;
      rehash(m);
      const html = renderFlowchartHtml(m);
      expect(validateFlowchartHtml(html)).toEqual([]);
      const p = dom.parse(html);
      expect(dom.text(dom.oneById(p, "linchpin-flowchart-sequence"))).toBe(sequenceLine(seq));
      if (seq !== null && seq !== "observed-execution") expect(html).toContain("(reading order, not an observed execution)");
      if (seq === "observed-execution") expect(html).not.toContain("reading order");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// AC6

describe("AC6 the validator judges the document itself", () => {
  const D1model = fixtureModel();
  const D1 = renderFlowchartHtml(D1model);
  const D2model = stepsModel();
  const D2 = renderFlowchartHtml(D2model);
  const claimedId = D1model.edges.find((e) => e.basis === "claimed")!.id;
  const firstEdge = D1model.edges[0]!.id;

  test("both base documents are valid and large enough", () => {
    expect(D1model.nodes.length).toBeGreaterThanOrEqual(3);
    expect(D1model.edges.length).toBeGreaterThanOrEqual(3);
    expect(validateFlowchartHtml(D1)).toEqual([]);
    expect(validateFlowchartHtml(D2)).toEqual([]);
    expect(D1model.edges.find((e) => e.id === firstEdge)!.verification).toBeNull();
  });

  test("[] for every generated document in this file", () => {
    const docs = [D1, D2, ...[hostileModel(EVIL), hostileModel("plain"), evidenceModel(), viewerModel(), viewerModel(false)].map(renderFlowchartHtml)];
    for (const c of CASES) docs.push(generateFlowchartHtml(input(review(c).graph), c));
    for (const d of docs) expect(validateFlowchartHtml(d)).toEqual([]);
  });

  type Row = [string, () => string, FlowchartProblemCode, string[]];
  const rows: Row[] = [
    ["doctype removed", () => D1.replace(/^<!DOCTYPE html>\r?\n?/, ""), "document", []],
    ["comment added to body", () => sub(D1, "<body>", "<body><!-- x -->"), "document", []],
    ["model block removed", () => D1.replace(MODEL_RE, () => ""), "model-missing", []],
    ["second model block added", () => sub(D1, "</body>", `${MODEL_RE.exec(D1)![0]}</body>`), "model-missing", []],
    ["model block not JSON", () => D1.replace(MODEL_RE, () => `<script type="application/json" id="linchpin-flowchart-model">{not json</script>`), "model-missing", []],
    ["label changed, not rehashed", () => withModel(D1, (m) => { m.nodes[2]!.label += " changed"; }, false), "model-hash", []],
    ["key added to a node, rehashed", () => withModel(D1, (m) => { (m.nodes[3] as any).x = 1; }, true), "model-schema", [D1model.nodes[3]!.id]],
    ["basis verified, rehashed", () => withModel(D1, (m) => { (m.edges[1] as any).basis = "verified"; }, true), "model-schema", [D1model.edges[1]!.id]],
    ["two nodes share an id, rehashed", () => withModel(D1, (m) => { m.nodes[1]!.id = m.nodes[0]!.id; }, true), "model-schema", [D1model.nodes[0]!.id]],
    ["edge to names a missing node, rehashed", () => withModel(D1, (m) => { m.edges[2]!.to = "nope"; }, true), "model-dangling", [D1model.edges[2]!.id]],
    ["step nodeIds names a missing node, rehashed", () => withModel(D2, (m) => { m.steps[1]!.nodeIds.push("nope"); }, true), "model-dangling", ["step-2"]],
    ["label changed and rehashed, chart left", () => withModel(D1, (m) => { m.nodes.find((n) => n.id === "node:b")!.label = "Renamed governance"; }, true), "render-mismatch", ["node:b"]],
    ["one node group deleted", () => cut(D1, `<g data-node-id="node:c"`, "</g>"), "render-mismatch", ["node:c"]],
    ["extra element with data-node-id", () => sub(D1, "<body>", `<body><span data-node-id="node:c"></span>`), "render-mismatch", ["node:c"]],
    ["extra element with data-edge-id", () => sub(D1, "<body>", `<body><span data-edge-id="e1"></span>`), "render-mismatch", ["e1"]],
    ["data-basis claimed to observed", () => editStartTag(D1, `<g data-edge-id="${claimedId}"`, (t) => t.replace(`data-basis="claimed"`, `data-basis="observed"`)), "render-mismatch", [claimedId]],
    ["data-verification none to verified", () => editStartTag(D1, `<g data-edge-id="${firstEdge}"`, (t) => t.replace(`data-verification="none"`, `data-verification="verified"`)), "render-mismatch", [firstEdge]],
    ["edges-table row deleted", () => cut(D1, `<tr data-edge-row="${claimedId}">`, "</tr>"), "render-mismatch", [claimedId]],
    ["edges-table basis cell changed", () => { const i = D1.indexOf(`<tr data-edge-row="${claimedId}">`); return sub(D1, "<td>claimed</td>", "<td>observed</td>", i); }, "render-mismatch", [claimedId]],
    ["step item deleted", () => cut(D2, `<li data-step-id="step-2"`, "</li>"), "render-mismatch", ["step-2"]],
    ["note item deleted", () => { const i = D2.search(/<li data-note(="")?>/); return D2.slice(0, i) + D2.slice(D2.indexOf("</li>", i) + 5); }, "render-mismatch", []],
    ["reading-order wording removed", () => sub(D2, " (reading order, not an observed execution)", ""), "render-mismatch", []],
    ["script alert added", () => sub(D1, "</body>", "<script>alert(1)</script></body>"), "active-content", []],
    ["upper-case external script added", () => sub(D1, "</body>", `<SCRIPT SRC="https://example.org/x.js"></SCRIPT></body>`), "active-content", []],
    ["one character of the viewer changed", () => changeOneLetter(D1, FLOWCHART_VIEWER_JS), "active-content", []],
    ["one character of the stylesheet changed", () => changeOneLetter(D1, FLOWCHART_STYLE_CSS), "active-content", []],
    ["second style element added", () => sub(D1, "</head>", "<style>x{}</style></head>"), "active-content", []],
    ["policy meta removed", () => D1.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, () => ""), "active-content", []],
    ["policy default-src none becomes *", () => sub(D1, "default-src &#39;none&#39;", "default-src *"), "active-content", []],
    ["onclick added", () => sub(D1, "<body>", `<body onclick="x()">`), "active-content", []],
    ["ONLOAD added", () => sub(D1, "<body>", `<body ONLOAD="x()">`), "active-content", []],
    ["hidden on an edge group", () => editStartTag(D1, `<g data-edge-id="${claimedId}"`, (t) => `${t} hidden`), "active-content", []],
    ["display none on an edge group", () => editStartTag(D1, `<g data-edge-id="${claimedId}"`, (t) => `${t} display="none"`), "active-content", []],
    ["img added", () => sub(D1, "<body>", `<body><img src="x.png">`), "active-content", []],
    ["iframe added", () => sub(D1, "<body>", "<body><iframe></iframe>"), "active-content", []],
    ["link added", () => sub(D1, "<body>", `<body><link rel="stylesheet" href="x.css">`), "active-content", []],
    ["a added", () => sub(D1, "<body>", `<body><a href="x">x</a>`), "active-content", []],
  ];

  test("the mutation table has 37 cases", () => {
    expect(rows.length).toBe(37);
  });

  for (const [name, mutate, code, ids] of rows) {
    test(`mutation: ${name} -> ${code}`, () => {
      const html = mutate();
      expect(html).not.toBe(D1);
      expect(html).not.toBe(D2);
      let problems: FlowchartProblem[] = [];
      expect(() => { problems = validateFlowchartHtml(html); }).not.toThrow();
      expect(Array.isArray(problems)).toBe(true);
      for (const p of problems) {
        expect(PROBLEM_CODES).toContain(p.code);
        expect(typeof p.detail).toBe("string");
      }
      expectProblem(problems, code, ...ids);
    });
  }

  function pseudoRandomBytes(n: number): string {
    let s = 0x2545f491;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      bytes[i] = s & 0xff;
    }
    return new TextDecoder("latin1").decode(bytes);
  }

  const hostileInputs: [string, () => string][] = [
    ["empty string", () => ""],
    ["one megabyte of pseudo-random bytes", () => pseudoRandomBytes(1 << 20)],
    ["one megabyte of <", () => "<".repeat(1 << 20)],
    ["deeply nested elements", () => `<!DOCTYPE html>${"<g>".repeat(100_000)}`],
    ["truncated document", () => D1.slice(0, Math.floor(D1.length / 2))],
    ["random bytes in the model block", () => D1.replace(MODEL_RE, () => `<script type="application/json" id="linchpin-flowchart-model">${pseudoRandomBytes(4096).replace(/</g, "")}</script>`)],
  ];
  for (const [name, make] of hostileInputs) {
    test(`never throws, returns a problem within two seconds: ${name}`, () => {
      const html = make();
      const t0 = performance.now();
      let problems: FlowchartProblem[] = [];
      expect(() => { problems = validateFlowchartHtml(html); }).not.toThrow();
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(problems.length).toBeGreaterThan(0);
    }, 10_000);
  }

  test("never executes or fetches anything", () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    (globalThis as any).fetch = (..._args: unknown[]) => { fetched++; return Promise.reject(new Error("no fetch")); };
    try {
      const html = sub(sub(D1, "</body>", `<script>globalThis.__lpFlowchartPwned = 1</script><img src="http://127.0.0.1:1/x.png"></body>`), "</head>", `<link rel="stylesheet" href="http://127.0.0.1:1/x.css"></head>`);
      const problems = validateFlowchartHtml(html);
      expectProblem(problems, "active-content");
      expect((globalThis as any).__lpFlowchartPwned).toBeUndefined();
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("validate.ts imports nothing from the renderer (import lines only, transitive)", () => {
    const dir = join(ROOT, "src", "flowchart");
    const importSpecifiers = (file: string): string[] => {
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => /\b(import|from|require)\b/.test(l));
      const specs: string[] = [];
      for (const l of lines) {
        for (const m of l.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]!);
        for (const m of l.matchAll(/^\s*import\s*["']([^"']+)["']/g)) specs.push(m[1]!);
        for (const m of l.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]!);
        for (const m of l.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]!);
        // a dynamic import with a computed specifier cannot be checked: refuse it
        expect(/\bimport\s*\(\s*[^"'\s]/.test(l)).toBe(false);
      }
      return specs;
    };
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const s of importSpecifiers(file)) {
        if (!s.startsWith(".")) continue;
        let target = resolve(dirname(file), s);
        if (!existsSync(target) || !target.endsWith(".ts")) target = existsSync(`${target}.ts`) ? `${target}.ts` : join(target, "index.ts");
        visit(target);
      }
    };
    visit(join(dir, "validate.ts"));
    expect(seen.has(join(dir, "validate.ts"))).toBe(true);
    expect(seen.has(join(dir, "render.ts"))).toBe(false);
    expect(seen.has(join(dir, "index.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// AC7

describe("AC7 conformance to the source", () => {
  const T = "Conformance title";
  const G = () => clone(GRAPH);
  const doc = generateFlowchartHtml(input(G()), T);

  test("[] with the original input and the document's title", () => {
    expect(validateFlowchartHtml(doc, input(G()))).toEqual([]);
  });

  const variants: [string, (g: any) => void, string[]][] = [
    ["isolated node removed", (g) => { g.nodes = g.nodes.filter((n: any) => n.id !== "iso:x"); }, ["iso:x"]],
    ["node removed with its edges", (g) => { g.nodes = g.nodes.filter((n: any) => n.id !== "loop:z"); g.edges = g.edges.filter((e: any) => e.from !== "loop:z"); }, ["loop:z"]],
    ["one edge removed", (g) => { g.edges = g.edges.filter((e: any) => e.type !== "PROPOSED_IN"); }, ["node:a", "node:b"]],
    ["one edge added", (g) => { g.edges.push({ from: "node:c", to: "node:ñ", type: "CITES", basis: "observed", evidenceIds: ["ev9"] }); }, ["node:c", "node:ñ"]],
    ["one basis changed", (g) => { g.edges.find((e: any) => e.type === "MINTS").basis = "observed"; }, ["node:B", "node:ab"]],
    ["one evidence list changed", (g) => { g.edges.find((e: any) => e.type === "HOLDS").evidenceIds = ["ev8", "ev11"]; }, ["node:ñ", "node:ab"]],
    ["one label changed", (g) => { g.nodes.find((n: any) => n.id === "node:c").label = "Another claim"; }, ["node:c"]],
    ["one kind changed", (g) => { g.nodes.find((n: any) => n.id === "node:ñ").type = "Mint"; }, ["node:ñ"]],
    ["one relation changed", (g) => { g.edges.find((e: any) => e.type === "DESCRIBES").type = "REFERS_TO"; }, ["node:c", "node:a"]],
  ];
  for (const [name, edit, ids] of variants) {
    test(`source-mismatch: ${name}`, () => {
      const g2 = G();
      edit(g2);
      const doc2 = generateFlowchartHtml(input(g2), T);
      expect(validateFlowchartHtml(doc2)).toEqual([]);
      expect(validateFlowchartHtml(doc2, input(g2))).toEqual([]);
      const problems = validateFlowchartHtml(doc2, input(G()));
      expectProblem(problems, "source-mismatch", ...ids);
      // and the other direction
      expectProblem(validateFlowchartHtml(doc, input(g2)), "source-mismatch");
    });
  }

  const badInputs: [string, unknown][] = [
    ["null", null],
    ["empty object", {}],
    ["graph 7", { source: "evidence-graph", graph: 7 }],
    ["node without type", { source: "evidence-graph", graph: { nodes: [{ id: "x", label: "X" }], edges: [] } }],
    ["dangling edge", { source: "evidence-graph", graph: { nodes: [{ id: "x", type: "T", label: "X" }], edges: [{ from: "x", to: "y", type: "R", basis: "observed", evidenceIds: [] }] } }],
  ];
  for (const [name, bad] of badInputs) {
    test(`source-invalid without throwing: ${name}`, () => {
      let problems: FlowchartProblem[] = [];
      expect(() => { problems = validateFlowchartHtml(doc, bad as FlowchartInput); }).not.toThrow();
      expectProblem(problems, "source-invalid");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// AC8

describe("AC8 generation is gated by validation", () => {
  const T = "Gated";
  const G = () => clone(GRAPH);

  test("returns the validated document, equal to render of the projection", () => {
    const html = generateFlowchartHtml(input(G()), T);
    expect(html).toBe(renderFlowchartHtml(toFlowchartModel(input(G()), T)));
    expect(validateFlowchartHtml(html, input(G()))).toEqual([]);
    expect(generateFlowchartHtml(input(G()), T, { render: (m) => renderFlowchartHtml(m) })).toBe(html);
  });

  test("invalid input throws source-invalid", () => {
    expectFlowchartError(() => generateFlowchartHtml(input({ nodes: [{ id: "x", type: "T", label: "X" }], edges: [{ from: "x", to: "gone", type: "R", basis: "observed", evidenceIds: [] }] }), T), "source-invalid", "gone");
  });

  const renders: [string, (html: string, m: FlowchartModel) => string, FlowchartProblemCode][] = [
    ["drops one edge group", (h) => cut(h, `<g data-edge-id="e2"`, "</g>"), "render-mismatch"],
    ["changes one data-basis", (h, m) => { const e = m.edges.find((x) => x.basis === "claimed")!; return editStartTag(h, `<g data-edge-id="${e.id}"`, (t) => t.replace(`data-basis="claimed"`, `data-basis="observed"`)); }, "render-mismatch"],
    ["adds a script element", (h) => sub(h, "</body>", "<script>alert(1)</script></body>"), "active-content"],
    ["alters one character of the viewer", (h) => changeOneLetter(h, FLOWCHART_VIEWER_JS), "active-content"],
  ];
  for (const [name, edit, code] of renders) {
    test(`options.render that ${name} throws ${code}`, () => {
      let seen: FlowchartModel | null = null;
      expectFlowchartError(() => generateFlowchartHtml(input(G()), T, { render: (m) => { seen = m; return edit(renderFlowchartHtml(m), m); } }), code);
      expect(seen).not.toBeNull();
    });
  }

  test("options.render of a different, internally valid model throws source-mismatch", () => {
    const other = G();
    other.nodes = other.nodes.filter((n: any) => n.id !== "iso:x");
    const otherModel = toFlowchartModel(input(other), T);
    expectFlowchartError(() => generateFlowchartHtml(input(G()), T, { render: () => renderFlowchartHtml(otherModel) }), "source-mismatch", "iso:x");
  });
});

// ---------------------------------------------------------------------------------------------
// AC9

describe("AC9 the viewer is fixed and bounded", () => {
  const V = FLOWCHART_VIEWER_JS;
  const S = FLOWCHART_STYLE_CSS;
  const lines = V.split("\n");
  const marker = lines.findIndex((l) => l === "// DOM layer");
  const core = lines.slice(0, marker).join("\n");
  const domLayer = lines.slice(marker + 1).join("\n");

  test("V1: both constants are ASCII without </, <! or <?", () => {
    for (const c of [V, S]) {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
      expect(/^[\x00-\x7f]*$/.test(c)).toBe(true);
      for (const t of ["</", "<!", "<?"]) expect(c.includes(t)).toBe(false);
    }
  });

  test("V1: the stylesheet loads nothing, adds no text, hides nothing; dimmed opacity >= 0.3", () => {
    for (const t of ["url(", "@import", "before", "after", "visibility"]) expect(S.includes(t)).toBe(false);
    expect(/display\s*:\s*none/i.test(S)).toBe(false);
    const opacities = [...S.matchAll(/opacity\s*:\s*([0-9]*\.?[0-9]+)/g)].map((m) => Number(m[1]));
    for (const o of opacities) expect(o).toBeGreaterThanOrEqual(0.3);
    const rules = [...S.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!, body: m[2]! }));
    const dimmed = rules.filter((r) => r.sel.includes("dimmed") && /opacity\s*:/.test(r.body));
    expect(dimmed.length).toBeGreaterThan(0);
    for (const r of dimmed) {
      const o = Number(/opacity\s*:\s*([0-9]*\.?[0-9]+)/.exec(r.body)![1]);
      expect(o).toBeGreaterThanOrEqual(0.3);
      expect(o).toBeLessThan(1);
    }
  });

  test("V1: one DOM layer marker; the core declares both functions and avoids document, window, globalThis", () => {
    expect(lines.filter((l) => l === "// DOM layer").length).toBe(1);
    expect(V.split("// DOM layer").length - 1).toBe(1);
    expect(marker).toBeGreaterThan(0);
    for (const name of ["linchpinFlowchartReduce", "linchpinFlowchartPresent"]) {
      expect(new RegExp(`(function\\s+${name}\\s*\\(|(const|let|var)\\s+${name}\\s*=)`).test(core)).toBe(true);
    }
    for (const t of ["document", "window", "globalThis"]) expect(core.includes(t)).toBe(false);
    const trimmed = domLayer.trim();
    expect(trimmed.startsWith(`if (typeof document !== "undefined")`)).toBe(true);
    expect(trimmed.endsWith("}")).toBe(true);
  });

  test("V2: the viewer contains none of the forbidden tokens; setAttribute only for data-mark", () => {
    const forbidden = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval", "Function", "import", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "location", "history", "cookie", "localStorage", "sessionStorage", "indexedDB", "postMessage", "open(", "setInterval", "removeAttribute", "setAttributeNS", "classList", "className", "dataset"];
    for (const t of forbidden) {
      if (V.includes(t)) throw new Error(`viewer contains forbidden token ${t}`);
    }
    const setAttr = V.split("setAttribute(").length - 1;
    expect(setAttr).toBe(V.split(`setAttribute("data-mark",`).length - 1);
    // other text-writing APIs than textContent
    for (const t of ["innerText", "outerText", "nodeValue", "insertAdjacentText"]) expect(V.includes(t)).toBe(false);
  });

  test("V3: the loaded core functions are the viewer's own text; no global added; nothing thrown", () => {
    const before = Object.getOwnPropertyNames(globalThis).sort();
    let core1: ReturnType<typeof loadFlowchartViewerCore> | undefined;
    expect(() => { core1 = loadFlowchartViewerCore(); }).not.toThrow();
    expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(before);
    expect(typeof core1!.reduce).toBe("function");
    expect(typeof core1!.present).toBe("function");
    const r = String(core1!.reduce);
    const p = String(core1!.present);
    expect(r.length).toBeGreaterThan(20);
    expect(core.includes(r)).toBe(true);
    expect(core.includes(p)).toBe(true);
    expect(r).not.toBe(p);
    // our own evaluation where document is undefined: no throw, no global, same function text
    expect(typeof (globalThis as any).document).toBe("undefined");
    const ours = new Function(`${V}\nreturn [linchpinFlowchartReduce, linchpinFlowchartPresent];`)() as [Function, Function];
    expect(Object.getOwnPropertyNames(globalThis).sort()).toEqual(before);
    expect(String(ours[0])).toBe(r);
    expect(String(ours[1])).toBe(p);
  });

  test("the V and S hashes in rendered documents are the base64 SHA-256 of the constants", () => {
    for (const m of [fixtureModel(), stepsModel()]) {
      const html = renderFlowchartHtml(m);
      const policy = policyOf(dom.parse(html));
      expect(policy).toBe(expectedPolicy());
      expect(policy).toContain(`'sha256-${sha256b64(V)}'`);
      expect(policy).toContain(`'sha256-${sha256b64(S)}'`);
      // Q2: apostrophes are served as &#39;
      expect(html).toContain(`script-src &#39;sha256-${sha256b64(V)}&#39;`);
      expect(html).toContain(`style-src &#39;sha256-${sha256b64(S)}&#39;`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AC10

describe("AC10 selection, inspection and stepping", () => {
  const core = loadFlowchartViewerCore();
  const M = deepFreeze(viewerModel());
  const M0 = deepFreeze(viewerModel(false));
  const snapshot = clone(M);
  const INIT: FlowchartViewState = deepFreeze({ selected: null, step: null });
  const st = (s: FlowchartViewState) => deepFreeze(clone(s));
  const reduce = (m: FlowchartModel, s: FlowchartViewState, a: Parameters<typeof core.reduce>[2]) => {
    const frozen = st(s);
    const out = core.reduce(m, frozen, deepFreeze(clone(a)));
    expect(out).not.toBe(frozen);
    return out;
  };
  const present = (m: FlowchartModel, s: FlowchartViewState): FlowchartPresentation => {
    const p = core.present(m, st(s));
    expect(Object.keys(p.nodes).sort()).toEqual(m.nodes.map((n) => n.id).sort());
    expect(Object.keys(p.edges).sort()).toEqual(m.edges.map((e) => e.id).sort());
    return p;
  };
  const marks = (ids: string[], set: Record<string, FlowchartMark>, rest: FlowchartMark) => Object.fromEntries(ids.map((id) => [id, set[id] ?? rest]));
  const NODES = ["a", "b", "c", "d", "z"];
  const EDGES = ["e1", "e2", "e3"];
  const node = (id: string) => ({ type: "node" as const, id });
  const edge = (id: string) => ({ type: "edge" as const, id });

  test("the model is as the case list needs", () => {
    expect(M.edges.map((e) => `${e.id}:${e.from}->${e.to}`)).toEqual(["e1:a->b", "e2:b->c", "e3:d->d"]);
    expect(M.steps.length).toBe(3);
  });

  test("nothing selected and no step: all normal, no step id, no inspector", () => {
    expect(present(M, INIT)).toEqual({ nodes: marks(NODES, {}, "normal"), edges: marks(EDGES, {}, "normal"), stepId: null, inspector: null });
  });

  test("select a node with incoming and outgoing edges", () => {
    const s = reduce(M, INIT, { type: "select", target: node("b") });
    expect(s).toEqual({ selected: node("b"), step: null });
    expect(present(M, s)).toEqual({
      nodes: marks(NODES, { b: "selected", a: "related", c: "related" }, "dimmed"),
      edges: marks(EDGES, { e1: "related", e2: "related" }, "dimmed"),
      stepId: null,
      inspector: { heading: "Label B", rows: [["id", "b"], ["kind", "KindB"], ["incoming", "1"], ["outgoing", "1"]] },
    });
  });

  test("select a node with only an outgoing edge", () => {
    const p = present(M, reduce(M, INIT, { type: "select", target: node("a") }));
    expect(p.nodes).toEqual(marks(NODES, { a: "selected", b: "related" }, "dimmed"));
    expect(p.edges).toEqual(marks(EDGES, { e1: "related" }, "dimmed"));
    expect(p.inspector!.rows).toEqual([["id", "a"], ["kind", "KindA"], ["incoming", "0"], ["outgoing", "1"]]);
  });

  test("select a node with a self-loop", () => {
    const p = present(M, reduce(M, INIT, { type: "select", target: node("d") }));
    expect(p.nodes).toEqual(marks(NODES, { d: "selected" }, "dimmed"));
    expect(p.edges).toEqual(marks(EDGES, { e3: "related" }, "dimmed"));
    expect(p.inspector).toEqual({ heading: "Label D", rows: [["id", "d"], ["kind", "KindD"], ["incoming", "1"], ["outgoing", "1"]] });
  });

  test("select an isolated node", () => {
    const p = present(M, reduce(M, INIT, { type: "select", target: node("z") }));
    expect(p.nodes).toEqual(marks(NODES, { z: "selected" }, "dimmed"));
    expect(p.edges).toEqual(marks(EDGES, {}, "dimmed"));
    expect(p.inspector).toEqual({ heading: "Label Z", rows: [["id", "z"], ["kind", "KindZ"], ["incoming", "0"], ["outgoing", "0"]] });
  });

  test("select an edge without basis or evidence", () => {
    const s = reduce(M, INIT, { type: "select", target: edge("e2") });
    expect(s).toEqual({ selected: edge("e2"), step: null });
    expect(present(M, s)).toEqual({
      nodes: marks(NODES, { b: "related", c: "related" }, "dimmed"),
      edges: marks(EDGES, { e2: "selected" }, "dimmed"),
      stepId: null,
      inspector: {
        heading: "BC",
        rows: [["id", "e2"], ["from", "Label B"], ["to", "Label C"], ["basis", "not evidence"], ["verification", "not stated"], ["evidence", "no evidence"], ["source id", "none"]],
      },
    });
  });

  test("select an edge with basis, verification, evidence and source id", () => {
    const p = present(M, reduce(M, INIT, { type: "select", target: edge("e1") }));
    expect(p.nodes).toEqual(marks(NODES, { a: "related", b: "related" }, "dimmed"));
    expect(p.edges).toEqual(marks(EDGES, { e1: "selected" }, "dimmed"));
    expect(p.inspector).toEqual({
      heading: "AB",
      rows: [["id", "e1"], ["from", "Label A"], ["to", "Label B"], ["basis", "observed"], ["verification", "verified"], ["evidence", "x1, x2"], ["source id", "src-ab"]],
    });
  });

  test("select the self-loop edge", () => {
    const p = present(M, reduce(M, INIT, { type: "select", target: edge("e3") }));
    expect(p.nodes).toEqual(marks(NODES, { d: "related" }, "dimmed"));
    expect(p.edges).toEqual(marks(EDGES, { e3: "selected" }, "dimmed"));
  });

  test("a second selection of the same target clears", () => {
    const s1 = reduce(M, INIT, { type: "select", target: node("b") });
    expect(reduce(M, s1, { type: "select", target: node("b") })).toEqual({ selected: null, step: null });
    const s2 = reduce(M, INIT, { type: "select", target: edge("e1") });
    expect(reduce(M, s2, { type: "select", target: edge("e1") })).toEqual({ selected: null, step: null });
  });

  test("selecting another target replaces the selection and clears the step", () => {
    const s1 = reduce(M, INIT, { type: "select", target: node("b") });
    expect(reduce(M, s1, { type: "select", target: edge("e1") })).toEqual({ selected: edge("e1"), step: null });
    expect(reduce(M, { selected: null, step: 1 }, { type: "select", target: node("c") })).toEqual({ selected: node("c"), step: null });
  });

  test("a target not in the model leaves the state unchanged, as a new object", () => {
    const states: FlowchartViewState[] = [INIT, { selected: node("b"), step: null }, { selected: null, step: 1 }];
    for (const s of states) {
      for (const target of [node("nope"), edge("e9"), edge("a"), node("e1")]) {
        expect(reduce(M, s, { type: "select", target })).toEqual(s);
      }
    }
  });

  test("clear", () => {
    expect(reduce(M, { selected: node("b"), step: null }, { type: "clear" })).toEqual({ selected: null, step: null });
    expect(reduce(M, { selected: null, step: 2 }, { type: "clear" })).toEqual({ selected: null, step: null });
    expect(reduce(M, INIT, { type: "clear" })).toEqual({ selected: null, step: null });
  });

  test("stepping forward and back across both ends of a three-step model", () => {
    const deltas: (1 | -1)[] = [-1, 1, 1, 1, 1, -1, -1, -1];
    const expected = [null, 0, 1, 2, 2, 1, 0, 0];
    let s: FlowchartViewState = INIT;
    deltas.forEach((delta, i) => {
      s = reduce(M, s, { type: "step", delta });
      expect(s).toEqual({ selected: null, step: expected[i]! });
    });
  });

  test("a step change clears the selection", () => {
    expect(reduce(M, { selected: node("b"), step: null }, { type: "step", delta: 1 })).toEqual({ selected: null, step: 0 });
    expect(reduce(M, { selected: edge("e1"), step: 0 }, { type: "step", delta: 1 })).toEqual({ selected: null, step: 1 });
    expect(reduce(M, { selected: node("a"), step: 2 }, { type: "step", delta: -1 })).toEqual({ selected: null, step: 1 });
  });

  test("present at a step", () => {
    expect(present(M, { selected: null, step: 2 })).toEqual({
      nodes: marks(NODES, { b: "related", c: "related" }, "dimmed"),
      edges: marks(EDGES, { e2: "related" }, "dimmed"),
      stepId: "s3",
      inspector: { heading: "Third step", rows: [["sequence", "plan-order"], ["step", "3 of 3"]] },
    });
    expect(present(M, { selected: null, step: 0 })).toEqual({
      nodes: marks(NODES, { a: "related" }, "dimmed"),
      edges: marks(EDGES, {}, "dimmed"),
      stepId: "s1",
      inspector: { heading: "First step", rows: [["sequence", "plan-order"], ["step", "1 of 3"]] },
    });
  });

  test("a model without steps: every step action leaves the state unchanged", () => {
    for (const s of [INIT, { selected: node("b"), step: null }, { selected: edge("e3"), step: null }] as FlowchartViewState[]) {
      for (const delta of [1, -1] as const) expect(reduce(M0, s, { type: "step", delta })).toEqual(s);
    }
    expect(present(M0, INIT).stepId).toBeNull();
  });

  test("present never invents or omits ids, on every reachable state", () => {
    const actions: Parameters<typeof core.reduce>[2][] = [
      ...NODES.map((id) => ({ type: "select" as const, target: node(id) })),
      ...EDGES.map((id) => ({ type: "select" as const, target: edge(id) })),
      { type: "select", target: node("ghost") },
      { type: "clear" },
      { type: "step", delta: 1 },
      { type: "step", delta: -1 },
    ];
    let s: FlowchartViewState = INIT;
    for (let i = 0; i < 60; i++) {
      s = reduce(M, s, actions[(i * 7) % actions.length]!);
      const p = present(M, s);
      for (const v of [...Object.values(p.nodes), ...Object.values(p.edges)]) expect(["normal", "selected", "related", "dimmed"]).toContain(v);
      if (p.stepId !== null) expect(M.steps.map((x) => x.id)).toContain(p.stepId);
    }
  });

  test("the model is unchanged after all of the above", () => {
    expect(M).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------------------------
// AC11

describe("AC11 command line", () => {
  const dir = join(TMP, "cli");
  mkdirSync(dir, { recursive: true });
  const fixtureModelDefault = toFlowchartModel(input(clone(GRAPH)), "Linchpin flowchart");

  test("flowchart writes the document and prints path, counts and hash", () => {
    const out = join(dir, "a.html");
    const r = cli(["flowchart", GRAPH_PATH, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(out);
    expect(r.out).toContain(`nodes=${GRAPH.nodes.length}`);
    expect(r.out).toContain(`edges=${GRAPH.edges.length}`);
    const hash = /sha256=([0-9a-f]{64})/.exec(r.out)?.[1];
    expect(hash).toBe(fixtureModelDefault.sha256);
    const html = readFileSync(out, "utf8");
    expect(validateFlowchartHtml(html)).toEqual([]);
    expect(validateFlowchartHtml(html, input(clone(GRAPH)))).toEqual([]);
    expect(html).toContain("<title>Linchpin flowchart</title>");
    expect(modelOf(html).source).toBe("evidence-graph");
    expect(html).toBe(generateFlowchartHtml(input(clone(GRAPH)), "Linchpin flowchart"));
  }, CLI_TIMEOUT);

  test("--title and explicit --source evidence-graph; output is deterministic across processes", () => {
    const b = join(dir, "b.html");
    const c = join(dir, "c.html");
    expect(cli(["flowchart", GRAPH_PATH, "--out", b, "--title", "A & B"]).code).toBe(0);
    expect(readFileSync(b, "utf8")).toContain("<title>A &amp; B</title>");
    expect(cli(["flowchart", GRAPH_PATH, "--out", c, "--title", "A & B", "--source", "evidence-graph"]).code).toBe(0);
    expect(readFileSync(c, "utf8")).toBe(readFileSync(b, "utf8"));
  }, CLI_TIMEOUT);

  test("does not depend on LINCHPIN_RPC_URL", () => {
    const d = join(dir, "d.html");
    const r = cli(["flowchart", GRAPH_PATH, "--out", d], { LINCHPIN_RPC_URL: "not a url at all" });
    expect(r.code).toBe(0);
    expect(readFileSync(d, "utf8")).toBe(readFileSync(join(dir, "a.html"), "utf8"));
    expect(cli(["flowchart-validate", d], { LINCHPIN_RPC_URL: "not a url at all" }).code).toBe(0);
  }, CLI_TIMEOUT);

  const badGraphPath = join(dir, "bad-graph.json");
  writeFileSync(badGraphPath, JSON.stringify({ nodes: [{ id: "x", type: "T", label: "X" }], edges: [{ from: "x", to: "ghost", type: "R", basis: "observed", evidenceIds: [] }] }));
  const problemLine = new RegExp(`^(${PROBLEM_CODES.join("|")})\\t.+$`);

  test("a problem prints code<TAB>detail, exits 1 and writes nothing", () => {
    const sub2 = join(dir, "fresh");
    mkdirSync(sub2, { recursive: true });
    const out = join(sub2, "never.html");
    const r = cli(["flowchart", badGraphPath, "--out", out]);
    expect(r.code).toBe(1);
    const lines = r.all.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(problemLine);
    expect(lines.some((l) => /^source-invalid\t/.test(l) && l.includes("ghost"))).toBe(true);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(sub2)).toEqual([]);
  }, CLI_TIMEOUT);

  test("a problem leaves an existing output byte-identical and no stray file", () => {
    const sub3 = join(dir, "existing");
    mkdirSync(sub3, { recursive: true });
    const out = join(sub3, "keep.html");
    const original = Buffer.from("previous bytes é\n\0end");
    writeFileSync(out, original);
    const r = cli(["flowchart", badGraphPath, "--out", out]);
    expect(r.code).toBe(1);
    expect(Buffer.compare(readFileSync(out), original)).toBe(0);
    expect(readdirSync(sub3)).toEqual(["keep.html"]);
  }, CLI_TIMEOUT);

  test("invalid JSON input exits 1", () => {
    const p = join(dir, "not-json.json");
    writeFileSync(p, "{ nodes: ");
    const out = join(dir, "not-json.html");
    const r = cli(["flowchart", p, "--out", out]);
    expect(r.code).toBe(1);
    expect(existsSync(out)).toBe(false);
  }, CLI_TIMEOUT);

  test("flowchart-validate: ok on a good file, with and without --input", () => {
    const good = join(dir, "a.html");
    for (const args of [[good], [good, "--input", GRAPH_PATH], [good, "--input", GRAPH_PATH, "--source", "evidence-graph"]]) {
      const r = cli(["flowchart-validate", ...args]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/\bok\b/);
      expect(r.out).toContain(`nodes=${GRAPH.nodes.length}`);
      expect(r.out).toContain(`edges=${GRAPH.edges.length}`);
      expect(r.out).toContain(fixtureModelDefault.sha256);
    }
  }, CLI_TIMEOUT);

  test("flowchart-validate: a mutated file and a different graph exit 1 with problems", () => {
    const good = readFileSync(join(dir, "a.html"), "utf8");
    const bad = join(dir, "mutated.html");
    writeFileSync(bad, sub(good, "</body>", "<script>alert(1)</script></body>"));
    const r = cli(["flowchart-validate", bad]);
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/^ok\b/m);
    const lines = r.all.split("\n").filter((l) => l.trim() !== "");
    expect(lines.some((l) => /^active-content\t/.test(l))).toBe(true);
    for (const l of lines) expect(l).toMatch(problemLine);

    const otherGraph = clone(GRAPH);
    otherGraph.nodes = otherGraph.nodes.filter((n: any) => n.id !== "iso:x");
    const otherPath = join(dir, "other-graph.json");
    writeFileSync(otherPath, JSON.stringify(otherGraph));
    const r2 = cli(["flowchart-validate", join(dir, "a.html"), "--input", otherPath]);
    expect(r2.code).toBe(1);
    expect(r2.all.split("\n").some((l) => /^source-mismatch\t/.test(l) && l.includes("iso:x"))).toBe(true);
  }, CLI_TIMEOUT);

  const usageCases: [string, string[]][] = [
    ["flowchart without input", ["flowchart"]],
    ["flowchart without --out", ["flowchart", GRAPH_PATH]],
    ["flowchart-validate without file", ["flowchart-validate"]],
    ["flowchart with a nonexistent input", ["flowchart", join(dir, "missing.json"), "--out", join(dir, "m.html")]],
    ["flowchart-validate with a nonexistent html", ["flowchart-validate", join(dir, "missing.html")]],
    ["flowchart-validate with a nonexistent --input", ["flowchart-validate", join(dir, "a.html"), "--input", join(dir, "missing.json")]],
  ];
  for (const [name, args] of usageCases) {
    test(`exit 2 with a usage line: ${name}`, () => {
      const r = cli(args);
      expect(r.code).toBe(2);
      expect(r.all.toLowerCase()).toContain("usage");
      expect(existsSync(join(dir, "m.html"))).toBe(false);
    }, CLI_TIMEOUT);
  }

  test("linchpin usage names both commands and the existing ones; exit codes as before", () => {
    const r = cli([]);
    expect(r.code).toBe(0);
    for (const c of ["flowchart", "flowchart-validate", "review", "pack", "cases", "doctor"]) expect(r.all).toContain(`linchpin ${c}`);
    const unknown = cli(["no-such-command"]);
    expect(unknown.code).toBe(1);
    expect(unknown.all).toContain("linchpin flowchart-validate");
  }, CLI_TIMEOUT);
});

// ---------------------------------------------------------------------------------------------
// AC12

describe("AC12 recorded cases", () => {
  for (const c of CASES) {
    test(`${c}: review, flowchart and flowchart-validate exit 0 with the graph's counts`, () => {
      const r = review(c);
      expect(r.code).toBe(0);
      expect(r.graph).not.toBeNull();
      const n = r.graph.nodes.length;
      const m = r.graph.edges.length;
      const out = join(r.dir, "flowchart.html");
      const gen = cli(["flowchart", join(r.dir, "graph.json"), "--out", out]);
      expect(gen.code).toBe(0);
      expect(gen.out).toContain(`nodes=${n}`);
      expect(gen.out).toContain(`edges=${m}`);
      const val = cli(["flowchart-validate", out, "--input", join(r.dir, "graph.json")]);
      expect(val.code).toBe(0);
      expect(val.out).toMatch(/\bok\b/);
      expect(val.out).toContain(`nodes=${n}`);
      expect(val.out).toContain(`edges=${m}`);
      const html = readFileSync(out, "utf8");
      expect(modelOf(html).nodes.length).toBe(n);
      expect(modelOf(html).edges.length).toBe(m);
      // the counts recorded in the spec on 2026-11-06, reported for the verifier
      console.log(`AC12 ${c}: nodes=${n} edges=${m}`);
    }, CLI_TIMEOUT);
  }
});
