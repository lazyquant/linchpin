// Independent tests for the HTML flowchart presentation contract (AC1 to AC6), written by the
// tester (Claude, claude-opus-5-5) from the approved presentation contract, the original
// html-flowchart contract, the approved plan, its R1-R12 resolutions, the approved clarifications
// PC1-PC6 and src/flowchart/types.ts. The implementation bodies were not read. The DOM tests
// execute the literal viewer script taken from rendered documents in a fake DOM with an injected
// scheduler (tests/fixtures/html-flowchart-presentation).
// AC5 (browser observation) is not claimed here: a fake DOM is not a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  FLOWCHART_STYLE_CSS,
  FLOWCHART_VIEWER_JS,
  generateFlowchartHtml,
  hashFlowchartModel,
  loadFlowchartPlaybackCore,
  loadFlowchartViewerCore,
  renderFlowchartHtml,
  toFlowchartModel,
  validateFlowchartHtml,
  type FlowchartModel,
  type FlowchartPlaybackAction,
  type FlowchartPlaybackState,
  type FlowchartPresentation,
  type FlowchartProblem,
  type FlowchartSelection,
  type FlowchartSequence,
} from "../src/flowchart/index";
import * as dom from "./fixtures/html-flowchart/dom";
import { deepFreeze, evidenceModel, hostileModel, rehash, viewerModel, withoutHash } from "./fixtures/html-flowchart/models";
import { FakeWorld, type FakeElement } from "./fixtures/html-flowchart-presentation/fakedom";
import { RECORDED_BASELINE, emptyModel, longLabels, oneNode, oneStep, threeNodes, threeSteps } from "./fixtures/html-flowchart-presentation/models";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "linchpin-presentation-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DASH = "—";
const WALK = `Guided walkthrough ${DASH} reading order, not observed execution`;
const STEPS_MODE = `Model steps ${DASH} sequence shown above`;
const INIT: FlowchartPlaybackState = { index: null, status: "stopped" };
const IDS = {
  controls: "linchpin-flowchart-controls",
  play: "linchpin-flowchart-play",
  stop: "linchpin-flowchart-stop",
  replay: "linchpin-flowchart-replay",
  prev: "linchpin-flowchart-prev",
  next: "linchpin-flowchart-next",
  status: "linchpin-flowchart-playback-status",
  mode: "linchpin-flowchart-playback-mode",
  help: "linchpin-flowchart-playback-help",
  canvas: "linchpin-flowchart-canvas",
  chart: "linchpin-flowchart-chart",
  svg: "linchpin-flowchart",
  inspector: "linchpin-flowchart-inspector",
  sequence: "linchpin-flowchart-sequence",
  source: "linchpin-flowchart-source",
  steps: "linchpin-flowchart-steps",
  notes: "linchpin-flowchart-notes",
  nodesTable: "linchpin-flowchart-nodes",
  edgesTable: "linchpin-flowchart-edges",
  model: "linchpin-flowchart-model",
  viewer: "linchpin-flowchart-viewer",
} as const;
const BUTTONS = ["play", "stop", "replay", "prev", "next"] as const;

const core = loadFlowchartPlaybackCore();
const viewer = loadFlowchartViewerCore();

/** Item count, derived from the spec: steps when present, otherwise nodes. */
const count = (m: FlowchartModel) => (m.steps.length > 0 ? m.steps.length : m.nodes.length);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
function statusText(m: FlowchartModel, st: FlowchartPlaybackState): string {
  const n = count(m);
  if (n === 0) return `Stopped ${DASH} item 0 of 0. No items to play.`;
  return `${cap(st.status)} ${DASH} item ${st.index === null ? 0 : st.index + 1} of ${n}`;
}
function sequenceText(seq: FlowchartSequence | null): string {
  if (seq === null) return "No sequence";
  if (seq === "observed-execution") return "Sequence: observed-execution";
  return `Sequence: ${seq} (reading order, not an observed execution)`;
}
function modeText(m: FlowchartModel): string {
  if (m.steps.length === 0) return WALK;
  return m.sequence === null ? `Model steps ${DASH} sequence not stated` : STEPS_MODE;
}
function run(m: FlowchartModel, actions: FlowchartPlaybackAction["type"][], from: FlowchartPlaybackState = INIT): FlowchartPlaybackState {
  let s = from;
  for (const a of actions) s = core.reducePlayback(m, s, { type: a });
  return s;
}
const S = (index: number | null, status: FlowchartPlaybackState["status"]): FlowchartPlaybackState => ({ index, status });

