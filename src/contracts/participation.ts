import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { RecordingRpc } from "../chain/rpc";
import type { Evidence } from "../chain/evidence";
import { associatedTokenAccount, classifyAuthority, readMintState, listGovernances } from "../pack/classify";
import { parseTokenAccount, TOKEN_PROGRAM } from "../chain/token-layout";
import type { PackRegistry } from "../pack/build";
import type { ContractsInput, readContractsLayer } from "./marinade";
import type { IdlType, LegacyIdl } from "./idl";
import { accountDiscriminator, decodeAccountAs, toPlain } from "./decode";

export type ContractsLayer = Awaited<ReturnType<typeof readContractsLayer>>;
export type Provenance = { evidenceIds: string[]; slot: number | null; asOf: string; basis: "decoded" | "derived" | "observed" | "claimed" | "declared" };
export function provenance(evidence: Evidence[], ids = evidence.map(e => e.id), basis: Provenance["basis"] = "decoded"): Provenance {
  const selected = evidence.filter(e => ids.includes(e.id));
  return { evidenceIds: [...new Set(ids)], slot: selected.reduce<number | null>((s, e) => e.slot === null ? s : Math.max(s ?? 0, e.slot), null),
    asOf: evidence.reduce((s, e) => e.retrievedAt > s ? e.retrievedAt : s, ""), basis };
}
export const figure = <T>(value: T, p: Provenance, unit?: string) => ({ value, ...p, ...(unit ? { unit } : {}) });

