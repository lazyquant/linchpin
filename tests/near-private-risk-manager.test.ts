/**
 * Independent tests for the NEAR private risk manager: policy engine, private join,
 * watch, report, MCP server, IronClaw package, public-tree conventions.
 *
 * Written by the tester node from the approved spec, plan 033, the decision log, the
 * exported signatures and the committed fixture bytes. Implementation bodies and
 * implementation.md were not read. Everything is offline: fetch is trapped (only the
 * loopback address of the MCP server under test is allowed), canary values are synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import { canonical } from "../src/chain/evidence";
import { openStore, type EvidenceStore } from "../src/engine/index";
import { runQuery } from "../src/engine/queries/index";
import { loadNearSnapshot, loadNearSnapshots } from "../src/near/reader/index";
import {
  NEAR_POLICY_KINDS, NEAR_TRAVERSAL_RELATIONS, NO_LIBRARIES, createNearRegistry, evaluateNearPolicy, loadNearLibraries,
  loadNearPolicy, nearPolicyContext, referencedSnapshots,
} from "../src/near/policy/index";
import { PositionRejected, loadNearBook, parseNearBook, positionRoot } from "../src/near/private/book";
import { joinPositions } from "../src/near/private/join";
import { buildNearReview } from "../src/near/private/review";
import { NEAR_BANNED_WORDS, findNearBannedWords, renderNearReport } from "../src/near/private/render";
import { nearChain, reviewRoots } from "../src/near/private/chains";
import { renderWatch, watchPolicy } from "../src/near/private/watch";
import { writeLocalReport } from "../src/near/private/report";
import { McpConfigError, SERVER_CAPS, SUPPORTED_PROTOCOL_VERSIONS, startMcpServer, createMcpHandler } from "../src/near/mcp/server";
import { TOOLS } from "../src/near/mcp/tools";
import { assertPublicResponse } from "../src/near/mcp/privacy";
import * as reviewCli from "../src/near/cli/review";
import * as policyCli from "../src/near/cli/policy";
import * as watchCli from "../src/near/cli/watch";
import * as serveCli from "../src/near/cli/serve";
import { PolicyRejected, parsePolicy } from "../src/policy/index";
import { brokenLibraries, fakeLibraries } from "./fixtures/near-private-risk-manager/libraries";
import { LIVE, N, NEAR_ROOT, evaluateRule, liveSnapshot, mutate } from "./fixtures/near-private-risk-manager/rule-store";
import { McpClient, installTrap } from "./fixtures/near-private-risk-manager/mcp-client";

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_ALLOWLIST = existsSync(join(import.meta.dir, "..", "scripts", "publish" + "." + "allowlist"));
const DEV_BOOK = existsSync(join(import.meta.dir, "..", "fixtures", "near", "private", "book-synthetic.json"));

const REPO = join(import.meta.dir, "..");
const FX = join(import.meta.dir, "fixtures", "near-private-risk-manager");
const CONSTRUCTED = "near-constructed-intents-locker-added";
const SHIPPED = "quantrin-near-v1";
const SYNTHETIC_BOOK = join(REPO, "fixtures", "near", "private", "book-synthetic.json");
const CANARY_BOOK = join(FX, "book-canary.json");
const CANARIES = ["cnry-id-q9x4h2", "cnry-owner-z7k3m1", "73519.000284731"];

// Whole-file trap: no outbound network, loopback 127.0.0.1 allowed for the MCP server under test.
/**
 * Measured 2026-11-10 on this worktree (CPU-bound: user time = wall time; repeated in-process runs show no speed-up):
 * one offline `policy` run 6.7 s; `review` 50-60 s; `watch` with the small locker policy 16-40 s; `watch` with the
 * shipped policy 100 s. The cause is the sibling libraries re-verifying the snapshot (a known deviation of this run,
 * reported in test-report.md). Timeout = 10 s + 1.5 x the summed measured cost of the CLI runs in the test, so a
 * regression to well above the measured time still fails. (The default 5 s cannot hold even one run.)
 */
const CLI_COST_MS = { policy: 7_000, review: 60_000, watch: 40_000, watchShipped: 100_000 };
const cliTimeout = (runs: Partial<Record<keyof typeof CLI_COST_MS, number>>) =>
  Math.round(10_000 + 1.5 * (Object.keys(CLI_COST_MS) as (keyof typeof CLI_COST_MS)[]).reduce((t, k) => t + (runs[k] ?? 0) * CLI_COST_MS[k], 0));
const trap = installTrap();
afterAll(() => { trap.restore(); expect(trap.attempts).toEqual([]); });

const scratch: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "linchpin-near-tester-")); scratch.push(d); return d; }
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** Run a CLI module in-process with stdout, stderr and console captured. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "", err = "";
  const log = console.log, error = console.error, warn = console.warn, info = console.info;
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  const join_ = (a: unknown[]) => a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n";
  console.log = (...a: unknown[]) => { out += join_(a); }; console.info = console.log;
  console.error = (...a: unknown[]) => { err += join_(a); }; console.warn = console.error;
  (process.stdout as any).write = (c: unknown) => { out += String(c); return true; };
  (process.stderr as any).write = (c: unknown) => { err += String(c); return true; };
  try { const code = await fn(); return { code, out, err }; }
  finally { console.log = log; console.error = error; console.warn = warn; console.info = info; (process.stdout as any).write = so; (process.stderr as any).write = se; }
}

const liveStore = (): EvidenceStore => loadNearSnapshot(LIVE, { root: NEAR_ROOT });
const pairStore = (): EvidenceStore => loadNearSnapshots([LIVE, CONSTRUCTED], { root: NEAR_ROOT });
const fixtureText = (name: string) => readFileSync(join(FX, name), "utf8");

// ===========================================================================
// AC1 policy engine: 15 kinds x {within, outside, undetermined}
// ===========================================================================
const ONE_DAY = 86_400_000;
const dropFacts = (subject: string, ...predicates: string[]) => (f: { subject: string; predicate: string }) => f.subject === subject && (predicates.length === 0 || predicates.includes(f.predicate));
type Case = { kind: string; within: [Record<string, unknown>, ReturnType<typeof liveSnapshot>?]; outside: [Record<string, unknown>, ReturnType<typeof liveSnapshot>?]; undetermined: [Record<string, unknown>, ReturnType<typeof liveSnapshot>?]; outsideCode: string };

const snapAllProposalsGone = () => mutate({ id: "tst-no-hist", drop: f => f.subject.startsWith(N("intents.sputnik-dao.near#proposal:")) });
const snapNoDeployLog = () => mutate({ id: "tst-no-deploy", drop: f => f.subject === N("ctl-intents.near#deployment:intents.near") });
const snapNoThreshold = () => mutate({ id: "tst-no-thr", drop: dropFacts(N("burrow.sputnik-dao.near"), "vote-threshold") });
const snapNoOracleKeys = () => mutate({ id: "tst-no-keys", drop: dropFacts(N("aggregate-oracle.near"), "has-full-access-key") });
const snapConflictOwner = () => mutate({ id: "tst-conflict", add: [{ subject: N("contract.main.burrow.near"), predicate: "owned-by", object: N("evil-owner.near"), status: "conflicting" }] });

const RULE_CASES: Case[] = [
  { kind: "no-full-access-keys", outsideCode: "full-access-key",
    within: [{ accounts: [N("aggregate-oracle.near")] }], outside: [{ accounts: [N("sputnik-dao.near")] }], undetermined: [{ accounts: [N("aggregate-oracle.near")] }, snapNoOracleKeys()] },
  { kind: "min-threshold", outsideCode: "below-threshold",
    within: [{ dao: N("burrow.sputnik-dao.near"), num: 1, denom: 2 }], outside: [{ dao: N("burrow.sputnik-dao.near"), num: 2, denom: 3 }], undetermined: [{ dao: N("burrow.sputnik-dao.near"), num: 1, denom: 2 }, snapNoThreshold()] },
  { kind: "max-council-change-days", outsideCode: "council-changed",
    within: [{ dao: N("intents.sputnik-dao.near"), days: 3 }], outside: [{ dao: N("intents.sputnik-dao.near"), days: 30 }], undetermined: [{ dao: N("intents.sputnik-dao.near"), days: 30 }, snapAllProposalsGone()] },
  { kind: "pause-operator-set", outsideCode: "no-pause-operator",
    within: [{ contract: N("intents.near") }], outside: [{ contract: N("contract.main.burrow.near") }], undetermined: [{ contract: N("aggregate-oracle.near") }] },
  { kind: "pause-state-is", outsideCode: "paused-state",
    within: [{ contract: N("intents.near"), paused: false }], outside: [{ contract: N("intents.near"), paused: true }], undetermined: [{ contract: N("aggregate-oracle.near"), paused: false }] },
  { kind: "role-grantee-count-max", outsideCode: "grantees-above-max",
    within: [{ contract: N("intents.near"), role: "UnrestrictedAccountLocker", n: 5 }], outside: [{ contract: N("intents.near"), role: "UnrestrictedAccountLocker", n: 1 }], undetermined: [{ contract: N("intents.near"), role: "NoSuchRole", n: 1 }] },
  { kind: "role-grantee-count-min", outsideCode: "grantees-below-min",
    within: [{ contract: N("intents.near"), role: "PauseManager", n: 2 }], outside: [{ contract: N("intents.near"), role: "PauseManager", n: 50 }], undetermined: [{ contract: N("intents.near"), role: "NoSuchRole", n: 1 }] },
  { kind: "controller-resolved", outsideCode: "conflict",
    within: [{ account: N("contract.main.burrow.near") }], outside: [{ account: N("contract.main.burrow.near") }, snapConflictOwner()], undetermined: [{ account: N("aggregate-oracle.near") }] },
  { kind: "oracle-enabled-is", outsideCode: "oracle-not-enabled",
    within: [{ contract: N("contract.main.burrow.near"), account: N("aggregate-oracle.near") }], outside: [{ contract: N("contract.main.burrow.near"), account: N("priceoracle.near") }], undetermined: [{ contract: N("intents.near"), account: N("aggregate-oracle.near") }] },
  { kind: "no-upgrade-since", outsideCode: "upgraded-since",
    within: [{ contract: N("intents.near"), isoDate: "2026-11-09T19:00:00.000Z" }], outside: [{ contract: N("intents.near"), isoDate: "2026-10-01T00:00:00.000Z" }], undetermined: [{ contract: N("intents.near"), isoDate: "2026-10-01T00:00:00.000Z" }, snapNoDeployLog()] },
  { kind: "mpc-threshold-min", outsideCode: "threshold-below-min",
    within: [{ contract: N("v1.signer"), n: 11 }], outside: [{ contract: N("v1.signer"), n: 12 }], undetermined: [{ contract: N("intents.near"), n: 1 }] },
];

