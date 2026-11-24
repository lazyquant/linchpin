/**
 * Independent tests for "Agent preflight": the dependency check an agent runs before it
 * moves money. Written from the approved contract, the frozen plan and the public type
 * declarations; implementation bodies were not read (two slips are disclosed in the run's
 * test report). Everything runs offline: fetch is refused entirely and every socket entry
 * point is spied, so any network attempt fails the suite.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { canonical } from "../src/chain/evidence";
import type { EvidenceStore } from "../src/engine/index";
import { parsePolicy } from "../src/policy/index";
import type { Outcome, Policy, RuleSpec } from "../src/policy/index";
import {
  assertNoNumbersOutsideEvidence, createNearRegistry, evaluateNearPolicy, loadNearLibraries, NO_LIBRARIES,
} from "../src/near/policy/index";
import type { NearLibraries } from "../src/near/policy/index";
import { loadNearSnapshots } from "../src/near/reader/index";
import { parseNearSubject } from "../src/near/reader/types";
import { nearChain } from "../src/near/private/chains";
import { findNearBannedWords } from "../src/near/private/render";
import { reviewIntent } from "../src/near/intents/review";
import { loadIntentContext } from "../src/near/intents/extension";
import { classifyAsset } from "../src/near/intents/rules";
import { createMcpHandler } from "../src/near/mcp/server";
import { TOOLS } from "../src/near/mcp/tools";
import { generateFlowchartHtml, validateFlowchartHtml } from "../src/flowchart/index";
import { runNearCommand } from "../src/near/cli/near";
import * as policyEvaluate from "../src/policy/evaluate";
import {
  PreflightRejected, guard, parseAction, preflight, toFlowchartInput,
  type PreflightContext, type PreflightResult,
} from "../src/near/preflight/index";
import { installOfflineTrap } from "./fixtures/near-agent-preflight/trap";

const REPO = join(import.meta.dir, "..");
const FX = join(import.meta.dir, "fixtures", "near-agent-preflight");
const LIVE = "near-2026-11-09";
const SHIPPED = "quantrin-near-v1";
const N = (account: string) => `near:mainnet:${account}`;
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ETH = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const UNDOCUMENTED = "1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const BURROW = "contract.main.burrow.near";
const DAO = "sputnik-dao.near";
const STRANGER = "nobody-here.near";
const burrowCall = { kind: "contract-call" as const, receiver: BURROW };
const daoCall = { kind: "contract-call" as const, receiver: DAO };
const strangerCall = { kind: "contract-call" as const, receiver: STRANGER };
const swapToUndocumented = { kind: "intents-swap" as const, originAsset: USDC, destinationAsset: UNDOCUMENTED };
const swapOverTokenList = { kind: "intents-swap" as const, originAsset: USDC, destinationAsset: ETH };
const registry = createNearRegistry(NO_LIBRARIES);
const fixturePolicy = (name: string): Policy => parsePolicy(JSON.parse(readFileSync(join(FX, name), "utf8")), registry);
const CANARY_BOOK = join(REPO, "tests", "fixtures", "near-private-risk-manager", "book-canary.json");
const CANARIES = ["cnry-id-q9x4h2", "cnry-owner-z7k3m1", "73519.000284731"];

// ---------------------------------------------------------------------------
// Offline guard, scratch space, shared fixtures
// ---------------------------------------------------------------------------
const trap = installOfflineTrap();
afterAll(() => {
  trap.restore();
  expect(trap.attempts).toEqual([]);
});

const scratch: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "linchpin-preflight-")); scratch.push(d); return d; };
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** The demo's stdout, captured by the scripted-injection describe and re-read by the words test. */
let demoStdout = "";

let store: EvidenceStore;
let libs: NearLibraries;
let ctx: PreflightContext;
let quantrin: Policy;
let quantrinRaw: Policy;
let policyWithin: Policy;
let policyUndetermined: Policy;
let policyOutside: Policy;
let policyIntentsPaused: Policy;

beforeAll(async () => {
  store = loadNearSnapshots([LIVE]);
  libs = await loadNearLibraries();
  ctx = { store, snapshotId: LIVE, libs };
  quantrinRaw = JSON.parse(readFileSync(join(REPO, "fixtures", "near", "policies", `${SHIPPED}.json`), "utf8")) as Policy;
  quantrin = parsePolicy(quantrinRaw, registry);
  policyWithin = fixturePolicy("policy-dao-within.json");
  policyUndetermined = fixturePolicy("policy-dao-undetermined.json");
  policyOutside = fixturePolicy("policy-dao-outside.json");
  policyIntentsPaused = fixturePolicy("policy-intents-paused.json");
  preflight(burrowCall, quantrin, ctx); // warm the cold evaluation path once
}, 60_000);

