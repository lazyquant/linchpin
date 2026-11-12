/**
 * Independent tests for the private position review and the shared policy core
 * (development-graph run for the private position review slice).
 *
 * Expectations come from the approved specification (acceptance criteria AC1..AC7 with
 * the V1..V6 amendments), plan 023, the gate-1 decisions (including clarification B1 on
 * the receipt handoff for exported economics), the exported names and signatures of the
 * new modules, the frozen engine contracts, and the bytes of the two recorded public
 * captures under fixtures/kamino. The implementer's report and implementation bodies
 * were not read. All tests run offline: fetch is replaced with a thrower for the whole
 * file, and spawned CLI processes get an unreachable RPC endpoint.
 *
 * Fixture positions are synthetic; no real position data appears in this file.
 * Canary values (a unique position id, quantity, unit and owner-like subject) prove that
 * private data never reaches executor input, the trace, logs, or the public export.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { canonical } from "../src/chain/evidence";
import {
  memoryTraceSink,
  openStore,
  projectForModel,
  runPlan,
  validatePlan,
  validateReview,
  validateSnapshot,
  type EnginePlan,
  type EngineRunOutcome,
  type EngineTraceEvent,
  type EvidenceSnapshot,
  type PrivatePosition,
  type ReviewEnvelope,
  type RunLimits,
  type RunPlanInput,
} from "../src/engine/index";
import {
  GENERIC_RULES,
  PolicyRejected,
  combineOutcomes,
  compareDecimals,
  createGenericRegistry,
  createRuleRegistry,
  evaluatePolicy,
  parsePolicy,
  projectVerdict,
  type Policy,
  type PolicyPosition,
  type RuleKind,
} from "../src/policy/index";
import {
  DEMO_BOOK,
  DEMO_POLICY,
  MAX_QUERIES_PER_PLAN,
  PRIVATE_EXPORT_LABEL,
  PositionRejected,
  ReviewRunFailed,
  buildRoundPlans,
  checkPrivateExportPath,
  economicsFor,
  economicsQuantities,
  exitItemsFor,
  exportJson,
  findBannedWords,
  loadBook,
  loadKaminoEvidence,
  parseBook,
  renderMarkdown,
  reviewPositions,
  runDemo,
  toPublicReview,
  toPublicWatch,
  watchPositions,
  type EconomicsView,
  type PositionEvidence,
  type PositionReport,
  type WatchReport,
} from "../src/review/position/index";
import { engineAccess, queryChains } from "../src/review/position/index";
import { MAX_RELATIONS, VOCABULARY, isTraversalRelation, type EvidenceStore, type QueryRequest } from "../src/engine/index";
import {
  AT,
  EIGHT_DAYS_LATER,
  SEVEN_DAYS_EXACT,
  STALE,
  buildStore,
  citedReceiptIds,
  context,
  exitItem,
  fact,
  position,
  receipt,
  walkJson,
  X,
  Y,
  Z,
} from "./fixtures/private-position-review/support";
import { CONSTRUCTED_ID, NEW_ADMIN, OLD_ADMIN, VAULT_ADMIN_SUBJECT, constructedVaultAdminChange } from "./fixtures/private-position-review/constructed";

// ---------------------------------------------------------------------------
// Offline guarantee: no in-process call may reach the network.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
(globalThis as { fetch: unknown }).fetch = () => {
  fetchCalls += 1;
  throw new Error("network access attempted");
};
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Shared constants and helpers
// ---------------------------------------------------------------------------
const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "fixtures", "kamino");
const CLI = join(ROOT, "src", "cli.ts");
const FIX = join(import.meta.dir, "fixtures", "private-position-review");

const VAULT = "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
const PYUSD = "solana:mainnet-beta:2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const SHARES = "solana:mainnet-beta:DCqyVY1SFCwq8unnexv9pjujVAC7jsmjfoUWBrNLvbY";
const RESERVE_2GC9 = "solana:mainnet-beta:2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN";
const RESERVE_92QE = "solana:mainnet-beta:92qeAka3ZzCGPfJriDXrE7tiNqfATVCAM6ZjjctR3TrS";
const ORACLE = "solana:mainnet-beta:3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";
const ADMIN_7FLX = "solana:mainnet-beta:7fLxEftpppneavpueYgP2s7HhSGbWpj2jTCmAEwwqonY";
const CONTROLLER_24LJ = "solana:mainnet-beta:24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT";

const evidence = loadKaminoEvidence(FIXTURES);
const A = evidence.snapshots[0]!;
const B = evidence.snapshots[1]!;
/** Observed-to of the later capture: the pinned evaluation instant for the demo. */
const B_ASOF = "2026-11-09T17:04:20.763Z";
/** Observed-to of the earlier capture. */
const A_ASOF = "2026-11-09T16:34:18.768Z";

const CANARY_ID = "canary-pos-Q7ZK3";
const CANARY_QUANTITY = "424242.000913";
const CANARY_UNIT = "canaryunitW9XV";
const CANARY_OWNER = "CANARYownerWa11et";
/** A 42-character base58 owner-like subject (no 0, O, I or l). */
const CANARY_OWNER_SUBJECT = `solana:mainnet-beta:${CANARY_OWNER}Abcdefghijkmnopqrstuvwxyz`;
const CANARIES = [CANARY_ID, CANARY_QUANTITY, CANARY_UNIT, CANARY_OWNER];

const tempDirs: string[] = [];
function tempDir(prefix = "linchpin-pos-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function bookEntry(overrides: Partial<PrivatePosition> = {}): PrivatePosition {
  return {
    id: "vault-1",
    subject: VAULT,
    quantity: "1250.000000",
    unit: SHARES,
    snapshotId: "book-1",
    source: "manual",
    fixtureKind: "synthetic",
    ...overrides,
  };
}

