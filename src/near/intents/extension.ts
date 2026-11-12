import { loadQuoteNotRecorded } from "./oneclick";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact, QueryReason } from "../../engine/contracts";
import { openStore, type EvidenceSnapshot } from "../../engine/queries/snapshot";
import { buildNearSnapshot, createNearClient, DEFAULT_NEAR_RPC, endpointOrigin, extendSnapshot, factId, liveSnapshotIds, mapOwnerUnknown, mapperFor, nearReads, nearSnapshotDir, readNearManifest, receiptFor, recordValue, verifyRecord, type MapperContext, type NearRecord } from "../reader";
import { CURRENT_NEAR_SNAPSHOT } from "../subjects/registry";
import { loadRouteRules, loadTokenList } from "./rules";
import type { IntentContext, OffchainController } from "./types";
import { buildRouteEvidence, captureRouteReads, type RouteRead } from "./migration";
export const INTENT_EXTENSION_SUFFIX = ".intents";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const TREASURY = "near:mainnet:omft.near#solana:HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16";
export const OMNI_PROGRAM = "near:mainnet:omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe";
export const REPORTED_MINTS = ["3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG", "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "HsRpHQn6VbyMs5b5j5SV6xQ2VvpvvCCzu19GjytVSCoz"] as const;
export const RHEA_MINT = "8SMMso8Muv8d6i4WmMDthKt6TN1ysN6937sx3DKLXZqB";
export const INTENT_EXTRA_READS = [
  ...["view_account", "view_access_key_list", "ft_metadata", "owner_get", "get_owner", "acl_get_permissioned_accounts"].map(method => ({ account: USDC, method })),
  ...["sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near", "wrap.near"].flatMap(account => ["owner_get", "get_owner", "acl_get_permissioned_accounts"].map(method => ({ account, method }))),
] as const;
export const OFFCHAIN_DOCUMENTS: readonly { id: OffchainController["id"]; title: string; url: string; mustContain: RegExp[]; summary: string }[] = [
  { id: "solver-class", title: "Solver Terms of Use", url: "https://docs.near-intents.org/integration/market-makers/solver-terms-of-use.md", mustContain: [/\bKY[BC]\b/i, /api key/i, /suspen/i], summary: "Solvers are a permissioned class: admission checks, API keys, suspension at the operator's discretion" },
  { id: "message-bus", title: "Message Bus", url: "https://docs.near-intents.org/integration/market-makers/message-bus/introduction.md", mustContain: [/message bus/i, /solver/i], summary: "Quotes and intents pass through an operator-run relay" },
  { id: "shield", title: "SHIELD incident API", url: "https://docs.near-intents.org/security-compliance/shield-incident-api", mustContain: [/pause/i, /quote/i], summary: "The operator can refuse quotes and pause by chain, token or destination" },
  { id: "operator-terms", title: "Terms of service", url: "https://docs.near-intents.org/security-compliance/terms-of-service", mustContain: [/Intents Technology/i, /British Virgin Islands|BVI/i], summary: "Terms set by the operating company" },
];
export interface IntentDocumentRecord { id: OffchainController["id"]; title: string; url: string; retrievedAt: string; httpStatus: number; contentType: string; bytes: number; sha256: string; finalUrl: string }
export interface IntentExtensionManifest { version: 1; baseSnapshotId: string; extensionId: string; endpointHost: string; capturedAt: string; reads: Record<string, string>; documents: string; reported: string; routeReads?: string; documentFailures?: { id: string; assertion: string; responseSha256: string; retrievedAt: string; endpointHost: string }[] }
export interface IntentReportedEntry { subject: string; predicate: string | null; object: string | null; title: string; excerpt: string; source: string; observedAt: string; reason: QueryReason | null }
export function reportedEntries(): IntentReportedEntry[] {
  const title = "Research Notes — NEAR Intents, Chain Signatures and Omnibridge (2026-10-22)", observedAt = "2026-10-22T00:00:00.000Z";
  const entry = (subject: string, predicate: string, object: string, excerpt: string): IntentReportedEntry => ({ subject, predicate, object, title, excerpt, source: "report:near-intents-research-2026-10-22", observedAt, reason: null });
  const conflict = (subject: string, excerpt: string): IntentReportedEntry => ({ subject, predicate: null, object: null, title: "Linchpin Shared Engine and NEAR Solana Build Plan 2026-10-22", excerpt, source: "report:build-plan-2026-10-22", observedAt, reason: { code: "conflict", subject, ref: "report:solana-class-2026-10-22" } });
  return [
    entry(TREASURY, "CONTROLLED_BY", "unknown", "Solana: NEAR Intents treasury `HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16`"),
    entry(OMNI_PROGRAM, "UPGRADE_AUTHORITY", "solana:5kx8AapW8tPkiFbuHiuEBcmN3ddwpBWZfCrZgxXgWeb6", "upgrade authority `5kx8AapW8tPkiFbuHiuEBcmN3ddwpBWZfCrZgxXgWeb6` (last deploy slot 428811242)"),
    conflict(OMNI_PROGRAM, "resolves to a **3-of-5 Squads v4 multisig with zero configured time lock**, rather than the earlier “single-key upgrade authority” description"),
    ...REPORTED_MINTS.flatMap(mint => { const subject = `near:mainnet:intents.near#solana:${mint}`, excerpt = "all three share mint authority `FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds`, freeze authority none"; return [entry(subject, "MINT_AUTHORITY", "solana:FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds", excerpt), entry(subject, "FREEZE_AUTHORITY", "none", excerpt), conflict(subject, "the dataset README identifies an off-curve PDA, not a plain wallet")]; }),
  ];
}
function documentReceipt(d: IntentDocumentRecord): EvidenceReceipt { return externalReceipt(`doc:${d.sha256.slice(0, 40)}`, `document:${new URL(d.url).host}`, d.sha256, d.retrievedAt); }
function externalReceipt(id: string, source: string, responseSha256: string, at: string): EvidenceReceipt {
  return { id, source, responseSha256, privacy: "public", observation: { chain: "near", network: "mainnet", blockOrSlot: null, blockHash: null, observedAt: at, retrievedAt: at, historicalState: "current-only" } };
}
function documentFact(d: IntentDocumentRecord, id: string): Fact {
  const f: Fact = { id: "", subject: `near:mainnet:intents.near#offchain:${d.id}`, predicate: "claimed-document", object: `${d.url}|${d.sha256}|${d.retrievedAt}`, basis: "claimed", status: "verified", privacy: "public", evidenceIds: [documentReceipt(d).id], path: [], validFrom: null, validTo: null }; f.id = factId(id, f); return f;
}
export async function captureIntentExtension(o: { snapshotId: string; root?: string; fetch?: typeof fetch; now?: () => Date; dryRun?: boolean }): Promise<IntentExtensionManifest> {
  if (readNearManifest(o.snapshotId, { root: o.root }).constructed) throw new Error("Cannot extend a constructed base");
  const dir = join(nearSnapshotDir(o.snapshotId, o.root), "intents"), extensionId = o.snapshotId + INTENT_EXTENSION_SUFFIX;
  if (existsSync(dir)) throw new Error("Intent extension already exists");
  const endpointUrl = process.env.LINCHPIN_NEAR_RPC_URL ?? DEFAULT_NEAR_RPC, endpointHost = endpointOrigin(endpointUrl).host;
  const manifest: IntentExtensionManifest = { version: 1, baseSnapshotId: o.snapshotId, extensionId, endpointHost, capturedAt: (o.now?.() ?? new Date()).toISOString(), reads: {}, documents: "", reported: "" };
  if (o.dryRun) return manifest;
  const client = createNearClient({ mode: "record", snapshotId: extensionId, snapshotDir: join(dir, "reads"), endpointHost, endpointUrl, archivalUrl: null, fetch: o.fetch, now: o.now, retries: 0 }, false);
  for (const { account, method } of INTENT_EXTRA_READS) {
    const r = method === "view_account" ? await client.viewAccount(account) : method === "view_access_key_list" ? await client.viewAccessKeys(account) : await client.callFunction(account, method, {});
    if (!r.ok && r.error.kind !== "call-error") throw new Error(`Intent capture failed: ${account} ${method} ${r.error.kind}`);
  }
  const routeReads = await captureRouteReads(loadRouteRules(), { endpointUrl, fetch: o.fetch, now: o.now });
  // Retain completed read-only observations even if a later document gate refuses capture.
  mkdirSync(join(dir, "reads"), { recursive: true });
  for (const r of client.records) {
    const file = `${r.requestSha256}.json`, bytes = JSON.stringify(r, null, 1) + "\n";
    manifest.reads[file] = sha256(bytes); writeFileSync(join(dir, "reads", file), bytes, { flag: "wx" });
  }
  const routeBytes = JSON.stringify(routeReads, null, 1) + "\n";
  manifest.routeReads = sha256(routeBytes);
  writeFileSync(join(dir, "route-reads.json"), routeBytes, { flag: "wx" });
  const documents: IntentDocumentRecord[] = [];
  for (const d of OFFCHAIN_DOCUMENTS) {
    let response: Response; try { response = await (o.fetch ?? globalThis.fetch)(d.url, { redirect: "follow", signal: AbortSignal.timeout(20_000) }); } catch { throw new Error(`Document transport failed: ${d.id}`); }
    if (!response.ok) throw new Error(`Document HTTP ${response.status}: ${d.id}`);
    const finalUrl = response.url || d.url;
    if (new URL(finalUrl).origin !== new URL(d.url).origin) throw new Error(`Document origin changed: ${d.id}`);
    const bytes = new Uint8Array(await response.arrayBuffer()), body = new TextDecoder().decode(bytes);
    const failed = d.mustContain.filter(pattern => !pattern.test(body));
    if (failed.length) {
      if (d.id === "shield" && failed.length === 1 && failed[0].source === "pause") {
        (manifest.documentFailures ??= []).push({ id: d.id, assertion: "/pause/i", responseSha256: sha256(bytes), retrievedAt: (o.now?.() ?? new Date()).toISOString(), endpointHost: new URL(d.url).host });
        continue;
      }
      throw new Error(`Document missing pattern: ${d.id} ${failed[0].source}`);
    }
    documents.push({ id: d.id, title: d.title, url: d.url, retrievedAt: (o.now?.() ?? new Date()).toISOString(), httpStatus: response.status, contentType: response.headers.get("content-type") ?? "", bytes: bytes.length, sha256: sha256(bytes), finalUrl });
  }
  const docs = JSON.stringify(documents, null, 1) + "\n", reported = JSON.stringify(reportedEntries(), null, 1) + "\n";
  manifest.documents = sha256(docs); manifest.reported = sha256(reported);
  writeFileSync(join(dir, "documents.json"), docs, { flag: "wx" }); writeFileSync(join(dir, "reported.json"), reported, { flag: "wx" });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n", { flag: "wx" });
  return manifest;
}
function loadExtension(baseId: string, root?: string): { manifest: IntentExtensionManifest; records: NearRecord[]; documents: IntentDocumentRecord[]; reported: IntentReportedEntry[]; routeReads: RouteRead[] } {
  if (readNearManifest(baseId, { root }).constructed) throw new Error("Cannot extend a constructed base");
  const dir = join(nearSnapshotDir(baseId, root), "intents"), manifest: IntentExtensionManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.baseSnapshotId !== baseId || manifest.extensionId !== baseId + INTENT_EXTENSION_SUFFIX || !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(manifest.endpointHost)) throw new Error("Invalid intent manifest");
  const read = (file: string, hash: string) => { const bytes = readFileSync(join(dir, file)); if (sha256(bytes) !== hash) throw new Error(`Intent extension hash mismatch: ${file}`); return JSON.parse(bytes.toString("utf8")); };
  const records = Object.entries(manifest.reads).sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => {
    if (!/^[0-9a-f]{64}\.json$/.test(file)) throw new Error("Invalid extension filename");
    const r = read(`reads/${file}`, hash) as NearRecord; verifyRecord(r);
    if (`${r.requestSha256}.json` !== file || r.endpointHost !== manifest.endpointHost || r.request.method !== "query" || !("finality" in r.request.params) || r.request.params.finality !== "final") throw new Error("Invalid extension read"); return r;
  });
  return { manifest, records, documents: read("documents.json", manifest.documents), reported: read("reported.json", manifest.reported), routeReads: manifest.routeReads ? read("route-reads.json", manifest.routeReads) : [] };
}
export function buildIntentSnapshot(baseId: string, opts: { root?: string } = {}): EvidenceSnapshot {
  const ext = loadExtension(baseId, opts.root), id = ext.manifest.extensionId, facts = new Map<string, Fact>(), receipts = new Map<string, EvidenceReceipt>();
  const add = (f: Fact) => { const old = facts.get(f.id); if (old) old.evidenceIds = [...new Set([...old.evidenceIds, ...f.evidenceIds])].sort(); else facts.set(f.id, f); };
  const accounts = [...new Set(ext.records.flatMap(r => r.request.method === "query" ? [r.request.params.account_id] : []))];
  for (const account of accounts) {
    const ctx: MapperContext = { snapshotId: id, account, constructed: false, entry: { account, subject: `near:mainnet:${account}`, label: account, chains: ["intents"], recipes: [{ kind: "account" }, { kind: "keys" }, { kind: "acl" }, { kind: "owner", method: "get_owner" }], yields: [] } };
    const own = ext.records.filter(r => r.request.method === "query" && r.request.params.account_id === account);
    let ownerReturned = false;
    for (const r of own) {
      const receipt = receiptFor(r, id); receipts.set(receipt.id, receipt);
      if (r.request.method !== "query" || r.outcome !== "result") continue;
      const p = r.request.params, method = "method_name" in p ? p.method_name : undefined;
      if (method === "get_owner" || method === "owner_get") ownerReturned = true;
      mapperFor(p.request_type, method === "owner_get" ? "get_owner" : method)?.(recordValue(r), receipt, ctx).forEach(add);
    }
    if (!ownerReturned) {
      const r = own.find(r => r.request.method === "query" && "method_name" in r.request.params && r.request.params.method_name === "get_owner");
      if (r) mapOwnerUnknown(receiptFor(r, id), ctx).forEach(add);
    }
  }
  for (const e of Object.values(buildRouteEvidence(ext.routeReads, loadRouteRules()))) {
    for (const r of e.receipts) receipts.set(r.id, r);
    if (e.controller) {
      const f: Fact = { id: "", subject: `near:mainnet:${e.token}`, predicate: "upgraded-by", object: `near:mainnet:${e.controller.value}`, basis: "decoded", status: "verified", privacy: "public", evidenceIds: [e.controller.receipt.id, ...e.sourceMetadata ? [e.sourceMetadata.receipt.id] : []], path: [], validFrom: null, validTo: null };
      f.id = factId(id, f); add(f);
    }
  }
  for (const d of ext.documents) { const r = documentReceipt(d); receipts.set(r.id, r); add(documentFact(d, id)); }
  for (const entry of ext.reported) {
    const hash = sha256(entry.excerpt), r = externalReceipt(`rep:${hash.slice(0, 40)}`, entry.source, hash, entry.observedAt); receipts.set(r.id, r);
    if (entry.predicate && entry.object) { const f: Fact = { id: "", subject: entry.subject, predicate: entry.predicate, object: entry.object, basis: "reported", status: "unverified", evidenceIds: [r.id], path: [], validFrom: null, validTo: null, privacy: "public" }; f.id = factId(id, f); add(f); }
  }
  return extendSnapshot(buildNearSnapshot(baseId, opts), { id, facts: [...facts.values()], receipts: [...receipts.values()] });
}
export function loadIntentContext(opts: { snapshotId?: string; before?: string; after?: string; root?: string } = {}): IntentContext {
  if (!!opts.before !== !!opts.after) throw new Error("Both change snapshots required");
  const baseSnapshotId = opts.snapshotId ?? CURRENT_NEAR_SNAPSHOT, base = buildNearSnapshot(baseSnapshotId, opts), extension = buildIntentSnapshot(baseSnapshotId, opts), ext = loadExtension(baseSnapshotId, opts.root);
  const ids = liveSnapshotIds(opts.root), before = opts.before ?? (ids.length > 1 ? ids[0] : undefined), after = opts.after ?? (ids.length > 1 ? ids.at(-1) : undefined);
  const snapshots = new Map([[base.id, base], [extension.id, extension]]);
  for (const id of [before, after]) if (id && !snapshots.has(id)) snapshots.set(id, buildNearSnapshot(id, opts));
  const offchain = ext.documents.map(d => ({ id: d.id, subject: `near:mainnet:intents.near#offchain:${d.id}`, title: d.title, url: d.url, sha256: d.sha256, retrievedAt: d.retrievedAt, summary: OFFCHAIN_DOCUMENTS.find(x => x.id === d.id)?.summary ?? "Postmortem of the 2026-09-29 ghost-balance incident, as published", factId: documentFact(d, extension.id).id, receiptId: documentReceipt(d).id }));
  return { store: openStore([...snapshots.values()]), baseSnapshotId, snapshotId: extension.id, asOf: [extension.observedTo, ...ext.routeReads.map(r => r.retrievedAt)].sort().at(-1)!, change: before && after ? { before, after, constructed: snapshots.get(after)!.constructed || snapshots.get(before)!.constructed } : null, reads: nearReads(baseSnapshotId, opts), rules: loadRouteRules(), tokens: loadTokenList(), offchain, quoteNotRecorded: loadQuoteNotRecorded(), routeEvidence: buildRouteEvidence(ext.routeReads, loadRouteRules()) };
}