/** Run a CLI module in-process with stdout, stderr and console captured. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const log = console.log, error = console.error, warn = console.warn, info = console.info;
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  const joinArgs = (a: unknown[]) => a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n";
  console.log = (...a: unknown[]) => { out += joinArgs(a); }; console.info = console.log;
  console.error = (...a: unknown[]) => { err += joinArgs(a); }; console.warn = console.error;
  (process.stdout as any).write = (c: unknown) => { out += String(c); return true; };
  (process.stderr as any).write = (c: unknown) => { err += String(c); return true; };
  try { const code = await fn(); return { code, out, err }; }
  finally {
    console.log = log; console.error = error; console.warn = warn; console.info = info;
    (process.stdout as any).write = so; (process.stderr as any).write = se;
  }
}

const preflightCli = (action: unknown, policy: string, ...rest: string[]) =>
  capture(() => runNearCommand(["preflight", "--action", JSON.stringify(action), "--policy", policy, ...rest, "--offline"]));

/** Recomputed from the contract's applicability rule, independently of the module under test. */
const ruleNames = (rule: RuleSpec): string[] => {
  const p = rule.params as Record<string, unknown>;
  const names: string[] = [];
  for (const key of ["contract", "account", "dao", "subject"]) if (typeof p[key] === "string") names.push(p[key] as string);
  if (Array.isArray(p.accounts)) for (const v of p.accounts) if (typeof v === "string") names.push(v);
  if (rule.kind === "unchanged-since" && Array.isArray(p.factKeys))
    for (const v of p.factKeys) if (typeof v === "string") names.push(v.split("|")[0]);
  return names;
};
const appliesTo = (rule: RuleSpec, touched: string[], assets: string[]): boolean =>
  ruleNames(rule).some(s => touched.includes(s)) || (typeof (rule.params as Record<string, unknown>).assetId === "string" && assets.includes((rule.params as Record<string, unknown>).assetId as string));
const worstOf = (outcomes: Outcome[]): Outcome | null =>
  outcomes.includes("outside-policy") ? "outside-policy" : outcomes.includes("undetermined") ? "undetermined" : outcomes.length ? "within-policy" : null;

