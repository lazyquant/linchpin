import { basename, dirname, join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { nearReads, nearSnapshotDir, recordValue, type NearRecord } from "../near/reader";

export type SiteFact = {
  key: string; value: string; chain: "near" | "solana"; account: string;
  method: string; receiptId: string; file: string; block: number;
  blockHash?: string; responseSha256: string; retrievedAt: string;
};
export type SiteFacts = {
  facts: Map<string, SiteFact>;
  snapshot: { id: string; capturedAt: string; constructed: boolean };
};
export class SiteFactError extends Error {
  constructor(public factKey: string, public source: string, message: string) {
    super(`${message} [${factKey}; ${source}]`);
    this.name = "SiteFactError";
  }
}
type Json = Record<string, any>;
export type NearRead = {
  request: { request_type: string; account_id: string; method_name: string; args: Json };
  result: any; blockHeight: number; blockHash?: string;
  responseSha256: string; retrievedAt: string;
};
const integer = (n: number | bigint) => n.toLocaleString("en-US");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
function object(value: any, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`missing or invalid ${label}`);
  return value;
}
function nonempty(value: any, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`empty ${label}`);
  return value;
}
function date(value: any): string {
  const text = nonempty(value, "retrievedAt");
  if (!Number.isFinite(Date.parse(text))) throw new Error("invalid retrievedAt");
  return new Date(text).toISOString().slice(0, 10);
}
function jsonArgs(value: any): Json {
  if (value == null || value === "") return {};
  return object(typeof value === "string" ? JSON.parse(Buffer.from(value, "base64").toString("utf8")) : value, "args");
}
/** Compatibility decoder for the original constructed landing-page fixtures. */
export function readNearRead(json: unknown): NearRead {
  const raw = object(json, "read");
  const request = object(raw.request?.params ?? raw.request, "request");
  const response = object(raw.response, "response");
  if (response.error) throw new Error("RPC response contains an error");
  const envelope = object(response.result, "response.result");
  let result: any = envelope;
  if (request.request_type === "call_function") {
    const bytes = envelope.result;
    if (!Array.isArray(bytes) || bytes.some((x: unknown) => !Number.isInteger(x) || Number(x) < 0 || Number(x) > 255)) {
      throw new Error("missing or invalid call_function result bytes");
    }
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
  }
  const blockHeight = raw.block_height ?? envelope.block_height;
  if (!Number.isInteger(blockHeight) || blockHeight <= 0) throw new Error("missing or invalid block_height");
  const responseSha256 = nonempty(raw.responseSha256, "responseSha256");
  if (!/^[a-f0-9]{64}$/i.test(responseSha256)) throw new Error("invalid responseSha256");
  date(raw.retrievedAt);
  return {
    request: {
      request_type: nonempty(request.request_type, "request_type"),
      account_id: nonempty(request.account_id, "account_id"),
      method_name: request.method_name ?? "",
      args: jsonArgs(request.args ?? request.args_base64),
    }, result, blockHeight, blockHash: raw.block_hash ?? envelope.block_hash,
    responseSha256, retrievedAt: raw.retrievedAt,
  };
}
async function readJson(file: string, key: string): Promise<{ json: Json; text: string }> {
  if (!(await Bun.file(file).exists())) throw new SiteFactError(key, file, `missing fixture for ${key}`);
  try {
    const text = await Bun.file(file).text();
    return { json: object(JSON.parse(text), "JSON object"), text };
  } catch (error) {
    throw new SiteFactError(key, file, `parse failure: ${error instanceof Error ? error.message : error}`);
  }
}
function funds(proposal: Json): boolean {
  if (proposal.kind?.Transfer) return true;
  const actions = proposal.kind?.FunctionCall?.actions;
  if (!Array.isArray(actions)) return false;
  return actions.some((action: Json) => {
    if (/^(ft_transfer|ft_transfer_call|storage_withdraw)$/.test(action.method_name) || /^withdraw/.test(action.method_name)) return true;
    if (action.method_name !== "execute") return false;
    const args = jsonArgs(action.args);
    return Array.isArray(args.actions) && args.actions.some((a: Json) => a.Withdraw != null);
  });
}

