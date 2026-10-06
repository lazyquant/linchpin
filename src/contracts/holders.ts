import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import type { RecordingRpc } from "../chain/rpc";
import { canonical, sha256 } from "../chain/evidence";
import { TOKEN_PROGRAM, parseTokenAccount, formatUnits } from "../chain/token-layout";
import { listGovernances, readMintState } from "../pack/classify";
import type { PackRegistry } from "../pack/build";
import type { readAuthorities } from "./authorities";
import { tokenTransfers, timeWindow } from "./flows";
import { figure, provenance, ratio, type ContractsLayer, type Provenance, type readParticipation } from "./participation";

type Participation = Awaited<ReturnType<typeof readParticipation>>;
type Authorities = Awaited<ReturnType<typeof readAuthorities>>;
export type LabelsFile = { source: string; retrievedAt: string; labels: { address: string; label: string; category?: string }[] };
export type Role = Omit<Provenance, "basis"> & { basis: "derived" | "decoded" | "claimed" | "reported"; name: string; source?: string; retrievedAt?: string; detail?: unknown };
const unique = <T>(values: T[]) => [...new Set(values)];
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
const descending = (a: bigint, b: bigint) => a > b ? -1 : a < b ? 1 : 0;
export function validateLabels(value: unknown): LabelsFile {
  const file = value as LabelsFile;
  if (!file || typeof file.source !== "string" || !file.source || typeof file.retrievedAt !== "string" || !Number.isFinite(Date.parse(file.retrievedAt)) || !Array.isArray(file.labels)) throw new Error("Invalid labels file source, retrievedAt or labels");
  for (const label of file.labels) {
    if (typeof label.address !== "string" || typeof label.label !== "string" || !label.label || label.category !== undefined && typeof label.category !== "string") throw new Error("Invalid address label");
    new PublicKey(label.address);
  }
  return file;
}
export const rankRoles = (roles: Role[]) => [...roles].sort((a, b) => ({ derived: 0, decoded: 1, claimed: 2, reported: 3 })[a.basis] - ({ derived: 0, decoded: 1, claimed: 2, reported: 3 })[b.basis] || a.name.localeCompare(b.name));
export function classifyOwner(address: string, info: AccountInfo<Buffer> | null) {
  const onCurve = PublicKey.isOnCurve(new PublicKey(address).toBytes()), ownerProgram = info?.owner.toBase58() ?? null;
  return { address, onCurve, ownerProgram, kind: !info ? onCurve ? "wallet-no-account" : "pda-no-account" : info.owner.equals(SystemProgram.programId) ? onCurve ? "wallet" : "pda-system" : "program-owned" };
}
export type OwnerBalance = { owner: string; amountRaw: string; accounts: number; nonZeroAccounts: number };
export function decodeOwnerSlice(data: Buffer) {
  if (data.length !== 40) throw new Error(`MNDE owner+amount slice must be 40 bytes, got ${data.length}`);
  return { owner: new PublicKey(data.subarray(0, 32)).toBase58(), amountRaw: data.readBigUInt64LE(32).toString() };
}
export function decodeAmountSlice(data: Buffer) {
  if (data.length !== 8) throw new Error(`mSOL amount slice must be 8 bytes, got ${data.length}`);
  return data.readBigUInt64LE().toString();
}
export function aggregateOwners(accounts: { owner: string; amountRaw: string }[]): OwnerBalance[] {
  const owners = new Map<string, { amount: bigint; accounts: number; nonZeroAccounts: number }>();
  for (const account of accounts) {
    const n = BigInt(account.amountRaw); if (n < 0n) throw new Error("negative token balance");
    const row = owners.get(account.owner) ?? { amount: 0n, accounts: 0, nonZeroAccounts: 0 };
    row.amount += n; row.accounts++; if (n > 0n) row.nonZeroAccounts++; owners.set(account.owner, row);
  }
  return [...owners].map(([owner, r]) => ({ owner, amountRaw: String(r.amount), accounts: r.accounts, nonZeroAccounts: r.nonZeroAccounts }))
    .sort((a, b) => descending(BigInt(a.amountRaw), BigInt(b.amountRaw)) || a.owner.localeCompare(b.owner));
}
/** Population Gini over nonzero balances, with exact integer arithmetic until the final fraction. */
export function gini(values: bigint[]): number | null {
  const xs = values.filter(n => n > 0n).sort((a, b) => -descending(a, b)), total = sum(xs), n = BigInt(xs.length);
  return total === 0n ? null : ratio(2n * sum(xs.map((x, i) => BigInt(i + 1) * x)) - (n + 1n) * total, n * total);
}
export function nakamoto(values: bigint[], supply = sum(values)): number | null {
  if (supply <= 0n) return null;
  let held = 0n;
  for (const [i, amount] of [...values].sort(descending).entries()) { held += amount; if (held * 2n > supply) return i + 1; }
  return null;
}
export function histogram(values: bigint[], decimals: number) {
  const rows = new Map<number, { count: number; total: bigint }>();
  for (const raw of values.filter(n => n > 0n)) {
    // Bucket bounds are exact powers of ten in token units, including sub-token amounts.
    const exponent = raw.toString().length - 1 - decimals;
    const row = rows.get(exponent) ?? { count: 0, total: 0n }; row.count++; row.total += raw; rows.set(exponent, row);
  }
  return [...rows].sort(([a], [b]) => a - b).map(([exponent, r]) => ({ lowerInclusive: `10^${exponent}`, upperExclusive: `10^${exponent + 1}`, exponent, count: r.count, amountRaw: String(r.total) }));
}
export function floatComponents(supply: bigint, dao: bigint, vsr: bigint, escrow: bigint, labs: bigint) {
  const verifiedOnly = supply - dao - vsr - escrow;
  return { supplyRaw: String(supply), daoRaw: String(dao), vsrRaw: String(vsr), escrowRaw: String(escrow), labsClaimedRaw: String(labs),
    verifiedOnlyRaw: String(verifiedOnly), includingClaimedRaw: String(verifiedOnly - labs), nonnegative: verifiedOnly >= 0n && verifiedOnly - labs >= 0n };
}