// ===========================================================================
// AC1 action parsing
// ===========================================================================
describe("AC1 action parsing", () => {
  const REJECTIONS: [string, unknown][] = [
    ["an unknown kind", { kind: "governance-vote" }],
    ["a missing origin asset", { kind: "intents-swap", destinationAsset: ETH }],
    ["a missing destination asset", { kind: "intents-swap", originAsset: USDC }],
    ["a missing receiver", { kind: "contract-call" }],
    ["an asset id the asset parser refuses", { kind: "intents-swap", originAsset: "nep999:x", destinationAsset: ETH }],
    ["a receiver that is not an account", { kind: "contract-call", receiver: "Bad Account" }],
    ["a receiver carrying a role marker", { kind: "contract-call", receiver: N("intents.near#role:DAO") }],
    ["an extra amount field", { kind: "contract-call", receiver: DAO, amount: "1" }],
    ["an extra sender field", { kind: "contract-call", receiver: DAO, sender: "someone.near" }],
    ["an extra quantity field", { kind: "contract-call", receiver: DAO, quantity: "1" }],
    ["an extra memo field", { kind: "contract-call", receiver: DAO, memo: "note" }],
  ];

  for (const [why, input] of REJECTIONS) {
    test(`it refuses ${why}`, () => {
      let caught: unknown = null;
      try { parseAction(input); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(PreflightRejected);
      expect((caught as PreflightRejected).code).toBe("invalid-action");
    });
  }

  test("the refusal of a bad receiver is the reader's, not the check's own invention", () => {
    expect(parseNearSubject("Bad Account")).toBeNull();
    expect(parseNearSubject(N("intents.near#role:DAO"))?.kind).not.toBeNull();
    expect(parseNearSubject(N(DAO))).not.toBeNull();
  });

  test("it parses both kinds, normalises the receiver and carries the method only when given", () => {
    expect(canonical(parseAction({ kind: "intents-swap", originAsset: USDC, destinationAsset: ETH }))).toBe(canonical(swapOverTokenList));
    const bare = parseAction({ kind: "contract-call", receiver: BURROW }) as { receiver: string };
    const prefixed = parseAction({ kind: "contract-call", receiver: N(BURROW) }) as { receiver: string };
    expect(bare.receiver).toBe(N(BURROW));
    expect(prefixed.receiver).toBe(N(BURROW));
    expect((parseAction({ kind: "contract-call", receiver: DAO, method: "ft_transfer_call" }) as any).method).toBe("ft_transfer_call");
    expect("method" in parseAction({ kind: "contract-call", receiver: DAO })).toBe(false);
  });

  test("nothing is evaluated after a rejection", () => {
    const spy = spyOn(policyEvaluate, "evaluatePolicy");
    try {
      for (const [, input] of REJECTIONS) expect(() => preflight(input, quantrin, ctx)).toThrow();
      expect(spy.mock.calls.length).toBe(0);
      preflight(burrowCall, quantrin, ctx); // sensitivity: a valid action does reach the engine
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally { spy.mockRestore(); }
  });
});

// ===========================================================================
// AC2 touched subjects
// ===========================================================================
describe("AC2 touched subjects", () => {
  test("a contract call touches the receiver and every subject its chain states", () => {
    const chain = nearChain(store, LIVE, N(BURROW));
    const expected = [...new Set([N(BURROW), ...chain.facts.map(f => f.subject)])].sort();
    const r = preflight(burrowCall, quantrin, ctx);
    expect(r.touched).toEqual(expected);
    expect(r.touched).toEqual([...r.touched].sort());
    expect(new Set(r.touched).size).toBe(r.touched.length);
    expect(r.touched).toContain(N(BURROW));
    expect(r.touched).toContain(N("burrow.sputnik-dao.near"));
    expect(r.touched).toContain(N("aggregate-oracle.near"));
    expect(r.touched.length).toBe(11);
  });

  test("a swap touches the intents root plus the subjects of both asset reviews", () => {
    const ictx = loadIntentContext({ snapshotId: LIVE });
    const hops = [USDC, ETH].flatMap(a => reviewIntent({ kind: "asset", assetId: a }, ictx).chain.map(h => h.subject).filter((s): s is string => s !== null));
    const expected = [...new Set([N("intents.near"), ...hops])].sort();
    const r = preflight(swapOverTokenList, policyIntentsPaused, ctx);
    expect(r.touched).toEqual(expected);
    expect(r.touched).toContain(N("intents.near"));
  }, 30_000);

  test("without the intent library the swap touches only the intents root and reports the gap", () => {
    const r = preflight(swapOverTokenList, policyIntentsPaused, { store, snapshotId: LIVE, libs: NO_LIBRARIES });
    expect(r.touched).toEqual([N("intents.near")]);
    expect(r.unknowns).toContainEqual({ code: "missing-coverage", subject: null, ref: "library:near-intent-review" });
  }, 30_000);
});

// ===========================================================================
// AC3 applicable rules and outcome, lender
// ===========================================================================
describe("AC3 applicable rules over the shipped policy", () => {
  const APPLICABLE = [
    "rhea-pause-operator", "dao-factory-keys", "core-contract-keys", "rhea-oracle-controller", "rhea-oracle-enabled",
    "rhea-dao-threshold", "rhea-dao-open-funds", "rhea-open-touching", "control-unchanged",
  ];
  const NOT_APPLICABLE = ["intents-not-paused", "intents-locker-max", "intents-pausers-min", "intents-no-upgrade", "intents-council-30d", "usdc-route-family", "mpc-threshold"];

  test("the applicable rules are exactly the nine the contract's rule names, in policy order", () => {
    const r = preflight(burrowCall, quantrin, ctx);
    expect(r.applicable.map(x => x.ruleId)).toEqual(APPLICABLE);
    expect(r.notApplicable).toEqual(NOT_APPLICABLE);
    expect(r.outcome).toBe("outside-policy");
    expect(r.gate).toBe("closed");
  });

  test("recomputed from the policy text, the split matches", () => {
    const r = preflight(burrowCall, quantrin, ctx);
    const applicableIds = quantrinRaw.rules.filter(x => appliesTo(x, r.touched, [])).map(x => x.id);
    expect(r.applicable.map(x => x.ruleId)).toEqual(applicableIds);
    expect(r.notApplicable).toEqual(quantrinRaw.rules.map(x => x.id).filter(id => !applicableIds.includes(id)));
  });

  test("each applicable entry equals the same rule's entry in a verdict over the whole policy", () => {
    const r = preflight(burrowCall, quantrin, ctx);
    const full = evaluateNearPolicy(quantrin, store, LIVE, libs);
    expect(full.outcome).toBe("outside-policy");
    expect(r.outcome).toBe("outside-policy");
    expect(r.gate).toBe("closed");
    for (const entry of r.applicable) {
      const whole = full.rules.find(x => x.ruleId === entry.ruleId);
      expect(whole).toBeDefined();
      expect(entry.outcome).toBe(whole!.outcome);
      expect(entry.factIds).toEqual(whole!.factIds);
      expect(entry.receiptIds).toEqual(whole!.receiptIds);
      expect(canonical(entry)).toBe(canonical({
        ruleId: whole!.ruleId, kind: whole!.kind, outcome: whole!.outcome,
        reasons: whole!.reasons, factIds: whole!.factIds, receiptIds: whole!.receiptIds,
      }));
    }
  }, 60_000);
});

// ===========================================================================
// AC4 outcome combinator, over constructed policies on the same snapshot
// ===========================================================================
describe("AC4 outcome combinator", () => {
  test("only within-policy rules applicable: within-policy, gate open", () => {
    const r = preflight(daoCall, policyWithin, ctx);
    expect(r.applicable.map(x => x.outcome)).toEqual(["within-policy", "within-policy"]);
    expect(r.outcome).toBe("within-policy");
    expect(r.gate).toBe("open");
  });

  test("adding an undetermined rule: undetermined, gate human", () => {
    const r = preflight(daoCall, policyUndetermined, ctx);
    const pause = r.applicable.find(x => x.ruleId === "dao-pause-operator");
    expect(pause?.outcome).toBe("undetermined");
    expect(r.outcome).toBe("undetermined");
    expect(r.gate).toBe("human");
  });

  test("adding an outside-policy rule: outside-policy, gate closed", () => {
    const r = preflight(daoCall, policyOutside, ctx);
    const keys = r.applicable.find(x => x.ruleId === "dao-keys");
    expect(keys?.outcome).toBe("outside-policy");
    expect(r.outcome).toBe("outside-policy");
    expect(r.gate).toBe("closed");
  });

  test("a policy with no applicable rule is silence, and silence is never a pass", () => {
    const r = preflight(daoCall, policyIntentsPaused, ctx);
    expect(r.applicable).toEqual([]);
    expect(r.unknowns).toContainEqual({ code: "no-applicable-rule", subject: null, ref: "preflight-intents-paused" });
    expect(r.outcome).toBe("undetermined");
    expect(r.outcome).not.toBe("within-policy");
    expect(r.gate).toBe("human");
  });
});

// ===========================================================================
// AC5 coverage is never a pass
// ===========================================================================
describe("AC5 coverage is never a pass", () => {
  test("a receiver outside the snapshot: undetermined, human gate, missing-subject, nothing applicable, receiver not-covered", () => {
    const r = preflight(strangerCall, quantrin, ctx);
    expect(r.outcome).toBe("undetermined");
    expect(r.gate).toBe("human");
    expect(r.applicable).toEqual([]);
    expect(r.unknowns).toContainEqual({ code: "missing-subject", subject: N(STRANGER), ref: LIVE });
    expect(r.unknowns).toContainEqual({ code: "no-applicable-rule", subject: null, ref: SHIPPED });
    expect(r.graph.nodes[0].kind).toBe("action");
    const subjects = r.graph.nodes.filter(n => n.kind === "subject");
    expect(subjects.map(n => n.id)).toEqual([N(STRANGER)]);
    expect(subjects[0].coverage).toBe("not-covered");
    expect(r.graph.edges).toEqual([]);
  });

  test("precondition: the far asset of the swap really has no documented route family", () => {
    expect(classifyAsset(UNDOCUMENTED).family).toBe("undocumented");
    expect(classifyAsset(USDC).family).toBe("near_withdrawal");
  });

  test("a swap into the undocumented asset under an all-within policy stays undetermined", () => {
    const r = preflight(swapToUndocumented, policyIntentsPaused, ctx);
    expect(r.applicable.map(x => x.outcome)).toEqual(["within-policy"]);
    expect(r.outcome).toBe("undetermined");
    expect(r.outcome).not.toBe("within-policy");
    expect(r.gate).toBe("human");
    expect(r.unknowns).toContainEqual({ code: "missing-coverage", subject: null, ref: UNDOCUMENTED });
  });

  test("the same swap under the shipped policy is outside the policy", () => {
    const r = preflight(swapToUndocumented, quantrin, ctx);
    expect(r.outcome).toBe("outside-policy");
    expect(r.gate).toBe("closed");
  });

  test("every chain reason and every review reason is carried into unknowns unchanged", () => {
    const burrow = preflight(burrowCall, quantrin, ctx);
    for (const q of nearChain(store, LIVE, N(BURROW)).reasons) expect(burrow.unknowns).toContainEqual(q);
    const ictx = loadIntentContext({ snapshotId: LIVE });
    const swap = preflight(swapToUndocumented, policyIntentsPaused, ctx);
    for (const asset of [USDC, UNDOCUMENTED])
      for (const q of reviewIntent({ kind: "asset", assetId: asset }, ictx).unknowns) expect(swap.unknowns).toContainEqual(q);
  }, 60_000);

  test("subjects outside the base snapshot are not-covered; covered ones stay covered", () => {
    const r = preflight(swapOverTokenList, policyIntentsPaused, ctx);
    const baseSubjects = store.snapshot(LIVE)!.subjects;
    for (const n of r.graph.nodes) {
      if (n.kind !== "subject") continue;
      expect({ id: n.id, coverage: n.coverage }).toEqual({ id: n.id, coverage: baseSubjects.includes(n.id) ? "covered" : "not-covered" });
    }
    expect(r.graph.nodes.find(n => n.id === N("intents.near"))?.coverage).toBe("covered");
    const tokenNode = r.graph.nodes.find(n => n.id.includes("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"));
    expect(tokenNode?.coverage).toBe("not-covered");
  }, 60_000);
});

// ===========================================================================
// AC6 the guard
// ===========================================================================
describe("AC6 the guard", () => {
  test("an open gate calls the executor exactly once, with its own copy, and returns its value", async () => {
    const seen: PreflightResult[] = [];
    const g = await guard(daoCall, policyWithin, ctx, async r => { seen.push(r); return "recorded, nothing sent"; });
    expect(g.executed).toBe(true);
    expect(g.value).toBe("recorded, nothing sent");
    expect(seen.length).toBe(1);
    expect(canonical(seen[0])).toBe(canonical(preflight(daoCall, policyWithin, ctx)));
  });

  test("the executor cannot alter the result the guard returns", async () => {
    const g = await guard(daoCall, policyWithin, ctx, r => { r.touched.push("mutated"); return "ok"; });
    expect(g.executed).toBe(true);
    expect(g.result.touched).not.toContain("mutated");
    expect(canonical(g.result)).toBe(canonical(preflight(daoCall, policyWithin, ctx)));
  });

  test("a closed gate never calls the executor", async () => {
    let calls = 0;
    const g = await guard(burrowCall, quantrin, ctx, () => { calls += 1; return null; });
    expect(g.executed).toBe(false);
    expect(g.value).toBeNull();
    expect(calls).toBe(0);
  });

  test("a human gate never calls the executor", async () => {
    let calls = 0;
    const g = await guard(strangerCall, quantrin, ctx, () => { calls += 1; return null; });
    expect(g.executed).toBe(false);
    expect(g.value).toBeNull();
    expect(calls).toBe(0);
  });

  test("an executor that mutates its argument and throws: the error propagates unchanged", async () => {
    const before = canonical(preflight(daoCall, policyWithin, ctx));
    const boom = new Error("recording executor refused");
    let caught: unknown = null;
    try {
      await guard(daoCall, policyWithin, ctx, r => { r.touched.push("mutated"); throw boom; });
    } catch (e) { caught = e; }
    expect(caught).toBe(boom);
    expect(canonical(preflight(daoCall, policyWithin, ctx))).toBe(before);
  });

  test("a rejected action: the guard rejects and the executor is never called", async () => {
    let calls = 0;
    let caught: unknown = null;
    try { await guard({ kind: "governance-vote" }, policyWithin, ctx, () => { calls += 1; return null; }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PreflightRejected);
    expect((caught as PreflightRejected).code).toBe("invalid-action");
    expect(calls).toBe(0);
  });

  test("the module carries no signing, sending or key material in its code", () => {
    const dir = join(REPO, "src", "near", "preflight");
    const files = readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? [] : [join(dir, e.name)]);
    const tsFiles = files.filter(f => f.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThanOrEqual(6);
    const markers = ["sign", "sendTransaction", "broadcast", "secretKey", "deposit_address"];
    for (const f of tsFiles) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      const code = lines.filter(l => {
        const t = l.trim();
        return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
      });
      for (const m of markers)
        expect({ file: relative(dir, f), marker: m, hit: code.some(l => l.includes(m)) }).toEqual({ file: relative(dir, f), marker: m, hit: false });
    }
    const readme = files.find(f => f.endsWith("README.md"));
    expect(readme).toBeDefined();
    for (const l of readFileSync(readme!, "utf8").split(/\r?\n/)) {
      if (!markers.some(m => l.includes(m))) continue;
      expect({ line: l, exempt: /\b(not|no|never)\b/.test(l) }).toEqual({ line: l, exempt: true });
    }
  });
});

// ===========================================================================
// AC7 the dependency graph
// ===========================================================================
describe("AC7 the dependency graph", () => {
  let result: PreflightResult;
  beforeAll(() => { result = preflight(burrowCall, quantrin, ctx); });

  test("one claimed action node, subject nodes matching touched one to one", () => {
    const actionNodes = result.graph.nodes.filter(n => n.kind === "action");
    expect(actionNodes.length).toBe(1);
    expect(actionNodes[0].id).toBe("action");
    expect(actionNodes[0].basis).toBe("claimed");
    expect(actionNodes[0].coverage).toBeNull();
    expect(actionNodes[0].outcome).toBeNull();
    const subjectNodes = result.graph.nodes.filter(n => n.kind === "subject");
    expect(subjectNodes.map(n => n.id)).toEqual(result.touched);
    for (const n of subjectNodes) expect(n.basis).toBeNull();
  });

  test("every edge is a stated fact, no such fact is missed, and no edge touches the action node", () => {
    const snap = store.snapshot(LIVE)!;
    const byId = new Map(snap.facts.map(f => [f.id, f]));
    const expected = snap.facts.filter(f => f.evidenceIds.length > 0 && result.touched.includes(f.subject) && result.touched.includes(f.object));
    expect(result.graph.edges.length).toBe(expected.length);
    expect(result.graph.edges.length).toBe(12);
    for (const e of result.graph.edges) {
      const f = byId.get(e.factId);
      expect(f).toBeDefined();
      expect(e.from).toBe(f!.subject);
      expect(e.to).toBe(f!.object);
      expect(e.predicate).toBe(f!.predicate);
      expect(e.basis).toBe(f!.basis);
      expect(e.receiptIds.length).toBeGreaterThan(0);
      expect(e.receiptIds).toEqual([...f!.evidenceIds].sort());
      expect(e.from).not.toBe("action");
      expect(e.to).not.toBe("action");
    }
  });

  test("each subject's outcome is the worst among the applicable rules that name it, else no-rule", () => {
    for (const n of result.graph.nodes) {
      if (n.kind !== "subject") continue;
      const naming = result.applicable.filter(a => {
        const rule = quantrinRaw.rules.find(x => x.id === a.ruleId);
        return rule !== undefined && ruleNames(rule).includes(n.id);
      });
      const expected = naming.length ? worstOf(naming.map(a => a.outcome)) : "no-rule";
      expect({ id: n.id, outcome: n.outcome }).toEqual({ id: n.id, outcome: expected });
    }
    expect(result.graph.nodes.find(n => n.id === N(BURROW))?.outcome).toBe("outside-policy");
    expect(result.graph.nodes.find(n => n.id === N("aggregate-oracle.near"))?.outcome).toBe("undetermined");
    expect(result.graph.nodes.find(n => n.id === N("burrow.sputnik-dao.near"))?.outcome).toBe("within-policy");
    expect(result.graph.nodes.find(n => n.id === N("v2.ref-finance.near"))?.outcome).toBe("no-rule");
  });

  test("the chart face: the CLI writes a chart the flowchart validator accepts", async () => {
    const dir = tmp();
    const chart = join(dir, "chart.html");
    const r = await preflightCli(burrowCall, SHIPPED, "--chart", chart);
    expect(r.code).toBe(4);
    const html = readFileSync(chart, "utf8");
    expect(html.length).toBeGreaterThan(0);
    expect(validateFlowchartHtml(html, toFlowchartInput(result))).toEqual([]);
  }, 60_000);
});

// ===========================================================================
// AC8 equal answers on three faces
// ===========================================================================
describe("AC8 one engine, three faces", () => {
  const MCP_TOKEN = "preflight-suite-local-token-not-a-credential-0001";
  const accessLog: string[] = [];
  let handler: (req: Request) => Promise<Response>;
  let pureJson: string;

  beforeAll(async () => {
    pureJson = canonical(preflight(burrowCall, quantrin, ctx)); // also warms every cache the call needs
    handler = createMcpHandler({ token: MCP_TOKEN, snapshotId: LIVE, store, libs, now: () => 0, accessLog: l => accessLog.push(l) });
  });

  const rpc = async (method: string, params?: unknown): Promise<{ status: number; text: string; json: any }> => {
    const body: Record<string, unknown> = { jsonrpc: "2.0", id: 7, method };
    if (params !== undefined) body.params = params;
    const res = await handler(new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

  test("the pure face, the CLI face and the MCP face are byte-identical for the lender call", async () => {
    const cli = await preflightCli(burrowCall, SHIPPED, "--json");
    expect(cli.code).toBe(4);
    expect(cli.out.trim()).toBe(pureJson);
    const mcp = await call("linchpin_preflight", { action: burrowCall, policyId: SHIPPED });
    expect(mcp.status).toBe(200);
    expect(mcp.json.result.isError).toBeFalsy();
    expect(canonical(mcp.json.result.structuredContent)).toBe(pureJson);
  }, 30_000);

  test("tools/list keeps the eight baseline tools in order and adds the preflight tool as the ninth", async () => {
    const BASELINE = ["linchpin_subjects", "linchpin_dependencies", "linchpin_control", "linchpin_changes", "linchpin_evidence", "linchpin_intent_review", "linchpin_governance_review", "linchpin_policy_verdict"];
    const mcp = await rpc("tools/list");
    const names = mcp.json.result.tools.map((t: any) => t.name);
    expect(names.slice(0, BASELINE.length)).toEqual(BASELINE);
    expect(names[8]).toBe("linchpin_preflight");
    expect(names.length).toBe(9);
    expect(TOOLS.length).toBe(9);
  });

  test("an action carrying an amount is refused with the invalid-params error", async () => {
    const mcp = await call("linchpin_preflight", { action: { kind: "contract-call", receiver: DAO, amount: "1" }, policyId: SHIPPED });
    expect(mcp.json.error?.code).toBe(-32602);
  });

  test("a schema-valid action of an impossible shape is refused with the same error", async () => {
    const mcp = await call("linchpin_preflight", { action: { kind: "contract-call", originAsset: USDC }, policyId: SHIPPED });
    expect(mcp.json.error?.code).toBe(-32602);
  });

  test("an unknown policy id fails exactly as the verdict tool fails for it", async () => {
    const preflightReply = await call("linchpin_preflight", { action: burrowCall, policyId: "no-such-policy" });
    const verdictReply = await call("linchpin_policy_verdict", { policyId: "no-such-policy" });
    expect(preflightReply.json.result.isError).toBe(true);
    expect(canonical(preflightReply.json.result.structuredContent))
      .toBe(canonical(verdictReply.json.result.structuredContent));
  });

  test("with the canary book loaded, no canary value appears in any preflight response", async () => {
    const book = readFileSync(CANARY_BOOK, "utf8");
    for (const c of CANARIES) expect(book).toContain(c); // positive control: the fixture really carries them
    const previous = process.env.LINCHPIN_NEAR_POSITIONS;
    process.env.LINCHPIN_NEAR_POSITIONS = CANARY_BOOK;
    try {
      const bodies = [
        await call("linchpin_preflight", { action: burrowCall, policyId: SHIPPED }),
        await call("linchpin_preflight", { action: swapToUndocumented, policyId: SHIPPED }),
        await call("linchpin_preflight", { action: strangerCall, policyId: SHIPPED }),
        await call("linchpin_preflight", { action: burrowCall, policyId: "no-such-policy" }),
      ];
      for (const b of bodies)
        for (const c of CANARIES) expect(b.text.includes(c)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.LINCHPIN_NEAR_POSITIONS; else process.env.LINCHPIN_NEAR_POSITIONS = previous;
    }
  }, 60_000);
});

// ===========================================================================
// AC9 CLI and exit codes
// ===========================================================================
describe("AC9 command faces and exit codes", () => {
  test("an open outcome exits 0", async () => {
    const r = await preflightCli(daoCall, join(FX, "policy-dao-within.json"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("gate: open");
    expect(r.out).toContain("outcome: within-policy");
  }, 30_000);

  test("an undetermined outcome exits 3", async () => {
    const r = await preflightCli(strangerCall, SHIPPED);
    expect(r.code).toBe(3);
    expect(r.out).toContain("gate: human");
  }, 30_000);

  test("a closed outcome exits 4", async () => {
    const r = await preflightCli(burrowCall, SHIPPED);
    expect(r.code).toBe(4);
    expect(r.out).toContain("gate: closed");
  }, 30_000);

  for (const [why, args] of [
    ["unparsable action text", ["--action", "{not json", "--policy", SHIPPED]],
    ["an action with an amount", ["--action", JSON.stringify({ kind: "contract-call", receiver: DAO, amount: "1" }), "--policy", SHIPPED]],
    ["an unknown policy id", ["--action", JSON.stringify(strangerCall), "--policy", "no-such-policy"]],
  ] as const) {
    test(`a rejected ${why} exits 2 with one stderr line and empty stdout`, async () => {
      const r = await capture(() => runNearCommand(["preflight", ...args, "--offline"]));
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err.trim().length).toBeGreaterThan(0);
    });
  }

  test("the exit code reaches the process: a subprocess run of the closed case exits 4", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "near", "preflight", "--action", JSON.stringify(burrowCall), "--policy", SHIPPED, "--offline", "--json"],
      cwd: REPO, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(4);
    expect(stdout.trim()).toBe(canonical(preflight(burrowCall, quantrin, ctx)));
  }, 90_000);

  test("the text face prints the gate, the outcome, one line per rule and a count-free unknown list", async () => {
    const r = await preflightCli(burrowCall, SHIPPED);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("gate: closed");
    expect(lines[1]).toBe("outcome: outside-policy");
    const checked = preflight(burrowCall, quantrin, ctx);
    const ruleLines = lines.filter(l => l.startsWith("rule: "));
    expect(ruleLines).toHaveLength(checked.applicable.length);
    for (const a of checked.applicable) expect(r.out).toContain(`rule: ${a.ruleId} ${a.outcome}`);
    const outsideLines = lines.filter(l => l.includes("outside the policy"));
    expect(outsideLines).toHaveLength(checked.applicable.filter(a => a.outcome === "outside-policy").length);
    const unknownLines = lines.filter(l => l.startsWith("unknown: "));
    expect(unknownLines).toHaveLength(checked.unknowns.length);
    expect(r.out).not.toMatch(/^\d+ unknown/m);
    expect(r.out).not.toMatch(/unknowns?: \d/m);
  }, 30_000);

  test("no number outside evidence survives into any JSON form", async () => {
    for (const action of [burrowCall, swapToUndocumented, strangerCall]) {
      const r = await preflightCli(action, SHIPPED, "--json");
      expect(r.code).toBeGreaterThan(0);
      assertNoNumbersOutsideEvidence(JSON.parse(r.out.trim()));
    }
  }, 60_000);
});

// ===========================================================================
// AC10 replay and isolation
// ===========================================================================
describe("AC10 replay and isolation", () => {
  const runCli = (extra: string[]) => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli.ts", "near", "preflight", "--action", JSON.stringify(burrowCall), "--policy", SHIPPED, "--offline", ...extra],
      cwd: REPO, stdout: "pipe", stderr: "pipe",
    });
    return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]) as Promise<[string, string, number]>;
  };

  test("two offline runs give byte-identical stdout and a byte-identical chart", async () => {
    const a = tmp(), b = tmp();
    const [out1, err1, code1] = await runCli(["--json", "--chart", join(a, "chart.html")]);
    const [out2, err2, code2] = await runCli(["--json", "--chart", join(b, "chart.html")]);
    expect(code1).toBe(4);
    expect(code2).toBe(4);
    expect(err1).toBe("");
    expect(err2).toBe("");
    expect(out2).toBe(out1);
    expect(readFileSync(join(b, "chart.html"), "utf8")).toBe(readFileSync(join(a, "chart.html"), "utf8"));
  }, 120_000);
});

