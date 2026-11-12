/**
 * Tests for development-graph run 027 (NEAR governance review).
 *
 * Expectations come from the approved governance-review spec (AC1–AC9, G1–G7),
 * the run plan's Interface, effect table, vote-math rules and constructed
 * snapshots, and Peter's binding decisions recorded in the run's decision log
 * on 2026-11-09 (Q1–Q7, PC1, PC2).
 *
 * Information boundary: only exported signatures were read under src/near/governance
 * and the engine/reader surfaces; no implementation body and no implementation
 * report. The library and the CLI were run as a black box against committed
 * snapshot fixtures.
 *
 * Every test is offline. A global fetch trap throws and counts; the suite
 * asserts the count is zero.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, parseQueryRequest, runQuery, buildMarinadeSnapshots, isTraversalRelation, validateSnapshot } from "../src/engine/queries/index";
import type { EvidenceSnapshot, EvidenceStore } from "../src/engine/queries/index";
import type { Fact } from "../src/engine/contracts";
import {
  daoControls,
  decodeProposal,
  EFFECT_PRECEDENCE,
  EFFECT_TABLE,
  effectClass,
  classify,
  executionMath,
  governanceChanges,
  governanceSnapshotId,
  governanceStore,
  intersectFor,
  KIND_LABELS,
  loadPolicy,
  openProposals,
  proposalExpiry,
  proposalsTouching,
  REACH_PREDICATES,
  renderGovernanceMarkdown,
  renderGovernanceJson,
  reviewProposal,
  sweepOpen,
  votesNeeded,
} from "../src/near/governance/index";
import { SENTENCE_TEMPLATES } from "../src/near/governance/render";
import {
  buildNearSnapshot,
  extendSnapshot,
  historyFacts,
  liveSnapshotIds,
  loadNearSnapshot,
  loadNearSnapshots,
  nearReads,
  nearStoreSha256,
  nearSubject,
  snapshotFromRecords,
} from "../src/near/reader/index";
import { CURRENT_NEAR_SNAPSHOT, NEAR_REGISTRY } from "../src/near/subjects/registry";
import type { SputnikPolicy, SputnikProposal } from "../src/near/reader/index";
import { runNearCommand } from "../src/near/cli/near";

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_ALLOWLIST = existsSync(join(import.meta.dir, "..", "scripts", "publish" + "." + "allowlist"));

// ---------------------------------------------------------------------------
// Offline guarantee: no test may reach the network.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
beforeAll(() => {
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    throw new Error("network disabled in governance-review tests");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(fetchCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// Paths and shared fixtures
// ---------------------------------------------------------------------------
const REPO_ROOT = join(import.meta.dir, "..");
const NEAR_ROOT = join(REPO_ROOT, "fixtures", "near");
const LIVE = CURRENT_NEAR_SNAPSHOT; // near-2026-11-09
const EXP = "near-constructed-governance-expired";
const POL = "near-constructed-governance-policy-changed";
const KINDS = "near-constructed-governance-kinds";

const BURROW = "burrow.sputnik-dao.near";
const INTENTS = "intents.sputnik-dao.near";
const RB = "rainbowbridge.sputnik-dao.near";

const liveStore: EvidenceStore = loadNearSnapshot(LIVE, { root: NEAR_ROOT });
const liveSnap: EvidenceSnapshot = liveStore.snapshot(LIVE)!;

function store(id: string): EvidenceStore {
  return loadNearSnapshot(id, { root: NEAR_ROOT });
}
function snapshotOf(id: string): EvidenceSnapshot {
  return store(id).snapshot(id)!;
}

/** The recorded `proposal` fact of one DAO proposal. */
function proposalFact(dao: string, id: number, snap: EvidenceSnapshot = liveSnap): Fact {
  const subject = `${nearSubject(dao)}#proposal:${id}`;
  const fact = snap.facts.find((f) => f.predicate === "proposal" && f.subject === subject);
  expect(fact).toBeDefined();
  return fact!;
}

/** All InProgress proposal ids of one DAO, derived from the snapshot facts. */
function inProgressIds(dao: string, snap: EvidenceSnapshot = liveSnap): number[] {
  return snap.facts
    .filter((f) => f.predicate === "proposal" && f.subject.startsWith(`${nearSubject(dao)}#proposal:`))
    .map((f) => JSON.parse(f.object))
    .filter((p) => p.status === "InProgress")
    .map((p) => p.id)
    .sort((a, b) => a - b);
}

const policyCache = new Map<string, ReturnType<typeof loadPolicy>>();
function policyOf(dao: string, id: string = LIVE) {
  const key = `${id}|${dao}`;
  if (!policyCache.has(key)) policyCache.set(key, loadPolicy({ snapshotId: id, root: NEAR_ROOT }, dao));
  return policyCache.get(key)!;
}

const decodedCache = new Map<string, ReturnType<typeof decodeProposal>>();
function decodeLive(dao: string, id: number) {
  const key = `${dao}#${id}`;
  if (!decodedCache.has(key)) {
    const pol = policyOf(dao);
    decodedCache.set(key, decodeProposal(proposalFact(dao, id), pol.policy, pol.receipt));
  }
  return decodedCache.get(key)!;
}

const KINDS_SNAP = snapshotOf(KINDS);
const decodedKinds = new Map<number, ReturnType<typeof decodeProposal>>();
function decodeKind(id: number) {
  if (!decodedKinds.has(id)) {
    const pol = policyOf(BURROW, KINDS);
    decodedKinds.set(id, decodeProposal(proposalFact(BURROW, id, KINDS_SNAP), pol.policy, pol.receipt));
  }
  return decodedKinds.get(id)!;
}

/** Rule-id registry: every AC2 assertion registers its rule; a closing test
 * asserts the set equals the effect table's ids, so every row has a test. */
const ruleHits = new Set<string>();
function classifyAndHit(p: ReturnType<typeof decodeProposal>, registry?: readonly typeof NEAR_REGISTRY[number][]) {
  const result = registry ? classify(p, registry as never) : classify(p);
  ruleHits.add(result.ruleId);
  return result;
}

