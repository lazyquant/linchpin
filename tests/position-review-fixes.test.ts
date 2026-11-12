// Fixes for the diff review of run 023 (graph/reviews/023-private-position-review): R2, R3 and R4.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicy, evaluation, parsePolicy, reason } from "../src/policy/evaluate";
import { createGenericRegistry } from "../src/policy/rules/index";
import { PositionRejected, resolvedLocalPath } from "../src/review/position/book";
import { checkPrivateExportPath, toPublicReview, writePrivateExport } from "../src/review/position/export";

const VAULT = "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "linchpin-fixes-")));
  dirs.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".private"));
  return root;
}

describe("R2: a link with a missing target does not hide where a private export lands", () => {
  test("a dangling link in .private that points into the repository is refused and nothing is written", () => {
    const root = repo(), link = join(root, ".private", "export.json"), target = join(root, "leak.json");
    symlinkSync(target, link);
    expect(resolvedLocalPath(link)).toBe(target);
    expect(() => checkPrivateExportPath(link)).toThrow(PositionRejected);
    expect(() => writePrivateExport(link, { secret: "quantity" })).toThrow(PositionRejected);
    expect(existsSync(target)).toBe(false);
  });
  test("a relative dangling link and a chain of dangling links resolve to the final target", () => {
    const root = repo(), first = join(root, ".private", "a.json"), second = join(root, ".private", "b.json");
    symlinkSync("b.json", first);
    symlinkSync(join("..", "docs", "leak.json"), second);
    expect(resolvedLocalPath(first)).toBe(join(root, "docs", "leak.json"));
    expect(() => checkPrivateExportPath(first)).toThrow(PositionRejected);
  });
  test("a dangling link that stays inside .private is still allowed, and a link loop is refused", () => {
    const root = repo(), link = join(root, ".private", "export.json"), loop = join(root, ".private", "loop.json");
    symlinkSync("real.json", link);
    expect(checkPrivateExportPath(link)).toBe(join(root, ".private", "real.json"));
    symlinkSync("loop.json", loop);
    expect(() => resolvedLocalPath(loop)).toThrow(PositionRejected);
    expect(checkPrivateExportPath(join(root, ".private", "new", "report.json"))).toBe(join(root, ".private", "new", "report.json"));
  });
});

describe("R3: the public export carries no private fact or receipt", () => {
  const fact = (id: string, privacy: string, evidenceIds: string[]) => ({ id, subject: VAULT, predicate: "VAULT_ADMIN",
    object: "solana:mainnet-beta:7fLxEftpppneavpueYgP2s7HhSGbWpj2jTCmAEwwqonY", basis: "decoded", status: "verified", evidenceIds, path: [], validFrom: null, validTo: null, privacy });
  const receipt = (id: string, privacy: string) => ({ id, source: `${privacy}-note-${id}`, responseSha256: "0".repeat(64), privacy,
    observation: { chain: "solana", network: "mainnet-beta", blockOrSlot: "1", blockHash: null, observedAt: "2026-11-09T17:04:18.000Z", retrievedAt: "2026-11-09T17:04:18.000Z", historicalState: "current-only" } });
  test("private facts, private receipts and facts resting on a private receipt are dropped; public ones stay", () => {
    const report = { version: 1, privacy: "private", label: "x",
      snapshot: { id: "s1", constructed: false, observedFrom: "2026-11-09T17:04:18.000Z", observedTo: "2026-11-09T17:04:18.000Z", fromBlockOrSlot: "1", toBlockOrSlot: "1" },
      asOf: "2026-11-09T17:04:18.000Z",
      positions: [{ position: { id: "p1", subject: VAULT, quantity: "1250", unit: "u", snapshotId: "b1", source: "manual", fixtureKind: "synthetic" },
        inScope: true, coverage: "covered", coverageReason: null,
        chain: { snapshotId: "s1", constructed: false, subjects: [VAULT],
          dependencyFacts: [fact("f-dep-private", "private", ["r-public"])],
          controlFacts: [fact("f-private", "private", ["r-private"]), fact("f-public", "public", ["r-public"]), fact("f-on-private-receipt", "public", ["r-public", "r-private"])],
          stateFacts: [fact("f-state-private", "private", ["r-public"])],
          controllers: [], oracleSources: [], reasons: [], receipts: [receipt("r-private", "private"), receipt("r-public", "public")], entries: [] },
        economics: null, economicsReason: "no-economics-source" }],
      totals: { positions: 1, covered: 1, unknownCoverage: 0, byUnit: [] }, verdict: null, publicSubjects: [VAULT], runs: [],
      economicsReceipts: [receipt("r-econ-private", "private")] };
    const exported = toPublicReview(report as unknown as Parameters<typeof toPublicReview>[0]);
    const text = JSON.stringify(exported);
    for (const hidden of ["f-private", "f-dep-private", "f-state-private", "f-on-private-receipt", "r-private", "r-econ-private", "private-note"]) expect(text.includes(hidden)).toBe(false);
    expect(exported.subjects[0]!.controlFacts.map(f => f.id)).toEqual(["f-public"]);
    expect(exported.subjects[0]!.receipts.map(r => r.id)).toEqual(["r-public"]);
  });
});

describe("R4: a rule that names no outcome does not pass", () => {
  test("an evaluation without an outcome becomes undetermined with rule-error", () => {
    const unnamed = evaluation as unknown as (outcome: undefined, reasons: ReturnType<typeof reason>[]) => ReturnType<typeof evaluation>;
    const kind = { kind: "demo-kind", parse: () => ({}), evaluate: () => unnamed(undefined, [reason("missing-fact")]) };
    const registry = createGenericRegistry().extend([kind as never]);
    const policy = parsePolicy({ policyId: "p", subjects: [VAULT], rules: [{ id: "d", kind: "demo-kind", params: {} }] }, registry);
    const store = { snapshot: () => ({ id: "s1", subjects: [VAULT], constructed: false }), receipt: () => undefined, factsFrom: () => [] };
    const context = { evaluatedAt: "2026-11-09T17:04:18.000Z", snapshotId: "s1", registry, roleOf: () => undefined, positions: [], price: () => null };
    const verdict = evaluatePolicy(policy, store as never, context as never);
    expect(verdict.outcome).toBe("undetermined");
    expect(verdict.rules[0]!.reasons.map(r => r.code)).toEqual(["rule-error"]);
  });
});
