import { createHash } from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { RecordingRpc } from "../chain/rpc";
import { canonical, sha256, type Evidence } from "../chain/evidence";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, formatUnits } from "../chain/token-layout";
import { associatedTokenAccount, classifyAuthority, listGovernances, readTokenAccount, type AuthorityContext } from "../pack/classify";
import type { PackRegistry } from "../pack/build";
import type { TreasuryLedger } from "../pack/ledger";
import { readAuthorities, transactionInstructions } from "./authorities";
import { figure, provenance, ratio, type ContractsLayer, type Provenance, type readParticipation } from "./participation";
import { readOnChainIdl, type LegacyIdl } from "./idl";
import { decodeAccount, toPlain } from "./decode";
import { instructionInventory, normalizeName } from "./inventory";

type Participation = Awaited<ReturnType<typeof readParticipation>>;
export type DocsCapture = { retrievedAt: string; base?: string; claimSentences: { page: string; text: string }[] };
export type FlowHolders = { evidence?: Evidence[]; sourceEvidence?: { id: string; source: string; retrievedAt: string; sha256: string }[]; classifications?: { address: string; roles: { name: string; basis: string }[] }[] };
export const DESTINATION_PATTERNS = ["treasury", "fee", "partner", "beneficiary", "bond", "reserve", "leg", "vault"] as const;
export const snakeCase = (name: string) => name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
export const instructionDiscriminator = (name: string) => createHash("sha256").update(`global:${snakeCase(name)}`).digest().subarray(0, 8);
const unique = <T>(xs: T[]) => [...new Set(xs)];
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
export const STABLECOINS = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"];
export const transactionKeys = (tx: any): string[] => {
  const m = tx.transaction.message;
  return [...(m.staticAccountKeys ?? m.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])]
    .map(k => typeof k === "string" ? k : k.toBase58 ? k.toBase58() : String(k.pubkey));
};
export type TokenDelta = { account: string; mint: string; owner: string | null; ownerChanged: boolean; decimals: number; preRaw: string; postRaw: string; deltaRaw: string };
/** Missing one side represents creation/closure; missing balance arrays mean unavailable metadata. */
export function tokenDeltas(tx: any): TokenDelta[] | null {
  if (!tx?.meta || tx.meta.preTokenBalances == null || tx.meta.postTokenBalances == null) return null;
  const keys = transactionKeys(tx), before = tx.meta.preTokenBalances as any[], after = tx.meta.postTokenBalances as any[];
  return unique([...before, ...after].map(b => b.accountIndex as number)).map(index => {
    const pre = before.find(b => b.accountIndex === index), post = after.find(b => b.accountIndex === index), b = post ?? pre;
    if (!keys[index]) throw new Error("token balance references missing key");
    if (pre && post && (pre.mint !== post.mint || pre.uiTokenAmount.decimals !== post.uiTokenAmount.decimals)) throw new Error("token identity changed within transaction");
    const changed = !!(pre?.owner && post?.owner && pre.owner !== post.owner);
    const preRaw = pre?.uiTokenAmount.amount ?? "0", postRaw = post?.uiTokenAmount.amount ?? "0";
    return { account: keys[index], mint: b.mint, owner: changed ? null : post?.owner ?? pre?.owner ?? null, ownerChanged: changed,
      decimals: b.uiTokenAmount.decimals, preRaw, postRaw, deltaRaw: String(BigInt(postRaw) - BigInt(preRaw)) };
  });
}
export function attributeInstruction(tx: any, program: string, idl: LegacyIdl, account: string) {
  const parsed = transactionInstructions(tx), table = new Map(idl.instructions.map(i => [instructionDiscriminator(i.name).toString("hex"), i.name]));
  const candidates = [...parsed.top, ...parsed.inner].filter(i => i.program === program && i.accounts.includes(account))
    .map(i => ({ name: table.get(i.dataHex.slice(0, 16)) ?? "unknown discriminator", location: "parentIndex" in i ? "inner" : "top-level", index: i.index, parentIndex: "parentIndex" in i ? i.parentIndex : null }));
  // Multiple calls cannot be assigned a transaction-wide delta, even if they share a name.
  return { instruction: candidates.length === 1 ? candidates[0].name : candidates.length ? "ambiguous" : "unattributed", candidates };
}
export type TokenTransfer = { source: string; destination: string; sourceOwner: string | null; destinationOwner: string | null; mint: string | null; decimals: number | null; amountRaw: string; enclosingProgram: string | null };
export function tokenTransfers(tx: any): TokenTransfer[] {
  if (tx?.meta?.err !== null) return [];
  const deltas = tokenDeltas(tx) ?? [], parsed = transactionInstructions(tx);
  return [...parsed.top, ...parsed.inner].flatMap(ix => {
    if (![TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58()].includes(ix.program)) return [];
    const b = Buffer.from(ix.dataHex, "hex"), checked = b[0] === 12;
    if (!(b[0] === 3 && b.length === 9 || checked && b.length === 10)) return [];
    const source = ix.accounts[0], destination = ix.accounts[checked ? 2 : 1];
    if (!source || !destination) return [];
    const src = deltas.find(d => d.account === source), dst = deltas.find(d => d.account === destination);
    return [{ source, destination, sourceOwner: src?.owner ?? null, destinationOwner: dst?.owner ?? null,
      mint: checked ? ix.accounts[1] : src?.mint ?? dst?.mint ?? null, decimals: checked ? b[9] : src?.decimals ?? dst?.decimals ?? null,
      amountRaw: b.readBigUInt64LE(1).toString(), enclosingProgram: "parentIndex" in ix ? parsed.top[Number(ix.parentIndex)]?.program ?? null : ix.program }];
  });
}
export type Window = { oldestBlockTime: number | null; newestBlockTime: number | null };
export function timeWindow(times: (number | null)[]): Window {
  const known = times.filter((t): t is number => t !== null);
  return { oldestBlockTime: known.length ? Math.min(...known) : null, newestBlockTime: known.length ? Math.max(...known) : null };
}
export function compareRevenueWindows(treasury: Window, buybacks: Window, revenueRaw: bigint, spendRaw: bigint, complete: boolean, sameAsset: boolean) {
  const sameWindow = treasury.oldestBlockTime !== null && treasury.newestBlockTime !== null && treasury.newestBlockTime > treasury.oldestBlockTime &&
    treasury.oldestBlockTime === buybacks.oldestBlockTime && treasury.newestBlockTime === buybacks.newestBlockTime;
  return { status: "unresolved" as const, ratio: sameWindow && complete && sameAsset ? ratio(spendRaw, revenueRaw) : null,
    sameWindow, treasuryWindow: treasury, buybackWindow: buybacks,
    note: !sameWindow ? "Sample windows differ or are unknown; no ratio computed." : !complete ? "Sample has unavailable transactions or token metadata; no ratio computed." : !sameAsset ? "Assets differ; no price conversion established." : "Ratio covers this account sample only; total protocol revenue is not established." };
}