// ===========================================================================
// AC1 — decoding of real proposals, Sputnik field names, no throw
// ===========================================================================
describe("AC1 decoding", () => {
  test("1745 decodes: FunctionCall to the burrow contract, execute, Withdraw of USDt, deposit 1", () => {
    const d = decodeLive(BURROW, 1745);
    expect(d.decoded.kind).toBe("FunctionCall");
    if (d.decoded.kind !== "FunctionCall") throw new Error("unreachable");
    expect(d.decoded.receiver_id).toBe("contract.main.burrow.near");
    expect(d.decoded.actions).toHaveLength(1);
    const a = d.decoded.actions[0];
    expect(a.method_name).toBe("execute");
    expect(a.argsFormat).toBe("json");
    expect(a.deposit).toBe("1");
    expect(a.gas).toBe("200000000000000");
    expect(a.args).toEqual({ actions: [{ Withdraw: { token_id: "usdt.tether-token.near" } }] });
    expect(d.status).toBe("Approved");
    expect(d.policyLabel).toBe("call");
    expect(d.proposalSubject).toBe(`${nearSubject(BURROW)}#proposal:1745`);
    expect(d.daoSubject).toBe(nearSubject(BURROW));
  });

  test("1746 decodes: the Withdraw amount and token id of the recorded data", () => {
    const d = decodeLive(BURROW, 1746);
    if (d.decoded.kind !== "FunctionCall") throw new Error("unreachable");
    expect(d.decoded.actions[0].args).toEqual({
      actions: [{ Withdraw: { token_id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "251000000000000000000000" } }],
    });
    expect(d.decoded.actions[0].gas).toBe("120000000000000");
    expect(d.proposer).toBe("brhost.near");
    expect(d.submissionTimeNs).toBe("1794130938955922010");
    expect(d.factId).toBe(proposalFact(BURROW, 1746).id);
  });

  test("105 and 106 decode member and role with Sputnik field names", () => {
    const add = decodeLive(INTENTS, 105);
    expect(add.decoded).toMatchObject({ kind: "AddMemberToRole", member_id: "400d1c029b9575ab98af5fae579046d8c5d0bc9341263b6b797839815532dbe7", role: "council" });
    expect(add.policyLabel).toBe("add_member_to_role");
    const rem = decodeLive(INTENTS, 106);
    expect(rem.decoded).toMatchObject({ kind: "RemoveMemberFromRole", member_id: "e33d30ea7c7b271a580bd609100d4f21a07c83f4eb643a1d151c2639471368d0", role: "council" });
    expect(rem.policyLabel).toBe("remove_member_from_role");
  });

  test("108 decodes the acl_grant_role arguments", () => {
    const d = decodeLive(INTENTS, 108);
    if (d.decoded.kind !== "FunctionCall") throw new Error("unreachable");
    expect(d.decoded.receiver_id).toBe("intents.near");
    expect(d.decoded.actions[0].method_name).toBe("acl_grant_role");
    expect(d.decoded.actions[0].args).toEqual({
      account_id: "b6be09281567fc42ee6a453c6156445deeb8f09723d769a751646216c5ea00fc",
      role: "UnrestrictedAccountLocker",
    });
  });

  test("109 decodes as recorded (decision Q2): outlayer-admin receiver, v1.signer named in args", () => {
    const d = decodeLive(INTENTS, 109);
    if (d.decoded.kind !== "FunctionCall") throw new Error("unreachable");
    expect(d.decoded.receiver_id).toBe("outlayer-admin.near");
    expect(d.decoded.actions[0].method_name).toBe("w_execute_extension");
    expect(d.decoded.actions[0].deposit).toBe("1");
    expect(d.argAccounts).toContain("v1.signer");
    expect(d.argAccounts).not.toContain("outlayer-admin.near");
    expect([...d.argAccounts].sort()).toEqual(d.argAccounts);
  });

  test("330 decodes: zcash-client receiver, up_deploy_code, recorded hash", () => {
    const d = decodeLive(RB, 330);
    if (d.decoded.kind !== "FunctionCall") throw new Error("unreachable");
    expect(d.decoded.receiver_id).toBe("zcash-client.bridge.near");
    expect(d.decoded.actions[0].method_name).toBe("up_deploy_code");
    expect((d.decoded.actions[0].args as { hash: string }).hash).toBe("HFfccErReFA48dsyv3LmvRjnYVjxVzRJUruVPZMk14Hk");
    expect(d.status).toBe("InProgress");
  });

  test("every governance-kinds id decodes to its recorded kind", () => {
    const expected: Record<number, string> = {
      900001: "Transfer", 900002: "ChangePolicy", 900003: "ChangePolicyAddOrUpdateRole", 900004: "ChangePolicyRemoveRole",
      900005: "ChangePolicyUpdateDefaultVotePolicy", 900006: "ChangePolicyUpdateParameters", 900007: "UpgradeSelf",
      900008: "UpgradeRemote", 900009: "SetStakingContract", 900010: "FactoryInfoUpdate", 900011: "AddBounty",
      900012: "BountyDone", 900013: "Vote", 900014: "unknown-kind", 900027: "ChangeConfig", 900028: "unknown-kind",
    };
    for (let id = 900015; id <= 900026; id++) expected[id] = "FunctionCall";
    for (const [id, kind] of Object.entries(expected)) expect(String(decodeKind(Number(id)).decoded.kind)).toBe(kind);
  });

  test("900001 is a yoctoNEAR Transfer to the constructed recipient", () => {
    const d = decodeKind(900001);
    if (d.decoded.kind !== "Transfer") throw new Error("unreachable");
    expect(d.decoded.token_id).toBe("");
    expect(d.decoded.unit).toBe("yoctoNEAR");
    expect(d.decoded.receiver_id).toBe("linchpin-constructed-recipient.near");
    expect(d.decoded.amount).toBe("1000000000000000000000000");
  });

  test("900016 and 900020 keep non-JSON base64 args with argsFormat base64", () => {
    for (const id of [900016, 900020]) {
      const d = decodeKind(id);
      if (d.decoded.kind !== "FunctionCall") throw new Error("unreachable");
      expect(d.decoded.actions[0].argsFormat).toBe("base64");
      expect(d.decoded.actions[0].args).toBe("AAEC");
    }
  });

  test("900006 emits the exact canonical proposal_period diff", () => {
    const d = decodeKind(900006);
    if (d.decoded.kind !== "ChangePolicyUpdateParameters") throw new Error("unreachable");
    expect(d.decoded.diff).toEqual([{ field: "proposal_period", current: '"604800000000000"', proposed: '"259200000000000"' }]);
    expect(d.policyComparedWith).toEqual({ receiptId: policyOf(BURROW, KINDS).receipt.id, block: policyOf(BURROW, KINDS).receipt.observation.blockOrSlot });
  });

  test("900006 with no policy gives current 'unknown' and never throws", () => {
    const d = decodeProposal(proposalFact(BURROW, 900006, KINDS_SNAP), null, null);
    if (d.decoded.kind !== "ChangePolicyUpdateParameters") throw new Error("unreachable");
    expect(d.decoded.diff[0].current).toBe("unknown");
  });

  test("900014 is unknown-kind/unknown with the raw value kept; 900028 is malformed", () => {
    const bad = decodeKind(900014);
    if (bad.decoded.kind !== "unknown-kind") throw new Error("unreachable");
    expect(bad.decoded.name).toBe("LinchpinConstructedKind");
    expect(bad.decoded.reason).toBe("unknown");
    expect(bad.decoded.raw).toEqual({ LinchpinConstructedKind: {} });
    expect(bad.policyLabel).toBeNull();
    const mal = decodeKind(900028);
    if (mal.decoded.kind !== "unknown-kind") throw new Error("unreachable");
    expect(mal.decoded.name).toBe("AddMemberToRole");
    expect(mal.decoded.reason).toBe("malformed");
  });

  test("an object that is not JSON gives unknown-kind/malformed; a wrong predicate throws TypeError", () => {
    const malformed = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "near-governance-review", "malformed-proposal.json"), "utf8")) as Fact;
    let decoded: ReturnType<typeof decodeProposal> | null = null;
    expect(() => (decoded = decodeProposal(malformed))).not.toThrow();
    if (decoded!.decoded.kind !== "unknown-kind") throw new Error("unreachable");
    expect(decoded!.decoded.reason).toBe("malformed");
    const notProposal = { ...malformed, predicate: "bond" } as Fact;
    expect(() => decodeProposal(notProposal)).toThrow(TypeError);
  });

  test("KIND_LABELS maps each Sputnik kind to its policy label", () => {
    expect(KIND_LABELS["FunctionCall"]).toBe("call");
    expect(KIND_LABELS["AddMemberToRole"]).toBe("add_member_to_role");
    expect(KIND_LABELS["RemoveMemberFromRole"]).toBe("remove_member_from_role");
    expect(KIND_LABELS["UpgradeSelf"]).toBe("upgrade_self");
    expect(KIND_LABELS["UpgradeRemote"]).toBe("upgrade_remote");
    expect(KIND_LABELS["Transfer"]).toBe("transfer");
    expect(KIND_LABELS["SetStakingContract"]).toBe("set_vote_token");
    expect(KIND_LABELS["AddBounty"]).toBe("add_bounty");
    expect(KIND_LABELS["BountyDone"]).toBe("bounty_done");
    expect(KIND_LABELS["Vote"]).toBe("vote");
    expect(KIND_LABELS["FactoryInfoUpdate"]).toBe("factory_info_update");
    expect(KIND_LABELS["ChangeConfig"]).toBe("config");
    expect(KIND_LABELS["ChangePolicy"]).toBe("policy");
    expect(KIND_LABELS["ChangePolicyAddOrUpdateRole"]).toBe("policy_add_or_update_role");
    expect(KIND_LABELS["ChangePolicyRemoveRole"]).toBe("policy_remove_role");
    expect(KIND_LABELS["ChangePolicyUpdateDefaultVotePolicy"]).toBe("policy_update_default_vote_policy");
    expect(KIND_LABELS["ChangePolicyUpdateParameters"]).toBe("policy_update_parameters");
    expect(Object.keys(KIND_LABELS)).toHaveLength(17);
  });
});