function sub(html: string, from: string | RegExp, to: string | ((m: string) => string)): string {
  const out = typeof to === "string" ? html.replace(from, () => to) : html.replace(from, (x) => to(x));
  if (out === html) throw new Error(`mutation did not apply: ${String(from)}`);
  return out;
}
function codes(p: FlowchartProblem[]) {
  return p.map((x) => x.code);
}
function expectMismatchNaming(html: string, id: string, code: FlowchartProblem["code"] = "render-mismatch") {
  const problems = validateFlowchartHtml(html);
  expect(problems.length).toBeGreaterThan(0);
  // the detail must name the element; the validator may drop the common "linchpin-flowchart-" prefix
  const short = id.replace(/^linchpin-flowchart-/, "");
  expect(problems.filter((p) => p.code === code && p.detail.includes(short)).length).toBeGreaterThan(0);
}
function expectRejected(html: string) {
  expect(validateFlowchartHtml(html).length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------------------------
// DOM harness: the literal script of a rendered document, executed in the fake DOM.

interface Mounted {
  w: FakeWorld;
  m: FlowchartModel;
  html: string;
  el: (id: string) => FakeElement;
  status: () => string;
  disabled: () => Record<(typeof BUTTONS)[number], boolean>;
  press: (b: (typeof BUTTONS)[number], force?: boolean) => void;
  node: (id: string) => FakeElement;
  edge: (id: string) => FakeElement;
  outstanding: () => number;
  original: Set<FakeElement>;
  modelText: string;
}

function mount(m: FlowchartModel): Mounted {
  const html = renderFlowchartHtml(m);
  const w = new FakeWorld(html);
  const script = w.byId(IDS.viewer).textContent;
  if (script !== FLOWCHART_VIEWER_JS) throw new Error("served viewer script is not FLOWCHART_VIEWER_JS");
  const original = new Set(w.root.descendants());
  const modelText = w.byId(IDS.model).textContent;
  w.run(script);
  const el = (id: string) => w.byId(id);
  return {
    w,
    m,
    html,
    el,
    original,
    modelText,
    status: () => el(IDS.status).textContent,
    disabled: () => Object.fromEntries(BUTTONS.map((b) => [b, el(IDS[b]).attrs.has("disabled")])) as any,
    press: (b, force = false) => {
      w.click(el(IDS[b]), { force });
    },
    node: (id) => w.all((e) => e.localName === "g" && e.attrs.get("data-node-id") === id)[0]!,
    edge: (id) => w.all((e) => e.localName === "g" && e.attrs.get("data-edge-id") === id)[0]!,
    outstanding: () => w.scheduler.outstanding().length,
  };
}

/** data-mark of every chart group, table row and step item, compared with a presentation. */
function expectMarks(t: Mounted, p: FlowchartPresentation) {
  for (const n of t.m.nodes) {
    expect([n.id, t.node(n.id).attrs.get("data-mark")]).toEqual([n.id, p.nodes[n.id]]);
    const row = t.w.all((e) => e.attrs.get("data-node-row") === n.id)[0]!;
    expect([n.id, row.attrs.get("data-mark")]).toEqual([n.id, p.nodes[n.id]]);
  }
  for (const e of t.m.edges) {
    expect([e.id, t.edge(e.id).attrs.get("data-mark")]).toEqual([e.id, p.edges[e.id]]);
    const row = t.w.all((x) => x.attrs.get("data-edge-row") === e.id)[0]!;
    expect([e.id, row.attrs.get("data-mark")]).toEqual([e.id, p.edges[e.id]]);
  }
  for (const s of t.m.steps) {
    const li = t.w.all((x) => x.attrs.get("data-step-id") === s.id)[0]!;
    expect([s.id, li.attrs.get("data-mark")]).toEqual([s.id, p.stepId === s.id ? "selected" : "normal"]);
  }
}

function inspectorOf(t: Mounted): { heading: string; rows: [string, string][] } {
  const ins = t.el(IDS.inspector);
  const all = ins.descendants();
  const dts = all.filter((e) => e.localName === "dt").map((e) => e.textContent);
  const dds = all.filter((e) => e.localName === "dd").map((e) => e.textContent);
  const headingEl = all.find((e) => /^h[1-6]$/.test(e.localName));
  return { heading: headingEl?.textContent ?? "", rows: dts.map((d, i) => [d, dds[i] ?? ""] as [string, string]) };
}

function expectView(t: Mounted, st: FlowchartPlaybackState, sel: FlowchartSelection | null = null) {
  expect(t.status()).toBe(statusText(t.m, st));
  const p = core.presentPlayback(t.m, st, sel);
  expectMarks(t, p);
  if (p.inspector) expect(inspectorOf(t)).toEqual(p.inspector);
}

/** Every write the script made is one the plan permits; no unmodelled DOM API was touched. */
function expectBoundedWrites(t: Mounted) {
  const ins = t.el(IDS.inspector);
  const status = t.el(IDS.status);
  const buttons = new Set(BUTTONS.map((b) => t.el(IDS[b])));
  const created = (e: FakeElement) => !t.original.has(e);
  const bad: string[] = [];
  for (const wr of t.w.writes) {
    if (wr.kind === "forbidden") bad.push(`forbidden ${wr.what}`);
    else if (wr.kind === "attr") {
      if (wr.name !== "data-mark") bad.push(`setAttribute ${wr.name} on ${wr.el.localName}#${wr.el.id}`);
      if (!["normal", "selected", "related", "dimmed"].includes(wr.value)) bad.push(`data-mark=${wr.value}`);
    } else if (wr.kind === "text") {
      if (!(wr.el === status || wr.el === ins || created(wr.el))) bad.push(`textContent on ${wr.el.localName}#${wr.el.id}`);
    } else if (wr.kind === "disabled") {
      if (!buttons.has(wr.el)) bad.push(`disabled on ${wr.el.localName}#${wr.el.id}`);
    } else if (wr.kind === "append" || wr.kind === "remove") {
      if (!(wr.parent === ins || created(wr.parent))) bad.push(`${wr.kind} under ${wr.parent.localName}#${wr.parent.id}`);
    }
  }
  for (const e of t.w.root.descendants()) if (created(e) && !ins.contains(e)) bad.push(`created ${e.localName} outside inspector`);
  expect(bad).toEqual([]);
  expect([...t.w.unknown]).toEqual([]);
  expect(t.w.errors).toEqual([]);
  expect(t.w.scheduler.bad).toEqual([]);
  for (const tm of t.w.scheduler.timers) expect(tm.ms).toBe(2000);
  expect(t.w.scheduler.maxOutstanding).toBeLessThanOrEqual(1);
  // the model block is never rewritten and still hashes to its own sha256
  const text = t.el(IDS.model).textContent;
  expect(text).toBe(t.modelText);
  const parsed = JSON.parse(text) as FlowchartModel;
  expect(parsed).toEqual(t.m);
  expect(hashFlowchartModel(withoutHash(parsed))).toBe(t.m.sha256);
  // static texts never change
  expect(t.el(IDS.mode).textContent).toBe(modeText(t.m));
  expect(t.el(IDS.sequence).textContent).toBe(sequenceText(t.m.sequence));
  expect(t.el(IDS.help).textContent).toBe("Playback needs JavaScript");
}

function expectButtons(t: Mounted, st: FlowchartPlaybackState) {
  const empty = count(t.m) === 0;
  expect(t.disabled()).toEqual({
    play: empty || st.status === "playing",
    stop: empty || st.status !== "playing",
    replay: empty,
    prev: empty,
    next: empty,
  });
}

// =============================================================================================
// AC2 — deterministic playback core (pure reducer)

describe("AC2 playback core: one core, literally in the shipped script", () => {
  const V = FLOWCHART_VIEWER_JS;
  const marker = V.indexOf("// DOM layer");
  const coreText = V.slice(0, marker);
  const domText = V.slice(marker);

  test("returned functions occur literally in the core part, before // DOM layer", () => {
    expect(marker).toBeGreaterThan(0);
    expect(typeof core.reducePlayback).toBe("function");
    expect(typeof core.presentPlayback).toBe("function");
    expect(coreText.includes(String(core.reducePlayback))).toBe(true);
    expect(coreText.includes(String(core.presentPlayback))).toBe(true);
    for (const tkn of ["document", "window", "globalThis", "setTimeout", "clearTimeout", "Date", "Math.random", "performance"]) expect([tkn, coreText.includes(tkn)]).toEqual([tkn, false]);
  });

  test("timers are confined to the DOM layer: one setTimeout call site, 2000 ms, no other clock API", () => {
    expect(domText.split("setTimeout(").length - 1).toBe(1);
    expect(domText.includes("clearTimeout(")).toBe(true);
    expect(/\b2000\b/.test(domText)).toBe(true);
    for (const tkn of ["setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask", "Worker", "navigator", "fetch", "localStorage", "sessionStorage", "location", "history", "innerHTML", "insertAdjacentHTML", "removeAttribute", "setAttributeNS", "classList", "className", "dataset", "eval", "Function", "import"])
      expect([tkn, V.includes(tkn)]).toEqual([tkn, false]);
    const sets = V.match(/setAttribute\(/g)?.length ?? 0;
    const dataMark = V.match(/setAttribute\("data-mark",/g)?.length ?? 0;
    expect(sets).toBe(dataMark);
    expect(domText.includes("visibilitychange")).toBe(true);
  });

  test("evaluating the script where document is undefined throws nothing and adds no global", () => {
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    const again = loadFlowchartPlaybackCore();
    expect(String(again.reducePlayback)).toBe(String(core.reducePlayback));
    expect(Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k))).toEqual([]);
  });
});

describe("AC2 playback reducer: zero, one and three items, with and without steps", () => {
  const ALL: FlowchartPlaybackAction["type"][] = ["play", "stop", "replay", "tick", "previous", "next", "clear"];

  test("zero items: every action leaves the initial state", () => {
    const m = deepFreeze(emptyModel());
    for (const a of ALL) expect(core.reducePlayback(m, INIT, { type: a })).toEqual(INIT);
    expect(run(m, ["play", "tick", "tick", "next", "replay", "previous"])).toEqual(INIT);
  });

  for (const [name, mk] of [["one step", () => oneStep()], ["one node (fallback)", oneNode]] as const) {
    test(`${name}: Play completes immediately at index 0; Replay and Play from completed stay completed at 0`, () => {
      const m = deepFreeze(mk());
      expect(core.reducePlayback(m, INIT, { type: "play" })).toEqual(S(0, "completed"));
      expect(core.reducePlayback(m, INIT, { type: "replay" })).toEqual(S(0, "completed"));
      expect(run(m, ["play", "play"])).toEqual(S(0, "completed"));
      expect(run(m, ["play", "tick", "tick"])).toEqual(S(0, "completed"));
      expect(run(m, ["next"])).toEqual(S(0, "stopped"));
      expect(run(m, ["next", "next", "previous"])).toEqual(S(0, "stopped"));
      expect(run(m, ["next", "play"])).toEqual(S(0, "completed")); // PC1: stopped at final -> restart at 0
      expect(run(m, ["play", "stop"])).toEqual(S(0, "completed"));
      expect(run(m, ["previous"])).toEqual(INIT);
    });
  }

  for (const [name, mk] of [["three steps (5 nodes)", () => threeSteps()], ["three nodes (fallback)", threeNodes]] as const) {
    test(`${name}: initial Play selects 0 and plays; ticks advance once each; final index completes; no loop`, () => {
      const m = deepFreeze(mk());
      expect(core.reducePlayback(m, INIT, { type: "play" })).toEqual(S(0, "playing"));
      expect(run(m, ["play", "tick"])).toEqual(S(1, "playing"));
      expect(run(m, ["play", "tick", "tick"])).toEqual(S(2, "completed"));
      expect(run(m, ["play", "tick", "tick", "tick", "tick"])).toEqual(S(2, "completed"));
    });

    test(`${name}: repeated Play while playing is a no-op; tick while stopped or initial does nothing`, () => {
      const m = deepFreeze(mk());
      expect(run(m, ["play", "play", "play"])).toEqual(S(0, "playing"));
      expect(run(m, ["play", "tick", "play"])).toEqual(S(1, "playing"));
      expect(core.reducePlayback(m, INIT, { type: "tick" })).toEqual(INIT);
      expect(run(m, ["play", "stop", "tick", "tick"])).toEqual(S(0, "stopped"));
    });

    test(`${name}: Stop retains the index; Play resumes there; Stop on completed stays completed`, () => {
      const m = deepFreeze(mk());
      expect(run(m, ["play", "tick", "stop"])).toEqual(S(1, "stopped"));
      expect(run(m, ["play", "tick", "stop", "play"])).toEqual(S(1, "playing"));
      expect(run(m, ["play", "tick", "stop", "play", "tick"])).toEqual(S(2, "completed"));
      expect(run(m, ["play", "tick", "tick", "stop"])).toEqual(S(2, "completed"));
      expect(core.reducePlayback(m, INIT, { type: "stop" })).toEqual(INIT);
    });

    test(`${name}: Play after completion restarts at 0; Play from stopped at the final index restarts at 0 (PC1)`, () => {
      const m = deepFreeze(mk());
      expect(run(m, ["play", "tick", "tick", "play"])).toEqual(S(0, "playing"));
      expect(run(m, ["next", "next", "next"])).toEqual(S(2, "stopped"));
      expect(run(m, ["next", "next", "next", "play"])).toEqual(S(0, "playing"));
      // a stopped index that is not final resumes rather than restarting
      expect(run(m, ["next", "next", "play"])).toEqual(S(1, "playing"));
    });

    test(`${name}: Replay always restarts at 0 and plays, from every state`, () => {
      const m = deepFreeze(mk());
      for (const from of [INIT, S(0, "playing"), S(1, "playing"), S(1, "stopped"), S(2, "stopped"), S(2, "completed")])
        expect(core.reducePlayback(m, from, { type: "replay" })).toEqual(S(0, "playing"));
    });

    test(`${name}: Previous/Next stop first and clamp; manual step to the final item reports stopped`, () => {
      const m = deepFreeze(mk());
      expect(core.reducePlayback(m, INIT, { type: "previous" })).toEqual(INIT);
      expect(core.reducePlayback(m, INIT, { type: "next" })).toEqual(S(0, "stopped"));
      expect(run(m, ["next", "next", "next", "next", "next"])).toEqual(S(2, "stopped"));
      expect(run(m, ["next", "next", "previous", "previous", "previous"])).toEqual(S(0, "stopped"));
      expect(run(m, ["play", "next"])).toEqual(S(1, "stopped"));
      expect(run(m, ["play", "tick", "previous"])).toEqual(S(0, "stopped"));
      expect(run(m, ["play", "tick", "tick", "previous"])).toEqual(S(1, "stopped"));
      expect(run(m, ["play", "tick", "tick", "next"])).toEqual(S(2, "stopped"));
    });

    test(`${name}: clear resets to the initial state from every state`, () => {
      const m = deepFreeze(mk());
      for (const from of [S(0, "playing"), S(2, "completed"), S(1, "stopped")]) expect(core.reducePlayback(m, from, { type: "clear" })).toEqual(INIT);
    });
  }

  test("item count comes from steps when present, never from nodes (5 nodes, 3 steps clamps at 2)", () => {
    const m = deepFreeze(threeSteps());
    expect(m.nodes.length).toBe(5);
    expect(run(m, ["next", "next", "next", "next", "next", "next"]).index).toBe(2);
    expect(run(m, ["play", "tick", "tick"])).toEqual(S(2, "completed"));
  });

  test("pure: frozen model and state are accepted, inputs are unchanged, random walks never leave range", () => {
    for (const m of [emptyModel(), oneNode(), oneStep(), threeNodes(), threeSteps()]) {
      const snap = structuredClone(m);
      deepFreeze(m);
      let s: FlowchartPlaybackState = deepFreeze({ ...INIT });
      const n = count(m);
      for (let i = 0; i < 200; i++) {
        const a = ALL[(i * 5 + (i >> 2)) % ALL.length]!;
        const before = structuredClone(s);
        const next = core.reducePlayback(m, s, { type: a });
        expect(s).toEqual(before);
        expect(["stopped", "playing", "completed"]).toContain(next.status);
        if (next.index !== null) {
          expect(Number.isInteger(next.index)).toBe(true);
          expect(next.index).toBeGreaterThanOrEqual(0);
          expect(next.index).toBeLessThan(n);
        }
        if (n === 0) expect(next).toEqual(INIT);
        if (next.status === "playing") expect(next.index).not.toBeNull();
        if (next.status === "completed") expect(next.index).toBe(n - 1);
        s = deepFreeze(next);
      }
      expect(m).toEqual(snap);
    }
  });
});

describe("AC2 presentPlayback: step order, node fallback, selection precedence", () => {
  test("with steps, index k presents exactly the existing step presentation", () => {
    const m = deepFreeze(threeSteps());
    for (let k = 0; k < 3; k++) {
      for (const status of ["playing", "stopped"] as const) {
        const p = core.presentPlayback(m, S(k, status), null);
        expect(p).toEqual(viewer.present(m, { selected: null, step: k }));
        expect(p.stepId).toBe(m.steps[k]!.id);
      }
    }
    expect(core.presentPlayback(m, S(2, "completed"), null).stepId).toBe("s3");
  });

  test("without steps, index k presents node k of model order; no step id is manufactured", () => {
    const m = deepFreeze(threeNodes());
    const snap = structuredClone(m);
    expect(m.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    for (let k = 0; k < 3; k++) {
      const p = core.presentPlayback(m, S(k, "playing"), null);
      expect(p.stepId).toBeNull();
      expect(p.nodes[m.nodes[k]!.id]).toBe("selected");
      expect(Object.values(p.nodes).filter((v) => v === "selected").length).toBe(1);
      expect(p).toEqual(viewer.present(m, { selected: { type: "node", id: m.nodes[k]!.id }, step: null }));
      expect(p.inspector?.heading).toBe(m.nodes[k]!.label);
      expect((p.inspector?.rows ?? []).some(([k2, v]) => /observed|execut/i.test(`${k2} ${v}`))).toBe(false);
    }
    expect(m).toEqual(snap);
    expect(m.steps).toEqual([]);
    expect(hashFlowchartModel(withoutHash(m))).toBe(m.sha256);
  });

  test("no cursor, no selection: everything normal, no inspector", () => {
    for (const m of [threeSteps(), threeNodes(), emptyModel()]) {
      const p = core.presentPlayback(m, INIT, null);
      expect(p).toEqual(viewer.present(m, { selected: null, step: null }));
    }
  });

  test("a manual selection takes precedence over the cursor", () => {
    for (const m of [threeSteps(), threeNodes()]) {
      const node = { type: "node" as const, id: m.nodes[0]!.id };
      const edge = { type: "edge" as const, id: m.edges[0]!.id };
      for (const sel of [node, edge]) expect(core.presentPlayback(m, S(1, "stopped"), sel)).toEqual(viewer.present(m, { selected: sel, step: null }));
    }
  });
});

// =============================================================================================
// AC2 and AC4 — the shipped DOM layer with a fake scheduler

describe("AC2 DOM playback timer: 1999/2000 boundary, one handle, no ticks after Stop", () => {
  for (const [name, mk] of [["three steps", () => threeSteps()], ["three nodes (fallback)", threeNodes]] as const) {
    test(`${name}: loading schedules nothing; Play shows item 1 and schedules exactly one 2000 ms tick`, () => {
      const t = mount(mk());
      expect(t.outstanding()).toBe(0);
      expect(t.status()).toBe(statusText(t.m, INIT));
      expectButtons(t, INIT);
      t.press("play");
      expect(t.outstanding()).toBe(1);
      expectView(t, S(0, "playing"));
      expectButtons(t, S(0, "playing"));
      t.w.scheduler.advance(1999);
      expectView(t, S(0, "playing"));
      t.w.scheduler.advance(1);
      expectView(t, S(1, "playing"));
      expect(t.outstanding()).toBe(1);
      t.w.scheduler.advance(1999);
      expectView(t, S(1, "playing"));
      t.w.scheduler.advance(1);
      expectView(t, S(2, "completed"));
      expect(t.outstanding()).toBe(0);
      expectButtons(t, S(2, "completed"));
      t.w.scheduler.advance(60_000);
      expectView(t, S(2, "completed"));
      expect(t.w.scheduler.timers.length).toBe(2);
      expectBoundedWrites(t);
    });

    test(`${name}: Stop cancels at 1999 ms; nothing changes afterwards, even if the stale callback runs`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(1999);
      const pending = t.w.scheduler.outstanding()[0]!;
      t.press("stop");
      expect(t.outstanding()).toBe(0);
      expectView(t, S(0, "stopped"));
      expectButtons(t, S(0, "stopped"));
      const writes = t.w.writes.length;
      t.w.scheduler.advance(1);
      t.w.scheduler.advance(30_000);
      t.w.scheduler.forceFire(pending);
      expect(t.w.writes.length).toBe(writes);
      expect(t.outstanding()).toBe(0);
      expectView(t, S(0, "stopped"));
      expectBoundedWrites(t);
    });

    test(`${name}: resume after Stop waits a full 2000 ms from the retained item`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(2000);
      t.press("stop");
      expectView(t, S(1, "stopped"));
      t.w.scheduler.advance(500);
      t.press("play");
      expectView(t, S(1, "playing"));
      t.w.scheduler.advance(1999);
      expectView(t, S(1, "playing"));
      t.w.scheduler.advance(1);
      expectView(t, S(2, "completed"));
      expectBoundedWrites(t);
    });

    test(`${name}: repeated Play (forced past disabled) keeps one handle and does not postpone the tick`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(1500);
      t.press("play", true);
      t.press("play", true);
      t.press("play", true);
      expect(t.outstanding()).toBe(1);
      expectView(t, S(0, "playing"));
      t.w.scheduler.advance(500);
      expectView(t, S(1, "playing"));
      expectBoundedWrites(t);
    });

    test(`${name}: rapid Replay restarts at item 1, leaves one handle, and stale callbacks are inert`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(2000);
      expectView(t, S(1, "playing"));
      t.press("replay");
      t.press("replay");
      t.press("replay");
      expect(t.outstanding()).toBe(1);
      expectView(t, S(0, "playing"));
      const stale = t.w.scheduler.cancelled();
      expect(stale.length).toBeGreaterThan(0);
      for (const s of stale) t.w.scheduler.forceFire(s);
      expectView(t, S(0, "playing"));
      expect(t.outstanding()).toBe(1);
      t.w.scheduler.advance(1999);
      expectView(t, S(0, "playing"));
      t.w.scheduler.advance(1);
      expectView(t, S(1, "playing"));
      expectBoundedWrites(t);
    });

    test(`${name}: Replay after completion and Play after completion both restart`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(4000);
      expectView(t, S(2, "completed"));
      t.press("play");
      expectView(t, S(0, "playing"));
      t.w.scheduler.advance(4000);
      expectView(t, S(2, "completed"));
      t.press("replay");
      expectView(t, S(0, "playing"));
      expect(t.outstanding()).toBe(1);
      expectBoundedWrites(t);
    });

    test(`${name}: stopped at the final item, Play restarts at item 1 (PC1)`, () => {
      const t = mount(mk());
      t.press("next");
      t.press("next");
      t.press("next");
      expectView(t, S(2, "stopped"));
      expect(t.outstanding()).toBe(0);
      t.press("play");
      expectView(t, S(0, "playing"));
      expect(t.outstanding()).toBe(1);
      expectBoundedWrites(t);
    });

    test(`${name}: Previous/Next while playing stop, cancel the handle and step from the cursor`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(2000);
      t.press("next");
      expect(t.outstanding()).toBe(0);
      expectView(t, S(2, "stopped"));
      t.press("prev");
      t.press("prev");
      t.press("prev");
      expectView(t, S(0, "stopped"));
      t.w.scheduler.advance(10_000);
      expectView(t, S(0, "stopped"));
      expectButtons(t, S(0, "stopped"));
      expectBoundedWrites(t);
    });
  }

  for (const [name, mk] of [["one step", () => oneStep()], ["one node", oneNode]] as const) {
    test(`${name}: Play and Replay complete immediately with zero timers`, () => {
      const t = mount(mk());
      expect(t.status()).toBe(`Stopped ${DASH} item 0 of 1`);
      t.press("play");
      expect(t.status()).toBe(`Completed ${DASH} item 1 of 1`);
      expectView(t, S(0, "completed"));
      expect(t.w.scheduler.timers.length).toBe(0);
      expectButtons(t, S(0, "completed"));
      t.press("replay");
      expectView(t, S(0, "completed"));
      t.press("play");
      expectView(t, S(0, "completed"));
      expect(t.w.scheduler.timers.length).toBe(0);
      expectBoundedWrites(t);
    });
  }

  test("empty graph: every control disabled, explanation shown, forced clicks and keys change nothing", () => {
    const t = mount(emptyModel());
    expect(t.status()).toBe(`Stopped ${DASH} item 0 of 0. No items to play.`);
    expectButtons(t, INIT);
    for (const b of BUTTONS) t.press(b, true);
    t.w.key("document", "ArrowRight");
    t.w.key("document", "Escape");
    t.w.setHidden(true);
    t.w.setHidden(false);
    expect(t.status()).toBe(`Stopped ${DASH} item 0 of 0. No items to play.`);
    expect(t.w.scheduler.timers.length).toBe(0);
    expectButtons(t, INIT);
    expectBoundedWrites(t);
  });
});

