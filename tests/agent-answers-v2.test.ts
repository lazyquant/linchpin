/**
 * Independent tests for the answers module: a question becomes a cited answer surface drawn with the UI kit.
 * Every expected value comes from the approved contracts (the v2 and v1 specs, the kit, the committed bundles)
 * and from this file's own derivation over the bundles it builds — never from what the implementation prints.
 *
 * Pins below were taken from recorded runs over the committed bundles and from the contracts themselves.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpNamespace from "node:http";
import * as httpsNamespace from "node:https";
import { canonical, sha256 } from "../src/chain/evidence";
import { runOptions } from "../src/config";
import { RecordingRpc } from "../src/chain/rpc";
import { buildPack, type DocsCapture, type PackFile, type PackRegistry } from "../src/pack/build";
import { TOKENOMICS_REGISTRY, type ProtocolEntry } from "../src/tokenomics/registry";
import type { BundleResponse, SectionId } from "../src/tokenomics/api";
import { runTokenomicsLocal, tokenomicsQueries } from "../src/graph/tokenomics-neo4j";
import { CATALOG, catalogJson } from "../src/ui/catalog";
import { A2UI_VERSION, createSurface, updateComponents, updateDataModel } from "../src/ui/messages";
import { interpret } from "../src/ui/interpret";
import { mount } from "../src/ui/mount";
import { instantiate, listViewTemplates } from "../src/ui/templates";
import { receiptResolver, validateSurface } from "../src/ui/validate";
import { STRINGS, TEXT_RULE_WORDS } from "../src/ui/strings";
import type { A2uiMessage, ResolveEvidence, SurfaceTree, UiNode } from "../src/ui/types";
import { KIT_CSS } from "../src/ui/page";
import type { Coverage as RetrievalCoverage, RetrievalBackend, RetrievalResult, TemplateDescriptor } from "../src/answers/retrieval";
import { MECHANICS, RetrievalError } from "../src/answers/retrieval";
import { BundleBackend, bundleSource, snapshotId, templatesSha256, type BundleSource } from "../src/answers/bundle-backend";
import { TOOL_SPECS } from "../src/answers/tools";
import {
  ScriptedModel, ReplayModel, ModelError, answerQuestion, requestSha256, protocolScope,
  type ModelRequest, type ModelReply, type PlannerModel, type Script,
} from "../src/answers/planner";
import {
  SURFACE_ID, REFUSAL_TEXT, NO_MODEL_TEXT, PINNED_LABEL, REPLY_STRINGS, RULE_CODES_PREFIX, answerMeta,
} from "../src/answers/compose";
import { createAnswersHandler } from "../src/answers/handler";
import { GOLDEN, goldenModel, pinnedAnswers } from "../src/answers/pinned";
import { cacheKey, normaliseQuestion } from "../src/answers/log";
import { PROMPT_RULES, SYSTEM_PROMPT, PROMPT_SHA256 } from "../src/answers/prompt";
import { parseServeArgs, startAnswersServer } from "../src/answers/serve";
import { anthropicModelFromEnv, MODEL_VARIABLE } from "../src/answers/anthropic";

/* ---------- fixtures ---------- */

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "agent-answers-v2");
const readJson = (file: string): any => JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
const GOLDEN_FIXTURE = readJson("golden.json") as {
  questions: {
    id: string; protocol: string; question: string;
    script: Script;
    expect: any;
    checks?: Record<string, any>;
  }[];
};
const ADVERSARIAL = readJson("adversarial.json") as {
  recipes: { code: string; rule: string; tool?: any; backend?: string; bad: any; good: any; markerId: string; markerText: string }[];
  refusalCase: { code: string; tool: any; badA: any; badB: any; markers: string[] };
};

/* ---------- pins (from recorded runs over the committed bundles, and from the contracts) ---------- */

const PINNED = {
  promptRulesSha256: "ffb8e6c850557f89c413eb89d49da025524a9db72bff81e1101d1dd47749bd9e",
  systemPromptSha256: "c2dfa98268499349cbee9d375f4592f2dc6a92a08d7e2ae27493dcdea6b6a119",
  marinadeBundleSha256: "9e6fe9f8b0ef727a99eb93b529a396ab76072e08ede7067c787bc7d8bd605840",
  kaminoBundleSha256: "53e20a4b04c7c024577051318454bc9dee8061d0fa6db1c4b22a8484306ce3f7",
  pinnedDocumentSha256: "8e1463e023640212d92f4471ad42c27975bef29414fd6e5d92882c1a6687a6b8",
};

/* ---------- offline: the whole file traps the network except its own in-process origins ---------- */

