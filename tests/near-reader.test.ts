/**
 * Tests for development-graph run 020-near-reader (AC1–AC10).
 *
 * Expectations are derived from the approved "NEAR reader" spec, the parent
 * "NEAR Linchpin" spec's control-surface table, the approved 020 plan and Peter's
 * binding decisions on 2026-11-09 (the NEAR-only object cap raised to 1,048,576
 * characters, the Q3/Q6/Q7 answers and the PC2/PC3 resolutions).
 *
 * Information boundary: only exported signatures were read in src/near/** and
 * src/engine/**; no implementation body and no implementation report. The CLI and the
 * loaders were run as a black box.
 *
 * Every test is offline. A global fetch trap throws and counts; the suite asserts the
 * count is zero. Record-mode tests inject their own fake fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, sha256 } from "../src/chain/evidence";
import { openStore, runQuery, validateSnapshot } from "../src/engine/queries/index";
import type { EvidenceStore } from "../src/engine/queries/index";
import {
  captureSnapshot,
  controlSurface,
  createNearClient,
  decodeArgs,
  historyFacts,
  liveSnapshotIds,
  loadNearSnapshot,
  loadNearSnapshots,
  mapSputnikPolicy,
  nearReads,
  nearStoreSha256,
  nearSubject,
  requestSha256,
  buildNearSnapshot,
  readNearManifest,
} from "../src/near/reader/index";
import type { NearRecord } from "../src/near/reader/index";
import { NEAR_REGISTRY, CURRENT_NEAR_SNAPSHOT, registryEntry } from "../src/near/subjects/registry";
import { runNearCommand } from "../src/near/cli/near";
import { buildIntentSnapshot } from "../src/near/intents/extension";

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_ALLOWLIST = existsSync(join(import.meta.dir, "..", "scripts", "publish" + "." + "allowlist"));

// ---------------------------------------------------------------------------
// Offline guarantee (AC1 / AC10): no test may reach the network.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    throw new Error("network disabled in near-reader tests");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  // AC1/AC10: no test reached the network; every record-mode test injected its own fetch.
  expect(fetchCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Paths and helpers
// ---------------------------------------------------------------------------
const REPO_ROOT = join(import.meta.dir, "..");
const NEAR_ROOT = join(REPO_ROOT, "fixtures", "near");
const TEST_FIXTURES = join(import.meta.dir, "fixtures", "near-reader");
const LIVE = CURRENT_NEAR_SNAPSHOT;
const CONSTRUCTED = "near-constructed-intents-locker-added";
const RPC = JSON.parse(readFileSync(join(TEST_FIXTURES, "rpc-responses.json"), "utf8")) as Record<string, unknown>;

function fakeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Serve a canned JSON-RPC body keyed by the request, from tests/fixtures/near-reader/rpc-responses.json. */
function fixtureFetch(bodies: Record<string, unknown> = RPC): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as any;
    let key: string;
    if (request.method === "status") key = "status";
    else if (request.method === "block") key = "block";
    else if (request.params.request_type === "call_function") key = request.params.method_name === "get_owner" ? "call_error" : "call_function";
    else key = request.params.request_type;
    const body = bodies[key];
    if (body === undefined) throw new Error(`no fake body for ${key}`);
    return fakeResponse(body);
  }) as unknown as typeof fetch;
}

function loadLive(): EvidenceStore {
  return loadNearSnapshot(LIVE, { root: NEAR_ROOT });
}

function liveSnapshot() {
  return loadLive().snapshot(LIVE)!;
}

function reasons(result: { reasons: { code: string }[] }): string[] {
  return result.reasons.map((r) => r.code);
}