describe("AC2/AC4 DOM interruption: selection, Escape, visibility and arrows", () => {
  for (const [name, mk] of [["three steps", () => threeSteps()], ["three nodes (fallback)", threeNodes]] as const) {
    test(`${name}: clicking a node while playing stops, cancels, marks the node and keeps the cursor`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(2000);
      const target = t.m.nodes[t.m.nodes.length - 1]!.id;
      const sel = { type: "node" as const, id: target };
      t.w.click(t.node(target).children[0] as unknown as FakeElement); // the rect, as a browser would target
      expect(t.outstanding()).toBe(0);
      expectView(t, S(1, "stopped"), sel);
      expect(t.node(target).attrs.get("data-mark")).toBe("selected");
      t.w.scheduler.advance(10_000);
      expectView(t, S(1, "stopped"), sel);
      // selecting the same node again toggles it off and restores the cursor highlight
      t.w.click(t.node(target));
      expectView(t, S(1, "stopped"), null);
      // Next steps from the retained cursor
      t.press("next");
      expectView(t, S(2, "stopped"), null);
      expectBoundedWrites(t);
    });

    test(`${name}: clicking an edge or a table row while playing stops; Next then clears the selection`, () => {
      const t = mount(mk());
      t.press("play");
      const e = t.m.edges[0]!;
      t.w.click(t.edge(e.id));
      expect(t.outstanding()).toBe(0);
      expectView(t, S(0, "stopped"), { type: "edge", id: e.id });
      t.press("next");
      expectView(t, S(1, "stopped"), null);
      t.press("play");
      expect(t.outstanding()).toBe(1);
      const row = t.w.all((x) => x.attrs.get("data-node-row") === t.m.nodes[0]!.id)[0]!;
      t.w.click(row.children[0] as unknown as FakeElement);
      expect(t.outstanding()).toBe(0);
      expectView(t, S(1, "stopped"), { type: "node", id: t.m.nodes[0]!.id });
      // Play resumes from the cursor and drops the selection
      t.press("play");
      expectView(t, S(1, "playing"), null);
      expectBoundedWrites(t);
    });

    test(`${name}: Enter and Space on a focused group select it and stop playback`, () => {
      const t = mount(mk());
      t.press("play");
      const id = t.m.nodes[0]!.id;
      t.w.key(t.node(id), "Enter");
      expect(t.outstanding()).toBe(0);
      expectView(t, S(0, "stopped"), { type: "node", id });
      t.press("play");
      const eid = t.m.edges[t.m.edges.length - 1]!.id;
      t.w.key(t.edge(eid), " ");
      expect(t.outstanding()).toBe(0);
      expectView(t, S(0, "stopped"), { type: "edge", id: eid });
      expectBoundedWrites(t);
    });

    test(`${name}: Escape stops, clears the selection and keeps the cursor; Play resumes from it`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(2000);
      t.w.key("document", "Escape");
      expect(t.outstanding()).toBe(0);
      expectView(t, S(1, "stopped"), null);
      t.w.click(t.node(t.m.nodes[0]!.id));
      t.w.key(t.node(t.m.nodes[0]!.id), "Escape");
      expectView(t, S(1, "stopped"), null);
      t.w.scheduler.advance(10_000);
      expectView(t, S(1, "stopped"), null);
      t.press("play");
      expectView(t, S(1, "playing"), null);
      expectBoundedWrites(t);
    });

    test(`${name}: hiding the tab stops immediately; showing it never resumes; hidden Play and Replay refuse`, () => {
      const t = mount(mk());
      t.press("play");
      t.w.scheduler.advance(2000);
      t.w.setHidden(true);
      expect(t.outstanding()).toBe(0);
      expectView(t, S(1, "stopped"));
      t.w.scheduler.advance(10_000);
      t.w.setHidden(false);
      t.w.scheduler.advance(10_000);
      expect(t.outstanding()).toBe(0);
      expectView(t, S(1, "stopped"));
      // a hidden document refuses to start playback
      t.w.setHidden(true);
      t.press("play", true);
      expect(t.outstanding()).toBe(0);
      expect(t.status().startsWith("Playing")).toBe(false);
      t.press("replay", true);
      expect(t.outstanding()).toBe(0);
      expect(t.status().startsWith("Playing")).toBe(false);
      t.w.scheduler.advance(10_000);
      expect(t.status().startsWith("Playing")).toBe(false);
      t.w.setHidden(false);
      expect(t.outstanding()).toBe(0);
      expectBoundedWrites(t);
    });

    test(`${name}: ArrowLeft/Right on the canvas itself keep native scrolling and do not step (PC3)`, () => {
      const t = mount(mk());
      t.press("next");
      t.press("play");
      t.w.scheduler.advance(2000);
      const before = t.status();
      for (const k of ["ArrowRight", "ArrowLeft"]) {
        const ev = t.w.key(t.el(IDS.canvas), k);
        expect(ev.defaultPrevented).toBe(false);
        expect(t.status()).toBe(before);
      }
      expect(t.outstanding()).toBe(1);
      expectBoundedWrites(t);
    });

    test(`${name}: arrows elsewhere step and stop: on a focused node, an edge and the page`, () => {
      const t = mount(mk());
      t.w.key(t.node(t.m.nodes[0]!.id), "ArrowRight");
      expectView(t, S(0, "stopped"));
      t.press("play");
      t.w.key(t.edge(t.m.edges[0]!.id), "ArrowRight");
      expect(t.outstanding()).toBe(0);
      expectView(t, S(1, "stopped"));
      t.w.key("document", "ArrowRight");
      expectView(t, S(2, "stopped"));
      t.w.key("document", "ArrowRight");
      expectView(t, S(2, "stopped"));
      t.w.key("document", "ArrowLeft");
      expectView(t, S(1, "stopped"));
      expectBoundedWrites(t);
    });
  }

  test("fallback walkthrough over 5 nodes marks each node in model order and never writes steps", () => {
    const t = mount(viewerModel(false));
    expect(count(t.m)).toBe(5);
    t.press("play");
    for (let k = 0; k < 5; k++) {
      const id = t.m.nodes[k]!.id;
      expect(t.node(id).attrs.get("data-mark")).toBe("selected");
      expectView(t, S(k, k === 4 ? "completed" : "playing"));
      t.w.scheduler.advance(2000);
    }
    expect(t.el(IDS.steps).children.length).toBe(0);
    expectBoundedWrites(t);
  });

  test("inspector during step playback shows the step title and k of n", () => {
    const t = mount(threeSteps());
    t.press("play");
    t.w.scheduler.advance(2000);
    const ins = inspectorOf(t);
    expect(ins.heading).toBe("Second step");
    expect(ins.rows).toContainEqual(["step", "2 of 3"]);
    expect(ins.rows).toContainEqual(["sequence", "plan-order"]);
  });
});