describe("AC1 policy engine: every rule kind with a positive, a negative and an undetermined case", () => {
  for (const c of RULE_CASES) {
    test(`${c.kind}: within / outside / undetermined`, () => {
      const w = evaluateRule(c.kind, c.within[0], c.within[1]);
      expect(w.outcome).toBe("within-policy");
      const o = evaluateRule(c.kind, c.outside[0], c.outside[1]);
      expect(o.outcome).toBe("outside-policy");
      expect(o.codes).toContain(c.outsideCode);
      const u = evaluateRule(c.kind, c.undetermined[0], c.undetermined[1]);
      expect(u.outcome).toBe("undetermined");
      expect(u.outcome).not.toBe("within-policy");
      expect(u.codes.length).toBeGreaterThan(0);
      // every outcome names the facts and receipts it read when it read any
      for (const r of [w, o]) { expect(r.rule.factIds.length).toBeGreaterThan(0); expect(r.rule.receiptIds.length).toBeGreaterThan(0); }
    });
  }

  test("unchanged-since: within on the same snapshot, outside when a keyed fact changed, undetermined without the earlier snapshot", () => {
    const key = [N("intents.near#role:UnrestrictedAccountLocker|holds-role")];
    expect(evaluateRule("unchanged-since", { snapshotId: LIVE, factKeys: key }).outcome).toBe("within-policy");
    const constructed = pairStore().snapshot(CONSTRUCTED)!;
    const changed = evaluateRule("unchanged-since", { snapshotId: LIVE, factKeys: key }, constructed, NO_LIBRARIES, [liveSnapshot()]);
    expect(changed.outcome).toBe("outside-policy");
    expect(changed.codes).toContain("changed");
    // a role no one touched stays within on the constructed snapshot
    const stable = evaluateRule("unchanged-since", { snapshotId: LIVE, factKeys: [N("intents.near#role:Upgrader|holds-role")] }, constructed, NO_LIBRARIES, [liveSnapshot()]);
    expect(stable.outcome).toBe("within-policy");
    const missing = evaluateRule("unchanged-since", { snapshotId: "near-2026-01-01", factKeys: key });
    expect(missing.outcome).toBe("undetermined");
  });

  test("route-family-in, no-open-proposal-of-class, no-open-proposal-touching: within / outside / undetermined with fake libraries", () => {
    const store = liveStore();
    const asset = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    const libs = fakeLibraries(store, { families: { [asset]: "near_withdrawal", "nep141:other.near": "poa_bridge", "nep141:unknown.near": null } });
    expect(evaluateRule("route-family-in", { assetId: asset, families: ["near_withdrawal"] }, liveSnapshot(), libs).outcome).toBe("within-policy");
    const out = evaluateRule("route-family-in", { assetId: "nep141:other.near", families: ["near_withdrawal"] }, liveSnapshot(), libs);
    expect(out.outcome).toBe("outside-policy"); expect(out.codes).toContain("route-family-outside");
    const und = evaluateRule("route-family-in", { assetId: "nep141:unknown.near", families: ["near_withdrawal"] }, liveSnapshot(), libs);
    expect(und.outcome).toBe("undetermined"); expect(und.codes).toContain("missing-coverage");

    const dao = N("burrow.sputnik-dao.near");
    expect(evaluateRule("no-open-proposal-of-class", { dao, classes: ["funds"] }, liveSnapshot(), libs).outcome).toBe("within-policy");
    const open = fakeLibraries(store, { overrides: { [N("burrow.sputnik-dao.near#proposal:1746")]: { state: "open", effectClass: "funds" } } });
    const openFunds = evaluateRule("no-open-proposal-of-class", { dao, classes: ["funds"] }, liveSnapshot(), open);
    expect(openFunds.outcome).toBe("outside-policy"); expect(openFunds.codes).toContain("open-proposal");
    // an open proposal of another class does not trip the class rule
    expect(evaluateRule("no-open-proposal-of-class", { dao, classes: ["code"] }, liveSnapshot(), open).outcome).toBe("within-policy");
    const gap = evaluateRule("no-open-proposal-of-class", { dao, classes: ["funds"] }, liveSnapshot(), fakeLibraries(store, { gap: true }));
    expect(gap.outcome).toBe("undetermined"); expect(gap.codes).toContain("missing-coverage");

    const root = N("contract.main.burrow.near");
    expect(evaluateRule("no-open-proposal-touching", { subject: root }, liveSnapshot(), libs).outcome).toBe("within-policy");
    const touch = fakeLibraries(store, { touching: { "contract.main.burrow.near": [N("burrow.sputnik-dao.near#proposal:1746")] }, overrides: { [N("burrow.sputnik-dao.near#proposal:1746")]: { state: "open" } } });
    const t = evaluateRule("no-open-proposal-touching", { subject: root }, liveSnapshot(), touch);
    expect(t.outcome).toBe("outside-policy"); expect(t.codes).toContain("open-proposal");
    const tg = evaluateRule("no-open-proposal-touching", { subject: root }, liveSnapshot(), fakeLibraries(store, { gap: true }));
    expect(tg.outcome).toBe("undetermined");
  });

  test("plan item 5 / AC7: the policy-core R1 (max-share-behind in-scope only) and R5 (stale/no-facts are gap reasons) changes cannot touch a NEAR verdict: no such kind is registered, shipped or evaluated", async () => {
    const libs = await loadNearLibraries();
    for (const l of [NO_LIBRARIES, libs]) {
      const reg = createNearRegistry(l);
      expect(reg.get("max-share-behind")).toBeUndefined();
      expect(reg.kinds()).not.toContain("max-share-behind");
    }
    const policyDoc = JSON.parse(readFileSync(join(REPO, "fixtures", "near", "policies", `${SHIPPED}.json`), "utf8"));
    expect(policyDoc.rules.map((r: any) => r.kind)).not.toContain("max-share-behind");
    const v: any = evaluateNearPolicy(await loadNearPolicy(SHIPPED), liveStore(), LIVE, libs);
    expect(v.rules.map((r: any) => r.kind)).not.toContain("max-share-behind");
    const codes = new Set(v.rules.flatMap((r: any) => r.reasons.map((x: any) => x.code)));
    expect(codes.has("stale")).toBe(false); expect(codes.has("no-facts")).toBe(false);
    // verdict as probed before R1/R5 (AC1 outcomes) is unchanged
    expect(v.outcome).toBe("outside-policy");
  }, 30_000);

  test("the registry has exactly the 15 kinds of P2 and none of the position-dependent generic kinds", () => {
    const P2 = ["no-full-access-keys", "min-threshold", "max-council-change-days", "pause-operator-set", "pause-state-is", "role-grantee-count-max", "role-grantee-count-min", "controller-resolved", "oracle-enabled-is", "no-upgrade-since", "mpc-threshold-min", "route-family-in", "no-open-proposal-of-class", "no-open-proposal-touching", "unchanged-since"].sort();
    expect([...NEAR_POLICY_KINDS]).toEqual(P2);
    const reg = createNearRegistry(NO_LIBRARIES);
    expect(reg.kinds()).toEqual(P2);
    for (const k of ["max-share-behind", "min-exit-evidence", "max-evidence-age"]) expect(reg.get(k)).toBeUndefined();
    // every case table row above covers a registered kind, and together with the three library rules and unchanged-since all 15 are covered
    expect([...RULE_CASES.map(c => c.kind), "route-family-in", "no-open-proposal-of-class", "no-open-proposal-touching", "unchanged-since"].sort()).toEqual(P2);
  });

  test("a missing snapshot or a subject outside the snapshot is undetermined, never within", () => {
    for (const c of RULE_CASES) {
      const params = c.within[0];
      const keyed = JSON.stringify(params);
      const gone = keyed.replace(/near:mainnet:[a-z0-9.-]+/g, "near:mainnet:not-in-snapshot.near");
      const r = evaluateRule(c.kind, JSON.parse(gone));
      expect(r.outcome).toBe("undetermined");
    }
  });
});

describe("AC1 shipped policy over near-2026-11-09 without sibling libraries", () => {
  const policy = () => loadNearPolicy(SHIPPED);
  const byId = (v: any, id: string) => v.rules.find((r: any) => r.ruleId === id);

  test("overall outside-policy with the expected rule outcomes", async () => {
    const store = liveStore();
    const v: any = evaluateNearPolicy(await policy(), store, LIVE, NO_LIBRARIES);
    expect(v.outcome).toBe("outside-policy");
    const expected: Record<string, string> = {
      "rhea-pause-operator": "outside-policy", "dao-factory-keys": "outside-policy", "core-contract-keys": "within-policy",
      "rhea-oracle-controller": "undetermined", "rhea-oracle-enabled": "within-policy", "rhea-dao-threshold": "within-policy",
      "rhea-dao-open-funds": "undetermined", "rhea-open-touching": "undetermined", "intents-not-paused": "within-policy",
      "intents-locker-max": "outside-policy", "intents-pausers-min": "within-policy", "intents-no-upgrade": "outside-policy",
      "intents-council-30d": "outside-policy", "usdc-route-family": "undetermined", "mpc-threshold": "within-policy", "control-unchanged": "within-policy",
    };
    expect(v.rules.map((r: any) => r.ruleId)).toEqual(Object.keys(expected));
    for (const [id, outcome] of Object.entries(expected)) expect(byId(v, id).outcome).toBe(outcome);
    expect(byId(v, "rhea-oracle-controller").reasons.map((r: any) => r.code)).toContain("unknown-controller");
    for (const id of ["rhea-dao-open-funds", "rhea-open-touching", "usdc-route-family"]) expect(byId(v, id).reasons.map((r: any) => r.code)).toContain("missing-coverage");
    expect(byId(v, "intents-no-upgrade").reasons.map((r: any) => r.code)).toContain("upgraded-since");
    expect(v.evaluatedAt).toBe(liveSnapshot().observedTo);
  });

  test("with fake libraries rhea-dao-open-funds is within; a constructed open funds proposal 1746 makes it outside", async () => {
    const store = liveStore(), p = await policy();
    const v: any = evaluateNearPolicy(p, store, LIVE, fakeLibraries(store));
    expect(byId(v, "rhea-dao-open-funds").outcome).toBe("within-policy");
    expect(byId(v, "usdc-route-family").outcome).toBe("within-policy");
    expect(v.outcome).toBe("outside-policy");
    const open = fakeLibraries(store, { overrides: { [N("burrow.sputnik-dao.near#proposal:1746")]: { state: "open", effectClass: "funds" }, [N("burrow.sputnik-dao.near#proposal:1745")]: { state: "open", effectClass: "funds" } } });
    expect(byId(evaluateNearPolicy(p, store, LIVE, open), "rhea-dao-open-funds").outcome).toBe("outside-policy");
  });

  test("AC1 numbers: the verdict and the public review JSON hold no number outside a rule's evidence object", async () => {
    const store = liveStore(), p = await policy();
    const walk = (value: unknown, path: string[], inEvidence: boolean, bad: string[]) => {
      if (typeof value === "number") { if (!inEvidence) bad.push(path.join(".")); return; }
      if (Array.isArray(value)) { value.forEach((v, i) => walk(v, [...path, String(i)], inEvidence, bad)); return; }
      if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, [...path, k], inEvidence || k === "evidence", bad);
    };
    const verdict = evaluateNearPolicy(p, store, LIVE, NO_LIBRARIES);
    const bad: string[] = [];
    walk(verdict, ["verdict"], false, bad);
    const review = buildNearReview(p, store, LIVE, NO_LIBRARIES);
    walk(JSON.parse(canonical(review.publicVerdict)), ["publicVerdict"], false, bad);
    expect(bad).toEqual([]);
    // the CLI json output too
    const cli = await capture(() => policyCli.run([SHIPPED, "--json", "--offline"]));
    expect(cli.code).toBe(0);
    walk(JSON.parse(cli.out), ["cli"], false, bad);
    expect(bad).toEqual([]);
    // positive control: the walker does flag a bare number
    const probe: string[] = []; walk({ rules: [{ count: 3 }] }, [], false, probe); expect(probe.length).toBe(1);
  }, cliTimeout({ policy: 1, review: 0, watch: 0, watchShipped: 0 }));

  test("evaluation is deterministic and evaluates at the snapshot observedTo", async () => {
    const store = liveStore(), p = await policy();
    const a = canonical(evaluateNearPolicy(p, store, LIVE, NO_LIBRARIES)), b = canonical(evaluateNearPolicy(p, store, LIVE, NO_LIBRARIES));
    expect(a).toBe(b);
    expect(nearPolicyContext(store, LIVE).evaluatedAt).toBe(liveSnapshot().observedTo);
  });

  test("referencedSnapshots lists the unchanged-since ids", async () => {
    expect(referencedSnapshots(await policy())).toEqual([LIVE]);
  });
});

describe("AC1 parsePolicy rejects malformed policies", () => {
  const reg = () => createNearRegistry(NO_LIBRARIES);
  const rule = (kind: string, params: unknown, id = "r") => ({ policyId: "p", subjects: [N("intents.near")], rules: [{ id, kind, params }] });
  test("unknown kind, extra param, num > denom, negative n, bad isoDate, bad family, bad class, duplicate ids", () => {
    const bad: unknown[] = [
      rule("no-such-kind", {}),
      rule("pause-state-is", { contract: N("intents.near"), paused: false, extra: 1 }),
      rule("min-threshold", { dao: N("burrow.sputnik-dao.near"), num: 3, denom: 2 }),
      rule("role-grantee-count-max", { contract: N("intents.near"), role: "PauseManager", n: -1 }),
      rule("no-upgrade-since", { contract: N("intents.near"), isoDate: "yesterday" }),
      rule("route-family-in", { assetId: "nep141:a.near", families: ["carrier-pigeon"] }),
      rule("no-open-proposal-of-class", { dao: N("burrow.sputnik-dao.near"), classes: ["gossip"] }),
      rule("unchanged-since", { snapshotId: LIVE, factKeys: ["intents.near|holds-role"] }),
      { policyId: "p", subjects: [N("intents.near")], rules: [{ id: "x", kind: "pause-state-is", params: { contract: N("intents.near"), paused: false } }, { id: "x", kind: "pause-state-is", params: { contract: N("intents.near"), paused: true } }] },
    ];
    for (const input of bad) expect(() => parsePolicy(input, reg())).toThrow(PolicyRejected);
  });
  test("the NEAR parser accepts a role-subject fact key for unchanged-since", () => {
    const p = parsePolicy(rule("unchanged-since", { snapshotId: LIVE, factKeys: [N("intents.near#role:Upgrader|holds-role")] }), reg());
    expect(p.rules).toHaveLength(1);
  });
});