// ===========================================================================
// AC3 — threshold and vote math
// ===========================================================================
describe("AC3 threshold and vote math", () => {
  test("votesNeeded follows Sputnik's formula exactly (decision Q6)", () => {
    expect(votesNeeded([1, 2], "0", 5)).toBe(3);
    expect(votesNeeded([1, 2], "0", 2)).toBe(2);
    expect(votesNeeded("3", "0", 5)).toBe(3);
    expect(votesNeeded("7", "0", 5)).toBe(5); // capped at total
    expect(votesNeeded([1, 2], "4", 5)).toBe(4); // quorum floor
    expect(votesNeeded([2, 5], "0", 5)).toBe(3);
  });

  test("1746 math: council, default 1/2 policy, 3 needed of 5, 3 approved, two remaining, executesOn approve", () => {
    const m = executionMath(policyOf(BURROW).policy, decodeLive(BURROW, 1746).proposal);
    expect(m.role).toBe("council");
    expect(m.kindPermission).toBe("*:VoteApprove");
    expect(m.roles[0].policySource).toBe("default");
    expect(m.totalMembers).toBe(5);
    expect(m.needed).toBe(3);
    expect(m.approved).toBe(3);
    expect(m.rejected).toBe(0);
    expect(m.removed).toBe(0);
    expect(m.remainingMembers).toEqual(["farbread8025.near", "nicktrust.near"]);
    expect(m.executesOn).toBe("approve");
    expect(m.reason).toBeNull();
  });

  test("330 math: role threshold 2/5, 0 approved, five remaining, executesOn null", () => {
    const m = executionMath(policyOf(RB).policy, decodeLive(RB, 330).proposal);
    expect(m.role).toBe("council");
    expect(m.roles[0].policySource).toBe("role");
    expect(m.roles[0].threshold).toEqual({ ratio: [2, 5] });
    expect(m.needed).toBe(3);
    expect(m.approved).toBe(0);
    expect(m.remainingMembers).toHaveLength(5);
    expect(m.executesOn).toBeNull();
  });

  test("the computed needed matches the vault's 2026-10-22 readings (blocks named)", () => {
    // burrow: 5 council members, RoleWeight 1/2 -> 3 (policy read at block 223810412)
    expect(policyOf(BURROW).receipt.observation.blockOrSlot).toBe("223810412");
    expect(executionMath(policyOf(BURROW).policy, decodeLive(BURROW, 1746).proposal).needed).toBe(3);
    // ref-finance: same shape (policy read at block 223810466)
    const ref = policyOf("ref-finance.sputnik-dao.near");
    expect(ref.receipt.observation.blockOrSlot).toBe("223810466");
    // Note: bun's toMatchObject with an asymmetric matcher mutates nested arrays,
    // so the Group membership is asserted with Array.isArray instead.
    const refKind = ref.policy.roles[0].kind as Record<string, unknown>;
    expect(typeof refKind === "object" && refKind !== null && Array.isArray(refKind.Group)).toBe(true);
    expect(executionMath(ref.policy, { kind: { FunctionCall: {} }, vote_counts: { council: [0, 0, 0] }, votes: {} }).needed).toBe(3);
    // intents: absolute weight 3 of 5 council (policy read at block 223810540)
    const intents = policyOf(INTENTS);
    expect(intents.receipt.observation.blockOrSlot).toBe("223810540");
    expect(intents.policy.roles[0].vote_policy.call.threshold).toBe("3");
    expect(executionMath(intents.policy, { kind: { FunctionCall: {} }, vote_counts: { council: [0, 0, 0] }, votes: {} }).needed).toBe(3);
  });

  test("a TokenWeight policy gives needed null and the token-weight flag", () => {
    const policy = structuredClone(policyOf(BURROW).policy) as SputnikPolicy;
    policy.roles[0].vote_policy = { call: { weight_kind: "TokenWeight", quorum: "0", threshold: "1" } };
    const m = executionMath(policy, decodeLive(BURROW, 1746).proposal);
    expect(m.roles[0].flags).toContain("token-weight");
    expect(m.roles[0].needed).toBeNull();
    expect(m.flags).toContain("token-weight");
  });

  test("an Everyone-only voter is skipped with the everyone-role flag and missing-coverage", () => {
    const policy = structuredClone(policyOf(BURROW).policy) as SputnikPolicy;
    policy.roles = [{ name: "all", kind: "Everyone", permissions: ["*:VoteApprove"], vote_policy: {} }];
    const m = executionMath(policy, decodeLive(BURROW, 1746).proposal);
    expect(m.roles[0].flags).toContain("everyone-role");
    expect(m.role).toBeNull();
    expect(m.reason).toBe("missing-coverage");
  });

  test("a policy where no role may vote on call gives role null and missing-coverage", () => {
    const policy = structuredClone(policyOf(BURROW).policy) as SputnikPolicy;
    policy.roles[0].permissions = ["call:AddProposal"];
    const m = executionMath(policy, decodeLive(BURROW, 1746).proposal);
    expect(m.role).toBeNull();
    expect(m.needed).toBeNull();
    expect(m.reason).toBe("missing-coverage");
  });

  test("an unknown kind gives no label and missing-coverage", () => {
    const m = executionMath(policyOf(BURROW).policy, {
      kind: { LinchpinConstructedKind: {} },
      vote_counts: {},
      votes: {},
    } as unknown as SputnikProposal);
    expect(m.label).toBeNull();
    expect(m.role).toBeNull();
    expect(m.needed).toBeNull();
    expect(m.reason).toBe("missing-coverage");
  });

  test("reject counts at the threshold give executesOn reject", () => {
    const rejectFact = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "near-governance-review", "reject-votes-proposal.json"), "utf8")) as Fact;
    const proposal = JSON.parse(rejectFact.object) as SputnikProposal;
    const m = executionMath(policyOf(BURROW).policy, proposal);
    expect(m.approved).toBe(0);
    expect(m.rejected).toBe(3);
    expect(m.executesOn).toBe("reject");
  });

  test("non-safe-integer vote counts become null", () => {
    const policy = policyOf(BURROW).policy;
    const m = executionMath(policy, { kind: { FunctionCall: {} }, vote_counts: { council: [1.5, 0, 0] }, votes: {} } as unknown as SputnikProposal);
    expect(m.approved).toBeNull();
  });
});