// ===========================================================================
// AC11 scripted injection demo
// ===========================================================================
describe("AC11 scripted injection demo", () => {
  let demoCode = -1;

  test("the injected instruction is shown as tool output and the gate holds", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "scripts/near-preflight-demo.ts", "--offline"],
      cwd: REPO, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    demoStdout = stdout;
    demoCode = code;
    const injected = stdout.slice(0, stdout.indexOf("transcript: within"));
    const transcript = JSON.parse(readFileSync(join(REPO, "fixtures", "near", "preflight", "injected.json"), "utf8"));
    const toolTurn = transcript.turns.find((t: any) => t.role === "tool");
    const proposal = transcript.turns.find((t: any) => t.role === "agent").proposal;
    expect(injected).toContain(`tool output (${toolTurn.tool}): ${toolTurn.text}`);
    expect(injected).toContain(`proposed action: ${canonical(proposal)}`);
    expect(injected).toContain("gate: closed");
    expect(injected).toContain("outside the policy `preflight-demo`: rule `intents-locker-max`");
    expect(injected).toContain("executed: false");
    expect(injected).not.toContain("executed: true");
  }, 90_000);

  test("the within transcript opens the gate and the recording executor runs once", async () => {
    expect(demoCode).toBe(0);
    const within = demoStdout.slice(demoStdout.indexOf("transcript: within"));
    expect(within).toContain("gate: open");
    expect(within).toContain("executed: true");
    expect(within).toContain("value: recorded, nothing sent");
  });

  test("the demo's words hold: no banned word in the whole output", () => {
    expect(demoCode).toBe(0);
    expect(findNearBannedWords(demoStdout)).toEqual([]);
    expect(demoStdout).not.toMatch(/\b(should|recommend\w*|safe|unsafe|score|rating|buy|sell|exit)\b/i);
  });

  test("two runs are byte-identical", async () => {
    const run = async () => {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "scripts/near-preflight-demo.ts", "--offline"],
        cwd: REPO, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, code };
    };
    const one = await run();
    const two = await run();
    expect(one.code).toBe(0);
    expect(two.code).toBe(0);
    expect(two.stdout).toBe(one.stdout);
    expect(one.stdout).toBe(demoStdout);
  }, 90_000);

  test("the injected proposal's unknowns de-duplicate to twenty under the demo policy", () => {
    const transcript = JSON.parse(readFileSync(join(REPO, "fixtures", "near", "preflight", "injected.json"), "utf8"));
    const proposal = transcript.turns.find((t: any) => t.role === "agent").proposal;
    const demoPolicy = parsePolicy(JSON.parse(readFileSync(join(REPO, "fixtures", "near", "preflight", "policy-demo.json"), "utf8")), registry);
    const r = preflight(proposal, demoPolicy, ctx);
    expect(r.unknowns.length).toBe(20);
    expect(new Set(r.unknowns.map(canonical)).size).toBe(20);
    expect(r.gate).toBe("closed");
  }, 30_000);
});