const hits = { fetch: 0, websocket: 0, connect: 0, net: 0, http: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
const allowedOrigins = new Set<string>();
const realFetch = globalThis.fetch.bind(globalThis);
const restoreFns: (() => void)[] = [];

const urlOf = (input: unknown): string => {
  try {
    if (typeof input === "string") return input;
    const url = (input as { url?: string })?.url;
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
};
const guardedFetch: typeof fetch = ((input: any, init?: any) => {
  const url = urlOf(input);
  if ([...allowedOrigins].some((origin) => url.startsWith(`${origin}/`) || url === origin)) return realFetch(input, init);
  hits.fetch++;
  throw trapError("fetch");
}) as unknown as typeof fetch;

beforeAll(() => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(guardedFetch as any);
  restoreFns.push(() => fetchSpy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class {
    constructor() { hits.websocket++; throw trapError("WebSocket"); }
  };
  restoreFns.push(() => { (globalThis as any).WebSocket = realWebSocket; });
  const realConnect = (Bun as any).connect;
  (Bun as any).connect = (): never => { hits.connect++; throw trapError("Bun.connect"); };
  restoreFns.push(() => { (Bun as any).connect = realConnect; });
  for (const mod of [netNamespace as any, netDefault as any, httpNamespace as any, httpsNamespace as any]) {
    for (const name of ["connect", "createConnection", "request", "get"]) {
      if (typeof mod[name] !== "function") continue;
      try {
        const spy = spyOn(mod, name).mockImplementation(((): never => { hits.net++; throw trapError(`node module ${name}`); }) as any);
        restoreFns.push(() => spy.mockRestore());
      } catch {
        const real = mod[name];
        mod[name] = (): never => { hits.net++; throw trapError(`node module ${name}`); };
        restoreFns.push(() => { mod[name] = real; });
      }
    }
  }
}, 60000);

/* ---------- bundles: built once by this file, from the committed captures ---------- */

const NEO4J_KEYS = ["NEO4J_URI", "NEO4J_PASSWORD", "NEO4J_USERNAME", "NEO4J_DATABASE"] as const;
const savedEnv: Record<string, string | undefined> = {};

let sources: BundleSource[] = [];
let backend: BundleBackend;
const sourceOf = (protocol: string): BundleSource => sources.find((source) => source.id === protocol)!;

async function buildMarinadeSource(entry: ProtocolEntry): Promise<BundleSource> {
  const config = JSON.parse(readFileSync(join(ROOT, "packs/marinade/pack.json"), "utf8")) as PackFile;
  const registry = JSON.parse(readFileSync(join(ROOT, config.registry), "utf8")) as PackRegistry;
  const docsCapture = JSON.parse(readFileSync(join(ROOT, config.docsCapture), "utf8")) as DocsCapture;
  const opts = runOptions({
    offline: true, record: false, refresh: false, rpcUrl: "http://127.0.0.1:1",
    fixturesDir: join(ROOT, "fixtures"), outDir: join(ROOT, "out/answers-tests"),
  });
  const rpc = new RecordingRpc(opts, "marinade-pack");
  const packet = await buildPack(rpc, registry, { title: config.title, docsCapture, burns: config.burns, ledger: config.ledger });
  expect(rpc.counts.live).toBe(0);
  const build = await entry.load(ROOT, { marinadePack: { packet, evidence: rpc.evidence } } as any);
  return bundleSource(entry, build);
}

beforeAll(async () => {
  for (const key of NEO4J_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  const marinadeEntry = TOKENOMICS_REGISTRY.find((entry) => entry.id === "marinade")!;
  const kaminoEntry = TOKENOMICS_REGISTRY.find((entry) => entry.id === "kamino")!;
  const marinadeSource = await buildMarinadeSource(marinadeEntry);
  const kaminoBuild = await kaminoEntry.load(ROOT, {} as any);
  sources = [marinadeSource, bundleSource(kaminoEntry, kaminoBuild)];
  backend = new BundleBackend(sources);
}, 180000);

afterAll(() => {
  for (const restore of restoreFns.splice(0).reverse()) restore();
  for (const key of NEO4J_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/* ---------- shared helpers ---------- */

const uniq = (values: string[]): string[] => [...new Set(values)];
const lines = (ndjson: string): any[] => ndjson.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
const valueText = (value: unknown, gapWord: string): string =>
  value === null || value === undefined || value === "" || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    ? gapWord
    : String(value);

/** Every wire rule the reply must satisfy, checked the way the contract words it. */
function replyProblems(ndjson: string, resolver: ResolveEvidence): string[] {
  const problems: string[] = [];
  const rawLines = ndjson.split("\n").filter((line) => line !== "");
  if (rawLines.length !== 3) problems.push(`expected three lines, got ${rawLines.length}`);
  const parsed = rawLines.map((line) => { try { return JSON.parse(line); } catch { problems.push("a line is not one JSON object"); return null; } });
  if (parsed.some((line) => line === null)) return problems;
  const order = ["createSurface", "updateDataModel", "updateComponents"];
  order.forEach((key, at) => {
    const message = parsed[at];
    if (!message || !message[key]) problems.push(`message ${at} is not ${key}`);
    else if (message.version !== A2UI_VERSION) problems.push(`message ${at} has the wrong version`);
  });
  const [first, second, third] = parsed;
  if (first?.createSurface) {
    if (first.createSurface.surfaceId !== SURFACE_ID) problems.push("the surface id is not answer");
    if (first.createSurface.catalogId !== CATALOG.id) problems.push("the catalog is not the kit catalog");
  }
  if (second?.updateDataModel?.path !== "/") problems.push("updateDataModel path is not /");
  for (const component of third?.updateComponents?.components ?? []) {
    if (!Object.prototype.hasOwnProperty.call(CATALOG.components, component.component)) {
      problems.push(`component ${component.component} is not a kit catalog key`);
    }
  }
  let coverage: unknown;
  try { coverage = second?.updateDataModel?.value?.coverage; } catch { coverage = undefined; }
  const check = validateSurface(parsed as unknown as A2uiMessage[], { resolveEvidence: resolver, coverage: coverage as any });
  if (!check.ok) problems.push(`the kit validator refuses the reply: ${JSON.stringify(check.codes)}`);
  return problems;
}

/** A resolver built the way the server builds it: the ids the backend's evidence lookup answers. */
async function resolverFor(protocol: string, ndjson: string): Promise<ResolveEvidence> {
  const ids: string[] = [];
  for (const message of lines(ndjson)) {
    const results = message?.updateDataModel?.value?.results ?? {};
    for (const result of Object.values(results) as any[]) {
      for (const item of [...(result?.rows ?? []), ...(result?.edges ?? [])]) {
        for (const id of item?.evidenceIds ?? []) {
          if (typeof id === "string" || typeof id === "number") ids.push(String(id));
        }
      }
    }
  }
  const { missing } = await backend.evidence(protocol, ids);
  return receiptResolver(ids.filter((id) => !missing.includes(id)));
}

async function expectValidReply(ndjson: string, protocol: string): Promise<void> {
  const problems = replyProblems(ndjson, await resolverFor(protocol, ndjson));
  expect(problems, problems.join("; ")).toEqual([]);
}

const VALUE_COMPONENTS = new Set(["FactTable", "ControlChain", "ValuePath", "UnknownList", "Timeline"]);

/** The row keys a reply cites: fact, path and unknown rows of every result a value component binds. */
function citedFromReply(ndjson: string): { keys: string[]; rowsOf: Map<string, any[]>; model: any; components: any[] } {
  const [first, second, third] = lines(ndjson);
  expect(first.createSurface).toBeDefined();
  const model = second.updateDataModel.value;
  const components = third.updateComponents.components;
  const rowsOf = new Map<string, any[]>();
  const keys: string[] = [];
  for (const component of components) {
    if (!VALUE_COMPONENTS.has(component.component)) continue;
    const path = component?.result?.path;
    if (typeof path !== "string") continue;
    const match = /^\/results\/([^/]+)$/.exec(path);
    if (!match) continue;
    const result = model?.results?.[match[1]];
    if (!result || !Array.isArray(result.rows)) continue;
    rowsOf.set(match[1], result.rows);
    for (const row of result.rows) if (["fact", "path", "unknown"].includes(row.rowKind)) keys.push(row.key);
  }
  return { keys: uniq(keys).sort(), rowsOf, model, components };
}

/* ---------- expected keys: derived here from the committed bundles ---------- */

function flattenEnvRows(data: any, list: string): any[] {
  const value = String(list).split(".").reduce((at: any, key) => (at === null || at === undefined ? undefined : at[key]), data);
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function subjectFilter(rows: any[], sel: any): any[] {
  if (!sel.subject) return rows;
  const needle = String(sel.subject).toLowerCase();
  return rows.filter((row: any) => (sel.match as string[]).some((column) => String(row?.[column] ?? "").toLowerCase().includes(needle)));
}

function resolveSelector(source: BundleSource, sel: any): string[] {
  if (sel.source === "section") {
    const envelope = (source.bundle as BundleResponse)[sel.section as SectionId];
    const rows = subjectFilter(flattenEnvRows(envelope.data, sel.list).map((row: any) => ({ group: sel.list, ...row })), sel);
    return rows.map((row: any) => `${sel.section}:${sel.list}:${row[sel.idField]}`);
  }
  if (sel.source === "graph") {
    return uniq(source.graph.relationships.filter((rel) => (sel.edges as string[]).includes(rel.type)).map((rel) => rel.key));
  }
  if (sel.source === "graph-pairs") {
    const rels = source.graph.relationships;
    const out: string[] = [];
    for (const first of rels.filter((rel) => rel.type === sel.steps[0])) {
      for (const second of rels.filter((rel) => rel.source === first.target && rel.type === sel.steps[1])) {
        out.push(sha256(canonical([first.key, second.key])));
      }
    }
    return uniq(out);
  }
  if (sel.source === "unknowns") {
    const answer = (source.bundle as BundleResponse).answer.data;
    return uniq([
      ...(answer?.unknowns ?? []).map((row: any) => `answer:unknowns:${row.id}`),
      ...(answer?.statements ?? []).filter((row: any) => row.status === "unresolved").map((row: any) => `answer:statements:${row.id}`),
      ...((source.bundle as BundleResponse).claims.data?.rows ?? [])
        .filter((row: any) => row.status === "unresolved").map((row: any) => `claims:rows:${row.id}`),
    ]);
  }
  return [];
}

/** The bundle rows behind a section selector, for the value-level checks. */
function resolveSelectorRows(source: BundleSource, sel: any): any[] {
  if (sel.source !== "section") return [];
  const envelope = (source.bundle as BundleResponse)[sel.section as SectionId];
  const rows = flattenEnvRows(envelope.data, sel.list).map((row: any) => ({ group: sel.list, ...row }));
  return subjectFilter(rows, sel);
}

/* ---------- counting wrappers and constructed backends ---------- */

function counting(target: RetrievalBackend): { backend: RetrievalBackend; counts: { run: number; evidence: number; coverage: number; templates: number } } {
  const counts = { run: 0, evidence: 0, coverage: 0, templates: 0 };
  const wrapped: RetrievalBackend = {
    id: target.id,
    version: target.version,
    protocols: () => target.protocols(),
    coverage: (protocol) => { counts.coverage++; return target.coverage(protocol); },
    templates: (protocol) => { counts.templates++; return target.templates(protocol); },
    run: async (protocol, templateId, params, options) => { counts.run++; return target.run(protocol, templateId, params, options); },
    evidence: async (protocol, ids) => { counts.evidence++; return target.evidence(protocol, ids); },
  };
  return { backend: wrapped, counts };
}

const CONSTRUCTED_SNAPSHOT = "snapshot-of-a-constructed-case";

function constructedResult(caseName: string): { result: any; missing: string[] } {
  const rowBase = { factIds: [], snapshotIds: [CONSTRUCTED_SNAPSHOT], blockOrSlot: null, asOf: null };
  if (caseName === "row-without-evidence") {
    return {
      result: {
        shape: "table", columns: [{ name: "label", role: "label" }], coverage: "mapped", coverageNotes: [], truncated: false,
        rows: [{ ...rowBase, rowKind: "fact", key: "ck-uncited", values: { label: "A recorded label" }, bases: ["chain"], evidenceIds: [] }],
      },
      missing: [],
    };
  }
  if (caseName === "evidence-missing") {
    return {
      result: {
        shape: "table", columns: [{ name: "label", role: "label" }], coverage: "mapped", coverageNotes: [], truncated: false,
        rows: [{ ...rowBase, rowKind: "fact", key: "ck-unresolved", values: { label: "A recorded label" }, bases: ["chain"], evidenceIds: ["constructed-missing-id"] }],
      },
      missing: ["constructed-missing-id"],
    };
  }
  if (caseName === "not-mapped-unbound" || caseName === "not-mapped-drawn") {
    return {
      result: {
        shape: "table", columns: [{ name: "label", role: "label" }], coverage: "not-mapped",
        coverageNotes: ["A constructed note for what is not mapped."], truncated: false, rows: [],
      },
      missing: [],
    };
  }
  if (caseName === "graph-edge-uncited") {
    return {
      result: {
        shape: "graph", coverage: "mapped", coverageNotes: [], truncated: false,
        nodes: [{ id: "ga", label: "Left node", isolated: false }, { id: "gb", label: "Right node", isolated: false }],
        edges: [{ key: "gk", from: "ga", to: "gb", relation: "REL", factIds: [], bases: [], evidenceIds: [], blockOrSlot: 7, asOf: null }],
      },
      missing: [],
    };
  }
  throw new Error(`unknown constructed case ${caseName}`);
}

function constructedBackend(caseName: string): RetrievalBackend {
  const { result, missing } = constructedResult(caseName);
  const descriptor: TemplateDescriptor = {
    id: "probe", version: "1", title: "Probe", question: "The constructed probe.", mechanic: null, shape: "table",
    params: { type: "object", additionalProperties: false, required: [], properties: {} },
    columns: [], cannotTell: "It is a constructed case.",
  };
  return {
    id: "constructed", version: "1",
    protocols: () => [{ id: "probe", title: "Probe" }],
    coverage: (): RetrievalCoverage => ({ protocol: "probe", title: "Probe", snapshotIds: [CONSTRUCTED_SNAPSHOT], mechanics: [], subjects: [] }),
    templates: () => [descriptor],
    run: async () => ({ ...result, resultId: "r1" }) as unknown as RetrievalResult,
    evidence: async (_protocol, ids) => ({ items: [], missing: ids.filter((id) => missing.includes(id)) }),
  };
}

/* ---------- drawn-tree checks ---------- */

const flattenTree = (node: UiNode, out: UiNode[] = []): UiNode[] => { out.push(node); for (const child of node.children) flattenTree(child, out); return out; };
const hasClass = (node: UiNode, name: string): boolean => (node.attrs?.class ?? "").split(/\s+/).includes(name);
const descendants = (node: UiNode, pred: (candidate: UiNode) => boolean): UiNode[] => flattenTree(node).filter(pred);
const pairLabelMap: Record<string, string> = {
  [STRINGS.target]: "target", [STRINGS.instruction]: "instruction", [STRINGS.role]: "role", [STRINGS.authority]: "authority",
  [STRINGS.controller]: "controller", [STRINGS.threshold]: "threshold", [STRINGS.from]: "from", [STRINGS.to]: "to",
  [STRINGS.amount]: "amount", [STRINGS.unit]: "unit", [STRINGS.window]: "window", [STRINGS.time]: "time",
};
const PROVENANCE_LABELS = new Set<string>([STRINGS.basis, STRINGS.blockOrSlot, STRINGS.evidence, STRINGS.asOf]);

function checkDrawnRow(rowNode: UiNode, row: any, kind: "table" | "list", chain: boolean, columnNames: string[]): void {
  if (row.rowKind === "scope") {
    const scope = descendants(rowNode, (candidate) => hasClass(candidate, "lk-scope"));
    expect(scope.length, "a scope row shows its scope source").toBeGreaterThan(0);
    expect(scope.map((candidate) => candidate.text ?? "").join(" ")).toContain(row.scopeSource ?? "");
    return;
  }
  const bases = descendants(rowNode, (candidate) => hasClass(candidate, "lk-basis")).map((candidate) => candidate.text ?? "");
  expect(bases, `row ${row.key} draws every basis in order`).toEqual(row.bases);
  const obs = descendants(rowNode, (candidate) => hasClass(candidate, "lk-obs")).map((candidate) => candidate.text ?? "");
  const expectedObs = row.blockOrSlot !== null && row.blockOrSlot !== undefined
    ? [String(row.blockOrSlot)]
    : row.asOf ? [row.asOf] : [STRINGS.notRecorded];
  expect(obs, `row ${row.key} draws its block or slot, or its time, or the words that neither was recorded`).toEqual(expectedObs);
  const chipIds = descendants(rowNode, (candidate) => hasClass(candidate, "lk-evidence-id")).map((candidate) => candidate.text ?? "");
  if (row.evidenceIds.length === 0) {
    expect(descendants(rowNode, (candidate) => hasClass(candidate, "lk-no-evidence")).length, `row ${row.key} says when no evidence is recorded`).toBeGreaterThan(0);
  } else {
    expect(chipIds, `row ${row.key} draws its evidence ids`).toEqual(row.evidenceIds);
  }
  if (kind === "table") {
    for (const cell of descendants(rowNode, (candidate) => candidate.tag === "td" && typeof candidate.attrs?.["data-label"] === "string")) {
      const label = cell.attrs["data-label"];
      if (PROVENANCE_LABELS.has(label)) continue;
      const text = cell.children.map((kid) => kid.text ?? "").join("");
      expect(text, `table cell ${label} of row ${row.key}`).toEqual(valueText(row.values?.[label], STRINGS.notRecorded));
    }
  } else {
    for (const pair of descendants(rowNode, (candidate) => hasClass(candidate, "lk-pair"))) {
      const label = pair.children.find((kid) => hasClass(kid, "lk-pair-label"))?.text ?? "";
      const value = pair.children.find((kid) => hasClass(kid, "lk-value"));
      const column = pairLabelMap[label] ?? (columnNames.includes(label) ? label : undefined);
      if (column === undefined) continue;
      const gapWord = chain ? STRINGS.notMapped : STRINGS.notRecorded;
      expect(value?.text ?? "", `pair ${label} of row ${row.key}`).toEqual(valueText(row.values?.[column], gapWord));
    }
  }
}

/** Walks the drawn tree against the reply's bound rows, in component order. */
function checkDrawnTree(tree: SurfaceTree, components: any[], rowsOf: Map<string, any[]>): void {
  expect(tree.errors, JSON.stringify(tree.errors)).toEqual([]);
  const drawnRows = flattenTree(tree.root).filter((candidate) => hasClass(candidate, "lk-row"));
  let at = 0;
  for (const component of components) {
    if (!VALUE_COMPONENTS.has(component.component)) continue;
    const path = component?.result?.path;
    const match = typeof path === "string" ? /^\/results\/([^/]+)$/.exec(path) : null;
    if (!match) continue;
    const rows = rowsOf.get(match[1]) ?? [];
    const kind = component.component === "FactTable" ? "table" : "list";
    const chain = component.component === "ControlChain";
    const columnNames = Array.isArray(component.columns) ? component.columns as string[] : Object.keys(rows[0]?.values ?? {});
    for (const row of rows) {
      const rowNode = drawnRows[at++];
      expect(rowNode, `a drawn row exists for ${row.key}`).toBeDefined();
      if (rowNode) checkDrawnRow(rowNode, row, kind as "table" | "list", chain, columnNames);
    }
  }
  expect(at, "every drawn row belongs to a bound result row").toBe(drawnRows.length);
}

/* ---------- scripted-turn helpers ---------- */

const HEADER_AND = (valueId: string): any[] => [
  { id: "root", component: "Column", children: ["hd", valueId] },
  { id: "hd", component: "AnswerHeader", meta: { path: "/meta" } },
];

const SIMPLE_ANSWER = (valueId: string, component: any): any => ({
  components: [...HEADER_AND(valueId), component],
});

function scriptWith(tool: any | null, ...answers: any[]): Script {
  const turns: any[] = [];
  if (tool) turns.push({ tools: [tool] });
  for (const answer of answers) turns.push({ answer });
  return { turns };
}

const repairIn = (requests: ModelRequest[]): any =>
  requests.map((request) => request.messages[request.messages.length - 1] as any)
    .find((last) => last?.role === "user" && last?.kind === "repair") ?? null;

/* ---------- AC1: lane and isolation ---------- */

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g;

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((match) => match[1]);
}

function resolvesInto(fromFile: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const resolved = resolve(dirname(fromFile), specifier);
  return resolved === target || resolved.startsWith(`${target}/`);
}

describe("AC1 lane and isolation", () => {
  test("no src/answers file imports src/web, src/apps or src/agent", () => {
    const answersDir = join(ROOT, "src", "answers");
    const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: answersDir })].map((relative) => join(answersDir, relative));
    expect(files.length, "the answers module has files to scan").toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        for (const banned of ["web", "apps", "agent"]) {
          if (resolvesInto(file, spec, join(ROOT, "src", banned))) violations.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(violations, violations.join("; ")).toEqual([]);
  }, 30000);

  test("only the approved Solana launcher mount imports answers outside its module", () => {
    const answersDir = join(ROOT, "src", "answers");
    const violations: string[] = [];
    for (const pattern of ["src/**/*.ts", "scripts/**/*.ts"]) {
      for (const file of [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })]) {
        const full = join(ROOT, file);
        if (full.startsWith(`${answersDir}/`)) continue;
        for (const spec of importSpecifiers(readFileSync(full, "utf8"))) {
          // Solana later slice 1, authorized after both runs merged (S123).
          if (file === "src/apps/solana/main.ts" && spec === "../../answers/handler") continue;
          if (resolvesInto(full, spec, answersDir)) violations.push(`${file} imports ${spec}`);
        }
      }
    }
    expect(violations, violations.join("; ")).toEqual([]);
  }, 30000);

  test("the scanner reports a banned import when given one", () => {
    const synthetic = join(ROOT, "src", "answers", "synthetic-check.ts");
    const text = `import x from "../web/server";\nexport const y = x;\n`;
    expect(importSpecifiers(text).some((spec) => resolvesInto(synthetic, spec, join(ROOT, "src", "web")))).toBe(true);
  });
});

/* ---------- AC2: wire format through the kit ---------- */

describe("AC2 wire format through the kit", () => {
  test("every pinned golden reply is three kit messages in order and passes the kit validator", async () => {
    for (const entry of GOLDEN_FIXTURE.questions) {
      const outcome = await answerQuestion({
        question: entry.question, protocol: entry.protocol, backend,
        model: goldenModel({ question: entry.question, protocol: entry.protocol })!,
      });
      await expectValidReply(outcome.ndjson, entry.protocol);
    }
  }, 120000);

  test("the reply checker refuses a reply with a line removed or a changed catalog id", async () => {
    const question = "What fees does the vault charge?";
    const outcome = await answerQuestion({
      question, protocol: "kamino", backend, model: goldenModel({ question, protocol: "kamino" })!,
    });
    const rawLines = outcome.ndjson.split("\n").filter((line) => line !== "");
    expect(replyProblems(rawLines.slice(0, 2).join("\n"), receiptResolver([])).length).toBeGreaterThan(0);
    const mutated = rawLines.map((line) => line.replace('"linchpin.evidence.v1"', '"another.catalog"'));
    expect(replyProblems(mutated.join("\n"), receiptResolver([])).length).toBeGreaterThan(0);
  }, 30000);
});

/* ---------- AC3: retrieval and coverage as v1 ---------- */

const SECTION_MECHANIC: Record<string, string> = {
  path: "fees", control: "control", offsets: "flows", parameters: "parameters", programs: "code-upgrade",
  participation: "governance", holders: "holders", flows: "flows", claims: "claims",
};
const KAMINO_PENDING: SectionId[] = ["path", "offsets", "participation", "holders", "flows"];

describe("AC3 retrieval and coverage as v1", () => {
  test("the template list per protocol: one section template per served section, unknowns, one graph template per registry query id", () => {
    for (const source of sources) {
      const entry = TOKENOMICS_REGISTRY.find((candidate) => candidate.id === source.id)!;
      const expected = new Set<string>(["unknowns"]);
      for (const section of Object.keys(source.bundle)) {
        if (section === "answer" || section === "graph") continue;
        expected.add(`section-${section}`);
      }
      for (const id of entry.queryIds) expected.add(id);
      const listed = backend.templates(source.id).map((descriptor) => descriptor.id);
      expect(new Set(listed), `template ids of ${source.id}`).toEqual(expected);
      expect(new Set(listed).size, `template ids of ${source.id} are unique`).toBe(listed.length);
      for (const id of listed) expect(id).toMatch(/^[a-z][a-z0-9-]{0,47}$/);
      for (const descriptor of backend.templates(source.id)) {
        expect(descriptor.params.additionalProperties).toBe(false);
        for (const name of Object.keys(descriptor.params.properties)) {
          expect(["cypher", "query", "label", "property", "where"], `param name ${name} is outside the read-only gate`).not.toContain(name);
        }
      }
    }
  }, 30000);

  test("every fact, path and unknown row cites evidence that resolves and carries bases; the bundle slot appears as blockOrSlot", async () => {
    for (const source of sources) {
      for (const descriptor of backend.templates(source.id)) {
        const result = await backend.run(source.id, descriptor.id, {}, { maxRows: 500 });
        for (const row of result.rows) {
          if (row.rowKind === "coverage") continue;
          expect(row.bases.length, `row ${row.key} has bases`).toBeGreaterThan(0);
          expect(row.evidenceIds.length, `row ${row.key} has evidence ids`).toBeGreaterThan(0);
        }
        const ids = uniq(result.rows.flatMap((row) => row.evidenceIds));
        const { missing } = await backend.evidence(source.id, ids);
        expect(missing, `evidence of ${descriptor.id} resolves`).toEqual([]);
      }
      // Rows come in the bundle's list order, so a one-list section zips against its bundle rows.
      const zipSections: [SectionId, string][] = [
        ["control", "rows"], ["claims", "rows"], ["offsets", "rows"], ["parameters", "rows"], ["programs", "rows"], ["path", "links"],
      ];
      for (const [section, list] of zipSections) {
        const envelope = (source.bundle as BundleResponse)[section];
        if (envelope.status !== "ready" || !envelope.data) continue;
        const bundleRows = flattenEnvRows(envelope.data, list);
        const result = await backend.run(source.id, `section-${section}`, {}, { maxRows: 500 });
        expect(result.rows.length, `${source.id} ${section} returns every row of the list`).toBe(bundleRows.length);
        result.rows.forEach((row, at) => {
          expect(row.blockOrSlot, `${source.id} ${section} row ${at}: the bundle slot appears as blockOrSlot`).toEqual(bundleRows[at].slot);
          expect(row.bases, `${source.id} ${section} row ${at}: the recorded basis`).toEqual(Array.isArray(bundleRows[at].basis) ? bundleRows[at].basis : [bundleRows[at].basis]);
        });
      }
      const allRows = (await Promise.all(backend.templates(source.id).map((descriptor) => backend.run(source.id, descriptor.id, {}, { maxRows: 500 }))))
        .flatMap((result) => result.rows);
      expect(allRows.some((row) => row.rowKind === "scope"), "no bundle-local row is a scope row").toBe(false);
    }
  }, 120000);

  test("graph template rows equal the local query runner rows, in order", async () => {
    for (const source of sources) {
      const entry = TOKENOMICS_REGISTRY.find((candidate) => candidate.id === source.id)!;
      const queries = tokenomicsQueries(entry.namespace, entry.queryIds);
      for (const id of entry.queryIds) {
        const result = await backend.run(source.id, id, {}, { maxRows: 500 });
        const local = runTokenomicsLocal(source.graph, id, queries);
        expect(result.rows.map((row) => row.values), `graph rows of ${id} on ${source.id}`).toEqual(local.rows);
      }
    }
  }, 60000);

  test("a row over an inferred relationship carries inferred at that relationship's position", async () => {
    const source = sourceOf("marinade");
    const setByEdges = source.graph.relationships.filter((rel) => rel.type === "SET_BY");
    expect(setByEdges.length, "the marinade graph holds SET_BY relationships").toBeGreaterThan(0);
    const parameters = await backend.run("marinade", "section-parameters", {}, { maxRows: 500 });
    const bundleRows = (source.bundle as BundleResponse).parameters.data!.rows;
    expect(parameters.rows.length).toBe(bundleRows.length);
    parameters.rows.forEach((row, at) => {
      const bundleRow = bundleRows[at];
      for (const basis of Array.isArray(bundleRow.basis) ? bundleRow.basis : [bundleRow.basis]) {
        expect(row.bases, `parameter row ${bundleRow.id} keeps its own basis`).toContain(basis);
      }
      if ((bundleRow.setBy ?? []).length > 0) expect(row.bases, `parameter row ${bundleRow.id} carries the inferred set-by step`).toContain("inferred");
    });
    if (setByEdges.some((rel) => String((rel.props.basis as any) ?? "") === "inferred" || (Array.isArray(rel.props.basis) && rel.props.basis[0] === "inferred"))) {
      const graph = await backend.run("marinade", "parameter-control", {}, { maxRows: 500 });
      expect(graph.rows.filter((row) => row.bases[0] === "inferred").length, "rows whose first traversed relationship is inferred keep it first").toBeGreaterThan(0);
    }
  }, 60000);

  test("a pending section returns not-mapped, one coverage row and the envelope notes verbatim", async () => {
    const source = sourceOf("kamino");
    for (const section of KAMINO_PENDING) {
      const envelope = (source.bundle as BundleResponse)[section];
      expect(envelope.status, `kamino ${section} is pending in the recorded bundle`).toBe("pending");
      const result = await backend.run("kamino", `section-${section}`, {}, { maxRows: 500 });
      expect(result.coverage).toBe("not-mapped");
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].rowKind).toBe("coverage");
      expect(result.rows[0].key).toBe(`${section}:coverage`);
      expect(result.coverageNotes, `the ${section} notes verbatim`).toEqual(envelope.notes);
    }
  }, 30000);

  test("a ready section whose subject matches nothing returns mapped with zero rows; templatesSha256 is stable and reacts to change", async () => {
    const noMatch = await backend.run("kamino", "section-control", { subject: "zzz-no-such-row" }, { maxRows: 50 });
    expect(noMatch.coverage).toBe("mapped");
    expect(noMatch.rows).toEqual([]);
    const descriptors: Record<string, TemplateDescriptor[]> = {};
    for (const source of sources) descriptors[source.id] = backend.templates(source.id);
    const first = templatesSha256(descriptors);
    expect(first).toEqual(templatesSha256(descriptors));
    const changed = JSON.parse(JSON.stringify(descriptors));
    changed.marinade[0] = { ...changed.marinade[0], version: "changed" };
    expect(templatesSha256(changed)).not.toEqual(first);
    const secondBackend = new BundleBackend(sources);
    const rerun = await secondBackend.run("marinade", "section-claims", {}, { maxRows: 50 });
    expect(rerun.backend.templatesSha256).toEqual(first);
  }, 30000);

  test("two runs with the same input are equal by canonical JSON", async () => {
    const first = await backend.run("marinade", "section-control", { subject: "rewardFee" }, { maxRows: 50 });
    const second = await backend.run("marinade", "section-control", { subject: "rewardFee" }, { maxRows: 50 });
    expect(canonical(second)).toEqual(canonical(first));
  }, 30000);

  test("errors: as-of, unknown template, unknown protocol, and the read-only gate on params", async () => {
    const cases: [() => Promise<unknown>, string][] = [
      [() => backend.run("marinade", "section-control", {}, { maxRows: 50, asOf: "2026-11-12T00:00:00Z" }), "as-of-unsupported"],
      [() => backend.run("marinade", "no-such-template", {}, { maxRows: 50 }), "unknown-template"],
      [() => backend.run("aave", "section-control", {}, { maxRows: 50 }), "invalid-params"],
      [() => backend.run("marinade", "section-control", { subject: "x", extra: 1 }, { maxRows: 50 }), "invalid-params"],
      [() => backend.run("marinade", "section-control", { cypher: "MATCH (n) RETURN n" }, { maxRows: 50 }), "invalid-params"],
      [() => backend.run("marinade", "section-control", { subject: 5 as unknown as string }, { maxRows: 50 }), "invalid-params"],
      [() => backend.run("marinade", "section-control", { subject: "s".repeat(121) }, { maxRows: 50 }), "invalid-params"],
    ];
    for (const [attempt, code] of cases) {
      let caught: unknown = null;
      try { await attempt(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(RetrievalError);
      expect(String((caught as RetrievalError).code)).toBe(code);
    }
  }, 30000);

  test("coverage lists every mechanic once plus documentation, with the recorded notes verbatim", () => {
    for (const source of sources) {
      const coverage = backend.coverage(source.id);
      expect(coverage.mechanics.map((entry) => entry.mechanic)).toEqual([...MECHANICS, "documentation"]);
      expect(coverage.subjects).toEqual([]);
      expect(coverage.snapshotIds).toEqual([snapshotId(source.bundle)]);
      const documentation = coverage.mechanics[coverage.mechanics.length - 1];
      expect(documentation.status).toBe("not-mapped");
      expect(documentation.note).toBe("Documentation is not indexed in this capture");
      const numbers: number[] = [];
      JSON.stringify(coverage, (_key, value) => { if (typeof value === "number") numbers.push(value); return value; });
      expect(numbers, "no coverage field introduces a number").toEqual([]);
    }
    const kamino = backend.coverage("kamino");
    const byMechanic = new Map<string, any>(kamino.mechanics.map((entry) => [entry.mechanic, entry]));
    for (const mechanic of ["control", "code-upgrade", "parameters", "claims", "dependencies"]) {
      expect(byMechanic.get(mechanic)!.status, `kamino ${mechanic} is mapped`).toBe("mapped");
    }
    const pendingExpect: [string, SectionId[]][] = [
      ["fees", ["path"]], ["flows", ["offsets", "flows"]], ["governance", ["participation"]], ["holders", ["holders"]],
    ];
    for (const [mechanic, sections] of pendingExpect) {
      const entry = byMechanic.get(mechanic)!;
      expect(entry.status, `kamino ${mechanic} is not mapped`).toBe("not-mapped");
      for (const section of sections) {
        const envelope = (sourceOf("kamino").bundle as BundleResponse)[section];
        expect(entry.note, `the ${section} note appears verbatim under ${mechanic}`).toContain(envelope.notes.join(" "));
      }
    }
    const marinade = backend.coverage("marinade");
    const marinadeByMechanic = new Map<string, any>(marinade.mechanics.map((entry) => [entry.mechanic, entry]));
    for (const [section, mechanic] of Object.entries(SECTION_MECHANIC)) {
      expect(marinadeByMechanic.get(mechanic)!.status, `marinade ${mechanic} is mapped from ${section}`).toBe("mapped");
    }
  }, 30000);

  test("every row-shaped result, with its four retrieval fields removed, is a kit result that instantiate accepts", async () => {
    for (const [protocol, templateId] of [["kamino", "section-claims"], ["marinade", "section-control"], ["marinade", "section-flows"]] as const) {
      const result = await backend.run(protocol, templateId, {}, { maxRows: 50 });
      const kitResult = JSON.parse(JSON.stringify(result));
      delete kitResult.protocol; delete kitResult.backend; delete kitResult.templateId; delete kitResult.templateVersion;
      expect(() => instantiate("fact-table", {
        surfaceId: "probe", meta: { snapshotIds: [CONSTRUCTED_SNAPSHOT] }, results: [kitResult],
      }), `${templateId} of ${protocol} as a kit result`).not.toThrow();
    }
  }, 30000);
});

/* ---------- AC4: the data model is written by the server only ---------- */

const TOOL_CONTROL_M1 = { name: "run_template", input: { protocol: "marinade", templateId: "section-control", params: { subject: "rewardFee" } } };
const CHAIN_ANSWER = SIMPLE_ANSWER("v1", { id: "v1", component: "ControlChain", result: { path: "/results/r1" } });
const TABLE_ANSWER = SIMPLE_ANSWER("v1", { id: "v1", component: "FactTable", result: { path: "/results/r1" } });

describe("AC4 data model written by the server only", () => {
  const secondLine = (ndjson: string): string => ndjson.split("\n").filter((line) => line !== "")[1];

  test("component-list and view answers over the same tool calls share one byte-identical updateDataModel line", async () => {
    const question = "Who controls the reward fee?";
    const withComponents = await answerQuestion({
      question, protocol: "marinade", backend, model: new ScriptedModel(scriptWith(TOOL_CONTROL_M1, CHAIN_ANSWER)),
    });
    const withView = await answerQuestion({
      question, protocol: "marinade", backend, model: new ScriptedModel(scriptWith(TOOL_CONTROL_M1, { view: "control-chain", results: ["r1"] })),
    });
    const withOtherComponents = await answerQuestion({
      question, protocol: "marinade", backend, model: new ScriptedModel(scriptWith(TOOL_CONTROL_M1, TABLE_ANSWER)),
    });
    expect(secondLine(withComponents.ndjson)).toEqual(secondLine(withView.ndjson));
    expect(secondLine(withComponents.ndjson)).toEqual(secondLine(withOtherComponents.ndjson));
  }, 60000);

  test("results.<id> is the retrieval result the tool returned, byte-equal by canonical JSON; the key set is meta, results, coverage", async () => {
    const outcome = await answerQuestion({
      question: "Who controls the reward fee?", protocol: "marinade", backend,
      model: new ScriptedModel(scriptWith(TOOL_CONTROL_M1, CHAIN_ANSWER)),
    });
    const model = lines(outcome.ndjson)[1].updateDataModel.value;
    expect(Object.keys(model).sort()).toEqual(["coverage", "meta", "results"]);
    const fresh = structuredClone(await backend.run("marinade", "section-control", { subject: "rewardFee" }, { maxRows: 50 })) as any;
    fresh.resultId = "r1";
    expect(canonical(model.results.r1)).toEqual(canonical(fresh));
    expect(Object.keys(model.meta).sort()).toEqual(["protocolTitle", "question", "snapshotIds"]);
    expect(model.meta.question).toBe("Who controls the reward fee?");
  }, 30000);

  test("meta.question is the question trimmed with whitespace runs collapsed", async () => {
    const handler = createAnswersHandler({ backend, model: goldenModel as any });
    const response = await handler(new Request("http://127.0.0.1/api/answers/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "  Who   controls\n\tthe reward   fee?  ", protocol: "marinade" }),
    }));
    expect(response.status).toBe(200);
    const model = lines(await response.text())[1].updateDataModel.value;
    expect(model.meta.question).toBe("Who controls the reward fee?");
  }, 30000);
});

/* ---------- AC5: validator gate, one repair, refusal ---------- */

describe("AC5 validator gate, one repair, refusal", () => {
  for (const recipe of ADVERSARIAL.recipes) {
    const run = async (): Promise<void> => {
      const target = recipe.backend ? constructedBackend(recipe.backend) : backend;
      const protocol = recipe.backend ? "probe" : (recipe.tool.input.protocol as string);
      const tool = recipe.backend ? { name: "run_template", input: { protocol: "probe", templateId: "probe", params: {} } } : recipe.tool;
      const bad = JSON.parse(JSON.stringify(recipe.bad));
      if (recipe.code === "text-too-long") {
        for (const component of bad.components) if (component.component === "Note") component.text = "p".repeat(281);
      }
      const model = new ScriptedModel(scriptWith(tool, bad, recipe.good));
      const outcome = await answerQuestion({ question: recipe.rule, protocol, backend: target, model });
      expect(outcome.kind, `${recipe.rule}: the repaired surface is answered`).toBe("repaired");
      const repair = repairIn(model.requests);
      expect(repair, `${recipe.rule}: a request carries the repair message`).not.toBeNull();
      expect(repair.codes).toEqual([recipe.code]);
      expect(Object.keys(repair).sort()).toEqual(["codes", "kind", "role"]);
      const replyComponents = JSON.parse(JSON.stringify((outcome.messages[2] as any).updateComponents.components));
      expect(canonical(replyComponents), `${recipe.rule}: the reply is the repaired surface`).toEqual(canonical(recipe.good.components));
      for (const line of outcome.ndjson.split("\n")) {
        expect(line, `${recipe.rule}: no rejected marker reaches the reply`).not.toContain(recipe.markerId);
        expect(line).not.toContain(recipe.markerText);
      }
    };
    test(`${recipe.rule} ${recipe.code}: refused once, repaired once`, run, 30000);
  }

  test("breaking the same rule twice yields the fixed refusal surface", async () => {
    const refusal = ADVERSARIAL.refusalCase;
    const model = new ScriptedModel(scriptWith(refusal.tool, refusal.badA, refusal.badB));
    const outcome = await answerQuestion({ question: "Twice refused", protocol: "kamino", backend, model });
    expect(outcome.kind).toBe("refusal");
    expect(outcome.codes).toEqual([refusal.code]);
    await expectValidReply(outcome.ndjson, "kamino");
    const modelValue = lines(outcome.ndjson)[1].updateDataModel.value;
    expect(modelValue.results.refusal.coverageNotes[0]).toBe(REFUSAL_TEXT);
    expect(modelValue.results.refusal.coverageNotes[1]).toBe(`${RULE_CODES_PREFIX}${refusal.code}`);
    for (const marker of refusal.markers) expect(outcome.ndjson, `the refusal holds no marker (${marker})`).not.toContain(marker);
    expect(outcome.ndjson).not.toContain("/results/r1");
    const tree = interpret(outcome.messages);
    expect(tree.errors).toEqual([]);
    expect(flattenTree(tree.root).some((candidate) => (candidate.text ?? "").includes(REFUSAL_TEXT))).toBe(true);
  }, 30000);
});

/* ---------- AC6: view templates as answers ---------- */

describe("AC6 view templates as answers", () => {
  test("a view answer equals instantiate over the same result, byte for byte", async () => {
    const question = "Who controls the reward fee?";
    const outcome = await answerQuestion({
      question, protocol: "marinade", backend,
      model: new ScriptedModel(scriptWith(TOOL_CONTROL_M1, { view: "control-chain", results: ["r1"] })),
    });
    const scope = protocolScope(backend, "marinade");
    const fresh = structuredClone(await backend.run("marinade", "section-control", { subject: "rewardFee" }, { maxRows: 50 })) as any;
    fresh.resultId = "r1";
    const expected = instantiate("control-chain", {
      surfaceId: SURFACE_ID, meta: answerMeta(question, scope.title, scope.snapshotIds),
      results: [fresh], coverage: { mechanics: [], asked: [] },
    });
    const actual = outcome.ndjson.split("\n").filter((line) => line !== "");
    expect(actual, "the reply equals instantiate, byte for byte").toEqual(expected.map((message) => JSON.stringify(message)));
  }, 30000);

  test("list_views output equals the kit's view templates", async () => {
    const answer = { components: [{ id: "root", component: "Column", children: ["hd"] }, { id: "hd", component: "AnswerHeader", meta: { path: "/meta" } }] };
    const model = new ScriptedModel(scriptWith({ name: "list_views", input: {} }, answer));
    const outcome = await answerQuestion({ question: "Which views exist?", protocol: "kamino", backend, model });
    expect(outcome.kind, `${outcome.codes.join(",")}`).toBe("answer");
    const toolResults = model.requests[1].messages.filter((message: any) => message.role === "tool").flatMap((message: any) => message.results);
    expect(toolResults.filter((result: any) => result.name === "list_views").map((result: any) => result.output)).toEqual([listViewTemplates()]);
  }, 30000);

  for (const [bad, expectedCode] of [
    [{ view: "protocol-overview", results: ["r1"] }, "unknown-template"],
    [{ view: "answer-panel", results: ["r1"] }, "unknown-template"],
    [{ view: "control-chain", results: ["r7"] }, "dangling-binding"],
  ] as const) {
    test(`a view answer naming ${JSON.stringify(bad.view)} with ${JSON.stringify(bad.results)} gets ${expectedCode} in a repair turn`, async () => {
      const good = SIMPLE_ANSWER("v1", { id: "v1", component: "FactTable", result: { path: "/results/r1" } });
      const model = new ScriptedModel(scriptWith(
        { name: "run_template", input: { protocol: "kamino", templateId: "section-claims", params: { subject: "buffer" } } },
        bad, good,
      ));
      const outcome = await answerQuestion({ question: `View case for ${expectedCode}`, protocol: "kamino", backend, model });
      expect(outcome.kind).toBe("repaired");
      expect(repairIn(model.requests)?.codes).toEqual([expectedCode]);
    }, 30000);
  }

  test("control-chain over a table result gets shape-not-accepted", async () => {
    const good = SIMPLE_ANSWER("v1", { id: "v1", component: "FactTable", result: { path: "/results/r1" } });
    const model = new ScriptedModel(scriptWith(
      { name: "run_template", input: { protocol: "kamino", templateId: "section-claims", params: { subject: "buffer" } } },
      { view: "control-chain", results: ["r1"] }, good,
    ));
    const outcome = await answerQuestion({ question: "Shape case", protocol: "kamino", backend, model });
    expect(outcome.kind).toBe("repaired");
    expect(repairIn(model.requests)?.codes).toEqual(["shape-not-accepted"]);
  }, 30000);
});

/* ---------- AC7: the golden set, drawn ---------- */

describe("AC7 golden set", () => {
  async function entryChecks(entry: any, boundRows: any[], source: BundleSource): Promise<void> {
    const checks = entry.checks ?? {};
    if (checks.instructionNull) expect(boundRows[0].values.instruction, "K1 draws the instruction as not mapped, from a null").toBeNull();
    if (checks.statusEquals) expect(boundRows[0].values.status).toBe(checks.statusEquals);
    if (checks.authorityNone) {
      expect(boundRows[0].values.authority).toBe("none");
      expect(boundRows[0].values.controllerType).toBe("none");
    }
    if (checks.provenanceOfSelected) {
      const selected = resolveSelectorRows(source, entry.expect.select);
      expect(selected.length).toBe(boundRows.length);
      boundRows.forEach((row, at) => {
        const bundleRow = selected[at];
        expect(row.bases, "the original bases").toEqual(Array.isArray(bundleRow.basis) ? bundleRow.basis : [bundleRow.basis]);
        expect(row.evidenceIds, "the original evidence ids").toEqual(bundleRow.evidenceIds);
        expect(row.blockOrSlot, "the original slot").toEqual(bundleRow.slot);
        expect(row.asOf, "the original as-of").toEqual(bundleRow.asOf);
      });
    }
    if (checks.monthAmounts) {
      const months = resolveSelectorRows(source, entry.expect.select);
      expect(months.length).toBe(boundRows.length);
      boundRows.forEach((row, at) => {
        expect(row.values.amount, "the month amount is the recorded display string").toBe(months[at].mndeBought.display);
        expect(row.values.time).toBe(months[at].month);
        expect(row.values.sent).toBe(months[at].mndeSent.display);
        expect(row.values.credited).toBe(months[at].mndeCreditedWithoutPayment?.display ?? null);
      });
    }
    if (checks.amountEquals) expect(boundRows[0].values.amount).toBe(checks.amountEquals);
    if (checks.claimedOnlyRow) {
      const row = boundRows.find((candidate) => candidate.key === `path:links:${checks.claimedOnlyRow}`);
      expect(row, "the claimed-only link is among the rows").toBeDefined();
      expect(row.values.status).toBe("claimed-only");
      expect(row.values.amount, "a claimed-only link carries no observed amount").toBeNull();
    }
  }

  const runOne = async (entry: any, model: PlannerModel) => {
    const outcome = await answerQuestion({ question: entry.question, protocol: entry.protocol, backend, model });
    await expectValidReply(outcome.ndjson, entry.protocol);
    expect(outcome.kind, `${entry.id} is answered without refusal`).toBe("answer");
    expect(outcome.codes, `${entry.id} repairs nothing`).toEqual([]);
    const ids = uniq(Object.values(lines(outcome.ndjson)[1].updateDataModel.value.results as Record<string, any>)
      .flatMap((result: any) => (result.rows ?? []).flatMap((row: any) => row.evidenceIds)));
    const { missing } = await backend.evidence(entry.protocol, ids);
    expect(missing, `${entry.id}: every evidence id resolves`).toEqual([]);
    return { outcome, tree: interpret(outcome.messages) };
  };

  for (const entry of GOLDEN_FIXTURE.questions) {
    test(`${entry.id} scripted by this file cites exactly the derived rows and draws them`, async () => {
      const { outcome, tree } = await runOne(entry, new ScriptedModel(entry.script));
      expect(tree.errors, `${entry.id} draws without kit errors`).toEqual([]);
      const source = sourceOf(entry.protocol);
      const cited = citedFromReply(outcome.ndjson);
      if (entry.expect.kind === "keys") {
        const expected = resolveSelector(source, entry.expect.select).sort();
        expect(expected.length, `${entry.id}: the derivation found the recorded rows`).toBe(entry.expect.rows);
        expect(cited.keys, `${entry.id}: the cited row keys equal the derived set`).toEqual(expected);
        const boundRows = [...cited.rowsOf.values()][0] ?? [];
        expect(boundRows.length, `${entry.id}: the bound result holds the expected rows`).toBe(entry.expect.rows);
        checkDrawnTree(tree, cited.components, cited.rowsOf);
        await entryChecks(entry, boundRows, source);
      } else {
        expect(cited.keys, `${entry.id} cites no row`).toEqual([]);
        expect(cited.components.filter((candidate: any) => VALUE_COMPONENTS.has(candidate.component)).map((candidate: any) => candidate.component), `${entry.id} binds no value component`).toEqual([]);
        if (entry.expect.coverageMechanicBound !== undefined) {
          const note = cited.components.find((candidate: any) => candidate.component === "CoverageNote");
          expect(note?.coverage?.path).toBe(`/coverage/mechanics/${entry.expect.coverageMechanicBound}`);
        }
        if (entry.expect.select?.source === "envelope") {
          const envelope = (source.bundle as BundleResponse)[entry.expect.select.section as SectionId];
          const result = Object.values(lines(outcome.ndjson)[1].updateDataModel.value.results as Record<string, any>)[0] as any;
          expect(result.coverage).toBe("not-mapped");
          expect(result.coverageNotes, `${entry.id} holds the envelope notes verbatim`).toEqual(envelope.notes);
        }
      }
    }, 60000);

    test(`${entry.id} pinned script cites the same rows and repairs nothing`, async () => {
      const pinned = goldenModel({ question: entry.question, protocol: entry.protocol });
      expect(pinned, `${entry.id} is a pinned reference question`).not.toBeNull();
      const pinnedModel = pinned as PlannerModel;
      const scripted = pinnedModel as ScriptedModel;
      const { outcome, tree } = await runOne(entry, pinnedModel);
      expect(tree.errors, `${entry.id} draws without kit errors`).toEqual([]);
      expect(scripted.requests.some((request) => repairIn([request]) !== null), `${entry.id} passes the gate without repair`).toBe(false);
      const source = sourceOf(entry.protocol);
      const cited = citedFromReply(outcome.ndjson);
      if (entry.expect.kind === "keys") {
        expect(cited.keys, `${entry.id}: the pinned script cites the derived set`).toEqual(resolveSelector(source, entry.expect.select).sort());
        checkDrawnTree(tree, cited.components, cited.rowsOf);
      } else {
        expect(cited.keys).toEqual([]);
        expect(cited.components.filter((candidate: any) => VALUE_COMPONENTS.has(candidate.component)).length).toBe(0);
      }
    }, 60000);
  }
});

/* ---------- AC8: tool loop limits ---------- */

describe("AC8 tool loop limits", () => {
  const answerTurn = { components: [{ id: "root", component: "Column", children: ["hd"] }, { id: "hd", component: "AnswerHeader", meta: { path: "/meta" } }] };
  const controlCall = { name: "run_template", input: { protocol: "kamino", templateId: "section-claims", params: {} } };
  const toolOutputsOf = (request: ModelRequest): any[] =>
    request.messages.filter((message: any) => message.role === "tool").flatMap((message: any) => message.results.map((result: any) => result.output));

  test("the seventh tool call is not executed; the model is told the budget is gone", async () => {
    const counted = counting(backend);
    const model = new ScriptedModel({ turns: [...Array.from({ length: 7 }, () => ({ tools: [controlCall] })), { answer: answerTurn }] });
    const outcome = await answerQuestion({ question: "Budget case", protocol: "kamino", backend: counted.backend, model });
    expect(outcome.kind).toBe("answer");
    expect(counted.counts.run).toBe(6);
    const outputs = toolOutputsOf(model.requests[model.requests.length - 1]);
    expect(outputs.filter((output: any) => output?.error === "tool-budget-exhausted").length).toBe(1);
    expect(outputs.at(-1)).toEqual({ error: "tool-budget-exhausted" });
  }, 30000);

  test("the ninth model call is not made; the reply is the refusal with the budget code", async () => {
    const model = new ScriptedModel({ turns: Array.from({ length: 9 }, () => ({ tools: [controlCall] })) });
    const outcome = await answerQuestion({ question: "Model budget case", protocol: "kamino", backend, model });
    expect(model.requests.length).toBe(8);
    expect(outcome.kind).toBe("refusal");
    expect(outcome.codes).toEqual(["model-budget-exhausted"]);
    await expectValidReply(outcome.ndjson, "kamino");
    expect(outcome.ndjson).toContain("model-budget-exhausted");
  }, 30000);

  test("an unknown tool name gets unknown-tool and counts against the budget", async () => {
    const counted = counting(backend);
    const model = new ScriptedModel({
      turns: [
        { tools: [{ name: "drop_table", input: {} }] },
        ...Array.from({ length: 6 }, () => ({ tools: [controlCall] })),
        { answer: answerTurn },
      ],
    });
    const outcome = await answerQuestion({ question: "Unknown tool case", protocol: "kamino", backend: counted.backend, model });
    expect(outcome.kind).toBe("answer");
    const outputs = toolOutputsOf(model.requests[model.requests.length - 1]);
    expect(outputs.at(0)).toEqual({ error: "unknown-tool" });
    expect(outputs.at(-1)).toEqual({ error: "tool-budget-exhausted" });
    expect(counted.counts.run, "the failed call counted, so only five runs happened").toBe(5);
  }, 30000);

  test("a scripted model that never answers hits the deadline under a fake clock", async () => {
    let now = 0;
    const model = new ScriptedModel(
      { turns: Array.from({ length: 4 }, () => ({ tools: [controlCall] })) },
      { beforeTurn: () => { now += 25000; } },
    );
    const outcome = await answerQuestion({ question: "Deadline case", protocol: "kamino", backend, model, clock: () => now });
    expect(outcome.kind).toBe("refusal");
    expect(outcome.codes).toEqual(["deadline"]);
  }, 30000);

  test("a client disconnect stops further model and tool calls", async () => {
    const counted = counting(backend);
    const controller = new AbortController();
    const model = new ScriptedModel(
      { turns: [{ tools: [controlCall] }, { tools: [controlCall] }, { answer: answerTurn }] },
      { beforeTurn: (index) => { if (index === 1) controller.abort(); } },
    );
    const outcome = await answerQuestion({ question: "Abort case", protocol: "kamino", backend: counted.backend, model, signal: controller.signal });
    expect(outcome.kind).toBe("aborted");
    expect(outcome.messages).toEqual([]);
    expect(counted.counts.run, "turn two's tools never ran").toBe(1);
    expect(model.requests.length, "no model call after the one the abort interrupted").toBe(2);
  }, 30000);

  test("a script within all limits is answered", async () => {
    const outcome = await answerQuestion({
      question: "Within limits", protocol: "kamino", backend,
      model: new ScriptedModel({ turns: [{ tools: [controlCall] }, { answer: answerTurn }] }),
    });
    expect(outcome.kind).toBe("answer");
  }, 30000);
});

/* ---------- AC9: handler, requests, privacy ---------- */

const servers: { stop(): void }[] = [];
const CANARY_KEYS = [
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "NEO4J_PASSWORD", "NEO4J_URI",
  "LINCHPIN_RPC_URL", "LINCHPIN_NEAR_RPC_URL", "LINCHPIN_ONECLICK_API_KEY", "TYPESAFE_API_KEY",
] as const;

async function servedHandler(options: Parameters<typeof createAnswersHandler>[0]): Promise<string> {
  const handler = createAnswersHandler(options);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) });
  const origin = `http://127.0.0.1:${server.port}`;
  allowedOrigins.add(origin);
  servers.push({ stop: () => { allowedOrigins.delete(origin); server.stop(true); } });
  return origin;
}