// ===========================================================================
// 1. AC1 — fetch trap and offline loading
// ===========================================================================
describe("AC1 recording client and offline loading", () => {
  test("offline loading works with a trapped global fetch", () => {
    const before = fetchCalls;
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    expect(snapshot.chain).toBe("near");
    expect(snapshot.facts.length).toBeGreaterThan(0);
    expect(snapshot.receipts.length).toBeGreaterThan(0);
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    expect(index.records.length).toBeGreaterThan(0);
    expect(fetchCalls).toBe(before);
  });

  test("offline client returns missing-evidence for an absent fixture, never a network call", async () => {
    const before = fetchCalls;
    const client = createNearClient({
      mode: "offline",
      snapshotId: "near-offline-probe",
      snapshotDir: join(NEAR_ROOT, LIVE),
      endpointHost: readNearManifest(LIVE, { root: NEAR_ROOT }).endpointHost,
    });
    const read = await client.viewAccount("no-such-account-in-fixture.near");
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.error.kind).toBe("missing-fixture");
    expect(read.reasons).toHaveLength(1);
    expect(read.reasons[0].code).toBe("missing-evidence");
    expect(read.reasons[0].ref).toBe(
      requestSha256({ method: "query", params: { request_type: "view_account", account_id: "no-such-account-in-fixture.near", finality: "final" } }),
    );
    expect(fetchCalls).toBe(before);
  });

  test("a record-mode call writes one file with the required fields and no endpoint path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nr-record-"));
    try {
      const client = createNearClient({
        mode: "record",
        snapshotId: "near-record-probe",
        snapshotDir: dir,
        endpointHost: "example.invalid",
        endpointUrl: "https://example.invalid",
        archivalUrl: null,
        fetch: fixtureFetch(),
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        minIntervalMs: 0,
      });
      const reads = [await client.viewAccount("intents.near"), await client.viewAccessKeys("intents.near"), await client.viewCodeHash("intents.near"), await client.callFunction("intents.near", "acl_get_permissioned_accounts", {}), await client.block()];
      for (const read of reads) {
        expect(read.ok).toBe(true);
        const record = read.record!;
        const file = join(dir, `${record.requestSha256}.json`);
        const parsed = JSON.parse(readFileSync(file, "utf8")) as NearRecord;
        for (const key of ["request", "responseSha256", "blockHeight", "blockHash", "retrievedAt", "endpointHost"]) expect(parsed).toHaveProperty(key);
        expect(JSON.stringify({ ...parsed, response: undefined, resultText: undefined })).not.toContain("://");
        expect(read.receipt!.source).toBe("near-rpc:example.invalid");
        expect(read.receipt!.observation.chain).toBe("near");
        expect(read.receipt!.observation.network).toBe("mainnet");
        expect(read.receipt!.observation.historicalState).toBe("current-only");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a URL with a path, query or userinfo is rejected", () => {
    for (const url of ["https://example.invalid/v0/", "https://example.invalid/?k=1", "https://user:pass@example.invalid", "http://example.invalid", "https://example.invalid/#x"]) {
      expect(() =>
        createNearClient({ mode: "record", snapshotId: "near-x", snapshotDir: tmpdir(), endpointHost: "example.invalid", endpointUrl: url, fetch: fixtureFetch() }),
      ).toThrow(/credential-free origin/);
    }
  });

  test("a call-error yields ok false with a receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nr-callerr-"));
    try {
      const client = createNearClient({
        mode: "record",
        snapshotId: "near-callerr",
        snapshotDir: dir,
        endpointHost: "example.invalid",
        endpointUrl: "https://example.invalid",
        fetch: fixtureFetch(),
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        minIntervalMs: 0,
      });
      const read = await client.callFunction("aggregate-oracle.near", "get_owner", {});
      expect(read.ok).toBe(false);
      expect(read.receipt).not.toBeNull();
      expect(read.record!.outcome).toBe("call-error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 3. AC2 — mappers on the real records
// ===========================================================================
describe("AC2 mappers on the live snapshot", () => {
  const aclAccounts = ["intents.near", "omni.bridge.near", "omft.near", "ctl-intents.near"] as const;

  test("ACL grantee counts equal the recorded arrays, role by role", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    for (const account of aclAccounts) {
      const read = index.find(account, "call_function", "acl_get_permissioned_accounts");
      expect(read).not.toBeNull();
      const acl = read!.value as { super_admins: string[]; roles: Record<string, { admins: string[]; grantees: string[] }> };
      for (const [role, entry] of Object.entries(acl.roles)) {
        const node = nearSubject(account, "role", role);
        const onNode = snapshot.facts.filter((f) => f.predicate === "holds-role" && f.subject === node);
        expect(onNode.length).toBe(entry.grantees.length > 0 ? entry.grantees.length : 1);
        const objects = onNode.map((f) => f.object).sort();
        expect(objects).toEqual((entry.grantees.length > 0 ? entry.grantees.map((g) => nearSubject(g)) : ["none"]).sort());
      }
    }
  });

  test("an empty role has exactly one none fact", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    const read = index.find("intents.near", "call_function", "acl_get_permissioned_accounts");
    const acl = read!.value as { roles: Record<string, { grantees: string[] }> };
    const empties = Object.entries(acl.roles).filter(([, v]) => v.grantees.length === 0).map(([k]) => k);
    expect(empties.length).toBeGreaterThan(0);
    for (const role of empties) {
      const facts = snapshot.facts.filter((f) => f.predicate === "holds-role" && f.subject === nearSubject("intents.near", "role", role));
      expect(facts).toHaveLength(1);
      expect(facts[0].object).toBe("none");
    }
  });

  test("super-admin-of count equals super_admins.length per ACL contract", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    for (const account of aclAccounts) {
      const acl = index.find(account, "call_function", "acl_get_permissioned_accounts")!.value as { super_admins: string[] };
      const facts = snapshot.facts.filter((f) => f.predicate === "super-admin-of" && f.subject === nearSubject(account));
      expect(facts).toHaveLength(acl.super_admins.length);
    }
  });

  test("the largest proposal fact object is over 262144 and at most 1048576 characters", () => {
    const snapshot = liveSnapshot();
    const proposals = snapshot.facts.filter((f) => f.predicate === "proposal");
    expect(proposals.length).toBeGreaterThan(0);
    const largest = proposals.reduce((a, b) => (a.object.length >= b.object.length ? a : b));
    expect(largest.object.length).toBeGreaterThan(262144);
    expect(largest.object.length).toBeLessThanOrEqual(1048576);
    for (const p of proposals) expect(p.object.length).toBeLessThanOrEqual(1048576);
  });

  test("access keys: FullAccess vs FunctionCall carry receiver, methods and allowance", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    const keys = index.find("intents.near", "view_access_key_list")!.value as {
      keys: { public_key: string; access_key: { permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } } } }[];
    };
    const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key).sort();
    const fc = keys.keys.filter((k) => k.access_key.permission !== "FullAccess");
    const fullFacts = snapshot.facts.filter((f) => f.predicate === "has-full-access-key" && f.subject === nearSubject("intents.near")).map((f) => f.object).sort();
    expect(fullFacts).toEqual(full.length ? full : ["none"]);
    const fcFacts = snapshot.facts.filter((f) => f.predicate === "has-function-call-key" && f.subject === nearSubject("intents.near")).map((f) => f.object).sort();
    expect(fcFacts).toHaveLength(fc.length);
    for (const key of fc) {
      const permission = key.access_key.permission as { FunctionCall: { receiver_id: string; method_names: string[]; allowance: string | null } };
      const expected = `${key.public_key}|${permission.FunctionCall.receiver_id}|${permission.FunctionCall.method_names.join(",") || "*"}|${permission.FunctionCall.allowance === null ? "unlimited" : permission.FunctionCall.allowance}`;
      expect(fcFacts).toContain(expected);
    }
  });

  test("Sputnik policy yields one vote-threshold per vote_policy entry plus the default", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    const policy = index.find("intents.sputnik-dao.near", "call_function", "get_policy")!.value as {
      roles: { name: string; vote_policy: Record<string, unknown> }[];
      default_vote_policy: unknown;
    };
    const dao = nearSubject("intents.sputnik-dao.near");
    const defaults = snapshot.facts.filter((f) => f.predicate === "vote-threshold" && f.subject === dao);
    expect(defaults.some((f) => f.object.includes("|default|"))).toBe(true);
    for (const role of policy.roles) {
      const node = nearSubject("intents.sputnik-dao.near", "role", role.name);
      const thresholds = snapshot.facts.filter((f) => f.predicate === "vote-threshold" && f.subject === node);
      expect(thresholds).toHaveLength(Object.keys(role.vote_policy).length);
      for (const kind of Object.keys(role.vote_policy)) expect(thresholds.some((f) => f.object.split("|")[1] === kind)).toBe(true);
    }
    expect(snapshot.facts.filter((f) => f.predicate === "proposal-period" && f.subject === dao)).toHaveLength(1);
    expect(snapshot.facts.filter((f) => f.predicate === "bond" && f.subject === dao)).toHaveLength(1);
  });

  test("proposal 108 decodes its base64 args to JSON naming UnrestrictedAccountLocker", () => {
    const snapshot = liveSnapshot();
    const fact = snapshot.facts.find((f) => f.subject === nearSubject("intents.sputnik-dao.near", "proposal", "108"));
    expect(fact).toBeDefined();
    const object = JSON.parse(fact!.object) as { kind: { FunctionCall: { actions: { args: unknown; argsFormat: string; method_name: string }[] } } };
    const action = object.kind.FunctionCall.actions[0];
    expect(action.argsFormat).toBe("json");
    expect(action.method_name).toBe("acl_grant_role");
    expect(JSON.stringify(action.args)).toContain("UnrestrictedAccountLocker");
    expect(action).not.toHaveProperty("description");
  });

  test("proposal facts carry id, proposer, status, submission_time, submittedAt, vote_counts, votes", () => {
    const snapshot = liveSnapshot();
    for (const fact of snapshot.facts.filter((f) => f.predicate === "proposal").slice(0, 25)) {
      const object = JSON.parse(fact.object) as Record<string, unknown>;
      for (const key of ["id", "kind", "proposer", "status", "submission_time", "submittedAt", "vote_counts", "votes"]) expect(object).toHaveProperty(key);
      expect(object).not.toHaveProperty("description");
    }
  });

  test("controller deployments give upgrade_times plus the current version per node", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    const deployments = index.find("ctl-intents.near", "call_function", "get_deployments")!.value as Record<string, { upgrade_times: Record<string, string>; version: string }>;
    for (const [contract, node] of Object.entries(deployments)) {
      const subject = nearSubject("ctl-intents.near", "deployment", contract);
      const facts = snapshot.facts.filter((f) => f.predicate === "deployed-version" && f.subject === subject);
      expect(facts).toHaveLength(Object.keys(node.upgrade_times).length + 2);
      expect(facts.some((f) => f.object === `${node.version}@current`)).toBe(true);
      expect(facts.some((f) => f.object.startsWith("initial@"))).toBe(true);
    }
  });

  test("MPC state: threshold and participant count match the record; images map", () => {
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const snapshot = liveSnapshot();
    const state = index.find("v1.signer", "call_function", "state")!.value as { Running: { parameters: { threshold: number; participants: { participants: [string, unknown][] } } } };
    const parameters = state.Running.parameters;
    const signer = nearSubject("v1.signer");
    expect(snapshot.facts.filter((f) => f.predicate === "mpc-threshold" && f.subject === signer)).toHaveLength(1);
    expect(snapshot.facts.find((f) => f.predicate === "mpc-threshold" && f.subject === signer)!.object).toBe(String(parameters.threshold));
    expect(snapshot.facts.filter((f) => f.predicate === "mpc-participant" && f.subject === signer)).toHaveLength(parameters.participants.participants.length);
    const images = index.find("v1.signer", "call_function", "allowed_docker_image_hashes")!.value as unknown[];
    expect(snapshot.facts.filter((f) => f.predicate === "mpc-allowed-image" && f.subject === signer)).toHaveLength(images.length);
  });

  test("Burrow get_config yields owner, enabled/disabled oracles, routes, pause operator none and Running", () => {
    const snapshot = liveSnapshot();
    const burrow = nearSubject("contract.main.burrow.near");
    expect(snapshot.facts.find((f) => f.predicate === "owned-by" && f.subject === burrow)!.object).toBe(nearSubject("burrow.sputnik-dao.near"));
    expect(snapshot.facts.some((f) => f.predicate === "priced-by" && f.subject === burrow && f.object === nearSubject("aggregate-oracle.near"))).toBe(true);
    expect(snapshot.facts.some((f) => f.predicate === "legacy-oracle" && f.subject === burrow && f.object === nearSubject("priceoracle.near"))).toBe(true);
    expect(snapshot.facts.some((f) => f.predicate === "routes-through" && f.subject === burrow && f.object === nearSubject("v2.ref-finance.near"))).toBe(true);
    expect(snapshot.facts.find((f) => f.predicate === "pause-operator" && f.subject === burrow)!.object).toBe("none");
    expect(snapshot.facts.find((f) => f.predicate === "contract-mode" && f.subject === burrow)!.object).toBe("Running");
  });

  test("Ref owner and guardians, pause state and ft-metadata are present", () => {
    const snapshot = liveSnapshot();
    expect(snapshot.facts.some((f) => f.predicate === "owned-by" && f.subject === nearSubject("v2.ref-finance.near"))).toBe(true);
    expect(snapshot.facts.some((f) => f.predicate === "holds-role" && f.subject === nearSubject("v2.ref-finance.near", "role", "guardian"))).toBe(true);
    expect(snapshot.facts.some((f) => f.predicate === "paused" && f.subject === nearSubject("intents.near") && f.object === "false")).toBe(true);
    const metadata = snapshot.facts.filter((f) => f.predicate === "ft-metadata");
    expect(metadata.length).toBeGreaterThan(0);
    for (const fact of metadata) {
      const object = JSON.parse(fact.object) as Record<string, unknown>;
      for (const key of ["spec", "name", "symbol", "decimals", "reference", "reference_hash", "iconSha256"]) expect(object).toHaveProperty(key);
    }
  });

  test("forbidden words are absent outside the verbatim on-chain subtrees (Q6)", () => {
    const snapshot = liveSnapshot();
    const forbidden = /\bmultisig\b|\bupgrade authority\b|\bprograms?\b|\bpda\b/i;
    for (const fact of snapshot.facts) {
      expect(fact.predicate).not.toMatch(forbidden);
      if (fact.predicate === "proposal") {
        const object = JSON.parse(fact.object) as Record<string, unknown>;
        delete object.kind;
        expect(JSON.stringify(object)).not.toMatch(forbidden);
      } else if (fact.predicate === "ft-metadata") {
        const object = JSON.parse(fact.object) as Record<string, unknown>;
        delete object.name;
        delete object.symbol;
        expect(JSON.stringify(object)).not.toMatch(forbidden);
      } else {
        expect(fact.object).not.toMatch(forbidden);
      }
    }
  });

  test("synthetic: Resharing state, TokenWeight policy, non-JSON args and a role name with a space", () => {
    expect(decodeArgs(Buffer.from([0xff, 0xfe]).toString("base64"))).toEqual({ argsFormat: "base64", args: "//4=" });
    expect(decodeArgs(Buffer.from('{"a":1}').toString("base64"))).toEqual({ argsFormat: "json", args: { a: 1 } });
    expect(nearSubject("intents.near", "role", "Council Member")).toContain("Council~20Member");
    const policy = mapSputnikPolicy(
      {
        roles: [
          { name: "Council Member", kind: { Member: "10" }, permissions: ["*:*"], vote_policy: { call: { weight_kind: "TokenWeight", quorum: "10", threshold: "500" } } },
        ],
        default_vote_policy: { weight_kind: "TokenWeight", quorum: "10", threshold: "500" },
        proposal_period: "1",
        proposal_bond: "1",
        bounty_bond: "1",
        bounty_forgiveness_period: "1",
      },
      { id: "r", source: "near-rpc:x", responseSha256: "0".repeat(64), privacy: "public", observation: { chain: "near", network: "mainnet", blockOrSlot: "1", blockHash: null, observedAt: "2026-01-01T00:00:00.000Z", retrievedAt: "2026-01-01T00:00:00.000Z", historicalState: "current-only" } } as any,
      { snapshotId: "s", account: "intents.near", entry: registryEntry("intents.near")!, constructed: false },
    );
    expect(policy.some((f) => f.object.includes("TokenWeight"))).toBe(true);
  });
});

