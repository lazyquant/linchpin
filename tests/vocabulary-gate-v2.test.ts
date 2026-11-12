import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type * as TermsNS from "../src/graph/vocabulary/terms";
import type * as LintNS from "../src/graph/vocabulary/lint";
import type * as QuestionsNS from "../src/graph/vocabulary/questions";
import type * as ReportNS from "../src/graph/vocabulary/report";
import type * as CliNS from "../src/graph/vocabulary/cli";
import type * as BaseVocabularyNS from "../src/engine/queries/vocabulary";
import type * as BaseSchemaNS from "../src/graph/evidence/schema";
import type * as BaseRequestNS from "../src/engine/queries/request";
import type * as BaseProtocolsNS from "../src/graph/evidence/protocols";

let termsMod: typeof TermsNS;
let lintMod: typeof LintNS;
let questionsMod: typeof QuestionsNS;
let reportMod: typeof ReportNS;
let cliMod: typeof CliNS;
let baseVocabulary: typeof BaseVocabularyNS;
let baseSchema: typeof BaseSchemaNS;
let baseRequest: typeof BaseRequestNS;
let baseProtocols: typeof BaseProtocolsNS;
let netModule: typeof import("node:net");

const ROOT = join(import.meta.dir, "..");
const FIX = join(import.meta.dir, "fixtures", "vocabulary-gate-v2");

const trapped: Record<string, number> = { fetch: 0, connect: 0, listen: 0, socket: 0 };
const originals: Record<string, unknown> = {};
function trapNet(name: string): never {
  trapped[name] += 1;
  throw new Error(`offline trap: ${name} was called`);
}

let TERMS: TermsNS.Term[];
let registryProblems: typeof TermsNS.registryProblems;
let defaultSources: typeof TermsNS.defaultSources;
let lint: typeof LintNS.lint;
let defaultLintInput: typeof LintNS.defaultLintInput;
let QUESTIONS: QuestionsNS.Question[];
let createQuestionRuntime: typeof QuestionsNS.createQuestionRuntime;
let evaluateQuestion: typeof QuestionsNS.evaluateQuestion;
let evaluateQuestions: typeof QuestionsNS.evaluateQuestions;
let questionProblems: typeof QuestionsNS.questionProblems;
let parseWaivers: typeof ReportNS.parseWaivers;
let buildReport: typeof ReportNS.buildReport;
let renderReport: typeof ReportNS.renderReport;
let exitCodeOf: typeof ReportNS.exitCodeOf;
let loadDefaultInputs: typeof ReportNS.loadDefaultInputs;
let runCliMain: typeof CliNS.main;
let VOCABULARY: Record<string, { class: string }>;
let CORE_TYPES: Record<string, { class: string; mappedFrom: readonly { predicate: string }[] }>;
let NOT_PROJECTED: readonly string[];
let KIND_LABELS: readonly string[];
let SUBJECT_PATTERN: RegExp;
let collectSlice1Inputs: typeof BaseProtocolsNS.collectSlice1Inputs;

let inputs: BaseProtocolsNS.EvidenceInput[];
let lintSnapshots: LintNS.LintSnapshot[];
let lintInput: LintNS.LintInput;
let runtime: QuestionsNS.QuestionRuntime;
let realBase: Omit<ReportNS.ReportInputs, "waivers">;
let reportReal: ReportNS.Report;

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

beforeAll(async () => {
  originals.fetch = globalThis.fetch;
  globalThis.fetch = ((...a: unknown[]) => trapNet("fetch")) as unknown as typeof fetch;
  originals.connect = Bun.connect;
  (Bun as unknown as Record<string, unknown>).connect = () => trapNet("connect");
  originals.listen = Bun.listen;
  (Bun as unknown as Record<string, unknown>).listen = () => trapNet("listen");
  netModule = await import("node:net");
  originals.socketConnect = netModule.Socket.prototype.connect;
  netModule.Socket.prototype.connect = function (...a: unknown[]) {
    trapNet("socket");
  } as unknown as typeof netModule.Socket.prototype.connect;
  termsMod = await import("../src/graph/vocabulary/terms");
  lintMod = await import("../src/graph/vocabulary/lint");
  questionsMod = await import("../src/graph/vocabulary/questions");
  reportMod = await import("../src/graph/vocabulary/report");
  cliMod = await import("../src/graph/vocabulary/cli");
  baseVocabulary = await import("../src/engine/queries/vocabulary");
  baseSchema = await import("../src/graph/evidence/schema");
  baseRequest = await import("../src/engine/queries/request");
  baseProtocols = await import("../src/graph/evidence/protocols");

  TERMS = termsMod.TERMS as TermsNS.Term[];
  registryProblems = termsMod.registryProblems;
  defaultSources = termsMod.defaultSources;
  lint = lintMod.lint;
  defaultLintInput = lintMod.defaultLintInput;
  QUESTIONS = questionsMod.QUESTIONS as QuestionsNS.Question[];
  createQuestionRuntime = questionsMod.createQuestionRuntime;
  evaluateQuestion = questionsMod.evaluateQuestion;
  evaluateQuestions = questionsMod.evaluateQuestions;
  questionProblems = questionsMod.questionProblems;
  parseWaivers = reportMod.parseWaivers;
  buildReport = reportMod.buildReport;
  renderReport = reportMod.renderReport;
  exitCodeOf = reportMod.exitCodeOf;
  loadDefaultInputs = reportMod.loadDefaultInputs;
  runCliMain = cliMod.main;
  VOCABULARY = baseVocabulary.VOCABULARY as unknown as Record<string, { class: string }>;
  CORE_TYPES = baseSchema.CORE_TYPES as unknown as Record<string, { class: string; mappedFrom: readonly { predicate: string }[] }>;
  NOT_PROJECTED = baseSchema.NOT_PROJECTED;
  KIND_LABELS = baseSchema.KIND_LABELS;
  SUBJECT_PATTERN = baseRequest.SUBJECT_PATTERN;
  collectSlice1Inputs = baseProtocols.collectSlice1Inputs;

  inputs = collectSlice1Inputs(ROOT);
  lintSnapshots = inputs
    .filter(i => i.snapshot.constructed === false)
    .map(i => ({
      id: i.snapshot.id,
      facts: i.snapshot.facts.map(f => ({ id: f.id, predicate: f.predicate, object: f.object, privacy: f.privacy })),
    }));
  lintInput = defaultLintInput(lintSnapshots);
  runtime = createQuestionRuntime(inputs);
  realBase = loadDefaultInputs();
  reportReal = buildReport({ ...realBase, waivers: [] });
}, 60000);