export function declaredRoutes(layer: ContractsLayer, participation: Participation, asOf: string) {
  const states = [...layer.singletons, ...layer.enumerations.flatMap(e => e.accounts?.map(a => ({ ...a, program: e.program })) ?? []),
    ...participation.referral.rows.map(r => ({ ...r, program: "referral" })),
    ...[...(participation.escrow?.rows ?? []), ...Object.values(participation.gauges ?? {}).flatMap(g => g.rows)].map(r => ({ ...r, program: "escrow-relocker" })),
    ...(participation.directedStake?.rows ?? []).map(r => ({ ...r, program: "directed-stake" })),
    ...(participation.nativeProxy?.rows ?? []).map(r => ({ ...r, program: "native-staking-proxy" }))];
  function fields(value: any, prefix = ""): { field: string; address: string }[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value).flatMap(([name, v]) => {
      const field = prefix + name;
      if (typeof v === "string") { try { return [{ field, address: new PublicKey(v).toBase58() }]; } catch { return []; } }
      return fields(v, `${field}.`);
    });
  }
  const stateFields = states.flatMap(s => fields(s.value).map(f => ({ program: s.program, state: s.address, ...f, basis: "decoded" as const, evidenceIds: s.evidenceIds, slot: "slot" in s ? s.slot : null, asOf })));
  const byLeaf = new Map<string, typeof stateFields>();
  for (const f of stateFields) {
    const names = [normalizeName(f.field.split(".").at(-1)!), ...(f.field === "liqPool.msolLeg" ? ["liqpoolmsolleg"] : [])];
    for (const name of names) { const rows = byLeaf.get(name) ?? []; rows.push(f); byLeaf.set(name, rows); }
  }
  return layer.programs.flatMap(program => program.inventory.instructions.map(ix => {
    const destinations = ix.accounts.filter(a => a.isMut && DESTINATION_PATTERNS.some(pattern => a.name.toLowerCase().includes(pattern))).map(a => {
      const leaf = normalizeName(a.name.split(".").at(-1)!);
      const resolutions = (byLeaf.get(leaf) ?? []).filter(s => s.program === program.id || program.id === "referral" && s.program === "liquid-staking");
      return { account: a.name, resolutions: unique(resolutions.map(r => JSON.stringify(r))).map(r => JSON.parse(r) as typeof resolutions[number]),
        status: resolutions.length ? "resolved from state" : "unresolved", basis: "declared" as const, evidenceIds: a.evidenceIds, slot: a.slot, asOf };
    });
    return { program: program.id, programAddress: program.address, instruction: ix.name, destinations,
      note: destinations.length ? "Writable name matches are declared candidates, not proof of value direction." : "no destination account declared",
      basis: "declared" as const, evidenceIds: ix.evidenceIds, slot: ix.slot, asOf };
  }));
}
const FEE_INSTRUCTIONS: Record<string, string[]> = {
  rewardFee: ["updateActive", "updateDeactivated"], delayedUnstakeFee: ["orderUnstake"], withdrawStakeAccountFee: ["withdrawStakeAccount"],
  depositSolFee: ["deposit"], depositStakeAccountFee: ["depositStakeAccount"], "liqPool.lpMinFee": ["liquidUnstake"], "liqPool.lpMaxFee": ["liquidUnstake"], "liqPool.treasuryCut": ["liquidUnstake"],
};
export function matchFeeStatements(capture: DocsCapture, parameters: ContractsLayer["parameters"]) {
  const aliases: [RegExp, string][] = [[/delayed[ -]?unstak/i, "delayedUnstakeFee"], [/withdraw[ -]?stake[ -]?account/i, "withdrawStakeAccountFee"],
    [/deposit(?:ing)?\s+SOL|SOL deposit/i, "depositSolFee"], [/deposit(?:ing)?\s+stake|stake.account deposit/i, "depositStakeAccountFee"], [/reward[_ ]?fee|(?:takes|fee).*rewards|rewards.*fee/i, "rewardFee"]];
  return capture.claimSentences.flatMap(s => s.text.split(/(?<=[.!?])\s+(?=[A-Z])|\s+(?=Delayed unstaking)/).filter(text => /\bfees?\b|reward_fee|takes.*rewards/i.test(text) && /%|\bbps\b|basis points/i.test(text)).map(text => {
    const matches = aliases.filter(([re]) => re.test(text));
    const quantities = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(%|bps|basis points)/gi)];
    const parameter = !/native|select|lending|\bif\b|used to|previously|historical/i.test(text + " " + s.page) && matches.length === 1 && quantities.length === 1 ? parameters.find(p => p.field === matches[0][1]) : undefined;
    const expectedBps = quantities.length === 1 ? Number(quantities[0][1]) * (quantities[0][2] === "%" ? 100 : 1) : null;
    const actualBps = parameter ? Number(parameter.raw) / (parameter.unit === "hundredths of a basis point" ? 100 : 1) : null;
    return { chainResult: parameter ? `Decoded ${parameter.field} = ${actualBps} basis points.` : "No unique decoded parameter match.",
      status: actualBps === null ? "unresolved" : Math.abs(actualBps - expectedBps!) < 1e-9 ? "verified" : "contradiction",
      text, page: s.page, parameter: parameter?.field ?? null, expectedBps, actualBps, evidenceIds: parameter?.evidenceIds ?? [], slot: parameter?.slot ?? null };
  }));
}
export type BuybackObservation = { signature: string; blockTime: number | null; mndeDeltaRaw: string | null; boughtRaw: string; costs: { asset: string; raw: string; decimals: number }[];
  unattributedOutflowRaw?: string; recipients: { owner: string | null; destination: string; amountRaw: string; voterAuthority: boolean }[]; evidenceIds: string[]; slot: number; asOf: string; basis: "observed" };
export function walletCosts(tx: any, wallet: string, mnde: string) {
  const deltas = tokenDeltas(tx) ?? [], amounts = new Map<string, { raw: bigint; decimals: number }>();
  for (const d of deltas.filter(d => d.owner === wallet && d.mint !== mnde)) {
    const asset = d.mint === WRAPPED_SOL ? "SOL" : d.mint, old = amounts.get(asset);
    amounts.set(asset, { raw: (old?.raw ?? 0n) + BigInt(d.deltaRaw), decimals: d.decimals });
  }
  const index = transactionKeys(tx).indexOf(wallet);
  let solDeltaRaw: string | null = null;
  if (index >= 0 && tx.meta?.preBalances?.[index] != null && tx.meta?.postBalances?.[index] != null) {
    solDeltaRaw = String(BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]));
    const fee = index === 0 ? BigInt(tx.meta.fee ?? 0) : 0n;
    amounts.set("SOL", { raw: (amounts.get("SOL")?.raw ?? 0n) + BigInt(solDeltaRaw) + fee, decimals: 9 });
  }
  return { solDeltaRaw, tokenDeltas: deltas.filter(d => d.owner === wallet && d.mint !== mnde), costs: [...amounts].filter(([, a]) => a.raw < 0n).map(([asset, a]) => ({ asset, raw: String(-a.raw), decimals: a.decimals })) };
}
export function aggregateBuybackMonths(rows: BuybackObservation[]) {
  return unique(rows.map(r => r.blockTime === null ? "unknown" : new Date(r.blockTime * 1000).toISOString().slice(0, 7))).sort().map(month => {
    const selected = rows.filter(r => (r.blockTime === null ? "unknown" : new Date(r.blockTime * 1000).toISOString().slice(0, 7)) === month);
    const meta: Provenance = { basis: "derived", slot: Math.max(...selected.map(r => r.slot)), asOf: selected.map(r => r.asOf).sort().at(-1)!, evidenceIds: unique(selected.flatMap(r => r.evidenceIds)) };
    const bought = sum(selected.map(r => BigInt(r.boughtRaw))), recipients = selected.flatMap(r => r.recipients), out = sum(recipients.map(r => BigInt(r.amountRaw))) + sum(selected.map(r => BigInt(r.unattributedOutflowRaw ?? "0")));
    return { month, ...meta, window: { ...timeWindow(selected.map(r => r.blockTime)), ...meta }, mndeBoughtRaw: figure(String(bought), meta), mndeSentOutRaw: figure(String(out), meta), unattributedOutflowRaw: figure(String(sum(selected.map(r => BigInt(r.unattributedOutflowRaw ?? "0")))), meta),
      costs: unique(selected.flatMap(r => r.costs.map(c => c.asset))).map(asset => {
        const paid = selected.filter(r => BigInt(r.boughtRaw) > 0n && r.costs.some(c => c.asset === asset)), costs = paid.flatMap(r => r.costs.filter(c => c.asset === asset));
        const raw = sum(costs.map(c => BigInt(c.raw))), denominator = sum(paid.map(r => BigInt(r.boughtRaw))), decimals = costs[0]?.decimals ?? null;
        return { asset, raw: String(raw), decimals, mndeBoughtWithAssetRaw: String(denominator), averagePricePerMnde: decimals === null || denominator === 0n ? null : Number(raw) / 10 ** decimals / (Number(denominator) / 1e9), ...meta };
      }), recipients: unique(recipients.map(r => r.owner ?? r.destination)).map(owner => ({ owner, amountRaw: String(sum(recipients.filter(r => (r.owner ?? r.destination) === owner).map(r => BigInt(r.amountRaw)))), ...meta })),
      voterAuthorityShare: figure(ratio(sum(recipients.filter(r => r.voterAuthority).map(r => BigInt(r.amountRaw))), out), meta) };
  });
}
export type FlowSampleRow = { signature: string; slot: number; blockTime: number | null; tx: any; evidenceIds: string[]; asOf: string; basis: "observed" };
export type FlowSample = { address: string; limit: number; rows: FlowSampleRow[]; evidenceIds: string[]; window: Window };