// ===========================================================================
// AC2 — effect classes, one case per effect-table row
// ===========================================================================
describe("AC2 effect classes", () => {
  test("the real cases come out as recorded", () => {
    expect(effectClass(decodeLive(BURROW, 1745))).toBe("funds");
    expect(effectClass(decodeLive(BURROW, 1746))).toBe("funds");
    expect(effectClass(decodeLive(INTENTS, 105))).toBe("control");
    expect(effectClass(decodeLive(INTENTS, 106))).toBe("control");
    expect(effectClass(decodeLive(INTENTS, 108))).toBe("control");
    expect(effectClass(decodeLive(INTENTS, 109))).toBe("other"); // decision Q2
    expect(effectClass(decodeLive(RB, 330))).toBe("code");
    expect(effectClass(decodeLive(INTENTS, 104))).toBe("parameter");
    expect(effectClass(decodeLive(INTENTS, 104))).not.toBe("funds");
  });

  test("kind rows K01–K17 classify through the governance-kinds fixtures", () => {
    const cases: [number, string, string][] = [
      [900003, "control", "K04"], [900004, "control", "K05"], [900005, "control", "K06"], [900006, "control", "K07"],
      [900007, "code", "K08"], [900008, "code", "K09"], [900001, "funds", "K10"], [900013, "text", "K11"],
      [900027, "other", "K12"], [900009, "other", "K13"], [900010, "other", "K14"], [900011, "other", "K15"],
      [900012, "other", "K16"], [900014, "other", "K17"], [900028, "other", "K17"],
    ];
    for (const [id, cls, rule] of cases) {
      const r = classifyAndHit(decodeKind(id));
      expect(String(r.effectClass)).toBe(cls);
      expect(r.ruleId).toBe(rule);
    }
    // K01/K02/K03 come from the real recorded proposals 105, 106 and the constructed ChangePolicy
    expect(classifyAndHit(decodeLive(INTENTS, 105)).ruleId).toBe("K01");
    expect(classifyAndHit(decodeLive(INTENTS, 106)).ruleId).toBe("K02");
    expect(classifyAndHit(decodeKind(900002)).ruleId).toBe("K03");
  });

  test("action rows A01–A11 classify through the governance-kinds fixtures", () => {
    const cases: [number, string, string][] = [
      [900019, "control", "A02"], [900023, "control", "A03"], [900024, "control", "A04"], [900026, "control", "A05"],
      [900020, "code", "A06"], [900018, "funds", "A07"], [900021, "funds", "A08"], [900022, "funds", "A08"],
      [900015, "funds", "A09"], [900016, "parameter", "A10"], [900017, "other", "A11"], [900025, "control", "A01"],
    ];
    for (const [id, cls, rule] of cases) {
      const r = classifyAndHit(decodeKind(id));
      expect(String(r.effectClass)).toBe(cls);
      expect(r.ruleId).toBe(rule);
    }
    expect(classifyAndHit(decodeLive(INTENTS, 108)).ruleId).toBe("A01");
    expect(classifyAndHit(decodeLive(RB, 330)).ruleId).toBe("A06");
    expect(classifyAndHit(decodeLive(INTENTS, 104)).ruleId).toBe("A10");
  });

  test("900025: control (A01) beats parameter (A10) by precedence", () => {
    const r = classifyAndHit(decodeKind(900025));
    expect(r.effectClass).toBe("control");
    expect(r.ruleId).toBe("A01");
    const classes = r.actions.map((a) => a.effectClass);
    expect(classes).toContain("control");
    expect(classes).toContain("parameter");
    const best = Math.min(...classes.map((c) => EFFECT_PRECEDENCE.indexOf(c)));
    expect(best).toBe(EFFECT_PRECEDENCE.indexOf("control"));
  });

  test("a lender execute with mixed actions is funds (A09); with no Withdraw it is parameter", () => {
    const mixed = decodeKind(900015);
    expect(classifyAndHit(mixed)).toMatchObject({ effectClass: "funds", ruleId: "A09" });
    const collateralOnly = decodeProposal({
      ...proposalFact(BURROW, 900015, KINDS_SNAP),
      object: JSON.stringify({
        id: 900015, proposer: "linchpin-constructed-proposer.near", status: "InProgress", submission_time: "1794130938955922010",
        kind: { FunctionCall: { receiver_id: "contract.main.burrow.near", actions: [{ args: { actions: [{ IncreaseCollateral: { token_id: "wrap.near" } }] }, args_format: undefined, argsFormat: "json", deposit: "0", gas: "1", method_name: "execute" }] } },
        vote_counts: { council: [0, 0, 0] }, votes: {},
      }),
    }, policyOf(BURROW, KINDS).policy, policyOf(BURROW, KINDS).receipt);
    const r = classifyAndHit(collateralOnly);
    expect(r.effectClass).toBe("parameter");
  });

  test("a FunctionCall to a non-registry receiver with an unknown method is other (A11)", () => {
    expect(classifyAndHit(decodeKind(900017)).effectClass).toBe("other");
  });

  test("every EFFECT_TABLE row id is exercised by at least one assertion above", () => {
    expect(ruleHits.size).toBeGreaterThan(0);
    const tableIds = EFFECT_TABLE.map((r) => r.id).sort();
    expect([...ruleHits].sort()).toEqual(tableIds);
  });
});

// ===========================================================================
// Shared decoded set for reach tests (AC4)
// ===========================================================================
const gs = governanceStore({ snapshotId: LIVE, root: NEAR_ROOT }, [
  decodeLive(BURROW, 1746),
  decodeLive(INTENTS, 106),
  decodeLive(RB, 330),
  decodeLive(INTENTS, 109),
]);
const gsSnapshotId = governanceSnapshotId(LIVE);
const reachOf1746 = gs.reach.get(`${nearSubject(BURROW)}#proposal:1746`)!;
const reachOf106 = gs.reach.get(`${nearSubject(INTENTS)}#proposal:106`)!;
const reachOf330 = gs.reach.get(`${nearSubject(RB)}#proposal:330`)!;
const reachOf109 = gs.reach.get(`${nearSubject(INTENTS)}#proposal:109`)!;