afterAll(() => {
  globalThis.fetch = originals.fetch as typeof fetch;
  (Bun as unknown as Record<string, unknown>).connect = originals.connect;
  (Bun as unknown as Record<string, unknown>).listen = originals.listen;
  netModule.Socket.prototype.connect = originals.socketConnect as typeof netModule.Socket.prototype.connect;
});

const vocabCopy = (): Record<string, { class: string }> => ({ ...VOCABULARY });
function mkInput(over: Partial<LintNS.LintInput> = {}): LintNS.LintInput {
  return {
    vocabulary: vocabCopy(),
    coreTypes: structuredClone(CORE_TYPES) as LintNS.LintInput["coreTypes"],
    notProjected: [...NOT_PROJECTED],
    terms: [...TERMS],
    snapshots: [],
    ...over,
  };
}
const byRule = (findings: LintNS.Finding[], rule: string) => findings.filter(f => f.rule === rule);
const termOf = (terms: TermsNS.Term[], type: TermsNS.TermType, name: string) => terms.find(t => t.type === type && t.name === name);
const soundDef = "Records the observed value of the term on the subject entity.";

type Ref = { snapshotId: string; factId: string };
const refKey = (r: Ref) => `${r.snapshotId}\u0000${r.factId}`;
function collectRefs(q: QuestionsNS.Question): { yes: Ref[]; no: Ref[] } {
  const out: { yes: Ref[]; no: Ref[] } = { yes: [], no: [] };
  for (const which of ["yes", "no"] as const) {
    for (const e of q[which].expect ?? []) {
      for (const row of e.rows ?? []) {
        if (row.rowKind === "fact" || row.rowKind === "unknown") out[which].push(row.fact);
        else if (row.rowKind === "path") out[which].push(...row.facts);
      }
      for (const ch of e.changes ?? []) {
        if (ch.before) out[which].push(ch.before);
        if (ch.after) out[which].push(ch.after);
      }
    }
  }
  return out;
}
function collectReceipts(q: QuestionsNS.Question): { snapshotId: string; receiptId: string; historicalState: string }[] {
  const out: { snapshotId: string; receiptId: string; historicalState: string }[] = [];
  for (const which of ["yes", "no"] as const)
    for (const e of q[which].expect ?? [])
      for (const row of e.rows ?? [])
        if (row.rowKind === "receipt") out.push({ snapshotId: row.snapshotId, receiptId: row.receiptId, historicalState: row.historicalState });
  return out;
}
const sortedKeys = (refs: Ref[]) => [...new Set(refs.map(refKey))].sort();
const receiptKey = (r: { snapshotId: string; receiptId: string; historicalState: string }) => `${r.snapshotId}\u0000${r.receiptId}\u0000${r.historicalState}`;

describe("AC1 registry", () => {
  test("T1 AC1: registry complete against the base sources, all draft, treasury kind by relation", () => {
    const problems = registryProblems(TERMS);
    expect(problems.missing).toEqual([]);
    expect(problems.extra).toEqual([]);
    expect(problems.duplicate).toEqual([]);
    const expectedCount = Object.keys(VOCABULARY).length + Object.keys(CORE_TYPES).length + KIND_LABELS.length;
    expect(TERMS.length).toBe(expectedCount);
    for (const t of TERMS) expect(t.status).toBe("draft");
    const treasury = termOf(TERMS, "kind", "Treasury") as Extract<TermsNS.Term, { type: "kind" }> | undefined;
    expect(treasury).toBeDefined();
    expect(treasury?.establishedBy).toBe("relation-to-other");
  });

  test("T2 AC1: completeness fails naming an added vocabulary key, a removed entry, a duplicate and an unknown entry", () => {
    const sources = defaultSources();
    const extended = {
      vocabulary: { ...(sources.vocabulary as Record<string, unknown>), "sample-extra-predicate": { class: "state" } },
      coreTypes: sources.coreTypes,
      kinds: sources.kinds,
    };
    expect(registryProblems(TERMS, extended).missing).toContainEqual({ type: "predicate", name: "sample-extra-predicate" });

    const withoutTreasury = TERMS.filter(t => !(t.type === "kind" && t.name === "Treasury"));
    expect(registryProblems(withoutTreasury).missing).toContainEqual({ type: "kind", name: "Treasury" });

    const bond = termOf(TERMS, "predicate", "bond") as TermsNS.Term;
    expect(registryProblems([...TERMS, bond]).duplicate).toContainEqual({ type: "predicate", name: "bond" });

    const stranger: TermsNS.Term = { type: "predicate", name: "sample-extra-term", definition: soundDef, status: "draft", asserts: "current-state" };
    expect(registryProblems([...TERMS, stranger]).extra).toContainEqual({ type: "predicate", name: "sample-extra-term" });
  });

  test("T3 AC1: every name that is both a predicate and a core type has both registry entries", () => {
    const duals = Object.keys(VOCABULARY).filter(k => Object.hasOwn(CORE_TYPES, k));
    expect(duals.length).toBe(14);
    for (const name of duals) {
      expect(termOf(TERMS, "predicate", name)).toBeDefined();
      expect(termOf(TERMS, "coreType", name)).toBeDefined();
    }
  });
});

