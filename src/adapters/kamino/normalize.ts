import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { PUBLIC_FRESHNESS_MS, validateSnapshot, type EvidenceSnapshot } from "../../engine/queries/index";
import { verifyCapture, type KaminoCapture, type RpcRecord, type HttpRecord } from "./capture";
import { KVAULT_PROGRAM, KLEND_PROGRAM, METRIC_KEYS, SYSTEM_PROGRAM, identity, isConfiguredKey } from "./constants";
import { accountBytes, decodeVault, decodeReserve, decodeMarket, decodeProgram, decodeProgramDataHead, decodeSquadsMultisig, isDecodeFailure, type AccountRecord, type VaultState, type ReserveState, programDataAddress } from "./layout";
import { validateMechanics, type Entity, type EntityKind, type Relation, type RelationKind, type NamedQuantity, type Unit, type KaminoMechanics } from "./mechanics";
import { parseIdleClaim, compareIdleClaim, type IdleClaim, type ClaimComparison } from "./claims";

export type GapCode = "http-error" | "rate-limited" | "rpc-error" | "malformed-record" | "inconsistent-slots" | "partial-reserves" | "missing-account" | "unknown-controller";
export interface CoverageGap { code: GapCode; source: string; subject: string | null; detail: string }
export interface ControllerView { address: string; mechanisms: string[]; type: "unknown" | "squads-v4-multisig"; evidenceIds: string[] }
export interface ClaimView extends ClaimComparison { id: "kamino-docs-typical-buffer-share"; claim: IdleClaim | null; claimBasis: "claimed"; claimEvidenceIds: string[]; observedQuantity: "vault.idleSharePpm"; observationBasis: "derived"; observationEvidenceIds: string[]; scope: "documented typical vault, not this vault's policy" }
export interface CrossCheck { name: "allocations" | "tokenAvailable"; reported: string[] | string | null; decoded: string[] | string | null; agree: boolean }
export interface KaminoReport { version: 1; snapshotId: string; vault: string; stateSlot: string | null; quantities: NamedQuantity[]; missing: string[]; controllers: ControllerView[]; crossChecks: CrossCheck[]; claims: ClaimView[]; notCaptured: string[]; notComputed: string[] }
export interface KaminoResult { snapshot: EvidenceSnapshot; mechanics: KaminoMechanics; report: KaminoReport; gaps: CoverageGap[] }
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (items: string[]) => [...new Set(items)].sort(cmp);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const VAULT_QUANTITIES = ["tokenAvailable", "sharesIssued", "pendingFees", "performanceFeeBps", "managementFeeBps", "withdrawalPenaltyBps", "withdrawalPenaltyLamports", "minWithdrawAmount", "unallocatedWeight", "unallocatedTokensCap", "totalAssets", "idleSharePpm"];
const RESERVE_QUANTITIES = ["available", "borrowed", "utilizationPpm", "protocolTakeRatePct", "withdrawalCapCapacity", "vaultCtokenAllocation", "vaultTargetWeight", "vaultInvested", "vaultAllocationPpm"];