// One MCP server for the whole file: token from the environment, loopback, ephemeral port.
process.env.LINCHPIN_MCP_TOKEN = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
const TOKEN = process.env.LINCHPIN_MCP_TOKEN;
const accessLog: string[] = [];
let server: ReturnType<typeof startMcpServer>;
let client: McpClient;
beforeAll(() => {
  server = startMcpServer({ token: process.env.LINCHPIN_MCP_TOKEN!, snapshotId: LIVE, store: liveStore(), libs: NO_LIBRARIES, port: 0, accessLog: line => accessLog.push(line) });
  client = new McpClient(server.url, TOKEN);
});
afterAll(async () => { await server.stop(); });
const sc = (reply: { json: any }) => reply.json?.result?.structuredContent;
const publicCore = (verdict: any) => ({ outcome: verdict.outcome, rules: verdict.rules.map((r: any) => ({ ruleId: r.ruleId, kind: r.kind, outcome: r.outcome, reasons: r.reasons, factIds: r.factIds, receiptIds: r.receiptIds })) });

// ===========================================================================
// AC2 CLI and MCP give identical verdicts; replay is deterministic
// ===========================================================================
describe("AC2 demo equality and replay", () => {
  test.skipIf(!DEV_BOOK)("policy CLI --json, review --json-out publicVerdict and MCP linchpin_policy_verdict agree on rule ids, outcomes, reasons, fact ids and receipt ids", async () => {
    const dir = tmp();
    const cli = await capture(() => policyCli.run([SHIPPED, "--json", "--offline"]));
    expect(cli.code).toBe(0);
    const cliVerdict = JSON.parse(cli.out);
    const rev = await capture(() => reviewCli.run([SHIPPED, "--positions", SYNTHETIC_BOOK, "--out", join(dir, "r.md"), "--json-out", join(dir, "r.json"), "--offline"]));
    expect(rev.code).toBe(0);
    const reviewVerdict = JSON.parse(readFileSync(join(dir, "r.json"), "utf8")).publicVerdict;
    // The CLIs load the real sibling libraries; the file-wide MCP server is built with NO_LIBRARIES (fast, offline).
    // So the MCP verdict must equal the CLI verdict on every rule except the three library rules, which are the only ones that may differ.
    const reply = await client.call("linchpin_policy_verdict", { policyId: SHIPPED });
    expect(reply.status).toBe(200);
    expect(reply.json.result.isError).toBe(false);
    const mcpVerdict = sc(reply).verdict;
    expect(canonical(publicCore(reviewVerdict))).toBe(canonical(publicCore(cliVerdict)));
    const LIBRARY_RULES = ["rhea-dao-open-funds", "rhea-open-touching", "usdc-route-family"];
    const strip = (v: any) => publicCore(v).rules.filter((r: any) => !LIBRARY_RULES.includes(r.ruleId));
    expect(canonical(strip(cliVerdict))).toBe(canonical(strip(mcpVerdict)));
    const differing = publicCore(cliVerdict).rules.filter((r: any, i: number) => canonical(r) !== canonical(publicCore(mcpVerdict).rules[i])).map((r: any) => r.ruleId);
    expect(differing).toEqual(LIBRARY_RULES);
    expect(canonical(publicCore(cliVerdict))).not.toBe(canonical(publicCore(mcpVerdict)));
    expect(mcpVerdict.outcome).toBe("outside-policy");
    expect(sc(reply).snapshotId).toBe(LIVE);
    // falsifier: the comparison is sensitive (a different policy gives a different core)
    expect(canonical(publicCore(mcpVerdict))).not.toBe(canonical(publicCore({ outcome: "within-policy", rules: [] })));
  }, cliTimeout({ policy: 1, review: 1, watch: 0, watchShipped: 0 }));

  test("T-AC7 real libraries: the shipped `near serve` launcher answers linchpin_policy_verdict within its caps, with the CLI's verdict; a cold in-process server never answers a different verdict", async () => {
    // The subject is the server as shipped and launched (spec P4, AC5, AC6, AC7), not the in-process constructor.
    const shippedToken = "s".repeat(40);
    const child = Bun.spawn(["bun", "--no-env-file", join(REPO, "src", "cli.ts"), "near", "serve", "--port", "0"], {
      cwd: REPO, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, LINCHPIN_MCP_TOKEN: shippedToken },
    });
    let url = "", seen = "";
    try {
      // wait for the ready line on stdout: `listening http://127.0.0.1:<port>/mcp` (startup warm-up takes ~6-8 s)
      const reader = child.stdout.getReader(), dec = new TextDecoder();
      const deadline = Date.now() + 60_000;
      while (!url && Date.now() < deadline) {
        const got = await Promise.race([reader.read(), new Promise<null>(r => setTimeout(() => r(null), deadline - Date.now()))]);
        if (got === null || got.done) break;
        seen += dec.decode(got.value);
        const m = /^listening (http:\/\/127\.0\.0\.1:\d+\/mcp)\s*$/m.exec(seen);
        if (m) url = m[1];
      }
      expect(url, `no ready line from near serve; stdout so far: ${seen}`).not.toBe("");
      const t0 = Date.now();
      const reply = await new McpClient(url, shippedToken).call("linchpin_policy_verdict", { policyId: SHIPPED });
      const elapsed = Date.now() - t0;
      expect(reply.status).toBe(200);
      expect(reply.json.result.isError, JSON.stringify(sc(reply))).toBe(false);
      expect(elapsed).toBeLessThan(5_000); // the tool's 5 s cap, unchanged
      const cli = await capture(() => policyCli.run([SHIPPED, "--json", "--offline"]));
      expect(cli.code).toBe(0);
      const cliVerdict = JSON.parse(cli.out);
      expect(canonical(publicCore(sc(reply).verdict))).toBe(canonical(publicCore(cliVerdict)));

      // cold in-process construction (no warm-up): the same verdict as the CLI, or the structured timeout error, never a different verdict
      const cold = startMcpServer({ token: TOKEN, snapshotId: LIVE, store: liveStore(), libs: await loadNearLibraries(), port: 0 });
      let coldReply: any;
      try { coldReply = await new McpClient(cold.url, TOKEN).call("linchpin_policy_verdict", { policyId: SHIPPED }); } finally { await cold.stop(); }
      expect(coldReply.status).toBe(200);
      if (coldReply.json.result.isError) {
        expect(sc(coldReply).error).toBe("timeout");
        expect(sc(coldReply).verdict).toBeUndefined();
      } else {
        expect(canonical(publicCore(sc(coldReply).verdict))).toBe(canonical(publicCore(cliVerdict)));
      }
    } finally {
      child.kill();
      await child.exited;
    }
  }, 10_000 + 60_000 + 2 * cliTimeout({ policy: 1 }));

  test("an unknown policy id through MCP is a structured error, not a verdict", async () => {
    const reply = await client.call("linchpin_policy_verdict", { policyId: "no-such-policy" });
    expect(reply.json.result.isError).toBe(true);
    expect(sc(reply).error).toBe("unknown-policy");
    expect(sc(reply).verdict).toBeUndefined();
  });

  test("two offline policy runs give byte-identical output; two evaluations give equal canonical JSON", async () => {
    const a = await capture(() => policyCli.run([SHIPPED, "--offline"])), b = await capture(() => policyCli.run([SHIPPED, "--offline"]));
    expect(a.code).toBe(0); expect(a.out.length).toBeGreaterThan(100);
    expect(a.out).toBe(b.out);
    expect(a.out.split("\n")[0]).toBe("verdict outside-policy");
  }, cliTimeout({ policy: 2, review: 0, watch: 0, watchShipped: 0 }));
});