describe("AC2 rules on constructed inputs", () => {
  test("T4-VL1: an unmapped vocabulary key yields exactly one coverage finding naming it; the real vocabulary yields none", () => {
    const fired = lint(mkInput({ vocabulary: { ...vocabCopy(), "sample-extra-predicate": { class: "state" } } }));
    const vl1 = byRule(fired, "VL1");
    expect(vl1.map(f => f.id)).toEqual(["VL1:sample-extra-predicate"]);
    expect(vl1[0]?.severity).toBe("blocking");
    expect(vl1[0]?.status).toBe("open");
    expect(typeof (vl1[0]?.evidence as Record<string, unknown>).message).toBe("string");
    const quiet = byRule(lint(mkInput()), "VL1");
    expect(quiet).toEqual([]);
  });

  test("T4-VL2: fires on value objects in a relation class; silent with an identity object, on unknown or none only, and on private facts", () => {
    const vault = "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
    const fire = lint(mkInput({ snapshots: [{ id: "snap-a", facts: [{ id: "f1", predicate: "bond", object: "1000", privacy: "public" }] }] }));
    expect(byRule(fire, "VL2").map(f => f.id)).toEqual(["VL2:bond"]);
    expect(byRule(fire, "VL2")[0]?.severity).toBe("blocking");

    const withIdentity = lint(
      mkInput({
        snapshots: [
          {
            id: "snap-a",
            facts: [
              { id: "f1", predicate: "bond", object: "1000", privacy: "public" },
              { id: "f2", predicate: "bond", object: vault, privacy: "public" },
            ],
          },
        ],
      }),
    );
    expect(byRule(withIdentity, "VL2")).toEqual([]);

    const onlySentinels = lint(
      mkInput({
        snapshots: [
          {
            id: "snap-a",
            facts: [
              { id: "f1", predicate: "CONTROLLED_BY", object: "unknown", privacy: "public" },
              { id: "f2", predicate: "CONTROLLED_BY", object: "none", privacy: "public" },
            ],
          },
        ],
      }),
    );
    expect(byRule(onlySentinels, "VL2")).toEqual([]);

    const privateOnly = lint(mkInput({ snapshots: [{ id: "snap-a", facts: [{ id: "f1", predicate: "bond", object: "1000", privacy: "private" }] }] }));
    expect(byRule(privateOnly, "VL2")).toEqual([]);

    const noneAndValue = lint(
      mkInput({
        snapshots: [
          {
            id: "snap-a",
            facts: [
              { id: "f1", predicate: "has-full-access-key", object: "none", privacy: "public" },
              { id: "f2", predicate: "has-full-access-key", object: "ed25519-key-material", privacy: "public" },
            ],
          },
        ],
      }),
    );
    expect(byRule(noneAndValue, "VL2").map(f => f.id)).toEqual(["VL2:has-full-access-key"]);
  });

  test("T4-VL3: a shared last word across two classes fires once; the stop list and one class stay silent", () => {
    const fired = lint(mkInput({ vocabulary: { MULTISIG_THRESHOLD: { class: "state" }, "mpc-threshold": { class: "control" } } }));
    const vl3 = byRule(fired, "VL3");
    expect(vl3.map(f => f.id)).toEqual(["VL3:MULTISIG_THRESHOLD+mpc-threshold"]);
    expect(vl3[0]?.terms.slice().sort()).toEqual(vl3[0]?.terms);
    expect(vl3[0]?.severity).toBe("blocking");
    expect((vl3[0]?.evidence as Record<string, unknown>).keyWord).toBe("threshold");
    expect((vl3[0]?.evidence as Record<string, unknown>).classes).toEqual({ MULTISIG_THRESHOLD: "state", "mpc-threshold": "control" });

    const stopList = lint(
      mkInput({
        vocabulary: { PRICED_BY: { class: "dependency" }, BACKED_BY: { class: "backing" }, CONTROLLED_BY: { class: "control" } },
      }),
    );
    expect(byRule(stopList, "VL3")).toEqual([]);

    const sameClass = lint(
      mkInput({
        vocabulary: {
          MULTISIG_THRESHOLD: { class: "state" },
          "mpc-threshold": { class: "state" },
          "safe-threshold": { class: "state" },
          "vote-threshold": { class: "state" },
        },
      }),
    );
    expect(byRule(sameClass, "VL3")).toEqual([]);
  });

  test("T4-VL4: normalised-equal predicates with different mappings or an unmapped member fire; the same mapping stays silent", () => {
    const terms = [
      ...TERMS,
      { type: "predicate", name: "FOO_BAR", definition: soundDef, status: "draft", asserts: "current-state" },
      { type: "predicate", name: "foo-bar", definition: soundDef, status: "draft", asserts: "current-state" },
    ] as TermsNS.Term[];
    const coreTypes = structuredClone(CORE_TYPES) as Record<string, { class: string; mappedFrom: { predicate: string }[] }>;
    coreTypes["SAMPLE_TYPE"] = { class: "control", mappedFrom: [{ predicate: "FOO_BAR" }] };
    const fired = lint(
      mkInput({ vocabulary: { ...vocabCopy(), FOO_BAR: { class: "control" }, "foo-bar": { class: "control" } }, coreTypes: coreTypes as LintNS.LintInput["coreTypes"], terms }),
    );
    expect(byRule(fired, "VL4").map(f => f.id)).toEqual(["VL4:FOO_BAR+foo-bar"]);

    expect(byRule(lint(mkInput()), "VL4")).toEqual([]);

    const moved = structuredClone(CORE_TYPES) as Record<string, { class: string; mappedFrom: { predicate: string }[] }>;
    moved["PRICED_BY"].mappedFrom = moved["PRICED_BY"].mappedFrom.filter(m => m.predicate !== "priced-by");
    moved["DEPENDS_ON"].mappedFrom = [...moved["DEPENDS_ON"].mappedFrom, { predicate: "priced-by" }];
    const different = lint(mkInput({ coreTypes: moved as LintNS.LintInput["coreTypes"] }));
    expect(byRule(different, "VL4").map(f => f.id)).toEqual(["VL4:PRICED_BY+priced-by"]);
  });

  test("T4-VL5: a kind established by relation fires; a decoded kind stays silent", () => {
    const fired = byRule(lint(mkInput()), "VL5");
    expect(fired.map(f => f.id)).toEqual(["VL5:Treasury"]);
    expect(fired[0]?.severity).toBe("blocking");
    const terms = structuredClone(TERMS).map(t => (t.type === "kind" && t.name === "Treasury" ? { ...t, establishedBy: "decoded-type" as const } : t));
    expect(byRule(lint(mkInput({ terms })), "VL5")).toEqual([]);
  });

  test("T4-VL6: mixed assertions in one core type fire; one shared value stays silent", () => {
    const terms = structuredClone(TERMS).map(t => (t.type === "predicate" && t.name === "ALLOCATION_ADMIN" ? { ...t, asserts: "proposed-effect" as const } : t));
    const fired = byRule(lint(mkInput({ terms })), "VL6");
    expect(fired.map(f => f.id)).toEqual(["VL6:ADMIN"]);
    expect(fired[0]?.severity).toBe("blocking");
    expect((fired[0]?.evidence as Record<string, unknown>).asserts).toMatchObject({ VAULT_ADMIN: "current-state", ALLOCATION_ADMIN: "proposed-effect" });
    expect(byRule(lint(mkInput()), "VL6")).toEqual([]);
  });

  test("T4-VL7: missing, short and name-repeating definitions carry their severities; a sound definition stays silent", () => {
    const name = "UPGRADE_AUTHORITY";
    const withDef = (definition: string, status: "draft" | "reviewed" = "draft") =>
      structuredClone(TERMS).map(t => (t.type === "predicate" && t.name === name ? { ...t, definition, status } : t));
    const pick = (terms: TermsNS.Term[]) => byRule(lint(mkInput({ terms })), "VL7");

    const missing = pick(withDef(""));
    expect(missing.map(f => f.id)).toEqual([`VL7:${name}`]);
    expect(missing[0]?.severity).toBe("blocking");
    expect((missing[0]?.evidence as Record<string, unknown>).problem).toBe("missing");

    const short = pick(withDef("too short"));
    expect(short.map(f => f.id)).toEqual([`VL7:${name}`]);
    expect(short[0]?.severity).toBe("notice");
    expect((short[0]?.evidence as Record<string, unknown>).problem).toBe("short");

    const repeats = pick(withDef("upgrade authority"));
    expect(repeats.map(f => f.id)).toEqual([`VL7:${name}`]);
    expect(repeats[0]?.severity).toBe("notice");
    expect((repeats[0]?.evidence as Record<string, unknown>).problem).toBe("repeats-name");

    expect(pick(withDef("too short", "reviewed"))[0]?.severity).toBe("blocking");
    expect(pick(withDef("The authority that may deploy changed program code."))).toEqual([]);
  });

  test("T4-VL8: an unexercised predicate is a notice; an exercised one stays silent", () => {
    const fired = byRule(lint(mkInput()), "VL8");
    const mint = fired.find(f => f.id === "VL8:MINT_AUTHORITY");
    expect(mint).toBeDefined();
    expect(mint?.severity).toBe("notice");
    expect(mint?.evidence).toEqual({ factsExamined: 0, predicateFacts: 0, snapshots: 0 });
    const exercised = lint(
      mkInput({ snapshots: [{ id: "snap-a", facts: [{ id: "f1", predicate: "MINT_AUTHORITY", object: "none", privacy: "public" }] }] }),
    );
    expect(byRule(exercised, "VL8").find(f => f.id === "VL8:MINT_AUTHORITY")).toBeUndefined();
  });
});