/** Decode successful program calls; transaction-wide credits are counted once per claimant. */
export function distributorInstructions(tx: any, program: string, address: string, idl: LegacyIdl, mnde: string, voters: Set<string>) {
  if (tx?.meta?.err !== null) return { instructions: [], claims: [] };
  const parsed = transactionInstructions(tx), inventory = instructionInventory(idl), deltas = tokenDeltas(tx);
  const table = new Map(inventory.map(i => [instructionDiscriminator(i.name).toString("hex"), i]));
  const instructions = [...parsed.top, ...parsed.inner].filter(i => i.program === program).map(i => {
    const declaration = table.get(i.dataHex.slice(0, 16));
    const role = declaration?.accounts.map((a, index) => ({ ...a, address: i.accounts[index] }))
      .find(a => /claimant|user|authority/i.test(a.name.split(".").at(-1)!) && a.isSigner && parsed.signers.includes(a.address));
    return { ...i, name: declaration?.name ?? null, claimant: declaration && /claim/i.test(declaration.name) ? role?.address ?? transactionKeys(tx)[0] : null,
      claimantBasis: role ? "IDL signer role and transaction signer" : "fee payer fallback", mentionsDistributor: i.accounts.includes(address) };
  });
  const calls = instructions.filter(i => i.claimant && i.mentionsDistributor);
  const claims = unique(calls.map(i => i.claimant!)).map(claimant => {
    // Other distributor calls with the same claimant make a transaction-wide delta ambiguous.
    const ambiguous = instructions.some(i => i.claimant === claimant && !i.mentionsDistributor);
    const credits = deltas?.filter(d => d.owner === claimant && d.mint === mnde && BigInt(d.deltaRaw) > 0n);
    return { claimant, voterAuthority: voters.has(claimant), calls: calls.filter(i => i.claimant === claimant).length,
      amountRaw: credits && !ambiguous ? String(sum(credits.map(d => BigInt(d.deltaRaw)))) : null,
      amountBasis: "transaction token credits to claimant; not instruction argument", ambiguous, creditedAccounts: credits?.map(d => d.account) ?? [] };
  });
  return { instructions, claims };
}
export function aggregateDistributorClaims(rows: { signature: string; claims: ReturnType<typeof distributorInstructions>["claims"] }[]) {
  const claims = rows.flatMap(row => row.claims.map(c => ({ ...c, signature: row.signature })));
  // Shared signatures across distributor samples must not double count claimant credits.
  const uniqueClaims = [...new Map(claims.map(c => [`${c.signature}:${c.claimant}`, c])).values()];
  const claimants = unique(uniqueClaims.map(c => c.claimant)), voterClaimants = unique(uniqueClaims.filter(c => c.voterAuthority).map(c => c.claimant));
  const total = sum(uniqueClaims.map(c => BigInt(c.amountRaw ?? "0"))), voterTotal = sum(uniqueClaims.filter(c => c.voterAuthority).map(c => BigInt(c.amountRaw ?? "0")));
  return { claims: claims.reduce((n, c) => n + c.calls, 0), distinctClaimants: claimants.length, voterAuthorityClaimants: voterClaimants.length,
    totalClaimedRaw: String(total), voterAuthorityClaimedRaw: String(voterTotal), claimantShare: ratio(BigInt(voterClaimants.length), BigInt(claimants.length)),
    claimedAmountShare: ratio(voterTotal, total), unavailableAmounts: uniqueClaims.filter(c => c.amountRaw === null).length };
}
function publicKeyFields(value: unknown, path = ""): { field: string; address: string }[] {
  if (value instanceof PublicKey) return [{ field: path, address: value.toBase58() }];
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return [];
  return Object.entries(value).flatMap(([key, v]) => publicKeyFields(v, path ? `${path}.${key}` : key));
}
export async function readDistributor(rpc: RecordingRpc, registry: PackRegistry, layer: ContractsLayer, context: AuthorityContext,
  address: string, program: string, mnde: string, participation: Participation, sample: (address: string, limit: number) => Promise<FlowSample>) {
  const start = rpc.evidence.length, account = await rpc.getAccountInfo(new PublicKey(address)), idl = await readOnChainIdl(rpc, new PublicKey(program));
  const history = await sample(address, 300), voters = new Set(participation.vsr.rows.map(v => v.voterAuthority));
  let decoded: ReturnType<typeof decodeAccount> | null = null;
  let reason: string | null = idl.kind === "no-idl" ? "No on-chain Anchor IDL published; semantics unresolved." : null;
  if (idl.kind === "idl") {
    if (!account.value || account.value.owner.toBase58() !== program) reason = "Recipient account missing or ownership changed.";
    else {
      try { decoded = decodeAccount(idl.idl, account.value.data); }
      catch (error) { reason = `Account decode unresolved: ${error instanceof Error ? error.message : String(error)}`; }
    }
  }
  const references = publicKeyFields(decoded?.value), authorities = [];
  const signerRoles = idl.kind === "idl" ? instructionInventory(idl.idl).flatMap(i => i.signerRoles).map(r => normalizeName(r.split(".").at(-1)!)) : [];
  const isAuthority = (field: string) => /admin|authority|owner|clawback|operator|manager/i.test(field) || signerRoles.includes(normalizeName(field.split(".").at(-1)!));
  // Classify all public-key references so unusual authority field names are not silently omitted.
  const offCurve = unique(references.filter(r => isAuthority(r.field) && !PublicKey.isOnCurve(new PublicKey(r.address).toBytes())).map(r => r.address));
  const resolutions = offCurve.length ? await readAuthorities(rpc, registry, layer, offCurve) : null;
  for (const reference of references) {
    const classification = await classifyAuthority(rpc, new PublicKey(reference.address), context);
    authorities.push({ ...reference, authorityField: isAuthority(reference.field), roleBasis: "inferred" as const,
      classification: { ...classification, amountRaw: "amountRaw" in classification ? String(classification.amountRaw) : undefined },
      resolution: resolutions?.authorities.find(a => a.address === reference.address) ?? null });
  }
  const mint = references.find(r => normalizeName(r.field) === "mint")?.address;
  const vaultFields = references.filter(r => /vault/i.test(r.field));
  // Some distributor layouts store only the mint. Keep the ATA convention explicitly derived.
  const vaultCandidates = vaultFields.length ? vaultFields.map(r => ({ ...r, basis: "decoded" as const })) : mint ?
    [{ field: "associatedTokenAccount(distributor, mint)", address: associatedTokenAccount(new PublicKey(address), new PublicKey(mint)).toBase58(), basis: "derived" as const }] : [];
  const vaults = [];
  for (const candidate of vaultCandidates) {
    const read = await readTokenAccount(rpc, new PublicKey(candidate.address));
    vaults.push({ ...candidate, balanceRaw: read.value ? String(read.value.amountRaw) : null, mint: read.value?.mint ?? null, owner: read.value?.owner ?? null,
      expectedMint: mint ?? mnde, mintMatches: read.value ? read.value.mint === (mint ?? mnde) : null,
      ownerMatches: read.value ? read.value.owner === address : null, slot: read.slot, evidenceIds: read.evidenceIds });
  }
  const transactions = history.rows.map(row => ({ signature: row.signature, blockTime: row.blockTime, slot: row.slot, asOf: row.asOf, basis: row.basis,
    evidenceIds: unique([...row.evidenceIds, ...idl.evidenceIds]), succeeded: row.tx?.meta ? row.tx.meta.err === null : null, unavailable: !row.tx,
    ...(idl.kind === "idl" ? distributorInstructions(row.tx, program, address, idl.idl, mnde, voters) : { instructions: [], claims: [] }),
    observations: row.tx?.meta?.err === null ? { tokenDeltas: tokenDeltas(row.tx), programCalls: [...transactionInstructions(row.tx).top, ...transactionInstructions(row.tx).inner].filter(i => i.program === program) } : null }));
  const ids = unique([account.evidence.id, ...idl.evidenceIds, ...history.evidenceIds, ...rpc.evidence.slice(start).map(e => e.id), ...participation.vsr.rows.flatMap(v => v.evidenceIds)]);
  const evidence = [...layer.evidence, ...participation.evidence, ...rpc.evidence];
  const meta = provenance(evidence, ids, "observed");
  return { address, program, idl, idlName: idl.kind === "idl" ? idl.idl.name : null, status: decoded ? "decoded" : "unresolved", reason, ...meta,
    account: decoded ? { ...toPlain(decoded) as Record<string, unknown>, ...provenance(evidence, [account.evidence.id, ...idl.evidenceIds], "decoded") } : null,
    authorities: authorities.map(a => ({ ...a, ...provenance(evidence, [...a.classification.evidenceIds, ...(a.resolution?.evidenceIds ?? [])], "decoded") })),
    vaults: vaults.map(v => ({ ...v, asOf: meta.asOf })), window: { ...history.window, limit: 300, ...meta }, transactions, summary: { ...aggregateDistributorClaims(transactions), ...provenance(evidence, ids, "derived") } };
}