// ===========================================================================
// 4. AC3 — subject registry and coverage
// ===========================================================================
describe("AC3 subject registry", () => {
  test("every account in the control-surface table is registered with a chain tag", () => {
    const accounts = [
      "contract.main.burrow.near", "burrow.sputnik-dao.near", "aggregate-oracle.near", "priceoracle.near",
      "v2.ref-finance.near", "ref-finance.sputnik-dao.near", "sputnik-dao.near", "dclv2.ref-labs.near",
      "intents.near", "ctl-intents.near", "intents.sputnik-dao.near", "relay-key-manager.near", "pm.bridge.near",
      "bridge-mng.near", "bridge-ops.near", "wrap.near", "omft.near", "omni.bridge.near", "omdep.near",
      "v2_1.omni.hot.tg", "v1.signer", "rainbowbridge.sputnik-dao.near", "hos-root.sputnik-dao.near",
      "int-mnt-dao.sputnik-dao.near",
    ];
    const chains = new Set(["rhea", "intents", "governance", "mpc"]);
    for (const account of accounts) {
      const entry = registryEntry(account);
      expect(entry).toBeDefined();
      expect(entry!.chains.length).toBeGreaterThan(0);
      for (const chain of entry!.chains) expect(chains.has(chain)).toBe(true);
    }
    expect(NEAR_REGISTRY.filter((e) => e.chains.includes("rhea")).length).toBeGreaterThanOrEqual(6);
    expect(NEAR_REGISTRY.filter((e) => e.chains.includes("intents")).length).toBeGreaterThanOrEqual(12);
    expect(NEAR_REGISTRY.filter((e) => e.chains.includes("mpc")).map((e) => e.account)).toContain("v1.signer");
  });

  test("every registry entry has a record and every declared yield appears as a fact", () => {
    const snapshot = liveSnapshot();
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const accountsWithRecords = new Set(
      index.records.filter((r) => r.request.method === "query").map((r) => (r.request as { params: { account_id: string } }).params.account_id),
    );
    for (const entry of NEAR_REGISTRY) {
      expect(accountsWithRecords.has(entry.account)).toBe(true);
      for (const relation of entry.yields) {
        const facts = snapshot.facts.filter((f) => f.subject === entry.subject && f.predicate === relation);
        expect(facts.length).toBeGreaterThan(0);
      }
      if (entry.deployedBy) expect(registryEntry(entry.deployedBy)).toBeDefined();
    }
  });

  test("a registry copy with an extra account fails coverage naming that account", () => {
    const snapshot = liveSnapshot();
    const index = nearReads(LIVE, { root: NEAR_ROOT });
    const accountsWithRecords = new Set(
      index.records.filter((r) => r.request.method === "query").map((r) => (r.request as { params: { account_id: string } }).params.account_id),
    );
    const uncovered = [...NEAR_REGISTRY, { account: "not-captured.near" }].filter((e) => !accountsWithRecords.has(e.account)).map((e) => e.account);
    expect(uncovered).toContain("not-captured.near");
    for (const account of uncovered) expect(snapshot.subjects).not.toContain(nearSubject(account));
  });
});