/** Spawn the CLI the way an operator would, in a fresh working directory. */
function cli(args: string[], cwd: string) {
  const result = Bun.spawnSync([process.execPath, CLI, "position", ...args], {
    cwd,
    env: { ...process.env, LINCHPIN_RPC_URL: "http://127.0.0.1:1" },
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function reviewWith(book: readonly PrivatePosition[], options: {
  policy?: Policy | null;
  asOf?: string;
  engine?: { execute?: (input: RunPlanInput) => Promise<EngineRunOutcome>; trace?: ReturnType<typeof memoryTraceSink> };
  bookSnapshotId?: string;
  evidence?: PositionEvidence;
} = {}): Promise<PositionReport> {
  return reviewPositions({
    evidence: options.evidence ?? evidence,
    book,
    bookSnapshotId: options.bookSnapshotId ?? "book-1",
    snapshotId: B.id,
    asOf: options.asOf ?? B_ASOF,
    policy: options.policy ?? null,
    engine: options.engine,
  });
}

interface SpyEngine {
  engine: { execute: (input: RunPlanInput) => Promise<EngineRunOutcome>; trace: ReturnType<typeof memoryTraceSink> };
  inputs: { plan: EnginePlan; limits: RunLimits; blueprintId: string; store: RunPlanInput["store"] }[];
  envelopes: ReviewEnvelope[];
  nodeCounts: number[];
  statuses: string[];
  sink: ReturnType<typeof memoryTraceSink>;
}

/** A spy execute that records every plan input, then delegates to the real executor. */
function spyEngine(sink = memoryTraceSink()): SpyEngine {
  const spy: SpyEngine = {
    engine: { execute: async () => { throw new Error("not wired"); }, trace: sink },
    inputs: [],
    envelopes: [],
    nodeCounts: [],
    statuses: [],
    sink,
  };
  const execute = async (input: RunPlanInput): Promise<EngineRunOutcome> => {
    const plan = structuredClone(input.plan) as EnginePlan;
    spy.inputs.push({ plan, limits: { ...input.limits }, blueprintId: input.blueprintId, store: input.store });
    spy.nodeCounts.push(plan.nodes.length - 1);
    const outcome = await runPlan(input);
    spy.statuses.push(outcome.status);
    if (outcome.status === "succeeded") spy.envelopes.push(outcome.envelope);
    return outcome;
  };
  spy.engine.execute = execute;
  return spy;
}

function canaryBook(): PrivatePosition[] {
  return [
    bookEntry({ id: CANARY_ID, quantity: CANARY_QUANTITY, unit: CANARY_UNIT }),
    bookEntry({ id: "canary-owner-link", subject: CANARY_OWNER_SUBJECT, quantity: "7", unit: CANARY_UNIT }),
  ];
}

function assertNoCanaries(text: string, where: string): void {
  for (const canary of CANARIES) expect({ where, canary, found: text.includes(canary) }).toEqual({ where, canary, found: false });
}

function containsZeroValuation(value: unknown): boolean {
  let found = false;
  walkJson(value, (node, path) => {
    if (path.at(-1) === "valuation") {
      const v = node as { value?: unknown } | null;
      if (v && (v.value === 0 || v.value === "0")) found = true;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// AC1 — private inventory
// ---------------------------------------------------------------------------
describe("AC1 private inventory", () => {
  test("T1.1 default book path", () => {
    const cwd = tempDir();
    writeJson(join(cwd, ".private", "book.json"), [bookEntry()]);
    const result = cli(["review", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out")], cwd);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "out", "position-review.public.json"))).toBe(true);
    expect(existsSync(join(cwd, "out", "position-review.public.md"))).toBe(true);
  });

  test("T1.2 --book override", () => {
    const cwd = tempDir();
    writeJson(join(cwd, "other.json"), [bookEntry()]);
    const result = cli(["review", "--book", join(cwd, "other.json"), "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out")], cwd);
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, "out", "position-review.public.json"))).toBe(true);
  });

  test("T1.3 missing book", () => {
    const cwd = tempDir();
    const result = cli(["review", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out")], cwd);
    expect(result.code).toBe(2);
    expect(result.err).toContain("book not found");
    expect(existsSync(join(cwd, "out", "position-review.public.json"))).toBe(false);
  });

  test("T1.4 exact decimals", () => {
    for (const quantity of ["0", "1250.000000", "0.000001"]) expect(parseBook([bookEntry({ quantity })])).toHaveLength(1);
    for (const quantity of [1250, "1e3", "-1", "01", "1.", ".5", "1,000"]) {
      let code: string | null = null;
      try {
        parseBook([bookEntry({ quantity } as Partial<PrivatePosition>)]);
      } catch (error) {
        code = (error as { code?: string }).code ?? null;
      }
      expect({ quantity, code }).toEqual({ quantity, code: "malformed-quantity" });
    }
  });

  test("T1.5 exact keys", () => {
    const extra = () => {
      try {
        parseBook([{ ...bookEntry(), owner: "nobody" }]);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? null;
      }
    };
    const missing = () => {
      const { unit: _unit, ...rest } = bookEntry();
      try {
        parseBook([rest]);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? null;
      }
    };
    expect(extra()).toBe("unexpected-field");
    expect(missing()).toBe("missing-field");
  });

  test("T1.6 identity, not names", () => {
    let code: string | null = null;
    try {
      parseBook([bookEntry({ subject: "Sentora PYUSD" })]);
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe("malformed-subject");
    expect(parseBook([bookEntry({ subject: "near:mainnet:contract.main.burrow.near" })])).toHaveLength(1);
  });

  test("T1.7 no guessed ownership", () => {
    let code: string | null = null;
    try {
      parseBook([bookEntry({ source: "reader" })]);
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe("unsupported-source");
  });

  test("T1.8 duplicates", () => {
    let code: string | null = null;
    try {
      parseBook([bookEntry(), bookEntry()]);
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe("duplicate-position");
    expect(parseBook([bookEntry(), bookEntry({ snapshotId: "book-2" })])).toHaveLength(2);
  });

  test("T1.9 location guard", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeJson(join(root, "books", "real.json"), [bookEntry({ fixtureKind: "real-private" })]);
    writeJson(join(root, ".private", "real.json"), [bookEntry({ fixtureKind: "real-private" })]);
    writeJson(join(root, "books", "synthetic.json"), [bookEntry()]);
    let code: string | null = null;
    try {
      await loadBook(join(root, "books", "real.json"));
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe("real-book-in-repository");
    await expect(loadBook(join(root, ".private", "real.json"))).resolves.toHaveLength(1);
    await expect(loadBook(join(root, "books", "synthetic.json"))).resolves.toHaveLength(1);
  });

  test("T1.10 ignored locally", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(ignore.split("\n").some((line) => line.trim() === ".private/" || line.trim() === ".private")).toBe(true);
    const result = Bun.spawnSync(["git", "check-ignore", "-q", ".private/book.json"], { cwd: ROOT });
    expect(result.exitCode).toBe(0);
  });

  test("T1.11 no import path", () => {
    const cwd = tempDir();
    const unknown = cli(["review", "--import", "x.csv", "--fixtures", FIXTURES], cwd);
    expect(unknown.code).toBe(2);
    const csvPath = join(cwd, "positions.csv");
    writeFileSync(csvPath, "SECRETCSVBYTES,subject,quantity\n", "utf8");
    const csv = cli(["review", "--book", csvPath, "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out")], cwd);
    expect(csv.code).toBe(2);
    expect(csv.err).toContain("malformed-json");
    expect(csv.err).not.toContain("SECRETCSVBYTES");
    expect(existsSync(join(cwd, "out", "position-review.public.json"))).toBe(false);
  });

  test("T1.12 provenance kept", () => {
    const cwd = tempDir();
    writeJson(join(cwd, ".private", "book.json"), [bookEntry()]);
    const priv = join(cwd, "private.json");
    const result = cli(["review", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out"), "--private-export", priv], cwd);
    expect(result.code).toBe(0);
    const report = readJson(priv);
    expect(report.privacy).toBe("private");
    expect(report.label).toBe("PRIVATE LOCAL EXPORT: contains position data; keep local, do not commit or publish");
    expect(PRIVATE_EXPORT_LABEL).toBe("PRIVATE LOCAL EXPORT: contains position data; keep local, do not commit or publish");
    const entry = report.positions[0].position;
    expect(entry).toMatchObject({ snapshotId: "book-1", source: "manual", quantity: "1250.000000" });
  });
});

// ---------------------------------------------------------------------------
// AC2 — local join
// ---------------------------------------------------------------------------
describe("AC2 local join", () => {
  test("T2.1 covered by exact identity", async () => {
    const report = await reviewWith([bookEntry()]);
    const joined = report.positions[0]!;
    expect(joined.coverage).toBe("covered");
    expect(joined.coverageReason).toBeNull();
    const chain = joined.chain!;
    expect(chain.snapshotId).toBe(B.id);
    expect(chain.constructed).toBe(false);
    expect(chain.subjects).toHaveLength(26);
    expect(chain.dependencyFacts).toHaveLength(40);
    expect(chain.controlFacts).toHaveLength(16);
    expect(chain.stateFacts).toHaveLength(15);
    expect(chain.receipts).toHaveLength(26);
    expect(chain.controllers).toHaveLength(4);
    for (const controller of [CONTROLLER_24LJ, ADMIN_7FLX]) expect(chain.controllers).toContain(controller);
    expect(chain.oracleSources).toEqual([ORACLE]);
    expect(economicsFor(evidence.reports.get(B.id), VAULT)).not.toBeNull();
  });

  test("T2.2 near misses", async () => {
    const lower = VAULT.toLowerCase();
    const devnet = `solana:devnet:${VAULT.split(":").pop()}`;
    const report = await reviewWith([bookEntry({ subject: lower }), bookEntry({ id: "devnet-1", subject: devnet })]);
    expect(report.positions).toHaveLength(2);
    for (const joined of report.positions) {
      expect(joined.coverage).toBe("unknown");
      expect(joined.coverageReason).toBe("subject-not-in-snapshot");
      expect(joined.chain).toBeNull();
      expect(joined.economics).toBeNull();
    }
    expect(report.totals.covered).toBe(0);
    expect(report.totals.unknownCoverage).toBe(2);
  });

  test("T2.3 other chain", async () => {
    const report = await reviewWith([bookEntry({ subject: "near:mainnet:wrap.near", unit: "near:mainnet:wrap.near" })]);
    expect(report.positions[0]!.coverage).toBe("unknown");
    expect(report.positions[0]!.coverageReason).toBe("chain-not-supported");
    expect(report.positions[0]!.chain).toBeNull();
  });

  test("T2.4 totals keep unknowns", async () => {
    const report = await reviewWith([
      bookEntry(),
      bookEntry({ id: "uncovered-1", subject: "solana:mainnet-beta:11111111111111111111111111111111", quantity: "0.5" }),
      bookEntry({ id: "near-1", subject: "near:mainnet:wrap.near", quantity: "3", unit: "near:mainnet:wrap.near" }),
    ]);
    expect(report.totals).toMatchObject({ positions: 3, covered: 1, unknownCoverage: 2 });
    const byUnit = new Map(report.totals.byUnit.map((row) => [row.unit, row]));
    expect(byUnit.get(SHARES)).toEqual({ unit: SHARES, total: "1250.5", covered: "1250", unknownCoverage: "0.5" });
    expect(byUnit.get("near:mainnet:wrap.near")).toEqual({ unit: "near:mainnet:wrap.near", total: "3", covered: "0", unknownCoverage: "3" });
    expect(report.positions).toHaveLength(3);
  });

  test("T2.5 covered, no economics", async () => {
    const policy: Policy = { policyId: "synthetic-policy", subjects: [RESERVE_2GC9], rules: [{ id: "exit-evidence", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }] };
    const report = await reviewWith([bookEntry({ id: "reserve-1", subject: RESERVE_2GC9 })], { policy });
    const joined = report.positions[0]!;
    expect(joined.coverage).toBe("covered");
    expect(joined.chain).not.toBeNull();
    expect(joined.economics).toBeNull();
    expect(joined.economicsReason).toBe("no-economics-source");
    expect(report.verdict!.rules[0]!.outcome).toBe("undetermined");
    expect(report.verdict!.rules[0]!.reasons.map((reason) => reason.code)).toContain("missing-exit-evidence");
    expect(economicsFor(evidence.reports.get(B.id), RESERVE_2GC9)).toBeNull();
  });

  test("T2.6 executor input carries public identities only", async () => {
    const spy = spyEngine();
    await reviewWith(canaryBook(), { engine: spy.engine });
    const publicSubjects = new Set(B.subjects);
    for (const input of spy.inputs) {
      expect(input.blueprintId).toBe("position-review-v1");
      for (const node of input.plan.nodes) {
        const subject = (node.input.subject as { literal?: unknown } | undefined)?.literal;
        if (typeof subject === "string") expect(publicSubjects.has(subject)).toBe(true);
      }
      for (const canary of CANARIES) {
        expect(canonical({ plan: input.plan, limits: input.limits, blueprintId: input.blueprintId })).not.toContain(canary);
        for (const snapshot of evidence.snapshots) expect(canonical((input.store as PositionEvidence["store"]).snapshot(snapshot.id))).not.toContain(canary);
      }
    }
  });

  test("T2.7 executor rounds", async () => {
    const spy = spyEngine();
    const report = await reviewWith([bookEntry()], { engine: spy.engine });
    expect(spy.statuses).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(spy.nodeCounts).toEqual([1, 22, 4, 26]);
    for (const input of spy.inputs) expect(validatePlan(input.plan, input.limits).ok).toBe(true);
    expect(spy.sink.events).toHaveLength(118);
    const byRun = new Map<string, number[]>();
    for (const event of spy.sink.events) byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event.sequence]);
    expect(byRun.size).toBe(4);
    for (const sequences of byRun.values()) expect([...sequences].sort((a, b) => a - b)).toEqual(sequences.map((_, i) => i + 1));
    for (const envelope of spy.envelopes) {
      expect(validateReview(envelope)).toEqual({ ok: true });
      expect(envelope.review.policy).toBe("not-evaluated");
    }
    expect(spy.envelopes[0]!.review.claims).toHaveLength(40);
    expect(report.runs).toHaveLength(4);
  });

  test("T2.8 the gate and batching", async () => {
    const requests = Array.from({ length: 40 }, () => ({ name: "control" as const, subject: VAULT, scope: { asOf: B_ASOF, snapshotId: B.id, maxHops: 1, maxResults: 500 } }));
    const plans = buildRoundPlans(requests);
    expect(plans).toHaveLength(2);
    expect(plans.map((entry) => entry.plan.nodes.length - 1)).toEqual([31, 9]);
    for (const entry of plans) expect(validatePlan(entry.plan, entry.limits).ok).toBe(true);
    expect(MAX_QUERIES_PER_PLAN).toBe(31);
    const failing = async (): Promise<EngineRunOutcome> => ({ status: "rejected", runId: "run", code: "limit-exceeded", nodeId: null, dispatched: 0, accounting: { planned: null, queryCalls: 0, renderCalls: 0, modelTokens: null } });
    let thrown: unknown = null;
    try {
      await reviewWith([bookEntry()], { engine: { execute: failing, trace: memoryTraceSink() } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReviewRunFailed);
    expect((thrown as Error).message).toBe("executor rejected limit-exceeded");
  });

  test("T2.8b CLI fails closed on a failed executor run", () => {
    const cwd = tempDir();
    writeJson(join(cwd, ".private", "book.json"), [bookEntry()]);
    mkdirSync(join(cwd, "trace-dir"), { recursive: true });
    const result = cli(["review", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out"), "--trace", join(cwd, "trace-dir")], cwd);
    expect(result.code).toBe(1);
    expect(result.err).toContain("ReviewRunFailed: executor failed");
    expect(existsSync(join(cwd, "out", "position-review.public.json"))).toBe(false);
    expect(existsSync(join(cwd, "out", "position-review.public.md"))).toBe(false);
  });

  test("T2.9 trace file", () => {
    const cwd = tempDir();
    writeJson(join(cwd, ".private", "book.json"), [bookEntry()]);
    const tracePath = join(cwd, "t.jsonl");
    const result = cli(["review", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out"), "--trace", tracePath], cwd);
    expect(result.code).toBe(0);
    expect(statSync(tracePath).mode & 0o777).toBe(0o600);
    const lines = readFileSync(tracePath, "utf8").split("\n").filter((line) => line.trim());
    expect(lines).toHaveLength(118);
    const requiredKeys = ["runId", "sequence", "nodeId", "phase", "inputSha256", "registrySha256", "blueprintSha256", "modelId", "actualTokens", "acceptedEvidenceIds", "rejectedSourceIds"] as const;
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown> & EngineTraceEvent;
      for (const key of requiredKeys) expect({ key, present: Object.hasOwn(event, key) }).toEqual({ key, present: true });
    }
    const inside = tempDir();
    mkdirSync(join(inside, ".git"), { recursive: true });
    const blockedPath = join(inside, "t.jsonl");
    const blocked = cli(["review", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(inside, "out"), "--trace", blockedPath], inside);
    expect(blocked.code).toBe(2);
    expect(existsSync(blockedPath)).toBe(false);
  });

  test("T2.10 deterministic plans", async () => {
    const first = await reviewWith([bookEntry()]);
    const second = await reviewWith([bookEntry()]);
    expect(first.runs.map((run) => run.planSha256)).toEqual(second.runs.map((run) => run.planSha256));
    const firstJson = exportJson(toPublicReview(first));
    const secondJson = exportJson(toPublicReview(second));
    expect(firstJson).toBe(secondJson);
    expect(firstJson).not.toContain("runId");
  });
});

// ---------------------------------------------------------------------------
// AC3 — economics and exit
// ---------------------------------------------------------------------------
/** Window map for the 13 reported metrics, from the recorded capture facts. */
const reportedWindows: Record<string, string> = {
  apy: "current",
  apyTheoretical: "current",
  apyActual: "current",
  apyFarmRewards: "current",
  apyIncentives: "current",
  apyReservesIncentives: "current",
  apy24h: "24h",
  apy7d: "7d",
  apy14d: "14d",
  apy30d: "30d",
  apy90d: "90d",
  apy180d: "180d",
  apy365d: "365d",
};

async function vaultReport(policy: Policy | null = null): Promise<PositionReport> {
  return reviewWith([bookEntry()], { policy });
}

describe("AC3 economics and exit", () => {
  test("T3.1 rates and the receipt handoff (clarification B1)", async () => {
    const report = await vaultReport(DEMO_POLICY);
    const economics = report.positions[0]!.economics!;
    const reported = economics.rates.filter((quantity) => quantity.basis === "reported");
    expect(reported).toHaveLength(13);
    for (const quantity of reported) {
      const key = quantity.name.replace("vault.reported.", "");
      expect({ key, window: quantity.window }).toEqual({ key, window: reportedWindows[key] });
      expect(quantity.unit).toBe("ratio");
      expect(quantity.evidenceIds.length).toBeGreaterThanOrEqual(1);
    }
    expect(economics.rates.find((quantity) => quantity.name === "vault.reported.apy7d")!.value).toBe("0.0678795855554443365");
    // Every receipt cited by any exported economics quantity must resolve in the export.
    const exported = toPublicReview(report);
    const subject = exported.subjects.find((entry) => entry.subject === VAULT)!;
    const receiptIds = new Set(subject.receipts.map((entry) => entry.id));
    for (const quantity of economicsQuantities(economics)) {
      for (const id of quantity.evidenceIds) expect({ id, present: receiptIds.has(id) }).toEqual({ id, present: true });
    }
    for (const id of citedReceiptIds(economics)) expect({ id, present: receiptIds.has(id) }).toEqual({ id, present: true });
    // The per-subject export receipt list is exactly chain receipts plus economics receipts.
    const union = new Set([...report.positions[0]!.chain!.receipts.map((entry) => entry.id), ...report.economicsReceipts.map((entry) => entry.id)]);
    expect(subject.receipts.map((entry) => entry.id)).toEqual([...union].sort());
    // The chain receipts themselves stay the executor-returned 26.
    expect(report.positions[0]!.chain!.receipts).toHaveLength(26);
    expect(report.economicsReceipts.length).toBeGreaterThan(0);
  });

  test("T3.2 yield source", async () => {
    const report = await vaultReport();
    const economics = report.positions[0]!.economics!;
    expect(economics.yieldSource.kind).toBe("lending-reserve-allocation");
    expect(economics.yieldSource.allocations).toHaveLength(7);
    expect(economics.yieldSource.allocations.find((quantity) => quantity.subject === RESERVE_92QE)!.value).toBe("411516");
    expect(economics.yieldSource.rewards.map((quantity) => quantity.name)).toContain("vault.reported.apyFarmRewards");
  });

  test("T3.3 idle", async () => {
    const report = await vaultReport();
    const idle = report.positions[0]!.economics!.idle;
    const tokenAvailable = idle.find((quantity) => quantity.name === "vault.tokenAvailable")!;
    expect(tokenAvailable.value).toBe("40698887857");
    expect(tokenAvailable.unit).toBe("token-base-units");
    expect(tokenAvailable.decimals).toBe(6);
    expect(tokenAvailable.mint).toBe(PYUSD);
    expect(idle.find((quantity) => quantity.name === "vault.idleSharePpm")!.value).toBe("404");
  });

  test("T3.4 liquidity and constraints", async () => {
    const report = await vaultReport();
    const economics = report.positions[0]!.economics!;
    expect(economics.liquidity).toHaveLength(7);
    expect(economics.withdrawalConstraints).toHaveLength(10);
    expect(economics.withdrawalConstraints.filter((quantity) => quantity.window === "86400s")).toHaveLength(7);
    for (const name of ["vault.minWithdrawAmount", "vault.withdrawalPenaltyBps", "vault.withdrawalPenaltyLamports"]) {
      expect(economics.withdrawalConstraints.map((quantity) => quantity.name)).toContain(name);
    }
    expect(economics.queue).toEqual({ status: "not-captured" });
    expect(economics.missing).toEqual(["LendingMarket.emergencyCouncil", "LendingMarket.proposerAuthority", "VaultState.pendingAdmin", "farms", "withdrawal-queue"]);
    expect(economics.notComputed).toEqual(["exit-capacity", "guaranteed-return", "interest-accrued-since-last-refresh"]);
  });

  test("T3.5 utilization apart", async () => {
    const report = await vaultReport();
    const economics = report.positions[0]!.economics!;
    expect(economics.utilization.label).toBe("utilization: borrowed share of reserve supply; not exit liquidity");
    expect(economics.utilization.items).toHaveLength(7);
    const exit = exitItemsFor(economics, report.positions[0]!.chain!.stateFacts);
    expect(exit).toHaveLength(25);
    expect(exit.filter((item) => item.role === "utilization")).toHaveLength(7);
    expect(exit.filter((item) => item.role === "idle")).toHaveLength(1);
    expect(exit.filter((item) => item.role === "available-liquidity")).toHaveLength(7);
    expect(exit.filter((item) => item.role === "withdrawal-constraint")).toHaveLength(10);
    expect(exit.filter((item) => item.role === "withdrawal-constraint").every((item) => item.factIds.length === 0 && item.receiptIds.length > 0)).toBe(true);
  });

  test("T3.6 utilization is not exit liquidity", () => {
    const store = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [] }]);
    const registry = createGenericRegistry();
    const target = position({ exit: [exitItem("utilization", X, ["r1"])] });
    const policy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "exit-evidence", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }] };
    const verdict = evaluatePolicy(policy, store, context({ positions: [target], registry }));
    expect(verdict.rules[0]!.outcome).toBe("undetermined");
    expect(verdict.rules[0]!.reasons.map((reason) => reason.code)).toContain("utilization-only");
  });

  test("T3.7 missing price is not zero", async () => {
    const report = await vaultReport();
    const economics = report.positions[0]!.economics!;
    expect(economics.valuation).toEqual({ value: null, reason: "missing-price" });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("unknown (missing price)");
    expect(containsZeroValuation(economics)).toBe(false);
    expect(containsZeroValuation(toPublicReview(report))).toBe(false);
    expect(containsZeroValuation(JSON.parse(exportJson(toPublicReview(report))))).toBe(false);
  });

  test("T3.8 claim kept", async () => {
    const report = await vaultReport();
    const claims = report.positions[0]!.economics!.claims;
    expect(claims[0]!.id).toBe("kamino-docs-typical-buffer-share");
    expect(claims[0]!.result).toBe("below-claimed-range");
    expect(claims[0]!.scope).toBe("documented typical vault, not this vault's policy");
  });
});

// ---------------------------------------------------------------------------
// AC4 — two kinds of change
// ---------------------------------------------------------------------------
/** The 11 A→B state-change keys inside the vault's closure, from the recorded captures. */
const A_TO_B_KEYS = [
  "solana:mainnet-beta:2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN|AVAILABLE_LIQUIDITY_RAW",
  "solana:mainnet-beta:2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN|BORROWED_RAW",
  "solana:mainnet-beta:3ZUAwhEtK8XWfK4fy98z4yoptm4GeyeAu21L11HPXaZ5|BORROWED_RAW",
  "solana:mainnet-beta:6A8D3ExQ4CdiZTBmij7MScUeKsgs6mSHksYzJbiY61FM|BORROWED_RAW",
  "solana:mainnet-beta:6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC|BORROWED_RAW",
  "solana:mainnet-beta:92qeAka3ZzCGPfJriDXrE7tiNqfATVCAM6ZjjctR3TrS|AVAILABLE_LIQUIDITY_RAW",
  "solana:mainnet-beta:92qeAka3ZzCGPfJriDXrE7tiNqfATVCAM6ZjjctR3TrS|BORROWED_RAW",
  "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK|IDLE_RAW",
  "solana:mainnet-beta:FswUCVjvfAuzHCgPDF95eLKscGsLHyJmD6hzkhq26CLe|AVAILABLE_LIQUIDITY_RAW",
  "solana:mainnet-beta:FswUCVjvfAuzHCgPDF95eLKscGsLHyJmD6hzkhq26CLe|BORROWED_RAW",
  "solana:mainnet-beta:J11HELuMrLs4WywWHpwoagqT5NMgHTGqCexKjrhM1PuU|BORROWED_RAW",
];

type DependencyChangedEvent = Extract<WatchReport["events"][number], { kind: "dependency-changed" }>;

function watchWith(book: readonly PrivatePosition[], options: {
  bookBefore?: string;
  bookAfter?: string;
  before?: string;
  after?: string;
  evidence?: PositionEvidence;
  engine?: { execute?: (input: RunPlanInput) => Promise<EngineRunOutcome>; trace?: ReturnType<typeof memoryTraceSink> };
} = {}): Promise<WatchReport> {
  return watchPositions({
    evidence: options.evidence ?? evidence,
    book,
    bookBefore: options.bookBefore ?? "book-1",
    bookAfter: options.bookAfter ?? "book-1",
    before: options.before ?? A.id,
    after: options.after ?? B.id,
    engine: options.engine,
  });
}

describe("AC4 two kinds of change", () => {
  test("T4.1 real dependency change", async () => {
    const watched = await watchWith([bookEntry()]);
    expect(watched.events).toHaveLength(1);
    expect(watched.events.filter((entry) => entry.kind === "position-changed")).toHaveLength(0);
    const event = watched.events[0] as DependencyChangedEvent;
    expect(event.kind).toBe("dependency-changed");
    expect(event.subject).toBe(VAULT);
    expect(event.changes).toHaveLength(11);
    expect(event.changes.map((change) => change.key)).toEqual([...A_TO_B_KEYS].sort());
    for (const change of event.changes) expect(["idle", "available-liquidity", "utilization-input"]).toContain(change.role as string);
    const idle = event.changes.find((change) => change.key === `${VAULT}|IDLE_RAW`)!;
    expect(idle.beforeObject).toBe("amount:40973615178");
    expect(idle.afterObject).toBe("amount:40698887857");
    expect(idle.evidenceIds.length).toBeGreaterThan(0);
    expect(event.beforeSnapshotId).toBe(A.id);
    expect(event.afterSnapshotId).toBe(B.id);
    expect(event.constructed).toBe(false);
    expect(event.label).toBe("observed between two recorded captures");
    expect(watched.runs).toHaveLength(7);
    expect(watched.runs.at(-1)!.claims.filter((claim) => claim.template === "change")).toHaveLength(11);
  });

  test("T4.1b watch executor runs all succeed", async () => {
    const spy = spyEngine();
    await watchWith([bookEntry()], { engine: spy.engine });
    expect(spy.statuses).toEqual(Array(7).fill("succeeded"));
    expect(spy.nodeCounts).toEqual([1, 22, 4, 1, 22, 4, 26]);
    for (const input of spy.inputs) expect(validatePlan(input.plan, input.limits).ok).toBe(true);
  });

  test("T4.2 identical", async () => {
    const watched = await watchWith([bookEntry()], { before: B.id, after: B.id });
    expect(watched.events).toEqual([]);
    const cwd = tempDir();
    writeJson(join(cwd, ".private", "book.json"), [bookEntry()]);
    const result = cli(["watch", "--before", B.id, "--after", B.id, "--fixtures", FIXTURES, "--out", join(cwd, "out")], cwd);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.trim()) as { events: unknown[] };
    expect(parsed.events).toEqual([]);
  });

  test("T4.3 position only", async () => {
    const book = [bookEntry({ quantity: "1250.000000", snapshotId: "b1" }), bookEntry({ quantity: "1300.5", snapshotId: "b3" })];
    const watched = await watchWith(book, { bookBefore: "b1", bookAfter: "b3", before: B.id, after: B.id });
    expect(watched.events).toHaveLength(1);
    const event = watched.events[0]!;
    expect(event.kind).toBe("position-changed");
    expect(watched.events.filter((entry) => entry.kind === "dependency-changed")).toHaveLength(0);
    expect(event.kind === "position-changed" && event.changes).toEqual([{ field: "quantity", before: "1250.000000", after: "1300.5" }]);
  });

  test("T4.4 same value, other spelling", async () => {
    expect(compareDecimals("1250.000000", "1250")).toBe(0);
    const book = [bookEntry({ quantity: "1250.000000", snapshotId: "b1" }), bookEntry({ quantity: "1250", snapshotId: "b3" })];
    const watched = await watchWith(book, { bookBefore: "b1", bookAfter: "b3", before: B.id, after: B.id });
    expect(watched.events).toEqual([]);
  });

  test("T4.5 both at once", async () => {
    const book = [bookEntry({ quantity: "1250.000000", snapshotId: "b1" }), bookEntry({ quantity: "1300.5", snapshotId: "b3" })];
    const watched = await watchWith(book, { bookBefore: "b1", bookAfter: "b3" });
    expect(watched.events).toHaveLength(2);
    expect(watched.events.filter((event) => event.kind === "position-changed")).toHaveLength(1);
    expect(watched.events.filter((event) => event.kind === "dependency-changed")).toHaveLength(1);
  });

  test("T4.6 presence", async () => {
    const book = [bookEntry({ snapshotId: "b1" }), bookEntry({ id: "p2", quantity: "2", snapshotId: "b3" })];
    const watched = await watchWith(book, { bookBefore: "b1", bookAfter: "b3", before: B.id, after: B.id });
    const event = watched.events.find((entry) => entry.kind === "position-changed");
    expect(event && event.kind === "position-changed" ? event.changes : null).toEqual([{ field: "presence", before: "absent", after: "present" }]);
  });

  test("T4.7 constructed control change", async () => {
    const constructed = constructedVaultAdminChange(B);
    const constructedEvidence: PositionEvidence = { store: openStore([A, B, constructed]), snapshots: [A, B, constructed], reports: new Map() };
    const spy = spyEngine();
    const watched = await watchWith([bookEntry()], { before: B.id, after: constructed.id, evidence: constructedEvidence, engine: spy.engine });
    expect(spy.statuses).toEqual(Array(7).fill("succeeded"));
    for (const input of spy.inputs) expect(input.blueprintId).toBe("position-review-v1");
    expect(watched.events).toHaveLength(1);
    const event = watched.events[0] as DependencyChangedEvent;
    expect(event.kind).toBe("dependency-changed");
    expect(event.changes).toHaveLength(1);
    const change = event.changes[0]!;
    expect(change.key).toBe(`${VAULT_ADMIN_SUBJECT}|VAULT_ADMIN`);
    expect(change.kind).toBe("changed");
    expect(change.role).toBe("control");
    expect(change.beforeObject).toBe(OLD_ADMIN);
    expect(change.afterObject).toBe(NEW_ADMIN);
    expect(event.constructed).toBe(true);
    expect(event.label).toBe("constructed: not an observed historical change");
  });

  test("T4.8 constructed fixture is honest", () => {
    const constructed = constructedVaultAdminChange(B);
    const validated = validateSnapshot(structuredClone(constructed)) as EvidenceSnapshot;
    expect(validated.constructed).toBe(true);
    expect(validated.id).toBe(CONSTRUCTED_ID);
    for (const stored of validated.receipts) expect(stored.observation.historicalState).toBe("constructed");
    for (const stored of validated.facts) expect(stored.validFrom).toBe(constructed.observedFrom);
    const recorded = new Set([...A.receipts, ...B.receipts].map((entry) => entry.id));
    const recordedFacts = new Set([...A.facts, ...B.facts].map((entry) => entry.id));
    for (const stored of validated.receipts) expect(recorded.has(stored.id)).toBe(false);
    for (const stored of validated.facts) expect(recordedFacts.has(stored.id)).toBe(false);
    expect(constructed.observedFrom).toBe(B.observedFrom);
    expect(constructed.observedTo).toBe(B.observedTo);
    expect(constructed.fromBlockOrSlot).toBe(B.fromBlockOrSlot);
    expect(constructed.toBlockOrSlot).toBe(B.toBlockOrSlot);
    expect(() => openStore([A, B, constructed])).not.toThrow();
  });

  test("T4.9 public watch", async () => {
    const book = [bookEntry({ id: "p1" }), bookEntry({ id: "p2" })];
    const watched = await watchWith(book);
    expect(watched.events.filter((event) => event.kind === "dependency-changed")).toHaveLength(2);
    const projected = toPublicWatch(watched);
    expect(projected.events).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toContain("positionId");
    expect(JSON.stringify(projected)).not.toContain("position-changed");
    expect(projected.events.every((event) => event.kind === "dependency-changed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5 — three-outcome policy (chain-neutral core)
// ---------------------------------------------------------------------------
function ruleResult(policy: Policy, store: ReturnType<typeof buildStore>, positions: PolicyPosition[], options: {
  price?: (unit: string) => ReturnType<typeof priceIn> | null;
  evaluatedAt?: string;
  snapshotId?: string;
  registry?: ReturnType<typeof createGenericRegistry>;
} = {}) {
  const registry = options.registry ?? createGenericRegistry();
  const verdict = evaluatePolicy(policy, store, context({ positions, registry, price: options.price, evaluatedAt: options.evaluatedAt, snapshotId: options.snapshotId }));
  return verdict.rules[0]!;
}

const priceIn = (value: string, unitOfAccount = "usd") => ({ value, unitOfAccount, factIds: [], receiptIds: ["r1"] });

function controlPosition(ref: string, subject: string, members: string[], receiptIds: string[] = ["r1"]) {
  return position({ ref, subject, facts: members.map((member, index) => fact(`${ref}-f${index}`, subject, "CONTROLLED_BY", member, receiptIds)) });
}

function sharePolicy(maxPercent: number, basis: "count" | "value" = "count"): Policy {
  return { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "share", kind: "max-share-behind", params: { kind: "controller", maxPercent, basis } }] };
}

function baseStore(extraFacts: Parameters<typeof buildStore>[0][number]["facts"] = [], extraReceipts: ReturnType<typeof receipt>[] = []) {
  return buildStore([{ id: "s1", subjects: [X, Y, Z], receipts: [receipt("r1"), receipt("r2"), ...extraReceipts], facts: extraFacts }]);
}

describe("AC5 policy core", () => {
  for (const basis of ["count", "value"] as const) {
    test(`R1 share uses only in-scope positions (${basis})`, () => {
      const scoped = controlPosition("scoped", X, [X]);
      const excluded = { ...controlPosition("excluded", Y, [Y]), inScope: false };
      const options = { price: () => priceIn("1") };
      expect(ruleResult(sharePolicy(50, basis), baseStore(), [scoped], options).outcome).toBe("outside-policy");
      expect(ruleResult(sharePolicy(50, basis), baseStore(), [scoped, excluded], options).outcome).toBe("outside-policy");
      const empty = ruleResult(sharePolicy(50, basis), baseStore(), [excluded], options);
      expect(empty.outcome).toBe("undetermined");
      expect(empty.reasons.map(r => r.code)).toEqual(["no-positions"]);
    });
  }

  for (const code of ["stale", "no-facts"] as const) {
    test(`R5 ${code} chain makes age and share undetermined`, () => {
      const targets = [controlPosition("p1", X, [X]), controlPosition("p2", Y, [Y])];
      const age: Policy = { policyId: "age-policy", subjects: [X], rules: [{ id: "age", kind: "max-evidence-age", params: { days: 7 } }] };
      for (const policy of [age, sharePolicy(50)]) {
        expect(ruleResult(policy, baseStore(), targets).outcome).toBe("within-policy");
        const incomplete = targets.map(target => ({
          ...target, chain: { ...target.chain!, reasons: [{ code, subject: target.subject, ref: null }] },
        }));
        expect(ruleResult(policy, baseStore(), incomplete).outcome).toBe("undetermined");
      }
    });
  }

  test("T5.1 max-share-behind", () => {
    const store = baseStore();
    // Both positions behind one controller: 100% > 50% → outside.
    const bothX = [controlPosition("p1", X, [X]), controlPosition("p2", Y, [X])];
    const exceeded = ruleResult(sharePolicy(50), store, bothX);
    expect(exceeded.outcome).toBe("outside-policy");
    expect(exceeded.reasons.map((reason) => reason.code)).toEqual(["share-exceeded"]);
    expect(exceeded.reasons[0]!.subject).toBe(X);
    // One behind X, one behind Y: 50% each, equal is not exceeded → within.
    const split = [controlPosition("p1", X, [X]), controlPosition("p2", Y, [Y])];
    expect(ruleResult(sharePolicy(50), store, split).outcome).toBe("within-policy");
    // One uncovered position counts only in the upper bound → undetermined.
    const uncovered = [controlPosition("p1", X, [X]), position({ ref: "p2", subject: Y, chainNull: true })];
    const uncertain = ruleResult(sharePolicy(50), store, uncovered);
    expect(uncertain.outcome).toBe("undetermined");
    expect(uncertain.reasons.map((reason) => reason.code)).toContain("share-uncertain");
    // Value basis: any missing price → undetermined, no share computed.
    expect(ruleResult(sharePolicy(50, "value"), store, bothX, { price: () => null }).reasons.map((reason) => reason.code)).toContain("missing-price");
    // Weights 3×2=6 behind X vs 1×2=2 behind Y: 75% of the total.
    const weighted = (unit: string) => [
      position({ ref: "p1", subject: X, unit, quantity: "3", facts: [fact("p1f", X, "CONTROLLED_BY", X, ["r1"])] }),
      position({ ref: "p2", subject: Y, unit, quantity: "1", facts: [fact("p2f", Y, "CONTROLLED_BY", Y, ["r2"])] }),
    ];
    expect(ruleResult(sharePolicy(70, "value"), store, weighted("u"), { price: () => priceIn("2") }).outcome).toBe("outside-policy");
    expect(ruleResult(sharePolicy(75, "value"), store, weighted("u"), { price: () => priceIn("2") }).outcome).toBe("within-policy");
    // Differing units of account → undetermined.
    const mismatch = (unit: string) => (unit === "u" ? priceIn("2", "usd") : priceIn("2", "eur"));
    const mixed = weighted("u");
    mixed[1]!.unit = "v";
    expect(ruleResult(sharePolicy(50, "value"), store, mixed, { price: mismatch }).reasons.map((reason) => reason.code)).toContain("incomparable-units");
    // Empty population and the vacuous 100% bound.
    expect(ruleResult(sharePolicy(50), store, []).reasons.map((reason) => reason.code)).toEqual(["no-positions"]);
    let rejected: string | null = null;
    try {
      parsePolicy(sharePolicy(100), createGenericRegistry());
    } catch (error) {
      rejected = error instanceof PolicyRejected ? error.code : null;
    }
    expect(rejected).toBe("bad-params");
  });

  test("T5.2 min-exit-evidence", () => {
    const policy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "exit-evidence", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }] };
    const target = position({ exit: [exitItem("idle", X, ["r1"]), exitItem("withdrawal-constraint", X, ["r2"])] });
    const fresh = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1"), receipt("r2")], facts: [] }]);
    expect(ruleResult(policy, fresh, [target]).outcome).toBe("within-policy");
    const stale = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1"), receipt("r2", STALE)], facts: [] }]);
    const staleResult = ruleResult(policy, stale, [target]);
    expect(staleResult.outcome).toBe("outside-policy");
    expect(staleResult.reasons.map((reason) => reason.code)).toContain("stale-evidence");
    const noConstraint = position({ exit: [exitItem("idle", X, ["r1"])] });
    expect(ruleResult(policy, fresh, [noConstraint]).reasons.map((reason) => reason.code)).toContain("missing-exit-evidence");
    expect(ruleResult(policy, fresh, [position({ chainNull: true })]).outcome).toBe("undetermined");
    // An unknown position reference is undetermined, never silently skipped.
    const unknownRef = ruleResult({ ...policy, rules: [{ id: "exit-evidence", kind: "min-exit-evidence", params: { maxAgeDays: 7, positions: ["ghost-ref"] } }] }, fresh, [target]);
    expect(unknownRef.outcome).toBe("undetermined");
    expect(unknownRef.reasons.map((reason) => reason.code)).toContain("unknown-position");
  });

  test("T5.3 max-evidence-age", () => {
    const policy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "fresh", kind: "max-evidence-age", params: { days: 7 } }] };
    const freshTarget = position({ facts: [fact("f1", X, "DEPENDS_ON", Y, ["r1"])] });
    const freshStore = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [] }]);
    expect(ruleResult(policy, freshStore, [freshTarget]).outcome).toBe("within-policy");
    const staleStore = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1", STALE)], facts: [] }]);
    const staleResult = ruleResult(policy, staleStore, [freshTarget]);
    expect(staleResult.outcome).toBe("outside-policy");
    expect(staleResult.reasons.map((reason) => reason.code)).toContain("stale-evidence");
    const unresolved = position({ facts: [fact("f1", X, "DEPENDS_ON", Y, ["missing-receipt"])] });
    const unresolvedResult = ruleResult(policy, freshStore, [unresolved]);
    expect(unresolvedResult.outcome).toBe("undetermined");
    expect(unresolvedResult.reasons.map((reason) => reason.code)).toContain("missing-evidence");
    const gap = position({ facts: [fact("f1", X, "DEPENDS_ON", Y, ["r1"])], reasons: [{ code: "missing-history", subject: X, ref: null }] });
    const gapResult = ruleResult(policy, freshStore, [gap]);
    expect(gapResult.outcome).toBe("undetermined");
    expect(gapResult.reasons.map((reason) => reason.code)).toContain("incomplete-chain");
    // Exactly N days old is the inclusive boundary, therefore fresh.
    const boundaryStore = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1", SEVEN_DAYS_EXACT)], facts: [] }]);
    expect(ruleResult(policy, boundaryStore, [freshTarget]).outcome).toBe("within-policy");
    // An empty chain has no facts to stand on.
    expect(ruleResult(policy, freshStore, [position({ facts: [] })]).reasons.map((reason) => reason.code)).toContain("missing-fact");
  });

  test("T5.4 controller-resolved", () => {
    const policy = (account: string): Policy => ({ policyId: "synthetic-policy", subjects: [X], rules: [{ id: "controller", kind: "controller-resolved", params: { account } }] });
    const verified = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "CONTROLLED_BY", Y, ["r1"])] }]);
    expect(ruleResult(policy(X), verified, [position()]).outcome).toBe("within-policy");
    const conflicting = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "CONTROLLED_BY", Y, ["r1"], { status: "conflicting" })] }]);
    const conflictResult = ruleResult(policy(X), conflicting, [position()]);
    expect(conflictResult.outcome).toBe("outside-policy");
    expect(conflictResult.reasons.map((reason) => reason.code)).toContain("conflict");
    const unknown = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "CONTROLLED_BY", "unknown", ["r1"], { basis: "unknown", status: "unverified" })] }]);
    const unknownResult = ruleResult(policy(X), unknown, [position()]);
    expect(unknownResult.outcome).toBe("undetermined");
    expect(unknownResult.reasons.map((reason) => reason.code)).toContain("unknown-controller");
    const absentStore = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [] }]);
    const absent = ruleResult(policy(Z), absentStore, [position()]);
    expect(absent.outcome).toBe("undetermined");
    expect(absent.reasons.map((reason) => reason.code)).toContain("missing-fact");
  });

  test("T5.5 unchanged-since", () => {
    const key = `${X}|SUPPLY_RAW`;
    const policy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "unchanged", kind: "unchanged-since", params: { snapshotId: "s0", factKeys: [key] } }] };
    const same = buildStore([
      { id: "s0", subjects: [X], receipts: [receipt("r1")], facts: [fact("f0", X, "SUPPLY_RAW", "amount:5", ["r1"])] },
      { id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "SUPPLY_RAW", "amount:5", ["r1"])] },
    ]);
    expect(ruleResult(policy, same, [position()]).outcome).toBe("within-policy");
    const changed = buildStore([
      { id: "s0", subjects: [X], receipts: [receipt("r1")], facts: [fact("f0", X, "SUPPLY_RAW", "amount:5", ["r1"])] },
      { id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "SUPPLY_RAW", "amount:6", ["r1"])] },
    ]);
    const changedResult = ruleResult(policy, changed, [position()]);
    expect(changedResult.outcome).toBe("outside-policy");
    expect(changedResult.reasons.map((reason) => reason.code)).toContain("changed");
    expect(changedResult.reasons[0]!.subject).toBe(X);
    const missing = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [] }]);
    expect(ruleResult(policy, missing, [position()]).reasons.map((reason) => reason.code)).toContain("missing-snapshot");
    // Unknown on both sides is never a pass.
    const bothUnknown = buildStore([
      { id: "s0", subjects: [X], receipts: [receipt("r1")], facts: [fact("f0", X, "SUPPLY_RAW", "unknown", ["r1"], { basis: "unknown", status: "unverified" })] },
      { id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "SUPPLY_RAW", "unknown", ["r1"], { basis: "unknown", status: "unverified" })] },
    ]);
    expect(ruleResult(policy, bothUnknown, [position()]).outcome).toBe("undetermined");
    const oneSideEmpty = buildStore([
      { id: "s0", subjects: [X], receipts: [receipt("r1")], facts: [] },
      { id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [fact("f1", X, "SUPPLY_RAW", "amount:5", ["r1"])] },
    ]);
    expect(ruleResult(policy, oneSideEmpty, [position()]).outcome).toBe("undetermined");
  });

  test("T5.6 combinator", () => {
    expect(combineOutcomes(["within-policy", "within-policy"])).toBe("within-policy");
    expect(combineOutcomes(["within-policy", "undetermined"])).toBe("undetermined");
    expect(combineOutcomes(["undetermined", "outside-policy"])).toBe("outside-policy");
    expect(combineOutcomes(["outside-policy", "outside-policy"])).toBe("outside-policy");
    expect(combineOutcomes([])).toBe("undetermined");
  });

  test("T5.7 rule error", () => {
    const canary = "CANARYruleFailureZ9Q";
    const throwing = createRuleRegistry([{ kind: "explodes", parse: () => ({}), evaluate: () => { throw new Error(`<${canary}>`); } }]);
    const policy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "boom", kind: "explodes", params: {} }] };
    const verdict = evaluatePolicy(policy, baseStore(), context({ positions: [position()], registry: throwing }));
    expect(verdict.rules[0]!.outcome).toBe("undetermined");
    expect(verdict.rules[0]!.reasons.map((reason) => reason.code)).toEqual(["rule-error"]);
    expect(JSON.stringify(verdict)).not.toContain(canary);
    expect(verdict.outcome).toBe("undetermined");
  });

  test("T5.8 parse", () => {
    const registry = createGenericRegistry();
    const base: any = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "r", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }] };
    const codeOf = (value: unknown): string | null => {
      try {
        parsePolicy(value, registry);
        return null;
      } catch (error) {
        return error instanceof PolicyRejected ? error.code : null;
      }
    };
    expect(codeOf({ ...base, rules: [{ id: "r", kind: "nope", params: {} }] })).toBe("unknown-kind");
    expect(codeOf({ ...base, rules: [{ id: "r", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }, { id: "r", kind: "max-evidence-age", params: { days: 7 } }] })).toBe("duplicate-rule-id");
    expect(codeOf({ ...base, rules: [] })).toBe("empty-rules");
    expect(codeOf({ ...base, subjects: [] })).toBe("empty-subjects");
    expect(codeOf({ ...base, extra: 1 })).toBe("schema");
    expect(codeOf({ ...base, rules: [{ id: "r", kind: "max-evidence-age", params: { days: 0 } }] })).toBe("bad-params");
 expect(codeOf({ ...base, subjects: ["Sentora PYUSD"] })).toBe("schema");
  });

  test("T5.9 NEAR-shaped extension", () => {
    const extra: RuleKind<{ flag: boolean }> = { kind: "near-test-kind", parse: () => ({ flag: true }), evaluate: () => ({ outcome: "within-policy", reasons: [], factIds: [], receiptIds: [], evidence: {} }) };
    const base = createGenericRegistry();
    const extended = base.extend([extra]);
    expect(extended.kinds()).toContain("near-test-kind");
    expect(base.kinds()).not.toContain("near-test-kind");
    expect(base.kinds()).toEqual([...GENERIC_RULES.map((rule) => rule.kind)].sort());
    expect(() => base.extend([GENERIC_RULES[0]!])).toThrow(PolicyRejected);
    const policy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "near", kind: "near-test-kind", params: {} }, { id: "exit", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }] };
    const store = buildStore([{ id: "s1", subjects: [X], receipts: [receipt("r1")], facts: [] }]);
    const verdict = evaluatePolicy(policy, store, context({ positions: [position({ chainNull: true })], registry: extended }));
    expect(verdict.rules[0]!.outcome).toBe("within-policy");
    expect(verdict.rules[1]!.outcome).toBe("undetermined");
  });

  test("T5.10 no numbers outside evidence", () => {
    const verdict = evaluatePolicy(sharePolicy(10), baseStore(), context({ positions: [controlPosition("p1", X, [X]), controlPosition("p2", Y, [X])], registry: createGenericRegistry() }));
    const offenders: string[] = [];
    walkJson(verdict, (node, path) => {
      if (typeof node === "number" && !(path.includes("rules") && path.includes("evidence"))) offenders.push(path.join("."));
    });
    expect(offenders).toEqual([]);
  });

  test("T5.11 unknown never promoted", () => {
    const registry = createGenericRegistry();
    const empty = buildStore([{ id: "s1", subjects: [X], receipts: [], facts: [] }]);
    // Share: an unknown position keeps the upper bound above any cap.
    const share = evaluatePolicy(sharePolicy(50), empty, context({ positions: [position({ chainNull: true })], registry }));
    expect(share.rules[0]!.outcome).not.toBe("within-policy");
    expect(share.rules[0]!.outcome).toBe("undetermined");
    // Exit: evidence removed means unresolved receipt ids, not empty lists.
    const ghostExit = position({ exit: [exitItem("idle", X, ["ghost-1"]), exitItem("withdrawal-constraint", X, ["ghost-2"])] });
    const exitPolicy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "exit", kind: "min-exit-evidence", params: { maxAgeDays: 7 } }] };
    const exit = evaluatePolicy(exitPolicy, empty, context({ positions: [ghostExit], registry }));
    expect(exit.rules[0]!.outcome).toBe("undetermined");
    expect(exit.rules[0]!.reasons.map((reason) => reason.code)).toContain("missing-evidence");
    // Age: no facts at all.
    const agePolicy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "age", kind: "max-evidence-age", params: { days: 7 } }] };
    expect(evaluatePolicy(agePolicy, empty, context({ positions: [position({ facts: [] })], registry })).rules[0]!.outcome).toBe("undetermined");
    // Controller: no control facts for the account.
    const controllerPolicy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "controller", kind: "controller-resolved", params: { account: X } }] };
    expect(evaluatePolicy(controllerPolicy, empty, context({ positions: [position()], registry })).rules[0]!.outcome).toBe("undetermined");
    // Unchanged: the earlier snapshot is missing entirely.
    const unchangedPolicy: Policy = { policyId: "synthetic-policy", subjects: [X], rules: [{ id: "unchanged", kind: "unchanged-since", params: { snapshotId: "s0", factKeys: [`${X}|SUPPLY_RAW`] } }] };
    expect(evaluatePolicy(unchangedPolicy, empty, context({ positions: [position()], registry })).rules[0]!.outcome).toBe("undetermined");
  });

  test("T5.12 Kamino demo policy", async () => {
    const report = await vaultReport(DEMO_POLICY);
    const rules = new Map(report.verdict!.rules.map((rule) => [rule.ruleId, rule]));
    expect(rules.get("one-oracle-cap")!.outcome).toBe("outside-policy");
    expect(rules.get("one-oracle-cap")!.reasons.map((reason) => reason.code)).toContain("share-exceeded");
    expect(rules.get("one-oracle-cap")!.reasons[0]!.subject).toBe(ORACLE);
    expect(rules.get("one-oracle-cap")!.factIds).toHaveLength(7);
    expect(rules.get("value-cap")!.outcome).toBe("undetermined");
    expect(rules.get("value-cap")!.reasons.map((reason) => reason.code)).toContain("missing-price");
    expect(rules.get("exit-evidence")!.outcome).toBe("within-policy");
    expect(rules.get("fresh-evidence")!.outcome).toBe("undetermined");
    expect(rules.get("vault-admin-resolved")!.outcome).toBe("within-policy");
    expect(rules.get("admin-controller-resolved")!.outcome).toBe("undetermined");
    expect(rules.get("admin-controller-resolved")!.reasons.map((reason) => reason.code)).toContain("unknown-controller");
    expect(rules.get("admin-unchanged")!.outcome).toBe("within-policy");
    expect(report.verdict!.outcome).toBe("outside-policy");
    expect(report.verdict!.policyId).toBe("demo-solana-v1");
  });

  test("T5.13 later as-of", async () => {
    const report = await vaultReport(DEMO_POLICY);
    const later = await reviewWith([bookEntry()], { policy: DEMO_POLICY, asOf: EIGHT_DAYS_LATER });
    const rules = new Map(later.verdict!.rules.map((rule) => [rule.ruleId, rule]));
    expect(rules.get("exit-evidence")!.outcome).toBe("outside-policy");
    expect(rules.get("fresh-evidence")!.outcome).toBe("outside-policy");
    expect(later.verdict!.outcome).toBe("outside-policy");
    expect(report.verdict!.evaluatedAt).toBe(B_ASOF);
  });

  test("T5.14 earlier as-of", async () => {
    const spy = spyEngine();
    const report = await reviewWith([bookEntry()], { policy: DEMO_POLICY, asOf: A_ASOF, engine: spy.engine });
    const rules = new Map(report.verdict!.rules.map((rule) => [rule.ruleId, rule]));
    expect(rules.get("fresh-evidence")!.outcome).toBe("undetermined");
    expect(rules.get("fresh-evidence")!.reasons.map((reason) => reason.code)).toContain("incomplete-chain");
    expect(rules.get("fresh-evidence")!.reasons.find((reason) => reason.code === "incomplete-chain")!.ref).toBe("missing-history");
    expect(rules.get("exit-evidence")!.outcome).toBe("undetermined");
    expect(rules.get("exit-evidence")!.reasons.map((reason) => reason.code)).toContain("observed-after-evaluation");
    expect(rules.get("vault-admin-resolved")!.outcome).toBe("undetermined");
    expect(rules.get("admin-unchanged")!.outcome).toBe("undetermined");
    expect(rules.get("one-oracle-cap")!.outcome).toBe("undetermined");
    expect(rules.get("one-oracle-cap")!.reasons.map((reason) => reason.code)).toContain("share-uncertain");
    expect(rules.get("value-cap")!.reasons.map((reason) => reason.code)).toContain("missing-price");
    for (const rule of report.verdict!.rules) expect(rule.outcome).not.toBe("within-policy");
    expect(report.verdict!.outcome).toBe("undetermined");
    // Three executor runs: an unknown dependencies round, one control query, one state round.
    expect(report.runs).toHaveLength(3);
    expect(spy.nodeCounts).toEqual([1, 1, 1]);
    expect(spy.envelopes[0]!.results.every((entry) => entry.result.outcome === "unknown")).toBe(true);
    const chain = report.positions[0]!.chain!;
    expect(chain.dependencyFacts).toHaveLength(0);
    expect(chain.stateFacts).toHaveLength(0);
    expect(chain.reasons.map((reason) => reason.code)).toContain("missing-history");
  });

  test("T5.15 wording", async () => {
    const demo = await runDemo(FIXTURES);
    const publicMarkdown = renderMarkdown(toPublicReview(demo.review));
    const privateMarkdown = renderMarkdown(demo.review);
    expect(findBannedWords(publicMarkdown)).toEqual([]);
    expect(findBannedWords(privateMarkdown)).toEqual([]);
    expect(findBannedWords("This is safe and guarantees a loss.")).toContain("safe");
    expect(findBannedWords("keep `safe` in backticks")).toEqual([]);
  });

  test("T5.16 chain neutrality", () => {
    const dir = join(ROOT, "src", "policy");
    const files: string[] = [];
    const collect = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    collect(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect({ file: relative(ROOT, file), solana: text.includes("solana:") }).toEqual({ file: relative(ROOT, file), solana: false });
      expect({ file: relative(ROOT, file), kamino: /kamino/i.test(text) }).toEqual({ file: relative(ROOT, file), kamino: false });
      for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        expect({ file: relative(ROOT, file), specifier, relative: specifier.startsWith(".") }).toEqual({ file: relative(ROOT, file), specifier, relative: true });
        const target = resolve(dirname(file), specifier);
        const allowed = target.startsWith(dir + "/") || target === resolve(ROOT, "src", "engine", "contracts");
        expect({ file: relative(ROOT, file), specifier, allowed }).toEqual({ file: relative(ROOT, file), specifier, allowed: true });
      }
    }
  });

  test("T5.17 policy file wiring (supplementary)", () => {
    const cwd = tempDir();
    writeJson(join(cwd, "book.json"), [bookEntry()]);
    const result = cli(["review", "--book", join(cwd, "book.json"), "--book-snapshot", "book-1", "--policy", join(FIX, "policy-demo.json"), "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out")], cwd);
    expect(result.code).toBe(0);
    expect(result.out).toContain("verdict outside-policy");
    const report = readJson(join(cwd, "out", "position-review.public.json"));
    expect(report.verdict.rules).toHaveLength(7);
    expect(report.verdict.policyId).toBe("fixture-demo-policy");
    const missing = cli(["review", "--book", join(cwd, "book.json"), "--book-snapshot", "book-1", "--policy", join(cwd, "absent.json"), "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out2")], cwd);
    expect(missing.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC6 — safe export, canaries
// ---------------------------------------------------------------------------
describe("AC6 safe export", () => {
  test("T6.1 CLI canaries", () => {
    const cwd = tempDir();
    const bookPath = join(FIX, "book-canary.json");
    const out = join(cwd, "out");
    const tracePath = join(cwd, "trace.jsonl");
    const watchOut = join(cwd, "watch");
    const watchTrace = join(cwd, "watch-trace.jsonl");
    const privateExport = join(cwd, "private-export.json");
    const review = cli(["review", "--book", bookPath, "--book-snapshot", "book-1", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", out, "--trace", tracePath, "--private-export", privateExport], cwd);
    expect(review.code).toBe(0);
    const watch = cli(["watch", "--book", bookPath, "--book-before", "book-1", "--book-after", "book-1", "--before", A.id, "--after", B.id, "--fixtures", FIXTURES, "--out", watchOut, "--trace", watchTrace], cwd);
    expect(watch.code).toBe(0);
    const badPath = writeJson(join(cwd, "bad-book.json"), [bookEntry({ quantity: "12x" })]);
    const failure = cli(["review", "--book", badPath, "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "bad-out")], cwd);
    expect(failure.code).toBe(2);

    const publicTexts = [review.out, review.err, watch.out, watch.err, failure.out, failure.err, readFileSync(tracePath, "utf8"), readFileSync(watchTrace, "utf8")];
    for (const dir of [out, watchOut]) {
      for (const name of readdirSync(dir)) publicTexts.push(readFileSync(join(dir, name), "utf8"));
    }
    for (const text of publicTexts) assertNoCanaries(text, "public surface");

    const privateText = readFileSync(privateExport, "utf8");
    for (const canary of CANARIES) expect(privateText).toContain(canary);
    expect(statSync(privateExport).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(privateText) as { privacy: string; label: string };
    expect(parsed.privacy).toBe("private");
    expect(parsed.label).toBe("PRIVATE LOCAL EXPORT: contains position data; keep local, do not commit or publish");
  });

  test("T6.2 executor input, trace and model projection", async () => {
    const spy = spyEngine();
    await reviewWith(canaryBook(), { engine: spy.engine });
    const publicSubjects = new Set(B.subjects);
    for (const input of spy.inputs) {
      for (const node of input.plan.nodes) {
        const subject = (node.input.subject as { literal?: unknown } | undefined)?.literal;
        if (typeof subject === "string") expect(publicSubjects.has(subject)).toBe(true);
      }
      assertNoCanaries(canonical({ plan: input.plan, limits: input.limits, blueprintId: input.blueprintId }), "executor input");
    }
    assertNoCanaries(canonical(spy.sink.events), "trace");
    expect(spy.envelopes.length).toBeGreaterThan(0);
    for (const envelope of spy.envelopes) {
      const projection = projectForModel(envelope, B.subjects);
      assertNoCanaries(canonical(projection), "model projection");
      for (const stored of projection.request.publicFacts) expect(publicSubjects.has(stored.subject)).toBe(true);
    }
    const planLiterals = spy.inputs.flatMap((input) => input.plan.nodes.flatMap((node) => Object.values(node.input).map((value) => (value as { literal?: unknown }).literal))).filter((value): value is string => typeof value === "string");
    expect(planLiterals).not.toContain(CANARY_OWNER_SUBJECT);
  });

  test("T6.3 export path guard", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeJson(join(root, "book.json"), [bookEntry()]);
    const blocked = cli(["review", "--book", join(root, "book.json"), "--book-snapshot", "book-1", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(root, "out"), "--private-export", join(root, "report.json")], root);
    expect(blocked.code).toBe(2);
    expect(existsSync(join(root, "report.json"))).toBe(false);
    const allowed = cli(["review", "--book", join(root, "book.json"), "--book-snapshot", "book-1", "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(root, "out"), "--private-export", join(root, ".private", "report.json")], root);
    expect(allowed.code).toBe(0);
    expect(statSync(join(root, ".private", "report.json")).mode & 0o777).toBe(0o600);
    expect(() => checkPrivateExportPath(join(root, "report.json"))).toThrow(PositionRejected);
    expect(checkPrivateExportPath(join(root, ".private", "report.json")).endsWith(join(".private", "report.json"))).toBe(true);
  });

  test("T6.4 error text", () => {
    const cwd = tempDir();
    const badPath = writeJson(join(cwd, "bad.json"), [bookEntry({ id: CANARY_ID, quantity: "12x" })]);
    const result = cli(["review", "--book", badPath, "--fixtures", FIXTURES, "--as-of", B_ASOF, "--out", join(cwd, "out")], cwd);
    expect(result.code).toBe(2);
    expect(result.err).toContain("book entry 0 quantity: malformed-quantity");
    assertNoCanaries(result.err, "error text");
  });

  test("T6.5 static boundary", () => {
    for (const lane of ["src/review/position", "src/policy"]) {
      const files: string[] = [];
      const collect = (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) collect(full);
          else if (entry.name.endsWith(".ts")) files.push(full);
        }
      };
      collect(join(ROOT, lane));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const forbidden of ["neo4j-driver", "src/graph", "context/knowledge", "node:net", "node:http", "node:https", "fetch("]) {
          expect({ file: relative(ROOT, file), forbidden, found: text.includes(forbidden) }).toEqual({ file: relative(ROOT, file), forbidden, found: false });
        }
        if (file.includes(join("src", "review", "position"))) {
          const engineImports = [...text.matchAll(/from\s+"(\.\.\/\.\.\/engine\/[^"]+)"/g)].map((match) => match[1]!);
          expect({ file: relative(ROOT, file), engineImports }).toEqual({ file: relative(ROOT, file), engineImports: engineImports.map(() => "../../engine/index") });
        }
        if (!file.endsWith("command.ts")) expect({ file: relative(ROOT, file), consoles: text.includes("console.") }).toEqual({ file: relative(ROOT, file), consoles: false });
      }
    }
  });

  test("T6.6 public shape", async () => {
    const report = await vaultReport(DEMO_POLICY);
    const exported = toPublicReview(report);
    expect(exported.privacy).toBe("public");
    expect(exported.label).toBe("public export: no position quantities, units, identifiers or private subjects");
    const keys = new Set<string>();
    walkJson(exported, (_node, path) => {
      if (path.length) keys.add(path.at(-1)!);
    });
    for (const forbidden of ["quantity", "positionId", "positionRef", "evidence", "params", "totals", "body", "response", "records", "runId"]) {
      expect({ forbidden, present: keys.has(forbidden) }).toEqual({ forbidden, present: false });
    }
    walkJson(exported, (node) => {
      if (node && typeof node === "object" && "code" in node && "subject" in node && "ref" in node) {
        const reason = node as { subject: string | null };
        expect(reason.subject === null || report.publicSubjects.includes(reason.subject)).toBe(true);
      }
    });
    const subject = exported.subjects.find((entry) => entry.subject === VAULT)!;
    expect(subject.dependencyFacts).toHaveLength(40);
    expect(subject.controlFacts).toHaveLength(16);
    expect(subject.stateFacts).toHaveLength(15);
    expect(subject.economics).not.toHaveProperty("valuation");
    // B1: per-subject receipts are the union of chain receipts and economics receipts.
    const union = new Set([...report.positions[0]!.chain!.receipts.map((entry) => entry.id), ...report.economicsReceipts.map((entry) => entry.id)]);
    expect(subject.receipts.map((entry) => entry.id)).toEqual([...union].sort());
    expect(subject.receipts.every((entry, index, all) => index === 0 || all[index - 1]!.id < entry.id)).toBe(true);
    expect(report.positions[0]!.chain!.receipts).toHaveLength(26);
  });

  test("T6.7 projection", () => {
    const verdict = {
      policyId: "synthetic-policy",
      outcome: "within-policy" as const,
      evaluatedAt: AT,
      rules: [
        {
          ruleId: "r",
          kind: "k",
          outcome: "within-policy" as const,
          reasons: [
            { code: "share-exceeded", subject: CANARY_OWNER_SUBJECT, ref: null },
            { code: "missing-price", subject: null, ref: null },
            { code: "changed", subject: VAULT, ref: "k" },
          ],
          factIds: ["f1"],
          receiptIds: ["r1"],
          evidence: { privateDetail: "CANARYdetailZ1" },
        },
      ],
    };
    const projected = projectVerdict(verdict, [VAULT]);
    expect(projected.rules[0]).not.toHaveProperty("evidence");
    expect(projected.rules[0]!.reasons.map((reason) => reason.code)).toEqual(["missing-price", "changed"]);
    expect(JSON.stringify(projected)).not.toContain(CANARY_OWNER_SUBJECT);
    expect(JSON.stringify(projected)).not.toContain("CANARYdetailZ1");
  });
});

// ---------------------------------------------------------------------------
// AC7 — useful no-model demo
// ---------------------------------------------------------------------------
describe("AC7 demo", () => {
  test("T7.1 demo", () => {
    const cwd = tempDir();
    const out = join(cwd, "out");
    const result = cli(["demo", "--fixtures", FIXTURES, "--out", out], cwd);
    expect(result.code).toBe(0);
    for (const name of ["review", "dependency-change", "unchanged", "missing-data"]) expect(result.out).toContain(name);
    const demo = readJson(join(out, "position-demo.public.json"));
    const byName = new Map<string, any>(demo.scenarios.map((scenario: any) => [scenario.name, scenario]));
    expect(byName.get("review")!.verdict.outcome).toBe("outside-policy");
    expect(byName.get("dependency-change")!.events).toHaveLength(1);
    expect(byName.get("dependency-change")!.events[0].changes).toHaveLength(11);
    expect(byName.get("unchanged")!.events).toEqual([]);
    const missing = byName.get("missing-data")!;
    expect(missing.rules.map((rule: any) => rule.ruleId).sort()).toEqual(["admin-controller-resolved", "fresh-evidence", "value-cap"]);
    expect(missing.rules.every((rule: any) => rule.outcome === "undetermined")).toBe(true);
    expect(missing.unknownControllers).toHaveLength(4);
    expect(missing.missing).toEqual(["LendingMarket.emergencyCouncil", "LendingMarket.proposerAuthority", "VaultState.pendingAdmin", "farms", "withdrawal-queue"]);
    expect(missing.valuation).toEqual({ value: null, reason: "missing-price", label: "unknown (missing price)" });
    expect(demo.scenarios.map((scenario: any) => scenario.runs.length)).toEqual([4, 7, 7, 0]);
    for (const scenario of demo.scenarios) for (const run of scenario.runs) expect(run).not.toHaveProperty("runId");
    expect(demo.scenarios.map((scenario: any) => scenario.constructed)).toEqual([false, false, false, false]);
    expect(JSON.stringify(demo)).not.toContain("runId");
    // Every receipt id cited anywhere in the demo export resolves to an exported receipt.
    const receiptIds = new Set<string>(demo.receipts.map((entry: any) => entry.id));
    const cited = new Set<string>();
    walkJson(demo.scenarios, (node) => {
      if (Array.isArray(node)) return;
      if (node && typeof node === "object") {
        const values = node as Record<string, unknown>;
        for (const key of ["evidenceIds", "receiptIds", "claimEvidenceIds", "observationEvidenceIds"]) {
          if (Array.isArray(values[key])) values[key]!.forEach((id) => typeof id === "string" && cited.add(id));
        }
      }
    });
    expect(cited.size).toBeGreaterThan(0);
    for (const id of cited) expect({ id, present: receiptIds.has(id) }).toEqual({ id, present: true });
    // Clarification B1, demo form: the review scenario's per-subject receipts carry every
    // receipt cited by its exported economics quantities and claims.
    const reviewSubject = byName.get("review")!.subjects.find((entry: any) => entry.subject === VAULT);
    const perSubject = new Set(reviewSubject.receipts.map((entry: any) => entry.id));
    for (const id of citedReceiptIds(reviewSubject.economics)) expect({ id, present: perSubject.has(id) }).toEqual({ id, present: true });
  });

  test("T7.2 deterministic", () => {
    const first = tempDir();
    const second = tempDir();
    expect(cli(["demo", "--fixtures", FIXTURES, "--out", join(first, "out")], first).code).toBe(0);
    expect(cli(["demo", "--fixtures", FIXTURES, "--out", join(second, "out")], second).code).toBe(0);
    expect(readFileSync(join(first, "out", "position-demo.public.json"), "utf8")).toBe(readFileSync(join(second, "out", "position-demo.public.json"), "utf8"));
    expect(readFileSync(join(first, "out", "position-demo.public.md"), "utf8")).toBe(readFileSync(join(second, "out", "position-demo.public.md"), "utf8"));
  });

  test("T7.3 offline runDemo", async () => {
    const original = globalThis.fetch;
    const thrower = () => {
      throw new Error("network access attempted");
    };
    (globalThis as { fetch: unknown }).fetch = thrower;
    try {
      const demo = await runDemo(FIXTURES);
      expect(demo.review.verdict!.outcome).toBe("outside-policy");
    } finally {
      (globalThis as { fetch: unknown }).fetch = original;
    }
  });

  test("T7.4 synthetic book, no private directory needed", async () => {
    for (const entry of DEMO_BOOK) expect(entry.fixtureKind).toBe("synthetic");
    const cwd = tempDir();
    const demo = await runDemo(FIXTURES);
    expect(existsSync(join(cwd, ".private"))).toBe(false);
    expect(demo.review.positions[0]!.position.fixtureKind).toBe("synthetic");
    expect(demo.review.positions[0]!.position.quantity).toBe("1250.000000");
  });
});

// --- more groups follow ---

describe("dependency relations follow the snapshot (fix 7d33e42)", () => {
  const TRAVERSAL = Object.keys(VOCABULARY).filter(isTraversalRelation).sort();
  class Stop extends Error {}
  /** An engine whose execute records the dependency requests of the first round, then stops the review. */
  function capturingEngine(store: EvidenceStore) {
    const requests: QueryRequest[] = [];
    const engine = engineAccess(store, {
      execute: async (input: RunPlanInput) => {
        for (const node of (input.plan as EnginePlan).nodes) {
          if (node.agent !== "dependencies") continue;
          requests.push({ name: "dependencies", ...Object.fromEntries(Object.entries(node.input).map(([key, value]) => [key, (value as { literal: unknown }).literal])) } as QueryRequest);
        }
        throw new Stop();
      },
    });
    return { engine, requests };
  }
  const fakeStore = (predicates: string[]) =>
    ({ snapshot: () => ({ constructed: false, facts: predicates.map((predicate) => ({ predicate })) }) }) as unknown as EvidenceStore;
  const relationsOf = (request: QueryRequest) => (request as { relations: string[] }).relations;

  test("requests exactly the traversal relations the snapshot uses, sorted", async () => {
    const { engine, requests } = capturingEngine(evidence.store);
    await expect(queryChains(engine, [VAULT], B.id, B_ASOF)).rejects.toBeInstanceOf(Stop);
    const used = new Set(B.facts.map((fact) => fact.predicate));
    const expected = TRAVERSAL.filter((predicate) => used.has(predicate));
    expect(expected.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(relationsOf(requests[0]!)).toEqual(expected);
    expect(relationsOf(requests[0]!).length).toBeLessThan(TRAVERSAL.length);
  });

  test("a snapshot with no traversal facts still sends one relation", async () => {
    const { engine, requests } = capturingEngine(fakeStore(["NOT_A_RELATION"]));
    await expect(queryChains(engine, [VAULT], "solana:empty", B_ASOF)).rejects.toBeInstanceOf(Stop);
    expect(relationsOf(requests[0]!)).toEqual(TRAVERSAL.slice(0, 1));
  });

  test("an unknown snapshot reports missing coverage instead of failing", async () => {
    const { chains } = await queryChains(engineAccess(evidence.store), [VAULT], "solana:no-such-snapshot", B_ASOF, false);
    expect(chains.get(VAULT)!.reasons.map((reason) => reason.code)).toContain("missing-coverage");
    expect(chains.get(VAULT)!.dependencyFacts).toEqual([]);
  });

  test.if(TRAVERSAL.length > MAX_RELATIONS)("a snapshot using more relations than one query allows fails closed with a pointed code", async () => {
    const { engine, requests } = capturingEngine(fakeStore(TRAVERSAL));
    const thrown = await queryChains(engine, [VAULT], "solana:wide", B_ASOF).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ReviewRunFailed);
    expect((thrown as ReviewRunFailed).code).toBe(`relation-limit:${TRAVERSAL.length}>${MAX_RELATIONS}`);
    expect(requests).toHaveLength(0);
  });
});
