/**
 * Independent acceptance tests for the embeddable NEAR static panel wrapper.
 *
 * Every expected value comes from the approved embeddable-panel specification
 * (E1-E9, W1-W4, AC1-AC12) and from the pre-existing public type contracts of
 * the reader, engine, kit and flowchart.
 * Nothing is asserted from what the implementation prints: section titles and
 * order are the spec's own E2 words, the gap texts are the spec's fixed
 * phrases, and the rejection classes come from W2/W3. Panel-module constants
 * are not imported for expectations.
 *
 * Everything runs offline: fetch, WebSocket, Bun.connect and node:net are
 * trapped for the whole file, a deliberate attempt is proven blocked, and the
 * hit count must be zero at the end. Paths resolve from the repository root.
 *
 * The AC8 historical comparison builds the landing page from the commit named
 * by LINCHPIN_PANEL_BASE_COMMIT when that variable is supplied for the focused
 * run; the value is never hardcoded or printed here and only its presence is
 * assumed. Without it that one comparison skips with a warning.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as netNamespace from "node:net";
import netDefault from "node:net";

import { loadNearSnapshot, loadNearSnapshots, controlSurface } from "../src/near/reader/index";
import { openStore, runQuery } from "../src/engine/queries/index";
import type { EvidenceStore } from "../src/engine/queries/index";
import { BANNED_WORDS } from "../src/engine/render";
import {
  buildPanel,
  composePanelDocument,
  serializePanelData,
  validatePanelLinks,
  panelKitPage,
  panelSurface,
  panelEvidenceResolver,
  renderPanel,
  preparePanels,
  panelFiles,
  writePanelFiles,
  PanelRejected,
  type PanelData,
} from "../src/near/panel/index";
import { validateSurface } from "../src/ui/validate";
import { validateFlowchartHtml } from "../src/flowchart/index";
import { NEAR_REGISTRY } from "../src/near/subjects/registry";
import type { SubjectEntry } from "../src/near/subjects/registry";
import { buildSite } from "../src/site/site";

const REPO_ROOT = join(import.meta.dir, "..");
const SNAPSHOT_ID = "near-2026-11-09";
const CONSTRUCTED_ID = "near-constructed-intents-locker-added";
const INTENTS = "near:mainnet:intents.near";
const INTENTS_ACCOUNT = "intents.near";
const CTL = "near:mainnet:ctl-intents.near";
const DEMO_ID = "near-constructed-panel-demo";
const DEMO_SUBJECT = "near:mainnet:panel-demo.near";
const DEMO_ACCOUNT = "panel-demo.near";

/* Spec E2 section titles, in order (the spec's own words). */
const E2_TITLES = [
  "Identity and capture", "Who can change it", "What it rests on", "What rests on it",
  "State", "Open proposals", "Changes", "Not mapped", "Receipts",
];
/* Spec E2/E3 fixed gap texts. */
const GAP_TEXTS = ["none read", "one capture only: nothing to compare", "not a DAO", "unknown", "no relation recorded"];
/* Spec AC1's own phrase for the full-access-keys row value. */
const FULL_ACCESS_GAP = "none read as present";

function sha256Of(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

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

test("offline trap deliberately attempts and stays blocked", () => {
  expect(() => globalThis.fetch("https://panel-trap.invalid")).toThrow(/trapped/);
  expect(() => (Bun as unknown as { connect: (i: unknown) => unknown }).connect({})).toThrow(/trapped/);
  expect(() => (netDefault as unknown as { connect: (i: unknown) => unknown }).connect({})).toThrow(/trapped/);
  hits.fetch = 0; hits.connect = 0; hits.net = 0;
});

/* ------------------------------------------------------------------ */
/* Shared fixtures and helpers                                         */
/* ------------------------------------------------------------------ */

let store: EvidenceStore;
let intentsPanel: PanelData;
let registrySubjects: string[];
const panelBySubject = new Map<string, PanelData>();
let preparedPanels: Map<string, string>;

beforeAll(() => {
  store = loadNearSnapshot(SNAPSHOT_ID);
  const snapshot = store.snapshot(SNAPSHOT_ID)!;
  registrySubjects = NEAR_REGISTRY.filter((e) => snapshot.subjects.includes(e.subject)).map((e) => e.subject);
  intentsPanel = buildPanel(store, SNAPSHOT_ID, INTENTS);
  for (const subject of registrySubjects) panelBySubject.set(subject, buildPanel(store, SNAPSHOT_ID, subject));
  preparedPanels = preparePanels(store, SNAPSHOT_ID);
});

/** A minimal constructed EvidenceSnapshot built in code, for planted values. */
function demoConstructedStore(): EvidenceStore {
  const ISO = "2026-11-09T19:31:34.397Z";
  const snapshot = {
    version: 1 as const, id: DEMO_ID, chain: "near" as const, network: "mainnet" as const,
    constructed: true, observedFrom: ISO, observedTo: ISO, fromBlockOrSlot: "100", toBlockOrSlot: "200",
    freshUntil: ISO, subjects: [DEMO_SUBJECT],
    readers: [{ id: "r1", status: "complete" as const, subjects: [DEMO_SUBJECT] }],
    names: {},
    receipts: [{
      id: "rc-demo-1", source: "panel-demo", responseSha256: "a".repeat(64),
      observation: { chain: "near", network: "mainnet", blockOrSlot: "100", blockHash: "demoBckHashDemoBckHashDemoBckHash1111", observedAt: ISO, retrievedAt: ISO, historicalState: "constructed" as const },
      privacy: "public" as const,
    }],
    facts: [{
      id: "nf-demo-xss", subject: DEMO_SUBJECT, predicate: "paused",
      object: "<img src=x onerror=alert(1)>", basis: "observed" as const, status: "verified" as const,
      evidenceIds: ["rc-demo-1"], path: [], validFrom: null, validTo: null, privacy: "public" as const,
    }],
  };
  return openStore([snapshot]);
}

const demoRegistry: SubjectEntry[] = [{ account: "panel-demo.near", subject: DEMO_SUBJECT, label: "panel-demo.near", chains: ["intents"], recipes: [], yields: [] }];
function demoPanel(): PanelData {
  return buildPanel(demoConstructedStore(), DEMO_ID, DEMO_SUBJECT, { registry: demoRegistry });
}

let tmpDirs: string[] = [];
function newTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-test-"));
  tmpDirs.push(dir);
  return dir;
}
const BASE_TREE = join(REPO_ROOT, "tests", "fixtures", "near-embed-panels-wrapper", ".base-tree");
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(BASE_TREE, { recursive: true, force: true });
});

function listFilesRelative(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

interface SpawnResult { exitCode: number; stdout: string; stderr: string }
function spawnCLI(args: string[]): SpawnResult {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function assertInertPanelHtml(html: string, account: string): void {
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    expect(/type="application\/json"/i.test(m[0]), m[0]).toBe(true);
  }
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toContain("@import");
  expect(html).not.toMatch(/url\(/i);
  for (const m of html.matchAll(/<[a-z][^>]*>/gi)) {
    expect(/\son[a-z-]+\s*=/i.test(m[0]), m[0]).toBe(false);
  }
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    expect([`${account}.chart.html`, "index.html"], m[1]).toContain(m[1]);
  }
}

/** Extract a top-level JSON array that follows `key":` in an html string. */
function extractJsonArray(html: string, key: string): unknown[] {
  const at = html.indexOf(`"${key}":`);
  expect(at, key).toBeGreaterThan(-1);
  let i = html.indexOf("[", at);
  let depth = 0, inString = false, escaped = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) break; }
  }
  return JSON.parse(html.slice(html.indexOf("[", at), i + 1)) as unknown[];
}

