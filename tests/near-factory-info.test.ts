/**
 * Sputnik DAO factory update path (small change outside a run, 2026-11-14).
 *
 * Sputnik v2 contracts expose update(): while get_factory_info says auto_update: true the
 * factory can replace the DAO's code with no proposal or vote. The reader reads
 * get_factory_info beside get_policy from near-2026-11-14 on; near-2026-11-09 never read it
 * and must replay byte-identically.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceReceipt } from "../src/engine/contracts";
import { buildNearSnapshot, factoryInfoCoverageGap, loadNearSnapshots, mapFactoryInfo, mapFactoryInfoUnknown, nearCallReceiptId, nearChanges, nearReads, readNearManifest, snapshotFromRecords, type MapperContext } from "../src/near/reader/index";
import { buildPanel } from "../src/near/panel/build";
import { callTool } from "../src/near/mcp/tools";
import type { FactChange, QueryResult } from "../src/engine/contracts";
import { loadIntentContext, renderIntentMarkdown, reviewIntent } from "../src/near/intents";
import { registryEntry } from "../src/near/subjects/registry";

const ROOT = join(import.meta.dir, "..");
const NEAR_ROOT = join(ROOT, "fixtures", "near");
const OLD = "near-2026-11-09", NEW = "near-2026-11-14";
const USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const DAO = "intents.sputnik-dao.near", FACTORY = "sputnik-dao.near";
const n = (a: string) => `near:mainnet:${a}`;

const receipt: EvidenceReceipt = { id: "nr:test:factory", source: "near-rpc:test", responseSha256: "0".repeat(64), privacy: "public",
  observation: { chain: "near", network: "mainnet", blockOrSlot: "1", blockHash: "h", observedAt: "2026-11-14T00:00:00.000Z", retrievedAt: "2026-11-14T00:00:00.000Z", historicalState: "current-only" } };
const ctx: MapperContext = { snapshotId: "near-test", account: DAO, entry: registryEntry(DAO)!, constructed: false };
const upgradedBy = (id: string, account: string) => buildNearSnapshot(id, { root: NEAR_ROOT }).facts.filter(f => f.subject === n(account) && f.predicate === "upgraded-by");

describe("get_factory_info mapper", () => {
  test("auto_update true: the factory is an upgraded-by holder, observed and verified, with the receipt", () => {
    const facts = mapFactoryInfo({ factory_id: FACTORY, auto_update: true }, receipt, ctx);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ subject: n(DAO), predicate: "upgraded-by", object: n(FACTORY), basis: "observed", status: "verified", evidenceIds: [receipt.id] });
  });
  test("auto_update false: no edge from the factory", () => {
    expect(mapFactoryInfo({ factory_id: FACTORY, auto_update: false }, receipt, ctx)).toEqual([]);
  });
  test("a malformed answer is refused, not read as false", () => {
    expect(() => mapFactoryInfo({ factory_id: FACTORY }, receipt, ctx)).toThrow();
    expect(() => mapFactoryInfo({ factory_id: "Not An Account", auto_update: true }, receipt, ctx)).toThrow();
  });
  test("MethodNotFound: an explicit unknown, unverified, never a claim of safety", () => {
    const facts = mapFactoryInfoUnknown(receipt, ctx);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ subject: n(DAO), predicate: "upgraded-by", object: "unknown", basis: "unknown", status: "unverified" });
  });
});

describe("snapshots with and without get_factory_info", () => {
  test("near-2026-11-09 has no get_factory_info read and no upgraded-by fact on any DAO", () => {
    const old = buildNearSnapshot(OLD, { root: NEAR_ROOT });
    expect(nearReads(OLD, { root: NEAR_ROOT }).records.some(r => r.request.method === "query" && "method_name" in r.request.params && r.request.params.method_name === "get_factory_info")).toBe(false);
    expect(old.facts.filter(f => f.subject.endsWith(".sputnik-dao.near") && f.predicate === "upgraded-by")).toEqual([]);
  });
  test("near-2026-11-14: intents DAO upgradable by the factory, burrow not, rainbowbridge unknown", () => {
    const intents = upgradedBy(NEW, DAO);
    expect(intents.map(f => [f.object, f.status])).toEqual([[n(FACTORY), "verified"]]);
    expect(intents[0].evidenceIds).toEqual([nearCallReceiptId(NEW, DAO, "get_factory_info")]);
    expect(nearReads(NEW, { root: NEAR_ROOT }).find("burrow.sputnik-dao.near", "call_function", "get_factory_info")?.value).toEqual({ factory_id: FACTORY, auto_update: false });
    expect(upgradedBy(NEW, "burrow.sputnik-dao.near")).toEqual([]);
    expect(upgradedBy(NEW, "rainbowbridge.sputnik-dao.near").map(f => [f.object, f.basis, f.status])).toEqual([["unknown", "unknown", "unverified"]]);
    const readers = buildNearSnapshot(NEW, { root: NEAR_ROOT }).readers;
    expect(readers.find(r => r.id === `near-reader:rainbowbridge.sputnik-dao.near`)?.status).toBe("complete");
  });
  test("an absent get_factory_info read adds no fact and no partial status", () => {
    const manifest = readNearManifest(NEW, { root: NEAR_ROOT });
    const records = nearReads(NEW, { root: NEAR_ROOT }).records.filter(r => !(r.request.method === "query" && "method_name" in r.request.params && r.request.params.method_name === "get_factory_info"));
    const s = snapshotFromRecords(manifest, records);
    expect(s.facts.filter(f => f.subject.endsWith(".sputnik-dao.near") && f.predicate === "upgraded-by")).toEqual([]);
    expect(s.readers.find(r => r.id === `near-reader:${DAO}`)?.status).toBe("complete");
  });
  test("any other get_factory_info error makes the reader partial and asserts nothing", () => {
    const manifest = readNearManifest(NEW, { root: NEAR_ROOT });
    const records = nearReads(NEW, { root: NEAR_ROOT }).records.map(r => {
      if (r.request.method !== "query" || !("method_name" in r.request.params) || r.request.params.method_name !== "get_factory_info" || r.request.params.account_id !== "rainbowbridge.sputnik-dao.near") return r;
      return { ...r, response: JSON.parse(JSON.stringify(r.response).replaceAll("MethodNotFound", "GasExceeded")) };
    });
    const s = snapshotFromRecords(manifest, records);
    expect(s.facts.filter(f => f.subject === n("rainbowbridge.sputnik-dao.near") && f.predicate === "upgraded-by")).toEqual([]);
    expect(s.readers.find(r => r.id === "near-reader:rainbowbridge.sputnik-dao.near")?.status).toBe("partial");
  });
});

describe("intent review", () => {
  const review = (snapshotId: string) => reviewIntent({ kind: "asset", assetId: USDC }, loadIntentContext({ snapshotId, root: NEAR_ROOT }));
  test("near-2026-11-09 replays byte-identically to its committed sample, with no change pair", () => {
    expect(loadIntentContext({ snapshotId: OLD, root: NEAR_ROOT }).change).toBeNull();
    expect(renderIntentMarkdown(review(OLD))).toBe(readFileSync(join(NEAR_ROOT, "samples", "intent-review-usdc.md"), "utf8"));
  });
  test("near-2026-11-14 replays to its sample and names the factory as an upgrade holder of the intents DAO", () => {
    const r = review(NEW), md = renderIntentMarkdown(r);
    expect(md).toBe(readFileSync(join(NEAR_ROOT, "samples", "intent-review-usdc-2026-11-14.md"), "utf8"));
    const upgrade = r.control.find(c => c.subject === n(DAO) && c.power === "upgrade")!;
    expect(upgrade.holders).toEqual([n(FACTORY)]);
    expect(upgrade.detail).toContain("update()");
    expect(upgrade.detail).toContain("auto_update: true");
    expect(upgrade.receiptIds).toContain(nearCallReceiptId(NEW, DAO, "get_factory_info"));
    // The factory's own authority: its full-access keys, and the DAO's super-admin over intents.near.
    expect(r.control.find(c => c.subject === n(FACTORY) && c.power === "upgrade")!.holders.filter(h => h.startsWith("ed25519:")).length).toBeGreaterThan(0);
    expect(r.control.find(c => c.subject === n("intents.near") && c.power === "grant-roles")!.holders).toContain(n(DAO));
    const rainbow = r.control.find(c => c.subject === n("rainbowbridge.sputnik-dao.near") && c.power === "upgrade")!;
    expect(rainbow.holders).not.toContain("unknown");
    expect(rainbow.reasons.map(x => x.code)).toContain("unknown-controller");
  });
  test("a factory edge against a capture that never read get_factory_info is missing coverage, not an addition", () => {
    const ctx = loadIntentContext({ snapshotId: NEW, root: NEAR_ROOT });
    expect(ctx.change).toEqual({ before: OLD, after: NEW, constructed: false });
    const r = reviewIntent({ kind: "asset", assetId: USDC }, ctx);
    expect(r.changes.changes.filter(c => (c.after ?? c.before)!.predicate === "upgraded-by" && c.subject === n(DAO))).toEqual([]);
    expect(r.unknowns).toContainEqual({ code: "missing-coverage", subject: n(DAO), ref: `get_factory_info:${OLD}` });
    const added = { kind: "added" as const, key: "k", before: null, after: upgradedBy(NEW, DAO)[0] };
    expect(factoryInfoCoverageGap(ctx.store, added, OLD, NEW)).toBe(true);
  });
});

// Review near-factory-auto-update R1: the coverage rule holds for every consumer of a NEAR snapshot comparison.
describe("get_factory_info coverage gap in every NEAR changes consumer", () => {
  const gap = { code: "missing-coverage" as const, subject: n(DAO), ref: `get_factory_info:${OLD}` };
  const factoryEdge = (cs: FactChange[]) => cs.filter(c => (c.after ?? c.before)!.predicate === "upgraded-by" && (c.after ?? c.before)!.object === n(FACTORY));
  const store = () => loadNearSnapshots([OLD, NEW], { root: NEAR_ROOT });
  test("nearChanges 09->14: no added factory edge, a missing-coverage reason, outcome partial", () => {
    const r = nearChanges(store(), { name: "changes", subject: n(DAO), beforeSnapshotId: OLD, afterSnapshotId: NEW, maxResults: 500 });
    expect(factoryEdge(r.changes)).toEqual([]);
    expect(r.reasons).toContainEqual(gap);
    expect(r.outcome).toBe("partial");
  });
  test("symmetric: a later capture without the read does not report the factory edge as removed", () => {
    const r = nearChanges(store(), { name: "changes", subject: n(DAO), beforeSnapshotId: NEW, afterSnapshotId: OLD, maxResults: 500 });
    expect(factoryEdge(r.changes)).toEqual([]);
    expect(r.changes.filter(c => c.kind === "removed" && c.before!.predicate === "upgraded-by")).toEqual([]);
    expect(r.reasons).toContainEqual(gap);
  });
  test("a comparison within near-2026-11-09 is untouched", () => {
    const s = store(), request = { name: "changes" as const, subject: n(DAO), beforeSnapshotId: OLD, afterSnapshotId: OLD, maxResults: 500 };
    const r = nearChanges(s, request);
    expect(r.reasons.some(x => x.ref?.startsWith("get_factory_info"))).toBe(false);
  });
  test("near diff CLI 09->14: no added upgraded-by, the coverage reason printed", () => {
    const p = Bun.spawnSync(["bun", "--no-env-file", "src/cli.ts", "near", "diff", DAO, OLD, NEW, "--offline"], { cwd: ROOT });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    expect(out).not.toMatch(/^added$/m);
    expect(out).not.toContain(`upgraded-by ${n(FACTORY)}`);
    expect(out).toContain(`missing-coverage ${n(DAO)} get_factory_info:${OLD}`);
  });
  test("panel comparison 09->14: no added · upgraded-by row, the coverage reason in the panel's reasons", () => {
    const panel = buildPanel(store(), NEW, n(DAO), { beforeSnapshotId: OLD });
    const rows = panel.sections.find(s => s.id === "changes")!.rows;
    expect(rows.some(r => r.change && (r.change.after ?? r.change.before)!.predicate === "upgraded-by")).toBe(false);
    expect(rows.some(r => r.what.includes("upgraded-by"))).toBe(false);
    expect(panel.reasons).toContainEqual(gap);
  });
  test("MCP linchpin_changes 09->14: no added factory edge, the coverage reason", async () => {
    const { value, isError } = await callTool("linchpin_changes", { subject: n(DAO), before: OLD, after: NEW }, { store: store(), snapshotId: NEW, libs: {} as never });
    expect(isError).toBe(false);
    const r = value as unknown as QueryResult;
    expect(factoryEdge(r.changes)).toEqual([]);
    expect(r.reasons).toContainEqual(gap);
  });
});