const askViaHttp = async (origin: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  realFetch(`${origin}/api/answers/ask`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });

const askDirect = async (handler: (request: Request) => Promise<Response>, body: unknown): Promise<Response> =>
  handler(new Request("http://127.0.0.1/api/answers/ask", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

describe("AC9 handler, requests, privacy", () => {
  let origin = "";

  beforeAll(async () => {
    origin = await servedHandler({ backend, model: goldenModel as any });
  }, 60000);

  afterAll(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  test("a cross-origin Origin gets 403", async () => {
    const response = await askViaHttp(origin, { question: "What fees does the vault charge?", protocol: "kamino" }, { Origin: "http://example.test" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross-origin" });
  }, 30000);

  test("an over-limit body, an empty or 601-character question, an unlisted protocol and a bad previous get 400", async () => {
    for (const body of [
      { question: "q".repeat(4090), protocol: "kamino" },
      { question: "", protocol: "kamino" },
      { question: "w".repeat(601), protocol: "kamino" },
      { question: "What fees?", protocol: "aave" },
      { question: "What fees?", protocol: "kamino", previous: "not-hex" },
      { question: "What fees?", protocol: "kamino", previous: "A".repeat(64) },
      { question: "What fees?", protocol: "kamino", extra: 1 },
    ]) {
      const response = await askViaHttp(origin, body);
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await response.json() as any).error).toBe("bad-request");
    }
  }, 30000);

  test("a second ask while one runs gets 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const slowModel: PlannerModel = {
      id: "slow",
      next: async () => {
        await gate;
        return {
          turn: { kind: "answer", answer: { components: [{ id: "root", component: "Column", children: ["hd"] }, { id: "hd", component: "AnswerHeader", meta: { path: "/meta" } }] } },
          usage: { inputTokens: null, outputTokens: null },
        };
      },
    };
    const busyOrigin = await servedHandler({ backend, model: () => slowModel });
    const first = askViaHttp(busyOrigin, { question: "First ask", protocol: "kamino" });
    await new Promise((wait) => setTimeout(wait, 150));
    const second = await askViaHttp(busyOrigin, { question: "Second ask", protocol: "kamino" });
    expect(second.status).toBe(409);
    expect(await (second.json() as any)).toEqual({ error: "busy" });
    release();
    expect((await first).status).toBe(200);
  }, 30000);

  test("every other path and method pair gets 404", async () => {
    for (const [method, path] of [["GET", "/api/answers/other"], ["GET", "/api/answers/ask"], ["POST", "/api/answers/pinned"], ["DELETE", "/api/answers/ask"]] as const) {
      const response = await realFetch(`${origin}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await (response.json() as any)).toEqual({ error: "not-found" });
    }
  }, 30000);

  test("an unknown address and a quantity next to a mint label get 422 before any tool or model call", async () => {
    const counted = counting(backend);
    let modelCalls = 0;
    const spyModel: PlannerModel = { id: "spy", next: async () => { modelCalls++; throw new Error("the model must not be called"); } };
    const privateOrigin = await servedHandler({ backend: counted.backend, model: () => spyModel });
    for (const question of [`What does ${"k".repeat(44)} hold?`, "What did 1250.5 mSOL do?", "1250.5 MNDE moved"]) {
      const response = await askViaHttp(privateOrigin, { question, protocol: "kamino" });
      expect(response.status, question).toBe(422);
      expect(await (response.json() as any)).toEqual({ error: "private-content" });
    }
    expect(counted.counts.run).toBe(0);
    expect(counted.counts.evidence).toBe(0);
    expect(modelCalls).toBe(0);
  }, 30000);

  test("an address the recorded evidence already holds, and a number without a mint label, are not refused", async () => {
    const vaultAddress = "A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
    for (const question of [`What is stored at ${vaultAddress}?`, "Did 1250.5 units move?"]) {
      const response = await askViaHttp(origin, { question, protocol: "kamino" });
      expect(response.status, question).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    }
  }, 30000);

  test("the canary variables appear in no reply, model request, trace line or console output", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "aa2-canary-"));
    const tracePath = join(traceDir, "trace.jsonl");
    const used: ScriptedModel[] = [];
    const capturing = (ask: any) => { const model = goldenModel(ask) as ScriptedModel; used.push(model); return model; };
    const canaryOrigin = await servedHandler({ backend, model: capturing as any, logPath: tracePath });
    const saved: Record<string, string | undefined> = {};
    const values = CANARY_KEYS.map((_key, at) => `canary-value-${at}-x`);
    CANARY_KEYS.forEach((key, at) => { saved[key] = process.env[key]; process.env[key] = values[at]; });
    const consoleLines: string[] = [];
    const spies = (["log", "info", "error", "warn"] as const).map((name) =>
      spyOn(console as any, name).mockImplementation((...args: any[]) => { consoleLines.push(args.map(String).join(" ")); }));
    const leak = (text: string): string | null => values.find((value) => text.includes(value)) ?? null;
    try {
      const response = await askViaHttp(canaryOrigin, { question: "What fees does the vault charge?", protocol: "kamino" });
      expect(response.status).toBe(200);
      expect(leak(await response.text()), "no canary in the reply body").toBeNull();
      expect(leak([...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join("\n")), "no canary in the reply headers").toBeNull();
      // Inspect the model instances the handler actually used, and show that they were asked something.
      expect(used.reduce((sum, model) => sum + model.requests.length, 0), "the handler's model received a request").toBeGreaterThan(0);
      expect(leak(JSON.stringify(used.map((model) => model.requests))), "no canary in a model request").toBeNull();
      expect(existsSync(tracePath), "the trace was written").toBe(true);
      expect(leak(readFileSync(tracePath, "utf8")), "no canary in the trace").toBeNull();
      expect(leak(consoleLines.join("\n")), "no canary on the console").toBeNull();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      rmSync(traceDir, { recursive: true, force: true });
      CANARY_KEYS.forEach((key) => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      });
    }
  }, 30000);
});

/* ---------- AC10: pinned answers and no model ---------- */

describe("AC10 pinned answers and no model", () => {
  test("the pinned route returns one labelled entry per golden question, byte-equal to the scripted ask", async () => {
    const handler = createAnswersHandler({ backend, model: goldenModel as any });
    const pinnedResponse = await handler(new Request("http://127.0.0.1/api/answers/pinned"));
    expect(pinnedResponse.status).toBe(200);
    expect(pinnedResponse.headers.get("content-type")).toContain("application/json");
    const document = await (pinnedResponse.json() as any);
    expect(document.label).toBe(PINNED_LABEL);
    expect(document.answers.map((answer: any) => answer.id).sort()).toEqual(GOLDEN.map((entry) => entry.id).sort());
    expect(document.answers.length).toBe(18);
    for (const answer of document.answers) {
      expect(answer.label).toBe(PINNED_LABEL);
      expect(answer.ndjson.split("\n").filter((line: string) => line !== "").length).toBe(3);
      const askResponse = await askDirect(handler, { question: answer.question, protocol: answer.protocol });
      expect(await askResponse.text(), `${answer.id}: the pinned ndjson is the handler's own reply`).toBe(answer.ndjson);
    }
    expect(canonical(await pinnedAnswers(backend))).toEqual(canonical(document));
  }, 120000);

  test("with no model configured a typed question gets the fixed surface, the prepared list and no network attempt", async () => {
    const savedModel = process.env[MODEL_VARIABLE];
    delete process.env[MODEL_VARIABLE];
    try {
      const before = hits.fetch + hits.websocket + hits.connect + hits.net + hits.http;
      const handler = createAnswersHandler({ backend, model: () => null });
      const response = await askDirect(handler, { question: "What fees does the vault charge?", protocol: "kamino" });
      expect(response.status).toBe(200);
      const ndjson = await response.text();
      const model = lines(ndjson)[1].updateDataModel.value;
      expect(model.results.status.coverageNotes[0]).toBe(NO_MODEL_TEXT);
      expect(model.results.prepared.rows.length).toBe(18);
      expect(model.results.prepared.rows[0].rowKind).toBe("scope");
      expect(model.results.prepared.rows[0].scopeSource).toBe("prepared answers of this build");
      const components = lines(ndjson)[2].updateComponents.components;
      expect(components.some((candidate: any) => candidate.component === "Note" && candidate.text === PINNED_LABEL)).toBe(true);
      expect(components.some((candidate: any) => candidate.component === "FactTable" && candidate.title === "Prepared answers")).toBe(true);
      const check = validateSurface(lines(ndjson) as unknown as A2uiMessage[], { resolveEvidence: receiptResolver([]), coverage: model.coverage });
      expect(check.codes, JSON.stringify(check.findings)).toEqual([]);
      expect(hits.fetch + hits.websocket + hits.connect + hits.net + hits.http, "no network attempt").toBe(before);
      const tree = interpret(lines(ndjson) as unknown as A2uiMessage[]);
      expect(tree.errors).toEqual([]);
      expect(flattenTree(tree.root).some((candidate) => (candidate.text ?? "") === NO_MODEL_TEXT)).toBe(true);
      const withModel = createAnswersHandler({ backend, model: goldenModel as any });
      const modelResponse = await askDirect(withModel, { question: "What fees does the vault charge?", protocol: "kamino" });
      expect(await modelResponse.text()).not.toContain(NO_MODEL_TEXT);
    } finally {
      if (savedModel === undefined) delete process.env[MODEL_VARIABLE];
      else process.env[MODEL_VARIABLE] = savedModel;
    }
  }, 60000);
});

/* ---------- AC11: the stand-alone page ---------- */

const FORBIDDEN_IN_PAGE = ["@import", "url(", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("];
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

describe("AC11 stand-alone page", () => {
  test("parseServeArgs refuses a non-loopback host and a port outside 1 to 65535, and accepts a valid one", () => {
    expect((parseServeArgs(["--host", "0.0.0.0"]) as any).error).toBeDefined();
    expect((parseServeArgs(["--port", "0"]) as any).error).toBeDefined();
    expect((parseServeArgs(["--port", "65536"]) as any).error).toBeDefined();
    expect((parseServeArgs(["--port", "x"]) as any).error).toBeDefined();
    expect(parseServeArgs(["--port", "8793"])).toEqual({ host: "127.0.0.1", port: 8793 });
  }, 30000);

  test("the launcher exits 2 with one stderr line for a non-loopback host", () => {
    const ran = spawnSync("bun", ["run", "src/answers/serve.ts", "--host", "0.0.0.0"], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
    expect(ran.status).toBe(2);
    expect((ran.stderr ?? "").split("\n").filter((line) => line.trim() !== "").length).toBe(1);
  }, 60000);

  test("the served page and script hold no outside URL, no css import, no html sink", async () => {
    const { url, stop } = await startAnswersServer({ port: 0, handler: async () => new Response("{}", { status: 404 }) });
    allowedOrigins.add(url);
    try {
      const page = await (await realFetch(`${url}/`)).text();
      const script = await (await realFetch(`${url}/answers.js`)).text();
      expect(page).toContain("Prepared answers");
      for (const [label, text] of [["page", page], ["script", script]] as const) {
        const scanned = text.replaceAll(url, "").replaceAll(SVG_NAMESPACE, "");
        for (const banned of FORBIDDEN_IN_PAGE) expect(scanned.includes(banned), `${label} holds ${banned}`).toBe(false);
        expect(scanned.includes("http:"), `${label} holds no http URL`).toBe(false);
        expect(scanned.includes("https:"), `${label} holds no https URL`).toBe(false);
      }
      for (const file of ["src/answers/web/page.ts", "src/answers/web/client.ts"]) {
        const text = readFileSync(join(ROOT, file), "utf8").replaceAll(SVG_NAMESPACE, "");
        for (const banned of FORBIDDEN_IN_PAGE) expect(text.includes(banned), `${file} holds ${banned}`).toBe(false);
        expect(text.includes("http:"), `${file} holds no http URL`).toBe(false);
        expect(text.includes("https:"), `${file} holds no https URL`).toBe(false);
      }
      expect(readFileSync(join(ROOT, "src/answers/web/page.ts"), "utf8"), "the page carries the kit stylesheet").toContain("KIT_CSS");
    } finally {
      allowedOrigins.delete(url);
      stop();
    }
  }, 60000);

  test("a hostile bound value reaches the page as text and creates no element", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const result = {
      resultId: "r1", shape: "table" as const,
      columns: [{ name: "label", role: "label" as const }],
      coverage: "mapped" as const, coverageNotes: [], truncated: false,
      rows: [{
        rowKind: "fact" as const, key: "hk", values: { label: hostile }, factIds: [], bases: ["chain"],
        evidenceIds: ["ev-hostile"], blockOrSlot: 1, asOf: null, snapshotIds: ["snap"],
      }],
    };
    const messages: A2uiMessage[] = [
      createSurface(SURFACE_ID),
      updateDataModel(SURFACE_ID, "/", { meta: { snapshotIds: ["snap"] }, results: { r1: result } }),
      updateComponents(SURFACE_ID, [
        { id: "root", component: "Column", children: ["hd", "v1"] },
        { id: "hd", component: "AnswerHeader", meta: { path: "/meta" } },
        { id: "v1", component: "FactTable", result: { path: "/results/r1" } },
      ]),
    ];
    const tree = interpret(messages);
    expect(tree.errors).toEqual([]);
    const calls: string[] = [];
    const makeFakeElement = (tag: string): Record<string, unknown> => {
      const el: Record<string, unknown> = { tagName: tag.toUpperCase(), attrs: {} as Record<string, string>, childNodes: [] as unknown[] };
      Object.assign(el, {
        setAttribute(name: string, value: string) { calls.push(`setAttribute:${name}`); (el.attrs as Record<string, string>)[name] = value; },
        append(...kids: unknown[]) { calls.push("append"); (el.childNodes as unknown[]).push(...kids); },
        replaceChildren(...kids: unknown[]) { calls.push("replaceChildren"); (el.childNodes as unknown[]).push(...kids); },
      });
      Object.defineProperty(el, "innerHTML", { set() { calls.push("innerHTML"); }, get() { return ""; } });
      Object.defineProperty(el, "outerHTML", { set() { calls.push("outerHTML"); }, get() { return ""; } });
      Object.defineProperty(el, "textContent", {
        set(value: unknown) { calls.push("textContent"); el.storedText = value; },
        get() { return el.storedText ?? ""; },
      });
      return el;
    };
    const documentFake = {
      createElement(tag: string) { calls.push(`createElement:${tag}`); return makeFakeElement(tag); },
      createElementNS(namespace: string, tag: string) { calls.push(`createElementNS:${tag}`); return makeFakeElement(tag); },
    };
    const host = makeFakeElement("div");
    (host as any).ownerDocument = documentFake;
    mount(tree.root, host as unknown as Element);
    const created = calls.filter((call) => call.startsWith("createElement:")).map((call) => call.split(":")[1]);
    expect(created, "no img element is ever created").not.toContain("img");
    expect(calls.some((call) => /^createElementNS?:img/.test(call))).toBe(false);
    const unexpected = calls.filter((call) => !/^(createElement|createElementNS|setAttribute|textContent|append|replaceChildren)(?::|$)/.test(call));
    expect(unexpected, "only creation, attributes, text and append are used").toEqual([]);
    expect(created.map((tag) => tag.toUpperCase()), "the value arrived through the drawn tree as text").toContain("SPAN");
  }, 30000);

  test("the page stylesheet is the kit's", () => {
    expect(typeof KIT_CSS).toBe("string");
    expect(KIT_CSS.length).toBeGreaterThan(1000);
  });
});

/* ---------- AC12: the real adapter and the eval script ---------- */

describe("AC12 real adapter", () => {
  const baseRequest: ModelRequest = {
    system: "system prompt",
    tools: TOOL_SPECS as any,
    messages: [{ role: "user", kind: "question", question: "What fees does the vault charge?", protocol: "kamino" }],
  };

  test("the adapter sends one recorded request, maps a tool-use reply, and reads the key at call time", async () => {
    const calls: { url: string; init: any }[] = [];
    const fakeFetch: typeof fetch = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu1", name: "run_template", input: { protocol: "kamino", templateId: "section-control", params: {} } }],
        usage: { input_tokens: 11, output_tokens: 7 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const envRecord: Record<string, string | undefined> = { [MODEL_VARIABLE]: "recorded-model-id", ANTHROPIC_API_KEY: "key-first" };
    const model = anthropicModelFromEnv({ env: envRecord, fetch: fakeFetch });
    expect(model.id).toBe("recorded-model-id");
    const reply = await model.next(baseRequest, new AbortController().signal);
    expect(reply.turn.kind).toBe("tools");
    expect(reply.turn.kind === "tools" ? reply.turn.calls : []).toEqual([{ id: "tu1", name: "run_template", input: { protocol: "kamino", templateId: "section-control", params: {} } }]);
    expect(reply.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(calls[0].init.headers).get("x-api-key")).toBe("key-first");
    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe("recorded-model-id");
    expect(body.system).toBe("system prompt");
    expect(typeof body.max_tokens).toBe("number");
    expect(Array.isArray(body.tools) && typeof body.tools[0].input_schema === "object").toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);
    envRecord.ANTHROPIC_API_KEY = "key-second";
    await model.next(baseRequest, new AbortController().signal);
    expect(calls.length).toBe(2);
    expect(new Headers(calls[1].init.headers).get("x-api-key"), "the key is read at call time").toBe("key-second");
  }, 30000);

  test("usage the provider does not report is null, never zero; unparseable final text becomes no answer", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "not json at all" }] }), { status: 200 })
    ) as unknown as typeof fetch;
    const model = anthropicModelFromEnv({ env: { [MODEL_VARIABLE]: "m", ANTHROPIC_API_KEY: "key-present" }, fetch: fakeFetch });
    const reply = await model.next(baseRequest, new AbortController().signal);
    expect(reply.turn.kind).toBe("answer");
    expect(reply.turn.kind === "answer" ? reply.turn.answer : "unexpected").toBeNull();
    expect(reply.usage).toEqual({ inputTokens: null, outputTokens: null });
  }, 30000);

  test("a provider failure becomes a bare code that holds neither the key nor a header", async () => {
    const cases: [() => Promise<Response>, string][] = [
      [async () => new Response('{"error":"denied","echo":"key-secret-value"}', { status: 401 }), "model-http-401"],
      [async (): Promise<Response> => { throw new Error("fetch failed while sending x-api-key: key-secret-value"); }, "model-network"],
    ];
    for (const [respond, expectedCode] of cases) {
      const fakeFetch = respond as unknown as typeof fetch;
      const model = anthropicModelFromEnv({ env: { [MODEL_VARIABLE]: "m", ANTHROPIC_API_KEY: "key-secret-value" }, fetch: fakeFetch });
      let caught: unknown = null;
      try { await model.next(baseRequest, new AbortController().signal); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ModelError);
      expect((caught as ModelError).code).toBe(expectedCode);
      expect((caught as ModelError).message.includes("key-secret-value"), "the key is not in the message").toBe(false);
    }
  }, 30000);

  test("without the model variable the adapter reports model-not-configured and the network sees nothing", () => {
    const saved = process.env[MODEL_VARIABLE];
    delete process.env[MODEL_VARIABLE];
    try {
      let networkCalls = 0;
      const fakeFetch: typeof fetch = (async () => { networkCalls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
      expect(() => anthropicModelFromEnv({ env: { ANTHROPIC_API_KEY: "k" }, fetch: fakeFetch })).toThrow(ModelError);
      let caught: unknown = null;
      try { anthropicModelFromEnv({ env: { ANTHROPIC_API_KEY: "k" }, fetch: fakeFetch }); } catch (error) { caught = error; }
      expect((caught as ModelError).code).toBe("model-not-configured");
      expect(networkCalls).toBe(0);
    } finally {
      if (saved === undefined) delete process.env[MODEL_VARIABLE];
      else process.env[MODEL_VARIABLE] = saved;
    }
  }, 30000);

  test("the eval script lists the golden questions offline", () => {
    const ran = spawnSync("bun", ["run", "src/answers/eval.ts", "--dry-run"], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
    expect(ran.status).toBe(0);
    const printed = (ran.stdout ?? "").split("\n").filter((line) => line.trim() !== "");
    expect(printed.length).toBe(18);
    printed.forEach((line, at) => {
      const fields = line.split("\t");
      expect(fields.length, line).toBe(3);
      expect(fields[0]).toBe(GOLDEN_FIXTURE.questions[at].id);
      expect(fields[2]).toBe(GOLDEN_FIXTURE.questions[at].question);
    });
  }, 60000);
});

/* ---------- AC13: offline, deterministic, compatible ---------- */

const wordPatterns = TEXT_RULE_WORDS.map((word) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}($|[^\\p{L}\\p{N}])`, "iu"));
const ruleWordsIn = (text: string): string[] => TEXT_RULE_WORDS.filter((_word, at) => wordPatterns[at].test(text));

describe("AC13 offline, deterministic, compatible", () => {
  test("the prompt pins hold and the prompt text holds no rule word outside the catalog's own rule", () => {
    expect(sha256(PROMPT_RULES)).toBe(PINNED.promptRulesSha256);
    expect(sha256(SYSTEM_PROMPT)).toBe(PINNED.systemPromptSha256);
    expect(PROMPT_SHA256).toBe(sha256(SYSTEM_PROMPT));
    expect(SYSTEM_PROMPT.endsWith(catalogJson())).toBe(true);
    expect(ruleWordsIn(PROMPT_RULES), "the written rules hold no rule word").toEqual([]);
    expect(ruleWordsIn(SYSTEM_PROMPT), "every rule word in the whole prompt comes from the catalog instructions that forbid them")
      .toEqual(ruleWordsIn(catalogJson()));
  }, 30000);

  test("the same golden question on two handlers gives byte-identical ndjson", async () => {
    const askOne = async (): Promise<string> => {
      const handler = createAnswersHandler({ backend, model: goldenModel as any });
      return (await askDirect(handler, { question: "What fees does the vault charge?", protocol: "kamino" })).text();
    };
    expect(await askOne()).toBe(await askOne());
  }, 30000);

  test("a recorded transcript replayed through ReplayModel gives the same ndjson", async () => {
    const question = "What fees does the vault charge?";
    const scripted = new ScriptedModel(GOLDEN_FIXTURE.questions.find((entry) => entry.id === "K3")!.script);
    const first = await answerQuestion({ question, protocol: "kamino", backend, model: scripted });
    const transcript = {
      modelId: "scripted",
      entries: scripted.requests.map((request, at) => ({ requestSha256: requestSha256(request), reply: scripted.replies[at] as ModelReply })),
    };
    expect(transcript.entries.length).toBe(scripted.requests.length);
    const second = await answerQuestion({ question, protocol: "kamino", backend, model: new ReplayModel(transcript) });
    expect(second.ndjson).toBe(first.ndjson);
  }, 30000);

  test("the sha256 of the pinned answers document is pinned in this file", async () => {
    const body = JSON.stringify(await pinnedAnswers(backend));
    expect(sha256(body)).toBe(PINNED.pinnedDocumentSha256);
  }, 30000);

  test("changing any cache-key field changes the key; identical asks reuse the cache with zero calls", async () => {
    const scope = protocolScope(backend, "marinade");
    const oneRun = await backend.run("marinade", "section-claims", {}, { maxRows: 1 });
    const fields = {
      question: "Who controls the reward fee?", protocol: "marinade", snapshotIds: scope.snapshotIds,
      backend: { id: backend.id, version: backend.version, templatesSha256: oneRun.backend.templatesSha256 },
      catalogId: CATALOG.id, promptSha256: PROMPT_SHA256, modelId: "scripted",
    };
    const base = cacheKey(fields);
    expect(cacheKey({ ...fields })).toBe(base);
    expect(cacheKey({ ...fields, question: "who controls the reward fee?" }))
      .toBe(cacheKey({ ...fields, question: "Who  controls the reward fee? " }));
    for (const variant of [
      { ...fields, question: "Another question" },
      { ...fields, protocol: "kamino" },
      { ...fields, snapshotIds: ["other"] },
      { ...fields, backend: { ...fields.backend, id: "other" } },
      { ...fields, backend: { ...fields.backend, version: "9" } },
      { ...fields, backend: { ...fields.backend, templatesSha256: "other" } },
      { ...fields, catalogId: "other.catalog" },
      { ...fields, promptSha256: "other" },
      { ...fields, modelId: "other" },
    ]) {
      expect(cacheKey(variant)).not.toBe(base);
    }

    const counted = counting(backend);
    let created = 0;
    let nextCalls = 0;
    const handler = createAnswersHandler({
      backend: counted.backend,
      model: () => {
        created++;
        return new ScriptedModel(scriptWith(TOOL_CONTROL_M1, { view: "control-chain", results: ["r1"] }), { beforeTurn: () => { nextCalls++; } });
      },
    });
    const request = (): Request => new Request("http://127.0.0.1/api/answers/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Who controls the reward fee?", protocol: "marinade" }),
    });
    const first = await handler(request());
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    const runsAfterFirst = counted.counts.run;
    const evidenceAfterFirst = counted.counts.evidence;
    const callsAfterFirst = nextCalls;
    const second = await handler(request());
    expect(await second.text()).toBe(firstBody);
    expect(counted.counts.run, "the second identical ask made no tool call").toBe(runsAfterFirst);
    expect(counted.counts.evidence, "the second identical ask made no evidence lookup").toBe(evidenceAfterFirst);
    expect(nextCalls, "the second identical ask made no model call").toBe(callsAfterFirst);
  }, 60000);

  test("the bundle hashes equal the base's", () => {
    expect(sha256(JSON.stringify(sourceOf("marinade").bundle))).toBe(PINNED.marinadeBundleSha256);
    expect(sha256(JSON.stringify(sourceOf("kamino").bundle))).toBe(PINNED.kaminoBundleSha256);
  }, 30000);

  test("every fixed reply string holds no rule word, except the two approved sentences", () => {
    const exempt = new Set([REFUSAL_TEXT, NO_MODEL_TEXT]);
    for (const member of REPLY_STRINGS) {
      const found = ruleWordsIn(member);
      if (exempt.has(member)) expect(found.length, `the exempt sentence holds the rule word the contract forbids: ${member}`).toBeGreaterThan(0);
      else expect(found, `fixed string holds a rule word: ${member}`).toEqual([]);
    }
    expect(REPLY_STRINGS).toContain(REFUSAL_TEXT);
    expect(REPLY_STRINGS).toContain(NO_MODEL_TEXT);
    expect(REPLY_STRINGS).toContain(PINNED_LABEL);
  }, 30000);

  test("the golden, refusal and no-model replies hold no rule word in literal text, recorded data aside", async () => {
    const exempt = new Set([REFUSAL_TEXT, NO_MODEL_TEXT]);
    const offending = (text: string): boolean => wordPatterns.some((pattern) => pattern.test(text));
    const serverBuilt = new Set(["refusal", "prepared", "status"]);
    const literalsOf = (ndjson: string): string[] => {
      const out: string[] = [];
      for (const message of lines(ndjson)) {
        for (const component of message?.updateComponents?.components ?? []) {
          for (const prop of ["text", "title"]) if (typeof component?.[prop] === "string") out.push(component[prop]);
        }
        const model = message?.updateDataModel?.value;
        if (typeof model?.meta?.question === "string") out.push(model.meta.question);
        for (const [id, result] of Object.entries((model?.results ?? {}) as Record<string, any>)) {
          if (!serverBuilt.has(id)) continue;
          out.push(...(result.coverageNotes ?? []));
          if (typeof result.scopeSource === "string") out.push(result.scopeSource);
          for (const row of result.rows ?? []) {
            out.push(...Object.values(row.values ?? {}).filter((value): value is string => typeof value === "string"));
            if (typeof row.scopeSource === "string") out.push(row.scopeSource);
          }
        }
      }
      return out;
    };
    for (const entry of GOLDEN_FIXTURE.questions) {
      const outcome = await answerQuestion({
        question: entry.question, protocol: entry.protocol, backend,
        model: goldenModel({ question: entry.question, protocol: entry.protocol })!,
      });
      for (const text of literalsOf(outcome.ndjson)) {
        if (exempt.has(text)) continue;
        expect(offending(text), `${entry.id}: literal text holds a rule word: ${text}`).toBe(false);
      }
    }
    const refusalCase = ADVERSARIAL.refusalCase;
    const refusalOutcome = await answerQuestion({
      question: "Twice refused words", protocol: "kamino", backend,
      model: new ScriptedModel(scriptWith(refusalCase.tool, refusalCase.badA, refusalCase.badB)),
    });
    expect(refusalOutcome.kind).toBe("refusal");
    for (const text of literalsOf(refusalOutcome.ndjson)) {
      if (exempt.has(text)) continue;
      expect(offending(text), `refusal literal holds a rule word: ${text}`).toBe(false);
    }
    const handler = createAnswersHandler({ backend, model: () => null });
    const noModel = await askDirect(handler, { question: "What fees does the vault charge?", protocol: "kamino" });
    for (const text of literalsOf(await noModel.text())) {
      if (exempt.has(text)) continue;
      expect(offending(text), `no-model literal holds a rule word: ${text}`).toBe(false);
    }
  }, 120000);

  test("no blocked network call ever happened in this file", () => {
    expect(hits).toEqual({ fetch: 0, websocket: 0, connect: 0, net: 0, http: 0 });
  }, 30000);
});