// ===========================================================================
// 5. Receipts and fixture hygiene (AC1/AC10)
// ===========================================================================
describe("receipts and fixture hygiene", () => {
  test("receipt ids are unique and match nr:<snapshotId>:<40 hex>", () => {
    const snapshot = liveSnapshot();
    const ids = snapshot.receipts.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^nr:near-2026-11-09:[0-9a-f]{40}$/);
  });

  test("record request hashes are unique and each receipt is near/mainnet with host-only source", () => {
    const snapshot = liveSnapshot();
    const records = nearReads(LIVE, { root: NEAR_ROOT }).records;
    const hashes = records.map((r) => r.requestSha256);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const receipt of snapshot.receipts) {
      expect(receipt.source.startsWith("near-rpc:")).toBe(true);
      expect(receipt.source.slice("near-rpc:".length)).not.toContain("/");
      expect(receipt.observation.chain).toBe("near");
      expect(receipt.observation.network).toBe("mainnet");
    }
  });

  test("fixture files contain no endpoint path, key or auth header; on-chain URLs are the approved exception", () => {
    const dir = join(NEAR_ROOT, LIVE);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(manifest).not.toContain("://");
    expect(manifest.toLowerCase()).not.toContain("authorization");
    const forbiddenEnvelope = /apikey|api_key|authorization|bearer|x-api-key/i;
    const host = readNearManifest(LIVE, { root: NEAR_ROOT }).endpointHost;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file === "manifest.json") continue;
      const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as NearRecord & { response: unknown; resultText?: string };
      const envelope = JSON.stringify({ ...record, response: undefined, resultText: undefined });
      expect(envelope).not.toMatch(forbiddenEnvelope);
      expect(envelope).not.toContain("://");
      // The only `http` substring allowed in an envelope is the numeric httpStatus field.
      expect(envelope.replace(/"httpStatus":\d+/g, "")).not.toMatch(/http/i);
      // No endpoint path: the host appears only as a bare host, never with a path.
      expect(envelope).not.toContain(`${host}/`);
      expect(envelope).not.toContain("/v0/");
      expect(envelope).not.toContain("/v1/");
    }
  });
});

// ===========================================================================
// 6. AC6 / AC7 — engine queries and changes
// ===========================================================================
describe("AC6 queries answer over the store", () => {
  function scopeAt(snapshot: ReturnType<typeof liveSnapshot>) {
    return { asOf: snapshot.observedTo, snapshotId: LIVE, maxHops: 8, maxResults: 500 };
  }

  test("dependencies over the RHEA chain returns the six hops and unknown-controller", () => {
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    const result = runQuery(store, {
      name: "dependencies",
      subject: "near:mainnet:contract.main.burrow.near",
      relations: ["owned-by", "priced-by", "routes-through", "deployed-by"],
      scope: scopeAt(snapshot),
    });
    expect(["complete", "partial"]).toContain(result.outcome);
    expect(result.facts.length).toBeGreaterThan(0);
    const subjects = new Set(result.facts.map((f) => f.subject));
    for (const expected of [
      "near:mainnet:burrow.sputnik-dao.near",
      "near:mainnet:aggregate-oracle.near",
      "near:mainnet:v2.ref-finance.near",
      "near:mainnet:ref-finance.sputnik-dao.near",
      "near:mainnet:sputnik-dao.near",
    ]) expect(subjects.has(expected)).toBe(true);
    expect(result.reasons.some((r) => r.code === "unknown-controller" && r.subject === "near:mainnet:aggregate-oracle.near")).toBe(true);
  });

  test("dependencies over intents.near reaches the controller, the DAO, its role grantees and the factory", () => {
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    const result = runQuery(store, {
      name: "dependencies",
      subject: "near:mainnet:intents.near",
      relations: ["upgraded-by", "holds-role", "super-admin-of", "owned-by", "deployed-by"],
      scope: scopeAt(snapshot),
    });
    expect(result.facts.length).toBeGreaterThan(0);
    const subjects = new Set(result.facts.map((f) => f.subject));
    for (const expected of ["near:mainnet:ctl-intents.near", "near:mainnet:intents.sputnik-dao.near", "near:mainnet:sputnik-dao.near"]) {
      expect(subjects.has(expected)).toBe(true);
    }
    expect([...subjects].some((s) => s.startsWith("near:mainnet:intents.near#role:"))).toBe(true);
  });

  test("control returns keys, roles, thresholds, pause state and every fact has a receipt in range", () => {
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    const surface = controlSurface(store, LIVE, "near:mainnet:intents.near", snapshot.observedTo);
    expect(surface.fullAccessKeys).toHaveLength(0);
    expect(surface.functionCallKeys).toBeGreaterThan(0);
    expect(Object.keys(surface.roles).length).toBeGreaterThan(0);
    expect(surface.paused).toContain("false");
    expect(surface.factIds.length).toBeGreaterThan(0);
    for (const result of surface.results) {
      for (const receipt of result.receipts) {
        if (receipt.observation.blockOrSlot === null) continue;
        expect(BigInt(receipt.observation.blockOrSlot) >= BigInt(snapshot.fromBlockOrSlot!)).toBe(true);
        expect(BigInt(receipt.observation.blockOrSlot) <= BigInt(snapshot.toBlockOrSlot!)).toBe(true);
      }
    }
  });

  test("control over the DAO gives council size and thresholds; factory keys are root", () => {
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    const dao = controlSurface(store, LIVE, "near:mainnet:intents.sputnik-dao.near", snapshot.observedTo);
    expect(dao.councilMembers.length).toBeGreaterThan(0);
    expect(dao.voteThresholds.length).toBeGreaterThan(0);
    const factory = controlSurface(store, LIVE, "near:mainnet:sputnik-dao.near", snapshot.observedTo);
    expect(factory.fullAccessKeys.length).toBeGreaterThan(0);
  });

  test("evidence query resolves a stored receipt and its fact", () => {
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    const fact = snapshot.facts[0];
    const result = runQuery(store, { name: "evidence", evidenceIds: [fact.evidenceIds[0]], maxResults: 10 });
    expect(result.receipts.map((r) => r.id)).toContain(fact.evidenceIds[0]);
  });
});