export async function readHolders(rpc: RecordingRpc, registry: PackRegistry, layer: ContractsLayer, participation: Participation, authorities: Authorities, labels: LabelsFile[] = []) {
  labels = labels.map(validateLabels);
  const start = rpc.evidence.length, mnde = registry.mints.find(m => m.id === "mnde")!.address, msol = registry.mints.find(m => m.id === "msol")!.address;
  const mndeRead = await rpc.getProgramAccounts(TOKEN_PROGRAM, [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mnde } }], { offset: 32, length: 40 });
  const mndeSupply = await readMintState(rpc, new PublicKey(mnde));
  const msolRead = await rpc.getProgramAccounts(TOKEN_PROGRAM, [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: msol } }], { offset: 64, length: 8 });
  const msolSupply = await readMintState(rpc, new PublicKey(msol));
  if (!mndeSupply.value || !msolSupply.value || mndeSupply.value.decimals !== 9 || msolSupply.value.decimals !== 9) throw new Error("holders: expected legacy MNDE/mSOL mints with nine decimals");
  const mndeAccounts = mndeRead.value.map(a => { if (!a.account.owner.equals(TOKEN_PROGRAM)) throw new Error("holders: token enumeration owner mismatch"); return { address: a.pubkey.toBase58(), ...decodeOwnerSlice(a.account.data) }; });
  const ownerRows = aggregateOwners(mndeAccounts), nonzeroOwners = ownerRows.filter(r => BigInt(r.amountRaw) > 0n);
  const msolAmounts = msolRead.value.map(a => { if (!a.account.owner.equals(TOKEN_PROGRAM)) throw new Error("holders: token enumeration owner mismatch"); return BigInt(decodeAmountSlice(a.account.data)); });
  const largest = await rpc.getTokenLargestAccounts(new PublicKey(msol));
  const topTokens = await rpc.getMultipleAccounts(largest.value.map(a => new PublicKey(a.address)));
  if (topTokens.value.length !== largest.value.length) throw new Error("holders: largest account batch length mismatch");
  const top = largest.value.map((entry, i) => {
    const info = topTokens.value[i];
    if (info && (!info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165)) throw new Error("holders: largest mSOL account layout mismatch");
    const decoded = info ? parseTokenAccount(info.data) : null;
    if (decoded && decoded.mint !== msol) throw new Error("holders: largest mSOL account mint mismatch");
    return { ...entry, owner: decoded?.owner ?? null, currentAmountRaw: decoded ? String(decoded.amountRaw) : null, balanceDifferenceRaw: decoded ? String(decoded.amountRaw - BigInt(entry.amountRaw)) : null };
  });
  const discovery = await listGovernances(rpc, new PublicKey(registry.governance.program), new PublicKey(registry.governance.realm));
  const daoOwners = new Set(discovery.governances.map(g => g.nativeTreasury));
  const selected = nonzeroOwners.filter((r, i) => i < 50 || BigInt(r.amountRaw) * 1000n > mndeSupply.value!.supplyRaw);
  const ownerAddresses = unique([...selected.map(r => r.owner), ...top.flatMap(r => r.owner ? [r.owner] : [])]);
  const ownerInfos = new Map<string, { info: AccountInfo<Buffer> | null; evidenceIds: string[] }>();
  for (let i = 0; i < ownerAddresses.length; i += 100) {
    const batch = ownerAddresses.slice(i, i + 100), read = await rpc.getMultipleAccounts(batch.map(a => new PublicKey(a)));
    if (read.value.length !== batch.length) throw new Error("holders: owner batch length mismatch");
    batch.forEach((address, j) => ownerInfos.set(address, { info: read.value[j], evidenceIds: [read.evidence.id] }));
  }
  const observations: { account: string; programs: string[]; signatures: { signature: string; blockTime: number | null; slot: number; unavailable: boolean; programs: string[]; evidenceIds: string[] }[]; evidenceIds: string[] }[] = [];
  const txCache = new Map<string, Awaited<ReturnType<RecordingRpc["getTransaction"]>>>();
  for (const row of top) {
    if (!row.owner || classifyOwner(row.owner, ownerInfos.get(row.owner)!.info).kind !== "pda-no-account") continue;
    const sigs = await rpc.getSignaturesForAddress(new PublicKey(row.address), 10), signatures = [];
    for (const sig of sigs.value) {
      let read = txCache.get(sig.signature); if (!read) { read = await rpc.getTransaction(sig.signature); txCache.set(sig.signature, read); }
      const programs = read.value ? unique(tokenTransfers(read.value).filter(t => t.source === row.address && BigInt(t.amountRaw) > 0n).flatMap(t => t.enclosingProgram ? [t.enclosingProgram] : [])) : [];
      signatures.push({ signature: sig.signature, blockTime: read.value?.blockTime ?? sig.blockTime ?? null, slot: read.value?.slot ?? sig.slot, unavailable: !read.value, programs, evidenceIds: [sigs.evidence.id, read.evidence.id] });
    }
    observations.push({ account: row.address, programs: unique(signatures.flatMap(s => s.programs)), signatures, evidenceIds: unique([sigs.evidence.id, ...signatures.flatMap(s => s.evidenceIds)]) });
  }
  const evidence = [...new Map([...layer.evidence, ...participation.evidence, ...authorities.evidence, ...rpc.evidence.slice(start)].map(e => [e.id, e])).values()];
  const p = <B extends Provenance["basis"] = "decoded">(ids: string[], basis: B = "decoded" as B) => ({ ...provenance(evidence, ids, basis), basis });
  const meta = provenance(evidence, undefined, "derived");
  const registryId = `registry:${sha256(canonical(registry))}`;
  const sourceEvidence = [{ id: registryId, source: "registry docs labels", retrievedAt: registry.retrievedAt, sha256: sha256(canonical(registry)) },
    ...labels.map(file => ({ id: `labels:${sha256(canonical(file))}`, source: file.source, retrievedAt: file.retrievedAt, sha256: sha256(canonical(file)) }))];
  const labelsFor = (address: string): Role[] => labels.flatMap(file => file.labels.filter(l => l.address === address).map(l => ({ name: l.label, detail: l.category ?? null, source: file.source, retrievedAt: file.retrievedAt,
    ...p([`labels:${sha256(canonical(file))}`]), basis: "reported" as const })));
  const accountsByAddress = new Map(mndeAccounts.map(a => [a.address, a]));
  const mndeRealms = new Set(participation.gauges.realm.rows.filter(r => r.value.govMint === mnde).map(r => r.address));
  const escrowRows = participation.escrow.rows.filter(r => mndeRealms.has(String(r.value.realm)));
  const escrowVaults = unique(escrowRows.map(r => String(r.value.vault))).map(address => ({ address, token: accountsByAddress.get(address) }));
  const rolesFor = (address: string): Role[] => {
    const roles: Role[] = [];
    const governance = discovery.governances.find(g => g.nativeTreasury === address);
    if (governance) roles.push({ name: "DAO native treasury", detail: { governance: governance.address }, ...p(governance.evidenceIds, "derived") });
    for (const id of ["labs-treasury", "buyback-accumulation"]) {
      const label = registry.accounts.find(a => a.id === id && a.address === address);
      if (label) roles.push({ name: id === "labs-treasury" ? "Labs treasury" : "buyback wallet", source: registry.sources["docs:the-mnde-token"], retrievedAt: registry.retrievedAt, ...p([registryId], "claimed") });
    }
    const voter = participation.vsr.rows.find(v => v.address === address);
    if (voter) roles.push({ name: "VSR voter account", detail: { voterAuthority: voter.voterAuthority, lockupKinds: unique(voter.deposits.map((d: { lockup: { kind: { variant: string } } }) => d.lockup.kind.variant)) }, ...p(voter.evidenceIds, "decoded") });
    const escrows = escrowRows.filter(r => r.address === address || accountsByAddress.get(String(r.value.vault))?.owner === address);
    if (escrows.length) roles.push({ name: "escrow relocker account", detail: { escrows: escrows.map(r => r.address) }, ...p(unique([mndeRead.evidence.id, ...escrows.flatMap(r => r.evidenceIds)]), "decoded") });
    const resolved = authorities.authorities.find(a => a.address === address && a.status === "resolved");
    if (resolved) roles.push({ name: "resolved authority", detail: resolved.resolutions.filter(r => r.status === "resolved"), ...p(resolved.evidenceIds, "derived") });
    return rankRoles([...roles, ...labelsFor(address)]);
  };
  const classifications = ownerAddresses.map(address => {
    const record = ownerInfos.get(address)!, roles = rolesFor(address);
    return { ...classifyOwner(address, record.info), roles, roleName: roles[0]?.name ?? null, ...p(record.evidenceIds) };
  });
  const byOwner = new Map(classifications.map(c => [c.address, c]));
  const tokenRoles = (address: string): Role[] => [...layer.authorities.filter(a => a.address === address && ["liqPool.msolLeg", "treasuryMsolAccount"].includes(a.field))
    .map(a => ({ name: a.field === "liqPool.msolLeg" ? "LP mSOL leg" : "treasury mSOL account", ...p(a.evidenceIds, "derived") })), ...labelsFor(address)];
  const mp = p([mndeRead.evidence.id, ...mndeSupply.evidenceIds], "derived"), sp = p([msolRead.evidence.id, ...msolSupply.evidenceIds], "derived");
  const stats = (values: bigint[], supply: bigint, provenance: Provenance) => {
    const sorted = values.filter(n => n > 0n).sort(descending), total = sum(values);
    return { nonZero: figure(sorted.length, provenance), totalRaw: figure(String(total), provenance), supplyRaw: figure(String(supply), provenance), differenceFromSupplyRaw: figure(String(total - supply), provenance),
      topShares: [10, 100, 1000].map(n => ({ n, share: ratio(sum(sorted.slice(0, n)), supply), amountRaw: String(sum(sorted.slice(0, n))), ...provenance })),
      gini: figure(gini(sorted), provenance) };
  };
  const mndeStats = stats(nonzeroOwners.map(r => BigInt(r.amountRaw)), mndeSupply.value.supplyRaw, mp);
  const allVsrOwners = new Set(participation.vsr.rows.map(v => v.address)), allEscrowVaults = new Set(escrowVaults.map(v => v.address));
  // Categories are disjoint in the float: DAO, then VSR custody, then escrow, then Labs.
  const dao = sum(mndeAccounts.filter(a => daoOwners.has(a.owner)).map(a => BigInt(a.amountRaw)));
  const reconciliation = participation.vsr.reconciliation;
  const fullyReconciled = reconciliation.missing.value === 0 && reconciliation.mismatched.value === 0;
  const vsrDecoded = BigInt(fullyReconciled ? reconciliation.vaultBalances.raw : participation.vsr.totalDeposited.raw);
  const vsrDaoOverlap = sum(participation.vsr.rows.filter(v => daoOwners.has(v.address)).map(v => BigInt(v.amount.raw)));
  const vsr = vsrDecoded - vsrDaoOverlap;
  const escrow = sum(mndeAccounts.filter(a => allEscrowVaults.has(a.address) && !daoOwners.has(a.owner) && !allVsrOwners.has(a.owner)).map(a => BigInt(a.amountRaw)));
  const labsAddress = registry.accounts.find(a => a.id === "labs-treasury")?.address;
  const labs = sum(mndeAccounts.filter(a => a.owner === labsAddress && !daoOwners.has(a.owner) && !allVsrOwners.has(a.owner) && !allEscrowVaults.has(a.address)).map(a => BigInt(a.amountRaw)));
  const fp = p(unique([...mp.evidenceIds, ...discovery.evidenceIds, ...reconciliation.evidenceIds, ...participation.escrow.evidenceIds, ...participation.gauges.realm.evidenceIds]), "derived");
  const floats = floatComponents(mndeSupply.value.supplyRaw, dao, vsr, escrow, labs);
  const float = { name: "liquid float (derived)", ...fp,
    components: [ { name: "supply", raw: floats.supplyRaw, ...p(mndeSupply.evidenceIds) }, { name: "DAO-controlled", raw: floats.daoRaw, ...p([mndeRead.evidence.id, ...discovery.evidenceIds], "derived") },
      { name: "VSR custody", raw: floats.vsrRaw, method: fullyReconciled ? "G3 reconciled vault total" : "G3 decoded deposited total; vault reconciliation incomplete", ...p(reconciliation.evidenceIds, "derived") },
      { name: "escrow MNDE vault balances", raw: floats.escrowRaw, ...p([mndeRead.evidence.id, ...participation.escrow.evidenceIds, ...participation.gauges.realm.evidenceIds], "derived") },
      { name: "Labs treasury (claimed label)", raw: floats.labsClaimedRaw, ...p([mndeRead.evidence.id, registryId], "claimed") } ],
    verifiedOnly: { raw: floats.verifiedOnlyRaw, display: formatUnits(BigInt(floats.verifiedOnlyRaw), 9), ...fp },
    includingClaimed: { raw: floats.includingClaimedRaw, display: formatUnits(BigInt(floats.includingClaimedRaw), 9), ...p([...fp.evidenceIds, registryId], "derived"), includesClaimedLabel: true },
    nonnegative: figure(floats.nonnegative, fp), vsrReconciled: figure(fullyReconciled, fp), timeLockedMnde: participation.vsr.timeLocked,
    escrowCoverage: { decodedEscrows: escrowRows.length, uniqueVaults: escrowVaults.length, vaultsInMintEnumeration: escrowVaults.filter(v => v.token).length, missingVaults: escrowVaults.filter(v => !v.token).map(v => v.address), ...fp },
    notes: ["VSR custody includes used deposits that are unlocked; timeLockedMnde is shown separately. This remainder measures custody exclusions, not market liquidity.",
      "Escrow stored amounts can survive exit; only balances in MNDE token accounts named by decoded escrows of MNDE realms are subtracted.",
      "Exclusions are disjoint: DAO, VSR, escrow, Labs. Missing vaults, mismatched slots and negative remainders are reported, never clamped."] };
  const top20 = top.map(row => ({ ...row, roles: rankRoles(tokenRoles(row.address)), classification: row.owner ? byOwner.get(row.owner)! : null,
    shareOfSupply: ratio(BigInt(row.amountRaw), msolSupply.value!.supplyRaw), ...p([largest.evidence.id, topTokens.evidence.id, ...msolSupply.evidenceIds], "derived") }));
  const dependencies = new Map<string, { program: string | null; entity: string; accounts: typeof top20; evidenceIds: string[]; basis: "decoded" | "observed" | "derived" }>();
  for (const row of top20) {
    const c = row.classification, observation = observations.find(o => o.account === row.address);
    const programs = c?.kind === "program-owned" ? [c.ownerProgram!] : observation?.programs ?? [];
    const entities = programs.length ? programs : [row.owner ?? row.address];
    for (const entity of entities) {
      const group = dependencies.get(entity) ?? { program: programs.length ? entity : null, entity, accounts: [], evidenceIds: [], basis: c?.kind === "program-owned" ? "decoded" : programs.length ? "observed" : "derived" };
      group.accounts.push(row); group.evidenceIds.push(...row.evidenceIds, ...(c?.evidenceIds ?? []), ...(observation?.evidenceIds ?? [])); dependencies.set(entity, group);
    }
  }
  const downstream = [...dependencies.values()].map(group => ({ program: group.program, entity: group.entity, labels: labelsFor(group.entity),
    label: labelsFor(group.entity)[0] ?? null, msolHeldRaw: String(sum(group.accounts.map(a => BigInt(a.amountRaw)))), msolHeld: formatUnits(sum(group.accounts.map(a => BigInt(a.amountRaw))), 9),
    shareOfSupply: ratio(sum(group.accounts.map(a => BigInt(a.amountRaw))), msolSupply.value!.supplyRaw), accounts: group.accounts.map(a => a.address),
    ...p(unique(group.evidenceIds), group.basis) }));
  const readSlots = evidence.flatMap(e => e.slot === null ? [] : [e.slot]);
  return { pack: registry.pack, ...meta, evidence, sourceEvidence, asOfSlotRange: readSlots.length ? [Math.min(...readSlots), Math.max(...readSlots)] : [null, null], classifications,
    mnde: { unit: "owner balances", ...mp, accounts: figure(mndeAccounts.length, p([mndeRead.evidence.id])), nonZeroAccounts: figure(mndeAccounts.filter(a => BigInt(a.amountRaw) > 0n).length, p([mndeRead.evidence.id])), distinctNonZeroOwners: figure(nonzeroOwners.length, mp),
      ...mndeStats, enumerationSlot: mndeRead.evidence.slot, supplySlot: mndeSupply.slot, nakamotoCoefficient: figure(nakamoto(nonzeroOwners.map(r => BigInt(r.amountRaw)), mndeSupply.value.supplyRaw), mp),
      histogram: histogram(nonzeroOwners.map(r => BigInt(r.amountRaw)), 9).map(r => ({ ...r, ...mp })),
      owners: ownerRows.map(r => ({ ...r, shareOfSupply: ratio(BigInt(r.amountRaw), mndeSupply.value!.supplyRaw), ...mp })),
      topOwners: selected.map(r => ({ ...r, classification: byOwner.get(r.owner)!, shareOfSupply: ratio(BigInt(r.amountRaw), mndeSupply.value!.supplyRaw), ...mp })) },
    float, msol: { unit: "token-account balances", ...sp, accounts: figure(msolAmounts.length, p([msolRead.evidence.id])), ...stats(msolAmounts, msolSupply.value.supplyRaw, sp), enumerationSlot: msolRead.evidence.slot, supplySlot: msolSupply.slot, top20 },
    downstream, downstreamObservations: observations.map(o => ({ ...o, ...p(o.evidenceIds, "observed"), window: { ...timeWindow(o.signatures.map(s => s.blockTime)), ...p(o.evidenceIds, "observed") }, signatures: o.signatures.map(s => ({ ...s, ...p(s.evidenceIds, "observed"), slot: s.slot })) })),
    assumptions: ["Legacy SPL Token only. Full mint enumerations use dataSize 165 and mint memcmp offset zero. MNDE slice is owner+amount; mSOL slice is amount only. Recorder compression does not change fixture keys.",
      "Supply and accounts are separate RPC reads in this run; differenceFromSupplyRaw and slot spread report disagreement. Shares use recorded mint supply, not the enumerated total.",
      "MNDE concentration, Gini and histogram use aggregated nonzero owners. mSOL statistics use nonzero token accounts, not owners. Gini is population Gini; Nakamoto requires strictly more than 50% of mint supply.",
      "Roles are ordered derived > decoded > claimed > reported, retaining every label. Third-party labels keep their source and retrieval date; they do not establish control or identity.",
      "Downstream coverage is top 20 mSOL token accounts. Owning programs are decoded; top-level programs moving tokens out of account-less PDAs are bounded observations, not controller proof.",
      "An account observed under multiple programs appears in each program group; group holdings overlap and must not be summed. Unknown owners and empty/failed transaction samples remain unassigned.",
      "The verified-only float excludes no claimed labels, but is a derived custody remainder with G3 reconciliation and slot caveats; it is not a verified market-liquidity estimate."] };
}