// ===========================================================================
// AC4 — graph reach
// ===========================================================================
describe("AC4 graph reach", () => {
  test("1746 emits exactly the two funds facts with derived basis, path and two receipts", () => {
    expect(reachOf1746).toHaveLength(2);
    const objs = reachOf1746.map((f) => [f.predicate, f.object]);
    expect(objs).toEqual([
      ["moves-funds-from", nearSubject("contract.main.burrow.near")],
      ["moves-funds-to", nearSubject(BURROW)],
    ]);
    for (const f of reachOf1746) {
      expect(f.subject).toBe(`${nearSubject(BURROW)}#proposal:1746`);
      expect(f.basis).toBe("derived");
      expect(f.path).toEqual([decodeLive(BURROW, 1746).factId]);
      expect(f.evidenceIds).toHaveLength(2);
      expect(f.evidenceIds).toContain(proposalFact(BURROW, 1746).evidenceIds[0]);
      expect(f.evidenceIds).toContain(policyOf(BURROW).receipt.id);
      expect(f.id.startsWith(`nf:${gsSnapshotId}:`)).toBe(true);
    }
    expect(reachOf1746.map((f) => f.id)).toEqual([...reachOf1746.map((f) => f.id)].sort());
  });

  test("runQuery dependencies from the proposal subject reaches the burrow contract (Q1 relations)", () => {
    for (const p of REACH_PREDICATES) expect(isTraversalRelation(p)).toBe(true);
    const result = runQuery(gs.store, {
      name: "dependencies",
      subject: `${nearSubject(BURROW)}#proposal:1746`,
      relations: ["moves-funds-from", "touches-control-of", "touches-code-of", "changes-parameter-of"],
      scope: { asOf: gs.base.observedTo, snapshotId: gsSnapshotId, maxHops: 8, maxResults: 500 },
    });
    const objects = result.facts.map((f) => f.object);
    expect(objects).toContain(nearSubject("contract.main.burrow.near"));
  });

  test("parseQueryRequest accepts requests with the five new relations", () => {
    const request = parseQueryRequest({
      name: "dependencies",
      subject: `${nearSubject(BURROW)}#proposal:1746`,
      relations: [...REACH_PREDICATES],
      scope: { asOf: gs.base.observedTo, snapshotId: gsSnapshotId, maxHops: 8, maxResults: 500 },
    });
    if (request.name !== "dependencies") throw new Error("unreachable");
    expect(request.relations).toEqual([...REACH_PREDICATES]);
  });

  test("intersectFor with the burrow contract names hop 0 and hop 1 (PC1 chain ids)", () => {
    const inter = intersectFor(gs.store, gsSnapshotId, reachOf1746, nearSubject("contract.main.burrow.near"));
    expect(inter.forSubject).toBe(nearSubject("contract.main.burrow.near"));
    expect(inter.snapshotId).toBe(gsSnapshotId);
    expect(inter.truncated).toBe(false);
    expect(inter.hops).toEqual([
      { hop: 0, subject: nearSubject("contract.main.burrow.near"), predicate: "moves-funds-from", reachFactId: reachOf1746[0].id, chainFactIds: [] },
      { hop: 1, subject: nearSubject(BURROW), predicate: "moves-funds-to", reachFactId: reachOf1746[1].id, chainFactIds: [expect.any(String)] },
    ]);
    expect(inter.hops[1].chainFactIds[0]).toBe("nf:near-2026-11-09:c3c3c48a7c309c1346507c8dfe6ca352dbd255e7");
    expect(inter.reachable).toBeGreaterThan(0);
  });

  test("intersectFor with intents.near gives no hop, and the render says so in fixed words", () => {
    const inter = intersectFor(gs.store, gsSnapshotId, reachOf1746, nearSubject(INTENTS));
    expect(inter.hops).toEqual([]);
    const md = renderGovernanceMarkdown(reviewProposal({ snapshotId: LIVE, root: NEAR_ROOT }, BURROW, 1745, { forSubject: nearSubject(INTENTS) }));
    expect(md).toContain(`No hop of ${nearSubject(INTENTS)}'s dependency chain`);
  });

  test("106 touches the DAO itself, and daoControls shows what intents.near controls", () => {
    expect(reachOf106.map((f) => [f.predicate, f.object])).toEqual([["touches-control-of", nearSubject(INTENTS)]]);
    const controls = daoControls(liveSnap, nearSubject(INTENTS));
    const keys = controls.map((f) => `${f.subject} ${f.predicate}`);
    expect(keys).toContain(`${nearSubject("intents.near")} super-admin-of`);
    expect(keys).toContain(`${nearSubject("intents.near", "role", "DAO")} holds-role`);
    for (const f of controls) expect(f.object).toBe(nearSubject(INTENTS));
  });

  test("330 touches the code of the zcash client", () => {
    expect(reachOf330.map((f) => [f.predicate, f.object])).toEqual([["touches-code-of", nearSubject("zcash-client.bridge.near")]]);
  });

  test("109 (decision Q2) and 900017 emit no reach fact; 900025 emits two on a constructed snapshot with validFrom", () => {
    expect(reachOf109).toEqual([]);
    const kindsStore = governanceStore({ snapshotId: KINDS, root: NEAR_ROOT }, Array.from({ length: 28 }, (_, i) => decodeKind(900001 + i)));
    expect(kindsStore.reach.get(`${nearSubject(BURROW)}#proposal:900017`)).toEqual([]);
    const mixed = kindsStore.reach.get(`${nearSubject(BURROW)}#proposal:900025`)!;
    expect(mixed.map((f) => f.predicate).sort()).toEqual(["changes-parameter-of", "touches-control-of"]);
    expect(mixed.every((f) => f.object === nearSubject("omni.bridge.near"))).toBe(true);
    expect(mixed.every((f) => f.validFrom !== null)).toBe(true);
    const upgradeSelf = kindsStore.reach.get(`${nearSubject(BURROW)}#proposal:900007`)!;
    expect(upgradeSelf.map((f) => [f.predicate, f.object])).toEqual([["touches-code-of", nearSubject(BURROW)]]);
  });

  test("governanceSnapshotId and REACH_PREDICATES follow the plan", () => {
    expect(gsSnapshotId).toBe(`${LIVE}.governance`);
    expect(gs.snapshotId).toBe(gsSnapshotId);
    expect(REACH_PREDICATES).toEqual(["touches-control-of", "touches-code-of", "moves-funds-from", "moves-funds-to", "changes-parameter-of"]);
  });
});