describe("AC7 changes between snapshots", () => {
  test("self-pair gives zero changes", () => {
    const store = loadLive();
    const result = runQuery(store, { name: "changes", subject: "near:mainnet:intents.near", beforeSnapshotId: LIVE, afterSnapshotId: LIVE, maxResults: 500 });
    expect(result.changes).toHaveLength(0);
    expect(result.observations.every((o) => o.constructed === false)).toBe(true);
  });

  test("the constructed pair shows exactly one added locker grantee", () => {
    const store = loadNearSnapshots([LIVE, CONSTRUCTED], { root: NEAR_ROOT });
    const result = runQuery(store, {
      name: "changes",
      subject: "near:mainnet:intents.near#role:UnrestrictedAccountLocker",
      beforeSnapshotId: LIVE,
      afterSnapshotId: CONSTRUCTED,
      maxResults: 500,
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].kind).toBe("added");
    expect(result.changes[0].before).toBeNull();
    expect(result.changes[0].after!.object).toBe(nearSubject("linchpin-constructed-locker.near"));
    const constructed = result.observations.find((o) => o.snapshotId === CONSTRUCTED);
    expect(constructed?.constructed).toBe(true);
    const live = result.observations.find((o) => o.snapshotId === LIVE);
    expect(live?.constructed).toBe(false);
  });

  test.skipIf(!liveSnapshotIds(NEAR_ROOT).includes("near-2026-11-13"))(
    "the real pair near-2026-11-13 (skipped until the freeze-day capture exists)",
    () => {
      const store = loadNearSnapshots([LIVE, "near-2026-11-13"], { root: NEAR_ROOT });
      const result = runQuery(store, { name: "changes", subject: "near:mainnet:intents.near", beforeSnapshotId: LIVE, afterSnapshotId: "near-2026-11-13", maxResults: 500 });
      expect(result.observations.every((o) => o.constructed === false)).toBe(true);
      for (const change of result.changes) {
        if (change.before) expect(change.before.evidenceIds.length).toBeGreaterThan(0);
        if (change.after) expect(change.after.evidenceIds.length).toBeGreaterThan(0);
      }
    },
  );

  test("a chain mismatch gives incompatible-snapshots (Q7)", () => {
    const solana = JSON.parse(readFileSync(join(TEST_FIXTURES, "solana-min.json"), "utf8"));
    const store = loadNearSnapshots([LIVE], { root: NEAR_ROOT });
    // openStore through the engine with both snapshots; a Solana snapshot cannot be added to a NEAR store,
    // so the engine boundary is exercised directly.
    const engineStore = openStore([store.snapshot(LIVE)!, solana]);
    const result = runQuery(engineStore, { name: "changes", subject: "near:mainnet:intents.near", beforeSnapshotId: LIVE, afterSnapshotId: "solana-min", maxResults: 10 });
    expect(result.reasons.map((r) => r.code)).toContain("incompatible-snapshots");
    expect(result.changes).toHaveLength(0);
  });

  test("a subject missing on one side gives missing-coverage (Q7)", () => {
    const store = loadNearSnapshots([LIVE, CONSTRUCTED], { root: NEAR_ROOT });
    const result = runQuery(store, { name: "changes", subject: "near:mainnet:wrap.near", beforeSnapshotId: LIVE, afterSnapshotId: CONSTRUCTED, maxResults: 10 });
    expect(result.reasons.map((r) => r.code)).toContain("missing-coverage");
    expect(result.changes).toHaveLength(0);
  });
});