describe("AC4 inspector evidence in the DOM equals the source for every node and edge", () => {
  test("every edge of the evidence model (all bases, verifications, empty evidence) and every node", () => {
    const m = evidenceModel();
    const t = mount(m);
    const label = (id: string) => m.nodes.find((n) => n.id === id)!.label;
    for (const e of m.edges) {
      t.w.key(t.edge(e.id), "Enter");
      expect(inspectorOf(t)).toEqual({
        heading: e.relation,
        rows: [
          ["id", e.id],
          ["from", label(e.from)],
          ["to", label(e.to)],
          ["basis", e.basis ?? "not evidence"],
          ["verification", e.verification ?? "not stated"],
          ["evidence", e.evidenceIds.length ? e.evidenceIds.join(", ") : "no evidence"],
          ["source id", e.sourceId ?? "none"],
        ],
      });
      expect(t.edge(e.id).attrs.get("data-mark")).toBe("selected");
    }
    for (const n of m.nodes) {
      t.w.click(t.node(n.id));
      const inc = m.edges.filter((e) => e.to === n.id).length;
      const out = m.edges.filter((e) => e.from === n.id).length;
      expect(inspectorOf(t)).toEqual({ heading: n.label, rows: [["id", n.id], ["kind", n.kind], ["incoming", String(inc)], ["outgoing", String(out)]] });
    }
    expectBoundedWrites(t);
  });

  test("hostile text stays text in the inspector, and the self-loop and isolated node select", () => {
    const t = mount(hostileModel(`<b>&"'</script>`));
    for (const n of t.m.nodes) {
      t.w.click(t.node(n.id));
      expect(inspectorOf(t).heading).toBe(n.label);
    }
    const loop = t.m.edges.find((e) => e.from === e.to)!;
    t.w.click(t.edge(loop.id));
    expect(inspectorOf(t).heading).toBe(loop.relation);
    expect(t.w.writes.filter((w) => w.kind === "create").every((w) => w.kind === "create" && ["h2", "h3", "dl", "dt", "dd", "p", "div", "span"].includes(w.tag))).toBe(true);
    expectBoundedWrites(t);
    const iso = mount(threeSteps());
    iso.w.click(iso.node("z"));
    expectView(iso, INIT, { type: "node", id: "z" });
    iso.w.click(iso.node("d"));
    expectView(iso, INIT, { type: "node", id: "d" });
  });
});

