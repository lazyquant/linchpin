import { expect, test } from "bun:test";
import { contextReads, contextSnapshot, contextStore } from "../src/near/governance/snapshots";
import { proposalsTouching, sweepOpen } from "../src/near/governance/review";
import { governanceStore } from "../src/near/governance/reach";
import { NEAR_REGISTRY } from "../src/near/subjects/registry";
import { buildNearSnapshot } from "../src/near/reader/load";

const SNAPSHOT = "near-2026-11-09";

test("one context builds each snapshot, store and read index once", () => {
  const ctx = { snapshotId: SNAPSHOT };
  expect(contextSnapshot(ctx)).toBe(contextSnapshot(ctx, SNAPSHOT));
  expect(contextStore(ctx, [SNAPSHOT])).toBe(contextStore(ctx, [SNAPSHOT]));
  expect(contextReads(ctx)).toBe(contextReads(ctx));
  expect(contextSnapshot({ snapshotId: SNAPSHOT })).not.toBe(contextSnapshot(ctx));
});

test("the cached snapshot equals a fresh build", () => {
  expect(contextSnapshot({ snapshotId: SNAPSHOT })).toEqual(buildNearSnapshot(SNAPSHOT));
});

test("a sweep with one shared context answers as a sweep with fresh contexts", () => {
  const shared = { snapshotId: SNAPSHOT };
  for (const subject of ["near:mainnet:intents.near", "near:mainnet:wrap.near"]) {
    expect(proposalsTouching(shared, subject)).toEqual(proposalsTouching({ snapshotId: SNAPSHOT }, subject));
  }
}, 120_000);

test("an unknown snapshot still throws, every time", () => {
  const ctx = { snapshotId: "near-1999-01-01" };
  expect(() => contextSnapshot(ctx)).toThrow();
  expect(() => contextSnapshot(ctx)).toThrow();
});

test("changing a returned report does not change the next answer from the same context", () => {
  const ctx = { snapshotId: SNAPSHOT };
  const first = proposalsTouching(ctx, "near:mainnet:intents.near");
  const report = sweepOpen(ctx, "rainbowbridge.sputnik-dao.near");
  const fresh = sweepOpen({ snapshotId: SNAPSHOT }, "rainbowbridge.sputnik-dao.near");
  for (const r of report.receipts) (r as { id: string }).id = "tampered";
  for (const f of report.supportingFacts ?? []) (f as { object: string }).object = "tampered";
  for (const p of report.proposals) for (const f of p.reach) (f as { object: string }).object = "tampered";
  expect(sweepOpen(ctx, "rainbowbridge.sputnik-dao.near")).toEqual(fresh);
  expect(proposalsTouching(ctx, "near:mainnet:intents.near")).toEqual(first);
}, 120_000);

test("a context whose snapshot or root changes does not reuse the old builds", () => {
  const ctx: { snapshotId: string; root?: string } = { snapshotId: SNAPSHOT };
  const before = contextSnapshot(ctx);
  ctx.snapshotId = "near-constructed-intents-locker-added";
  expect(contextSnapshot(ctx).id).toBe("near-constructed-intents-locker-added");
  ctx.snapshotId = SNAPSHOT;
  expect(contextSnapshot(ctx)).not.toBe(before);
  ctx.root = "/nonexistent-linchpin-root";
  expect(() => contextSnapshot(ctx)).toThrow();
});

test("the exported derived store is built fresh, and changing it does not change a later sweep", () => {
  const ctx = { snapshotId: SNAPSHOT };
  const report = sweepOpen(ctx, "rainbowbridge.sputnik-dao.near");
  const decoded = report.proposals.map(p => p.decoded);
  const mine = governanceStore(ctx, decoded);
  expect(mine).not.toBe(governanceStore(ctx, decoded));
  mine.reach.clear();
  expect(governanceStore(ctx, decoded).reach.size).toBe(decoded.length);
  expect(sweepOpen(ctx, "rainbowbridge.sputnik-dao.near")).toEqual(sweepOpen({ snapshotId: SNAPSHOT }, "rainbowbridge.sputnik-dao.near"));
}, 120_000);

test("a registry changed in place starts the context over", () => {
  const registry = [...NEAR_REGISTRY];
  const ctx = { snapshotId: SNAPSHOT, registry };
  const first = contextSnapshot(ctx);
  expect(contextSnapshot(ctx)).toBe(first);
  registry.pop();
  expect(contextSnapshot(ctx)).not.toBe(first);
});