// ===========================================================================
// AC3 private join stays local: canary strings
// ===========================================================================
describe("AC3 private join stays local", () => {
  test("the canary book parses and carries the owner suffix (positive control, decision PC1)", () => {
    const positions = parseNearBook(JSON.parse(readFileSync(CANARY_BOOK, "utf8")));
    expect(positions).toHaveLength(1);
    expect(positions[0].subject).toContain("cnry-owner-z7k3m1");
    expect(positions[0].id).toBe("cnry-id-q9x4h2");
    expect(positions[0].quantity).toBe("73519.000284731");
    expect(positionRoot(positions[0])).toBe(N("contract.main.burrow.near"));
    expect(positionRoot(positions[0])).not.toContain("cnry");
  });

  test("canaries never leave the local report: queries, public facts, receipts, fixtures, MCP responses, access log, stdout, stderr, scratch files", async () => {
    const out = tmp();            // PC3: scratch is in the OS temp directory, outside the repository
    const reportPath = join(out, "report.md"), jsonPath = join(out, "review.json");
    const positions = parseNearBook(JSON.parse(readFileSync(CANARY_BOOK, "utf8")));
    const store = liveStore(), policy = await loadNearPolicy(SHIPPED);

    // (1) recorded QueryRequests, with and without the book
    const requests: unknown[] = [];
    const recording: typeof runQuery = ((st: EvidenceStore, req: any) => { requests.push(req); return runQuery(st, req); }) as typeof runQuery;
    const review = buildNearReview(policy, store, LIVE, NO_LIBRARIES, { query: recording });
    const withBook = joinPositions(review, positions);
    const requestsWithBook = canonical(requests);
    const requests2: unknown[] = [];
    buildNearReview(policy, store, LIVE, NO_LIBRARIES, { query: ((st: EvidenceStore, req: any) => { requests2.push(req); return runQuery(st, req); }) as typeof runQuery });
    expect(canonical(requests2)).toBe(requestsWithBook); // T-AC3b: the same requests whatever the book
    expect(requests.length).toBeGreaterThan(5);
    expect(withBook[0].coverage).toBe("covered");

    // (2) CLI runs with captured streams
    const streams: string[] = [];
    const r1 = await capture(() => reviewCli.run([SHIPPED, "--positions", CANARY_BOOK, "--out", reportPath, "--json-out", jsonPath, "--offline"]));
    const r2 = await capture(() => watchCli.run([SHIPPED, "--before", LIVE, "--after", LIVE, "--positions", CANARY_BOOK, "--positions-before", join(FX, "book-before.json"), "--offline"]));
    const r3 = await capture(() => policyCli.run([SHIPPED, "--offline"]));
    expect([r1.code, r2.code, r3.code]).toEqual([0, 0, 0]);
    streams.push(r1.out, r1.err, r2.out, r2.err, r3.out, r3.err);

    // (3) MCP: every tool once with the canary book exposed through the environment
    const prior = process.env.LINCHPIN_NEAR_POSITIONS;
    process.env.LINCHPIN_NEAR_POSITIONS = CANARY_BOOK;
    const bodies: string[] = [];
    try {
      const receipt = liveSnapshot().receipts[0].id;
      const calls: [string, unknown][] = [
        ["linchpin_subjects", {}], ["linchpin_dependencies", { subject: "contract.main.burrow.near" }], ["linchpin_control", { subject: "contract.main.burrow.near" }],
        ["linchpin_changes", { subject: "contract.main.burrow.near", before: LIVE, after: LIVE }], ["linchpin_evidence", { evidenceIds: [receipt] }],
        ["linchpin_intent_review", { assetId: "nep141:usdt.tether-token.near" }], ["linchpin_governance_review", { dao: "burrow.sputnik-dao.near" }], ["linchpin_policy_verdict", { policyId: SHIPPED }],
      ];
      const c = new McpClient(server.url, TOKEN);
      for (const [name, args] of calls) { const reply = await c.call(name, args); expect(reply.status).toBe(200); }
      await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }); await c.rpc("tools/list"); await c.rpc("ping");
      bodies.push(...c.bodies);
    } finally { if (prior === undefined) delete process.env.LINCHPIN_NEAR_POSITIONS; else process.env.LINCHPIN_NEAR_POSITIONS = prior; }

    // (4) positive controls on the local report only
    const report = readFileSync(reportPath, "utf8");
    expect(report).toContain("cnry-id-q9x4h2");
    expect(report).toContain("73519.000284731");
    expect(report).toContain(N("contract.main.burrow.near")); // PC1: the join table shows the root subject
    expect(statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(r1.out.trim().split("\n")).toHaveLength(2);
    expect(r1.out).toContain(`report ${reportPath}`);
    expect(r1.out).toMatch(/verdict outside-policy/);
    expect(statSync(jsonPath).mode & 0o777).toBe(0o600);

    // (5) the grep set
    const haystacks: [string, string][] = [
      ["requests", canonical(requests)], ["publicFacts", canonical(review.chains)], ["publicVerdict", canonical(review.publicVerdict)],
      ["receipts", canonical(review.receipts)], ["accessLog", accessLog.join("\n")], ["mcp", bodies.join("\n")], ["streams", streams.join("\n")],
    ];
    for (const entry of readdirSync(out)) if (entry !== "report.md") haystacks.push([`scratch:${entry}`, readFileSync(join(out, entry), "utf8")]);
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else haystacks.push([`fixtures:${relative(REPO, p)}`, readFileSync(p, "utf8")]); } };
    walk(join(REPO, "fixtures", "near"));
    expect(haystacks.length).toBeGreaterThan(80);
    const hits = haystacks.flatMap(([name, text]) => CANARIES.filter(c => text.includes(c)).map(c => `${name}:${c}`));
    expect(hits).toEqual([]);
    expect(accessLog.length).toBeGreaterThan(8);
    // public facts and receipts contain no private marker either
    expect(canonical(review.chains)).not.toContain('"privacy":"private"');
    // the position-only canary is also absent from an unrelated pure-text probe (sensitivity check)
    expect([...CANARIES].filter(c => report.includes(c))).toEqual(["cnry-id-q9x4h2", "73519.000284731"]);
    // the repository stayed clean of scratch output
    expect(existsSync(join(REPO, "report.md"))).toBe(false);
  }, cliTimeout({ policy: 1, review: 1, watch: 0, watchShipped: 1 }));

  test("the access log has one JSON line per request and never the token, headers or argument values", () => {
    expect(accessLog.length).toBeGreaterThan(0);
    for (const line of accessLog) {
      const row = JSON.parse(line);
      for (const key of ["at", "status", "rpcMethod", "tool", "requestSha256", "responseSha256", "ms"]) expect(Object.keys(row)).toContain(key);
      expect(line).not.toContain(TOKEN);
      expect(line.toLowerCase()).not.toContain("bearer");
      expect(line).not.toContain("contract.main.burrow.near");
    }
  });

  test("MCP source modules import neither the book loader nor the join (static check)", () => {
    for (const f of readdirSync(join(REPO, "src", "near", "mcp"))) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join(REPO, "src", "near", "mcp", f), "utf8");
      expect(text).not.toMatch(/from\s+["'][^"']*private\/(book|join)["']/);
      expect(text).not.toMatch(/import\([^)]*private\/(book|join)/);
    }
  });

  test("parseNearBook rejects a malformed subject, a #role: suffix, an http unit, the reader source, and the messages carry no values", () => {
    const base = JSON.parse(readFileSync(CANARY_BOOK, "utf8"))[0];
    const variants: Record<string, unknown>[] = [
      { ...base, subject: "contract.main.burrow.near" },
      { ...base, subject: "near:mainnet:contract.main.burrow.near#role:cnry-owner-z7k3m1" },
      { ...base, subject: "near:mainnet:Bad Account#holder:cnry-owner-z7k3m1" },
      { ...base, unit: "http://cnry-id-q9x4h2.example/token" },
      { ...base, source: "reader" },
    ];
    for (const v of variants) {
      let message = "";
      try { parseNearBook([v]); } catch (e) { message = String((e as Error).message); expect(e).toBeInstanceOf(PositionRejected); }
      expect(message).not.toBe("");
      for (const c of CANARIES) expect(message).not.toContain(c);
    }
  });

  test("a real-private book inside the repository is refused by the loader", async () => {
    const dir = join(REPO, ".private");
    const inside = mkdtempSync(join(FX, "tmp-real-")); // inside the repository on purpose, under the tester lane, removed afterwards
    scratch.push(inside);
    const row = { ...JSON.parse(readFileSync(CANARY_BOOK, "utf8"))[0], fixtureKind: "real-private" };
    const path = join(inside, "real.json");
    writeFileSync(path, JSON.stringify([row]));
    let failed = false;
    try { await loadNearBook({ path, env: {} }); } catch (e) { failed = true; expect(String((e as Error).message)).not.toContain("cnry"); }
    expect(failed).toBe(true);
    void dir;
  });

  test.skipIf(!DEV_BOOK)("synthetic book: three covered positions and syn-stake uncovered with missing-subject", async () => {
    const book = parseNearBook(JSON.parse(readFileSync(SYNTHETIC_BOOK, "utf8")));
    const review = buildNearReview(await loadNearPolicy(SHIPPED), liveStore(), LIVE, NO_LIBRARIES);
    const joined = joinPositions(review, book);
    const byId = Object.fromEntries(joined.map(j => [j.position.id, j]));
    expect(joined).toHaveLength(4);
    for (const id of ["syn-rhea-usdt", "syn-intents-usdc", "syn-intents-sol-usdc"]) expect(byId[id].coverage).toBe("covered");
    expect(byId["syn-stake"].coverage).toBe("uncovered");
    expect(byId["syn-stake"].reason).toBe("missing-subject");
    // the join is on the root only: an owner suffix never selects a chain
    expect(byId["syn-intents-usdc"].root).toBe(N("intents.near"));
    // falsifier: a root that merely starts with a covered root is not covered
    const lookalike = parseNearBook([{ ...JSON.parse(readFileSync(CANARY_BOOK, "utf8"))[0], subject: "near:mainnet:contract.main.burrow.near.fake#holder:x" }]);
    expect(joinPositions(review, lookalike)[0].coverage).toBe("uncovered");
  });

  test("the local report writer refuses a repository path and writes mode 0600 elsewhere", () => {
    const dir = tmp(), path = join(dir, "sub", "x.md");
    writeLocalReport(path, "text");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeLocalReport(join(REPO, "leak-report.md"), "text")).toThrow();
    expect(existsSync(join(REPO, "leak-report.md"))).toBe(false);
  });
});

// ===========================================================================
// AC4 watch
// ===========================================================================
describe("AC4 watch", () => {
  const LOCKER = join(FX, "policy-locker-watch.json");
  const watch = (args: string[]) => capture(() => watchCli.run(args));

  test("the constructed pair emits exactly one dependency-changed event with the holds-role fact and the flipped rule, labelled constructed", async () => {
    const json = await watch([LOCKER, "--before", LIVE, "--after", CONSTRUCTED, "--offline", "--json"]);
    expect(json.code).toBe(0);
    const events = json.out.trim().split("\n").map(l => JSON.parse(l));
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("dependency-changed");
    expect(e.cause).toBe("facts");
    expect(e.subject).toBe(N("intents.near#role:UnrestrictedAccountLocker"));
    expect(e.constructed).toBe(true);
    expect(e.changes).toHaveLength(1);
    expect(e.changes[0].kind).toBe("added");
    expect(e.changes[0].key.endsWith("holds-role|near:mainnet:linchpin-constructed-locker.near")).toBe(true);
    expect(e.flippedRules).toEqual([{ ruleId: "locker-max-2", kind: "role-grantee-count-max", before: "within-policy", after: "outside-policy" }]);
    const md = await watch([LOCKER, "--before", LIVE, "--after", CONSTRUCTED, "--offline"]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("constructed");
    expect(md.out).toContain("dependency-changed");
    expect(md.out).not.toContain("position-changed");
  }, cliTimeout({ policy: 0, review: 0, watch: 2, watchShipped: 0 }));

  test("the library function agrees: one event, receipt ids resolve in the store", async () => {
    const store = pairStore();
    const policy = await loadNearPolicy(LOCKER);
    const { events } = watchPolicy({ policy, store, before: LIVE, after: CONSTRUCTED, libs: NO_LIBRARIES });
    expect(events).toHaveLength(1);
    const ev: any = events[0];
    expect(ev.receiptIds.length).toBeGreaterThan(0);
    for (const id of ev.receiptIds) expect(store.receipt(id)).toBeDefined();
    expect(renderWatch(events)).toContain("constructed");
  });

  test("identical inputs emit nothing and exit 0, for md and json", async () => {
    for (const extra of [[], ["--json"]]) {
      const r = await watch([LOCKER, "--before", LIVE, "--after", LIVE, "--offline", ...extra]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
    const shipped = await watch([SHIPPED, "--before", LIVE, "--after", LIVE, "--offline"]);
    expect(shipped.code).toBe(0); expect(shipped.out).toBe("");
  }, cliTimeout({ policy: 0, review: 0, watch: 2, watchShipped: 1 }));

  test("a position-only difference emits only position-changed events and prints no id, quantity or owner", async () => {
    const r = await watch([LOCKER, "--before", LIVE, "--after", LIVE, "--positions-before", join(FX, "book-before.json"), "--positions", join(FX, "book-after.json"), "--offline", "--json"]);
    expect(r.code).toBe(0);
    const events = r.out.trim().split("\n").map(l => JSON.parse(l));
    expect(events.map(e => e.kind)).toEqual(["position-changed", "position-changed"]);
    expect(events.map(e => e.change).sort()).toEqual(["added", "changed"]);
    expect(events.some(e => e.kind === "dependency-changed")).toBe(false);
    for (const needle of ["wb-id-", "wb-owner-", "222.75", "111.5", "999.125", "7.25"]) expect(r.out + r.err).not.toContain(needle);
    const md = await watch([LOCKER, "--before", LIVE, "--after", LIVE, "--positions-before", join(FX, "book-before.json"), "--positions", join(FX, "book-after.json"), "--offline"]);
    for (const needle of ["wb-id-", "wb-owner-", "222.75", "111.5", "999.125"]) expect(md.out).not.toContain(needle);
    expect(md.out).toContain("position-changed");
  }, cliTimeout({ policy: 0, review: 0, watch: 2, watchShipped: 0 }));

  test("a removed position is reported as removed, and equal books emit nothing", async () => {
    const same = await watch([LOCKER, "--before", LIVE, "--after", LIVE, "--positions-before", join(FX, "book-before.json"), "--positions", join(FX, "book-before.json"), "--offline"]);
    expect(same.code).toBe(0); expect(same.out).toBe("");
    const removed = await watch([LOCKER, "--before", LIVE, "--after", LIVE, "--positions-before", join(FX, "book-after.json"), "--positions", join(FX, "book-before.json"), "--offline", "--json"]);
    const kinds = removed.out.trim().split("\n").map(l => JSON.parse(l));
    expect(kinds.map(e => e.change).sort()).toEqual(["changed", "removed"]);
  }, cliTimeout({ policy: 0, review: 0, watch: 2, watchShipped: 0 }));

  test("--record together with --offline exits 1", async () => {
    const r = await watch([LOCKER, "--before", LIVE, "--record", "near-2026-12-31", "--offline"]);
    expect(r.code).toBe(1);
  }, cliTimeout({ policy: 0, review: 0, watch: 1, watchShipped: 0 }));

  test("live pair: structural assertions on the latest two live snapshots, skipped while only one exists", async () => {
    const { liveSnapshotIds } = await import("../src/near/reader/index");
    const ids = liveSnapshotIds(NEAR_ROOT);
    if (ids.length < 2) { expect(ids.length).toBeLessThan(2); return; } // second live snapshot not yet captured
    const [before, after] = ids.slice(-2);
    const store = loadNearSnapshots([before, after], { root: NEAR_ROOT });
    const policy = await loadNearPolicy(SHIPPED);
    const { events } = watchPolicy({ policy, store, before, after, libs: NO_LIBRARIES });
    const keys = events.map(e => `${e.kind}|${(e as any).subject ?? ""}|${(e as any).cause ?? ""}`);
    expect(keys).toEqual([...keys].sort());
    for (const e of events as any[]) for (const id of e.receiptIds ?? []) expect(store.receipt(id)).toBeDefined();
  });
});

// ===========================================================================
// AC8 (task numbering): the maximum relations per dependencies request, report, replay
// ===========================================================================
describe("MAX_RELATIONS and chain queries", () => {
  test("the eight traversal relations are pinned by name", () => {
    expect([...NEAR_TRAVERSAL_RELATIONS]).toEqual(["deployed-by", "holds-role", "legacy-oracle", "owned-by", "priced-by", "routes-through", "super-admin-of", "upgraded-by"]);
  });
  test("every dependencies request lists at most 8 relations, all from the pinned set, in sorted unique form", async () => {
    const requests: any[] = [];
    const rec: typeof runQuery = ((st: EvidenceStore, req: any) => { requests.push(req); return runQuery(st, req); }) as typeof runQuery;
    buildNearReview(await loadNearPolicy(SHIPPED), liveStore(), LIVE, NO_LIBRARIES, { query: rec });
    const deps = requests.filter(r => r.name === "dependencies");
    expect(deps.length).toBeGreaterThan(0);
    for (const r of deps) {
      expect(r.relations.length).toBeGreaterThan(0);
      expect(r.relations.length).toBeLessThanOrEqual(8);
      expect(new Set(r.relations).size).toBe(r.relations.length);
      for (const rel of r.relations) expect(NEAR_TRAVERSAL_RELATIONS).toContain(rel);
      expect(r.scope.maxHops).toBeLessThanOrEqual(4);
      expect(r.scope.snapshotId).toBe(LIVE);
    }
    // nearChain on its own obeys the same limit
    const own: any[] = [];
    nearChain(liveStore(), LIVE, N("intents.near"), ((st: EvidenceStore, req: any) => { own.push(req); return runQuery(st, req); }) as typeof runQuery);
    for (const r of own.filter(r => r.name === "dependencies")) expect(r.relations.length).toBeLessThanOrEqual(8);
  });
  test("reviewRoots is the policy subjects plus the three public roots, sorted and unique", async () => {
    const roots = reviewRoots(await loadNearPolicy(SHIPPED));
    expect(roots).toEqual([...new Set(roots)].sort());
    for (const r of ["contract.main.burrow.near", "intents.near", "v1.signer"]) expect(roots).toContain(N(r));
  });
});

describe("AC8 max-council-change-days is evaluated at observedTo, not the wall clock", () => {
  test("Q3: N = 30 counts a change within the last 30 days before observedTo; outside today because of proposals 105 and 106", () => {
    const r = evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: 30 });
    expect(r.outcome).toBe("outside-policy");
    expect(r.rule.reasons.map((x: any) => x.ref).sort()).toEqual([N("intents.sputnik-dao.near#proposal:105"), N("intents.sputnik-dao.near#proposal:106")]);
    expect(evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: 3 }).outcome).toBe("within-policy");
  });
  test("moving observedTo a year later turns the same rule within, while the wall clock would not", () => {
    const later = mutate({ id: "tst-later", shiftObservedMs: 400 * 86_400_000 });
    expect(later.observedTo > liveSnapshot().observedTo).toBe(true);
    const r = evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: 30 }, later);
    expect(r.verdict.evaluatedAt).toBe(later.observedTo);
    expect(r.outcome).not.toBe("outside-policy");
    // two evaluations of the same snapshot, run apart, agree
    const a = canonical(evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: 30 }).verdict);
    const b = canonical(evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: 30 }).verdict);
    expect(a).toBe(b);
  });
  test("the cutoff boundary: days just below the age of proposal 106 is within, days at its age is outside", () => {
    const snap = liveSnapshot();
    const f = snap.facts.find(x => x.subject === N("intents.sputnik-dao.near#proposal:106") && x.predicate === "proposal")!;
    const submitted = Number(BigInt(JSON.parse(f.object).submission_time) / 1_000_000n);
    const ageDays = (Date.parse(snap.observedTo) - submitted) / 86_400_000;
    expect(ageDays).toBeGreaterThan(1); expect(ageDays).toBeLessThan(30);
    const below = Math.floor(ageDays) - 1 >= 1 ? Math.floor(ageDays) - 1 : 1;
    const justOutside = Math.ceil(ageDays) + 1;
    expect(evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: below }).outcome).not.toBe("outside-policy");
    expect(evaluateRule("max-council-change-days", { dao: N("intents.sputnik-dao.near"), days: justOutside }).outcome).toBe("outside-policy");
  });
});