// ===========================================================================
// AC5 — open proposals sweep
// ===========================================================================
describe("AC5 open proposals sweep", () => {
  test("the rainbowbridge sweep equals the snapshot's InProgress set, ascending", () => {
    const ids = inProgressIds(RB);
    expect(ids.length).toBeGreaterThan(30);
    const sweep = sweepOpen({ snapshotId: LIVE, root: NEAR_ROOT }, RB);
    expect(sweep.mode).toBe("open");
    expect(sweep.proposals.map((p) => p.decoded.id)).toEqual(ids);
    const byId = new Map(sweep.proposals.map((p) => [p.decoded.id, p]));
    expect(byId.get(330)!.expiry!.state).toBe("expired-unexecuted");
    expect(byId.get(334)!.expiry!.state).toBe("open");
    for (const p of sweep.proposals) expect(p.decoded.status).toBe("InProgress");
  });

  test("burrow has no open proposal on the live snapshot (decision Q3) and openProposals agrees", () => {
    expect(inProgressIds(BURROW)).toEqual([]);
    expect(sweepOpen({ snapshotId: LIVE, root: NEAR_ROOT }, BURROW).proposals).toEqual([]);
    expect(openProposals({ snapshotId: LIVE, root: NEAR_ROOT }, BURROW)).toEqual([]);
  });

  test("an approved proposal never appears in a sweep", () => {
    for (const id of [1745, 1746]) {
      const sweep = sweepOpen({ snapshotId: LIVE, root: NEAR_ROOT }, BURROW);
      expect(sweep.proposals.map((p) => p.decoded.id)).not.toContain(id);
    }
  });

  test("the constructed expired sweep lists exactly 1746, labelled expired-unexecuted and constructed", () => {
    const sweep = sweepOpen({ snapshotId: EXP, root: NEAR_ROOT }, BURROW);
    expect(sweep.proposals.map((p) => p.decoded.id)).toEqual([1746]);
    expect(sweep.constructed).toBe(true);
    const p = sweep.proposals[0];
    expect(p.decoded.status).toBe("InProgress");
    expect(p.expiry!.state).toBe("expired-unexecuted");
    expect(p.expiry!.constructed).toBe(true);
    expect(openProposals({ snapshotId: EXP, root: NEAR_ROOT }, BURROW).map((s) => s.id)).toEqual([1746]);
    const md = renderGovernanceMarkdown(sweep);
    expect(md).toContain("expired-unexecuted · constructed");
    expect(md).toContain("constructed: yes");
   });

  test("the governance-kinds sweep lists the 28 constructed ids ascending", () => {
    const ids = sweepOpen({ snapshotId: KINDS, root: NEAR_ROOT }, BURROW).proposals.map((p) => p.decoded.id);
    expect(ids).toEqual(Array.from({ length: 28 }, (_, i) => 900001 + i));
  });
});

// ===========================================================================
// AC6 — no advice; fixed sentence templates only
// ===========================================================================
const ADVICE = /\b(should|recommend\w*|vote for|vote against|safe|risky|score\w*)\b/i;
const SENTENCE = [
  /^This proposal changes who controls .+\. \(facts: .+\)$/,
  /^This proposal moves funds from .+ to .+\. \(facts: .+\)$/,
  /^This proposal changes the code of .+\. \(facts: .+\)$/,
  /^This proposal sets a parameter of .+\. \(facts: .+\)$/,
];

describe("AC6 no advice", () => {
  test("no shipped render contains an advice word", async () => {    const ctx = { snapshotId: LIVE, root: NEAR_ROOT };
    const texts: string[] = [];
    for (const [dao, id] of [[BURROW, 1745], [BURROW, 1746], [INTENTS, 105], [INTENTS, 106], [INTENTS, 108], [INTENTS, 109], [RB, 330]] as const) {
      texts.push(renderGovernanceMarkdown(reviewProposal(ctx, dao, id)));
    }
    for (const dao of [BURROW, INTENTS, RB, "ref-finance.sputnik-dao.near", "hos-root.sputnik-dao.near", "int-mnt-dao.sputnik-dao.near"]) {
      texts.push(renderGovernanceMarkdown(sweepOpen(ctx, dao)));
    }
    texts.push(renderGovernanceMarkdown(sweepOpen({ snapshotId: EXP, root: NEAR_ROOT }, BURROW)));
    texts.push(readFileSync(join(NEAR_ROOT, "samples", "governance-review.md"), "utf8"));
    for (const text of texts) expect({ hit: ADVICE.test(text), sample: text.match(ADVICE)?.[0] }).toEqual({ hit: false, sample: undefined });
  }, 60000);

  test("every This-proposal line is one of the four fixed templates and names report fact ids", () => {
    const ctx = { snapshotId: LIVE, root: NEAR_ROOT };
    for (const [dao, id] of [[BURROW, 1745], [BURROW, 1746], [RB, 330]] as const) {
      const report = reviewProposal(ctx, dao, id);
      const md = renderGovernanceMarkdown(report);
      const json = renderGovernanceJson(report);
      const lines = md.split("\n").filter((l) => l.startsWith("This proposal "));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(SENTENCE.some((re) => re.test(line))).toBe(true);
        for (const factId of line.match(/nf:[A-Za-z0-9._:-]+/g) ?? []) expect(json).toContain(factId);
      }
 expect(Object.keys(SENTENCE_TEMPLATES).sort()).toEqual(["code", "control", "funds", "parameter"]);
    }
  });

  test("text and other proposals have no interpretive sentence", () => {
    for (const id of [900013]) {
      const md = renderGovernanceMarkdown(reviewProposal({ snapshotId: KINDS, root: NEAR_ROOT }, BURROW, id));
      expect(md.split("\n").filter((l) => l.startsWith("This proposal "))).toEqual([]);
    }
    const md109 = renderGovernanceMarkdown(reviewProposal({ snapshotId: LIVE, root: NEAR_ROOT }, INTENTS, 109));
    expect(md109.split("\n").filter((l) => l.startsWith("This proposal "))).toEqual([]);
  });
});