// =============================================================================================
// Static document contract

const DOCS = {
  steps: () => threeSteps(),
  oneStep: () => oneStep(),
  nodes: () => threeNodes(),
  oneNode: () => oneNode(),
  empty: () => emptyModel(),
};

function body(p: dom.Parsed): dom.El {
  return p.all.find((e) => e.tag === "body")!;
}

describe("AC3/AC6 static controls, status, mode and disclaimers", () => {
  for (const [name, mk] of Object.entries(DOCS)) {
    test(`${name}: exact controls, labels, types, disabled state, status, mode, help`, () => {
      const m = mk();
      const html = renderFlowchartHtml(m);
      expect(renderFlowchartHtml(m)).toBe(html);
      expect(validateFlowchartHtml(html)).toEqual([]);
      const p = dom.parse(html);
      expect(p.errors).toEqual([]);
      const controls = dom.oneById(p, IDS.controls);
      expect(controls.tag).toBe("div");
      const kids = dom.childEls(controls);
      expect(kids.map((k) => [k.tag, dom.attr(k, "id"), dom.attr(k, "type")])).toEqual(BUTTONS.map((b) => ["button", IDS[b], "button"]));
      const stepWord = m.steps.length ? "step" : "item";
      expect(kids.map((k) => dom.text(k))).toEqual(["Play", "Stop", "Replay", `Previous ${stepWord}`, `Next ${stepWord}`]);
      for (const k of kids) expect(dom.childEls(k)).toEqual([]);
      expect(dom.tagsOf(p, "button").length).toBe(5);
      const empty = count(m) === 0;
      expect(kids.map((k) => dom.has(k, "disabled"))).toEqual(empty ? [true, true, true, true, true] : [false, true, false, false, false]);
      const status = dom.oneById(p, IDS.status);
      expect([status.tag, dom.attr(status, "role"), dom.attr(status, "aria-live"), dom.attr(status, "aria-atomic")]).toEqual(["p", "status", "polite", "true"]);
      expect(dom.text(status)).toBe(statusText(m, INIT));
      const mode = dom.oneById(p, IDS.mode);
      expect([mode.tag, dom.text(mode)]).toEqual(["p", modeText(m)]);
      expect(dom.childEls(mode)).toEqual([]);
      const help = dom.oneById(p, IDS.help);
      expect([help.tag, dom.text(help)]).toEqual(["p", "Playback needs JavaScript"]);
      expect(dom.text(dom.oneById(p, IDS.sequence))).toBe(sequenceText(m.sequence));
      expect(dom.text(dom.oneById(p, IDS.inspector))).toBe("Select a node or an edge");
      // no inline styles anywhere
      expect(p.all.filter((e) => dom.has(e, "style"))).toEqual([]);
    });
  }

  test("status N counts steps, not nodes, when steps exist (5 nodes, 3 steps -> of 3)", () => {
    const html = renderFlowchartHtml(threeSteps());
    expect(dom.text(dom.oneById(dom.parse(html), IDS.status))).toBe(`Stopped ${DASH} item 0 of 3`);
  });

  for (const seq of ["plan-order", "explanation", "decoded-transaction", "observed-execution", "simulation", "constructed-example"] as const) {
    test(`sequence ${seq}: sequence line unchanged, mode states model steps and never observed execution by itself`, () => {
      const m = threeSteps(seq);
      const html = renderFlowchartHtml(m);
      expect(validateFlowchartHtml(html)).toEqual([]);
      const p = dom.parse(html);
      expect(dom.text(dom.oneById(p, IDS.sequence))).toBe(sequenceText(seq));
      expect(dom.text(dom.oneById(p, IDS.mode))).toBe(STEPS_MODE);
    });
  }

  test("head: charset first, then exactly one viewport meta", () => {
    const p = dom.parse(renderFlowchartHtml(threeNodes()));
    const head = p.all.find((e) => e.tag === "head")!;
    const hk = dom.childEls(head);
    expect(hk[0]!.rawStart).toBe('<meta charset="utf-8">');
    expect([hk[1]!.tag, dom.attr(hk[1]!, "name"), dom.attr(hk[1]!, "content")]).toEqual(["meta", "viewport", "width=device-width, initial-scale=1"]);
    expect(dom.tagsOf(p, "meta").filter((m) => dom.attr(m, "name") === "viewport").length).toBe(1);
  });

  test("PC5 nesting: body order, workspace with canvas then inspector, canvas > chart > svg, content after", () => {
    for (const mk of Object.values(DOCS)) {
      const p = dom.parse(renderFlowchartHtml(mk()));
      const kids = dom.childEls(body(p));
      const ids = kids.map((k) => dom.attr(k, "id") ?? (dom.attr(k, "class") ? `.${dom.attr(k, "class")}` : k.tag));
      const order = ["h1", IDS.source, IDS.sequence, IDS.controls, IDS.status, IDS.mode, IDS.help, ".flowchart-workspace"];
      expect(ids.slice(0, order.length)).toEqual(order);
      const ws = kids[order.length - 1]!;
      expect(ws.tag).toBe("div");
      expect(p.all.filter((e) => (dom.attr(e, "class") ?? "").split(/\s+/).includes("flowchart-workspace")).length).toBe(1);
      const wk = dom.childEls(ws);
      expect(wk.map((k) => [k.tag, dom.attr(k, "id")])).toEqual([["div", IDS.canvas], ["aside", IDS.inspector]]);
      expect([dom.attr(wk[0]!, "tabindex"), dom.attr(wk[0]!, "aria-label")]).toEqual(["0", "Scrollable flowchart"]);
      const ck = dom.childEls(wk[0]!);
      expect(ck.map((k) => [k.tag, dom.attr(k, "id")])).toEqual([["div", IDS.chart]]);
      const sk = dom.childEls(ck[0]!);
      expect(sk.map((k) => [k.tag, dom.attr(k, "id")])).toEqual([["svg", IDS.svg]]);
      // steps, notes and tables follow the workspace
      const rest = ids.slice(order.length);
      for (const id of [IDS.steps, IDS.notes, IDS.nodesTable, IDS.edgesTable]) {
        const el = dom.oneById(p, id);
        let top: dom.El = el;
        while (top.parent && top.parent.tag !== "body") top = top.parent;
        expect(kids.indexOf(top)).toBeGreaterThan(order.length - 1);
      }
      expect(rest.length).toBeGreaterThan(0);
    }
  });

  test("empty graph keeps No nodes inside the SVG", () => {
    const p = dom.parse(renderFlowchartHtml(emptyModel()));
    expect(dom.text(dom.oneById(p, IDS.svg))).toContain("No nodes");
  });

  test("scripts disabled: complete tables, steps, notes, initial status and disclaimers are served as text", () => {
    const m = threeSteps("simulation");
    const p = dom.parse(renderFlowchartHtml(m));
    expect(p.all.filter((e) => dom.has(e, "data-node-row")).length).toBe(m.nodes.length);
    expect(p.all.filter((e) => dom.has(e, "data-edge-row")).length).toBe(m.edges.length);
    expect(p.all.filter((e) => dom.has(e, "data-step-id")).length).toBe(3);
    expect(dom.text(dom.oneById(p, IDS.status))).toBe(`Stopped ${DASH} item 0 of 3`);
    expect(dom.text(dom.oneById(p, IDS.sequence))).toBe("Sequence: simulation (reading order, not an observed execution)");
    // nothing in the served marks implies that playback already ran
    expect(p.all.filter((e) => dom.has(e, "data-mark"))).toEqual([]);
  });
});