describe("AC8 report and replay", () => {
  const HEADINGS = ["# Private local report", "## Positions", "## Control per chain", "## Open proposals", "## Route families", "## Changes", "## Policy verdict", "## Unknowns", "## Receipts"];
  const render = async (name: string, format: "md" | "html") => {
    const dir = tmp(); const out = join(dir, `${name}.${format}`);
    const r = await capture(() => reviewCli.run([SHIPPED, "--positions", SYNTHETIC_BOOK, "--out", out, "--format", format, "--offline"]));
    expect(r.code).toBe(0);
    return { out, text: readFileSync(out, "utf8"), stdout: r.out };
  };

  test.skipIf(!DEV_BOOK)("the markdown report has the nine sections in order and every fact line carries a footnote with block height and host", async () => {
    const { text } = await render("a", "md");
    let at = -1;
    for (const h of HEADINGS) { const i = text.indexOf(h, at + 1); expect(i).toBeGreaterThan(at); at = i; }
    expect(text).toContain("Private local report");
    const foots = text.split("\n").filter(l => /^\[\^\d+\]:/.test(l));
    expect(foots.length).toBeGreaterThan(10);
    for (const f of foots) { expect(f).toMatch(/block \d+/); expect(f).toContain("archival-rpc.mainnet.fastnear.com"); expect(f).toMatch(/sha256 [0-9a-f]{12}/); }
    // every footnote reference used in the body resolves to a definition
    const refs = new Set([...text.matchAll(/\[\^(\d+)\](?!:)/g)].map(m => m[1]));
    const defs = new Set(foots.map(f => /^\[\^(\d+)\]/.exec(f)![1]));
    for (const r of refs) expect(defs.has(r)).toBe(true);
    // fact lines in the verdict section and fact rows in the control tables end with a footnote
    const body = text.slice(0, text.search(/^\[\^1\]:/m));
    const factLines = body.split("\n").filter(l => /\((claimed|reported|decoded|simulated|observed|derived|unknown), (verified|unverified|conflicting|missing)\)/.test(l) || /^\| `near:mainnet:[^`]*` \| `[a-z-]+` \|/.test(l));
    expect(factLines.length).toBeGreaterThan(50);
    for (const l of factLines) expect(l).toMatch(/\[\^\d+\]/);
  }, cliTimeout({ review: 1 }));

  test.skipIf(!DEV_BOOK)("two offline runs give byte-identical markdown files and byte-identical html files", async () => {
    const m1 = await render("m1", "md"), m2 = await render("m2", "md");
    expect(m1.text).toBe(m2.text);
    const h1 = await render("h1", "html"), h2 = await render("h2", "html");
    expect(h1.text).toBe(h2.text);
    expect(h1.text).not.toBe(m1.text);
    expect(h1.text.toLowerCase()).toContain("<html");
  }, cliTimeout({ review: 4 }));

  test.skipIf(!DEV_BOOK)("the report contains no wall-clock timestamp: the only dates are the snapshot's and policy dates", async () => {
    const { text } = await render("clock", "md");
    const stamps = [...text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g)].map(m => m[0]);
    const allowedMonths = /^(20(1[0-9]|2[0-6]))-/;
    for (const s of stamps) expect(s).toMatch(allowedMonths);
    const nowYear = String(new Date().getUTCFullYear());
    expect(text.includes(new Date().toISOString().slice(0, 16))).toBe(false);
    void nowYear;
  }, cliTimeout({ review: 1 }));

  test("html escapes a hostile fact object", () => {
    const hostile = mutate({ id: "tst-xss", add: [{ subject: N("intents.near"), predicate: "paused", object: "<script>alert(1)</script>" }] });
    const store = openStore([hostile]);
    return loadNearPolicy(join(FX, "policy-locker-watch.json")).then(policy => {
      const review = buildNearReview(policy, store, hostile.id, NO_LIBRARIES);
      const html = renderNearReport({ review, positions: [] }, "html");
      expect(html).not.toContain("<script>alert(1)</script>");
      const md = renderNearReport({ review, positions: [] }, "md");
      expect(md).toContain("<script>alert(1)</script>"); // markdown keeps the value inside a code span
    });
  });

  test.skipIf(!DEV_BOOK)("every undetermined rule id and every reason code of the review appear in the Unknowns section", async () => {
    const dir = tmp(), outPath = join(dir, "r.md"), jsonPath = join(dir, "r.json");
    await capture(() => reviewCli.run([SHIPPED, "--positions", SYNTHETIC_BOOK, "--out", outPath, "--json-out", jsonPath, "--offline"]));
    const text = readFileSync(outPath, "utf8"), review = JSON.parse(readFileSync(jsonPath, "utf8"));
    const unknowns = text.slice(text.indexOf("## Unknowns"), text.indexOf("## Receipts"));
    for (const r of review.verdict.rules.filter((x: any) => x.outcome === "undetermined")) expect(unknowns).toContain(r.ruleId);
    for (const u of review.unknowns) expect(unknowns).toContain(u.code);
    // With the real libraries the three library rules are determined (probed), so only the oracle controller stays undetermined.
    expect(review.verdict.rules.filter((x: any) => x.outcome === "undetermined").map((x: any) => x.ruleId)).toEqual(["rhea-oracle-controller"]);
  }, cliTimeout({ policy: 0, review: 1, watch: 0, watchShipped: 0 }));
});

// ===========================================================================
// AC2 (spec numbering) sibling libraries: absent, broken, fake, loaded
// ===========================================================================
describe("sibling libraries (spec AC2): absent, broken, fake", () => {
  const LIB_RULES: [string, Record<string, unknown>][] = [
    ["route-family-in", { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", families: ["near_withdrawal"] }],
    ["no-open-proposal-of-class", { dao: N("burrow.sputnik-dao.near"), classes: ["funds"] }],
    ["no-open-proposal-touching", { subject: N("contract.main.burrow.near") }],
  ];
  test("NO_LIBRARIES: the three library rules are undetermined with missing-coverage, and nothing throws", () => {
    for (const [kind, params] of LIB_RULES) {
      const r = evaluateRule(kind, params, liveSnapshot(), NO_LIBRARIES);
      expect(r.outcome).toBe("undetermined");
      expect(r.codes).toContain("missing-coverage");
    }
  });
  test("broken libraries (throwing, and wrong-shape) give the same outcome with no rule-error", () => {
    for (const mode of ["throw", "shape"] as const) for (const [kind, params] of LIB_RULES) {
      const r = evaluateRule(kind, params, liveSnapshot(), brokenLibraries(mode));
      expect(r.outcome).toBe("undetermined");
      expect(r.codes).toContain("missing-coverage");
      expect(r.codes).not.toContain("rule-error");
    }
  });
  test("a whole shipped-policy evaluation with broken libraries still returns a verdict (outside-policy) without throwing", async () => {
    const v: any = evaluateNearPolicy(await loadNearPolicy(SHIPPED), liveStore(), LIVE, brokenLibraries("throw"));
    expect(v.outcome).toBe("outside-policy");
    expect(v.rules.find((r: any) => r.ruleId === "rhea-dao-open-funds").outcome).toBe("undetermined");
  });
  test("T-AC2d: loadNearLibraries with a base URL whose ../intents and ../governance modules do not exist reports both absent", async () => {
    const dir = tmp();
    const libs = await loadNearLibraries(pathToFileURL(join(dir, "policy", "libraries.ts")));
    expect(libs.intents).toBeNull(); expect(libs.governance).toBeNull();
    expect(libs.status).toEqual([{ name: "near-intent-review", status: "absent" }, { name: "near-governance-review", status: "absent" }]);
    expect(existsSync(join(dir, "intents"))).toBe(false);
  });
  test("T-AC2d: loadNearLibraries() in this worktree (siblings merged on the base) reports both loaded", async () => {
    const libs = await loadNearLibraries();
    expect(libs.status).toEqual([{ name: "near-intent-review", status: "loaded" }, { name: "near-governance-review", status: "loaded" }]);
    expect(libs.intents).not.toBeNull(); expect(libs.governance).not.toBeNull();
  });
  // T-AC2e: only meaningful when the sibling libraries exist, which they do on this base (the guard is real, not a stub).
  const SIBLINGS = existsSync(join(REPO, "src", "near", "governance", "index.ts")) && existsSync(join(REPO, "src", "near", "intents", "index.ts"));
  test.skipIf(!SIBLINGS)("T-AC2e: with the real libraries the three library rules produce real outcomes from the committed snapshot (probed 2026-11-10)", async () => {
    const libs = await loadNearLibraries();
    expect(libs.status.map(x => x.status)).toEqual(["loaded", "loaded"]);
    const v: any = evaluateNearPolicy(await loadNearPolicy(SHIPPED), liveStore(), LIVE, libs);
    const by = (id: string) => v.rules.find((r: any) => r.ruleId === id);
    // Probe: burrow.sputnik-dao.near has no InProgress proposal in near-2026-11-09 (governance --open), so both proposal rules are within, with no missing-coverage.
    expect(by("rhea-dao-open-funds").outcome).toBe("within-policy");
    expect(by("rhea-open-touching").outcome).toBe("within-policy");
    // Probe: classifyAsset(USDC nep141 id) = near_withdrawal (rule nep141-near), the only allowed family.
    expect(by("usdc-route-family").outcome).toBe("within-policy");
    for (const id of ["rhea-dao-open-funds", "rhea-open-touching", "usdc-route-family"]) {
      expect(by(id).reasons.map((r: any) => r.code)).not.toContain("missing-coverage");
      expect(by(id).reasons).toEqual([]);
    }
    // a different asset of an unclassified family must not be within: falsifier on the real classifier
    const other = evaluateRule("route-family-in", { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", families: ["poa_bridge"] }, liveSnapshot(), libs);
    expect(other.outcome).toBe("outside-policy");
    // the other 13 rules are unchanged by the real libraries
    const none: any = evaluateNearPolicy(await loadNearPolicy(SHIPPED), liveStore(), LIVE, NO_LIBRARIES);
    for (const r of v.rules.filter((x: any) => !["rhea-dao-open-funds", "rhea-open-touching", "usdc-route-family"].includes(x.ruleId)))
      expect(canonical(r)).toBe(canonical(none.rules.find((x: any) => x.ruleId === r.ruleId)));
    expect(v.outcome).toBe("outside-policy");
  }, 30_000);
  test("the review reports a library status instead of inventing sections when libraries are absent", async () => {
    const review: any = buildNearReview(await loadNearPolicy(SHIPPED), liveStore(), LIVE, NO_LIBRARIES);
    expect(review.libraries.map((l: any) => l.status)).toEqual(["absent", "absent"]);
    const text = renderNearReport({ review, positions: [] }, "md");
    expect(text).toContain("missing-coverage");
  });
});

// ===========================================================================
// AC5 MCP conformance
// ===========================================================================
describe("AC5 MCP server conformance (ephemeral 127.0.0.1 port, token from the environment)", () => {
  const EXPECTED_TOOLS = ["linchpin_subjects", "linchpin_dependencies", "linchpin_control", "linchpin_changes", "linchpin_evidence", "linchpin_intent_review", "linchpin_governance_review", "linchpin_policy_verdict"];
  const initParams = (v: string) => ({ protocolVersion: v, capabilities: {}, clientInfo: { name: "tester", version: "0" } });

  test("the listener is on 127.0.0.1 with a numeric ephemeral port and the /mcp path", () => {
    const u = new URL(server.url);
    expect(u.hostname).toBe("127.0.0.1"); expect(u.pathname).toBe("/mcp"); expect(Number(u.port)).toBeGreaterThan(0);
  });

  test("initialize returns protocol version and server info; unsupported versions fall back to the newest", async () => {
    const r = await client.rpc("initialize", initParams("2025-06-18"));
    expect(r.status).toBe(200);
    expect(r.json.jsonrpc).toBe("2.0");
    expect(r.json.result.protocolVersion).toBe("2025-06-18");
    expect(r.json.result.serverInfo.name).toBe("linchpin-near");
    expect(typeof r.json.result.serverInfo.version).toBe("string");
    expect(r.json.result.capabilities.tools).toBeDefined();
    expect((await client.rpc("initialize", initParams("2024-11-05"))).json.result.protocolVersion).toBe("2024-11-05");
    expect((await client.rpc("initialize", initParams("1999-01-01"))).json.result.protocolVersion).toBe("2025-06-18");
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual(["2025-06-18", "2025-03-26", "2024-11-05"]);
    // an unsupported MCP-Protocol-Version header is a 400
    expect((await client.rpc("ping", undefined, { "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
  });

  test("ping returns an empty result", async () => {
    const r = await client.rpc("ping");
    expect(r.status).toBe(200); expect(r.json.result).toEqual({});
  });

  test("tools/list returns the eight baseline tools first, in order, and every listed tool has an object input schema that forbids extra properties", async () => {
    const r = await client.rpc("tools/list");
    const tools = r.json.result.tools;
    expect(tools.slice(0, EXPECTED_TOOLS.length).map((t: any) => t.name)).toEqual(EXPECTED_TOOLS);
    expect(TOOLS.slice(0, EXPECTED_TOOLS.length).map(t => t.name)).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(typeof t.description).toBe("string");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  const VALID_ARGS: Record<string, unknown> = {
    linchpin_subjects: {}, linchpin_dependencies: { subject: "intents.near" }, linchpin_control: { subject: "near:mainnet:intents.near" },
    linchpin_changes: { subject: "intents.near", before: LIVE, after: LIVE }, linchpin_evidence: { evidenceIds: [liveSnapshot().receipts[0].id] },
    linchpin_intent_review: { assetId: "nep141:usdt.tether-token.near" }, linchpin_governance_review: { dao: "burrow.sputnik-dao.near" }, linchpin_policy_verdict: { policyId: SHIPPED },
  };
  for (const name of EXPECTED_TOOLS) {
    test(`tools/call ${name}: isError false, object structuredContent, text content parses to the same object, passes the privacy projection`, async () => {
      const r = await client.call(name, VALID_ARGS[name]);
      expect(r.status).toBe(200);
      const result = r.json.result;
      expect(result.isError).toBe(false);
      expect(result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)).toBe(true);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(() => assertPublicResponse(r.json)).not.toThrow();
      expect(r.text).not.toContain('"privacy":"private"');
      expect(r.text).not.toContain("#holder:");
    });
  }

  test("the intent and governance tools say missing-coverage while the sibling libraries are absent", async () => {
    for (const [name, args] of [["linchpin_intent_review", VALID_ARGS.linchpin_intent_review], ["linchpin_governance_review", VALID_ARGS.linchpin_governance_review]] as const) {
      const r = await client.call(name, args);
      expect(r.json.result.isError).toBe(false);
      expect(JSON.stringify(sc(r))).toContain("missing-coverage");
    }
  });

  test("a missing bearer, a wrong bearer, a Basic scheme and a prefix of the token each give 401 with an empty body, before the body is parsed", async () => {
    const url = server.url, body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const variants: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN.slice(0, -1)}` }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN }, { authorization: "Bearer " }];
    for (const h of variants) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...h }, body });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    // auth precedes parsing: invalid JSON with no token is 401, not a JSON-RPC parse error
    const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(401); expect(await bad.text()).toBe("");
    // positive control: the right token works
    expect((await client.rpc("ping")).status).toBe(200);
  });

  test("JSON-RPC errors: unknown tool and unknown method -32601, schema failures -32602, bad JSON -32700, batch -32600, notification 202", async () => {
    expect((await client.call("linchpin_nope", {})).json.error.code).toBe(-32601);
    expect((await client.rpc("resources/list")).json.error.code).toBe(-32601);
    expect((await client.call("linchpin_dependencies", { subject: "intents.near", maxHops: "2" })).json.error.code).toBe(-32602);
    expect((await client.call("linchpin_control", { subject: "intents.near", extra: true })).json.error.code).toBe(-32602);
    expect((await client.call("linchpin_control", {})).json.error.code).toBe(-32602);
    expect((await client.call("linchpin_control", { subject: "Bad Subject!" })).json.error.code).toBe(-32602);
    expect((await client.call("linchpin_dependencies", { subject: "intents.near", relations: ["not-a-relation"] })).json.error.code).toBe(-32602);
    expect((await client.call("linchpin_dependencies", { subject: "intents.near", maxResults: 0 })).json.error.code).toBe(-32602);
    expect((await client.call("linchpin_policy_verdict", { policyId: "../../etc/passwd" })).json.error.code).toBe(-32602);
    expect((await client.post("{not json", {}, true)).json.error.code).toBe(-32700);
    expect((await client.post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).json.error.code).toBe(-32600);
    expect((await client.post({ id: 1, method: "ping" })).json.error.code).toBe(-32600);
    const note = await client.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202); expect(note.text).toBe("");
    // error envelopes carry no stack text or file path
    const err = await client.call("linchpin_nope", {});
    expect(err.text).not.toMatch(/\/Users|node_modules|at \w+\.|\.ts:/);
  });

  test("an unknown subject is a structured missing-subject, not an error envelope", async () => {
    const r = await client.call("linchpin_control", { subject: "no-such-account.near" });
    expect(r.json.result.isError).toBe(false);
    expect(JSON.stringify(sc(r))).toContain("missing-subject");
  });

  test("clamps: maxResults above 200 and maxHops above 4 are clamped and reported as truncated", async () => {
    expect(SERVER_CAPS.maxResults).toBe(200); expect(SERVER_CAPS.maxHops).toBe(4); expect(SERVER_CAPS.maxBodyBytes).toBe(65536);
    const control = await client.call("linchpin_control", { subject: "intents.near", maxResults: 100000 });
    expect(sc(control).truncated).toBe(true);
    expect(sc(control).clamped).toContain("maxResults");
    const dep = await client.call("linchpin_dependencies", { subject: "contract.main.burrow.near", maxResults: 100000, maxHops: 64 });
    expect(sc(dep).truncated).toBe(true);
    expect(sc(dep).clamped).toEqual(expect.arrayContaining(["maxResults", "maxHops"]));
    expect(JSON.stringify(sc(dep).facts ?? []).length).toBeGreaterThan(2);
    for (const key of ["facts"]) if (Array.isArray(sc(control)[key])) expect(sc(control)[key].length).toBeLessThanOrEqual(200);
    const subj = await client.call("linchpin_subjects", { maxResults: 100000 });
    expect(sc(subj).clamped).toContain("maxResults");
    // falsifier: a request inside the caps is not reported as clamped
    const small = await client.call("linchpin_subjects", { maxResults: 5 });
    expect(sc(small).clamped ?? []).not.toContain("maxResults");
    // 64 KB: a larger request body is refused (413) before any tool runs
    const big = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(70_000) } }) });
    expect(big.status).toBe(413);
    // exactly-at-cap sanity: a body well below the cap is accepted
    expect((await client.rpc("ping", { pad: "x".repeat(1000) })).status).toBe(200);
  });

  test("transport: GET and PUT are 405, other paths 404, a foreign Origin 403, a non-JSON content type 415", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(server.url, { method: "GET", headers: auth })).status).toBe(405);
    expect((await fetch(server.url, { method: "PUT", headers: auth })).status).toBe(405);
    const root = new URL(server.url); root.pathname = "/";
    expect((await fetch(root, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    const origin = await fetch(server.url, { method: "POST", headers: { ...auth, "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(origin.status).toBe(403); expect(await origin.text()).toBe("");
    const ct = await fetch(server.url, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(ct.status).toBe(415);
  });

  test("the server refuses to start without a token or with a short one, and the CLI exits 2 with the documented message", async () => {
    const opts = { snapshotId: LIVE, store: liveStore(), libs: NO_LIBRARIES, port: 0 };
    for (const [token, code] of [["", "token-missing"], ["short-token", "token-too-short"], ["a".repeat(31), "token-too-short"]] as const) {
      let caught: unknown;
      try { startMcpServer({ ...opts, token }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(McpConfigError);
      expect((caught as McpConfigError).code).toBe(code);
    }
    const saved = process.env.LINCHPIN_MCP_TOKEN;
    delete process.env.LINCHPIN_MCP_TOKEN;
    try {
      const r = await capture(() => serveCli.run([]));
      expect(r.code).toBe(2);
      expect(r.out + r.err).toContain("LINCHPIN_MCP_TOKEN is required (at least 32 characters)");
      process.env.LINCHPIN_MCP_TOKEN = "short";
      const s = await capture(() => serveCli.run(["--port", "0"]));
      expect(s.code).toBe(2);
    } finally { process.env.LINCHPIN_MCP_TOKEN = saved; }
  });

  test("serve --host 0.0.0.0 (or any --host) exits 2 with a clear message and opens no listener", async () => {
    const env = { ...process.env, LINCHPIN_MCP_TOKEN: "z".repeat(40) } as Record<string, string>;
    for (const host of ["0.0.0.0", "127.0.0.1", "::"]) {
      const proc = Bun.spawn(["bun", "--no-env-file", join(REPO, "src", "cli.ts"), "near", "serve", "--port", "0", "--host", host], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
      const killer = setTimeout(() => proc.kill(), 20000);
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(killer);
      expect(code).toBe(2);
      expect(/--host/.test(out + err)).toBe(true);
      expect(/refus|not supported|loopback|127\.0\.0\.1/i.test(out + err)).toBe(true);
      expect(/listening/.test(out + err)).toBe(false);
    }
  }, 90_000);

  test("without --host the listener is on 127.0.0.1 only: the machine's other interface address is closed", async () => {
    const env = { ...process.env, LINCHPIN_MCP_TOKEN: "z".repeat(40) } as Record<string, string>;
    const proc = Bun.spawn(["bun", "--no-env-file", join(REPO, "src", "cli.ts"), "near", "serve", "--port", "0"], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
    try {
      // Correction 2: one read loop, no dropped chunks; serve warms ~7 s before it prints the ready line.
      let text = ""; const reader = proc.stdout.getReader(); const deadline = Date.now() + 60_000;
      while (!/listening http:\/\/\S+\/mcp/.test(text) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>(r => setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())))]);
        if (chunk.value) text += new TextDecoder().decode(chunk.value);
        if (chunk.done) break;
      }
      const m = /listening (http:\/\/([^:]+):(\d+)\/mcp)/.exec(text);
      expect(m).not.toBeNull();
      if (m) {
        expect(m[2]).toBe("127.0.0.1");
        const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal);
        if (lan) {
          let reached = true;
          try { const sock = await trap.real.connect({ hostname: lan.address, port: Number(m[3]), socket: { data() {}, open(s) { s.end(); }, error() {}, close() {} } }); void sock; } catch { reached = false; }
          expect(reached).toBe(false);
        }
      }
    } finally { proc.kill(); }
  }, 90_000);

  test("the whole file made no outbound attempt so far", () => { expect(trap.attempts).toEqual([]); });
});

// ===========================================================================
// AC7 (task numbering): the agent face has no access to positions
// ===========================================================================
describe("AC7 no tool returns a position field", () => {
  const FORBIDDEN_KEYS = ["quantity", "positionRef", "positions", "position", "fixtureKind", "inScope", "holder", "owner", "balance", "amount"];
  const keysOf = (v: unknown, acc: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(v)) v.forEach(x => keysOf(x, acc));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keysOf(x, acc); }
    return acc;
  };
  test("no tool input schema has a position or quantity property", () => {
    for (const t of TOOLS) {
      const props = Object.keys((t.inputSchema as any).properties ?? {});
      for (const p of props) expect(FORBIDDEN_KEYS).not.toContain(p);
    }
  });
  test("no tool response, with the canary book present in the environment, has a position key or a holder marker", async () => {
    const prior = process.env.LINCHPIN_NEAR_POSITIONS;
    process.env.LINCHPIN_NEAR_POSITIONS = SYNTHETIC_BOOK;
    try {
      for (const t of TOOLS) {
        const args = { linchpin_subjects: {}, linchpin_dependencies: { subject: "intents.near" }, linchpin_control: { subject: "intents.near" }, linchpin_changes: { subject: "intents.near" }, linchpin_evidence: { evidenceIds: [liveSnapshot().receipts[0].id] }, linchpin_intent_review: { assetId: "nep141:usdt.tether-token.near" }, linchpin_governance_review: { dao: "burrow.sputnik-dao.near" }, linchpin_policy_verdict: { policyId: SHIPPED } }[t.name]!;
        const r = await client.call(t.name, args);
        const keys = keysOf(r.json);
        for (const k of ["quantity", "positionRef", "positions", "fixtureKind", "inScope", "holder"]) expect(keys.has(k)).toBe(false);
        for (const marker of ["synthetic-owner", "syn-rhea-usdt", "#holder:", "1250.5"]) expect(r.text).not.toContain(marker);
      }
    } finally { if (prior === undefined) delete process.env.LINCHPIN_NEAR_POSITIONS; else process.env.LINCHPIN_NEAR_POSITIONS = prior; }
  });
  test("assertPublicResponse rejects a forbidden key and a holder marker at any depth (positive control)", () => {
    for (const bad of [{ a: { b: [{ quantity: "1" }] } }, { positionRef: "x" }, { positions: [] }, { x: [{ holder: "h" }] }, { s: "near:mainnet:a.near#holder:k" }]) expect(() => assertPublicResponse(bad)).toThrow();
    expect(() => assertPublicResponse({ ok: { nested: ["near:mainnet:a.near#role:x"] } })).not.toThrow();
  });
  test("the access-controlled handler is also position-free when built directly with createMcpHandler", async () => {
    const handler = createMcpHandler({ token: TOKEN, snapshotId: LIVE, store: liveStore(), libs: NO_LIBRARIES });
    const res = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(res.status).toBe(200);
    const unauth = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(unauth.status).toBe(401); expect(await unauth.text()).toBe("");
  });
});