/** Pure replay: discovery responses provide no facts, quantities or receipts. */
export function normalizeCapture(input: KaminoCapture): KaminoResult {
  const capture = verifyCapture(input), { manifest, records } = capture;
  const state = records["rpc-state.json"] as RpcRecord, programs = records["rpc-programs.json"] as RpcRecord;
  const vaultKey = manifest.target.vault, vaultId = identity(vaultKey), stateSlot = state.slot === null ? null : String(state.slot);
  const snapshotId = `solana-mainnet-beta.kamino.${manifest.captureId}`;
  const receipts: EvidenceReceipt[] = [], gaps: CoverageGap[] = [], gapSubjects = new Set<string>();
  const readers: EvidenceSnapshot["readers"] = [], names: Record<string, string> = {};
  const entities = new Map<string, Entity>(), relations: Relation[] = [], quantities = new Map<string, NamedQuantity>();
  const stateSubjects = new Set<string>(), programSubjects = new Set<string>();
  const receiptByAccount = new Map<string, string>(), httpReceipts = new Map<string, string>();
  const relationKeys = new Set<string>();
  function receipt(file: string, record: RpcRecord | HttpRecord, key?: string, account?: AccountRecord | null) {
    const source = `kamino-capture:${manifest.captureId}/${file}${key === undefined ? "" : `#${key}`}`;
    const responseSha256 = record.kind === "http" ? record.bodySha256 : key === undefined ? record.responseSha256 : sha256(canonical(account ?? null));
    const blockOrSlot = record.kind === "rpc" && record.slot !== null ? String(record.slot) : null;
    const fields = { captureId: manifest.captureId, source, responseSha256, blockOrSlot, retrievedAt: record.retrievedAt };
    const r: EvidenceReceipt = { id: sha256(canonical(fields)), source, responseSha256, privacy: "public", observation: { chain: "solana", network: "mainnet-beta", blockOrSlot, blockHash: null, observedAt: record.retrievedAt, retrievedAt: record.retrievedAt, historicalState: manifest.constructed ? "constructed" : "current-only" } };
    receipts.push(r); return r.id;
  }
  function gap(code: GapCode, source: string, key: string | null, detail: string, affected: string[] = []) {
    const subject = key === null ? null : identity(key);
    if (!gaps.some(g => g.code === code && g.source === source && g.subject === subject)) gaps.push({ code, source, subject, detail });
    for (const k of affected) gapSubjects.add(identity(k));
  }
  function entity(key: string, kind: EntityKind, evidenceIds: string[]) {
    const id = identity(key), old = entities.get(id);
    if (old) { if (old.kind !== kind) { gap("malformed-record", "rpc-state.json", key, "Account occupies incompatible roles", [key]); return; } old.evidenceIds = sorted([...old.evidenceIds, ...evidenceIds]); return; }
    entities.set(id, { id, kind, evidenceIds: sorted(evidenceIds), ...(kind === "Authority" ? { controllerType: "unknown" as const } : {}) });
  }
  function relation(kind: RelationKind, from: string, to: string, evidenceIds: string[]) {
    const r = { kind, from: identity(from), to: identity(to), evidenceIds: sorted(evidenceIds) };
    const key = `${kind}|${r.from}|${r.to}`; if (!relationKeys.has(key)) { relationKeys.add(key); relations.push(r); }
  }
  function rpcAccounts(file: string, record: RpcRecord, readerId: string, subjects: Set<string>) {
    const failed = record.httpStatus < 200 || record.httpStatus >= 300 || !record.response.context || !Array.isArray(record.response.value) || record.response.value.length !== record.params[0].length;
    const accounts = new Map<string, AccountRecord | null>();
    if (failed) {
      const evidence = receipt(file, record);
      gap(record.httpStatus === 429 || record.response.code === 429 ? "rate-limited" : "rpc-error", file, null, "Account read unavailable");
      if (file === "rpc-state.json") { subjects.add(vaultId); entity(vaultKey, "Vault", [evidence]); }
      else {
        const requested = new Set(record.params[0]);
        const known = new Set([KVAULT_PROGRAM, KLEND_PROGRAM, ...record.params[0].filter(key => requested.has(programDataAddress(key)))]);
        for (const key of known) { subjects.add(identity(key)); entity(key, "Program", [evidence]); }
      }
    } else for (let i = 0; i < record.params[0].length; i++) {
      const key = record.params[0][i]!, account = record.response.value![i] ?? null;
      accounts.set(key, account); subjects.add(identity(key)); receiptByAccount.set(key, receipt(file, record, key, account));
    }
    readers.push({ id: readerId, status: failed ? "failed" : "complete", subjects: [] });
    return { accounts, failed };
  }
  const sr = rpcAccounts("rpc-state.json", state, "kamino-chain-state", stateSubjects);
  const pr = rpcAccounts("rpc-programs.json", programs, "kamino-chain-programs", programSubjects);
  const se = (key: string) => receiptByAccount.get(key)!;
  const authorities = new Set<string>();
  const decodedReserves = new Map<string, ReserveState>();
  const reserveKeys = new Set<string>(), marketKeys = new Set<string>(), oracleKeys = new Set<string>();
  const terminalStates: { key: string; predicate: string; object: string; evidenceIds: string[] }[] = [];
  function imply(key: string, kind: EntityKind, from: string, evidenceIds: string[], program = false): boolean {
    entity(key, kind, evidenceIds);
    const available = (program ? programs : state).params[0].includes(key);
    if (!available) gap("inconsistent-slots", program ? "rpc-programs.json" : "rpc-state.json", key, "Decoded reference was not requested in the same read", [from]);
    return available;
  }
  function authority(key: string, from: string, evidenceIds: string[]) {
    if (!isConfiguredKey(key)) return;
    authorities.add(key); imply(key, "Authority", from, sr.accounts.has(key) ? [se(key)] : evidenceIds);
  }
  function owner(key: string, a: AccountRecord) {
    if (programs.params[0].includes(a.owner)) { entity(a.owner, "Program", [se(a.owner) ?? se(key)]); relation("OWNER_PROGRAM", key, a.owner, [se(key)]); }
    else gap("inconsistent-slots", "rpc-programs.json", a.owner, "Owning program was not requested", [key]);
  }
  let vault: VaultState | null = null;
  if (!sr.failed) {
    const decoded = decodeVault(sr.accounts.get(vaultKey));
    entity(vaultKey, "Vault", [se(vaultKey) ?? receipts[0]!.id]);
    if (isDecodeFailure(decoded) || decoded.tokenMint !== manifest.target.tokenMint) gap("malformed-record", "rpc-state.json", vaultKey, "Vault owner, layout or mint mismatch", [vaultKey]);
    else {
      vault = decoded;
      if (vault.name !== null) names[vaultId] = vault.name;
      owner(vaultKey, sr.accounts.get(vaultKey)!);
      for (const [kind, key] of [["VAULT_ADMIN", vault.vaultAdminAuthority], ["ALLOCATION_ADMIN", vault.allocationAdmin]] as const) {
        if (isConfiguredKey(key)) { authority(key, vaultKey, [se(vaultKey)]); relation(kind, vaultKey, key, [se(vaultKey)]); }
      }
      imply(vault.sharesMint, "Mint", vaultKey, sr.accounts.has(vault.sharesMint) ? [se(vault.sharesMint)] : [se(vaultKey)]);
      const uniqueAllocations = [] as VaultState["allocations"];
      for (const allocation of vault.allocations) {
        if (reserveKeys.has(allocation.reserve)) { gap("malformed-record", "rpc-state.json", vaultKey, "Duplicate reserve allocation dropped", [vaultKey]); continue; }
        reserveKeys.add(allocation.reserve); uniqueAllocations.push(allocation);
        imply(allocation.reserve, "Reserve", vaultKey, sr.accounts.has(allocation.reserve) ? [se(allocation.reserve)] : [se(vaultKey)]);
        relation("ALLOCATES_TO", vaultKey, allocation.reserve, [se(vaultKey)]);
      }
      vault = { ...vault, allocations: uniqueAllocations };
    }
    // Account discriminators retain independent coverage when the vault itself is malformed.
    for (const [key, a] of sr.accounts) { if (key === vaultKey || reserveKeys.has(key)) continue; const r = decodeReserve(a); if (!isDecodeFailure(r)) reserveKeys.add(key); }
    for (const key of reserveKeys) {
      if (!sr.accounts.has(key)) continue;
      entity(key, "Reserve", [se(key)]);
      const r = decodeReserve(sr.accounts.get(key));
      if (isDecodeFailure(r) || r.mintPubkey !== (vault?.tokenMint ?? manifest.target.tokenMint)) { gap("partial-reserves", "rpc-state.json", key, "Reserve unavailable or incompatible with vault mint", [key, vaultKey]); continue; }
      decodedReserves.set(key, r); owner(key, sr.accounts.get(key)!);
      marketKeys.add(r.lendingMarket); imply(r.lendingMarket, "Market", key, sr.accounts.has(r.lendingMarket) ? [se(r.lendingMarket)] : [se(key)]); relation("IN_MARKET", key, r.lendingMarket, [se(key)]);
      for (const oracle of r.oracleKeys) { oracleKeys.add(oracle); imply(oracle, "OracleSource", key, sr.accounts.has(oracle) ? [se(oracle)] : [se(key)]); relation("PRICED_BY", key, oracle, [se(key)]); }
    }
    for (const [key, a] of sr.accounts) { if (marketKeys.has(key)) continue; const m = decodeMarket(a); if (!isDecodeFailure(m)) marketKeys.add(key); }
    for (const key of marketKeys) {
      if (!sr.accounts.has(key)) continue;
      entity(key, "Market", [se(key)]); const a = sr.accounts.get(key)!;
      if (a === null) { gap("missing-account", "rpc-state.json", key, "Market account is null", [key]); continue; }
      const m = decodeMarket(a);
      if (isDecodeFailure(m)) { gap("malformed-record", "rpc-state.json", key, m.reason, [key]); continue; }
      if (m.name !== null) names[identity(key)] = m.name;
      owner(key, a);
      if (isConfiguredKey(m.lendingMarketOwner)) { authority(m.lendingMarketOwner, key, [se(key)]); relation("MARKET_OWNER", key, m.lendingMarketOwner, [se(key)]); }
    }
    for (const key of oracleKeys) {
      if (!sr.accounts.has(key)) continue;
      const a = sr.accounts.get(key)!;
      if (a === null) { gap("missing-account", "rpc-state.json", key, "Oracle account is null", [key]); continue; }
      try { accountBytes(a); if (a.executable) throw new Error(); owner(key, a); } catch { gap("malformed-record", "rpc-state.json", key, "Malformed oracle account", [key]); }
    }
  }
  // Program and programdata facts are sourced solely from the bounded program read.
  const programKeys = new Set<string>([KVAULT_PROGRAM, KLEND_PROGRAM]);
  for (const key of oracleKeys) { const a = sr.accounts.get(key); if (a && pr.accounts.has(a.owner)) programKeys.add(a.owner); }
  for (const [key, a] of pr.accounts) { try { if (a?.executable || accountBytes(a).readUInt32LE(0) === 2) programKeys.add(key); } catch {} }
  if (!pr.failed) for (const key of programKeys) {
    if (!pr.accounts.has(key)) continue;
    entity(key, "Program", [se(key)]);
    const p = decodeProgram(pr.accounts.get(key), key);
    if (isDecodeFailure(p)) { gap("malformed-record", "rpc-programs.json", key, p.reason, [key]); continue; }
    entity(p.programData, "ProgramData", [se(p.programData) ?? se(key)]);
    relation("PROGRAM_DATA", key, p.programData, [se(key)]);
    if (!pr.accounts.has(p.programData)) { gap("inconsistent-slots", "rpc-programs.json", p.programData, "Programdata was not requested", [key]); continue; }
    const d = decodeProgramDataHead(pr.accounts.get(p.programData));
    if (isDecodeFailure(d)) { gap("malformed-record", "rpc-programs.json", p.programData, d.reason, [p.programData]); continue; }
    const evidenceIds = [se(key), se(p.programData)];
    if (d.upgradeAuthority === null) terminalStates.push({ key, predicate: "UPGRADE_AUTHORITY", object: "none", evidenceIds });
    else {
      entity(d.upgradeAuthority, "Authority", sr.accounts.has(d.upgradeAuthority) ? [se(d.upgradeAuthority)] : evidenceIds);
      relation("UPGRADE_AUTHORITY", key, d.upgradeAuthority, evidenceIds);
      if (!sr.failed) authority(d.upgradeAuthority, key, evidenceIds);
    }
  }
  if (!sr.failed) for (const key of [...authorities]) {
    // Unread authorities have an inconsistent-read gap, not a fabricated account receipt.
    if (!sr.accounts.has(key)) continue;
    const a = decodeSquadsMultisig(sr.accounts.get(key));
    if (isDecodeFailure(a)) { gap("unknown-controller", "rpc-state.json", key, "Account does not establish a controller type"); terminalStates.push({ key, predicate: "CONTROLLED_BY", object: "unknown", evidenceIds: [se(key)] }); continue; }
    entities.get(identity(key))!.controllerType = "squads-v4-multisig";
    terminalStates.push({ key, predicate: "MULTISIG_THRESHOLD", object: `amount:${a.threshold}`, evidenceIds: [se(key)] });
    for (const member of a.members) { entity(member.key, "Authority", [se(key)]); relation("MULTISIG_MEMBER", key, member.key, [se(key)]); }
    if (a.configAuthority === SYSTEM_PROGRAM) terminalStates.push({ key, predicate: "CONFIG_AUTHORITY", object: "none", evidenceIds: [se(key)] });
    else { entity(a.configAuthority, "Authority", [se(key)]); relation("CONFIG_AUTHORITY", key, a.configAuthority, [se(key)]); }
  }

  function quantity(name: string, key: string, value: bigint | number | string, unit: Unit, evidenceIds: string[], extra: Partial<NamedQuantity> = {}) {
    quantities.set(name, { name, subject: identity(key), value: String(value), unit, mint: null, decimals: null, window: "point", basis: "decoded", evidenceIds: sorted(evidenceIds), inputs: [], asOfSlot: stateSlot, ...extra });
  }
  function derived(name: string, key: string, value: bigint, unit: Unit, inputs: string[], extra: Partial<NamedQuantity> = {}) {
    quantity(name, key, value, unit, inputs.flatMap(n => quantities.get(n)?.evidenceIds ?? []), { basis: "derived", inputs, ...extra });
  }
  const invested = new Map<string, bigint>();
  if (vault) {
    const token = { mint: identity(vault.tokenMint), decimals: vault.tokenMintDecimals };
    for (const field of ["tokenAvailable", "minWithdrawAmount", "unallocatedTokensCap"] as const) quantity(`vault.${field}`, vaultKey, vault[field], "token-base-units", [se(vaultKey)], token);
    quantity("vault.pendingFees", vaultKey, vault.pendingFeesSf >> 60n, "token-base-units", [se(vaultKey)], token);
    quantity("vault.sharesIssued", vaultKey, vault.sharesIssued, "token-base-units", [se(vaultKey)], { mint: identity(vault.sharesMint), decimals: vault.sharesMintDecimals });
    for (const field of ["performanceFeeBps", "managementFeeBps", "withdrawalPenaltyBps"] as const) quantity(`vault.${field}`, vaultKey, vault[field], "bps", [se(vaultKey)]);
    quantity("vault.withdrawalPenaltyLamports", vaultKey, vault.withdrawalPenaltyLamports, "lamports", [se(vaultKey)]);
    quantity("vault.unallocatedWeight", vaultKey, vault.unallocatedWeight, "weight", [se(vaultKey)]);
  }
  for (const [key, r] of decodedReserves) {
    const prefix = `reserve.${key}.`, token = { mint: identity(r.mintPubkey), decimals: r.mintDecimals }, asOfSlot = String(r.lastUpdateSlot);
    quantity(prefix + "available", key, r.totalAvailableAmount, "token-base-units", [se(key)], token);
    quantity(prefix + "borrowed", key, r.borrowedAmountSf >> 60n, "token-base-units", [se(key)], { ...token, asOfSlot });
    quantity(prefix + "protocolTakeRatePct", key, r.protocolTakeRatePct, "pct", [se(key)]);
    if (r.withdrawalCapCapacity >= 0n) quantity(prefix + "withdrawalCapCapacity", key, r.withdrawalCapCapacity, "token-base-units", [se(key)], { ...token, window: `${r.withdrawalCapIntervalSeconds}s` });
    const totalSupplySf = (r.totalAvailableAmount << 60n) + r.borrowedAmountSf - r.accumulatedProtocolFeesSf - r.accumulatedReferrerFeesSf - r.pendingReferrerFeesSf;
    if (totalSupplySf > 0n) derived(prefix + "utilizationPpm", key, r.borrowedAmountSf * 1_000_000n / totalSupplySf, "ppm", [prefix + "available", prefix + "borrowed"], { asOfSlot });
    const allocation = vault?.allocations.find(a => a.reserve === key);
    if (allocation) {
      quantity(prefix + "vaultCtokenAllocation", key, allocation.ctokenAllocation, "ctoken-base-units", [se(vaultKey)], { mint: identity(r.collateralMint), decimals: r.mintDecimals });
      quantity(prefix + "vaultTargetWeight", key, allocation.targetAllocationWeight, "weight", [se(vaultKey)]);
      const value = r.collateralMintTotalSupply === 0n ? allocation.ctokenAllocation === 0n ? 0n : null : totalSupplySf < 0n ? null : allocation.ctokenAllocation * totalSupplySf / (r.collateralMintTotalSupply << 60n);
      if (value !== null) { invested.set(key, value); derived(prefix + "vaultInvested", key, value, "token-base-units", [prefix + "vaultCtokenAllocation", prefix + "available", prefix + "borrowed"], { ...token, asOfSlot }); }
    }
  }
  if (vault && vault.allocations.every(a => invested.has(a.reserve))) {
    const investmentNames = vault.allocations.map(a => `reserve.${a.reserve}.vaultInvested`), sum = [...invested.values()].reduce((a, b) => a + b, 0n);
    const total = vault.tokenAvailable + sum - (vault.pendingFeesSf >> 60n);
    const token = { mint: identity(vault.tokenMint), decimals: vault.tokenMintDecimals };
    const borrowedSlots = vault.allocations.map(a => decodedReserves.get(a.reserve)!.lastUpdateSlot);
    const asOfSlot = borrowedSlots.length ? String(borrowedSlots.reduce((a, b) => a < b ? a : b)) : stateSlot;
    if (total > 0n) { derived("vault.totalAssets", vaultKey, total, "token-base-units", ["vault.tokenAvailable", ...investmentNames, "vault.pendingFees"], { ...token, asOfSlot }); derived("vault.idleSharePpm", vaultKey, vault.tokenAvailable * 1_000_000n / total, "ppm", ["vault.tokenAvailable", "vault.totalAssets"], { asOfSlot }); }
    if (sum > 0n) for (const a of vault.allocations) derived(`reserve.${a.reserve}.vaultAllocationPpm`, a.reserve, invested.get(a.reserve)! * 1_000_000n / sum, "ppm", investmentNames, { asOfSlot: String(decodedReserves.get(a.reserve)!.lastUpdateSlot) });
  }
  if (vault && sr.accounts.has(vault.sharesMint)) {
    try {
      const a = sr.accounts.get(vault.sharesMint), b = accountBytes(a);
      if (!a || !["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(a.owner) || b.length < 82 || b[45] !== 1 || b[44] !== vault.sharesMintDecimals) throw new Error();
      terminalStates.push({ key: vault.sharesMint, predicate: "SUPPLY_RAW", object: `amount:${b.readBigUInt64LE(36)}`, evidenceIds: [se(vault.sharesMint)] });
    } catch { gap("malformed-record", "rpc-state.json", vault.sharesMint, "Invalid shares mint", [vault.sharesMint]); }
  }

  function http(file: string, readerId: string): Record<string, unknown> | string | null {
    const r = records[file] as HttpRecord, evidenceId = receipt(file, r); httpReceipts.set(file, evidenceId);
    let data: Record<string, unknown> | string | null = null, code: GapCode | null = null;
    if (r.httpStatus === 429) code = "rate-limited";
    else if (r.httpStatus < 200 || r.httpStatus >= 300) code = "http-error";
    else if (r.headers["x-kamino-truncated"] !== undefined && r.headers["x-kamino-truncated"] !== "false") code = "malformed-record";
    else {
      try {
        if (file === "docs-liquidity.json") { if (!r.headers["content-type"]?.startsWith("text/")) throw new Error(); data = r.body; }
        else { const value: unknown = JSON.parse(r.body); if (!isObject(value)) throw new Error(); if (file === "api-vault.json" && (value.address !== vaultKey || value.programId !== KVAULT_PROGRAM || !isObject(value.state) || !Array.isArray(value.state.vaultAllocationStrategy))) throw new Error(); data = value; }
      } catch { code = "malformed-record"; }
    }
    if (code) gap(code, file, null, "HTTP response unavailable or malformed");
    readers.push({ id: readerId, status: code ? "failed" : "complete", subjects: [] }); return data;
  }
  const apiVault = http("api-vault.json", "kamino-api-vault"), metrics = http("api-metrics.json", "kamino-api-metrics"), docs = http("docs-liquidity.json", "kamino-docs");
  if (isObject(metrics)) for (const key of METRIC_KEYS) {
    const value = metrics[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) { gap("malformed-record", "api-metrics.json", null, "Metric is not an exact decimal string"); readers.find(r => r.id === "kamino-api-metrics")!.status = "failed"; continue; }
    quantity(`vault.reported.${key}`, vaultKey, value, "ratio", [httpReceipts.get("api-metrics.json")!], { basis: "reported", window: /^apy\d/.test(key) ? key.slice(3) : "current", asOfSlot: null });
  }
  const crossChecks: CrossCheck[] = [];
  if (isObject(apiVault)) {
    const apiState = apiVault.state as Record<string, unknown>;
    const reported = sorted((apiState.vaultAllocationStrategy as unknown[]).flatMap(a => isObject(a) && typeof a.reserve === "string" && isConfiguredKey(a.reserve) ? [identity(a.reserve)] : []));
    const decoded = vault ? sorted(vault.allocations.map(a => identity(a.reserve))) : [];
    const reportedAvailable = typeof apiState.tokenAvailable === "string" ? apiState.tokenAvailable : null;
    crossChecks.push({ name: "allocations", reported, decoded, agree: vault !== null && canonical(reported) === canonical(decoded) }, { name: "tokenAvailable", reported: reportedAvailable, decoded: vault?.tokenAvailable.toString() ?? null, agree: vault !== null && reportedAvailable === vault.tokenAvailable.toString() });
  }
  const mechanics = validateMechanics({ entities: [...entities.values()].sort((a, b) => cmp(a.id, b.id)), relations: relations.sort((a, b) => cmp(`${a.from}|${a.kind}|${a.to}`, `${b.from}|${b.kind}|${b.to}`)), quantities: [...quantities.values()].sort((a, b) => cmp(a.name, b.name)) });
  const times = receipts.map(r => r.observation.observedAt).sort(cmp), slots = receipts.flatMap(r => r.observation.blockOrSlot === null ? [] : [r.observation.blockOrSlot]).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const observedFrom = times[0]!, observedTo = times[times.length - 1]!;
  const facts: Fact[] = [], factKeys = new Set<string>();
  function fact(subject: string, predicate: string, object: string, evidenceIds: string[]) {
    const tuple = `${subject}|${predicate}|${object}`; if (factKeys.has(tuple)) return; factKeys.add(tuple);
    const fields: Omit<Fact, "id"> = { subject, predicate, object, basis: predicate === "CONTROLLED_BY" ? "unknown" : "decoded", status: predicate === "CONTROLLED_BY" ? "unverified" : "verified", evidenceIds: sorted(evidenceIds), path: [], validFrom: manifest.constructed ? observedFrom : null, validTo: null, privacy: "public" };
    facts.push({ id: sha256(canonical(fields)), ...fields });
  }
  for (const r of mechanics.relations) fact(r.from, r.kind, r.to, r.evidenceIds);
  for (const q of mechanics.quantities) {
    const predicate = q.name === "vault.tokenAvailable" ? "IDLE_RAW" : /^reserve\.[^.]+\.available$/.test(q.name) ? "AVAILABLE_LIQUIDITY_RAW" : /^reserve\.[^.]+\.borrowed$/.test(q.name) ? "BORROWED_RAW" : null;
    if (predicate) fact(q.subject, predicate, `amount:${q.value}`, q.evidenceIds);
  }
  for (const s of terminalStates) if (mechanics.entities.some(e => e.id === identity(s.key))) fact(identity(s.key), s.predicate, s.object, s.evidenceIds);
  const subjects = sorted([...stateSubjects, ...programSubjects, ...mechanics.entities.map(e => e.id), ...gapSubjects]);
  readers.find(r => r.id === "kamino-chain-state")!.subjects = sorted([...stateSubjects]);
  readers.find(r => r.id === "kamino-chain-programs")!.subjects = sorted([...programSubjects]);
  if (gapSubjects.size) readers.push({ id: "kamino-gaps", status: "partial", subjects: sorted([...gapSubjects]) });
  const snapshot = validateSnapshot({ version: 1, id: snapshotId, chain: "solana", network: "mainnet-beta", constructed: manifest.constructed, observedFrom, observedTo, fromBlockOrSlot: slots[0] ?? null, toBlockOrSlot: slots[slots.length - 1] ?? null, freshUntil: new Date(Date.parse(observedTo) + PUBLIC_FRESHNESS_MS).toISOString(), subjects, readers: readers.sort((a, b) => cmp(a.id, b.id)), names: Object.fromEntries(Object.entries(names).sort(([a], [b]) => cmp(a, b))), receipts: receipts.sort((a, b) => cmp(a.id, b.id)), facts: facts.sort((a, b) => cmp(a.id, b.id)) });
  const mechanisms = new Set(["VAULT_ADMIN", "ALLOCATION_ADMIN", "MARKET_OWNER", "UPGRADE_AUTHORITY", "MULTISIG_MEMBER", "CONFIG_AUTHORITY"]);
  const controllers: ControllerView[] = mechanics.entities.filter(e => e.kind === "Authority").map(e => ({ address: e.id, mechanisms: sorted(facts.filter(f => f.object === e.id && mechanisms.has(f.predicate)).map(f => f.predicate)), type: e.controllerType!, evidenceIds: e.evidenceIds }));
  const expected = [...VAULT_QUANTITIES.map(n => `vault.${n}`), ...METRIC_KEYS.map(n => `vault.reported.${n}`), ...(vault?.allocations ?? []).flatMap(a => RESERVE_QUANTITIES.map(n => `reserve.${a.reserve}.${n}`))];
  const idle = quantities.get("vault.idleSharePpm"), claim = typeof docs === "string" ? parseIdleClaim(docs) : null;
  const claims: ClaimView[] = [{ id: "kamino-docs-typical-buffer-share", claim, claimBasis: "claimed", claimEvidenceIds: [httpReceipts.get("docs-liquidity.json")!], observedQuantity: "vault.idleSharePpm", observationBasis: "derived", observationEvidenceIds: idle?.evidenceIds ?? [], ...compareIdleClaim(claim, idle?.value ?? null, (records["docs-liquidity.json"] as HttpRecord).retrievedAt, state.retrievedAt), scope: "documented typical vault, not this vault's policy" }];
  const report: KaminoReport = { version: 1, snapshotId, vault: vaultId, stateSlot, quantities: mechanics.quantities, missing: expected.filter(n => !quantities.has(n)).sort(cmp), controllers, crossChecks, claims, notCaptured: ["LendingMarket.emergencyCouncil", "LendingMarket.proposerAuthority", "VaultState.pendingAdmin", "farms"], notComputed: ["exit-capacity", "guaranteed-return", "interest-accrued-since-last-refresh"] };
  return { snapshot, mechanics, report, gaps: gaps.sort((a, b) => cmp(`${a.code}|${a.source}|${a.subject}`, `${b.code}|${b.source}|${b.subject}`)) };
}
