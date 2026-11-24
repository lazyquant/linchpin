import { openStore, type EvidenceSnapshot, type EvidenceStore } from "../../engine/queries/snapshot";
import { buildNearSnapshot, nearReads, readNearManifest, type NearReadIndex } from "../reader/load";
import type { GovernanceContext } from "./types";

/**
 * Snapshots, stores and read indexes built once per governance context.
 *
 * A sweep reviews every DAO, and each DAO review used to rebuild the same recorded snapshot from disk several times
 * (manifest, records, hashes): about 250 ms each, so one `proposalsTouching` call took about 9 s. The recorded files
 * of a snapshot do not change while a context is in use, so each build is kept on the context object and dropped with
 * it. What these return is shared: callers must not change it, and a report built from it is copied before it is
 * returned (`review.ts`). A failed build is not kept.
 */
const caches = new WeakMap<GovernanceContext, { snapshotId: string; root: string | undefined; registry: string | undefined; entries: Map<string, unknown> }>();
// By content, so a registry changed in place also starts over. Without one the fixed NEAR registry applies.
const registryKey = (ctx: GovernanceContext): string | undefined => ctx.registry === undefined ? undefined : JSON.stringify(ctx.registry);
export function contextMemo<T>(ctx: GovernanceContext, key: string, make: () => T): T {
  let held = caches.get(ctx);
  const registry = registryKey(ctx);
  // A context whose snapshot, root or registry was changed since its last use starts over.
  if (!held || held.snapshotId !== ctx.snapshotId || held.root !== ctx.root || held.registry !== registry) {
    held = { snapshotId: ctx.snapshotId, root: ctx.root, registry, entries: new Map() };
    caches.set(ctx, held);
  }
  const cache = held.entries;
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}
export function contextManifest(ctx: GovernanceContext, id: string = ctx.snapshotId): ReturnType<typeof readNearManifest> {
  return contextMemo(ctx, `manifest:${id}`, () => readNearManifest(id, { root: ctx.root }));
}
export function contextSnapshot(ctx: GovernanceContext, id: string = ctx.snapshotId): EvidenceSnapshot {
  return contextMemo(ctx, `snapshot:${id}`, () => buildNearSnapshot(id, { root: ctx.root }));
}
export function contextStore(ctx: GovernanceContext, ids: string[]): EvidenceStore {
  return contextMemo(ctx, `store:${JSON.stringify(ids)}`, () => openStore(ids.map(id => contextSnapshot(ctx, id))));
}
export function contextReads(ctx: GovernanceContext, id: string = ctx.snapshotId): NearReadIndex {
  return contextMemo(ctx, `reads:${id}`, () => nearReads(id, { root: ctx.root }));
}