// ===========================================================================
// AC9 honest unknowns and no advice
// ===========================================================================
describe("AC9 no advice vocabulary outside quoted fact objects", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
  const IRONCLAW = join(REPO, "src", "near", "ironclaw");

  test("the banned list is exactly the nine words of the spec", () => {
    expect([...NEAR_BANNED_WORDS].sort() as string[]).toEqual(["should", "recommend", "safe", "unsafe", "score", "rating", "buy", "sell", "exit"].sort());
  });
  test("findNearBannedWords: positive controls and quoted-span exemptions", () => {
    expect(findNearBannedWords("you should sell").sort()).toEqual(["sell", "should"]);
    expect(findNearBannedWords("a `exit` span and \"safe\" quote")).toEqual([]);
    expect(findNearBannedWords("This is UNSAFE and a Rating")).toEqual(expect.arrayContaining(["unsafe", "rating"]));
    expect(findNearBannedWords("safely")).toEqual([]); // whole words only
  });
  test("every file under src/near/ironclaw/** is free of banned words", () => {
    const all = files(IRONCLAW);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const f of all) expect({ f: relative(REPO, f), hits: findNearBannedWords(readFileSync(f, "utf8")) }).toEqual({ f: relative(REPO, f), hits: [] });
  });
  test("a plain grep of the skill and routine finds no banned word even inside quotes", () => {
    for (const f of [join(IRONCLAW, "skills", "linchpin-risk.md"), join(IRONCLAW, "routines", "policy-heartbeat.md")]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/\b(should|recommend\w*|safe|unsafe|score|rating|buy|sell|exit)\b/i);
    }
  });
  test("every tool description and the initialize instructions are free of banned words", async () => {
    for (const t of TOOLS) expect(findNearBannedWords(String((t as any).description))).toEqual([]);
    const list = await client.rpc("tools/list");
    for (const t of list.json.result.tools) expect(findNearBannedWords(t.description)).toEqual([]);
    const init = await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(typeof init.json.result.instructions).toBe("string");
    expect(findNearBannedWords(init.json.result.instructions)).toEqual([]);
  });
  test.skipIf(!DEV_BOOK)("the markdown report, the html report and the watch markdown are free of banned words", async () => {
    const dir = tmp();
    for (const format of ["md", "html"]) {
      const out = join(dir, `r.${format}`);
      await capture(() => reviewCli.run([SHIPPED, "--positions", SYNTHETIC_BOOK, "--out", out, "--format", format, "--offline"]));
      expect({ format, hits: findNearBannedWords(readFileSync(out, "utf8")) }).toEqual({ format, hits: [] });
    }
    const w = await capture(() => watchCli.run([join(FX, "policy-locker-watch.json"), "--before", LIVE, "--after", CONSTRUCTED, "--offline"]));
    expect(w.out.length).toBeGreaterThan(50);
    expect(findNearBannedWords(w.out)).toEqual([]);
    const p = await capture(() => policyCli.run([SHIPPED, "--offline"]));
    expect(findNearBannedWords(p.out)).toEqual([]);
  }, cliTimeout({ policy: 1, review: 2, watch: 1, watchShipped: 0 }));
  test("no rule or verdict carries a score, rating or dollar field", async () => {
    const v = JSON.stringify(evaluateNearPolicy(await loadNearPolicy(SHIPPED), liveStore(), LIVE, NO_LIBRARIES));
    expect(v).not.toMatch(/"(score|rating|risk|usd|dollar\w*)"/i);
  });
  test("tool error text never echoes exception messages", async () => {
    const r = await client.call("linchpin_policy_verdict", { policyId: "no-such-policy" });
    expect(r.text).not.toMatch(/Error:|ENOENT|\/Users|\.json/);
  });
});