export async function loadFacts(opts: {
  nearSnapshotDir: string; solanaFixturesDir: string; allowConstructed?: boolean;
}): Promise<SiteFacts> {
  const facts = new Map<string, SiteFact>();
  const snapshotDir = opts.nearSnapshotDir;
  const manifestFile = join(snapshotDir, "manifest.json");
  if (!(await Bun.file(manifestFile).exists())) {
    throw new SiteFactError("near.snapshot.id", manifestFile, `missing snapshot ${snapshotDir}`);
  }
  const { json: manifest, text: manifestText } = await readJson(manifestFile, "near.snapshot.id");
  let snapshot: SiteFacts["snapshot"];
  try {
    snapshot = { id: nonempty(manifest.snapshotId, "snapshotId"), capturedAt: nonempty(manifest.capturedAt, "capturedAt"), constructed: manifest.constructed === true };
    date(snapshot.capturedAt);
  } catch (error) { throw new SiteFactError("near.snapshot.id", manifestFile, String(error)); }
  if (snapshot.constructed && !opts.allowConstructed) throw new SiteFactError("near.snapshot.id", manifestFile, "constructed snapshot requires --allow-constructed");
  const manifestBase: Omit<SiteFact, "key" | "value"> = {
    chain: "near", account: "", method: "manifest", receiptId: `${basename(snapshotDir)}/manifest`,
    file: manifestFile, block: 0, responseSha256: sha256(manifestText), retrievedAt: snapshot.capturedAt,
  };
  const put = (key: string, value: string, base: Omit<SiteFact, "key" | "value">) => {
    if (!value.trim()) throw new SiteFactError(key, base.file, `empty value for ${key}`);
    facts.set(key, { ...base, key, value });
  };
  put("near.snapshot.id", snapshot.id, manifestBase);
  put("near.snapshot.date", date(snapshot.capturedAt), manifestBase);
  const reads: Array<{ read: NearRead; file: string }> = [];
  let missingRecord: SiteFactError | undefined;
  // Only explicitly constructed, unversioned fixtures use the legacy envelope.
  // Real snapshots always go through the reader's manifest and hash validation.
  const legacyStub = snapshot.constructed && manifest.version === undefined && manifest.readerVersion === undefined;
  if (legacyStub) {
    for (const name of (await readdir(snapshotDir)).sort()) {
      if (!name.endsWith(".json") || name === "manifest.json") continue;
      const file = join(snapshotDir, name);
      const { json } = await readJson(file, "near.read");
      try { reads.push({ read: readNearRead(json), file }); }
      catch (error) { throw new SiteFactError("near.read", file, `parse failure: ${String(error)}`); }
    }
  } else {
    try {
      const root = snapshot.constructed ? dirname(dirname(snapshotDir)) : dirname(snapshotDir);
      if (resolve(nearSnapshotDir(snapshot.id, root)) !== resolve(snapshotDir)) throw new Error("snapshot directory does not match snapshotId");
      const options = { root };
      let records: readonly NearRecord[];
      try { records = nearReads(snapshot.id, options).records; }
      catch (error) {
        const failure = error as NodeJS.ErrnoException;
        if (failure.code !== "ENOENT" || !failure.path?.endsWith(".json")) throw error;
        missingRecord = new SiteFactError("near.read", failure.path, `snapshot read failure: ${String(error)}`);
        // Inspect surviving records only to diagnose which fact lost its source.
        // This path must still fail below, even if the missing read is unused.
        const surviving: NearRecord[] = [];
        for (const name of Object.keys(manifest.files).sort()) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) throw error;
          const file = join(snapshotDir, name);
          if (await Bun.file(file).exists()) surviving.push((await readJson(file, "near.read")).json as NearRecord);
        }
        records = surviving;
      }
      for (const record of records) {
        // Status, account/code reads and recorded call errors are not page facts.
        if (record.outcome !== "result" || record.request.method !== "query" || record.request.params.request_type !== "call_function") continue;
        const file = join(snapshotDir, `${record.requestSha256}.json`);
        try {
          const request = record.request.params;
          const blockHeight = Number(record.blockHeight);
          if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0) throw new Error("missing or invalid blockHeight");
          date(record.retrievedAt);
          reads.push({ file, read: {
            request: { request_type: request.request_type, account_id: request.account_id, method_name: request.method_name, args: jsonArgs(request.args_base64) },
            result: recordValue(record), blockHeight, blockHash: record.blockHash ?? undefined,
            responseSha256: record.responseSha256, retrievedAt: record.retrievedAt,
          } });
        } catch (error) { throw new SiteFactError("near.read", file, `parse failure: ${String(error)}`); }
      }
    } catch (error) {
      if (error instanceof SiteFactError) throw error;
      throw new SiteFactError("near.read", snapshotDir, `snapshot read failure: ${String(error)}`);
    }
  }
  const baseFor = ({ read, file }: typeof reads[number]): Omit<SiteFact, "key" | "value"> => ({
    chain: "near", account: read.request.account_id, method: read.request.method_name,
    receiptId: `${basename(snapshotDir)}/${basename(file, ".json")}`, file, block: read.blockHeight,
    blockHash: read.blockHash, responseSha256: read.responseSha256, retrievedAt: read.retrievedAt,
  });
  function select(key: string, account: string, method: string) {
    const source = `${account} ${method}`;
    const matches = reads.filter(({ read }) => read.request.request_type === "call_function" && read.request.account_id === account && read.request.method_name === method);
    if (matches.length !== 1) throw new SiteFactError(key, missingRecord?.source ?? snapshotDir, `${matches.length ? "ambiguous" : "missing"} fixture for ${key}: ${source}`);
    return matches[0]!;
  }
  function extract(key: string, entry: typeof reads[number], fn: (value: Json) => string, guard?: (v: string) => boolean, expected?: string) {
    try {
      const value = fn(object(entry.read.result, "result"));
      if (guard && !guard(value)) throw new Error(`copy guard failed for ${key}: expected ${expected}, read ${value}`);
      put(key, value, baseFor(entry));
    } catch (error) {
      if (error instanceof SiteFactError) throw error;
      throw new SiteFactError(key, entry.file, String(error));
    }
  }
  const acl = select("intents.role.pause-manager.count", "intents.near", "acl_get_permissioned_accounts");
  function grantees(value: Json, role: string): string[] {
    const list = value.roles?.[role]?.grantees;
    if (!Array.isArray(list) || list.some(x => typeof x !== "string" || !x.trim())) throw new Error(`missing or invalid ${role}.grantees`);
    return list;
  }
  for (const [key, role] of [["pause-manager", "PauseManager"], ["account-locker", "UnrestrictedAccountLocker"]]) {
    extract(`intents.role.${key}.count`, acl, v => integer(grantees(v, role!).length), v => Number(v.replaceAll(",", "")) >= 1, ">= 1");
  }
  for (const [key, role] of [["upgrader", "Upgrader"], ["dao", "DAO"]]) {
    extract(`intents.role.${key}`, acl, v => grantees(v, role!).join(", "), v => v.length > 0, "non-empty grantees");
  }
  const policy = select("intents-dao.council.size", "intents.sputnik-dao.near", "get_policy");
  function council(v: Json): Json {
    const matches = Array.isArray(v.roles) ? v.roles.filter((r: Json) => r.name === "council") : [];
    if (matches.length !== 1 || !Array.isArray(matches[0].kind?.Group) || !matches[0].kind.Group.length) throw new Error("missing or ambiguous council Group");
    return matches[0];
  }
  extract("intents-dao.council.size", policy, v => integer(council(v).kind.Group.length));
  extract("intents-dao.council.threshold", policy, v => {
    const c = council(v), size = c.kind.Group.length;
    const p = c.vote_policy?.call ?? v.default_vote_policy;
    if (!p || p.weight_kind === "TokenWeight") throw new Error("copy guard failed for intents-dao.council.threshold: unsupported vote policy");
    let n: number;
    if (p.weight_kind === "RoleWeight" && Array.isArray(p.threshold) && p.threshold.length === 2) {
      const [num, den] = p.threshold.map(Number);
      if (!Number.isInteger(num) || !Number.isInteger(den) || num < 0 || den <= 0) throw new Error("invalid threshold ratio");
      n = Math.min(Math.floor(num * size / den) + 1, size);
    } else if ((p.weight_kind === "Weight" || p.weight_kind === "RoleWeight") && !Array.isArray(p.threshold)) n = Number(p.threshold);
    else throw new Error("unsupported vote policy");
    if (!Number.isInteger(n) || n < 1 || n > size) throw new Error(`copy guard failed for intents-dao.council.threshold: expected 1..${size}, read ${n}`);
    return integer(n);
  });
  extract("intents-dao.proposal-period", policy, v => {
    const ns = BigInt(nonempty(v.proposal_period, "proposal_period")), day = 86400000000000n;
    if (ns <= 0n) throw new Error("invalid proposal_period");
    if (ns % day === 0n) return `${integer(ns / day)} days`;
    const hours = Number(ns) / 3600000000000;
    if (!Number.isFinite(hours)) throw new Error("invalid proposal_period");
    return `${hours.toLocaleString("en-US", { maximumFractionDigits: 12 })} hours`;
  });
  extract("intents-dao.policy.fields", policy, v => Object.keys(v).sort().join(" · "), v => !/delay|timelock|hold/i.test(v), "no delay, timelock or hold field");
  const config = select("burrow.pause-operator", "contract.main.burrow.near", "get_config");
  extract("burrow.pause-operator", config, v => v.pause_operator_id == null ? "none" : nonempty(v.pause_operator_id, "pause_operator_id"), v => v === "none", "none");
  extract("burrow.owner", config, v => nonempty(v.owner_id, "owner_id"), v => v.endsWith(".sputnik-dao.near"), "a Sputnik DAO owner");
  for (const id of [1745, 1746]) {
    const key = `burrow-dao.proposal.${id}`;
    const candidates: Array<{ entry: typeof reads[number]; proposal: Json }> = [];
    for (const entry of reads) {
      const { request, result } = entry.read;
      if (request.account_id !== "burrow.sputnik-dao.near" || request.request_type !== "call_function") continue;
      if (request.method_name === "get_proposal" && Number(request.args.id) === id && result?.id === id) candidates.push({ entry, proposal: result });
      if (request.method_name === "get_proposals" && Array.isArray(result)) for (const p of result) if (p?.id === id) candidates.push({ entry, proposal: p });
    }
    if (candidates.length !== 1) throw new SiteFactError(`${key}.id`, missingRecord?.source ?? snapshotDir, `${candidates.length ? "ambiguous" : "missing"} fixture for ${key}.id: burrow.sputnik-dao.near get_proposal ${id}`);
    const { entry, proposal } = candidates[0]!;
    try {
      if (!funds(proposal)) throw new Error(`copy guard failed for ${key}.id: expected a funds action`);
      put(`${key}.id`, integer(id), baseFor(entry));
      put(`${key}.status`, nonempty(proposal.status, "status"), baseFor(entry));
    } catch (error) { throw new SiteFactError(`${key}.id`, entry.file, String(error)); }
  }
  if (missingRecord) throw missingRecord;
  // Every extracted NEAR fact above is placed on the page; snapshot metadata
  // has no read block. Unused reads must not widen the footer's evidence range.
  const placed = [...facts.values()].filter(f => f.chain === "near" && f.block > 0).sort((a, b) => a.block - b.block);
  for (const [key, fact] of [["near.block.min", placed[0]!], ["near.block.max", placed.at(-1)!]] as const) {
    put(key, integer(fact.block), fact);
  }
  const solanaFile = join(opts.solanaFixturesDir, "mip-14/getTransaction-4fe335555c17.json");
  const { json: sol } = await readJson(solanaFile, "solana.mip14.burned");
  try {
    const response = object(sol.response, "response"), meta = object(response.meta, "meta");
    if (meta.err !== null) throw new Error("copy guard failed for solana.mip14.slot: expected meta.err null");
    if (!Number.isInteger(response.slot) || response.slot <= 0) throw new Error("missing response.slot");
    const account = "B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG";
    const mint = "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey";
    const balance = (rows: any): Json => {
      const matches = Array.isArray(rows) ? rows.filter((r: Json) => r.owner === account && r.mint === mint) : [];
      if (matches.length !== 1) throw new Error("missing or ambiguous treasury token balance");
      return matches[0];
    };
    const pre = balance(meta.preTokenBalances), post = balance(meta.postTokenBalances);
    if (pre.accountIndex !== post.accountIndex) throw new Error("treasury token account mismatch");
    const preText = nonempty(pre.uiTokenAmount?.uiAmountString, "pre uiAmountString");
    const postText = nonempty(post.uiTokenAmount?.uiAmountString, "post uiAmountString");
    if (![preText, postText].every(v => /^\d+(\.\d+)?$/.test(v))) throw new Error("invalid token amount");
    const decimals = Math.max(preText.split(".")[1]?.length ?? 0, postText.split(".")[1]?.length ?? 0);
    const units = (text: string) => { const [whole, part = ""] = text.split("."); return BigInt(whole! + part.padEnd(decimals, "0")); };
    const delta = units(preText) - units(postText);
    if (delta <= 0n) throw new Error("copy guard failed for solana.mip14.burned: expected > 0");
    const base: Omit<SiteFact, "key" | "value"> = {
      chain: "solana", account, method: "getTransaction", file: solanaFile,
      receiptId: "mip-14/getTransaction-4fe335555c17", block: response.slot,
      retrievedAt: nonempty(sol.retrievedAt, "retrievedAt"), responseSha256: nonempty(sol.responseSha256, "responseSha256"),
    };
    put("solana.mip14.burned", integer(delta / 10n ** BigInt(decimals)), base);
    put("solana.mip14.slot", integer(response.slot), base);
    put("solana.mip14.retrieved", date(sol.retrievedAt), base);
    put("solana.mip14.signature", nonempty(sol.params?.signature, "params.signature"), base);
  } catch (error) { throw new SiteFactError("solana.mip14.burned", solanaFile, String(error)); }
  return { facts, snapshot };
}