describe("AC3/AC6 validator rejects altered controls, status, mode and falsely promoted execution", () => {
  const S3 = renderFlowchartHtml(threeSteps());
  const N3 = renderFlowchartHtml(threeNodes());
  const E0 = renderFlowchartHtml(emptyModel());
  const SIM = renderFlowchartHtml(threeSteps("simulation"));
  const btn = (id: string) => new RegExp(`<button type="button" id="${id}"( disabled)?>[^<]*</button>`);

  test("baselines are valid", () => {
    for (const h of [S3, N3, E0, SIM]) expect(validateFlowchartHtml(h)).toEqual([]);
  });

  const cases: [string, () => string, string][] = [
    ["Play removed", () => sub(S3, btn(IDS.play), ""), IDS.play],
    ["Stop removed (no steps)", () => sub(N3, btn(IDS.stop), ""), IDS.stop],
    ["Next duplicated", () => sub(S3, btn(IDS.next), (x) => x + x), IDS.next],
    ["Stop renamed", () => sub(S3, `id="${IDS.stop}"`, 'id="linchpin-flowchart-halt"'), IDS.stop],
    ["Replay type submit", () => sub(S3, `<button type="button" id="${IDS.replay}"`, `<button type="submit" id="${IDS.replay}"`), IDS.replay],
    ["Play relabelled", () => sub(S3, `id="${IDS.play}">Play<`, `id="${IDS.play}">Run<`), IDS.play],
    ["step doc says Next item", () => sub(S3, ">Next step<", ">Next item<"), IDS.next],
    ["walkthrough doc says Previous step", () => sub(N3, ">Previous item<", ">Previous step<"), IDS.prev],
    ["button child element", () => sub(S3, `id="${IDS.play}">Play<`, `id="${IDS.play}"><span>Play</span><`), IDS.play],
    ["Stop not disabled initially", () => sub(S3, `id="${IDS.stop}" disabled>`, `id="${IDS.stop}">`), IDS.stop],
    ["Play disabled initially", () => sub(N3, `id="${IDS.play}">`, `id="${IDS.play}" disabled>`), IDS.play],
    ["empty: Play enabled", () => sub(E0, `id="${IDS.play}" disabled>`, `id="${IDS.play}">`), IDS.play],
    ["empty: Next enabled", () => sub(E0, `id="${IDS.next}" disabled>`, `id="${IDS.next}">`), IDS.next],
    ["status count altered", () => sub(S3, `item 0 of 3<`, `item 0 of 5<`), IDS.status],
    ["status claims playing", () => sub(N3, `Stopped ${DASH} item 0 of 3`, `Playing ${DASH} item 1 of 3`), IDS.status],
    ["empty status explanation removed", () => sub(E0, `item 0 of 0. No items to play.`, `item 0 of 0`), IDS.status],
    ["status role removed", () => sub(S3, ' role="status"', ""), IDS.status],
    ["status aria-live off", () => sub(S3, `id="${IDS.status}" role="status" aria-live="polite"`, `id="${IDS.status}" role="status" aria-live="off"`), IDS.status],
    ["status aria-atomic removed", () => sub(S3, ' aria-atomic="true"', ""), IDS.status],
    ["walkthrough disclaimer becomes model steps", () => sub(N3, WALK, STEPS_MODE), IDS.mode],
    ["walkthrough disclaimer drops not observed", () => sub(N3, WALK, `Guided walkthrough ${DASH} observed execution`), IDS.mode],
    ["empty doc disclaimer removed", () => sub(E0, WALK, ""), IDS.mode],
    ["step doc claims walkthrough", () => sub(S3, STEPS_MODE, WALK), IDS.mode],
    ["simulation steps mode promoted to observed", () => sub(SIM, STEPS_MODE, `Model steps ${DASH} observed execution`), IDS.mode],
    ["help removed", () => sub(S3, /<p id="linchpin-flowchart-playback-help">[^<]*<\/p>/, ""), IDS.help],
    ["help altered", () => sub(S3, "Playback needs JavaScript", "Playback ran"), IDS.help],
  ];
  for (const [name, mk, id] of cases) test(`${name} -> render-mismatch naming ${id}`, () => expectMismatchNaming(mk(), id));

  test("mode paragraph removed or duplicated is rejected", () => {
    expectRejected(sub(N3, /<p id="linchpin-flowchart-playback-mode">[^<]*<\/p>/, ""));
    expectRejected(sub(N3, /<p id="linchpin-flowchart-playback-mode">[^<]*<\/p>/, (x) => x + x));
    expectRejected(sub(S3, /<p id="linchpin-flowchart-playback-status"[^>]*>[^<]*<\/p>/, ""));
  });

  test("an extra button anywhere is rejected", () => {
    expectRejected(sub(S3, `</div>\n<p id="${IDS.status}"`, `<button type="button">Extra</button></div>\n<p id="${IDS.status}"`));
    expectRejected(sub(S3, `<h2>Notes</h2>`, `<button type="button" id="linchpin-flowchart-loop">Loop</button><h2>Notes</h2>`));
  });

  test("falsely promoted execution in the sequence line is rejected (plan-order, simulation, no steps)", () => {
    expectMismatchNaming(sub(S3, sequenceText("plan-order"), "Sequence: observed-execution"), IDS.sequence);
    expectMismatchNaming(sub(SIM, sequenceText("simulation"), "Sequence: observed-execution"), IDS.sequence);
    expectMismatchNaming(sub(N3, ">No sequence<", ">Sequence: observed-execution<"), IDS.sequence);
  });

  test("a model rehashed to observed-execution while the chart still says simulation is rejected", () => {
    const m = threeSteps("simulation");
    const html = renderFlowchartHtml(m);
    const block = /(<script type="application\/json" id="linchpin-flowchart-model">)([\s\S]*?)(<\/script>)/.exec(html)!;
    const mm = JSON.parse(block[2]!) as FlowchartModel;
    mm.sequence = "observed-execution";
    rehash(mm);
    const text = JSON.stringify(mm).replace(/</g, "\\u003c");
    const mutated = html.replace(block[0], `${block[1]}${text}${block[3]}`);
    expect(codes(validateFlowchartHtml(mutated))).toContain("render-mismatch");
  });

  test("a no-step model that gains manufactured steps (rehashed) no longer matches the served chart", () => {
    const m = threeNodes();
    const html = renderFlowchartHtml(m);
    const block = /(<script type="application\/json" id="linchpin-flowchart-model">)([\s\S]*?)(<\/script>)/.exec(html)!;
    const mm = JSON.parse(block[2]!) as FlowchartModel;
    mm.sequence = "observed-execution";
    mm.steps = mm.nodes.map((n, i) => ({ id: `w${i}`, title: n.label, nodeIds: [n.id], edgeIds: [] }));
    rehash(mm);
    const mutated = html.replace(block[0], `${block[1]}${JSON.stringify(mm)}${block[3]}`);
    expect(validateFlowchartHtml(mutated).length).toBeGreaterThan(0);
  });

  test("viewport, canvas affordances and nesting mutations are rejected", () => {
    const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';
    expectRejected(sub(S3, `${viewport}\n`, ""));
    expectRejected(sub(S3, viewport, '<meta name="viewport" content="width=1600">'));
    expectRejected(sub(S3, viewport, `${viewport}\n${viewport}`));
    expectRejected(sub(S3, `id="${IDS.canvas}" tabindex="0"`, `id="${IDS.canvas}"`));
    expectRejected(sub(S3, 'aria-label="Scrollable flowchart"', 'aria-label="Chart"'));
    // controls moved after the workspace
    const ctrl = /<div id="linchpin-flowchart-controls">[\s\S]*?<\/div>\n/.exec(S3)![0];
    expectRejected(sub(sub(S3, ctrl, ""), "<h2>Steps</h2>", `${ctrl}<h2>Steps</h2>`));
    // inspector moved out of the workspace
    const ins = /<aside id="linchpin-flowchart-inspector"[^>]*>[^<]*<\/aside>/.exec(S3)![0];
    expectRejected(sub(sub(S3, ins, ""), "<h2>Steps</h2>", `${ins}<h2>Steps</h2>`));
    // chart wrapper removed
    expectRejected(sub(sub(S3, `<div id="${IDS.chart}">`, ""), "</svg></div>", "</svg>"));
    // workspace class renamed
    expectRejected(sub(S3, 'class="flowchart-workspace"', 'class="flowchart-board"'));
    // inline style added to the canvas
    expect(codes(validateFlowchartHtml(sub(S3, `id="${IDS.canvas}"`, `id="${IDS.canvas}" style="overflow:hidden"`)))).toContain("active-content");
  });
});