// ===========================================================================
// AC10 conventions, IronClaw manifest and public tree
// ===========================================================================
describe("AC10 IronClaw package and public tree", () => {
  const IRONCLAW = join(REPO, "src", "near", "ironclaw");
  const MANIFEST = join(IRONCLAW, "linchpin", "manifest.toml");
  const manifest = () => Bun.TOML.parse(readFileSync(MANIFEST, "utf8")) as any;
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);

  test("the manifest parses with Bun.TOML and has the exact schema_version, https server, namespace, max_tools, permission and effects network + use_secret", () => {
    const m = manifest();
    expect(m.schema_version).toBe("reborn.extension_manifest.v3");
    expect(m.mcp.server.startsWith("https://")).toBe(true);
    expect(m.mcp.server).toContain("<host>");
    expect(m.mcp.namespace).toBe("linchpin");
    expect(m.mcp.max_tools).toBeGreaterThanOrEqual(8);
    expect(m.mcp.max_tools).toBe(TOOLS.length);
    expect(m.mcp.default_permission).toBe("ask");
    expect(m.mcp.effects).toEqual(["network", "use_secret"]);
    expect(Array.isArray(m.mcp.credentials) && m.mcp.credentials.length).toBe(1);
    expect(m.mcp.credentials[0].injection).toEqual({ type: "header", name: "authorization", prefix: "Bearer " });
  });
  test("falsifiers: the checks above reject an http server, extra effects and a wrong schema version", () => {
    const base = readFileSync(MANIFEST, "utf8");
    const http = Bun.TOML.parse(base.replace("https://", "http://")) as any;
    expect(http.mcp.server.startsWith("https://")).toBe(false);
    const eff = Bun.TOML.parse(base.replace('effects = ["network", "use_secret"]', 'effects = ["network"]')) as any;
    expect(eff.mcp.effects).not.toEqual(["network", "use_secret"]);
    const more = Bun.TOML.parse(base.replace('effects = ["network", "use_secret"]', 'effects = ["network", "use_secret", "write"]')) as any;
    expect(more.mcp.effects).not.toEqual(["network", "use_secret"]);
    const ver = Bun.TOML.parse(base.replace("v3", "v2")) as any;
    expect(ver.schema_version).not.toBe("reborn.extension_manifest.v3");
  });
  test("no credential value is present: the credential entry holds only a handle, the secret field is flagged secret, no field is a value", () => {
    const m = manifest();
    const cred = m.mcp.credentials[0];
    expect(Object.keys(cred).sort()).toEqual(["handle", "injection", "scopes", "vendor"]);
    expect(cred.scopes).toEqual([]);
    for (const field of m.auth.linchpin.fields) { expect(field.secret).toBe(true); expect(Object.keys(field).sort()).toEqual(["handle", "label", "secret"]); }
    expect(JSON.stringify(m)).not.toMatch(/"(token|value|password|key|secret_value)"\s*:\s*"[^"]+"/i);
  });
  test("no hostname, token or key is anywhere in the package", () => {
    const all = files(IRONCLAW);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      expect({ f: relative(REPO, f), hex: /[0-9a-f]{32,}/i.exec(text)?.[0] ?? null }).toEqual({ f: relative(REPO, f), hex: null });
      expect(text).not.toMatch(/Bearer (?!token\b)[A-Za-z0-9._~+\/=-]{12,}/); // a credential-shaped value; the words "Bearer token" in prose are not one
      expect(text).not.toMatch(/trycloudflare|ngrok|quantrin\.ai|LINCHPIN_MCP_TOKEN\s*=/i);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}|nearai_|AKIA[0-9A-Z]{8,}/);
      // every https URL in the package is a literal placeholder, never a real host
      for (const url of text.match(/https?:\/\/[^\s"'`)>\]]+/g) ?? []) expect(url).toMatch(/<host|cloud\.near\.ai\/verify|docs\.|github\.com\/nearai|ironclaw/i);
    }
  });
  test("the skill and the routine front matter parse and carry the required fields", () => {
    const fm = (text: string) => { const m = /^---\n([\s\S]*?)\n---\n/.exec(text); expect(m).not.toBeNull(); return Bun.YAML.parse(m![1]) as any; };
    const skillText = readFileSync(join(IRONCLAW, "skills", "linchpin-risk.md"), "utf8");
    const skill = fm(skillText);
    expect(skill.name).toBe("linchpin-risk");
    expect(skill.activation.keywords).toEqual(["dependency", "control", "policy", "proposal", "intent", "what changed"]);
    for (const needle of ["unchecked summary", "receipt"]) expect(skillText).toContain(needle);
    const routineText = readFileSync(join(IRONCLAW, "routines", "policy-heartbeat.md"), "utf8");
    const routine = fm(routineText);
    expect(routine.name).toBe("policy-heartbeat");
    expect(routine.schedule).toBe("0 */6 * * *");
    expect(routineText).toContain("linchpin_policy_verdict");
    expect(routineText).toContain("outside-policy");
  });
  test("tool names the skill and routine mention exist on the server", () => {
    const names = TOOLS.map(t => t.name);
    for (const f of [join(IRONCLAW, "skills", "linchpin-risk.md"), join(IRONCLAW, "routines", "policy-heartbeat.md")]) {
      for (const used of readFileSync(f, "utf8").match(/linchpin_[a-z_]+/g) ?? []) expect(names).toContain(used);
    }
  });

  const allowlistPath = join(REPO, "scripts", "publish" + ".allowlist");
  const sections = () => {
    const out: Record<string, string[]> = {}; let cur = "";
    for (const raw of readFileSync(allowlistPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) { cur = line.slice(1, -1); out[cur] = []; } else out[cur].push(line);
    }
    return out;
  };
  const glob = (pattern: string): RegExp => {
    const segments = pattern.split("/").filter((part, i, all) => part !== "**" || all[i - 1] !== "**");
    let source = "^";
    segments.forEach((part, i) => {
      if (part === "**") { if (segments.length === 1) source += "[^]+"; else if (i === segments.length - 1) source += "(?:/[^]+)?"; else source += (i ? "/" : "") + "(?:[^/]+/)*"; }
      else { if (i && segments[i - 1] !== "**") source += "/"; source += part.split("*").map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"); }
    });
    return new RegExp(source + "$");
  };
  const published = (path: string): boolean => { let on = false; for (const pat of sections().paths) { const neg = pat.startsWith("!"); if (glob(neg ? pat.slice(1) : pat).test(path)) on = !neg; } return on; };

  test.skipIf(!DEV_ALLOWLIST)("the public tree: ironclaw, policies, mcp, policy and private-module sources and this test are published; fixtures/near/private is not", () => {
    expect(published("src/near/ironclaw/linchpin/manifest.toml")).toBe(true);
    expect(published("src/near/ironclaw/skills/linchpin-risk.md")).toBe(true);
    expect(published("fixtures/near/policies/quantrin-near-v1.json")).toBe(true);
    expect(published("src/near/mcp/server.ts")).toBe(true);
    expect(published("src/near/policy/registry.ts")).toBe(true);
    expect(published("src/near/private/join.ts")).toBe(true);
    expect(published("tests/near-private-risk-manager.test.ts")).toBe(true);
    expect(published("fixtures/near/private/book-synthetic.json")).toBe(false);
    expect(published("fixtures/near/private/anything/else.json")).toBe(false);
    expect(sections().paths).toContain("!fixtures/near/private/**");
    // sensitivity: the matcher does include the neighbouring public snapshot
    expect(published("fixtures/near/near-2026-11-09/manifest.json")).toBe(true);
  });

  test.skipIf(!DEV_ALLOWLIST)("no published file of the lane contains a forbidden marker of the allowlist", () => {
    const markers = sections().forbidden ?? [];
    expect(markers.length).toBeGreaterThan(5);
    const roots = ["src/near/ironclaw", "src/near/mcp", "src/near/policy", "src/near/private", "fixtures/near/policies", "tests/fixtures/near-private-risk-manager"];
    const targets = [...roots.flatMap(r => files(join(REPO, r))), ...["review", "policy", "watch", "serve"].map(n => join(REPO, "src", "near", "cli", `${n}.ts`)), join(REPO, "tests", "near-private-risk-manager.test.ts")];
    expect(targets.length).toBeGreaterThan(25);
    const hits: string[] = [];
    for (const f of targets) {
      const text = readFileSync(f, "utf8");
      for (const m of markers) if (text.includes(m)) hits.push(`${relative(REPO, f)} :: ${m}`);
    }
    expect(hits).toEqual([]);
  });

  test("the synthetic book is not referenced by a published source file path other than as a CLI argument default-free input", () => {
    // fixtures/near/private is private: no published source may import from it
    for (const dir of ["src/near/ironclaw", "src/near/mcp", "src/near/policy", "src/near/private"]) for (const f of files(join(REPO, dir))) {
      expect(readFileSync(f, "utf8")).not.toMatch(/from\s+["'][^"']*fixtures\/near\/private/);
    }
  });

  test("no hostname, token or key is committed in the lane's published sources", () => {
    const targets = ["src/near/ironclaw", "src/near/mcp", "src/near/policy", "src/near/private", "fixtures/near/policies"].flatMap(d => files(join(REPO, d)));
    for (const f of targets) {
      const text = readFileSync(f, "utf8");
      expect({ f: relative(REPO, f), bearer: /Bearer [A-Za-z0-9]{16,}/.exec(text)?.[0] ?? null }).toEqual({ f: relative(REPO, f), bearer: null });
      expect(text).not.toMatch(/trycloudflare\.com|ngrok\.io|quantrin\.ai/i);
      expect({ f: relative(REPO, f), key: /\b[0-9a-f]{64}\b.*(token|secret)/i.exec(text)?.[0] ?? null }).toEqual({ f: relative(REPO, f), key: null });
    }
  });
});

// ===========================================================================
// Extra falsifiers: libraries in review/watch, timeouts, book resolution, constructed pair over MCP
// ===========================================================================
describe("extra falsifiers", () => {
  test("review with fake libraries fills the governance and intents sections instead of reporting missing coverage", async () => {
    const store = liveStore(), policy = await loadNearPolicy(SHIPPED);
    const calls: string[] = [];
    const libs = fakeLibraries(store, { calls });
    const review: any = buildNearReview(policy, store, LIVE, libs);
    expect(review.libraries.map((l: any) => l.status)).toEqual(["loaded", "loaded"]);
    expect(calls.some(c => c.startsWith("classify:nep141:17208628"))).toBe(true);
    expect(calls.some(c => c.startsWith("touching:") || c.startsWith("open:"))).toBe(true);
    expect(review.publicVerdict.rules.find((r: any) => r.ruleId === "usdc-route-family").outcome).toBe("within-policy");
    const absent: any = buildNearReview(policy, store, LIVE, NO_LIBRARIES);
    expect(canonical(review.governance)).not.toBe(canonical(absent.governance));
  });

  test("watch: a proposal that is open after but not before and touches a chain root gives a proposal event (governance library present)", async () => {
    const before = liveSnapshot();
    const after = mutate({ id: "tst-after-proposal" });
    const store = openStore([before, after]);
    const target = N("burrow.sputnik-dao.near#proposal:1746");
    const base = fakeLibraries(store);
    const open = fakeLibraries(store, { overrides: { [target]: { state: "open", effectClass: "funds" } }, touching: { "contract.main.burrow.near": [target] } });
    const libs = { ...base, governance: {
      ...base.governance!,
      openProposals: (snap: string, dao: string) => (snap === after.id ? open : base).governance!.openProposals(snap, dao),
      proposalsTouching: (snap: string, subject: string) => (snap === after.id ? open : base).governance!.proposalsTouching(snap, subject),
    } };
    const policy = await loadNearPolicy(SHIPPED);
    const { events } = watchPolicy({ policy, store, before: LIVE, after: after.id, libs });
    const proposal = (events as any[]).filter(e => e.kind === "dependency-changed" && e.cause === "proposal");
    expect(proposal.length).toBeGreaterThanOrEqual(1);
    expect(proposal.some(e => e.proposals.includes(target))).toBe(true);
    // the same libraries on identical snapshots give nothing
    expect(watchPolicy({ policy, store, before: LIVE, after: LIVE, libs }).events).toEqual([]);
  });

  test("watch without the governance library records a missing-coverage unknown and no proposal event", async () => {
    const store = pairStore();
    const { events, unknowns } = watchPolicy({ policy: await loadNearPolicy(SHIPPED), store, before: LIVE, after: CONSTRUCTED, libs: NO_LIBRARIES });
    expect((events as any[]).some(e => e.cause === "proposal")).toBe(false);
    expect(unknowns.some(u => u.code === "missing-coverage")).toBe(true);
  });

  test("MCP: a tool call that runs past the timeout returns isError timeout with no exception text", async () => {
    let t = 0;
    const handler = createMcpHandler({ token: TOKEN, snapshotId: LIVE, store: liveStore(), libs: NO_LIBRARIES, now: () => (t += 10_000) });
    const res = await handler(new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "linchpin_dependencies", arguments: { subject: "contract.main.burrow.near" } } }) }));
    const json: any = await res.json();
    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent.error).toBe("timeout");
  });

  test("MCP over the constructed pair: linchpin_changes shows exactly the one added locker grantee and marks it constructed", async () => {
    const pair = startMcpServer({ token: TOKEN, snapshotId: LIVE, store: pairStore(), libs: NO_LIBRARIES, port: 0 });
    try {
      const c = new McpClient(pair.url, TOKEN);
      const r = await c.call("linchpin_changes", { subject: "intents.near#role:UnrestrictedAccountLocker", before: LIVE, after: CONSTRUCTED });
      expect(r.json.result.isError).toBe(false);
      const text = JSON.stringify(sc(r));
      expect(text).toContain("linchpin-constructed-locker.near");
      expect(text).toContain('"constructed":true');
      expect(sc(r).changes).toHaveLength(1);
      expect(sc(r).changes[0].kind).toBe("added");
      // a snapshot id that is not loaded is refused as a structured result or schema error, never a crash
      const bad = await c.call("linchpin_changes", { subject: "intents.near", before: "near-2020-01-01", after: LIVE });
      expect(bad.status).toBe(200);
      expect(bad.json.error?.code === -32602 || bad.json.result?.isError === true || JSON.stringify(sc(bad)).includes("incompatible-snapshots") || JSON.stringify(sc(bad)).includes("missing")).toBe(true);
      // the shipped policy through the pair server evaluates at the server snapshot, unchanged
      const v = await c.call("linchpin_policy_verdict", { policyId: SHIPPED });
      expect(sc(v).snapshotId).toBe(LIVE);
    } finally { await pair.stop(); }
  });

  test("book resolution: the flag beats the environment, the environment is used otherwise, an explicit missing path is an error (no default path is read)", async () => {
    const dir = tmp();
    const a = join(dir, "a.json"), b = join(dir, "b.json");
    writeFileSync(a, readFileSync(CANARY_BOOK)); writeFileSync(b, readFileSync(join(FX, "book-before.json")));
    const viaFlag = await loadNearBook({ path: a, env: { LINCHPIN_NEAR_POSITIONS: b } });
    expect(viaFlag.source).toBe("flag"); expect(viaFlag.positions[0].id).toBe("cnry-id-q9x4h2");
    const viaEnv = await loadNearBook({ env: { LINCHPIN_NEAR_POSITIONS: b } });
    expect(viaEnv.source).toBe("env"); expect(viaEnv.positions).toHaveLength(2);
    let failed = false;
    try { await loadNearBook({ path: join(dir, "missing.json"), env: {} }); } catch (e) { failed = true; expect(String((e as Error).message)).toMatch(/book[ -]not[ -]found/i); }
    expect(failed).toBe(true);
  });

  test("review and policy CLIs fail closed: unknown policy, unknown snapshot and a missing positions file exit non-zero without writing a report", async () => {
    const dir = tmp(), out = join(dir, "never.md");
    const noPolicy = await capture(() => reviewCli.run(["no-such-policy", "--out", out, "--offline"]));
    expect(noPolicy.code).not.toBe(0);
    const noSnap = await capture(() => reviewCli.run([SHIPPED, "--snapshot", "near-2020-01-01", "--out", out, "--offline"]));
    expect(noSnap.code).not.toBe(0);
    const noBook = await capture(() => reviewCli.run([SHIPPED, "--positions", join(dir, "nope.json"), "--out", out, "--offline"]));
    expect(noBook.code).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    const pol = await capture(() => policyCli.run(["no-such-policy", "--offline"]));
    expect(pol.code).not.toBe(0);
  }, cliTimeout({ policy: 1, review: 3, watch: 0, watchShipped: 0 }));

  test.skipIf(!DEV_BOOK)("an existing report file is rewritten with mode 0600 even when it was group readable", async () => {
    const dir = tmp(), out = join(dir, "r.md");
    writeFileSync(out, "old"); chmodSync(out, 0o644);
    const r = await capture(() => reviewCli.run([SHIPPED, "--positions", SYNTHETIC_BOOK, "--out", out, "--offline"]));
    expect(r.code).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, "utf8")).toContain("Private local report");
  }, cliTimeout({ policy: 0, review: 1, watch: 0, watchShipped: 0 }));

  test.skipIf(!DEV_BOOK)("a book position on an unregistered root is uncovered in the report and the other rows stay covered", async () => {
    const dir = tmp(), out = join(dir, "r.md");
    await capture(() => reviewCli.run([SHIPPED, "--positions", SYNTHETIC_BOOK, "--out", out, "--offline"]));
    const rows = readFileSync(out, "utf8").split("\n").filter(l => l.startsWith("| `syn-"));
    expect(rows).toHaveLength(4);
    expect(rows.filter(r => r.includes("`covered`"))).toHaveLength(3);
    const stake = rows.find(r => r.includes("syn-stake"))!;
    expect(stake).toContain("`uncovered`"); expect(stake).toContain("missing-subject");
    expect(rows.join("\n")).not.toContain("synthetic-owner");
  }, cliTimeout({ policy: 0, review: 1, watch: 0, watchShipped: 0 }));
});