describe("AC3 findings on the committed vocabulary", () => {
  test("T5 AC3: lint ids on the committed snapshots equal the pinned fixture list", () => {
    const pinned = readJson(join(FIX, "findings.json")) as string[];
    expect([...pinned].sort()).toEqual(pinned);
    const findings = lint(lintInput);
    const got = findings.map(f => f.id);
    expect(got).toEqual(pinned);
    expect(pinned).toContain("VL3:MULTISIG_THRESHOLD+liquidation-threshold+mpc-threshold+safe-threshold+vote-threshold");
    for (const p of ["vote-threshold", "has-full-access-key", "has-function-call-key", "bond", "proposal-period", "paused", "contract-mode", "mpc-threshold", "mpc-allowed-image"])
      expect(pinned).toContain(`VL2:${p}`);
    expect(pinned).toContain("VL5:Treasury");
    expect(pinned).toContain("VL8:MINT_AUTHORITY");
    expect(pinned).toContain("VL8:safe-threshold");
    for (const rule of ["VL1", "VL4", "VL6", "VL7"]) expect(got.some(id => id.startsWith(`${rule}:`))).toBe(false);
    expect(pinned.length).toBe(63);
    expect(byRule(findings, "VL2").length).toBe(9);
    expect(findings.filter(f => f.severity === "blocking").length).toBe(11);
    expect(findings.filter(f => f.severity === "notice").length).toBe(52);
    expect(findings.every(f => f.status === "open")).toBe(true);
  });

  test("T6 AC3: independent derivation of the value, split, kind and unexercised rules equals the lint output", () => {
    const stop = new Set(["by", "from", "to", "of", "in"]);
    const relation = new Set(["control", "dependency", "backing", "origin"]);
    const splitWords = (n: string) =>
      n
        .split(/_|-| /)
        .flatMap(x => x.replace(/([a-z])([A-Z])/g, "$1 $2").split(" "))
        .map(x => x.toLowerCase())
        .filter(Boolean);
    const facts = lintSnapshots.flatMap(s => s.facts).filter(f => f.privacy === "public");
    const isIdentity = (o: string) => SUBJECT_PATTERN.test(o);
    const perPred = new Map<string, string[]>();
    for (const p of Object.keys(VOCABULARY)) perPred.set(p, []);
    for (const f of facts) if (perPred.has(f.predicate)) perPred.get(f.predicate)?.push(f.object);

    const myVl2: string[] = [];
    for (const [p, objects] of perPred) {
      const cls = VOCABULARY[p]?.class;
      if (!cls || !relation.has(cls) || objects.length === 0) continue;
      const hasValue = objects.some(o => !isIdentity(o) && o !== "none" && o !== "unknown");
      if (!objects.some(isIdentity) && hasValue) myVl2.push(`VL2:${p}`);
    }
    const groups = new Map<string, string[]>();
    for (const p of Object.keys(VOCABULARY)) {
      const w = splitWords(p);
      const key = w.length ? w[w.length - 1] : "";
      if (!key || stop.has(key)) continue;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const myVl3: string[] = [];
    for (const [, members] of groups) {
      const classes = new Set(members.map(p => VOCABULARY[p]?.class));
      if (members.length >= 2 && classes.size >= 2) myVl3.push(`VL3:${members.slice().sort().join("+")}`);
    }
    const myVl5 = ["VL5:Treasury"];
    const myVl8 = Object.keys(VOCABULARY)
      .filter(p => (perPred.get(p) ?? []).length === 0)
      .map(p => `VL8:${p}`);
    const mine = [...myVl2, ...myVl3, ...myVl5, ...myVl8].sort();
    const allFindings = lint(lintInput);
    const got = [...byRule(allFindings, "VL2"), ...byRule(allFindings, "VL3"), ...byRule(allFindings, "VL5"), ...byRule(allFindings, "VL8")]
      .map(f => f.id)
      .sort();
    expect(got).toEqual(mine);
  });
});

describe("AC4 finding evidence", () => {
  test("T7 AC4: finding evidence resolves against the snapshots and matches independently counted facts", () => {
    const findings = lint(lintInput);
    const total = lintSnapshots.reduce((a, s) => a + s.facts.filter(f => f.privacy === "public").length, 0);
    const index = new Map<string, Map<string, string>>();
    for (const s of lintSnapshots) {
      const m = new Map<string, string>();
      for (const f of s.facts) if (f.privacy === "public") m.set(f.id, f.predicate);
      index.set(s.id, m);
    }
    const mine = new Map<string, number>();
    for (const f of lintSnapshots.flatMap(s => s.facts).filter(f => f.privacy === "public")) mine.set(f.predicate, (mine.get(f.predicate) ?? 0) + 1);
    for (const f of findings) {
      if (f.rule !== "VL2" && f.rule !== "VL8") continue;
      expect(f.evidence.factsExamined).toBe(total);
      if (f.rule === "VL8") {
        expect(f.evidence.predicateFacts).toBe(0);
        expect(f.evidence.snapshots).toBe(lintSnapshots.length);
        continue;
      }
      const predicate = f.terms[0] ?? "";
      const count = mine.get(predicate) ?? 0;
      expect(f.evidence.predicateFacts).toBe(count);
      expect(f.evidence.identityObjects).toBe(0);
      const examples = f.evidence.examples as { snapshotId: string; factId: string }[];
      expect(examples.length).toBe(Math.min(3, count));
      let lastKey = "";
      for (const e of examples) {
        expect(lintSnapshots.map(s => s.id)).toContain(e.snapshotId);
        expect(index.get(e.snapshotId)?.get(e.factId)).toBe(predicate);
        const key = `${e.snapshotId}\u0000${e.factId}`;
        expect(key >= lastKey).toBe(true);
        lastKey = key;
      }
      const predFacts = lintSnapshots.flatMap(s => s.facts).filter(x => x.privacy === "public" && x.predicate === predicate);
      expect(f.evidence.objects).toEqual({
        value: predFacts.filter(x => !SUBJECT_PATTERN.test(x.object) && x.object !== "none" && x.object !== "unknown").length,
        none: predFacts.filter(x => x.object === "none").length,
        unknown: predFacts.filter(x => x.object === "unknown").length,
      });
    }
    expect(mine.get("vote-threshold") ?? 0).toBe(53);
    expect(mine.get("has-full-access-key") ?? 0).toBe(33);
  });
});

describe("AC5 questions", () => {
  test("T8 AC5: questions hold the twelve ids, pass on the real runtime and leave none failing", () => {
    expect(QUESTIONS.map(q => q.id)).toEqual(["CQ1", "CQ2", "CQ3", "CQ4", "CQ5", "CQ6", "CQ7", "CQ8", "CQ9", "CQ10", "CQ11", "CQ12"]);
    const results = evaluateQuestions(QUESTIONS, runtime);
    expect(results.map(r => r.id)).toEqual(QUESTIONS.map(q => q.id));
    for (const r of results) {
      expect(r.yes.status).not.toBe("fail");
      expect(r.no.status).not.toBe("fail");
    }
    for (const r of results.filter(x => x.id !== "CQ12")) {
      expect(r.yes.status).toBe("pass");
      expect(r.no.status).toBe("pass");
    }
    const cq12 = results.find(r => r.id === "CQ12");
    expect(cq12?.yes.status).toBe("uncovered");
    expect(cq12?.no.status).toBe("uncovered");
    const bothCovered = results.filter(r => r.id !== "CQ12" && r.yes.status === "pass" && r.no.status === "pass").length;
    expect(bothCovered).toBeGreaterThanOrEqual(9);
    for (const c of [cq12?.yes, cq12?.no]) {
      expect(typeof c?.detail).toBe("string");
      expect((c?.detail.match(/\./g) ?? []).length).toBe(1);
      expect(c?.detail.trim().endsWith(".")).toBe(true);
    }
    expect(questionProblems(QUESTIONS, runtime)).toEqual([]);
    for (const q of QUESTIONS)
      for (const which of ["yes", "no"] as const)
        for (const e of q[which].expect ?? [])
          for (const row of e.rows ?? [])
            if (row.rowKind === "unknown") {
              const fact = runtime.hasFact(row.fact.snapshotId, row.fact.factId);
              expect(fact).toBeDefined();
              expect(fact?.object).toBe(row.object);
            }
  });

  test("T9 AC5: stored fact ids equal the independently resolved selectors", () => {
    const expected = readJson(join(FIX, "cq-expected.json")) as {
      factRefs: Record<string, { yes: Ref[]; no: Ref[] }>;
      receipts: Record<string, { yes: { snapshotId: string; receiptId: string; historicalState: string }[]; no: { snapshotId: string; receiptId: string; historicalState: string }[] }>;
    };
    for (const q of QUESTIONS) {
      const gotRefs = collectRefs(q);
      const expRefs = expected.factRefs[q.id] ?? { yes: [], no: [] };
      expect(sortedKeys(gotRefs.yes)).toEqual(sortedKeys(expRefs.yes));
      expect(sortedKeys(gotRefs.no)).toEqual(sortedKeys(expRefs.no));
      const gotReceipts = collectReceipts(q);
      const expReceipts = expected.receipts[q.id] ?? { yes: [], no: [] };
      expect(gotReceipts.map(receiptKey).sort()).toEqual([...expReceipts.yes, ...expReceipts.no].map(receiptKey).sort());
    }
  });
});

describe("AC6 a question that looks answered and is not", () => {
  test("T10a AC6: an empty result fails the unknown and missing-coverage cases; the stored ones pass", () => {
    const q3 = QUESTIONS.find(q => q.id === "CQ3") as QuestionsNS.Question;
    expect(evaluateQuestion(q3, runtime).no.status).toBe("pass");
    const q3broken = structuredClone(q3);
    q3broken.no.expect = [{ rows: [] }];
    expect(evaluateQuestion(q3broken, runtime).no.status).toBe("fail");

    const q7 = QUESTIONS.find(q => q.id === "CQ7") as QuestionsNS.Question;
    expect(evaluateQuestion(q7, runtime).no.status).toBe("pass");
    const q7broken = structuredClone(q7);
    q7broken.no.expect = [{ reasons: [], changes: [] }];
    expect(evaluateQuestion(q7broken, runtime).no.status).toBe("fail");
  });

  test("T10b AC6: stored cases fail against a runtime that holds no facts", () => {
    const empty: QuestionsNS.QuestionRuntime = {
      run: () => ({ rows: [], reasons: [], changes: [] }),
      hasFact: () => undefined,
      hasReceipt: () => false,
      snapshots: () => [],
    };
    for (const id of ["CQ3", "CQ7"]) {
      const q = QUESTIONS.find(x => x.id === id) as QuestionsNS.Question;
      expect(evaluateQuestion(q, empty).no.status).toBe("fail");
    }
  });

  test("T10c AC6: the mint fixture passes with the none row and fails empty or against an unknown object", () => {
    const q12 = QUESTIONS.find(q => q.id === "CQ12") as QuestionsNS.Question;
    const snapNone = readJson(join(FIX, "mint-authority-none.snapshot.json")) as BaseProtocolsNS.EvidenceInput["snapshot"];
    const mint = snapNone.subjects[0];
    const rtNone = createQuestionRuntime([{ snapshot: snapNone }], { protocols: [] });
    const step: QuestionsNS.Step = {
      template: "control",
      params: { subject: mint, scope: { snapshotId: snapNone.id, asOf: snapNone.observedTo, maxHops: 1, maxResults: 100 } },
    };
    const noneRow: QuestionsNS.ExpectedRow = {
      rowKind: "unknown",
      fact: { snapshotId: snapNone.id, factId: "fact-mint-none-fixture-001" },
      object: "none",
    };
    const passCase: QuestionsNS.Question = { ...structuredClone(q12), yes: { status: "covered", steps: [step], expect: [{ rows: [noneRow] }] } };
    expect(evaluateQuestion(passCase, rtNone).yes.status).toBe("pass");

    const emptyCase = structuredClone(passCase);
    emptyCase.yes.expect = [{ rows: [] }];
    expect(evaluateQuestion(emptyCase, rtNone).yes.status).toBe("fail");

    const snapUnknown = readJson(join(FIX, "mint-authority-unknown.snapshot.json")) as BaseProtocolsNS.EvidenceInput["snapshot"];
    const rtUnknown = createQuestionRuntime([{ snapshot: snapUnknown }], { protocols: [] });
    const unknownCase = structuredClone(passCase);
    unknownCase.yes.expect = [
      { rows: [{ rowKind: "unknown", fact: { snapshotId: snapUnknown.id, factId: "fact-mint-unknown-fixture-001" }, object: "none" }] } as QuestionsNS.Expectation,
    ];
    expect(evaluateQuestion(unknownCase, rtUnknown).yes.status).toBe("fail");
  });

  test("T10d AC6: a covered case with steps and no expectations fails and is reported", () => {
    const q = QUESTIONS.find(x => x.id === "CQ1") as QuestionsNS.Question;
    expect(evaluateQuestion(q, runtime).yes.status).toBe("pass");
    const noExpectations = structuredClone(q);
    noExpectations.yes.expect = [];
    const result = evaluateQuestion(noExpectations, runtime).yes;
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("expectations");
    expect(questionProblems([noExpectations], runtime).some(p => p.startsWith("CQ1 yes:") && p.includes("expectations"))).toBe(true);

    const fewer = structuredClone(q);
    fewer.yes.expect = fewer.yes.expect.slice(0, fewer.yes.steps.length - 1);
    expect(fewer.yes.steps.length).toBeGreaterThan(1);
    expect(evaluateQuestion(fewer, runtime).yes.status).toBe("fail");
    expect(questionProblems([fewer], runtime).length).toBeGreaterThan(0);

    const more = structuredClone(q);
    more.yes.expect = [...more.yes.expect, { rows: [] }];
    expect(evaluateQuestion(more, runtime).yes.status).toBe("fail");
    expect(questionProblems([more], runtime).length).toBeGreaterThan(0);

    const noSteps = structuredClone(q);
    noSteps.yes.steps = [];
    noSteps.yes.expect = [];
    expect(evaluateQuestion(noSteps, runtime).yes.status).toBe("fail");
    expect(questionProblems([noSteps], runtime).some(p => p.includes("covered without a step"))).toBe(true);
  });

  test("T10e AC6: an expectation that asserts nothing fails and is reported; an explicitly empty list is an assertion", () => {
    const q = QUESTIONS.find(x => x.id === "CQ1") as QuestionsNS.Question;
    const nothing: QuestionsNS.Expectation[] = [{}, { noReasons: [] }, { rows: undefined, reasons: undefined, changes: undefined }];
    for (const empty of nothing) {
      const broken = structuredClone(q);
      broken.yes.expect = broken.yes.steps.map(() => ({ ...empty }));
      expect(evaluateQuestion(broken, runtime).yes.status).toBe("fail");
      expect(evaluateQuestion(broken, runtime).yes.detail).toContain("asserts nothing");
      expect(questionProblems([broken], runtime).some(p => p.startsWith("CQ1 yes:") && p.includes("asserts nothing"))).toBe(true);
    }

    const onlyOne = structuredClone(q);
    onlyOne.yes.expect = structuredClone(onlyOne.yes.expect);
    onlyOne.yes.expect[onlyOne.yes.expect.length - 1] = {};
    expect(evaluateQuestion(onlyOne, runtime).yes.status).toBe("fail");
    expect(questionProblems([onlyOne], runtime).length).toBeGreaterThan(0);

    // The falsifier cases of the shipped set rely on explicitly empty lists, which stay valid.
    const q3 = QUESTIONS.find(x => x.id === "CQ3") as QuestionsNS.Question;
    const q7 = QUESTIONS.find(x => x.id === "CQ7") as QuestionsNS.Question;
    const emptyLists = structuredClone(q3);
    emptyLists.no.expect = [{ rows: [] }];
    expect(questionProblems([emptyLists], runtime)).toEqual([]);
    const emptyReasons = structuredClone(q7);
    emptyReasons.no.expect = [{ reasons: [], changes: [] }];
    expect(questionProblems([emptyReasons], runtime)).toEqual([]);
  });

  test("T10f AC6: the shipped set has no problem, and every covered case has one asserting expectation per step", () => {
    expect(questionProblems(QUESTIONS, runtime)).toEqual([]);
    for (const q of QUESTIONS)
      for (const which of ["yes", "no"] as const) {
        const c = q[which];
        if (c.status !== "covered") continue;
        expect(c.steps.length).toBeGreaterThan(0);
        expect(c.expect.length).toBe(c.steps.length);
      }
  });
});

describe("AC7 waivers", () => {
  test("T11 AC7: shipped waivers are empty and every real finding stays open", () => {
    const shipped = readFileSync(join(ROOT, "src", "graph", "vocabulary", "waivers.json"), "utf8");
    expect(parseWaivers(shipped)).toEqual([]);
    expect(reportReal.findings.every(f => f.status === "open")).toBe(true);
  });

  test("T12 AC7: a complete waiver applies; incomplete ones leave the finding open; unknown ids go stale", () => {
    const waivers = parseWaivers(
      JSON.stringify([
        { findingId: "VL5:Treasury", reason: "recorded as the relation to its holding entities", decision: "waive for this release" },
        { findingId: "VL5:Treasury", reason: "second entry without a decision" },
        { findingId: "VL5:Treasury", reason: "   ", decision: "waive" },
        { findingId: "VL9:nothing", reason: "names no current finding", decision: "waive" },
      ]),
    );
    const rep = buildReport({ ...realBase, waivers });
    const f5 = rep.findings.find(f => f.id === "VL5:Treasury");
    expect(f5?.status).toBe("waived");
    expect(rep.waivers.applied.map(w => w.findingId)).toEqual(["VL5:Treasury"]);
    expect(rep.waivers.unanswered.length).toBe(2);
    expect(rep.waivers.stale.map(w => w.findingId)).toEqual(["VL9:nothing"]);
    expect(rep.verdict).toBe("not-conformant");
  });

  test("T13 AC7: malformed waiver text exits 1 with a message and prints no report", async () => {
    for (const text of ["{", '[{"findingId":1}]', '{"findingId":"x"}']) {
      const outs: string[] = [];
      const errs: string[] = [];
      let writes = 0;
      const code = await runCliMain([], {
        waiversText: () => text,
        out: (t: string) => outs.push(t),
        err: (t: string) => errs.push(t),
        writeText: () => {
          writes += 1;
        },
      });
      expect(code).toBe(1);
      expect(outs).toEqual([]);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]?.length).toBeGreaterThan(0);
      expect(writes).toBe(0);
    }
  });
});