export type FundingCredit = { asset: string; decimals: number; amountRaw: string; destination: string; sourceAccount: string | null; sourceOwner: string | null;
  attribution: string; candidates: { account: string; owner: string | null; debitRaw: string }[] };
/** Net credits are observations; a sole same-asset debit is an inferred source, never revenue. */
export function fundingCredits(tx: any, wallet: string, mnde: string, knownPurchase = false) {
  if (tx?.meta?.err !== null) return { excludedPurchase: false, credits: [] as FundingCredit[], unavailable: true };
  const deltas = tokenDeltas(tx), parsed = transactionInstructions(tx), keys = transactionKeys(tx);
  const signed = parsed.signers.includes(wallet), mndeNet = sum((deltas ?? []).filter(d => d.owner === wallet && d.mint === mnde).map(d => BigInt(d.deltaRaw)));
  const purchase = signed && (knownPurchase || mndeNet > 0n && walletCosts(tx, wallet, mnde).costs.length > 0);
  if (purchase) return { excludedPurchase: true, credits: [] as FundingCredit[], unavailable: false };
  const credits: FundingCredit[] = [], index = keys.indexOf(wallet);
  const allocate = (asset: string, decimals: number, amount: bigint, destination: string, candidates: FundingCredit["candidates"], transfers: { account: string; owner: string | null; amount: bigint }[]) => {
    const matched = transfers.filter(t => candidates.some(c => c.account === t.account));
    if (matched.length && sum(matched.map(t => t.amount)) === amount && matched.every(t => sum(matched.filter(m => m.account === t.account).map(m => m.amount)) <= BigInt(candidates.find(c => c.account === t.account)!.debitRaw))) {
      for (const t of matched) credits.push({ asset, decimals, amountRaw: String(t.amount), destination, sourceAccount: t.account, sourceOwner: t.owner, attribution: "decoded transfer reconciles net credit and source debit", candidates });
    } else {
      const source = candidates.length === 1 && BigInt(candidates[0].debitRaw) >= amount ? candidates[0] : null;
      credits.push({ asset, decimals, amountRaw: String(amount), destination, sourceAccount: source?.account ?? null, sourceOwner: source?.owner ?? null,
        attribution: source ? "inferred from sole same-asset debit" : "unresolved: source debits do not uniquely reconcile credit", candidates });
    }
  };
  const hasSol = index >= 0 && tx.meta.preBalances?.[index] != null && tx.meta.postBalances?.[index] != null;
  if (hasSol) {
    const amount = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
    if (amount > 0n) {
      const candidates = keys.flatMap((account, i) => {
        if (i === index || tx.meta.preBalances[i] == null || tx.meta.postBalances[i] == null) return [];
        // A fee-only debit is not a funding source.
        const debit = BigInt(tx.meta.preBalances[i]) - BigInt(tx.meta.postBalances[i]) - (i === 0 ? BigInt(tx.meta.fee ?? 0) : 0n);
        return debit > 0n ? [{ account, owner: account, debitRaw: String(debit) }] : [];
      });
      const transfers = [...parsed.top, ...parsed.inner].flatMap(i => {
        const b = Buffer.from(i.dataHex, "hex");
        if (i.program !== SystemProgram.programId.toBase58() || b.length < 12) return [];
        const tag = b.readUInt32LE(), destination = i.accounts[tag === 11 ? 2 : 1];
        return (tag === 2 || tag === 11) && destination === wallet ? [{ account: i.accounts[0], owner: i.accounts[0], amount: b.readBigUInt64LE(4) }] : [];
      });
      allocate("SOL", 9, amount, wallet, candidates, transfers);
    }
  }
  for (const d of (deltas ?? []).filter(d => d.owner === wallet && d.mint !== mnde && BigInt(d.deltaRaw) > 0n)) {
    const candidates = (deltas ?? []).filter(s => s.mint === d.mint && s.owner !== wallet && BigInt(s.deltaRaw) < 0n)
      .map(s => ({ account: s.account, owner: s.owner, debitRaw: String(-BigInt(s.deltaRaw)) }));
    const transfers = tokenTransfers(tx).filter(t => t.destination === d.account && t.mint === d.mint && t.sourceOwner !== wallet)
      .map(t => ({ account: t.source, owner: t.sourceOwner, amount: BigInt(t.amountRaw) }));
    allocate(d.mint, d.decimals, BigInt(d.deltaRaw), d.account, candidates, transfers);
  }
  return { excludedPurchase: false, credits, unavailable: !hasSol || deltas === null };
}
export function aggregateFunding(rows: { blockTime: number | null; credits: FundingCredit[] }[], buybackMonths: ReturnType<typeof aggregateBuybackMonths>) {
  const monthOf = (time: number | null) => time === null ? "unknown" : new Date(time * 1000).toISOString().slice(0, 7);
  const credits = rows.flatMap(r => r.credits.map(c => ({ ...c, month: monthOf(r.blockTime) })));
  const group = (selected: typeof credits) => unique(selected.map(c => JSON.stringify([c.sourceOwner ?? c.sourceAccount, c.asset, c.decimals]))).map(key => {
    const [source, asset, decimals] = JSON.parse(key) as [string | null, string, number];
    const items = selected.filter(c => (c.sourceOwner ?? c.sourceAccount) === source && c.asset === asset && c.decimals === decimals);
    return { source, asset, decimals, amountRaw: String(sum(items.map(c => BigInt(c.amountRaw)))), sourceAccounts: unique(items.flatMap(c => c.sourceAccount ? [c.sourceAccount] : [])) };
  });
  return { bySource: group(credits), months: unique([...credits.map(c => c.month), ...buybackMonths.map(m => m.month)]).sort().map(month => {
    const sources = group(credits.filter(c => c.month === month)), spent = buybackMonths.find(m => m.month === month);
    return { month, sources, solReceivedRaw: String(sum(sources.filter(c => c.asset === "SOL").map(c => BigInt(c.amountRaw)))),
      solReceivedBySource: sources.filter(c => c.asset === "SOL"), solSpentOnMndeRaw: String(sum((spent?.costs ?? []).filter(c => c.asset === "SOL").map(c => BigInt(c.raw)))) };
  }) };
}

