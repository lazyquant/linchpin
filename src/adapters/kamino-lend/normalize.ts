import { isConfiguredKey } from "../kamino/constants";
import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { PUBLIC_FRESHNESS_MS, validateSnapshot, type EvidenceSnapshot } from "../../engine/queries";
import { verifyKaminoLendCapture, type KaminoLendCapture } from "./capture";
import { KAMINO_LEND_TARGET as TARGET, KLEND_PROGRAM, SCOPE_PROGRAM, SQUADS_PROGRAM, SQUADS_V3_PROGRAM, SYSTEM_PROGRAM, identity } from "./constants";
import { accountBytes, decodeLendReserve, decodeLendMarket, decodeGlobalConfig, decodeMintHead, decodeProgram, decodeProgramDataHead, decodeSquadsMultisig, isDecodeFailure, globalConfigAddress, squadsVaultPda, type AccountRecord } from "./layout";
export interface CoverageGap { code: string; source: string; subject: string | null; detail: string }
export interface CoverageNote { id: string; code: "missing-coverage"; subject: string | null; detail: string }
export interface KaminoLendResult { snapshot: EvidenceSnapshot; gaps: CoverageGap[]; coverage: CoverageNote[] }
const sorted = (a: string[]) => [...new Set(a)].sort();
export function normalizeKaminoLendCapture(input: KaminoLendCapture): KaminoLendResult {
  const { manifest, records } = verifyKaminoLendCapture(input);
  const receipts: EvidenceReceipt[] = [], facts: Fact[] = [], gaps: CoverageGap[] = [], coverage: CoverageNote[] = [];
  const accounts = new Map<string, AccountRecord | null>(), evidence = new Map<string,string>(), sources = new Map<string,string>();
  const readers: EvidenceSnapshot["readers"] = [], partial = new Set<string>(), names: Record<string,string> = {};
  const times = Object.values(records).map(r => r.retrievedAt).sort(), observedFrom = times[0]!, observedTo = times.at(-1)!;
  function gap(code: string, key: string | null, detail: string, source = key ? sources.get(key) ?? "rpc-state.json" : "api-reserves.json") { gaps.push({ code, source, subject: key ? identity(key) : null, detail }); if (key && ["missing-account","malformed-record","membership-mismatch"].includes(code)) partial.add(identity(key)); }
  for (const file of manifest.records) {
    const r = records[file]!;
    const keys = r.kind === "rpc" ? r.params[0] : [];
    const failed = r.httpStatus < 200 || r.httpStatus >= 300 || (r.kind === "rpc" && (!r.response.context || !Array.isArray(r.response.value)));
    readers.push({ id: r.kind === "http" ? "kamino-lend-api" : `kamino-lend-chain-${r.role.slice(4)}`, status: failed ? "failed" : "complete", subjects: keys.map(identity).sort() });
    if (failed) gap(r.httpStatus === 429 ? "rate-limited" : r.httpStatus < 200 || r.httpStatus >= 300 ? "http-error" : "rpc-error", null, "Recorded response unavailable", file);
    for (const [i,k] of (r.kind === "http" ? ["body"] : keys).entries()) {
      const a = r.kind === "rpc" ? r.response.value?.[i] ?? null : null;
      const source = `fixture:kamino-lend/${manifest.captureId}/${file}#${k}`, responseSha256 = r.kind === "http" ? r.bodySha256 : sha256(canonical(a)), blockOrSlot = r.kind === "rpc" && r.slot !== null ? String(r.slot) : null;
      const id = sha256(canonical({ captureId: manifest.captureId, source, responseSha256, blockOrSlot, retrievedAt: r.retrievedAt }));
      receipts.push({ id, source, responseSha256, privacy: "public", observation: { chain: "solana", network: "mainnet-beta", blockOrSlot, blockHash: null, observedAt: r.retrievedAt, retrievedAt: r.retrievedAt, historicalState: manifest.constructed ? "constructed" : "current-only" } });
      if (r.kind === "rpc") { evidence.set(k,id); sources.set(k,file); if (!failed) { accounts.set(k,a); if (a === null) gap("missing-account",k,"Account absent in recorded response"); } }
    }
  }
  function fact(k: string, predicate: string, object: string, ids = [evidence.get(k)!], basis: Fact["basis"] = "decoded") {
    if (accounts.has(k) && accounts.get(k) === null) return;
    const fields: Omit<Fact,"id"> = { subject: identity(k), predicate, object: /^(amount:|none$|unknown$)/.test(object) ? object : identity(object), basis, status: object === "unknown" || basis === "unknown" ? "unverified" : "verified", evidenceIds: sorted(ids), path: [], validFrom: manifest.constructed ? observedFrom : null, validTo: null, privacy: "public" };
    facts.push({ id: sha256(canonical(fields)), ...fields });
  }
  const owner = (k: string) => fact(k,"OWNER_PROGRAM",accounts.get(k)!.owner);
  function read<T>(k: string, fn: (a: unknown) => T): Exclude<T,{ok:false}> | null { if (!accounts.has(k) || accounts.get(k) === null) { if (!accounts.has(k)) gap("missing-account",k,"Account not available"); return null; } const d = fn(accounts.get(k)); if (isDecodeFailure(d)) { gap("malformed-record",k,d.reason); return null; } return d as Exclude<T,{ok:false}>; }
  const authorities = new Map<string,string[]>();
  function authority(k: string, predicate: string, a: string | null, ids = [evidence.get(k)!]) { a = a && isConfiguredKey(a) ? a : null; fact(k,predicate,a ?? "none",ids); if (a) authorities.set(a,sorted([...(authorities.get(a) ?? []),...ids])); }
  const market = read(TARGET.market,decodeLendMarket);
  if (market) { owner(TARGET.market); authority(TARGET.market,"MARKET_OWNER",market.lendingMarketOwner); authority(TARGET.market,"EMERGENCY_AUTHORITY",market.emergencyCouncil); authority(TARGET.market,"RESERVE_PROPOSER",market.proposerAuthority); }
  const global = read(TARGET.globalConfig,decodeGlobalConfig);
  if (global && globalConfigAddress() === TARGET.globalConfig) { owner(TARGET.globalConfig); authority(TARGET.globalConfig,"GLOBAL_ADMIN",global.globalAdmin); }
  const api = records["api-reserves.json"]!;
  let entries: { reserve: string; liquidityToken?: string }[] = [];
  try { if (api.kind !== "http" || api.httpStatus !== 200) throw new Error(); const data = JSON.parse(api.body); if (!Array.isArray(data) || data.some(e => typeof e.reserve !== "string")) throw new Error(); entries = data; } catch { gap("malformed-record",null,"Invalid reserve list"); }
  const mints = new Map<string,{ decimals: number; program: string }[]>(), oracles = new Set<string>();
  for (const e of entries) {
    const k = e.reserve;
    coverage.push({ id: "reserve-status-not-decoded", code: "missing-coverage", subject: identity(k), detail: "Status (Active, Obsolete or Hidden) is not decoded; IN_MARKET and PRICED_BY do not establish active status." });
    if (typeof e.liquidityToken === "string" && e.liquidityToken.length) names[identity(k)] = e.liquidityToken;
    const r = read(k,decodeLendReserve); if (!r) continue;
    if (r.lendingMarket !== TARGET.market) { gap("membership-mismatch",k,"Reserve belongs to another market"); continue; }
    owner(k); fact(k,"IN_MARKET",r.lendingMarket); fact(k,"ASSET_MINT",r.mintPubkey);
    fact(k,"AVAILABLE_LIQUIDITY_RAW",`amount:${r.totalAvailableAmount}`); fact(k,"BORROWED_RAW",`amount:${r.borrowedAmountSf >> 60n}`);
    mints.set(r.mintPubkey,[...(mints.get(r.mintPubkey) ?? []),{ decimals: r.mintDecimals, program: r.tokenProgram }]);
    for (const o of r.oracleKeys) { fact(k,"PRICED_BY",o); oracles.add(o); }
  }
  for (const [k,expected] of mints) { const m = read(k,decodeMintHead); if (!m) continue; if (expected.some(e => e.decimals !== m.decimals || e.program !== accounts.get(k)!.owner)) { gap("malformed-record",k,"Mint differs from reserve metadata"); continue; } owner(k); fact(k,"DECIMALS",`amount:${m.decimals}`); fact(k,"MINT_AUTHORITY",m.mintAuthority ?? "none"); fact(k,"FREEZE_AUTHORITY",m.freezeAuthority ?? "none"); }
  for (const k of oracles) { const a = read(k,a => { try { accountBytes(a); if ((a as AccountRecord).executable) throw new Error(); return true; } catch { return { ok:false as const, reason:"Invalid oracle account" }; } }); if (a) owner(k); }
  for (const k of [KLEND_PROGRAM,SCOPE_PROGRAM]) { const p = read(k,a => decodeProgram(a,k)); if (!p) continue; const d = read(p.programData,decodeProgramDataHead); if (!d) continue; const ids = [evidence.get(k)!,evidence.get(p.programData)!]; fact(k,"PROGRAM_DATA",p.programData,ids); authority(k,"UPGRADE_AUTHORITY",d.upgradeAuthority,ids); }
  const multisigs: string[] = [];
  for (const [k,a] of accounts) { if (!a || sources.get(k) !== "rpc-control.json") continue; if (a.owner === SQUADS_V3_PROGRAM) { owner(k); continue; } if (a.owner !== SQUADS_PROGRAM) continue; const m = read(k,decodeSquadsMultisig); if (!m) continue; multisigs.push(k); owner(k); fact(k,"MULTISIG_THRESHOLD",`amount:${m.threshold}`); for (const member of m.members) fact(k,"MULTISIG_MEMBER",member.key); fact(k,"CONFIG_AUTHORITY",m.configAuthority === SYSTEM_PROGRAM ? "none" : m.configAuthority); }
  for (const [k,ids] of authorities) { const matches = multisigs.filter(ms => squadsVaultPda(ms) === k); if (matches.length === 1) fact(k,"CONTROLLED_BY",matches[0]!,[...ids,evidence.get(matches[0]!)!],"derived"); else { fact(k,"CONTROLLED_BY","unknown",ids,"unknown"); gap("unknown-controller",k,"No pinned controller established"); } }
  for (const [id,detail] of Object.entries({ "reserve-list-completeness":"Reserve list documented by API; completeness is not proven on chain.", "reserve-status":"Reserve status is not covered.", "scope-chain-indices":"Scope chain indices and their resolved entries are not covered.", "multisig-timelock":"Multisig time locks are not covered.", "pending-owner-admin":"Pending owner and admin are not covered.", "squads-v3-layout":"Squads v3 layout is not covered.", "fee-collector":"Fee collector is not covered.", "switchboard-upgrade-authority":"Switchboard upgrade authority is not covered.", "proposer-initialisation-phase":"Which reserves remain in the proposer's initialisation phase is not evaluated." })) coverage.push({ id,code:"missing-coverage",subject:null,detail });
  if (partial.size) readers.push({ id:"kamino-lend-gaps",status:"partial",subjects:sorted([...partial]) });
  const slots = receipts.flatMap(r => r.observation.blockOrSlot === null ? [] : [r.observation.blockOrSlot]).sort((a,b) => BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
  const snapshot = validateSnapshot({ version:1,id:`solana-mainnet-beta.kamino-lend.${manifest.captureId}`,chain:"solana",network:"mainnet-beta",constructed:manifest.constructed,observedFrom,observedTo,fromBlockOrSlot:slots[0] ?? null,toBlockOrSlot:slots.at(-1) ?? null,freshUntil:new Date(Date.parse(observedTo)+PUBLIC_FRESHNESS_MS).toISOString(),subjects:sorted([...evidence.keys()].map(identity).concat(facts.map(f=>f.subject),[...partial])),readers:readers.sort((a,b)=>a.id.localeCompare(b.id)),names:Object.fromEntries(Object.entries(names).sort()),receipts:receipts.sort((a,b)=>a.id.localeCompare(b.id)),facts:[...new Map(facts.map(f=>[f.id,f])).values()].sort((a,b)=>a.id.localeCompare(b.id)) });
  return { snapshot,gaps,coverage };
}