/** Only a fixed-width prefix can be used as an RPC memcmp offset. */
export function fieldOffset(idl: LegacyIdl, account: string, field: string): number {
  function size(t: IdlType, depth = 0): number {
    if (depth > 128) throw new Error("recursive IDL layout");
    if (typeof t === "string") {
      const n = ({ bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, publicKey: 32 } as Record<string, number>)[t];
      if (n) return n;
    } else if ("array" in t) return size(t.array[0], depth + 1) * t.array[1];
    else if ("defined" in t) {
      const d = [...(idl.types ?? []), ...(idl.accounts ?? [])].find(d => d.name === t.defined)?.type;
      if (d?.kind === "struct") return d.fields.reduce((n, f) => n + size(f.type, depth + 1), 0);
      if (d?.kind === "enum" && d.variants.every(v => !v.fields?.length)) return 1;
    }
    throw new Error(`variable or unknown layout before ${account}.${field}`);
  }
  const d = idl.accounts?.find(a => a.name === account)?.type;
  if (d?.kind !== "struct") throw new Error(`missing struct ${account}`);
  let offset = 8;
  for (const f of d.fields) { if (f.name === field) return offset; offset += size(f.type); }
  throw new Error(`missing field ${account}.${field}`);
}
export type Lockup = { kind: { variant: string }; startTs: string | bigint; endTs: string | bigint };
export function remainingLockup(lockup: Lockup, now: bigint): bigint {
  if (lockup.kind.variant === "None") return 0n;
  const end = BigInt(lockup.endTs), start = BigInt(lockup.startTs);
  const remaining = end - (lockup.kind.variant === "Constant" ? start : now);
  return remaining > 0n ? remaining : 0n;
}
export const BUCKETS = ["none", "under 30 days", "30–180 days", "180 days–1 year", "over 1 year"] as const;
export function lockupBucket(seconds: bigint): typeof BUCKETS[number] {
  return seconds <= 0n ? BUCKETS[0] : seconds < 30n * 86400n ? BUCKETS[1] : seconds < 180n * 86400n ? BUCKETS[2] : seconds <= 365n * 86400n ? BUCKETS[3] : BUCKETS[4];
}
export type VotingConfig = { digitShift: unknown; baselineVoteWeightScaledFactor: unknown; maxExtraLockupVoteWeightScaledFactor: unknown; lockupSaturationSecs: unknown };
/** Task-supplied VSR 0.2.x formula claim; integer divisions truncate. Not a runtime instruction simulation. */
export function votingPower(amount: bigint, remaining: bigint, config: VotingConfig): bigint {
  const shift = Number(config.digitShift);
  if (!Number.isInteger(shift) || shift < -128 || shift > 127) throw new Error("unsupported digit shift");
  const shifted = shift >= 0 ? amount * 10n ** BigInt(shift) : amount / 10n ** BigInt(-shift);
  const baseline = shifted * BigInt(String(config.baselineVoteWeightScaledFactor)) / 1_000_000_000n;
  const extra = shifted * BigInt(String(config.maxExtraLockupVoteWeightScaledFactor)) / 1_000_000_000n;
  const saturation = BigInt(String(config.lockupSaturationSecs));
  if (saturation === 0n && extra > 0n) throw new Error("nonzero extra voting weight with zero saturation");
  return baseline + (saturation === 0n ? 0n : extra * (remaining < saturation ? remaining : saturation) / saturation);
}
export const ratio = (n: bigint, d: bigint): number | null => d === 0n ? null : Number(n * 1_000_000_000_000n / d) / 1_000_000_000_000;
const display = (n: bigint) => `${n / 1_000_000_000n}.${(n % 1_000_000_000n).toString().padStart(9, "0")}`;
const sum = (ns: bigint[]) => ns.reduce((a, b) => a + b, 0n);
const descending = (a: bigint, b: bigint) => a > b ? -1 : a < b ? 1 : 0;
export const PARTICIPATION_ASSUMPTIONS = [
  "VSR vault convention: associated token account of (Voter account, MNDE mint), allowing an off-curve owner. Reconciliation tests balances, token mint and owner; mismatches stay visible.",
  "Voting formula claimed from voter-stake-registry 0.2.x source (programs/voter-stake-registry/src/state/{deposit_entry,voting_mint_config,lockup}.rs); not independently fetched: digit-shift amount, baseline and extra factors / 1e9, extra weighted by min(remaining,saturation)/saturation with integer truncation. This requested duration formula is a derived estimate, not a verified simulation of Daily/Monthly vesting or executable voting instructions.",
  "Buckets use latest evidence retrievedAt in this participation run: None/expired = none; (0,30d), [30d,180d), [180d,365d], >365d. Constant uses endTs-startTs; other kinds use max(endTs-asOf,0). Year = 365 days. Registrar timeOffset is reported but not applied to the requested wall-clock estimate.",
  "Only used deposits assigned to MNDE contribute MNDE totals and vault reconciliation; all used deposits contribute voting power using their configured mint. Deposited MNDE includes unlocked deposits, so it is not all time-locked.",
  "Shares are fractions (0–1), truncated to 12 decimal places, of the mint supply recorded in this run; top-10 shares report both deposited MNDE and supply denominators. Top-20 voting share ranks by voting power.",
  "Activity is newest 25 address signatures, including failures: count / elapsed days between known oldest and newest block times; zero/unknown windows return null. No signatures or no times means unknown, not dormant. This measures address activity, not proof of successful gauge use.",
  "Referral fee units absent from IDL documentation remain unknown raw units; Pct fields indicate percent by name (claimed). Escrow NFT ownership and claimTime as a lockup end are not inferred. Separate reads are not an atomic snapshot.",
];