// ===========================================================================
// 7. PC2 / AC5 — failed pinned read stays honest
// ===========================================================================
describe("PC2 failed pinned read", () => {
  const UNKNOWN_BLOCK = {
    jsonrpc: "2.0",
    id: "near-reader",
    error: {
      name: "HANDLER_ERROR",
      cause: { name: "UNKNOWN_BLOCK", info: { block_reference: { block_id: 999999999999 } } },
      code: -32000,
      message: "Server error",
      data: "DB Not Found Error",
    },
  };

  test("a pinned read answered UNKNOWN_BLOCK gives a current-only receipt and an unknown history receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nr-pinned-"));
    const seen: { block_id?: number; finality?: string }[] = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { params: { block_id?: number; finality?: string } };
      seen.push(request.params);
      return fakeResponse(request.params.block_id !== undefined ? UNKNOWN_BLOCK : RPC.view_account);
    }) as unknown as typeof fetch;
    try {
      const client = createNearClient({
        mode: "record",
        snapshotId: "near-probe",
        snapshotDir: dir,
        endpointHost: "archival-rpc.mainnet.fastnear.com",
        endpointUrl: "https://archival-rpc.mainnet.fastnear.com",
        archivalUrl: "https://archival-rpc.mainnet.fastnear.com",
        fetch: fake,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        minIntervalMs: 0,
      });
      const read = await client.viewAccount("intents.near", { blockId: "999999999999" });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("expected ok");
      expect(read.receipt!.observation.historicalState).toBe("current-only");
      expect(read.historyReceipt).not.toBeNull();
      expect(read.historyReceipt!.observation.historicalState).toBe("unknown");
      expect(reasons(read)).toContain("missing-history");
      expect(read.reasons.find((r) => r.code === "missing-history")!.ref).toBe(read.historyReceipt!.id);
      const pinned = client.records.find((r) => "block_id" in r.request.params)!;
      expect(pinned.outcome).toBe("rpc-error");
      expect(pinned.archival).toMatchObject({ attempted: true, errorName: "UNKNOWN_BLOCK" });
      expect(read.historyReceipt!.responseSha256).toBe((pinned.archival as { errorBodySha256: string }).errorBodySha256);
      expect(seen.map((p) => (p.block_id !== undefined ? "pinned" : p.finality))).toEqual(["pinned", "final"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pinned read with no archival URL records not-attempted and never a pinned receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nr-unpinned-"));
    const seen: { block_id?: number; finality?: string }[] = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { params: { block_id?: number; finality?: string } };
      seen.push(request.params);
      return fakeResponse(RPC.view_account);
    }) as unknown as typeof fetch;
    try {
      const client = createNearClient({
        mode: "record",
        snapshotId: "near-probe",
        snapshotDir: dir,
        endpointHost: "example.invalid",
        endpointUrl: "https://example.invalid",
        archivalUrl: null,
        fetch: fake,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        minIntervalMs: 0,
      });
      const read = await client.viewAccount("intents.near", { blockId: "223800000" });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("expected ok");
      expect(read.receipt!.observation.historicalState).toBe("current-only");
      expect(read.historyReceipt).toBeNull();
      expect(reasons(read)).toContain("missing-history");
      expect(seen.every((p) => p.block_id === undefined)).toBe(true);
      const pinned = client.records.find((r) => "block_id" in r.request.params)!;
      expect(pinned.outcome).toBe("not-attempted");
      expect(pinned.archival).toMatchObject({ attempted: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("offline replay of the recorded UNKNOWN_BLOCK probe gives the same result", async () => {
    const before = fetchCalls;
    const client = createNearClient({
      mode: "offline",
      snapshotId: "near-probe-unknown-block",
      snapshotDir: join(NEAR_ROOT, "probes", "unknown-block"),
      endpointHost: "archival-rpc.mainnet.fastnear.com",
    });
    const read = await client.viewAccount("intents.near", { blockId: "999999999999" });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected ok");
    expect(read.receipt!.observation.historicalState).toBe("current-only");
    expect(read.historyReceipt!.observation.historicalState).toBe("unknown");
    expect(read.historyReceipt!.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reasons(read)).toContain("missing-history");
    expect(fetchCalls).toBe(before);
  });

  test("no receipt in any snapshot or probe is pinned", () => {
    for (const id of liveSnapshotIds(NEAR_ROOT)) {
      const snapshot = buildNearSnapshot(id, { root: NEAR_ROOT });
      expect(snapshot.receipts.filter((r) => r.observation.historicalState === "pinned")).toHaveLength(0);
    }
  });

  test("a successful pinned read is the only path to pinned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nr-pin-ok-"));
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { params: { block_id?: number } };
      return fakeResponse(request.params.block_id !== undefined ? RPC.archival_success : RPC.view_account);
    }) as unknown as typeof fetch;
    try {
      const client = createNearClient({
        mode: "record",
        snapshotId: "near-pin-ok",
        snapshotDir: dir,
        endpointHost: "archival-rpc.mainnet.fastnear.com",
        endpointUrl: "https://archival-rpc.mainnet.fastnear.com",
        archivalUrl: "https://archival-rpc.mainnet.fastnear.com",
        fetch: fake,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        minIntervalMs: 0,
      });
      const read = await client.viewAccount("intents.near", { blockId: "223800000" });
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("expected ok");
      expect(read.receipt!.observation.historicalState).toBe("pinned");
      expect(read.receipt!.observation.blockOrSlot).toBe("223800000");
      expect(read.historyReceipt).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 8. AC8 — history from on-chain records
// ===========================================================================
describe("AC8 history facts", () => {
  test("intents.near history includes the 0.4.4/0.4.5 upgrades and the approved 105-108 proposals", () => {
    const store = loadLive();
    const snapshot = store.snapshot(LIVE)!;
    const history = historyFacts(store, "near:mainnet:intents.near", LIVE);
    const upgrades = history.events.filter((e) => e.kind === "code-upgrade");
    expect(upgrades.some((e) => e.at.startsWith("2026-10-02"))).toBe(true);
    expect(upgrades.some((e) => e.at.startsWith("2026-10-07"))).toBe(true);

    // PC3: expected proposal ids are derived from the recorded statuses, not hard-coded.
    const proposals = snapshot.facts.filter(
      (f) => f.predicate === "proposal" && f.subject.startsWith("near:mainnet:intents.sputnik-dao.near#proposal:"),
    );
    const approved = proposals
      .map((f) => JSON.parse(f.object) as { id: number; status: string; submittedAt: string })
      .filter((p) => p.status === "Approved" && [105, 106, 107, 108].includes(p.id));
    expect(approved.map((p) => p.id).sort((a, b) => a - b)).toEqual([105, 106, 107, 108]);
    for (const proposal of approved) {
      const event = history.events.find((e) => e.source.subject === nearSubject("intents.sputnik-dao.near", "proposal", String(proposal.id)));
      expect(event).toBeDefined();
      expect(event!.at).toBe(proposal.submittedAt);
    }
  });

  test("events are ordered and every event fact is derived from its single source", () => {
    const store = loadLive();
    const history = historyFacts(store, "near:mainnet:intents.near", LIVE);
    expect(history.events.length).toBeGreaterThan(0);
    for (let i = 1; i < history.events.length; i++) {
      const prev = history.events[i - 1];
      const current = history.events[i];
      expect(prev.at < current.at || (prev.at === current.at && prev.source.id <= current.source.id)).toBe(true);
    }
    for (const event of history.events) {
      expect(event.fact.basis).toBe("derived");
      expect(event.fact.path).toEqual([event.source.id]);
      expect(event.fact.evidenceIds).toEqual(event.source.evidenceIds);
      expect(event.fact.subject).toBe("near:mainnet:intents.near");
    }
  });

  test("an InProgress acl proposal produces no event (PC3 negative)", () => {
    const snapshot = structuredClone(loadLive().snapshot(LIVE)!);
    const target = snapshot.facts.find((f) => f.subject === nearSubject("intents.sputnik-dao.near", "proposal", "107"))!;
    const object = JSON.parse(target.object) as Record<string, unknown>;
    object.status = "InProgress";
    target.object = JSON.stringify(object);
    const history = historyFacts(openStore([snapshot]), "near:mainnet:intents.near", LIVE);
    expect(history.events.some((e) => e.source.subject === target.subject)).toBe(false);
  });

  test("a constructed store with no deployed-version facts infers no code events", () => {
    const snapshot = structuredClone(buildNearSnapshot(CONSTRUCTED, { root: NEAR_ROOT }));
    const history = historyFacts(openStore([snapshot]), "near:mainnet:intents.near", CONSTRUCTED);
    expect(history.events.filter((e) => e.kind === "code-upgrade" || e.kind === "code-deployed")).toHaveLength(0);
  });

  test("a windowed DAO adds a missing-coverage reason", () => {
    const store = loadLive();
    const history = historyFacts(store, "near:mainnet:intents.near", LIVE);
    expect(history.reasons.some((r) => r.code === "missing-coverage")).toBe(true);
  });
});

// ===========================================================================
// 9. AC9 — CLI over committed snapshots, offline
// ===========================================================================
describe("AC9 CLI", () => {
  async function capture(args: string[]): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    console.error = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    try {
      const code = await runNearCommand(args);
      return { code, lines };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  test("subjects prints a table with exit 0", async () => {
    const before = fetchCalls;
    const { code, lines } = await capture(["subjects"]);
    expect(code).toBe(0);
    expect(lines[0]).toContain("account");
    expect(lines.length).toBe(NEAR_REGISTRY.length + 1);
    expect(fetchCalls).toBe(before);
  });

  test("subjects --json parses and equals the registry", async () => {
    const { code, lines } = await capture(["subjects", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.map((e: { account: string }) => e.account)).toEqual(NEAR_REGISTRY.map((e) => e.account));
  });

  test("facts intents.near --offline prints each fact with at least one receipt line", async () => {
    const before = fetchCalls;
    const { code, lines } = await capture(["facts", "intents.near", "--offline"]);
    expect(code).toBe(0);
    const factLines = lines.filter((l) => /^nf:/.test(l));
    expect(factLines.length).toBeGreaterThan(0);
    for (let i = 0; i < lines.length; i++) {
      if (!/^nf:/.test(lines[i])) continue;
      const next = lines[i + 1];
      expect(next).toBeDefined();
      expect(next).toMatch(/^\s+nr:near-2026-11-09:[0-9a-f]{40} \S+ \d+ [0-9a-f]{12}$/);
    }
    expect(fetchCalls).toBe(before);
  });

  test("snapshot <id> prints the manifest offline", async () => {
    const { code, lines } = await capture(["snapshot", LIVE]);
    expect(code).toBe(0);
    const manifest = JSON.parse(lines.join("\n"));
    expect(manifest.snapshotId).toBe(LIVE);
  });

  test("diff prints the one added locker change and both receipts offline", async () => {
    const before = fetchCalls;
    const { code, lines } = await capture(["diff", "intents.near#role:UnrestrictedAccountLocker", LIVE, CONSTRUCTED, "--offline"]);
    expect(code).toBe(0);
    expect(lines[0]).toContain("complete: 1 changes");
    expect(lines).toContain("added");
    const receiptLines = lines.filter((l) => /^\s+nr:/.test(l));
    expect(receiptLines.length).toBeGreaterThanOrEqual(1);
    expect(receiptLines.some((l) => l.includes("nr:near-constructed-intents-locker-added:"))).toBe(true);
    expect(fetchCalls).toBe(before);
  });

  test("an unknown subcommand returns 1 and an unknown account returns 0 with missing-subject", async () => {
    const unknown = await capture(["bogus"]);
    expect(unknown.code).toBe(1);
    const missing = await capture(["facts", "nobody.near", "--offline"]);
    expect(missing.code).toBe(0);
    expect(missing.lines.join("\n")).toContain("missing-subject near:mainnet:nobody.near");
  });

  test("src/cli.ts registers exactly one near dispatcher line", () => {
    const cli = readFileSync(join(REPO_ROOT, "src", "cli.ts"), "utf8");
    expect(cli.match(/cmd === "near"/g)?.length).toBe(1);
  });
});

// ===========================================================================
// 10. Solana regression and the NEAR-only object cap
// ===========================================================================
describe("Solana regression and the NEAR-only relaxation", () => {
  test("solana-min.json is still accepted", () => {
    const solana = JSON.parse(readFileSync(join(TEST_FIXTURES, "solana-min.json"), "utf8"));
    expect(() => validateSnapshot(solana)).not.toThrow();
  });

  test("a long NEAR object is accepted but the same object is rejected for Solana", () => {
    const near = buildNearSnapshot(LIVE, { root: NEAR_ROOT });
    const long = near.facts.find((f) => f.object.length > 262144);
    expect(long).toBeDefined();
    const solana = JSON.parse(readFileSync(join(TEST_FIXTURES, "solana-min.json"), "utf8"));
    const relaxed = structuredClone(solana);
    relaxed.facts[0].object = "x".repeat(300000);
    expect(() => validateSnapshot(relaxed)).toThrow(/malformed fact object/);
    const nearLong = structuredClone(near);
    nearLong.facts[0].object = "x".repeat(300000);
    expect(() => validateSnapshot(nearLong)).not.toThrow();
  });

  test("the NEAR object cap is 1048576 characters, not more", () => {
    const near = buildNearSnapshot(LIVE, { root: NEAR_ROOT });
    const over = structuredClone(near);
    over.facts[0].object = "x".repeat(1048577);
    expect(() => validateSnapshot(over)).toThrow(/malformed fact object/);
    const atCap = structuredClone(near);
    atCap.facts[0].object = "x".repeat(1048576);
    expect(() => validateSnapshot(atCap)).not.toThrow();
  });

  test("a control character in a NEAR fact object is rejected", () => {
    const near = buildNearSnapshot(LIVE, { root: NEAR_ROOT });
    const bad = structuredClone(near);
    bad.facts[0].object = "x\u0001y";
    expect(() => validateSnapshot(bad)).toThrow(/malformed fact object/);
  });

  test.skipIf(!DEV_ALLOWLIST)("no published file under src/near, fixtures/near or this test carries a forbidden marker (AC10)", () => {
    // The marker list is read from the publish policy file; its name is assembled so
    // that this test file does not itself contain one of the forbidden markers.
    const policy = readFileSync(join(REPO_ROOT, "scripts", "publish" + "." + "allowlist"), "utf8");
    const section = policy.split("[forbidden]")[1] ?? "";
    const markers = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("["));
    expect(markers.length).toBeGreaterThan(0);
    const roots = [join(REPO_ROOT, "src", "near"), join(REPO_ROOT, "fixtures", "near")];
    const files: string[] = [join(import.meta.dir, "near-reader.test.ts")];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    for (const root of roots) walk(root);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const marker of markers) expect({ file, marker, hit: text.includes(marker) }).toEqual({ file, marker, hit: false });
    }
  });
});

// ===========================================================================
// 2. AC4 — replay determinism and capture refusal
// ===========================================================================
describe("AC4 snapshot replay and capture", () => {
  test("two loads give an identical canonical store equal to manifest.storeSha256", () => {
    const before = fetchCalls;
    const first = buildNearSnapshot(LIVE, { root: NEAR_ROOT });
    const second = buildNearSnapshot(LIVE, { root: NEAR_ROOT });
    const manifest = readNearManifest(LIVE, { root: NEAR_ROOT });
    const digest = (s: typeof first) =>
      sha256(canonical({ facts: [...s.facts].sort((a, b) => a.id.localeCompare(b.id)), receipts: [...s.receipts].sort((a, b) => a.id.localeCompare(b.id)) }));
    expect(digest(first)).toBe(digest(second));
    expect(nearStoreSha256(first)).toBe(manifest.storeSha256);
    expect(fetchCalls).toBe(before);
  });

  test("the manifest carries the R3 fields", () => {
    const m = readNearManifest(LIVE, { root: NEAR_ROOT });
    for (const key of ["snapshotId", "capturedAt", "completedAt", "endpointHost", "fromBlock", "toBlock", "nearcoreVersion", "constructed", "storeSha256"]) {
      expect(m).toHaveProperty(key);
    }
    expect(m.snapshotId).toBe(LIVE);
    expect(m.constructed).toBe(false);
    expect(m.endpointHost).not.toContain("://");
    expect(m.nearcoreVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("fromBlock and toBlock are the min and max block heights of the retained records", () => {
    const m = readNearManifest(LIVE, { root: NEAR_ROOT });
    const heights = nearReads(LIVE, { root: NEAR_ROOT }).records
      .map((r) => r.blockHeight)
      .filter((h): h is string => h !== null)
      .map((h) => BigInt(h));
    expect(heights.length).toBeGreaterThan(0);
    const min = heights.reduce((a, b) => (a < b ? a : b));
    const max = heights.reduce((a, b) => (a > b ? a : b));
    expect(m.fromBlock).toBe(String(min));
    expect(m.toBlock).toBe(String(max));
    expect(BigInt(m.fromBlock) <= BigInt(m.toBlock)).toBe(true);
  });

  test("exactly one closing block read is retained", () => {
    const blocks = nearReads(LIVE, { root: NEAR_ROOT }).records.filter((r) => r.request.method === "block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].outcome).toBe("result");
  });

  test("capture refuses to overwrite an existing directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "nr-capture-"));
    const registry = [{ account: "intents.near", subject: nearSubject("intents.near"), label: "intents.near", chains: ["intents"] as ["intents"], recipes: [{ kind: "account" as const }, { kind: "keys" as const }], yields: [] }];
    try {
      const first = await captureSnapshot({
        snapshotId: "near-2026-11-10",
        root,
        registry,
        fetch: fixtureFetch(),
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        minIntervalMs: 0,
        endpointUrl: "https://example.invalid",
        archivalUrl: null,
      });
      expect(first.snapshotId).toBe("near-2026-11-10");
      expect(readdirSync(join(root, "near-2026-11-10")).length).toBeGreaterThan(0);
      await expect(
        captureSnapshot({
          snapshotId: "near-2026-11-10",
          root,
          registry,
          fetch: fixtureFetch(),
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          minIntervalMs: 0,
          endpointUrl: "https://example.invalid",
          archivalUrl: null,
        }),
      ).rejects.toThrow(/refuses to overwrite/);
      expect(readdirSync(join(root, "near-2026-11-10")).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tampered record byte fails the file-hash check", () => {
    const root = mkdtempSync(join(tmpdir(), "nr-tamper-file-"));
    try {
      cpSync(join(NEAR_ROOT, LIVE), join(root, LIVE), { recursive: true });
      const dir = join(root, LIVE);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: Record<string, string> };
      const file = Object.keys(manifest.files)[0];
      const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      record.blockHash = "tampered";
      writeFileSync(join(dir, file), JSON.stringify(record, null, 1) + "\n");
      expect(() => buildNearSnapshot(LIVE, { root })).toThrow(/file hash mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tampered resultText with a re-hashed file fails the response-hash check", () => {
    const root = mkdtempSync(join(tmpdir(), "nr-tamper-result-"));
    try {
      cpSync(join(NEAR_ROOT, LIVE), join(root, LIVE), { recursive: true });
      const dir = join(root, LIVE);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: Record<string, string> };
      const file = Object.keys(manifest.files).find((name) => {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { request?: { params?: { method_name?: string } } };
        return record.request?.params?.method_name === "acl_get_permissioned_accounts";
      })!;
      const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as { resultText: string };
      record.resultText = record.resultText.replace("PauseManager", "PauseManagerX");
      writeFileSync(join(dir, file), JSON.stringify(record, null, 1) + "\n");
      manifest.files[file] = sha256(readFileSync(join(dir, file)));
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
      expect(() => buildNearSnapshot(LIVE, { root })).toThrow(/response hash mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence rule: an unidentified object or basis is unverified.
// "verified" is for a statement that evidence supports; "we could not identify
// it" is not one. "none" is different: an authority that was read and is absent
// is a verified fact.
// ---------------------------------------------------------------------------
describe("an unidentified owner is unverified", () => {
  const constructedIds = readdirSync(join(NEAR_ROOT, "constructed"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `near-constructed-${e.name}`)
    .sort();
  const snapshots = () => [
    ...liveSnapshotIds(NEAR_ROOT).map((id) => buildNearSnapshot(id, { root: NEAR_ROOT })),
    ...constructedIds.map((id) => buildNearSnapshot(id, { root: NEAR_ROOT })),
    // The intent extension adds token-route facts through the same fact builder.
    ...liveSnapshotIds(NEAR_ROOT).map((id) => buildIntentSnapshot(id, { root: NEAR_ROOT })),
  ];

  test("no fact of any committed snapshot says unknown and verified", () => {
    const all = snapshots();
    expect(all.map((s) => s.id)).toContain(LIVE);
    expect(all.some((s) => s.constructed)).toBe(true);
    const offenders = all.flatMap((s) =>
      s.facts
        .filter((f) => (f.object === "unknown" || f.basis === "unknown") && f.status === "verified")
        .map((f) => `${s.id} ${f.id} ${f.subject} ${f.predicate}`),
    );
    expect(offenders).toEqual([]);
    // The rule is exercised, not vacuous: the live snapshot does carry unidentified owners.
    const unknownOwners = liveSnapshot().facts.filter((f) => f.predicate === "owned-by" && f.object === "unknown");
    expect(unknownOwners.length).toBeGreaterThan(0);
    for (const f of unknownOwners) {
      expect(f.basis).toBe("unknown");
      expect(f.status).toBe("unverified");
    }
  });

  test("a none fact, an authority read and absent, stays verified", () => {
    const none = liveSnapshot().facts.filter((f) => f.object === "none");
    expect(none.length).toBeGreaterThan(0);
    for (const f of none) expect(f.status).toBe("verified");
    const role = none.find((f) => f.predicate === "holds-role");
    expect(role).toBeDefined();
    expect(role!.basis).toBe("observed");
  });

  test("the control query still reports unknown-controller for an unidentified owner", () => {
    const store = loadLive();
    const subject = nearSubject("aggregate-oracle.near");
    const result = runQuery(store, { name: "control", subject, scope: { asOf: store.snapshot(LIVE)!.observedTo, snapshotId: LIVE, maxHops: 8, maxResults: 500 } });
    expect(result.reasons.some((r) => r.code === "unknown-controller" && r.subject === subject)).toBe(true);
    const owner = result.facts.find((f) => f.subject === subject && f.predicate === "owned-by");
    expect(owner?.object).toBe("unknown");
    expect(owner?.status).toBe("unverified");
  });
});