describe("AC6 renderer and validator agree; modified bytes, false evidence and missing items fail", () => {
  test("valid output for empty, hostile, cyclic, parallel, long-label, every-basis models", () => {
    for (const m of [emptyModel(), hostileModel(`<>&"'</script><!-- é`), evidenceModel(), longLabels(), threeNodes(), threeSteps("constructed-example"), oneStep("decoded-transaction")])
      expect(validateFlowchartHtml(renderFlowchartHtml(m))).toEqual([]);
  });

  test("one changed byte of the viewer or the stylesheet -> active-content", () => {
    const html = renderFlowchartHtml(threeSteps());
    const v = FLOWCHART_VIEWER_JS;
    const i = v.indexOf("2000");
    expect(i).toBeGreaterThan(0);
    const v2 = v.slice(0, i) + "1000" + v.slice(i + 4);
    expect(codes(validateFlowchartHtml(html.replace(v, v2)))).toContain("active-content");
    const c = FLOWCHART_STYLE_CSS;
    const c2 = c.slice(0, -1) + (c.endsWith(" ") ? "\n" : " ");
    expect(codes(validateFlowchartHtml(html.replace(c, c2)))).toContain("active-content");
  });

  test("CSP hashes equal the SHA-256 of both constants", () => {
    const html = renderFlowchartHtml(threeNodes());
    const b64 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("base64");
    expect(html).toContain(`script-src &#39;sha256-${b64(FLOWCHART_VIEWER_JS)}&#39;`);
    expect(html).toContain(`style-src &#39;sha256-${b64(FLOWCHART_STYLE_CSS)}&#39;`);
    for (const ch of [FLOWCHART_VIEWER_JS, FLOWCHART_STYLE_CSS]) expect(/^[\x00-\x7f]*$/.test(ch)).toBe(true);
  });

  test("false evidence and missing model items -> render-mismatch", () => {
    const m = threeSteps();
    const html = renderFlowchartHtml(m);
    expect(codes(validateFlowchartHtml(sub(html, 'data-relation="AB" data-basis="observed"', 'data-relation="AB" data-basis="claimed"')))).toContain("render-mismatch");
    expect(codes(validateFlowchartHtml(sub(html, "<td>simulated</td>", "<td>observed</td>")))).toContain("render-mismatch");
    expect(codes(validateFlowchartHtml(sub(html, /<g data-node-id="z"[\s\S]*?<\/g>/, "")))).toContain("render-mismatch");
    expect(codes(validateFlowchartHtml(sub(html, /<li data-step-id="s2">[\s\S]*?<\/li>/, "")))).toContain("render-mismatch");
    expect(codes(validateFlowchartHtml(sub(html, /<tr data-edge-row="e1">[\s\S]*?<\/tr>/, "")))).toContain("render-mismatch");
  });

  test("validate.ts does not import the renderer or index.ts, even transitively", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:import|export)[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        if (!spec.startsWith(".")) continue;
        const base = resolve(dirname(file), spec);
        const f = [base, `${base}.ts`, join(base, "index.ts")].find((x) => existsSync(x) && !statSync(x).isDirectory());
        if (f) visit(f);
      }
    };
    visit(join(ROOT, "src/flowchart/validate.ts"));
    const rel = [...seen].map((f) => f.slice(ROOT.length + 1));
    expect(rel).not.toContain("src/flowchart/render.ts");
    expect(rel).not.toContain("src/flowchart/index.ts");
  });
});

