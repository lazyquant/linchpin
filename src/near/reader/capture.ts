import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import { NEAR_REGISTRY, REGISTRY_VERSION, registrySha256, type Recipe, type SubjectEntry } from "../subjects/registry";
import { createNearClient, DEFAULT_NEAR_RPC, endpointOrigin, restoredResponse } from "./client";
import { nearReads, nearSnapshotDir, nearStoreSha256, readNearManifest, snapshotFromRecords, type NearSnapshotManifest } from "./load";
import { mapperFor } from "./mappers";
import type { NearClient, NearRead, NearRecord } from "./types";
export interface CaptureOptions { snapshotId: string; root?: string; endpointUrl?: string; archivalUrl?: string | null; fetch?: typeof fetch; now?: () => Date; registry?: readonly SubjectEntry[]; dryRun?: boolean; minIntervalMs?: number }
async function recipeReads(client: NearClient, account: string, recipe: Recipe): Promise<NearRead<unknown>[]> {
  const call = (method: string, args: unknown = {}) => client.callFunction(account, method, args);
  switch (recipe.kind) {
    case "account": return [await client.viewAccount(account)];
    case "keys": return [await client.viewAccessKeys(account)];
    case "code": return [await client.viewCodeHash(account)];
    case "acl": return [await call("acl_get_permissioned_accounts")];
    case "pause": return [await call("pa_is_paused", { key: "ALL" }), await call("pa_all_paused")];
    case "owner": return [await call(recipe.method)];
    case "guardians": return [await call("get_guardians")];
    case "burrow-config": return [await call("get_config")];
    case "sputnik-policy": return [await call("get_policy")];
    case "controller-deployments": return [await call("get_deployments")];
    case "mpc-state": return [await call("state")];
    case "mpc-images": return [await call("allowed_docker_image_hashes")];
    case "ft-metadata": return [await call("ft_metadata")];
    case "sputnik-proposals": {
      const last = await call("get_last_proposal_id"), results = [last];
      if (!last.ok) return results;
      const n = last.value;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid last proposal id");
      const start = recipe.window === "all" ? 0 : Math.max(0, n - recipe.window);
      for (let i = start; i < n; i += 100) results.push(await call("get_proposals", { from_index: i, limit: Math.min(100, n - i) }));
      for (const id of recipe.pinned ?? []) if (id < start || id >= n) results.push(await call("get_proposal", { id }));
      return results;
    }
  }
}
function manifestFor(id: string, records: readonly NearRecord[], extra: Partial<NearSnapshotManifest>): NearSnapshotManifest {
  const heights = records.flatMap(r => r.blockHeight === null ? [] : [BigInt(r.blockHeight)]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (!heights.length) throw new Error("Capture has no block heights");
  return { version: 1, snapshotId: id, capturedAt: records[0].retrievedAt, completedAt: records.at(-1)!.retrievedAt, endpointHost: records[0].endpointHost, archivalHost: null,
    fromBlock: String(heights[0]), toBlock: String(heights.at(-1)), nearcoreVersion: "unknown", protocolVersion: 0,
    constructed: false, constructedFrom: null, constructedChange: null, registryVersion: REGISTRY_VERSION, registrySha256: registrySha256(), readerVersion: "near-reader/1", reads: records.length, files: {}, storeSha256: "0".repeat(64), ...extra };
}
function finishManifest(m: NearSnapshotManifest, records: readonly NearRecord[], registry: readonly SubjectEntry[], dir?: string): NearSnapshotManifest {
  for (const r of records) {
    const name = `${r.requestSha256}.json`, bytes = JSON.stringify(r, null, 1) + "\n";
    m.files[name] = sha256(bytes);
    if (dir) writeFileSync(join(dir, name), bytes);
  }
  m.storeSha256 = nearStoreSha256(snapshotFromRecords(m, records, registry));
  if (dir) writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 1) + "\n");
  return m;
}
function reserve(finalDir: string, staging: string): void {
  if (existsSync(finalDir) || existsSync(staging)) throw new Error("NEAR capture refuses to overwrite an existing directory");
  mkdirSync(dirname(staging), { recursive: true }); mkdirSync(staging);
}
export async function captureSnapshot(o: CaptureOptions): Promise<NearSnapshotManifest> {
  if (!/^near-\d{4}-\d{2}-\d{2}$/.test(o.snapshotId)) throw new Error("Capture requires a live snapshot id");
  const root = o.root ?? "fixtures/near", finalDir = nearSnapshotDir(o.snapshotId, root), staging = join(root, `.${o.snapshotId}.partial`);
  if (existsSync(finalDir) || existsSync(staging)) throw new Error("NEAR capture refuses to overwrite an existing directory");
  const endpointUrl = o.endpointUrl ?? process.env.LINCHPIN_NEAR_RPC_URL ?? DEFAULT_NEAR_RPC;
  const endpointHost = endpointOrigin(endpointUrl).host, archivalUrl = o.archivalUrl === undefined ? process.env.LINCHPIN_NEAR_ARCHIVAL_RPC_URL ?? null : o.archivalUrl;
  const archivalHost = archivalUrl ? endpointOrigin(archivalUrl).host : null;
  const registry = o.registry ?? NEAR_REGISTRY, clock = o.now ?? (() => new Date()), capturedAt = clock().toISOString();
  const client = createNearClient({ ...o, mode: "record", minIntervalMs: o.minIntervalMs ?? 2000, endpointUrl, archivalUrl, endpointHost, snapshotDir: staging }, !o.dryRun);
  if (!o.dryRun) reserve(finalDir, staging);
  try {
    let failed = false;
    for (const entry of registry) for (const recipe of entry.recipes) {
      try {
        const reads = await recipeReads(client, entry.account, recipe); let methodMissing = false;
        for (const read of reads) {
          if (!read.ok) {
            if (recipe.kind === "owner" && read.error.kind === "call-error" && read.error.name === "MethodNotFound") { methodMissing = true; continue; }
            throw new Error(`${read.error.kind}${read.error.name ? ` ${read.error.name}` : ""}`);
          }
          const req = read.record.request;
          if (req.method === "query") mapperFor(req.params.request_type, "method_name" in req.params ? req.params.method_name : undefined)?.(read.value, read.receipt, { snapshotId: o.snapshotId, account: entry.account, entry, constructed: false });
        }
        if (o.dryRun) console.log(`${methodMissing ? "method-not-found" : "ok"} ${entry.account} ${recipe.kind}`);
      } catch (e) {
        if (!o.dryRun) throw new Error(`${entry.account} ${recipe.kind}: ${e instanceof Error ? e.message : "recipe error"}`);
        console.log(`error ${entry.account} ${recipe.kind}: ${e instanceof Error ? e.message : "recipe error"}`); failed = true;
      }
    }
    // One retained closing block. Bounds include every query response height.
    const status = await client.status(), block = await client.block();
    if (!status.ok || !block.ok) throw new Error("NEAR status or closing block read failed");
    if (failed) throw new Error("NEAR dry run has failing recipes");
    const version = (status.value as any)?.version;
    const m = manifestFor(o.snapshotId, client.records, { capturedAt, completedAt: clock().toISOString(), endpointHost, archivalHost, protocolVersion: block.value.protocolVersion, nearcoreVersion: String(version?.build ?? version?.version ?? "unknown") });
    finishManifest(m, client.records, registry, o.dryRun ? undefined : staging);
    if (!o.dryRun) {
      if (existsSync(finalDir)) throw new Error("NEAR snapshot appeared during capture");
      renameSync(staging, finalDir);
    }
    return m;
  } catch (e) { if (!o.dryRun) rmSync(staging, { recursive: true, force: true }); throw e; }
}
export async function constructSnapshot(name: "intents-locker-added", from: string, root = "fixtures/near"): Promise<NearSnapshotManifest> {
  if (name !== "intents-locker-added") throw new Error("Unknown constructed snapshot");
  const id = `near-constructed-${name}`, finalDir = nearSnapshotDir(id, root), staging = join(root, `.${id}.partial`);
  const source = readNearManifest(from, { root });
  if (source.constructed) throw new Error("Constructed source must be a live snapshot");
  const records = nearReads(from, { root }).records.filter(r => r.request.method === "query" && r.request.params.account_id === "intents.near").map(r => structuredClone(r));
  const acl = records.find(r => r.request.method === "query" && "method_name" in r.request.params && r.request.params.method_name === "acl_get_permissioned_accounts");
  if (!acl?.resultText || acl.outcome !== "result") throw new Error("Source ACL missing");
  const value = JSON.parse(acl.resultText), grantees = value.roles.UnrestrictedAccountLocker.grantees as string[];
  if (grantees.includes("linchpin-constructed-locker.near")) throw new Error("Constructed grantee already present");
  grantees.push("linchpin-constructed-locker.near"); acl.resultText = JSON.stringify(value); acl.responseSha256 = sha256(canonical(restoredResponse(acl)));
  reserve(finalDir, staging);
  try {
    const m = manifestFor(id, records, { capturedAt: source.capturedAt, completedAt: source.completedAt, constructed: true, constructedFrom: from, constructedChange: "one UnrestrictedAccountLocker grantee added", nearcoreVersion: source.nearcoreVersion, protocolVersion: source.protocolVersion });
    finishManifest(m, records, NEAR_REGISTRY, staging); mkdirSync(dirname(finalDir), { recursive: true }); if (existsSync(finalDir)) throw new Error("NEAR snapshot appeared during construction"); renameSync(staging, finalDir); return m;
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
}
export async function probeUnknownBlock(o: { archivalUrl: string; endpointUrl?: string; root?: string; fetch?: typeof fetch; now?: () => Date }): Promise<void> {
  const root = o.root ?? "fixtures/near", dir = join(root, "probes", "unknown-block"), staging = join(root, ".unknown-block.partial");
  const endpointUrl = o.endpointUrl ?? process.env.LINCHPIN_NEAR_RPC_URL ?? DEFAULT_NEAR_RPC;
  const host = endpointOrigin(endpointUrl).host; endpointOrigin(o.archivalUrl); reserve(dir, staging);
  try {
    const client = createNearClient({ ...o, endpointUrl, endpointHost: host, mode: "record", snapshotId: "near-probe-unknown-block", snapshotDir: staging });
    const read = await client.viewAccount("intents.near", { blockId: "999999999999" });
    if (!read.ok || !read.historyReceipt || !client.records.some(r => r.archival?.attempted && r.archival.errorName === "UNKNOWN_BLOCK")) throw new Error("Probe did not return UNKNOWN_BLOCK and current fallback");
    writeFileSync(join(staging, "probe.json"), JSON.stringify({ version: 1, snapshotId: "near-probe-unknown-block", endpointHost: host, archivalHost: endpointOrigin(o.archivalUrl).host, requestBlockId: "999999999999", historyReceipt: read.historyReceipt, receipt: read.receipt, reasons: read.reasons, files: Object.fromEntries(client.records.map(r => [`${r.requestSha256}.json`, sha256(readFileSync(join(staging, `${r.requestSha256}.json`)))])) }, null, 1) + "\n");
    mkdirSync(dirname(dir), { recursive: true }); if (existsSync(dir)) throw new Error("NEAR probe appeared during capture"); renameSync(staging, dir);
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
}