function escapeLikeMarkup(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Tester fixtures for the spawned-child checks below. */
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "near-embed-panels-wrapper");
const NET_TRAP_PRELOAD = join(FIXTURE_DIR, "net-trap-child.ts");
const INVALID_SURFACE_CHILD = "./tests/fixtures/near-embed-panels-wrapper/invalid-surface-child.ts";
const NET_TRAP_KINDS = ["fetch", "websocket", "bun.connect", "net.connect", "net.createConnection"] as const;
const INVALID_SURFACE_CODES = ["unresolved-evidence", "uncited-row"] as const;

/** Spawns the real CLI entry with the tester preload trapping every network entry point of the child. */
function spawnCLIWithNetTrap(args: string[], opts?: { probe?: boolean }): SpawnResult & { logLines: string[] } {
  const dir = newTmpDir();
  const logPath = join(dir, "attempts.log");
  const env = { ...process.env, PANEL_NETTRAP_LOG: logPath } as Record<string, string>;
  if (opts?.probe) env.PANEL_NETTRAP_PROBE = "1";
  const proc = Bun.spawnSync(["bun", "--preload", NET_TRAP_PRELOAD, "src/cli.ts", ...args], {
    cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env,
  });
  let logLines: string[] = [];
  try {
    logLines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch { /* no attempt was logged */ }
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), logLines };
}

/** Removes both inert JSON blocks so a markup assertion cannot be satisfied by embedded JSON. */
function stripInertJsonBlocks(html: string): string {
  return html.replace(/<script type="application\/json" id="lk-(?:messages|panel-data)">[\s\S]*?<\/script>/g, "");
}

/* ------------------------------------------------------------------ */
/* AC1 - panel data for the verifier                                   */
/* ------------------------------------------------------------------ */