describe("AC8 verdict and exit code", () => {
  test("T14 AC8: the base verdict is not-conformant and the CLI exits 1", () => {
    expect(reportReal.verdict).toBe("not-conformant");
    expect(exitCodeOf(reportReal)).toBe(1);
    const spawned = Bun.spawnSync([process.execPath, "run", "src/graph/vocabulary/cli.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(spawned.exitCode).toBe(1);
  });

  test("T15 AC8: waiving every blocking finding conforms and exits 0", async () => {
    const wtext = readFileSync(join(FIX, "waivers-blocking.json"), "utf8");
    const outs: string[] = [];
    const code = await runCliMain([], { waiversText: () => wtext, out: (t: string) => outs.push(t) });
    expect(code).toBe(0);
    const rep = JSON.parse(outs[0] ?? "{}") as ReportNS.Report;
    expect(rep.verdict).toBe("conformant");
    expect(rep.waivers.applied.length).toBe(11);
  });

  test("T16 AC8: one failing case or one open blocking finding breaks conformance", () => {
    const wtext = readFileSync(join(FIX, "waivers-blocking.json"), "utf8");
    const waivers = parseWaivers(wtext);
    const failing = structuredClone(QUESTIONS as unknown as QuestionsNS.Question[]);
    const q1 = failing.find(q => q.id === "CQ1") as QuestionsNS.Question;
    q1.yes.expect = [{ rows: [] }];
    const repFail = buildReport({ ...realBase, questions: failing, waivers });
    expect(repFail.verdict).toBe("not-conformant");
    expect(exitCodeOf(repFail)).toBe(1);
    const repOpen = buildReport({ ...realBase, waivers: waivers.slice(1) });
    expect(repOpen.verdict).toBe("not-conformant");
    expect(exitCodeOf(repOpen)).toBe(1);
  });
});

describe("AC9 determinism", () => {
  test("T17 AC9: repeated runs print identical bytes", async () => {
    const a: string[] = [];
    const b: string[] = [];
    await runCliMain([], { out: (t: string) => a.push(t) });
    await runCliMain([], { out: (t: string) => b.push(t) });
    expect(Buffer.compare(Buffer.from(a[0] ?? ""), Buffer.from(b[0] ?? ""))).toBe(0);
    const s1 = Bun.spawnSync([process.execPath, "run", "src/graph/vocabulary/cli.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const s2 = Bun.spawnSync([process.execPath, "run", "src/graph/vocabulary/cli.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(Buffer.compare(s1.stdout as Buffer, s2.stdout as Buffer)).toBe(0);
  });

  test("T18 AC9: reversed input order prints identical bytes", () => {
    const revRuntime = createQuestionRuntime([...inputs].reverse());
    const revLint = { ...defaultLintInput([...lintSnapshots].reverse()), terms: [...TERMS].reverse() };
    const repRev = buildReport({ lint: revLint, questions: QUESTIONS, runtime: revRuntime, waivers: [] });
    expect(renderReport(repRev)).toBe(renderReport(reportReal));
  });

  test("T19 AC9: the report carries no timestamp, host or absolute path", async () => {
    const os = await import("node:os");
    const text = renderReport(reportReal);
    expect(/T\d\d:\d\d:\d\d/.test(text)).toBe(false);
    expect(text.includes(os.hostname())).toBe(false);
    expect(text.includes(process.cwd())).toBe(false);
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        expect(v.startsWith("/")).toBe(false);
        expect(/^[A-Za-z]:\\/.test(v)).toBe(false);
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    };
    walk(JSON.parse(text));
  });

  test("T20 AC9: the hashes track vocabulary and schema changes, not key order", () => {
    const vocabChanged: Record<string, { class: string }> = { ...vocabCopy(), bond: { class: "state" } };
    const repVocab = buildReport({ ...realBase, lint: { ...realBase.lint, vocabulary: vocabChanged }, waivers: [] });
    expect(repVocab.vocabularySha256).not.toBe(reportReal.vocabularySha256);
    expect(repVocab.schemaSha256).toBe(reportReal.schemaSha256);

    const moved = structuredClone(CORE_TYPES) as Record<string, { class: string; mappedFrom: { predicate: string }[] }>;
    moved["PRICED_BY"].mappedFrom = moved["PRICED_BY"].mappedFrom.filter(m => m.predicate !== "priced-by");
    moved["DEPENDS_ON"].mappedFrom = [...moved["DEPENDS_ON"].mappedFrom, { predicate: "priced-by" }];
    const repMap = buildReport({ ...realBase, lint: { ...realBase.lint, coreTypes: moved as LintNS.LintInput["coreTypes"] }, waivers: [] });
    expect(repMap.schemaSha256).not.toBe(reportReal.schemaSha256);
    expect(repMap.vocabularySha256).toBe(reportReal.vocabularySha256);

    const reorderedVocab = Object.fromEntries(Object.entries(realBase.lint.vocabulary).reverse()) as LintNS.LintInput["vocabulary"];
    const reorderedCore = Object.fromEntries(Object.entries(realBase.lint.coreTypes).reverse()) as LintNS.LintInput["coreTypes"];
    const repOrder = buildReport({ ...realBase, lint: { ...realBase.lint, vocabulary: reorderedVocab, coreTypes: reorderedCore }, waivers: [] });
    expect(repOrder.vocabularySha256).toBe(reportReal.vocabularySha256);
    expect(repOrder.schemaSha256).toBe(reportReal.schemaSha256);
  });
});

async function runDriverTrap(mode: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(FIX, "driver-trap.ts"), mode], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

describe("AC10 offline, read only, publishable", () => {
  test("T21 AC10: no network or driver call while the report and the questions run", async () => {
    const outs: string[] = [];
    await runCliMain([], { out: (t: string) => outs.push(t) });
    evaluateQuestions(QUESTIONS, runtime);
    lint(lintInput);
    expect(Object.values(trapped).every(n => n === 0)).toBe(true);
    expect(outs.length).toBe(1);
  });

  test("T21b AC10: in a separate process the vocabulary module and the report never load or construct the driver", async () => {
    const run = await runDriverTrap("report");
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const summary = JSON.parse(run.stdout) as { mode: string; fired: string[]; printed: number; findings: number };
    expect(summary.mode).toBe("report");
    expect(summary.fired).toEqual([]);
    expect(summary.printed).toBe(1);
    expect(summary.findings).toBe(reportReal.findings.length);
  }, 60000);

  test("T21c AC10: the same process check fails when the driver is constructed on purpose", async () => {
    const run = await runDriverTrap("construct");
    expect(run.exitCode).toBe(1);
    const summary = JSON.parse(run.stdout) as { fired: string[] };
    expect(summary.fired).toEqual(["loaded", "constructed"]);
    const bad = await runDriverTrap("unknown-mode");
    expect(bad.exitCode).toBe(2);
  }, 60000);

  test("T22 AC10: nothing is written unless the output file is named", async () => {
    const written: { path: string; text: string }[] = [];
    const outs: string[] = [];
    await runCliMain([], { out: (t: string) => outs.push(t), writeText: (p: string, t: string) => written.push({ path: p, text: t }) });
    expect(written).toEqual([]);
    await runCliMain(["--out", "sample-report.json"], { out: (t: string) => outs.push(t), writeText: (p: string, t: string) => written.push({ path: p, text: t }) });
    expect(written.length).toBe(1);
    expect(written[0]?.path).toBe("sample-report.json");
    expect(written[0]?.text).toBe(outs[outs.length - 1]);
  });

  test("T23 AC10: module imports stay inside the allowed source set", () => {
    const moduleDir = join(ROOT, "src", "graph", "vocabulary");
    const allowed = [moduleDir, join(ROOT, "src", "engine"), join(ROOT, "src", "graph", "evidence"), join(ROOT, "src", "adapters", "kamino"), join(ROOT, "src", "near")];
    const barred = /(index|neo4j|cli|parity)$/;
    const specRe = [/\b(?:import|export)\b[^"'`;]{0,400}?\bfrom\s*["']([^"']+)["']/g, /^\s*import\s+["']([^"']+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g];
    for (const file of readdirSync(moduleDir)) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(moduleDir, file), "utf8");
      for (const re of specRe)
        for (const m of text.matchAll(re)) {
          const spec = m[1] ?? "";
          if (spec.startsWith("node:")) continue;
          if (!spec.startsWith(".")) throw new Error(`${file}: bare package import ${spec}`);
          const abs = resolve(moduleDir, spec);
          if (!allowed.some(base => abs === base || abs.startsWith(base + sep))) throw new Error(`${file}: import outside the allowed set: ${spec}`);
          if (abs.startsWith(join(ROOT, "src", "graph", "evidence") + sep) && barred.test(abs)) throw new Error(`${file}: barred evidence import: ${spec}`);
        }
    }
  });

  test("T24 AC10: no production file outside the module imports it", () => {
    const moduleDir = join(ROOT, "src", "graph", "vocabulary");
    const specRe = [/\b(?:import|export)\b[^"'`;]{0,400}?\bfrom\s*["']([^"']+)["']/g, /^\s*import\s+["']([^"']+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))].filter(f => !f.startsWith(moduleDir + sep));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const re of specRe)
        for (const m of text.matchAll(re)) {
          const spec = m[1] ?? "";
          if (!spec.startsWith(".")) continue;
          const abs = resolve(join(file, ".."), spec);
          if (abs === moduleDir || abs.startsWith(moduleDir + sep)) throw new Error(`${file}: imports the vocabulary module: ${spec}`);
        }
    }
  });

  test("T25 AC10: this test file imports only the runner, node builtins and source paths", () => {
    const text = readFileSync(import.meta.path, "utf8");
    const specRe = [/\b(?:import|export)\b[^"'`;]{0,400}?\bfrom\s*["']([^"']+)["']/g, /^\s*import\s+["']([^"']+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g];
    for (const re of specRe)
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? "";
        if (!(spec === "bun:test" || spec.startsWith("node:") || spec.startsWith("../src/"))) throw new Error(`unexpected import specifier: ${spec}`);
      }
    // Every dynamic import names its module as a plain string, so the scan above sees all of them.
    expect(/\bimport\s*\(\s*[^"'\s)]/.test(text)).toBe(false);
    expect(/\brequire\s*\(\s*[^"'\s)]/.test(text)).toBe(false);
  });

  test("T26 AC10: no forbidden string, model name or numbered run id in the published files", () => {
    const parts: string[][] = [
      ["AGENTS", ".md"],
      ["CL", "AUDE", ".local", ".md"],
      ["docs", "/", "plans"],
      ["docs", "/", "specs"],
      ["plans", "/", "0"],
      ["graph", "/", "scripts"],
      ["graph", "/", "nodes"],
      ["graph", "/", "runs"],
      ["graph", "/", "artifacts"],
      ["graph", ":", "check"],
      ["graph", ":", "test"],
      ["tsconfig", ".", "graph"],
      ["delegate", "_", "task"],
      ["decision", "-", "log"],
      ["publish", ".", "allowlist"],
      ["linchpin", "-", "dev"],
      ["/Users", "/", "siki"],
    ];
    const needles = parts.map(p => p.join(""));
    const modelNameParts: string[][] = [["cl", "au", "de"], ["gp", "t"], ["gl", "m"], ["son", "net"], ["op", "us"]];
    const modelNames = modelNameParts.map(p => p.join(""));
    const runIdNeedle = ["0", "4", "5", "-"].join("");
    const files = [
      ...readdirSync(join(ROOT, "src", "graph", "vocabulary")).map(f => join(ROOT, "src", "graph", "vocabulary", f)),
      import.meta.path,
      ...readdirSync(FIX).map(f => join(FIX, f)),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const n of needles) if (text.includes(n)) throw new Error(`${file} contains a private needle`);
      const lower = text.toLowerCase();
      for (const n of modelNames) if (lower.includes(n)) throw new Error(`${file} names a model`);
      if (lower.includes(runIdNeedle)) throw new Error(`${file} names the numbered run`);
    }
  });
});