export function assembleVerdict(routes: ReturnType<typeof declaredRoutes>, mechanisms: { parameter?: string; evidenceIds: string[] }[], claims: { id: string; status: string; chainResult: string; evidenceIds: string[] }[], offsets: unknown[], meta: Provenance, operations: { link: string; qualification: string; evidenceIds: string[] }[] = []) {
  return { enforcedByCode: routes.filter(r => r.destinations.some(d => d.resolutions.length) && mechanisms.some(m => FEE_INSTRUCTIONS[m.parameter ?? ""]?.includes(r.instruction)))
    .map(r => ({ link: `activity → ${r.instruction} → declared destination`, qualification: "IDL account declaration plus decoded state; executable enforcement not established by this reader", ...r })),
    operatedByAccounts: [{ link: "treasury → buyback wallet → recipients", qualification: "Transfers require account operation; no automatic revenue allocation or holder entitlement established", ...meta }, ...operations.map(o => ({ ...meta, ...o }))],
    unverified: claims.filter(c => c.status !== "verified").map(c => ({ claim: c.id, result: c.chainResult, ...meta, evidenceIds: c.evidenceIds })), offsets };
}

export async function readFlows(rpc: RecordingRpc, registry: PackRegistry, layer: ContractsLayer, participation: Participation, holders: FlowHolders | null, docsCapture: DocsCapture, ledger?: TreasuryLedger & { asOf?: string }) {
  const start = rpc.evidence.length;
  const discovery = await listGovernances(rpc, new PublicKey(registry.governance.program), new PublicKey(registry.governance.realm));
  const context = { program: new PublicKey(registry.governance.program), governances: discovery.governances.map(g => new PublicKey(g.address)) };
  const mnde = registry.mints.find(m => m.id === "mnde")!.address, msol = registry.mints.find(m => m.id === "msol")!.address;
  const treasuryAddress = layer.authorities.find(a => a.field === "treasuryMsolAccount")!.address;
  const treasuryAccount = await readTokenAccount(rpc, new PublicKey(treasuryAddress));
  if (!treasuryAccount.value || treasuryAccount.value.mint !== msol) throw new Error("flows: State treasury is not an mSOL token account");
  const authority = treasuryAccount.value.owner, authorityClass = await classifyAuthority(rpc, new PublicKey(authority), context);
  const buybackWallet = registry.accounts.find(a => a.id === "buyback-accumulation")!.address;
  const buybackAta = associatedTokenAccount(new PublicKey(buybackWallet), new PublicKey(mnde)).toBase58();
  const txCache = new Map<string, Awaited<ReturnType<RecordingRpc["getTransaction"]>>>();
  async function sample(address: string, limit: number) {
    const sigs = await rpc.getSignaturesForAddress(new PublicKey(address), limit), rows = [];
    for (const s of sigs.value) {
      let read = txCache.get(s.signature);
      if (!read) { read = await rpc.getTransaction(s.signature); txCache.set(s.signature, read); }
      rows.push({ signature: s.signature, slot: read.value?.slot ?? s.slot, blockTime: read.value?.blockTime ?? s.blockTime ?? null, tx: read.value,
        evidenceIds: [sigs.evidence.id, read.evidence.id], asOf: read.evidence.retrievedAt, basis: "observed" as const });
    }
    return { address, limit, rows, evidenceIds: unique([sigs.evidence.id, ...rows.flatMap(r => r.evidenceIds)]), window: timeWindow(rows.map(r => r.blockTime)) };
  }
  const treasurySample = await sample(treasuryAddress, 1000), authoritySample = await sample(authority, 200), buybackSample = await sample(buybackAta, 1000);
  const classified = new Map<string, Awaited<ReturnType<typeof classifyAuthority>>>();
  async function destination(transfer: TokenTransfer) {
    let owner = transfer.destinationOwner, ownerBasis: "observed" | "decoded" = "observed", ids: string[] = [];
    if (!owner) { const read = await readTokenAccount(rpc, new PublicKey(transfer.destination)); owner = read.value?.owner ?? null; ownerBasis = "decoded"; ids.push(...read.evidenceIds); }
    let classification = owner ? classified.get(owner) : undefined;
    if (owner && !classification) { classification = await classifyAuthority(rpc, new PublicKey(owner), context); classified.set(owner, classification); }
    ids.push(...(classification?.evidenceIds ?? []), ...discovery.evidenceIds);
    const voter = participation.vsr.rows.find(v => v.voterAuthority === owner);
    const roles = holders?.classifications?.find(c => c.address === owner)?.roles ?? [];
    const distributorRole = roles.find(r => /distribut/i.test(r.name));
    const category = voter ? "VSR voter authority" : classification?.kind === "native-treasury-pda" ? "DAO native treasury" : owner === buybackWallet ? "buyback wallet" : distributorRole ? "distributor (label only)" : classification?.kind === "program-owned" ? "program-owned; distributor unresolved" : "other";
    return { owner, ownerBasis, classification: classification ? { ...classification, amountRaw: "amountRaw" in classification ? String(classification.amountRaw) : undefined } : null,
      category, categoryBasis: voter ? "decoded" : category === "DAO native treasury" ? "derived" : owner === buybackWallet ? "claimed" : distributorRole ? distributorRole.basis : "observed", voterAuthority: !!voter, roles,
      evidenceIds: unique([...ids, ...(voter?.evidenceIds ?? []), ...(holders?.classifications?.find(c => c.address === owner)?.roles.flatMap(r => "evidenceIds" in r ? r.evidenceIds as string[] : []) ?? [])]) };
  }
  const outgoing = [];
  const buybacks: (Omit<BuybackObservation, "recipients"> & { payment: ReturnType<typeof walletCosts>; kind: string; purchaseBasis: string; topLevelPrograms: string[]; recipients: (TokenTransfer & Awaited<ReturnType<typeof destination>>)[] })[] = [];
  for (const row of authoritySample.rows) {
    if (!row.tx) continue;
    for (const transfer of tokenTransfers(row.tx).filter(t => t.sourceOwner === authority && [msol, mnde, WRAPPED_SOL, ...STABLECOINS].includes(t.mint ?? "")))
      outgoing.push({ ...transfer, destinationDetail: await destination(transfer), signature: row.signature, blockTime: row.blockTime, slot: row.slot, evidenceIds: row.evidenceIds });
  }
  for (const row of buybackSample.rows) {
    const valid = row.tx?.meta?.err === null, deltas = valid ? tokenDeltas(row.tx) : null;
    const delta = deltas?.find(d => d.account === buybackAta)?.deltaRaw ?? (deltas ? "0" : null);
    const payment = valid ? walletCosts(row.tx, buybackWallet, mnde) : { solDeltaRaw: null, tokenDeltas: [], costs: [] };
    const recipients = [];
    if (valid) for (const transfer of tokenTransfers(row.tx).filter(t => t.sourceOwner === buybackWallet && t.mint === mnde && t.destinationOwner !== buybackWallet)) {
      const detail = await destination(transfer);
      if (detail.owner !== buybackWallet) recipients.push({ ...transfer, ...detail });
    }
    const bought = delta !== null && BigInt(delta) > 0n && deltas?.find(d => d.account === buybackAta)?.owner === buybackWallet && payment.costs.length > 0;
    const netOut = delta !== null && BigInt(delta) < 0n ? -BigInt(delta) : 0n, attributedOut = sum(recipients.map(r => BigInt(r.amountRaw)));
    const unattributedOutflowRaw = String(netOut > attributedOut ? netOut - attributedOut : 0n);
    buybacks.push({ signature: row.signature, blockTime: row.blockTime, slot: row.slot, asOf: row.asOf, basis: row.basis,
      evidenceIds: unique([...row.evidenceIds, ...recipients.flatMap(r => r.evidenceIds)]), mndeDeltaRaw: delta, boughtRaw: bought ? delta! : "0", costs: bought ? payment.costs : [], payment,
      kind: delta === null ? "unavailable or failed" : BigInt(delta) > 0n ? "MNDE in" : BigInt(delta) < 0n ? "MNDE out" : "other", purchaseBasis: bought ? "MNDE credit with same-transaction wallet spend; trade intent inferred" : "no purchase established",
      recipients, unattributedOutflowRaw, topLevelPrograms: valid ? unique(transactionInstructions(row.tx).top.map(i => i.program)) : [] });
  }
  const distributors = [];
  for (const owner of unique(buybacks.flatMap(b => b.recipients).filter(r => r.classification && ["program-owned", "dao-governance-account", "squads-v4-account", "squads-v3-account"].includes(r.classification.kind)).flatMap(r => r.owner ? [r.owner] : []))) {
    const classification = classified.get(owner)!;
    distributors.push(await readDistributor(rpc, registry, layer, context, owner, classification.owner!, mnde, participation, sample));
  }
  const fundingSample = await sample(buybackWallet, 1000), fundingRows = [];
  const fundingSourceDetails = new Map<string, { address: string; classification: Awaited<ReturnType<typeof destination>>["classification"]; roles: { name: string; basis: string; evidenceIds: string[] }[]; evidenceIds: string[] }>();
  for (const row of fundingSample.rows) {
    const result = fundingCredits(row.tx, buybackWallet, mnde, buybacks.some(b => b.signature === row.signature && BigInt(b.boughtRaw) > 0n));
    for (const credit of result.credits) {
      // Missing historical token owners stay unknown; classify the debited account itself in that case.
      for (const address of unique([credit.sourceAccount, credit.sourceOwner, ...credit.candidates.flatMap(c => [c.account, c.owner])].filter((a): a is string => a !== null))) {
        const existingSource = fundingSourceDetails.get(address);
        if (existingSource) { existingSource.evidenceIds = unique([...existingSource.evidenceIds, ...row.evidenceIds]); continue; }
        const classification = await classifyAuthority(rpc, new PublicKey(address), context), roles = [];
        if (address === authority) roles.push({ name: "treasury mSOL account owner", basis: "decoded", evidenceIds: treasuryAccount.evidenceIds });
        const governance = discovery.governances.find(g => g.nativeTreasury === address);
        if (governance) roles.push({ name: "DAO native treasury", basis: "derived", evidenceIds: governance.evidenceIds });
        if (registry.accounts.some(a => a.id === "labs-treasury" && a.address === address)) roles.push({ name: "Labs treasury", basis: "claimed", evidenceIds: [`registry:${sha256(canonical(registry))}`] });
        fundingSourceDetails.set(address, { address, classification: { ...classification, amountRaw: "amountRaw" in classification ? String(classification.amountRaw) : undefined }, roles,
          evidenceIds: unique([...row.evidenceIds, ...classification.evidenceIds, ...discovery.evidenceIds, ...roles.flatMap(r => r.evidenceIds)]) });
      }
    }
    fundingRows.push({ signature: row.signature, blockTime: row.blockTime, slot: row.slot, asOf: row.asOf, basis: row.basis,
      evidenceIds: row.evidenceIds, succeeded: row.tx?.meta ? row.tx.meta.err === null : null, ...result });
  }
  const evidence = [...new Map([...layer.evidence, ...participation.evidence, ...(holders?.evidence ?? []), ...rpc.evidence.slice(start)].map(e => [e.id, e])).values()];
  const p = (ids: string[], basis: Provenance["basis"] = "observed") => provenance(evidence, ids, basis), meta = provenance(evidence, undefined, "derived");
  const registryId = `registry:${sha256(canonical(registry))}`;
  const docsId = `docs:${sha256(canonical(docsCapture))}`, ledgerId = ledger ? `ledger:${sha256(canonical(ledger))}` : null;
  const routes = declaredRoutes(layer, participation, meta.asOf);
  const mechanisms = layer.parameters.filter(param => param.field in FEE_INSTRUCTIONS).map(param => ({ parameter: param.field, parameters: [{ ...param, asOf: meta.asOf }],
    destinationQualification: "Linked accounts are IDL candidates; fee destination semantics are not proven. A fee without a named fee/treasury receiver remains unresolved.",
    routes: routes.filter(r => r.program === "liquid-staking" && FEE_INSTRUCTIONS[param.field].includes(r.instruction)), ...p(param.evidenceIds, "decoded") }));
  const referralMechanisms = participation.referral.rows.map(r => ({ partner: r.value.partnerName, state: r.address, destination: r.value.msolTokenPartnerAccount,
    parameters: participation.referral.partners.find(partner => partner.address === r.address)?.fields.filter(f => /fee/i.test(f.name)) ?? [],
    routes: routes.filter(route => route.program === "referral" && route.destinations.some(d => d.resolutions.some(s => s.state === r.address))), ...p(r.evidenceIds, "decoded") }));
  const liquid = layer.programs.find(program => program.id === "liquid-staking")!;
  if (liquid.idl.kind !== "idl") throw new Error("flows: missing liquid staking IDL");
  const idl = liquid.idl.idl;
  const treasuryRows = treasurySample.rows.map(row => {
    const deltas = row.tx?.meta?.err === null ? tokenDeltas(row.tx) : null;
    return { signature: row.signature, blockTime: row.blockTime, ...p(row.evidenceIds), slot: row.slot,
      deltaRaw: deltas?.find(d => d.account === treasuryAddress)?.deltaRaw ?? (deltas ? "0" : null),
      attribution: row.tx ? attributeInstruction(row.tx, liquid.address, idl, treasuryAddress) : { instruction: "unavailable", candidates: [] } };
  });
  const byInstruction = unique(treasuryRows.filter(r => r.deltaRaw !== null && BigInt(r.deltaRaw) !== 0n).map(r => r.attribution.instruction)).map(instruction => {
    const rows = treasuryRows.filter(r => r.attribution.instruction === instruction && r.deltaRaw !== null), amounts = rows.map(r => BigInt(r.deltaRaw!));
    const inflow = sum(amounts.filter(n => n > 0n)), outflow = -sum(amounts.filter(n => n < 0n)), pm = p(unique([...liquid.evidenceIds, ...rows.flatMap(r => r.evidenceIds)]), "derived");
    const seconds = (treasurySample.window.newestBlockTime ?? 0) - (treasurySample.window.oldestBlockTime ?? 0);
    return { instruction, inflowRaw: String(inflow), outflowRaw: String(outflow), inflowMsol: formatUnits(inflow, 9), outflowMsol: formatUnits(outflow, 9), transactions: rows.filter(r => BigInt(r.deltaRaw!) !== 0n).length,
      perDay: { inflowMsol: seconds > 0 ? Number(inflow) / 1e9 * 86400 / seconds : null, outflowMsol: seconds > 0 ? Number(outflow) / 1e9 * 86400 / seconds : null, label: "extrapolation of sampled window only", ...pm }, ...pm };
  });
  const treasury = { address: treasuryAddress, ...p(treasurySample.evidenceIds), window: { ...treasurySample.window, ...p(treasurySample.evidenceIds) },
    transactionsRequested: figure(treasurySample.rows.length, p(treasurySample.evidenceIds)), transactionsRead: figure(treasurySample.rows.filter(r => r.tx).length, p(treasurySample.evidenceIds)),
    unavailableDeltas: figure(treasuryRows.filter(r => r.deltaRaw === null).length, p(treasurySample.evidenceIds)), nonZeroTransactions: figure(treasuryRows.filter(r => r.deltaRaw !== null && BigInt(r.deltaRaw) !== 0n).length, p(treasurySample.evidenceIds)),
    inflowRaw: figure(String(sum(byInstruction.map(r => BigInt(r.inflowRaw)))), p(treasurySample.evidenceIds, "derived")), outflowRaw: figure(String(sum(byInstruction.map(r => BigInt(r.outflowRaw)))), p(treasurySample.evidenceIds, "derived")), byInstruction, transactions: treasuryRows };
  const months = aggregateBuybackMonths(buybacks);
  const fundingIds = unique([...fundingSample.evidenceIds, ...[...fundingSourceDetails.values()].flatMap(s => s.evidenceIds)]);
  const fundingMeta = p(fundingIds, "derived"), fundingTotals = aggregateFunding(fundingRows, months);
  const buybackFunding = { wallet: buybackWallet, ...fundingMeta, window: { ...fundingSample.window, limit: 1000, ...p(fundingSample.evidenceIds) },
    transactionsRequested: figure(fundingSample.rows.length, p(fundingSample.evidenceIds)), transactionsRead: figure(fundingSample.rows.filter(r => r.tx).length, p(fundingSample.evidenceIds)),
    unavailableTransactionsOrMetadata: figure(fundingRows.filter(r => r.unavailable).length, p(fundingSample.evidenceIds)),
    excludedPurchases: figure(fundingRows.filter(r => r.excludedPurchase).length, p(fundingSample.evidenceIds)),
    sources: [...fundingSourceDetails.values()].map(s => ({ ...s, ...p(s.evidenceIds, "decoded") })), transactions: fundingRows,
    bySource: fundingTotals.bySource.map(s => ({ ...s, ...fundingMeta })), months: fundingTotals.months.map(m => ({ ...m, ...p(unique([...fundingIds, ...(months.find(b => b.month === m.month)?.evidenceIds ?? [])]), "derived") })),
    comparison: "SOL received by source in the wallet sample versus SOL spent in the buyback ATA sample; partial calendar months and differing windows, not protocol revenue.",
    purchaseWindow: { ...buybackSample.window, ...p(buybackSample.evidenceIds) } };
  const distributorSummary = { ...aggregateDistributorClaims(distributors.flatMap(d => d.transactions)),
    window: timeWindow(distributors.flatMap(d => d.transactions.map(t => t.blockTime))), ...p(unique(distributors.flatMap(d => d.evidenceIds)), "derived") };

  const feeClaims = matchFeeStatements(docsCapture, layer.parameters).map(c => ({ ...c, ...p([docsId, ...c.evidenceIds], "derived"), source: `${docsCapture.base ?? ""}${c.page.replaceAll("_", "/")}` }));
  const spendMsol = sum(buybacks.flatMap(b => b.costs.filter(c => c.asset === msol).map(c => BigInt(c.raw))));
  const v5 = compareRevenueWindows(treasurySample.window, buybackSample.window, BigInt(treasury.inflowRaw.value), spendMsol,
    treasuryRows.every(r => r.deltaRaw !== null) && buybacks.every(r => r.mndeDeltaRaw !== null), buybacks.some(b => b.costs.length) && buybacks.every(b => b.costs.every(c => c.asset === msol)));
  const recipients = buybacks.flatMap(b => b.recipients), sent = sum(recipients.map(r => BigInt(r.amountRaw))) + sum(buybacks.map(b => BigInt(b.unattributedOutflowRaw ?? "0"))), voterShare = ratio(sum(recipients.filter(r => r.voterAuthority).map(r => BigInt(r.amountRaw))), sent);
  const seeds = (ledger?.entries ?? []).filter(e => e.kind === "transfer" && e.asset === mnde && e.sourceControl === "dao-controlled" && e.amountRaw !== null &&
    BigInt(e.amountRaw) >= 9_900_000n * 1_000_000_000n && BigInt(e.amountRaw) <= 10_100_000n * 1_000_000_000n);
  const contextProposals = (ledger?.proposals ?? []).filter(p => /MIP[ -]?(17|11|13)\b/i.test(p.name));
  const constants = participation.vsr.rows.flatMap(v => v.deposits).filter(d => d.mint === mnde && d.lockup.kind.variant === "Constant");
  const periods = unique(constants.map(d => d.remainingSeconds.value)).map(seconds => ({ seconds, deposits: constants.filter(d => d.remainingSeconds.value === seconds).length,
    amountRaw: String(sum(constants.filter(d => d.remainingSeconds.value === seconds).map(d => BigInt(d.amountRaw.value)))), ...p(participation.vsr.timeLocked.evidenceIds, "derived") })).sort((a, b) => b.deposits - a.deposits);
  const dominant = periods[0] && (!periods[1] || periods[0].deposits > periods[1].deposits) ? periods[0].seconds : null;
  const claims = registry.valueRouteClaims.map(c => {
    let status = "unresolved", chainResult = "No decoded revenue destination or observed collection established.", details: unknown = null, ids: string[] = [docsId, registryId];
    if (c.id === "v1") { const v = layer.claims.find(c => c.id === "v1")!; status = v.status; chainResult = v.note; ids.push(...v.evidenceIds); }
    if (c.id === "v5") { chainResult = `${v5.note} Observed funding sources: ${buybackFunding.bySource.map(s => `${s.source ?? "unresolved"} (${fundingSourceDetails.get(s.source ?? "")?.roles.map(r => `${r.name}; ${r.basis}`).join(", ") || "classified account"}): ${s.amountRaw} raw ${s.asset}`).join("; ") || "none in sample"}. No same-window protocol revenue figure established.`; details = v5; ids.push(...treasurySample.evidenceIds, ...buybackSample.evidenceIds, ...fundingIds); }
    if (c.id === "v6") { status = BigInt(distributorSummary.voterAuthorityClaimedRaw) > 0n || voterShare !== null && voterShare > 0 ? "partly" : "unresolved";
      chainResult = `${distributorSummary.voterAuthorityClaimants} of ${distributorSummary.distinctClaimants} sampled distributor claimants (${distributorSummary.claimedAmountShare === null ? "unknown" : (distributorSummary.claimedAmountShare * 100).toFixed(2)} % of observed claimed MNDE) are current VSR voter authorities; window ${distributorSummary.window.oldestBlockTime ?? "unknown"}–${distributorSummary.window.newestBlockTime ?? "unknown"} (Unix seconds). Direct recipient share: ${voterShare ?? "unknown"}. Current overlap does not establish historical eligibility, subsequent locking, or tracing of fungible bought MNDE through a funded vault.`;
      details = { share: voterShare, window: buybackSample.window, distributors: distributorSummary }; ids.push(...buybacks.flatMap(b => b.evidenceIds), ...participation.vsr.timeLocked.evidenceIds, ...distributorSummary.evidenceIds); }
    if (c.id === "v7") { status = seeds.length ? "partly" : "unresolved"; chainResult = `${seeds.length} DAO MNDE transfer candidates within 1% of 10,000,000 in B.1; pool-seed purpose requires proposal and receipt review.`; details = seeds.map(e => ({ ...e, asOf: ledger?.asOf ?? meta.asOf })); ids.push(...seeds.flatMap(e => e.evidenceIds), ...(ledgerId ? [ledgerId] : [])); }
    if (c.id === "v8") { chainResult = `${contextProposals.length} proposal names match MIP-17, MIP-11 or MIP-13; names provide claimed context, not execution semantics.`; details = contextProposals.map(proposal => ({ ...proposal, asOf: ledger?.asOf ?? meta.asOf, basis: "claimed" })); ids.push(...contextProposals.flatMap(p => p.evidenceIds), ...(ledgerId ? [ledgerId] : [])); }
    if (c.id === "v9") { status = dominant === "2592000" ? "verified" : dominant ? "contradiction" : "unresolved"; chainResult = `Dominant Constant MNDE lockup period by used deposit count: ${dominant ?? "none or tied"} seconds. This checks stored periods, not an unlock execution.`; details = periods; ids.push(...participation.vsr.timeLocked.evidenceIds); }
    return { chainResult, status, id: c.id, text: c.text, source: registry.sources[c.source] ?? c.source, details, ...p(unique(ids), "derived") };
  });
  const offsets = [{ link: "DAO treasury external outflows", assets: ledger?.summary.assets.map(a => ({ ...a, window: timeWindow(ledger.entries.filter(e => e.asset === a.asset).map(e => e.executedAt)), ...p(unique([...(ledgerId ? [ledgerId] : []), ...(ledger?.entries.filter(e => e.asset === a.asset).flatMap(e => e.evidenceIds) ?? [])]), "observed"), asOf: ledger?.asOf ?? meta.asOf, slot: ledger.entries.filter(e => e.asset === a.asset).reduce<number | null>((slot, e) => e.slot === null ? slot : Math.max(slot ?? 0, e.slot), null) })) ?? [], available: !!ledger, ...meta },
    { link: "MNDE unlock periods", periods, ...p(participation.vsr.timeLocked.evidenceIds, "derived") }];
  return { pack: registry.pack, ...meta, evidence, sourceEvidence: [...(holders?.sourceEvidence ?? []).filter(e => e.id !== registryId), { id: registryId, source: "registry labels and claims", retrievedAt: registry.retrievedAt, sha256: sha256(canonical(registry)) }, { id: docsId, source: "docs capture", retrievedAt: docsCapture.retrievedAt, sha256: sha256(canonical(docsCapture)) }, ...(ledgerId ? [{ id: ledgerId, source: "B.1 recorded treasury ledger", retrievedAt: ledger?.asOf ?? null, sha256: sha256(canonical(ledger)) }] : [])],
    destinationPatterns: DESTINATION_PATTERNS, routes, mechanisms, referralMechanisms,
    docsOnlyMechanisms: ["v2", "v3", "v4"].map(id => ({ claim: registry.valueRouteClaims.find(c => c.id === id), destination: "unresolved", ...p([docsId], "claimed") })).concat([{ claim: { id: "native", text: docsCapture.claimSentences.filter(s => /native/i.test(s.page) && /fee/i.test(s.text)).map(s => s.text).join(" "), source: "docs:marinade-native" }, destination: "unresolved", ...p([docsId], "claimed") }]),
    treasury, treasuryAuthority: { address: authority, classification: { ...authorityClass, ...p([...authorityClass.evidenceIds, ...discovery.evidenceIds], authorityClass.kind === "native-treasury-pda" ? "derived" : "decoded") }, ...p(treasuryAccount.evidenceIds, "decoded"),
      window: { ...authoritySample.window, ...p(authoritySample.evidenceIds) }, transactionsRequested: figure(authoritySample.rows.length, p(authoritySample.evidenceIds)), transactionsRead: figure(authoritySample.rows.filter(r => r.tx).length, p(authoritySample.evidenceIds)),
      transfers: outgoing.map(r => ({ ...r, ...p([...r.evidenceIds, ...r.destinationDetail.evidenceIds]), slot: r.slot,
        destinationDetail: { ...r.destinationDetail, ...p(r.destinationDetail.evidenceIds), classification: r.destinationDetail.classification ? { ...r.destinationDetail.classification, ...p(r.destinationDetail.classification.evidenceIds, r.destinationDetail.classification.kind === "native-treasury-pda" ? "derived" : "decoded") } : null } })) },
    buybacks: { wallet: buybackWallet, walletLabelBasis: "claimed", ata: buybackAta, ataBasis: "derived", ...p([...buybackSample.evidenceIds, registryId]), window: { ...buybackSample.window, ...p(buybackSample.evidenceIds) }, transactions: buybacks.map(b => ({ ...b, recipients: b.recipients.map(r => ({ ...r, ...p([...b.evidenceIds, ...r.evidenceIds]), slot: b.slot,
      classification: r.classification ? { ...r.classification, ...p(r.classification.evidenceIds, r.classification.kind === "native-treasury-pda" ? "derived" : "decoded") } : null })) })), months, voterAuthorityShare: figure(voterShare, p(unique(buybacks.flatMap(b => b.evidenceIds)), "derived")) },
    distributors, distributorSummary, buybackFunding,
    claims, feeClaims, verdict: assembleVerdict(routes, mechanisms, claims, offsets, meta, [
      ...distributors.map(d => ({ link: `buyback wallet → ${d.address} (${d.idlName ?? "IDL unresolved"}) → sampled claimants`, qualification: `Funding is an account action. ${d.summary.voterAuthorityClaimants} of ${d.summary.distinctClaimants} current-voter claimant matches; successful claim-named calls and credits are observations, not verified merkle enforcement.`, evidenceIds: d.evidenceIds })),
      { link: "funding source accounts → buyback wallet → MNDE purchases", qualification: buybackFunding.comparison, evidenceIds: unique([...fundingIds, ...buybackSample.evidenceIds]) },
    ]),
    assumptions: ["MNDE and mSOL displays use nine decimals; G3 validates MNDE and the holder reader validates both mints. FeeCents and Fee denominators follow G1.",
      "Newest 1000 treasury / buyback ATA signatures and 200 treasury authority signatures are bounded address samples, not 30 days or all protocol revenue.",
      "Recipient transfer totals are supplemented with unattributed net MNDE debits; unavailable transactions can still hide flows. Only successful transactions enter flow totals. Pruned transactions, absent metadata and failed transactions remain unavailable; no zero is substituted for missing balance arrays.",
      "A unique account-bearing Anchor call is an attribution candidate, not proof of causality. Multiple calls retain an ambiguous transaction-wide delta.",
      "SPL Transfer/TransferChecked instructions identify recipients; unsupported token extensions are not allocated. Current account owners used as fallbacks are not historical ownership proof.",
      "MNDE bought means a positive ATA delta with same-transaction wallet asset spending; funding transfers can resemble purchases. Costs are wallet net deltas, not a decoded swap quote.",
      "SOL cost nets wrapped SOL and removes the wallet's transaction fee; rent and other SOL movements can remain. Per-asset prices use only MNDE credits in transactions spending that asset; multi-asset costs are not additive prices.",
      "VSR recipient and claimant matches use current decoded voter authorities, not historical eligibility, subsequent locking, or trailing-year votes. Claim-like means an IDL name containing claim, including clawback-like names if they contain that substring.",
      "Distributor samples use newest 300 signatures; wallet funding uses newest 1000 wallet signatures. Null/failed transactions remain unavailable. No IDL means observations only.",
      "Claim amounts are positive MNDE account deltas credited to the claimant, counted once per transaction and claimant; multiple distributor calls to the same claimant are ambiguous and excluded from amount totals. Other same-transaction credits can be included.",
      "Every decoded distributor public-key reference is classified; authority/admin/owner/clawback/operator/manager names and IDL signer-role matches select off-curve G2b resolution. Field names are inferred roles, not authorization proof. A missing explicit vault uses the derived distributor/mint ATA convention with mint and owner checks.",
      "Funding excludes signed inferred MNDE purchases. SOL credits are wallet net lamport increases; fees, rent, swaps and unrelated movements can affect them. Source attribution uses reconciled transfers or a sole same-asset debit; ambiguous debits remain candidates, never allocated proportionally. Token mints remain separate, including wrapped SOL.",
      "No cross-window ratio or cross-asset valuation is computed. B.1 and docs source hashes link external evidence without relabelling it as a fresh RPC read."] };
}