describe("AC1 buildPanel sections and capture", () => {
  test("panel identity fields follow the spec's JSON twin shape", () => {
    expect(intentsPanel.schema).toBe("linchpin.near-panel/1");
    expect(intentsPanel.subject).toBe(INTENTS);
    expect(intentsPanel.account).toBe(INTENTS_ACCOUNT);
  });

  test("all nine E2 sections appear under the spec's titles in the spec's order", () => {
    expect(intentsPanel.sections.map((s) => s.title)).toEqual(E2_TITLES);
  });

  test("capture block range equals the receipts' minimum and maximum blockOrSlot", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    const blocks = snapshot.receipts.map((r) => r.observation.blockOrSlot).filter((b) => b !== null) as string[];
    expect(blocks.length).toBeGreaterThan(0);
    const numeric = blocks.map((b) => Number(b));
    expect(numeric.every((n) => Number.isFinite(n))).toBe(true);
    const min = blocks[numeric.indexOf(Math.min(...numeric))];
    const max = blocks[numeric.indexOf(Math.max(...numeric))];
    expect(intentsPanel.capture.fromBlockOrSlot).toBe(min);
    expect(intentsPanel.capture.toBlockOrSlot).toBe(max);
  });

  test("upgrader row names the controller account for role Upgrader", () => {
    const control = intentsPanel.sections.find((s) => s.title === "Who can change it")!;
    const upgraderRows = control.rows.filter((r) => r.role === "Upgrader");
    expect(upgraderRows.length).toBe(1);
    expect(upgraderRows[0].value).toBe("ctl-intents.near");
  });

  test("pause manager grantees row equals the controlSurface grantee set", () => {
    const cs = controlSurface(store, SNAPSHOT_ID, INTENTS, store.snapshot(SNAPSHOT_ID)!.observedTo);
    const pauseKeys = Object.keys(cs.roles).filter((k) => /pause/i.test(k));
    expect(pauseKeys.length).toBeGreaterThan(0);
    const control = intentsPanel.sections.find((s) => s.title === "Who can change it")!;
    for (const key of pauseKeys) {
      const rows = control.rows.filter((r) => r.role === key);
      expect(rows.length, key).toBe(1);
      expect([...(rows[0].members ?? [])].sort(), key).toEqual([...cs.roles[key]].sort());
    }
  });

  test("full-access keys row says none were read as present", () => {
    const control = intentsPanel.sections.find((s) => s.title === "Who can change it")!;
    const keyRows = control.rows.filter((r) => /full.access/i.test(r.what));
    expect(keyRows.length).toBe(1);
    expect(keyRows[0].value).toBe(FULL_ACCESS_GAP);
  });

  test("the named control rows resolve facts and carry the union of their evidence", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    const factById = new Map(snapshot.facts.map((f) => [f.id, f]));
    const receiptIds = new Set(snapshot.receipts.map((r) => r.id));
    const control = intentsPanel.sections.find((s) => s.title === "Who can change it")!;
    const named = control.rows.filter(
      (r) => r.role === "Upgrader" || r.role === "PauseManager" || /full.access/i.test(r.what),
    );
    expect(named.length).toBe(3);
    for (const row of named) {
      expect(row.factIds.length).toBeGreaterThan(0);
      for (const id of row.factIds) expect(factById.has(id)).toBe(true);
      for (const id of row.evidenceIds) expect(receiptIds.has(id)).toBe(true);
      const union = new Set(row.factIds.flatMap((id) => factById.get(id)!.evidenceIds));
      expect([...row.evidenceIds].sort()).toEqual([...union].sort());
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC2 - every row is traceable                                        */
/* ------------------------------------------------------------------ */

describe("AC2 row traceability over every registry subject of the snapshot", () => {
  test("registry baseline subjects are covered", () => {
    expect(registrySubjects.length).toBeGreaterThan(0);
    expect(registrySubjects).toContain(INTENTS);
    expect(registrySubjects).toContain(CTL);
  });

  test("every fact row resolves fact and evidence ids; every gap row uses a spec gap text", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    const factIds = new Set(snapshot.facts.map((f) => f.id));
    const receiptIds = new Set(snapshot.receipts.map((r) => r.id));
    for (const [subject, data] of panelBySubject) {
      for (const section of data.sections) {
        for (const row of section.rows) {
          const where = `${subject} ${section.title} "${row.what}"`;
          if (row.gap) {
            expect(GAP_TEXTS, where).toContain(row.value);
          } else {
            expect(row.factIds.length, where).toBeGreaterThan(0);
            expect(row.evidenceIds.length, where).toBeGreaterThan(0);
            for (const id of row.factIds) expect(factIds.has(id), where).toBe(true);
            for (const id of row.evidenceIds) expect(receiptIds.has(id), where).toBe(true);
          }
        }
      }
    }
  });

  test("fact-row values stay within facts' objects, the spec's phrases and cited ids", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    const factById = new Map(snapshot.facts.map((f) => [f.id, f]));
    const specPhrases = [...GAP_TEXTS, FULL_ACCESS_GAP];
    for (const [subject, data] of panelBySubject) {
      const meta = data.capture;
      for (const section of data.sections) {
        if (section.title === "Identity and capture" || section.title === "Receipts") continue;
        for (const row of section.rows) {
          if (row.gap) continue;
          const corpus = row.factIds.map((id) => JSON.stringify(factById.get(id)?.object ?? "")).join(" ")
            + " " + specPhrases.join(" ")
            + " " + row.factIds.join(" ") + " " + meta.snapshotId
            + " " + (meta.fromBlockOrSlot ?? "") + " " + (meta.toBlockOrSlot ?? "")
            + " none unknown read as present";
          for (const token of row.value.split(/[^A-Za-z0-9._-]+/)) {
            if (!token) continue;
            expect(corpus.includes(token), `${subject} ${section.title} "${row.what}" token "${token}"`).toBe(true);
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC3 - what rests on it                                              */
/* ------------------------------------------------------------------ */

describe("AC3 reverse dependencies", () => {
  test("ctl-intents.near shows intents.near resting on it via upgraded-by", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    const upgradedBy = snapshot.facts.find((f) => f.predicate === "upgraded-by" && f.object === CTL);
    expect(upgradedBy).toBeDefined();
    const ctlPanel = panelBySubject.get(CTL)!;
    const reverse = ctlPanel.sections.find((s) => s.title === "What rests on it")!;
    const rows = reverse.rows.filter((r) => r.predicate === "upgraded-by");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.subject === INTENTS && r.factIds.includes(upgradedBy!.id))).toBe(true);
  });

  test("the section equals a direct scan of the snapshot's facts for three subjects", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    for (const subject of [INTENTS, CTL, "near:mainnet:intents.sputnik-dao.near"]) {
      const data = panelBySubject.get(subject) ?? buildPanel(store, SNAPSHOT_ID, subject);
      const inbound = snapshot.facts.filter((f) => f.object === subject);
      const computed = new Map<string, string[]>();
      for (const f of inbound) computed.set(f.predicate, [...(computed.get(f.predicate) ?? []), f.subject]);
      const reverse = data.sections.find((s) => s.title === "What rests on it")!;
      const shown = new Map<string, string[]>();
      for (const row of reverse.rows) {
        const key = row.predicate ?? "";
        shown.set(key, [...(shown.get(key) ?? []), row.subject ?? ""]);
      }
      expect([...shown.keys()].sort(), subject).toEqual([...computed.keys()].sort());
      for (const [predicate, subjectsOf] of computed) {
        expect([...(shown.get(predicate) ?? [])].sort(), `${subject} ${predicate}`).toEqual([...subjectsOf].sort());
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC4 - gaps and failure                                              */
/* ------------------------------------------------------------------ */

describe("AC4 rejection and gap rows", () => {
  test("a subject outside the snapshot throws PanelRejected(missing-subject)", () => {
    let caught: unknown;
    try {
      buildPanel(store, SNAPSHOT_ID, "near:mainnet:not-in-snapshot.near");
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PanelRejected);
    expect((caught as PanelRejected).code).toBe("missing-subject");
  });

  test("the CLI exits 2 with one stderr line and writes no file", () => {
    const out = newTmpDir();
    const res = spawnCLI(["near", "panel", "does-not-exist.near", "--out", join(out, "missing"), "--offline"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toContain("missing-subject");
    const written = existsSync(join(out, "missing")) ? readdirSync(join(out, "missing")) : [];
    expect(written).toHaveLength(0);
  }, 60000);

  test("each QueryReason appears as exactly one row under Not mapped, unchanged", () => {
    const gaps = intentsPanel.sections.find((s) => s.title === "Not mapped")!;
    expect(gaps.rows.length).toBe(intentsPanel.reasons.length);
    for (const reason of intentsPanel.reasons) {
      const rows = gaps.rows.filter((r) =>
        r.reason && r.reason.code === reason.code && r.reason.subject === reason.subject && r.reason.ref === reason.ref);
      expect(rows.length, reason.code).toBe(1);
      expect(rows[0].gap).toBe(true);
      expect(rows[0].factIds).toEqual([]);
    }
  });

  test("a fact whose object is unknown renders unknown, gap true, unverified", () => {
    const snapshot = store.snapshot(SNAPSHOT_ID)!;
    const unknownFacts = snapshot.facts.filter((f) => f.object === "unknown" && registrySubjects.includes(f.subject));
    expect(unknownFacts.length).toBeGreaterThan(0);
    for (const fact of unknownFacts) {
      const data = panelBySubject.get(fact.subject)!;
      let found = false;
      for (const section of data.sections) {
        for (const row of section.rows) {
          if (!row.factIds.includes(fact.id)) continue;
          found = true;
          expect(row.gap, fact.id).toBe(true);
          expect(row.value, fact.id).toBe("unknown");
          expect(row.status, fact.id).toBe("unverified");
        }
      }
      expect(found, fact.id).toBe(true);
    }
  });

  test("without a second snapshot the changes section holds exactly its one gap row", () => {
    const changes = intentsPanel.sections.find((s) => s.title === "Changes")!;
    expect(changes.rows.length).toBe(1);
    expect(changes.rows[0].gap).toBe(true);
    expect(changes.rows[0].value).toBe("one capture only: nothing to compare");
  });
});

/* ------------------------------------------------------------------ */
/* AC5 - the page is inert and self-contained                          */
/* ------------------------------------------------------------------ */

describe("AC5 inert and self-contained pages", () => {
  test("every generated panel html is inert", () => {
    expect(preparedPanels.size).toBeGreaterThan(0);
    for (const [name, content] of preparedPanels) {
      if (!name.endsWith(".html") || name.endsWith(".chart.html")) continue;
      assertInertPanelHtml(content, name.replace(/\.html$/, ""));
    }
  });

  test("a planted markup value appears escaped and creates no element", () => {
    const snap = structuredClone(loadNearSnapshot(CONSTRUCTED_ID).snapshot(CONSTRUCTED_ID)!);
    const fact = snap.facts.find((f) => f.predicate === "paused");
    expect(fact).toBeDefined();
    fact!.object = "<img src=x onerror=alert(1)>";
    const planted = openStore([snap]);
    const data = buildPanel(planted, CONSTRUCTED_ID, INTENTS);
    const row = data.sections.flatMap((s) => s.rows).find((r) => r.factIds.includes(fact!.id));
    expect(row?.value).toBe("<img src=x onerror=alert(1)>");
    const html = renderPanel(data).html;
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<img\b/i);
    assertInertPanelHtml(html, INTENTS_ACCOUNT);
  });

  test("every panel's messages pass the kit validator with its own evidence resolver", () => {
    for (const [subject, data] of panelBySubject) {
      const verdict = validateSurface(panelSurface(data), { resolveEvidence: panelEvidenceResolver(data) });
      expect(verdict.ok, subject).toBe(true);
    }
  });

  test("a failing surface refuses composition with the rule codes", () => {
    let caught: unknown;
    try { panelKitPage(demoPanel(), [{ version: "not-a-surface" }]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PanelRejected);
    expect((caught as PanelRejected).code).toBe("invalid-surface");
    expect((caught as PanelRejected).codes.length).toBeGreaterThan(0);
  });

  test("end to end: the CLI refuses a failing surface, names subject and rule codes, writes no file", () => {
    const out = newTmpDir();
    const resultPath = join(out, "child-result.json");
    const childDir = join(out, "panel-dir");
    const proc = Bun.spawnSync(["bun", "test", INVALID_SURFACE_CHILD], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PANEL_INVALID_SURFACE_RESULT: resultPath, PANEL_INVALID_SURFACE_OUT: childDir } as Record<string, string>,
    });
    expect(proc.exitCode, proc.stderr.toString().slice(-1500)).toBe(0);
    const record = JSON.parse(readFileSync(resultPath, "utf8")) as { code: number; stderrLines: string[] };
    expect(record.code, JSON.stringify(record)).not.toBe(0);
    const stderr = record.stderrLines.join("\n");
    expect(stderr).toContain(INTENTS);
    for (const code of INVALID_SURFACE_CODES) expect(stderr, code).toContain(code);
    expect(existsSync(childDir) ? readdirSync(childDir) : []).toHaveLength(0);
  }, 60000);
});

/* ------------------------------------------------------------------ */
/* AC6 - page equals JSON                                              */
/* ------------------------------------------------------------------ */

describe("AC6 page and JSON parity", () => {
  test("the composed JSON block is byte-identical to the serialized data", () => {
    const composed = composePanelDocument(panelKitPage(intentsPanel), INTENTS_ACCOUNT, intentsPanel);
    expect(composed.json).toBe(serializePanelData(intentsPanel));
    expect(composed.html).toContain(`<script type="application/json" id="lk-panel-data">${composed.json}</script>`);
  });

  test("the CLI's .json file is byte-identical to the page's data block, and rows appear in the markup", () => {
    const out = newTmpDir();
    const res = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", join(out, "cli"), "--offline"]);
    expect(res.exitCode).toBe(0);
    const dir = join(out, "cli");
    const jsonBytes = readFileSync(join(dir, `${INTENTS_ACCOUNT}.json`), "utf8");
    const html = readFileSync(join(dir, `${INTENTS_ACCOUNT}.html`), "utf8");
    expect(html).toContain(`<script type="application/json" id="lk-panel-data">${jsonBytes}</script>`);
    for (const section of intentsPanel.sections) {
      for (const row of section.rows) {
        expect(html.includes(row.value) || html.includes(escapeLikeMarkup(row.value)), row.what).toBe(true);
        expect(html).toContain(row.what);
      }
    }
  }, 60000);

  test("index.json carries each registry subject once with the sha256 of its json file", () => {
    const indexRaw = preparedPanels.get("index.json");
    expect(indexRaw).toBeDefined();
    const index = JSON.parse(indexRaw!) as { account: string; json: string; sha256: string }[];
    const seen = new Set<string>();
    for (const entry of index) {
      expect(seen.has(entry.account), entry.account).toBe(false);
      seen.add(entry.account);
      const file = preparedPanels.get(entry.json);
      expect(file, entry.json).toBeDefined();
      expect(entry.sha256, entry.json).toBe(sha256Of(file!));
    }
    expect(seen.size).toBe(registrySubjects.length);
  });

  test("stripping removes tokens that exist only inside each inert JSON block and keeps the visible markup", () => {
    const synthetic = [
      "<!doctype html><html><body>",
      "<main><h1>VISIBLE-HEAD-TOKEN</h1><p>VISIBLE-BODY-TOKEN</p></main>",
      '<script type="application/json" id="lk-messages">{"hint":"MESSAGES-ONLY-TOKEN"}</script>',
      '<script type="application/json" id="lk-panel-data">{"only":"DATA-ONLY-TOKEN"}</script>',
      "</body></html>",
    ].join("");
    const stripped = stripInertJsonBlocks(synthetic);
    expect(stripped, "lk-messages token survives").not.toContain("MESSAGES-ONLY-TOKEN");
    expect(stripped, "lk-panel-data token survives").not.toContain("DATA-ONLY-TOKEN");
    expect(stripped, "an application/json block survives").not.toMatch(/<script\b/i);
    expect(stripped).toContain("VISIBLE-HEAD-TOKEN");
    expect(stripped).toContain("VISIBLE-BODY-TOKEN");
  });

  test("every row's what, value and evidence ids are drawn in markup outside the inert blocks", () => {
    for (const [subject, data] of panelBySubject) {
      const account = subject.replace(/^near:mainnet:/, "");
      const page = preparedPanels.get(`${account}.html`);
      expect(page, account).toBeDefined();
      expect(page!.match(/<script type="application\/json" id="lk-messages">/g)?.length, account).toBe(1);
      expect(page!.match(/<script type="application\/json" id="lk-panel-data">/g)?.length, account).toBe(1);
      const markup = stripInertJsonBlocks(page!);
      expect(markup.length, account).toBeLessThan(page!.length);
      expect(markup, `${account} lk-messages block survives the strip`).not.toContain('id="lk-messages"');
      expect(markup, `${account} lk-panel-data block survives the strip`).not.toContain('id="lk-panel-data"');
      expect(markup, `${account} an application/json script survives the strip`).not.toMatch(/<script\b/i);
      for (const section of data.sections) {
        for (const row of section.rows) {
          const where = `${subject} ${section.title} "${row.what}"`;
          expect(markup.includes(row.what), `${where} what`).toBe(true);
          expect(markup.includes(row.value) || markup.includes(escapeLikeMarkup(row.value)), `${where} value`).toBe(true);
          for (const id of row.evidenceIds) {
            expect(markup.includes(id), `${where} evidence ${id}`).toBe(true);
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC7 - the chart                                                     */
/* ------------------------------------------------------------------ */

describe("AC7 charts", () => {
  test("every registry subject's chart validates with no problem and cites panel facts", () => {
    const isolated: string[] = [];
    for (const [subject, data] of panelBySubject) {
      const rendered = renderPanel(data);
      expect(validateFlowchartHtml(rendered.chart), subject).toEqual([]);
      const factIds = new Set([...data.facts.map((f) => f.id), ...data.relationFactIds]);
      const edges = extractJsonArray(rendered.chart, "edges") as { evidenceIds: string[] }[];
      if (edges.length === 0) {
        isolated.push(subject);
        continue;
      }
      for (const edge of edges) {
        expect(edge.evidenceIds.length, `${subject} edge`).toBeGreaterThan(0);
        expect(edge.evidenceIds.some((id) => factIds.has(id)), `${subject} edge evidence`).toBe(true);
      }
    }
    for (const subject of isolated) {
      const data = panelBySubject.get(subject)!;
      const rendered = renderPanel(data);
      expect(extractJsonArray(rendered.chart, "nodes"), subject).toHaveLength(1);
      expect(rendered.html, subject).toContain("no relation recorded");
    }
  });

  test("a subject with no relation fact gets a single-node chart and a stated gap", () => {
    const data = demoPanel();
    const chart = renderPanel(data).chart;
    expect(validateFlowchartHtml(chart)).toEqual([]);
    const nodes = extractJsonArray(chart, "nodes");
    expect(nodes.length).toBe(1);
    const html = renderPanel(data).html;
    expect(html).toContain("no relation recorded");
  });
});

/* ------------------------------------------------------------------ */
/* AC8 - CLI and site build                                            */
/* ------------------------------------------------------------------ */

describe("AC8 CLI and site build", () => {
  test("the panel CLI writes exactly the three files of E6", () => {
    const out = newTmpDir();
    const res = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", join(out, "cli"), "--offline"]);
    expect(res.exitCode).toBe(0);
    expect(readdirSync(join(out, "cli")).sort()).toEqual(
      [`${INTENTS_ACCOUNT}.chart.html`, `${INTENTS_ACCOUNT}.html`, `${INTENTS_ACCOUNT}.json`],
    );
  }, 60000);

  test("buildSite writes the three files per subject plus a plain index", async () => {
    const out = newTmpDir();
    const res = await buildSite({ outDir: out });
    expect(res.files.length).toBeGreaterThan(0);
    const rel = listFilesRelative(out);
    for (const subject of registrySubjects) {
      const account = subject.replace(/^near:mainnet:/, "");
      for (const suffix of [".html", ".json", ".chart.html"]) {
        expect(rel, `${account}${suffix}`).toContain(`panels/${account}${suffix}`);
      }
    }
    const index = JSON.parse(readFileSync(join(out, "panels", "index.json"), "utf8")) as { account: string; json: string; sha256: string }[];
    expect(index.map((e) => e.account).sort()).toEqual(registrySubjects.map((s) => s.replace(/^near:mainnet:/, "")).sort());
    for (const entry of index) {
      expect(entry.sha256).toBe(sha256Of(readFileSync(join(out, "panels", entry.json))));
    }
    const indexHtml = readFileSync(join(out, "panels", "index.html"), "utf8");
    for (const account of index.map((e) => e.account)) expect(indexHtml).toContain(account);
  }, 120000);

  test("existing site files stay byte-identical to a build made at the run's base commit", async () => {
    const baseCommit = process.env.LINCHPIN_PANEL_BASE_COMMIT;
    if (!baseCommit) {
      console.warn("AC8 base comparison skipped: LINCHPIN_PANEL_BASE_COMMIT is not set");
      return;
    }
    rmSync(BASE_TREE, { recursive: true, force: true });
    mkdirSync(BASE_TREE, { recursive: true });
    const tarPath = join(newTmpDir(), "base-archive.tar");
    const arch = Bun.spawnSync(["git", "archive", "--format=tar", baseCommit], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(arch.exitCode, arch.stderr.toString()).toBe(0);
    writeFileSync(tarPath, arch.stdout);
    const untar = Bun.spawnSync(["tar", "-xf", tarPath, "-C", BASE_TREE], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(untar.exitCode, untar.stderr.toString()).toBe(0);

    const baseMod = (await import(join(BASE_TREE, "src", "site", "site.ts"))) as { buildSite: typeof buildSite };
    const baseOut = newTmpDir();
    await baseMod.buildSite({ outDir: baseOut });
    const newOut = newTmpDir();
    await buildSite({ outDir: newOut });

    const baseFiles = listFilesRelative(baseOut);
    expect(baseFiles.length).toBeGreaterThan(0);
    const newFiles = listFilesRelative(newOut);
    for (const f of baseFiles) {
      expect(newFiles, f).toContain(f);
      expect(sha256Of(readFileSync(join(newOut, f))), f).toBe(sha256Of(readFileSync(join(baseOut, f))));
    }
  }, 180000);
});

/* ------------------------------------------------------------------ */
/* AC9 - replay and isolation                                          */
/* ------------------------------------------------------------------ */

describe("AC9 replay determinism", () => {
  test("two panel builds from the same snapshot are byte-identical", () => {
    const again = preparePanels(store, SNAPSHOT_ID);
    const canonical = (m: Map<string, string>) =>
      sha256Of([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}\u0000${v}`).join("\u0001"));
    expect(canonical(again)).toBe(canonical(preparedPanels));
  });

  test("two CLI builds produce byte-identical files", () => {
    const a = newTmpDir();
    const b = newTmpDir();
    const run = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", join(a, "run"), "--offline"]);
    expect(run.exitCode).toBe(0);
    const again = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", join(b, "run"), "--offline"]);
    expect(again.exitCode).toBe(0);
    const files = readdirSync(join(a, "run")).sort();
    expect(readdirSync(join(b, "run")).sort()).toEqual(files);
    for (const f of files) {
      expect(sha256Of(readFileSync(join(b, "run", f))), f).toBe(sha256Of(readFileSync(join(a, "run", f))));
    }
  }, 120000);
});

describe("AC9 network isolation of the spawned CLI child", () => {
  test("deliberate attempts inside the CLI child fail and the offline build still succeeds", () => {
    const out = newTmpDir();
    const res = spawnCLIWithNetTrap(["near", "panel", INTENTS_ACCOUNT, "--out", join(out, "cli"), "--offline"], { probe: true });
    expect(res.exitCode, res.stderr.slice(-800)).toBe(0);
    expect(res.logLines.filter((line) => line.endsWith(":NOT-BLOCKED")), res.logLines.join(" | ")).toEqual([]);
    expect(res.logLines.filter((line) => line.startsWith("probe:")).sort(),
      res.logLines.join(" | ")).toEqual(NET_TRAP_KINDS.map((k) => `probe:${k}:threw`).sort());
    expect(res.logLines.filter((line) => line.startsWith("attempt:")).sort(),
      res.logLines.join(" | ")).toEqual(NET_TRAP_KINDS.map((k) => `attempt:${k}`).sort());
    expect(readdirSync(join(out, "cli")).sort()).toEqual(
      [`${INTENTS_ACCOUNT}.chart.html`, `${INTENTS_ACCOUNT}.html`, `${INTENTS_ACCOUNT}.json`],
    );
  }, 60000);

  test("an offline CLI child makes zero network attempts and writes the three expected files", () => {
    const out = newTmpDir();
    const res = spawnCLIWithNetTrap(["near", "panel", INTENTS_ACCOUNT, "--out", join(out, "cli"), "--offline"]);
    expect(res.exitCode, res.stderr.slice(-800)).toBe(0);
    expect(res.logLines, res.logLines.join(" | ")).toEqual([]);
    expect(readdirSync(join(out, "cli")).sort()).toEqual(
      [`${INTENTS_ACCOUNT}.chart.html`, `${INTENTS_ACCOUNT}.html`, `${INTENTS_ACCOUNT}.json`],
    );
  }, 60000);
});

/* ------------------------------------------------------------------ */
/* AC10 - constructed and changes                                      */
/* ------------------------------------------------------------------ */

describe("AC10 constructed snapshot and changes", () => {
  test("the constructed panel is labelled CONSTRUCTED on the capture line and in the JSON", () => {
    const both = loadNearSnapshots([SNAPSHOT_ID, CONSTRUCTED_ID]);
    const data = buildPanel(both, CONSTRUCTED_ID, INTENTS, { beforeSnapshotId: SNAPSHOT_ID });
    expect(data.capture.constructed).toBe(true);
    expect(data.capture.label).toBe("CONSTRUCTED");
    expect(JSON.stringify(data)).toContain("CONSTRUCTED");
    expect(renderPanel(data).html).toContain("CONSTRUCTED");
  });

  test("with --before, changes hold exactly the fanned-out changes-query rows", () => {
    const both = loadNearSnapshots([SNAPSHOT_ID, CONSTRUCTED_ID]);
    const data = buildPanel(both, CONSTRUCTED_ID, INTENTS, { beforeSnapshotId: SNAPSHOT_ID });
    const changes = data.sections.find((s) => s.title === "Changes")!;

    const fanout = new Set<string>();
    for (const snapshotId of [SNAPSHOT_ID, CONSTRUCTED_ID]) {
      const snapshot = both.snapshot(snapshotId)!;
      for (const f of snapshot.facts) {
        if (f.subject === INTENTS || f.subject.startsWith(`${INTENTS}#`)) fanout.add(f.subject);
      }
    }
    expect(fanout.has(INTENTS)).toBe(true);
    const unionKeys: string[] = [];
    for (const subject of fanout) {
      const result = runQuery(both, {
        name: "changes", subject, beforeSnapshotId: SNAPSHOT_ID, afterSnapshotId: CONSTRUCTED_ID, maxResults: 500,
      });
      unionKeys.push(...result.changes.map((c) => c.key));
    }
    const rowKeys = changes.rows.map((r) => r.change?.key);
    expect(rowKeys.sort()).toEqual(unionKeys.sort());

    const locker = changes.rows.find((r) => (r.change?.key ?? "").includes("UnrestrictedAccountLocker"));
    expect(locker).toBeDefined();
    expect(locker!.change!.kind).toBe("added");
    expect(locker!.change!.after?.predicate ?? "").toBe("holds-role");
  });
});

/* ------------------------------------------------------------------ */
/* AC11 - words, accessibility, public tree                            */
/* ------------------------------------------------------------------ */

describe("AC11 words and accessibility", () => {
  test("no generated file contains a banned word", () => {
    const files = new Map<string, string>();
    for (const [name, content] of preparedPanels) files.set(name, content);
    const out = newTmpDir();
    const res = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", join(out, "cli"), "--offline"]);
    expect(res.exitCode).toBe(0);
    for (const name of readdirSync(join(out, "cli"))) files.set(name, readFileSync(join(out, "cli", name), "utf8"));
    for (const [name, content] of files) {
      const lower = content.toLowerCase();
      for (const word of BANNED_WORDS) {
        expect(lower.includes(String(word).toLowerCase()), `${name} contains "${word}"`).toBe(false);
      }
    }
  }, 120000);

  test("each panel page has one h1, one main, and only links and details as interactive elements", () => {
    for (const [name, content] of preparedPanels) {
      if (!name.endsWith(".html") || name.endsWith(".chart.html")) continue;
      expect(content.match(/<h1[\s>]/gi)?.length, name).toBe(1);
      expect(content.match(/<main[\s>]/gi)?.length, name).toBe(1);
      expect(content, name).not.toMatch(/<(button|input|select|textarea|form|iframe|embed|object)\b/i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* AC12 - narrow document wrapper and refusals                         */
/* ------------------------------------------------------------------ */

function stripAdditions(html: string): string {
  const navStart = html.indexOf('<nav id="lk-panel-links"');
  const dataStart = html.indexOf('<script type="application/json" id="lk-panel-data"');
  expect(navStart).toBeGreaterThan(-1);
  expect(dataStart).toBeGreaterThan(navStart);
  const navEnd = html.indexOf("</nav>", navStart) + "</nav>".length;
  const dataEnd = html.indexOf("</script>", dataStart) + "</script>".length;
  const cut = (s: string, start: number, end: number): string => {
    const from = s[start - 1] === "\n" ? start - 1 : start;
    return s.slice(0, from) + s.slice(end);
  };
  return cut(cut(html, dataStart, dataEnd), navStart, navEnd);
}

describe("AC12 narrow wrapper recovery and refusal", () => {
  test("removing the two additions recovers the kit bytes for every panel", () => {
    for (const [subject, data] of panelBySubject) {
      const account = subject.replace(/^near:mainnet:/, "");
      const kit = panelKitPage(data);
      const composed = composePanelDocument(kit, account, data);
      expect(stripAdditions(composed.html), subject).toBe(kit);
    }
  });

  test("the wrapper adds exactly two relative links, Chart and Index, styled color:inherit", () => {
    const kit = panelKitPage(intentsPanel);
    expect(kit).not.toMatch(/<a\b/i);
    const composed = composePanelDocument(kit, INTENTS_ACCOUNT, intentsPanel);
    const navStart = composed.html.indexOf('<nav id="lk-panel-links"');
    const navEnd = composed.html.indexOf("</nav>", navStart);
    const nav = composed.html.slice(navStart, navEnd);
    expect(nav).not.toContain("<style");
    const anchors = [...nav.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    expect(anchors.map((m) => [m[1], m[2]])).toEqual([
      [`${INTENTS_ACCOUNT}.chart.html`, "Chart"],
      ["index.html", "Index"],
    ]);
    for (const m of nav.matchAll(/style="([^"]*)"/g)) expect(m[1]).toBe("color:inherit");
  });

  test("documents with missing or duplicated anchors are refused, not guessed", () => {
    const kit = panelKitPage(intentsPanel);
    const noMain = kit.replace("</main>", "</section>");
    expect(noMain).not.toContain("</main>");
    const dupNav = kit.replace("</main>", '<nav id="lk-panel-links"></nav></main>');
    const dupData = kit.replace("</body>", '<script type="application/json" id="lk-panel-data">{}</script></body>');
    for (const mutated of [noMain, dupNav, dupData]) {
      let caught: unknown;
      try { composePanelDocument(mutated, INTENTS_ACCOUNT, intentsPanel); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PanelRejected);
      expect((caught as PanelRejected).code).toBe("invalid-document");
    }
  });

  test("wrapper link refusals apply end-to-end before any html is returned", () => {
    const kit = panelKitPage(intentsPanel);
    for (const links of [
      { chartHref: "/intents.near.chart.html", indexHref: "index.html" },
      { chartHref: "intents.near.chart.html", indexHref: "https://elsewhere.test/index.html" },
      { chartHref: "../intents.near.chart.html", indexHref: "index.html" },
    ]) {
      let caught: unknown;
      try { composePanelDocument(kit, INTENTS_ACCOUNT, intentsPanel, links); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PanelRejected);
      expect((caught as PanelRejected).code).toBe("invalid-document");
    }
  });

  test("json terminators stay inert inside the composed page", () => {
    const composed = composePanelDocument(panelKitPage(intentsPanel), INTENTS_ACCOUNT, intentsPanel);
    const blockStart = composed.html.indexOf('<script type="application/json" id="lk-panel-data">');
    const blockEnd = composed.html.indexOf("</script>", blockStart);
    expect(composed.html.slice(blockStart, blockEnd)).not.toContain("</script");
  });
});

describe("AC12 W2 link families refused by the wrapper", () => {
  const refusals: [string, string, string][] = [
    ["an absolute path", "/intents.near.chart.html", "index.html"],
    ["an absolute path on the index", "intents.near.chart.html", "/index.html"],
    ["an https scheme", "https://mirror.test/intents.near.chart.html", "index.html"],
    ["an https scheme on the index", "intents.near.chart.html", "https://elsewhere.test/index.html"],
    ["another scheme", "mailto:chart@example.test", "index.html"],
    ["a protocol-relative url", "//mirror.test/intents.near.chart.html", "index.html"],
    ["a parent segment", "../intents.near.chart.html", "index.html"],
    ["an inner parent segment", "intents.near.chart.html", "sub/../index.html"],
    ["a query target", "intents.near.chart.html", "index.html?ver=2"],
    ["a hash target", "intents.near.chart.html", "index.html#files"],
    ["an encoded separator", "intents.near%2fchart.html", "index.html"],
    ["an encoded name", "intents.near.chart.html", "index%2ehtml"],
    ["a backslash separator", "intents.near\\chart.html", "index.html"],
    ["a colon in the name", "a:b.html", "index.html"],
    ["a malformed name", "chart.html", "index.html"],
    ["another account's chart", "other.near.chart.html", "index.html"],
    ["an uppercase name", "intents.near.chart.html", "INDEX.HTML"],
    ["a trailing space", "intents.near.chart.html ", "index.html"],
    ["a directory-prefixed index", "intents.near.chart.html", "./index.html"],
    ["a wrong index suffix", "intents.near.chart.html", "index.htm"],
  ];

  test("the exact wrapper links are the only accepted pair", () => {
    expect(() => validatePanelLinks(INTENTS_ACCOUNT, { chartHref: `${INTENTS_ACCOUNT}.chart.html`, indexHref: "index.html" })).not.toThrow();
    const composed = composePanelDocument(panelKitPage(intentsPanel), INTENTS_ACCOUNT, intentsPanel);
    expect(composed.html).toContain(`href="${INTENTS_ACCOUNT}.chart.html"`);
    expect(composed.html).toContain('href="index.html"');
  });

  test("every refused family is rejected as invalid-document by the validator and before composition returns", () => {
    const kit = panelKitPage(intentsPanel);
    for (const [label, chartHref, indexHref] of refusals) {
      let validatorCaught: unknown;
      try { validatePanelLinks(INTENTS_ACCOUNT, { chartHref, indexHref }); } catch (e) { validatorCaught = e; }
      expect(validatorCaught, label).toBeInstanceOf(PanelRejected);
      expect((validatorCaught as PanelRejected).code, label).toBe("invalid-document");

      let composeCaught: unknown;
      try { composePanelDocument(kit, INTENTS_ACCOUNT, intentsPanel, { chartHref, indexHref }); } catch (e) { composeCaught = e; }
      expect(composeCaught, label).toBeInstanceOf(PanelRejected);
      expect((composeCaught as PanelRejected).code, label).toBe("invalid-document");
    }
  });
});

describe("AC12 W3 inert data serialization", () => {
  test("plain json values serialize, round-trip and are deterministic", () => {
    const value = { a: [1, "x", true, null], b: { c: -0.5, d: "" }, e: [] };
    const twin = { a: [1, "x", true, null], b: { c: -0.5, d: "" }, e: [] };
    const bytes = serializePanelData(value);
    expect(JSON.parse(bytes)).toEqual(value);
    expect(serializePanelData(twin)).toBe(bytes);
    expect(serializePanelData(value)).toBe(bytes);
    expect(JSON.parse(serializePanelData(null))).toBe(null);
    expect(JSON.parse(serializePanelData(42))).toBe(42);
    expect(JSON.parse(serializePanelData("plain"))).toBe("plain");
    expect(JSON.parse(serializePanelData(true))).toBe(true);
  });

  test("unsupported values, non-finite numbers, cycles and accessors are refused without invoking getters", () => {
    let getterHits = 0;
    const refusals: [string, () => unknown][] = [
      ["NaN", () => serializePanelData({ v: NaN })],
      ["+Infinity", () => serializePanelData({ v: Infinity })],
      ["-Infinity", () => serializePanelData({ v: -Infinity })],
      ["a function value", () => serializePanelData({ v: () => 1 })],
      ["a symbol value", () => serializePanelData({ v: Symbol("panel") })],
      ["a bigint value", () => serializePanelData({ v: BigInt(1) })],
      ["an undefined value", () => serializePanelData({ v: undefined })],
      ["an undefined document", () => serializePanelData(undefined)],
      ["a class instance", () => { class Probe { member = 1; } return serializePanelData({ v: new Probe() }); }],
      ["a Date", () => serializePanelData({ v: new Date(0) })],
      ["a Map", () => serializePanelData({ v: new Map() })],
      ["a Set", () => serializePanelData({ v: new Set() })],
      ["a sparse array", () => { const sparse: number[] = Array(3); sparse[0] = 1; sparse[2] = 3; return serializePanelData(sparse); }],
      ["an array of only holes", () => serializePanelData(Array(2))],
      ["a symbol key", () => serializePanelData({ [Symbol("panel")]: 1 })],
      ["a self-referencing object", () => { const a: Record<string, unknown> = {}; a.self = a; return serializePanelData(a); }],
      ["a self-referencing array", () => { const a: unknown[] = ["x"]; a.push(a); return serializePanelData(a); }],
      ["a mutual cycle", () => {
        const a: Record<string, unknown> = {};
        const b: Record<string, unknown> = { peer: a };
        a.peer = b;
        return serializePanelData(a);
      }],
      ["a getter property", () => serializePanelData({ get trapped() { getterHits += 1; return 1; } })],
      ["a setter-only property", () => serializePanelData({ set trapped(v: unknown) { throw new Error("setter invoked"); } })],
    ];
    for (const [label, attempt] of refusals) {
      let caught: unknown;
      try { attempt(); } catch (e) { caught = e; }
      expect(caught, label).toBeInstanceOf(PanelRejected);
      expect((caught as PanelRejected).code, label).toBe("invalid-document");
    }
    expect(getterHits).toBe(0);
  });

  test("a cyclic document is refused before composition returns", () => {
    const cyclic: Record<string, unknown> = { subject: INTENTS };
    cyclic.self = cyclic;
    let caught: unknown;
    try { composePanelDocument(panelKitPage(intentsPanel), INTENTS_ACCOUNT, cyclic); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PanelRejected);
    expect((caught as PanelRejected).code).toBe("invalid-document");
  });

  test("terminator characters are escaped so a planted terminator stays inert in the block", () => {
    const hostile = "</script><img src=x onerror=alert(1)>&\u2028line\u2029";
    const bytes = serializePanelData({ s: hostile });
    for (const ch of ["<", ">", "&", "\u2028", "\u2029"]) {
      expect(bytes.includes(ch), JSON.stringify(ch)).toBe(false);
    }
    expect((JSON.parse(bytes) as { s: string }).s).toBe(hostile);
    const composed = composePanelDocument(panelKitPage(intentsPanel), INTENTS_ACCOUNT, { s: hostile } as unknown as PanelData);
    const openTag = '<script type="application/json" id="lk-panel-data">';
    expect(composed.html).toContain(`${openTag}${bytes}</script>`);
    const blockStart = composed.html.indexOf(openTag);
    const blockEnd = composed.html.indexOf("</script>", blockStart);
    const block = composed.html.slice(blockStart + openTag.length, blockEnd);
    expect(block).not.toContain("</script");
    for (const ch of ["<", ">", "&"]) expect(block.includes(ch), JSON.stringify(ch)).toBe(false);
  });

/* ------------------------------------------------------------------ */
/* Post-archive review repairs: narrow regressions                     */
/*                                                                    */
/* Expected values come from the approved spec and Peter's recorded    */
/* repair decisions only, never from current output.                   */
/* ------------------------------------------------------------------ */

const PANEL_DATA_OPEN_TAG = '<script type="application/json" id="lk-panel-data">';

/** Reads the inert lk-panel-data block back out of a composed page. */
function panelDataBlock(html: string): string {
  const start = html.indexOf(PANEL_DATA_OPEN_TAG);
  expect(start, "the composed page holds one lk-panel-data block").toBeGreaterThan(-1);
  const from = start + PANEL_DATA_OPEN_TAG.length;
  return html.slice(from, html.indexOf("</script>", from));
}

describe("repair regression: document replacement treats supplied JSON bytes literally", () => {
  const METACHAR_TOKENS = ["$&", "$'", "$`", "$$", "a$&b$'c$`d$$e"];

  test("each replacement metacharacter survives byte-identical between block, external JSON and round-trip", () => {
    const kit = panelKitPage(intentsPanel);
    for (const token of METACHAR_TOKENS) {
      const value = { tag: token };
      const bytes = serializePanelData(value);
      expect(JSON.parse(bytes), token).toEqual(value);
      const composed = composePanelDocument(kit, INTENTS_ACCOUNT, value);
      expect(composed.json, token).toBe(bytes);
      expect(composed.html, token).toContain(`${PANEL_DATA_OPEN_TAG}${bytes}</script>`);
      expect(panelDataBlock(composed.html), token).toBe(bytes);
      expect((JSON.parse(composed.json) as { tag: string }).tag, token).toBe(token);
    }
  });

  test("rendered output keeps the tokens byte-identical across the block, exact json and the written file", async () => {
    for (const token of METACHAR_TOKENS) {
      const hostile = { ...demoPanel(), notes: { tag: token } } as PanelData;
      const bytes = serializePanelData(hostile);
      const rendered = renderPanel(hostile);
      expect(rendered.json, token).toBe(bytes);
      expect(panelDataBlock(rendered.html), token).toBe(bytes);
      expect((JSON.parse(rendered.json) as { notes: { tag: string } }).notes.tag, token).toBe(token);
      const out = newTmpDir();
      await writePanelFiles(out, panelFiles(rendered));
      expect(readdirSync(out).sort(), token).toEqual(
        [`${DEMO_ACCOUNT}.chart.html`, `${DEMO_ACCOUNT}.html`, `${DEMO_ACCOUNT}.json`],
      );
      expect(readFileSync(join(out, `${DEMO_ACCOUNT}.json`), "utf8"), token).toBe(bytes);
      expect(panelDataBlock(readFileSync(join(out, `${DEMO_ACCOUNT}.html`), "utf8")), token).toBe(bytes);
    }
  }, 60000);
});

describe("repair regression: CLI output roots across OS temp families and symlink refusal", () => {
  const createdParents: string[] = [];
  afterAll(() => {
    for (const dir of createdParents) rmSync(dir, { recursive: true, force: true });
  });

  /** Every OS-managed temp root family of this host, alias-formed and canonical-formed. */
  function osTempRoots(): { root: string; aliasFamily: boolean }[] {
    const candidates = new Set<string>(["/tmp", "/var/tmp", tmpdir(), realpathSync(tmpdir())]);
    const roots: { root: string; aliasFamily: boolean }[] = [];
    for (const root of candidates) {
      try {
        if (!statSync(root).isDirectory()) continue;
      } catch {
        continue;
      }
      roots.push({ root, aliasFamily: realpathSync(root) !== root });
    }
    return roots;
  }

  test("a fresh missing parent plus child directly under each OS temp family builds exit 0 with exactly three files", () => {
    const roots = osTempRoots();
    expect(roots.length, "this host exposes at least one temp root").toBeGreaterThan(0);
    for (const { root, aliasFamily } of roots) {
      console.info(`panel output-root coverage: ${aliasFamily ? "OS alias family" : "canonical"} root exercised`);
      const parent = join(root, `panel-root-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      createdParents.push(parent);
      const dir = join(parent, "child");
      const res = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", dir, "--offline"]);
      expect(res.exitCode, `${root}: ${res.stderr.slice(-400)}`).toBe(0);
      expect(readdirSync(dir).sort(), root).toEqual(
        [`${INTENTS_ACCOUNT}.chart.html`, `${INTENTS_ACCOUNT}.html`, `${INTENTS_ACCOUNT}.json`],
      );
    }
  }, 180000);

  test("a user-created directory symlink as the output destination is refused and an external sentinel stays unchanged", () => {
    const base = newTmpDir();
    const outside = join(base, "outside");
    mkdirSync(outside);
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched-bytes");
    const link = join(base, "linked-out");
    symlinkSync(outside, link, "dir");
    const res = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", link, "--offline"]);
    expect(res.exitCode, res.stderr.slice(-400)).not.toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched-bytes");
    expect(readdirSync(outside).sort()).toEqual(["sentinel.txt"]);
  }, 60000);

  test("a symlinked output leaf under a real parent is refused before writing outside the destination", () => {
    const base = newTmpDir();
    const vault = join(base, "vault");
    mkdirSync(vault);
    const sentinel = join(vault, "sentinel.txt");
    writeFileSync(sentinel, "untouched-bytes");
    const parent = join(base, "plain");
    mkdirSync(parent);
    const leaf = join(parent, "leaf");
    symlinkSync(vault, leaf, "dir");
    const res = spawnCLI(["near", "panel", INTENTS_ACCOUNT, "--out", leaf, "--offline"]);
    expect(res.exitCode, res.stderr.slice(-400)).not.toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched-bytes");
    expect(readdirSync(parent).sort()).toEqual(["leaf"]);
  }, 60000);
});

describe("repair regression: capture-scope sentence follows unknown and none-read gaps only", () => {
  const SENTENCE = "Capture scope; unresolved items are shown in the rows.";
  const STRUCTURAL_REASONS = ["not a DAO", "no relation recorded", "one capture only: nothing to compare"];
  const COVERAGE_REASONS = ["unknown", "none read"];

  function visibleText(html: string): string {
    return stripInertJsonBlocks(html)
      .replace(/<style\b[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ");
  }

  /** Slices the visible text into one region per E2 section, in order. */
  function sectionRegions(text: string): Map<string, string> {
    const regions = new Map<string, string>();
    let cursor = 0;
    for (let i = 0; i < E2_TITLES.length; i++) {
      const title = E2_TITLES[i];
      let at = text.indexOf(title, cursor);
      if (at === -1 && i === 0) {
        at = 0;
      }
      expect(at, `${title} region is resolvable`).toBeGreaterThan(-1);
      const next = i + 1 < E2_TITLES.length
        ? text.indexOf(E2_TITLES[i + 1], at === 0 && i === 0 ? 0 : at + title.length)
        : text.length;
      regions.set(title, text.slice(at, next === -1 ? text.length : next));
      cursor = at === 0 && i === 0 ? 0 : at + title.length;
    }
    return regions;
  }

  test("sections whose gaps are only structural keep every reason row and omit the sentence", () => {
    let checked = 0;
    for (const [subject, data] of panelBySubject) {
      const regions = sectionRegions(visibleText(renderPanel(data).html));
      for (const section of data.sections) {
        const gapRows = section.rows.filter((r) => r.gap);
        if (gapRows.length === 0 || !gapRows.every((r) => STRUCTURAL_REASONS.includes(r.value))) continue;
        checked++;
        const region = regions.get(section.title)!;
        expect(region, `${subject} ${section.title} omits the capture-scope sentence`).not.toContain(SENTENCE);
        for (const row of gapRows) {
          expect(region.includes(row.what), `${subject} ${section.title} keeps "${row.what}"`).toBe(true);
          expect(region.includes(row.value), `${subject} ${section.title} keeps "${row.value}"`).toBe(true);
        }
      }
    }
    expect(checked, "at least one structural-only section exists in the snapshot walk").toBeGreaterThan(0);
  });

  test("sections with an unknown or none-read gap keep the sentence beside their rows", () => {
    let checked = 0;
    for (const [subject, data] of panelBySubject) {
      const regions = sectionRegions(visibleText(renderPanel(data).html));
      for (const section of data.sections) {
        if (!section.rows.some((r) => r.gap && COVERAGE_REASONS.includes(r.value))) continue;
        checked++;
        const region = regions.get(section.title)!;
        expect(region, `${subject} ${section.title} carries the capture-scope sentence`).toContain(SENTENCE);
        for (const row of section.rows.filter((r) => r.gap)) {
          expect(region.includes(row.value), `${subject} ${section.title} keeps "${row.value}"`).toBe(true);
        }
      }
    }
    expect(checked, "at least one unknown or none-read section exists in the snapshot walk").toBeGreaterThan(0);
  });

  test("the sentence appears exactly once per coverage-gap section and nowhere else on the page", () => {
    for (const [subject, data] of panelBySubject) {
      const text = visibleText(renderPanel(data).html);
      const expected = data.sections.filter((s) => s.rows.some((r) => r.gap && COVERAGE_REASONS.includes(r.value))).length;
      expect(text.split(SENTENCE).length - 1, subject).toBe(expected);
    }
  });
});

describe("repair regression: banned-word gate covers the inert JSON channel", () => {
  expect(BANNED_WORDS).toContain("safe");
  expect(BANNED_WORDS).toContain("recommend");

  function withMetadata(metadata: Record<string, unknown>): PanelData {
    return { ...demoPanel(), ...metadata } as PanelData;
  }

  test("a quoted banned word inside JSON-only metadata is refused before any html is produced", () => {
    let caught: unknown;
    try { renderPanel(withMetadata({ notes: { note: "this capture is safe" } })); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PanelRejected);
  });

  test("quoted, mixed-case, key-name and further banned-word occurrences are refused alike", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["a mixed-case word", { notes: { note: "Safe" } }],
      ["a banned word as a JSON key", { notes: { safe: "recorded" } }],
      ["another banned word", { notes: { note: "we recommend" } }],
    ];
    for (const [label, metadata] of cases) {
      let caught: unknown;
      try { renderPanel(withMetadata(metadata)); } catch (e) { caught = e; }
      expect(caught, label).toBeInstanceOf(PanelRejected);
    }
  });

  test("the refusal follows the banned word, not the metadata shape", () => {
    expect(() => renderPanel(withMetadata({ notes: { note: "s a f e apart" } }))).not.toThrow();
    let caught: unknown;
    try { renderPanel(withMetadata({ notes: { note: "safe" } })); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PanelRejected);
  });

  test("harmless JSON-only metadata still renders with byte-identical parity and stays inert", async () => {
    const ok = withMetadata({ notes: { note: "captured rows and receipts", revision: 2 } });
    const bytes = serializePanelData(ok);
    const rendered = renderPanel(ok);
    expect(rendered.json).toBe(bytes);
    expect(panelDataBlock(rendered.html)).toBe(bytes);
    expect((JSON.parse(bytes) as { notes: { note: string; revision: number } }).notes).toEqual(
      { note: "captured rows and receipts", revision: 2 },
    );
    assertInertPanelHtml(rendered.html, DEMO_ACCOUNT);
  }, 60000);

  test("the build entry refuses a panel whose rendered rows would carry a banned word", () => {
    const snap = structuredClone(loadNearSnapshot(CONSTRUCTED_ID).snapshot(CONSTRUCTED_ID)!);
    const fact = snap.facts.find((f) => f.predicate === "paused");
    expect(fact).toBeDefined();
    fact!.object = "the paused flag is safe";
    const planted = openStore([snap]);
    let caught: unknown;
    try { preparePanels(planted, CONSTRUCTED_ID); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PanelRejected);
  }, 60000);
});
});