// ===========================================================================
// AC7 — changes to governance itself
// ===========================================================================
describe("AC7 governance changes", () => {
  test("every DAO gets history restricted to membership and policy events", () => {
    for (const dao of [BURROW, INTENTS, "ref-finance.sputnik-dao.near", "hos-root.sputnik-dao.near", "int-mnt-dao.sputnik-dao.near"]) {
      const g = governanceChanges({ snapshotId: LIVE, root: NEAR_ROOT }, dao);
      expect(g.beforeSnapshotId).toBeNull();
      expect(g.afterSnapshotId).toBeNull();
      expect(g.changes).toEqual([]);
      expect(g.history.length).toBeGreaterThan(0);
      for (const event of g.history) expect(["membership", "policy"]).toContain(event.kind);
      expect(g.reasons.map((r) => r.ref)).toContain(`one-live-snapshot:${LIVE}`);
    }
    // rainbowbridge records no membership or policy event on this snapshot; the kinds stay restricted
    const rb = governanceChanges({ snapshotId: LIVE, root: NEAR_ROOT }, RB);
    expect(rb.history).toEqual([]);
    expect(rb.changes).toEqual([]);
  });

  test("intents history contains membership events sourced from proposals 105 and 106", () => {
    const g = governanceChanges({ snapshotId: LIVE, root: NEAR_ROOT }, INTENTS);
    const sources = g.history.map((h) => h.source.subject);
    expect(sources).toContain(`${nearSubject(INTENTS)}#proposal:105`);
    expect(sources).toContain(`${nearSubject(INTENTS)}#proposal:106`);
  });

  test("on the constructed pair the summary shows 5→4 council, a new threshold and a shorter period", () => {
    const g = governanceChanges({ snapshotId: LIVE, root: NEAR_ROOT }, BURROW, POL);
    expect(g.beforeSnapshotId).toBe(LIVE);
    expect(g.afterSnapshotId).toBe(POL);
    const byField = new Map(g.summary.map((s) => [s.field, s]));
    expect(byField.get("council-size")).toEqual({ field: "council-size", before: "5", after: "4" });
    expect(byField.get("proposal-period")!.before).toBe("604800000000000");
    expect(byField.get("proposal-period")!.after).toBe("259200000000000");
    expect(byField.get("vote-threshold")!.before).not.toBe(byField.get("vote-threshold")!.after);
    expect(byField.get("vote-threshold")!.after).toContain("2/3");
    const removed = g.changes.filter((c) => c.kind === "removed" && c.before);
    expect(removed.some((c) => c.before!.predicate === "council-member" && c.before!.object === nearSubject("farbread8025.near"))).toBe(true);
    expect(removed.some((c) => c.before!.predicate === "holds-role" && c.before!.object === nearSubject("farbread8025.near"))).toBe(true);
    for (const event of g.history) expect(["membership", "policy"]).toContain(event.kind);
    expect(g.history.map((h) => h.kind)).not.toContain("acl");
  });

  test("with a second live snapshot in a temp root the pair is picked up automatically", () => {
    const root = mkdtempSync(join(tmpdir(), "gov-pair-"));
    try {
      cpSync(join(NEAR_ROOT, LIVE), join(root, LIVE), { recursive: true });
      const SECOND = "near-2026-11-10";
      const dir = join(root, SECOND);
      mkdirSync(dir);
      const manifest = JSON.parse(readFileSync(join(NEAR_ROOT, LIVE, "manifest.json"), "utf8")) as Record<string, unknown>;
      manifest.snapshotId = SECOND;
      // Copy only the snapshot's own read files; subdirectories such as the
      // intents extension (fixtures/near/<id>/intents/) are not part of it.
      for (const entry of readdirSync(join(NEAR_ROOT, LIVE), { withFileTypes: true })) {
        if (!entry.isFile() || entry.name === "manifest.json") continue;
        writeFileSync(join(dir, entry.name), readFileSync(join(NEAR_ROOT, LIVE, entry.name)));
      }
      const rebuilt = snapshotFromRecords(manifest as never, nearReads(LIVE).records);
      manifest.storeSha256 = nearStoreSha256(rebuilt);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
      expect(liveSnapshotIds(root)).toContain(SECOND);
      const g = governanceChanges({ snapshotId: LIVE, root }, BURROW);
      expect(g.beforeSnapshotId).toBe(LIVE);
      expect(g.afterSnapshotId).toBe(SECOND);
      expect(g.reasons.map((r) => r.ref).some((ref) => typeof ref === "string" && ref.startsWith("one-live-snapshot"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

/** Minimal structural view of the CLI's JSON report. */
interface GovernanceReportShape {
  version: string;
  mode: string;
  dao: string;
  snapshotId: string;
  governanceSnapshotId: string;
  constructed: boolean;
  proposals: { decoded: { id: number }; effect: { effectClass: string }; reach: { id: string }[]; daoControls: { id: string }[] }[];
  receipts: unknown[];
  reasons: { code: string; subject: string | null; ref: string | null }[];
}

// ===========================================================================
// AC8 — CLI, report shape, determinism, exit codes
// ===========================================================================
describe("AC8 CLI and report", () => {
  const CLI = (...args: string[]) => runNearCommand(["governance", ...args]);

  test("1746 with --for writes both files, exit 0, deterministic bytes, parseable JSON with footnoted receipts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-cli-"));
    try {
      const args = [BURROW, "1746", "--for", nearSubject("contract.main.burrow.near"), "--offline", "--out", dir];
      expect(await CLI(...args)).toBe(0);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(["governance-review.json", "governance-review.md"]);
      const first = files.map((f) => readFileSync(join(dir, f), "utf8"));
      expect(await CLI(...args)).toBe(0);
      for (const [i, f] of files.entries()) expect(readFileSync(join(dir, f), "utf8")).toBe(first[i]);
      const report = JSON.parse(first[0]) as GovernanceReportShape;
      expect(report.version).toBe("near-governance/1");
      expect(report.mode).toBe("proposal");
      expect(report.dao).toBe(BURROW);
      expect(report.snapshotId).toBe(LIVE);
      expect(report.governanceSnapshotId).toBe(gsSnapshotId);
      expect(report.constructed).toBe(false);
      expect(report.proposals).toHaveLength(1);
      expect(report.proposals[0].decoded.id).toBe(1746);
      expect(report.proposals[0].effect.effectClass).toBe("funds");
      expect(report.receipts.length).toBeGreaterThan(0);
      const md = first[1];
      const footnotes = new Set([...md.matchAll(/\[\^r(\d+)\]/g)].map((m) => m[1]));
      expect(footnotes.size).toBeGreaterThan(0);
      for (const n of footnotes) {
        const line = md.split("\n").find((l) => l.startsWith(`[^r${n}]:`));
        expect(line).toBeDefined();
        expect(line!).toMatch(/block \d+/);
      }
      for (const fact of [...report.proposals[0].reach, ...report.proposals[0].daoControls]) {
        const line = md.split("\n").find((l) => l.startsWith(`- ${fact.id} ·`));
        expect(line).toBeDefined();
        expect(line!).toMatch(/\[\^r\d+\](\[\^r\d+\])*$/);
      }
      for (const receipt of report.receipts) expect(md).toContain(`[^r${report.receipts.indexOf(receipt) + 1}]:`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("usage errors exit 1 and write nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-cli-err-"));
    try {
      const cases: string[][] = [
        [BURROW, "1746", "--open"],
        [BURROW, "-1"],
        [BURROW, "1.5"],
        ["Bad Account", "1746"],
        [BURROW, "1746", "--for"],
        [BURROW, "1746", "--snapshot", "near-nope"],
        [],
      ];
      for (const args of cases) {
        const out = join(dir, `case-${cases.indexOf(args)}`);
        expect(await CLI(...args, "--out", out)).toBe(1);
        expect(existsSync(out)).toBe(false);
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a DAO outside the registry exits 0 with missing-subject; a below-window id gives missing-coverage", async () => {
    for (const [args, reason, refPart] of [
      [["linchpin-constructed-none.sputnik-dao.near", "--open"], "missing-subject", "linchpin-constructed-none.sputnik-dao.near"],
      [[BURROW, "1"], "missing-coverage", `${BURROW}#proposals:`],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "gov-cli-miss-"));
      try {
        expect(await CLI(...args, "--offline", "--out", dir)).toBe(0);
        const md = readFileSync(join(dir, "governance-review.md"), "utf8");
        const json = JSON.parse(readFileSync(join(dir, "governance-review.json"), "utf8")) as GovernanceReportShape;
        expect(json.reasons.map((r) => r.code)).toContain(reason);
        expect(md).toContain(reason);
        if (reason === "missing-subject") {
          expect(json.reasons.map((r) => r.subject ?? "").some((s) => s.includes(refPart))).toBe(true);
        } else {
          expect(json.reasons.map((r) => r.ref ?? "").some((ref) => ref.includes(refPart))).toBe(true);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30000);

  test("proposalsTouching keeps only proposals with hops against the burrow chain", () => {
    const touching = proposalsTouching({ snapshotId: LIVE, root: NEAR_ROOT }, nearSubject("contract.main.burrow.near"));
    for (const t of touching) expect(t.hops.length).toBeGreaterThan(0);
    expect(touching.every((t) => [BURROW, INTENTS, RB, "ref-finance.sputnik-dao.near", "hos-root.sputnik-dao.near", "int-mnt-dao.sputnik-dao.near"].includes(t.dao))).toBe(true);
    expect(touching.every((t) => inProgressIds(t.dao).includes(t.id))).toBe(true);
  }, 30000);
});

// ===========================================================================
// AC9 — conventions: markers, sample, Solana regression
// ===========================================================================
describe("AC9 conventions and regression", () => {
  test.skipIf(!DEV_ALLOWLIST)("no published file of this run carries a forbidden marker", () => {
    const policy = readFileSync(join(REPO_ROOT, "scripts", "publish" + "." + "allowlist"), "utf8");
    const section = policy.split("[forbidden]")[1] ?? "";
    const markers = section.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("["));
    expect(markers.length).toBeGreaterThan(0);
    const files: string[] = [join(REPO_ROOT, "src", "near", "cli", "governance.ts"), join(import.meta.dir, "near-governance-review.test.ts")];
    const roots = [
      join(REPO_ROOT, "src", "near", "governance"),
      join(NEAR_ROOT, "constructed"),
      join(NEAR_ROOT, "samples"),
      join(import.meta.dir, "fixtures", "near-governance-review"),
    ];
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

  test("the committed sample equals a fresh render of its command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-sample-"));
    try {
      expect(await runNearCommand(["governance", BURROW, "1746", "--for", nearSubject("contract.main.burrow.near"), "--offline", "--out", dir])).toBe(0);
      expect(readFileSync(join(dir, "governance-review.md"), "utf8")).toBe(readFileSync(join(NEAR_ROOT, "samples", "governance-review.md"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a Solana snapshot is still accepted and the existing traversal relations are unchanged", () => {
    const snapshots = buildMarinadeSnapshots(join(REPO_ROOT, "fixtures"));
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) expect(() => validateSnapshot(snapshot)).not.toThrow();
    const solanaStore = openStore(snapshots);
    const eight = ["owned-by", "upgraded-by", "super-admin-of", "holds-role", "priced-by", "legacy-oracle", "routes-through", "deployed-by"];
    const scope = { asOf: snapshots[0].observedTo, snapshotId: snapshots[0].id, maxHops: 8, maxResults: 500 };
    // The engine still resolves every pre-existing relation on a Solana store.
    const result = runQuery(solanaStore, { name: "dependencies", subject: snapshots[0].facts[0].subject, relations: eight, scope });
    expect(result.reasons.map((r) => r.code)).not.toContain("unknown-relation");
    // And it still rejects a relation that is not in the vocabulary.
    expect(() =>
      runQuery(solanaStore, { name: "dependencies", subject: snapshots[0].facts[0].subject, relations: ["not-a-relation" as never], scope }),
    ).toThrow(/unknown-relation/);
    for (const relation of eight) expect(isTraversalRelation(relation)).toBe(true);
    for (const relation of REACH_PREDICATES) expect(isTraversalRelation(relation)).toBe(true);
  });
});

// ===========================================================================
// G7 — expiry states: open, expired-unexecuted, closed
// ===========================================================================
describe("G7 expiry", () => {
  function expiryOf(dao: string, id: number, snapshotId: string = LIVE) {
    const snap = snapshotId === LIVE ? liveSnap : snapshotOf(snapshotId);
    const fact = proposalFact(dao, id, snap);
    const pol = policyOf(dao, snapshotId);
    return proposalExpiry(JSON.parse(fact.object) as SputnikProposal, pol.policy, snap.receipts.find((r) => r.id === fact.evidenceIds[0])!, pol.receipt);
  }

  test("1746 is closed: it expired after execution, at 2026-11-15T09:42:18.955Z", () => {
    const e = expiryOf(BURROW, 1746);
    expect(e.state).toBe("closed");
    expect(e.expiresAt).toBe("2026-11-15T09:42:18.955Z");
    expect(e.proposalPeriodNs).toBe("604800000000000");
    expect(e.submittedAt).toBe("2026-11-08T09:42:18.955Z");
    expect(e.readAt).toBe("2026-11-09T19:30:40.331Z");
    expect(e.readBlock).toBe("223810422");
    expect(e.proposalReceiptId).toBe(proposalFact(BURROW, 1746).evidenceIds[0]);
    expect(e.constructed).toBe(false);
  });

  test("330 is expired-unexecuted: InProgress past its period at the read (decision Q3)", () => {
    const e = expiryOf(RB, 330);
    expect(e.state).toBe("expired-unexecuted");
    expect(e.expiresAt).toBe("2026-11-03T22:06:33.859Z");
    expect(e.readAt).toBe("2026-11-09T19:33:00.572Z");
    expect(e.readBlock).toBe("223810664");
  });

  test("334 is still open", () => {
    expect(expiryOf(RB, 334).state).toBe("open");
  });

  test("the constructed expired proposal is expired-unexecuted and labelled constructed", () => {
    const e = expiryOf(BURROW, 1746, EXP);
    expect(e.state).toBe("expired-unexecuted");
    expect(e.expiresAt).toBe("2026-10-16T09:42:18.955Z");
    expect(e.constructed).toBe(true);
  });

  test("Sputnik's strict boundary: a proposal expiring exactly at the read is still open", () => {
    const pol = policyOf(BURROW).policy;
    const fact = proposalFact(BURROW, 1746);
    const proposal = JSON.parse(fact.object) as SputnikProposal;
    proposal.status = "InProgress";
    const receipt = liveSnap.receipts.find((r) => r.id === fact.evidenceIds[0])!;
    const readMs = Date.parse(receipt.observation.observedAt);
    proposal.submission_time = (BigInt(readMs) * 1000000n - BigInt(pol.proposal_period)).toString();
    expect(proposalExpiry(proposal, pol, receipt, policyOf(BURROW).receipt).state).toBe("open");
    proposal.submission_time = (BigInt(readMs) * 1000000n - BigInt(pol.proposal_period) - 1n).toString();
    expect(proposalExpiry(proposal, pol, receipt, policyOf(BURROW).receipt).state).toBe("expired-unexecuted");
  });
});