type DecodedRow = { address: string; value: Record<string, any>; evidenceIds: string[] };
export async function readParticipation(rpc: RecordingRpc, registry: PackRegistry, contracts: ContractsInput, layer: ContractsLayer) {
  const start = rpc.evidence.length;
  const mint = new PublicKey(registry.mints.find(m => m.id === "mnde")!.address);
  const supply = await readMintState(rpc, mint);
  if (!supply.value || supply.value.decimals !== 9) throw new Error("MNDE mint missing or decimals differ from 9");
  const getIdl = (program: string) => {
    const p = layer.programs.find(p => p.id === program);
    if (!p || p.idl.kind !== "idl") throw new Error(`participation: missing IDL ${program}`);
    return p.idl;
  };
  async function rows(program: string, account: string, extra: { memcmp: { offset: number; bytes: string } }[] = []): Promise<{ rows: DecodedRow[]; evidenceIds: string[] }> {
    const old = layer.enumerations.find(e => e.program === program && e.account === account && e.mode === "full");
    if (old?.accounts && !extra.length) return { rows: old.accounts as DecodedRow[], evidenceIds: old.evidenceIds };
    const idl = getIdl(program);
    const read = await rpc.getProgramAccounts(new PublicKey(idl.program), [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator(account)) } }, ...extra]);
    const evidenceIds = [read.evidence.id, ...idl.evidenceIds];
    return { evidenceIds, rows: read.value.map(a => {
      if (!a.account.owner.equals(new PublicKey(idl.program))) throw new Error(`${account}: unexpected owner`);
      return { address: a.pubkey.toBase58(), value: toPlain(decodeAccountAs(idl.idl, account, a.account.data).value) as Record<string, any>, evidenceIds };
    }) };
  }
  const vsrIdl = getIdl("vsr");
  const voters = await rows("vsr", "Voter", [{ memcmp: { offset: fieldOffset(vsrIdl.idl, "Voter", "registrar"), bytes: layer.registrar.address } }]);
  const vaults = new Map<string, { account: Awaited<ReturnType<RecordingRpc["getAccountInfo"]>>["value"]; evidenceId: string }>();
  for (let i = 0; i < voters.rows.length; i += 100) {
    const batch = voters.rows.slice(i, i + 100).map(v => associatedTokenAccount(new PublicKey(v.address), mint));
    const read = await rpc.getMultipleAccounts(batch);
    if (read.value.length !== batch.length) throw new Error("vault batch response length mismatch");
    batch.forEach((key, j) => vaults.set(key.toBase58(), { account: read.value[j], evidenceId: read.evidence.id }));
  }
  const groups = new Map<string, Awaited<ReturnType<typeof rows>>>();
  for (const [p, names] of [ ["escrow-relocker", ["Realm", "Gaugemeister", "Gauge", "Escrow", "GaugeVoter", "GaugeVote"]], ["directed-stake", ["Root", "VoteRecord"]], ["referral", ["GlobalState", "ReferralState"]], ["native-staking-proxy", ["Root"]] ] as const)
    for (const name of names) groups.set(`${p}.${name}`, await rows(p, name));
  const activityReads = [];
  for (const p of layer.programs.filter(p => p.idl.kind === "idl")) activityReads.push({ program: p.id, address: p.address, read: await rpc.getSignaturesForAddress(new PublicKey(p.address), 25) });
  const native = groups.get("native-staking-proxy.Root")!;
  const discovery = await listGovernances(rpc, new PublicKey(registry.governance.program), new PublicKey(registry.governance.realm));
  const context = { program: new PublicKey(registry.governance.program), governances: discovery.governances.map(g => new PublicKey(g.address)) };
  const nativeAuthorities = [];
  for (const field of ["admin", "operator", "alternateStaker"]) {
    for (const address of new Set(native.rows.map(r => String(r.value[field])))) nativeAuthorities.push({ field, address, roots: native.rows.filter(r => r.value[field] === address).map(r => r.address), classification: toPlain(await classifyAuthority(rpc, new PublicKey(address), context)) });
  }
  const state = layer.singletons.find(s => s.id === "liquid-staking-state")!;
  const liquidIdl = getIdl("liquid-staking");
  if (!contracts.enumerate.some(e => e.account === "TicketAccountData" && e.mode === "count")) throw new Error("ticket count configuration missing");
  const ticketRead = await rpc.getProgramAccounts(new PublicKey(liquidIdl.program), [
    { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("TicketAccountData")) } },
    { memcmp: { offset: fieldOffset(liquidIdl.idl, "TicketAccountData", "stateAddress"), bytes: state.address } },
  ], { offset: 0, length: 0 });
  const evidence = [...new Map([...layer.evidence, ...rpc.evidence.slice(start)].map(e => [e.id, e])).values()];
  const p = (ids: string[], basis: Provenance["basis"] = "decoded") => provenance(evidence, ids, basis);
  const all = provenance(evidence), now = BigInt(Math.floor(Date.parse(all.asOf) / 1000));
  const vIds = [...voters.evidenceIds, ...layer.registrar.evidenceIds];
  const vp = p(vIds), sp = p([...vIds, ...supply.evidenceIds], "derived");
  const amount = (n: bigint, meta = vp) => ({ raw: n.toString(), display: display(n), unit: "MNDE", ...meta });
  const kindDefinition = vsrIdl.idl.types?.find(t => t.name === "LockupKind")?.type;
  if (kindDefinition?.kind !== "enum") throw new Error("VSR LockupKind enum missing");
  const kinds = new Map<string, bigint>(kindDefinition.variants.map(v => [v.name, 0n])), buckets = new Map<string, bigint>(BUCKETS.map(b => [b, 0n]));
  let used = 0, withUsed = 0, mndeUsed = 0;
  const voterRows = voters.rows.map(v => {
    if (v.value.registrar !== layer.registrar.address) throw new Error("RPC returned a Voter from another registrar");
    const deposits = v.value.deposits.filter((d: any) => d.isUsed);
    used += deposits.length; if (deposits.length) withUsed++;
    let deposited = 0n, power = 0n;
    const depositRows = deposits.map((d: any) => {
      const config = layer.registrar.votingMints[d.votingMintConfigIdx];
      if (!config) throw new Error("invalid voting mint index");
      const raw = BigInt(d.amountDepositedNative), remaining = remainingLockup(d.lockup, now);
      const weight = votingPower(raw, remaining, config); power += weight;
      if (config.mint === mint.toBase58()) {
        deposited += raw; mndeUsed++;
        kinds.set(d.lockup.kind.variant, (kinds.get(d.lockup.kind.variant) ?? 0n) + raw);
        const bucket = lockupBucket(remaining); buckets.set(bucket, buckets.get(bucket)! + raw);
      }
      return { mint: config.mint, amountRaw: figure(raw.toString(), vp, "native token units"), lockup: { ...d.lockup, ...vp },
        remainingSeconds: figure(remaining.toString(), p(vIds, "derived")), votingPower: figure(weight.toString(), p(vIds, "derived")) };
    });
    const vaultAddress = associatedTokenAccount(new PublicKey(v.address), mint).toBase58(), vault = vaults.get(vaultAddress)!;
    let balance: bigint | null = null, reason: string | null = null;
    if (vault.account) {
      if (!vault.account.owner.equals(TOKEN_PROGRAM) || vault.account.data.length !== 165) reason = "unexpected token program or layout";
      else { const token = parseTokenAccount(vault.account.data); balance = token.amountRaw;
        if (token.mint !== mint.toBase58() || token.owner !== v.address) reason = "token mint or owner differs from assumed convention";
        else if (balance !== deposited) reason = "balance differs from deposits";
      }
    }
    return { address: v.address, voterAuthority: String(v.value.voterAuthority), amount: amount(deposited), shareOfSupply: figure(ratio(deposited, supply.value!.supplyRaw), sp),
      votingPower: figure(power.toString(), p(vIds, "derived")), deposits: depositRows,
      vault: { address: vaultAddress, balanceRaw: balance?.toString() ?? null, status: !vault.account ? "missing" : reason ? "mismatched" : "matched", reason, ...p([...vIds, vault.evidenceId], "derived") }, ...vp };
  });
  voterRows.sort((a, b) => descending(BigInt(a.amount.raw), BigInt(b.amount.raw)) || a.address.localeCompare(b.address));
  const total = sum(voterRows.map(r => BigInt(r.amount.raw))), totalPower = sum(voterRows.map(r => BigInt(r.votingPower.value)));
  const timeLocked = total - buckets.get("none")!;
  const top10 = sum(voterRows.slice(0, 10).map(r => BigInt(r.amount.raw)));
  const topPower = [...voterRows].sort((a, b) => descending(BigInt(a.votingPower.value), BigInt(b.votingPower.value))).slice(0, 20);
  const reconciliationIds = [...vIds, ...[...vaults.values()].map(v => v.evidenceId)];
  const rp = p(reconciliationIds, "derived");
  const reconciliation = { matched: figure(voterRows.filter(r => r.vault.status === "matched").length, rp), mismatched: figure(voterRows.filter(r => r.vault.status === "mismatched").length, rp),
    missing: figure(voterRows.filter(r => r.vault.status === "missing").length, rp), examples: voterRows.filter(r => r.vault.status === "mismatched").slice(0, 10).map(r => ({ voter: r.address, deposited: r.amount, ...r.vault })),
    deposits: amount(total, rp), vaultBalances: amount(sum(voterRows.map(r => BigInt(r.vault.balanceRaw ?? 0))), rp), ...rp };
  const classificationWithProvenance = (classification: any) => ({ ...classification, ...p([...classification.evidenceIds, ...discovery.evidenceIds], classification.kind === "native-treasury-pda" ? "derived" : "decoded") });
  function group(key: string) {
    const g = groups.get(key)!; const meta = p(g.evidenceIds);
    const numericFields = [...new Set(g.rows.flatMap(r => Object.keys(r.value)))].filter(name => /amount|weight|count/i.test(name) && g.rows.every(r => typeof r.value[name] === "number" || typeof r.value[name] === "string" && /^\d+$/.test(r.value[name])));
    return { count: figure(g.rows.length, meta), totals: numericFields.map(field => ({ field, ...figure(sum(g.rows.map(r => BigInt(r.value[field]))).toString(), meta, "raw IDL units") })), rows: g.rows.map(r => ({ ...r, ...meta })), ...meta };
  }
  const directed = group("directed-stake.VoteRecord");
  const targetRows = new Map<string, typeof directed.rows>();
  for (const row of directed.rows) {
    const target = String(row.value.target), existing = targetRows.get(target);
    if (existing) existing.push(row); else targetRows.set(target, [row]);
  }
  const targets = [...targetRows].map(([target, rows]) => ({ target, records: figure(rows.length, p(directed.evidenceIds)),
    totals: directed.totals.map(({ field, unit }) => ({ field, ...figure(sum(rows.map(r => BigInt(r.value[field]))).toString(), p(directed.evidenceIds), unit) })),
    ...p(directed.evidenceIds) })).sort((a, b) => b.records.value - a.records.value || a.target.localeCompare(b.target));
  const escrow = group("escrow-relocker.Escrow");
  const referral = group("referral.ReferralState");
  const activity = activityReads.map(({ program, address, read }) => {
    const times = read.value.flatMap(s => s.blockTime == null ? [] : [s.blockTime]), newest = times.length ? Math.max(...times) : null, oldest = times.length ? Math.min(...times) : null;
    const meta = p([read.evidence.id], "observed");
    return { program, address, signatures: read.value, count: figure(read.value.length, meta), newestBlockTime: figure(newest, meta), oldestBlockTime: figure(oldest, meta),
      transactionsPerDay: figure(newest !== null && oldest !== null && newest > oldest ? times.length * 86400 / (newest - oldest) : null, { ...meta, basis: "derived" }),
      dormant: figure(newest === null || read.value[0]?.blockTime == null ? null : Number(now) - newest > 30 * 86400, { ...meta, basis: "derived" }), ...meta };
  });
  const tp = p([ticketRead.evidence.id, ...state.evidenceIds, ...liquidIdl.evidenceIds]);
  return { pack: contracts.pack, ...all, assumptions: PARTICIPATION_ASSUMPTIONS, evidence,
    vsr: { voters: figure(voterRows.length, vp), votersWithUsedDeposits: figure(withUsed, vp), usedDepositEntries: figure(used, vp), mndeUsedDepositEntries: figure(mndeUsed, vp), totalDeposited: amount(total), timeLocked: amount(timeLocked, p(vIds, "derived")), timeLockedShareOfSupply: figure(ratio(timeLocked, supply.value.supplyRaw), sp), supply: amount(supply.value.supplyRaw, p(supply.evidenceIds)), shareOfSupply: figure(ratio(total, supply.value.supplyRaw), sp),
      byLockupKind: [...kinds].map(([kind, raw]) => ({ kind, ...amount(raw) })), byRemainingLockup: [...buckets].map(([bucket, raw]) => ({ bucket, ...amount(raw, p(vIds, "derived")) })),
      rows: voterRows, top20: voterRows.slice(0, 20).map(({ deposits, ...r }) => r), top10ShareOfDeposits: figure(ratio(top10, total), p(vIds, "derived")), top10ShareOfSupply: figure(ratio(top10, supply.value.supplyRaw), sp), reconciliation,
      voting: { configuration: layer.registrar.votingMints.map(c => ({ ...c, ...p(c.evidenceIds), grantAuthority: c.grantAuthority ? { ...c.grantAuthority, ...p(c.grantAuthority.evidenceIds), classification: classificationWithProvenance(c.grantAuthority.classification) } : null })), registrarTimeOffset: figure(layer.singletons.find(s => s.id === "vsr-registrar-mnde")!.value.timeOffset, p(layer.registrar.evidenceIds)), formulaSource: { value: PARTICIPATION_ASSUMPTIONS[1], ...p(vIds, "claimed") }, total: figure(totalPower.toString(), p(vIds, "derived")), top20: topPower.map(r => ({ voter: r.address, voterAuthority: r.voterAuthority, ...r.votingPower })), top20Share: figure(ratio(sum(topPower.map(r => BigInt(r.votingPower.value))), totalPower), p(vIds, "derived")) } },
    escrow: { ...escrow, totalEscrowed: figure(sum(escrow.rows.map(r => BigInt(r.value.amount))).toString(), p(escrow.evidenceIds), "raw units across all realms; not assumed MNDE"),
      owners: figure(null, p(escrow.evidenceIds), "No owner field in IDL; NFT holder not read"), lockupEnds: figure(null, p(escrow.evidenceIds), "No end field; claimTime and cooldown retained without inferred semantics"),
      lockupObservations: escrow.rows.map(r => ({ address: r.address, state: r.value.state, claimTime: figure(r.value.claimTime, p(r.evidenceIds), "raw IDL i64"), cooldown: figure(r.value.cooldown, p(r.evidenceIds), "raw IDL i64"), ...p(r.evidenceIds) })),
      byRealm: [...new Set(escrow.rows.map(r => String(r.value.realm)))].map(realm => ({ realm, amount: figure(sum(escrow.rows.filter(r => r.value.realm === realm).map(r => BigInt(r.value.amount))).toString(), p(escrow.evidenceIds)) })) },
    gauges: { realm: group("escrow-relocker.Realm"), gaugemeister: group("escrow-relocker.Gaugemeister"), gauge: group("escrow-relocker.Gauge"), voters: group("escrow-relocker.GaugeVoter"), votes: group("escrow-relocker.GaugeVote") }, activity,
    directedStake: { roots: group("directed-stake.Root"), ...directed, targets, top20Targets: targets.slice(0, 20), total: directed.count, amount: figure(null, p(directed.evidenceIds), "IDL VoteRecord has no amount or weight field") },
    referral: { global: group("referral.GlobalState"), ...referral, partners: referral.rows.map(r => ({ address: r.address, name: r.value.partnerName, partnerAccount: r.value.partnerAccount,
      fields: Object.entries(r.value).filter(([name]) => /fee|pct|amount|accum|maxNetStake/i.test(name)).map(([name, value]) => ({ name, ...figure(value, p(r.evidenceIds), /Pct$/.test(name) ? "percent (name-based claim)" : "raw IDL units; denomination/scale unverified") })), ...p(r.evidenceIds) })) },
    nativeProxy: { ...group("native-staking-proxy.Root"), authorities: nativeAuthorities.map(a => ({ ...a, classification: classificationWithProvenance(a.classification), ...p([...native.evidenceIds, ...(a.classification as any).evidenceIds]) })), fees: figure(null, p(native.evidenceIds), "Root IDL has no fee field") },
    delayedUnstake: { ticketCount: figure(ticketRead.value.length, tp), circulatingTicketCount: figure(String(state.value.circulatingTicketCount), tp), circulatingTicketBalance: figure(String(state.value.circulatingTicketBalance), tp, "lamports"), countsAgree: figure(BigInt(ticketRead.value.length) === BigInt(String(state.value.circulatingTicketCount)), { ...tp, basis: "derived" }) },
  };
}
