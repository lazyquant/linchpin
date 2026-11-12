import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { openStore, validateSnapshot, type EvidenceSnapshot, type EvidenceStore } from "../../engine/queries/snapshot";
import { PUBLIC_FRESHNESS_MS } from "../../engine/queries/marinade";
import { NEAR_REGISTRY, REGISTRY_VERSION, registrySha256, type SubjectEntry } from "../subjects/registry";
import { receiptFor, recordValue, verifyRecord } from "./client";
import { factId, mapOwnerUnknown, mapperFor } from "./mappers";
import type { NearRecord } from "./types";
export interface NearSnapshotManifest {
  version: 1; snapshotId: string; capturedAt: string; completedAt: string; endpointHost: string; archivalHost: string | null;
  fromBlock: string; toBlock: string; nearcoreVersion: string; protocolVersion: number;
  constructed: boolean; constructedFrom: string | null; constructedChange: string | null;
  registryVersion: string; registrySha256: string; readerVersion: "near-reader/1";
  reads: number; files: Record<string, string>; storeSha256: string;
}
export interface LoadOptions { root?: string; verify?: boolean }
export interface NearReadIndex {
  records: readonly NearRecord[];
  find(account: string, requestType: string, method?: string, args?: unknown): { record: NearRecord; receipt: EvidenceReceipt; value: unknown } | null;
}
export function nearSnapshotDir(id: string, root = "fixtures/near"): string {
  if (/^near-\d{4}-\d{2}-\d{2}$/.test(id)) return join(root, id);
  if (/^near-constructed-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return join(root, "constructed", id.slice("near-constructed-".length));
  throw new Error("Invalid NEAR snapshot id");
}
export function readNearManifest(id: string, opts: LoadOptions = {}): NearSnapshotManifest {
  const m = JSON.parse(readFileSync(join(nearSnapshotDir(id, opts.root), "manifest.json"), "utf8")) as NearSnapshotManifest;
  if (m.version !== 1 || m.snapshotId !== id || m.readerVersion !== "near-reader/1" || m.constructed !== id.startsWith("near-constructed-")) throw new Error("Invalid NEAR manifest");
  if (!/^\d+$/.test(m.fromBlock) || !/^\d+$/.test(m.toBlock) || BigInt(m.fromBlock) > BigInt(m.toBlock)) throw new Error("Invalid NEAR block range");
  if (!m.files || m.reads !== Object.keys(m.files).length || !/^[0-9a-f]{64}$/.test(m.storeSha256)) throw new Error("Invalid NEAR manifest hashes");
  if (opts.verify !== false && (m.registryVersion !== REGISTRY_VERSION || m.registrySha256 !== registrySha256())) throw new Error("NEAR registry version mismatch");
  return m;
}
function readRecords(id: string, opts: LoadOptions): { manifest: NearSnapshotManifest; records: NearRecord[] } {
  const manifest = readNearManifest(id, opts), dir = nearSnapshotDir(id, opts.root);
  const records = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) throw new Error("Invalid NEAR record filename");
    const bytes = readFileSync(join(dir, file));
    if (opts.verify !== false && sha256(bytes) !== hash) throw new Error(`NEAR file hash mismatch: ${file}`);
    const record = JSON.parse(bytes.toString("utf8")) as NearRecord;
    if (`${record.requestSha256}.json` !== file) throw new Error("NEAR record filename mismatch");
    if (opts.verify !== false) verifyRecord(record);
    if (record.endpointHost !== manifest.endpointHost || "block_id" in record.request.params) throw new Error("NEAR snapshot must contain final reads from one host");
    return record;
  });
  const heights = records.flatMap(r => r.blockHeight === null ? [] : [BigInt(r.blockHeight)]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (!heights.length || String(heights[0]) !== manifest.fromBlock || String(heights.at(-1)) !== manifest.toBlock) throw new Error("NEAR block range mismatch");
  return { manifest, records };
}
export function nearStoreSha256(s: EvidenceSnapshot): string {
  return sha256(canonical({ facts: [...s.facts].sort((a, b) => a.id.localeCompare(b.id)), receipts: [...s.receipts].sort((a, b) => a.id.localeCompare(b.id)) }));
}
export function snapshotFromRecords(m: NearSnapshotManifest, records: readonly NearRecord[], registry: readonly SubjectEntry[] = NEAR_REGISTRY): EvidenceSnapshot {
  const receipts = records.map(r => receiptFor(r, m.snapshotId, m.constructed)).sort((a, b) => a.id.localeCompare(b.id));
  const facts = new Map<string, Fact>();
  const add = (f: Fact) => { const old = facts.get(f.id); if (old) old.evidenceIds = [...new Set([...old.evidenceIds, ...f.evidenceIds])].sort(); else facts.set(f.id, f); };
  const byAccount = (a: string) => records.filter(r => r.request.method === "query" && r.request.params.account_id === a);
  const entries = m.constructed ? registry.filter(e => byAccount(e.account).length) : registry;
  const readers: EvidenceSnapshot["readers"] = [];
  for (const entry of entries) {
    const own = byAccount(entry.account); let partial = own.length === 0;
    for (const r of own) {
      if (r.request.method !== "query") continue;
      const p = r.request.params, method = "method_name" in p ? p.method_name : undefined;
      const ctx = { snapshotId: m.snapshotId, account: entry.account, entry, constructed: m.constructed };
      const expectedOwner = method === "get_owner" && entry.recipes.some(r => r.kind === "owner") && r.outcome === "call-error" && JSON.stringify(r.response).includes("MethodNotFound");
      if (expectedOwner) mapOwnerUnknown(receiptFor(r, m.snapshotId, m.constructed), ctx).forEach(add);
      else if (r.outcome !== "result") partial = true;
      else mapperFor(p.request_type, method)?.(recordValue(r), receiptFor(r, m.snapshotId, m.constructed), ctx).forEach(add);
    }
    const expectedMethods = entry.recipes.flatMap(recipe => {
      switch (recipe.kind) {
        case "acl": return ["acl_get_permissioned_accounts"];
        case "pause": return ["pa_is_paused", "pa_all_paused"];
        case "owner": return [recipe.method];
        case "guardians": return ["get_guardians"];
        case "burrow-config": return ["get_config"];
        case "sputnik-policy": return ["get_policy"];
        case "sputnik-proposals": return ["get_last_proposal_id"];
        case "controller-deployments": return ["get_deployments"];
        case "mpc-state": return ["state"];
        case "mpc-images": return ["allowed_docker_image_hashes"];
        case "ft-metadata": return ["ft_metadata"];
        default: return [];
      }
    });
    if (expectedMethods.some(method => !own.some(r => r.request.method === "query" && "method_name" in r.request.params && r.request.params.method_name === method))) partial = true;
    for (const [recipe, type] of [["account", "view_account"], ["keys", "view_access_key_list"], ["code", "view_code"]]) {
      if (entry.recipes.some(r => r.kind === recipe) && !own.some(r => r.request.method === "query" && r.request.params.request_type === type)) partial = true;
    }
    readers.push({ id: `near-reader:${entry.account}`, status: partial ? "partial" : "complete", subjects: [entry.subject] });
    if (entry.deployedBy) {
      if (entry.account.slice(entry.account.indexOf(".") + 1) !== entry.deployedBy || !registry.some(e => e.account === entry.deployedBy)) throw new Error("Invalid NEAR factory relationship");
      const accountRead = (a: string) => byAccount(a).find(r => r.request.method === "query" && r.request.params.request_type === "view_account" && r.outcome === "result");
      const child = accountRead(entry.account), parent = accountRead(entry.deployedBy);
      if (child && parent) {
        const f: Fact = { id: "", subject: entry.subject, predicate: "deployed-by", object: `near:mainnet:${entry.deployedBy}`, basis: "derived", status: "verified", evidenceIds: [receiptFor(child, m.snapshotId, m.constructed).id, receiptFor(parent, m.snapshotId, m.constructed).id].sort(), path: [], validFrom: m.constructed ? child.retrievedAt : null, validTo: null, privacy: "public" };
        f.id = factId(m.snapshotId, f); add(f);
      } else readers.at(-1)!.status = "partial";
    }
  }
  const sortedFacts = [...facts.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const f of sortedFacts) if (!f.object.length || f.object.length > 1048576 || /[\u0000-\u001f]/.test(f.object)) throw new Error(`Invalid NEAR fact object: ${f.subject} ${f.predicate} (${f.object.length} characters)`);
  const times = receipts.map(r => r.observation.observedAt).sort();
  if (!times.length) throw new Error("Empty NEAR snapshot");
  const observedTo = times.at(-1)!;
  return validateSnapshot({ version: 1, id: m.snapshotId, chain: "near", network: "mainnet", constructed: m.constructed,
    observedFrom: times[0], observedTo, fromBlockOrSlot: m.fromBlock, toBlockOrSlot: m.toBlock, freshUntil: new Date(Date.parse(observedTo) + PUBLIC_FRESHNESS_MS).toISOString(),
    subjects: [...new Set([...entries.map(e => e.subject), ...sortedFacts.map(f => f.subject)])].sort(), readers,
    names: Object.fromEntries(entries.map(e => [e.subject, e.label])), receipts, facts: sortedFacts });
}
export function buildNearSnapshot(id: string, opts: LoadOptions = {}): EvidenceSnapshot {
  const { manifest, records } = readRecords(id, opts), snapshot = snapshotFromRecords(manifest, records);
  if (opts.verify !== false && nearStoreSha256(snapshot) !== manifest.storeSha256) throw new Error("NEAR store hash mismatch");
  return snapshot;
}
export function loadNearSnapshot(id: string, opts?: LoadOptions): EvidenceStore { return openStore([buildNearSnapshot(id, opts)]); }
export function loadNearSnapshots(ids: string[], opts?: LoadOptions): EvidenceStore { return openStore(ids.map(id => buildNearSnapshot(id, opts))); }
export function liveSnapshotIds(root = "fixtures/near"): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^near-\d{4}-\d{2}-\d{2}$/.test(e.name)).map(e => e.name).sort(); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
export function nearReads(id: string, opts: LoadOptions = {}): NearReadIndex {
  const { manifest, records } = readRecords(id, opts);
  return { records: structuredClone(records), find(account, requestType, method, args) {
    const record = records.find(r => r.request.method === "query" && r.request.params.account_id === account && r.request.params.request_type === requestType && (method === undefined || "method_name" in r.request.params && r.request.params.method_name === method) && (args === undefined || "args_base64" in r.request.params && canonical(JSON.parse(Buffer.from(r.request.params.args_base64, "base64").toString("utf8"))) === canonical(args)));
    return record && record.outcome === "result" ? { record: structuredClone(record), receipt: receiptFor(record, id, manifest.constructed), value: recordValue(record) } : null;
  } };
}
export function extendSnapshot(base: EvidenceSnapshot, add: { id: string; facts: Fact[]; receipts?: EvidenceReceipt[]; subjects?: string[] }): EvidenceSnapshot {
  if (add.id === base.id) throw new Error("Extension needs a new snapshot id");
  const receipts = [...base.receipts, ...add.receipts ?? []], times = receipts.map(r => r.observation.observedAt).sort();
  const heights = receipts.flatMap(r => r.observation.blockOrSlot === null ? [] : [BigInt(r.observation.blockOrSlot)]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return validateSnapshot({ ...structuredClone(base), id: add.id, facts: [...base.facts, ...add.facts], receipts,
    subjects: [...new Set([...base.subjects, ...add.subjects ?? [], ...add.facts.map(f => f.subject)])].sort(),
    observedFrom: times[0] ?? base.observedFrom, observedTo: times.at(-1) ?? base.observedTo,
    fromBlockOrSlot: heights.length ? String(heights[0]) : null, toBlockOrSlot: heights.length ? String(heights.at(-1)) : null });
}