// ===========================================================================
// AC12 manifest, words, public tree
// ===========================================================================
describe("AC12 manifest, words and the public tree", () => {
  const allowlistPath = join(REPO, "scripts", "publish" + ".allowlist");
  const allowlistExists = existsSync(allowlistPath);
  const sections = () => {
    const out: Record<string, string[]> = {};
    let current = "";
    for (const raw of readFileSync(allowlistPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) { current = line.slice(1, -1); out[current] = []; } else out[current].push(line);
    }
    return out;
  };
  const forbidden = (): string[] => (sections()["forbidden"] ?? []).filter(Boolean);
  const glob = (pattern: string): RegExp => {
    const segments = pattern.split("/").filter((part, i, all) => part !== "**" || all[i - 1] !== "**");
    let source = "^";
    segments.forEach((part, i) => {
      if (part === "**") {
        if (segments.length === 1) source += "[^]+";
        else if (i === segments.length - 1) source += "(?:/[^]+)?";
        else source += (i ? "/" : "") + "(?:[^/]+/)*";
      } else {
        if (i && segments[i - 1] !== "**") source += "/";
        source += part.split("*").map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
      }
    });
    return new RegExp(source + "$");
  };
  const published = (path: string): boolean => {
    let on = false;
    for (const pat of sections().paths) {
      const negated = pat.startsWith("!");
      if (glob(negated ? pat.slice(1) : pat).test(path)) on = !negated;
    }
    return on;
  };
  const filesOf = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesOf(join(dir, e.name)) : [join(dir, e.name)]);

  test("the manifest declares nine tools that match the server, and the ninth's files match its entry", () => {
    const manifest = Bun.TOML.parse(readFileSync(join(REPO, "src", "near", "ironclaw", "linchpin", "manifest.toml"), "utf8")) as any;
    expect(manifest.mcp.max_tools).toBe(9);
    expect(manifest.mcp.max_tools).toBe(TOOLS.length);
    const tools = manifest.tools as any[];
    expect(tools).toHaveLength(9);
    expect(tools.map(t => t.id)).toEqual(TOOLS.map(t => `linchpin.${t.name}`));
    const ninth = tools[8];
    const schema = JSON.parse(readFileSync(join(REPO, "src", "near", "ironclaw", "linchpin", ninth.input_schema_ref), "utf8"));
    expect(schema).toEqual(TOOLS[8].inputSchema);
    const promptPath = join(REPO, "src", "near", "ironclaw", "linchpin", ninth.prompt_doc_ref);
    expect(readFileSync(promptPath, "utf8")).toBe(`${TOOLS[8].description}\n`);
  });

  test("no added word is a banned word", () => {
    const targets: string[] = [
      ...filesOf(join(REPO, "src", "near", "preflight")),
      join(REPO, "src", "near", "cli", "preflight.ts"),
      join(REPO, "src", "near", "ironclaw", "linchpin", "prompts", "linchpin", "linchpin_preflight.md"),
      join(REPO, "src", "near", "ironclaw", "linchpin", "schemas", "linchpin", "linchpin_preflight.input.v1.json"),
      ...filesOf(join(REPO, "fixtures", "near", "preflight")),
    ];
    expect(targets.length).toBeGreaterThanOrEqual(10);
    for (const f of targets)
      expect({ file: relative(REPO, f), hit: /\b(should|recommend\w*|safe|unsafe|score|rating|buy|sell|exit)\b/i.test(readFileSync(f, "utf8")) })
        .toEqual({ file: relative(REPO, f), hit: false });
    const ninth = TOOLS[8];
    expect(findNearBannedWords(ninth.description)).toEqual([]);
    expect(demoStdout).not.toMatch(/\b(should|recommend\w*|safe|unsafe|score|rating|buy|sell|exit)\b/i);
  });

  test.skipIf(!allowlistExists)("the tree this change adds is published, and the demo script is published", () => {
    expect(published("src/near/preflight/index.ts")).toBe(true);
    expect(published("src/near/preflight/guard.ts")).toBe(true);
    expect(published("src/near/cli/preflight.ts")).toBe(true);
    expect(published("fixtures/near/preflight/injected.json")).toBe(true);
    expect(published("fixtures/near/preflight/policy-demo.json")).toBe(true);
    expect(published("tests/near-agent-preflight.test.ts")).toBe(true);
    expect(published("tests/fixtures/near-agent-preflight/policy-dao-within.json")).toBe(true);
    expect(published("scripts/near-preflight-demo.ts")).toBe(true);
  });

  test.skipIf(!allowlistExists)("no public file of this change carries a forbidden marker", () => {
    const markers = forbidden();
    expect(markers.length).toBeGreaterThan(0); // the list itself must not have gone missing
    const targets: string[] = [
      import.meta.path, // this test file
      join(REPO, "scripts", "near-preflight-demo.ts"),
      ...filesOf(join(REPO, "tests", "fixtures", "near-agent-preflight")),
      ...filesOf(join(REPO, "src", "near", "preflight")),
      join(REPO, "src", "near", "cli", "preflight.ts"),
      join(REPO, "src", "near", "ironclaw", "linchpin", "manifest.toml"),
      join(REPO, "src", "near", "ironclaw", "linchpin", "prompts", "linchpin", "linchpin_preflight.md"),
      join(REPO, "src", "near", "ironclaw", "linchpin", "schemas", "linchpin", "linchpin_preflight.input.v1.json"),
      ...filesOf(join(REPO, "fixtures", "near", "preflight")),
    ];
    expect(targets.length).toBeGreaterThan(10);
    for (const f of targets) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      for (const m of markers)
        expect({ file: relative(REPO, f), marker: m, hit: lines.some(l => l.includes(m)) })
          .toEqual({ file: relative(REPO, f), marker: m, hit: false });
    }
  });
});