describe("Layout: readable labels, unclipped, nothing shrunk to fit (static part of AC5)", () => {
  test("every node rect fits its full label at 14px (0.62em/char + 12px padding each side), is >=48px tall, inside the viewBox and non-overlapping", () => {
    for (const m of [longLabels(), threeSteps(), evidenceModel(), hostileModel("<&>")]) {
      const p = dom.parse(renderFlowchartHtml(m));
      const svg = dom.oneById(p, IDS.svg);
      const vb = dom.attr(svg, "viewbox")!.split(/\s+/).map(Number);
      const W = Number(dom.attr(svg, "width"));
      const H = Number(dom.attr(svg, "height"));
      expect(Number.isFinite(W) && W > 0 && Number.isFinite(H) && H > 0).toBe(true);
      expect([vb[2], vb[3]]).toEqual([W, H]);
      const rects: { x: number; y: number; w: number; h: number; id: string }[] = [];
      for (const n of m.nodes) {
        const g = p.all.find((e) => e.tag === "g" && dom.attr(e, "data-node-id") === n.id)!;
        const r = dom.childEls(g).find((e) => e.tag === "rect")!;
        const t = dom.childEls(g).find((e) => e.tag === "text")!;
        expect(dom.text(t)).toBe(n.label);
        const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(dom.attr(r, a)));
        expect(w!).toBeGreaterThanOrEqual(0.62 * 14 * [...n.label].length + 24);
        expect(h!).toBeGreaterThanOrEqual(48);
        expect(x! >= vb[0]! && y! >= vb[1]! && x! + w! <= vb[0]! + vb[2]! && y! + h! <= vb[1]! + vb[3]!).toBe(true);
        rects.push({ x: x!, y: y!, w: w!, h: h!, id: n.id });
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]!;
          const b = rects[j]!;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect([a.id, b.id, overlap]).toEqual([a.id, b.id, false]);
        }
      // edge paths and edge label anchors stay inside the viewBox (no negative excursions)
      for (const e of m.edges) {
        const g = p.all.find((x) => x.tag === "g" && dom.attr(x, "data-edge-id") === e.id)!;
        const d = dom.attr(dom.childEls(g).find((x) => x.tag === "path")!, "d")!;
        const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        for (let k = 0; k + 1 < nums.length; k += 2) {
          expect(nums[k]! >= vb[0]! && nums[k]! <= vb[0]! + vb[2]!).toBe(true);
          expect(nums[k + 1]! >= vb[1]! && nums[k + 1]! <= vb[1]! + vb[3]!).toBe(true);
        }
        const t = dom.childEls(g).find((x) => x.tag === "text")!;
        const tx = Number(dom.attr(t, "x"));
        const ty = Number(dom.attr(t, "y"));
        expect(tx >= vb[0]! && tx <= vb[0]! + vb[2]! && ty >= vb[1]! && ty <= vb[1]! + vb[3]!).toBe(true);
      }
    }
  });

  test("stylesheet: scrollable canvas, single column at 800px, reduced motion, focus-visible, dimming >= 0.3", () => {
    const c = FLOWCHART_STYLE_CSS;
    expect(/overflow(?:-x)?\s*:\s*auto/.test(c)).toBe(true);
    expect(/@media[^{]*max-width\s*:\s*800px/.test(c)).toBe(true);
    expect(/@media[^{]*prefers-reduced-motion\s*:\s*reduce/.test(c)).toBe(true);
    expect(c.includes(":focus-visible")).toBe(true);
    expect(/max-width\s*:\s*none/.test(c)).toBe(true);
    expect(/14px/.test(c)).toBe(true);
    for (const m of c.matchAll(/opacity\s*:\s*([0-9.]+)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0.3);
    for (const bad of ["url(", "@import", "before", "after", "visibility", "</", "<!", "<?"]) expect([bad, c.includes(bad)]).toEqual([bad, false]);
    expect(/display\s*:\s*none/.test(c)).toBe(false);
    expect(/animation\s*:/.test(c)).toBe(false);
    // PC2: the dimmed group itself keeps full opacity; dimming applies to fill/stroke, never text
    expect(/\[data-mark="dimmed"\]\s*\{[^}]*(?<![-\w])opacity\s*:/.test(c)).toBe(false);
  });
});

// =============================================================================================
// AC1 — recorded governance cases: generate and validate offline; source, model and hash preserved

describe("AC1 recorded cases generate and validate offline with unchanged counts and hashes", () => {
  const out: Record<string, { graph: any; html: string; cliFlow: number | null; cliValidate: string; cliValidateCode: number | null }> = {};
  const cli = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, LINCHPIN_RPC_URL: "http://127.0.0.1:1" } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  beforeAll(() => {
    for (const b of RECORDED_BASELINE) {
      const dir = join(TMP, b.case);
      const rv = cli(["review", `cases/${b.case}.json`, "--offline", "--out", dir]);
      if (rv.code !== 0) throw new Error(`review ${b.case} exited ${rv.code}: ${rv.err.slice(0, 400)}`);
      const fc = cli(["flowchart", join(dir, "graph.json"), "--out", join(dir, "flowchart.html")]);
      const fv = cli(["flowchart-validate", join(dir, "flowchart.html"), "--input", join(dir, "graph.json")]);
      out[b.case] = {
        graph: JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")),
        html: existsSync(join(dir, "flowchart.html")) ? readFileSync(join(dir, "flowchart.html"), "utf8") : "",
        cliFlow: fc.code,
        cliValidate: fv.out,
        cliValidateCode: fv.code,
      };
    }
  }, 240_000);

  for (const b of RECORDED_BASELINE) {
    test(`${b.case}: CLI flowchart and flowchart-validate --input exit 0; counts and hash equal the pre-build baseline`, () => {
      const r = out[b.case]!;
      expect(r.cliFlow).toBe(0);
      expect(r.cliValidateCode).toBe(0);
      expect(r.cliValidate).toContain("ok");
      expect(r.graph.nodes.length).toBe(b.nodes);
      expect(r.graph.edges.length).toBe(b.edges);
      const input = { source: "evidence-graph" as const, graph: r.graph };
      const m = toFlowchartModel(input, "Linchpin flowchart");
      expect(m.sha256).toBe(b.sha256);
      expect(validateFlowchartHtml(r.html)).toEqual([]);
      expect(validateFlowchartHtml(r.html, input)).toEqual([]);
      expect(r.html).toBe(generateFlowchartHtml(input, "Linchpin flowchart"));
      const block = /<script type="application\/json" id="linchpin-flowchart-model">([\s\S]*?)<\/script>/.exec(r.html)![1]!;
      const served = JSON.parse(block) as FlowchartModel;
      expect(served).toEqual(m);
      // labels and evidence are served verbatim
      const p = dom.parse(r.html);
      for (const n of m.nodes) expect(dom.text(p.all.find((e) => e.tag === "g" && dom.attr(e, "data-node-id") === n.id)!)).toBe(n.label);
      for (const e of m.edges) {
        const row = p.all.find((x) => dom.attr(x, "data-edge-row") === e.id)!;
        expect(dom.childEls(row).map((c) => dom.text(c))[6]).toBe(e.evidenceIds.length ? e.evidenceIds.join(", ") : "no evidence");
        expect(dom.childEls(row).map((c) => dom.text(c))[4]).toBe(e.basis ?? "not evidence");
      }
      // the recorded governance graphs have no steps: walkthrough mode, never observed execution
      expect(m.steps).toEqual([]);
      expect(dom.text(dom.oneById(p, IDS.mode))).toBe(WALK);
      expect(dom.text(dom.oneById(p, IDS.status))).toBe(`Stopped ${DASH} item 0 of ${b.nodes}`);
    });

    test(`${b.case}: full walkthrough in the fake DOM ends completed after N-1 ticks with <=1 handle and the model untouched`, () => {
      const m = toFlowchartModel({ source: "evidence-graph", graph: out[b.case]!.graph }, "Linchpin flowchart");
      const t = mount(m);
      t.press("play");
      for (let k = 1; k < b.nodes; k++) t.w.scheduler.advance(2000);
      expectView(t, S(b.nodes - 1, "completed"));
      expect(t.outstanding()).toBe(0);
      expect(t.w.scheduler.timers.length).toBe(b.nodes - 1);
      expectBoundedWrites(t);
    });
  }
});
