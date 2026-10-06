import { PublicKey, type Connection, type GetProgramAccountsConfig, type AccountInfo } from "@solana/web3.js";
import { getGovernanceAccounts, getNativeTreasuryAddress, GovernanceAccountParser, Proposal, ProposalState, pubkeyFilter } from "@solana/spl-governance";
import type { RecordingRpc } from "../chain/rpc";
import type { Evidence } from "../chain/evidence";
import { formatUnits } from "../chain/token-layout";
import { readProposalBundle, type ProposalBundle } from "../governance/reader";
import { decodeInstruction, type Decoded } from "../governance/decode";
import { effectsFromDecoded } from "../governance/effects";
import { findExecutionReceipt, type Receipt, type Reconciliation } from "../governance/receipt";
import { classifyAuthority, listGovernances, readMintState } from "./classify";

export type LedgerProposal = {
  governance: string; proposal: string; name: string; state: number; stateName: string;
  votingCompletedAt: number | null; executingAt: number | null;
  options: { instructionsCount: number }[]; slot: number | null; evidenceIds: string[];
};
export type ProposalDisposition = "payload" | "no executable payload" | "not executed";
export function proposalDisposition(proposal: Pick<LedgerProposal, "options" | "state">): ProposalDisposition {
  if (!proposal.options.some(o => o.instructionsCount > 0)) return "no executable payload";
  return [ProposalState.Completed, ProposalState.Executing, ProposalState.Succeeded].includes(proposal.state) ? "payload" : "not executed";
}

export async function listRealmProposals(rpc: RecordingRpc, programId: PublicKey, realm: PublicKey): Promise<LedgerProposal[]> {
  const discovery = await listGovernances(rpc, programId, realm);
  const proposals: LedgerProposal[] = [];
  for (const governance of discovery.governances) {
    const captured = new Map<string, { pubkey: PublicKey; account: AccountInfo<Buffer>; evidence: Evidence }>();
    const connection = {
      commitment: "confirmed",
      getProgramAccounts: async (program: PublicKey, config: GetProgramAccountsConfig) => {
        const result = await rpc.getProgramAccounts(program, config.filters ?? []);
        for (const entry of result.value) captured.set(entry.pubkey.toBase58(), { ...entry, evidence: result.evidence });
        return result.value;
      },
    } as unknown as Connection;
    await getGovernanceAccounts(connection, programId, Proposal, [pubkeyFilter(1, new PublicKey(governance.address))!]);
    // Parse captured accounts explicitly: malformed data must not silently disappear
    // through the SDK's bulk parser, which skips deserialization errors.
    for (const { pubkey, account, evidence } of captured.values()) {
      if (!account.owner.equals(programId)) throw new Error(`ledger: unexpected proposal owner for ${pubkey}`);
      const p = GovernanceAccountParser(Proposal)(pubkey, account).account as Proposal;
      if (p.governance.toBase58() !== governance.address) throw new Error(`ledger: proposal governance mismatch for ${pubkey}`);
      proposals.push({ governance: governance.address, proposal: pubkey.toBase58(), name: p.name, state: p.state,
        stateName: ProposalState[p.state], votingCompletedAt: p.votingCompletedAt == null ? null : Number(p.votingCompletedAt.toString()),
        executingAt: p.executingAt == null ? null : Number(p.executingAt.toString()),
        options: (p.options ?? []).map(o => ({ instructionsCount: o.instructionsCount })), slot: evidence.slot,
        evidenceIds: [...governance.evidenceIds, evidence.id] });
    }
  }
  return proposals.sort((a, b) => a.proposal.localeCompare(b.proposal));
}

export type OwnerControl = "dao-controlled" | "external" | "unknown";
export type LedgerCategory = "governance" | "program-upgrade" | "marinade" | "token-other" | "other";
export type LedgerReconciliation = Reconciliation["status"] | `matched (aggregate of ${number})`;
export function ledgerCategory(program: string): LedgerCategory {
  if (["GovER5L", "GovMaiH"].some(prefix => program.startsWith(prefix))) return "governance";
  if (program === "BPFLoaderUpgradeab1e11111111111111111111111") return "program-upgrade";
  if (["MarBms", "mnspJQ", "dstK1P", "tovt1V", "Ligadc", "VoteMB", "vBoNdE"].some(prefix => program.startsWith(prefix))) return "marinade";
  if (program.startsWith("TokenkegQ")) return "token-other";
  return "other";
}
export function classifyLedgerOwner(owner: string | null, daoOwners: readonly string[]): OwnerControl {
  return owner == null ? "unknown" : daoOwners.includes(owner) ? "dao-controlled" : "external";
}
export type LedgerEntry = {
  proposal: string; proposalName: string; governance: string; txAddress: string; optionIndex: number; txIndex: number; ixIndex: number;
  kind: Decoded["kind"]; programId: string; category: LedgerCategory | null; instructionLabel: string; upgradeProgram: string | null;
  asset: string | null; amountRaw: string | null; amountDisplay: string | null; decimals: number | null;
  source: string | null; sourceOwner: string | null; destination: string | null; destinationOwner: string | null;
  sourceControl: OwnerControl; destinationControl: OwnerControl;
  executedAt: number | null; receiptSignature: string | null; receiptSlot: number | null; slot: number | null;
  observedDeltaRaw: string | null; aggregateExpectedDeltaRaw: string | null; aggregateCount: number;
  reconciliation: LedgerReconciliation; basis: "decoded" | "observed"; evidenceIds: string[]; slots: number[]; notes: string[];
};
const unique = <T>(values: T[]) => [...new Set(values)];
const display = (amount: bigint, decimals: number | null) => decimals == null ? `${amount} raw (decimals unknown)` : formatUnits(amount, decimals);
const isMatched = (entry: LedgerEntry) => entry.reconciliation === "matched" || entry.reconciliation.startsWith("matched (aggregate of ");

/** Compare receipt-wide account deltas, including credits to a debited account.
 * Group by signature, not proposal transaction account: one execution can contain several.
 * Never allocate an aggregate observed delta to individual instructions. */
export function reconcileLedgerEntries(entries: LedgerEntry[], receipts: Receipt[]): void {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) if (entry.receiptSignature && entry.executedAt != null) {
    const group = groups.get(entry.receiptSignature) ?? [];
    group.push(entry); groups.set(entry.receiptSignature, group);
  }
  for (const [signature, group] of groups) {
    const receipt = receipts.find(r => r.signature === signature);
    if (!receipt) continue;
    const deltas = (e: LedgerEntry): [string, bigint][] => {
      const amount = BigInt(e.amountRaw ?? "0");
      return e.kind === "burn" && e.source ? [[e.source, -amount]]
        : e.kind === "transfer" && e.source && e.destination ? [[e.source, -amount], [e.destination, amount]]
        : e.kind === "mintTo" && e.destination ? [[e.destination, amount]] : [];
    };
    const totals = new Map<string, { amount: bigint; entries: Set<LedgerEntry> }>();
    for (const e of group) for (const [account, amount] of deltas(e)) {
      const key = `${e.asset}:${account}`;
      const total = totals.get(key) ?? { amount: 0n, entries: new Set<LedgerEntry>() };
      total.amount += amount; total.entries.add(e); totals.set(key, total);
    }
    for (const e of group) {
      const movements = deltas(e);
      const primary = movements[0]?.[0];
      e.observedDeltaRaw = receipt.tokenBalances.find(b => b.account === primary && b.mint === e.asset)?.deltaRaw ?? null;
      e.aggregateExpectedDeltaRaw = primary ? String(totals.get(`${e.asset}:${primary}`)!.amount) : null;
      let aggregateCount = 1;
      const matched = movements.length > 0 && receipt.success && receipt.innerPrograms.includes(e.programId) && movements.every(([account, amount]) => {
        const balance = receipt.tokenBalances.find(b => b.account === account && b.mint === e.asset);
        if (!balance) return false;
        const observed = BigInt(balance.deltaRaw);
        const total = totals.get(`${e.asset}:${account}`)!;
        if (observed === amount) return true;
        if (observed !== total.amount) return false;
        aggregateCount = Math.max(aggregateCount, total.entries.size);
        return true;
      });
      e.aggregateCount = matched ? aggregateCount : 0;
      e.reconciliation = !movements.length ? "not-reconcilable" : !matched ? "mismatch"
        : aggregateCount > 1 ? `matched (aggregate of ${aggregateCount})` : "matched";
      e.basis = matched ? "observed" : "decoded";
      if (matched && aggregateCount > 1) {
        e.evidenceIds = unique([...e.evidenceIds, ...group.flatMap(row => row.evidenceIds)]);
        e.slots = unique([...e.slots, ...group.flatMap(row => row.slots)]);
      }
    }
  }
}

/** One row per instruction, including unsupported and unexecuted payloads. */
export function ledgerEntriesFromBundle(bundle: ProposalBundle, receipts: Receipt[], daoOwners: string[] = [bundle.governance.nativeTreasury, bundle.governance.address]): LedgerEntry[] {
  const entries = bundle.transactions.flatMap((tx, txIndex) => {
    const decoded = tx.instructions.map(decodeInstruction);
    const effects = effectsFromDecoded(decoded.map((decoded, ixIndex) => ({ txIndex, ixIndex, decoded })), bundle, { nativeTreasury: bundle.governance.nativeTreasury });
    const receipt = receipts.find(r => r.proposalTransaction === tx.address) ?? null;
    return decoded.map((d, ixIndex): LedgerEntry => {
      const source = d.kind === "burn" || d.kind === "transfer" ? d.source : d.kind === "setAuthority" ? d.target : d.kind === "createAccount" ? d.payer : null;
      const destination = d.kind === "transfer" || d.kind === "mintTo" ? d.destination : d.kind === "createAccount" ? d.account : null;
      const src = source ? bundle.tokenAccounts[source] : undefined;
      const dst = destination ? bundle.tokenAccounts[destination] : undefined;
      const observedSource = receipt?.tokenBalances.find(b => b.account === source);
      const observedDestination = receipt?.tokenBalances.find(b => b.account === destination);
      const effect = effects.find(e => e.id === `fx-${txIndex}-${ixIndex}-move`);
      const asset = "mint" in d ? d.mint ?? observedSource?.mint ?? src?.mint ?? (effect?.detail.asset as string | null) ?? observedDestination?.mint ?? dst?.mint ?? null : src?.mint ?? null;
      const mint = asset ? bundle.mints[asset] : undefined;
      const decimals = mint?.decimals ?? null;
      const amount = "amountRaw" in d ? d.amountRaw : null;
      const sourceOwner = observedSource?.owner ?? src?.owner ?? null;
      const destinationOwner = observedDestination?.owner ?? dst?.owner ?? (d.kind === "createAccount" ? d.owner : null);
      const category = d.kind === "unsupported" ? ledgerCategory(d.program) : null;
      const data = Buffer.from(tx.instructions[ixIndex].dataHex, "hex");
      const upgrade = category === "program-upgrade" && data.length >= 4 && data.readUInt32LE(0) === 3;
      const evidenceIds = unique([bundle.proposal.evidenceId, bundle.governance.evidenceId, bundle.realm.evidenceId, tx.evidenceId,
        ...[src?.evidenceId, dst?.evidenceId, mint?.evidenceId].filter((id): id is string => !!id), ...(receipt?.evidenceIds ?? [])]);
      const slots = unique([src?.slot, dst?.slot, mint?.slot, receipt?.slot].filter((slot): slot is number => slot != null));
      return { proposal: bundle.proposal.address, proposalName: bundle.proposal.name, governance: bundle.governance.address,
        txAddress: tx.address, optionIndex: tx.optionIndex, txIndex: tx.index, ixIndex, kind: d.kind, programId: d.program, category,
        instructionLabel: category === "program-upgrade" ? upgrade ? "program upgrade" : "upgradeable loader instruction" : d.kind,
        upgradeProgram: upgrade ? tx.instructions[ixIndex].accounts[1]?.pubkey ?? null : null, asset,
        amountRaw: amount?.toString() ?? null, amountDisplay: amount == null ? null : display(amount, decimals), decimals,
        source, sourceOwner, destination, destinationOwner,
        sourceControl: classifyLedgerOwner(sourceOwner, daoOwners), destinationControl: classifyLedgerOwner(destinationOwner, daoOwners),
        executedAt: tx.executedAt, receiptSignature: receipt?.signature ?? null, receiptSlot: receipt?.slot ?? null, slot: receipt?.slot ?? null,
        observedDeltaRaw: null, aggregateExpectedDeltaRaw: null, aggregateCount: 0,
        reconciliation: tx.executedAt == null ? "not-executed" : receipt == null ? "receipt-not-found" : "not-reconcilable",
        basis: "decoded", evidenceIds, slots,
        notes: [...(d.kind === "unsupported" ? [d.reason] : []),
          ...((src && !observedSource?.owner) || (dst && !observedDestination?.owner) ? ["Owner fallback uses account state at capture, not historical execution state."] : [])] };
    });
  });
  reconcileLedgerEntries(entries, receipts);
  return entries;
}

const emptyCounts = () => ({ matched: 0, mismatch: 0, "not-reconcilable": 0, "not-executed": 0, "receipt-not-found": 0, unsupported: 0 });
type Counts = ReturnType<typeof emptyCounts>;
function countEntry(counts: Counts, entry: LedgerEntry) {
  const status = isMatched(entry) ? "matched" : entry.reconciliation as Reconciliation["status"];
  counts[status]++;
  if (entry.kind === "unsupported") counts.unsupported++;
}
export type LedgerAssetSummary = {
  asset: string; decimals: number | null; counts: Counts;
  externalOutflowsRaw: string; externalOutflowsDisplay: string; internalMovesRaw: string; internalMovesDisplay: string;
  externalInflowsRaw: string; externalInflowsDisplay: string; burnsRaw: string; burnsDisplay: string;
  netChangeOfDaoControlledBalanceRaw: string; netChangeOfDaoControlledBalanceDisplay: string;
};
export function ledgerSummary(entries: LedgerEntry[]) {
  const countsByKind: Record<Decoded["kind"], number> = { burn: 0, transfer: 0, mintTo: 0, createAccount: 0, setAuthority: 0, unsupported: 0 };
  const countsByCategory: Record<LedgerCategory, number> = { governance: 0, "program-upgrade": 0, marinade: 0, "token-other": 0, other: 0 };
  const counts = emptyCounts();
  const assets = new Map<string, { decimals: Set<number>; externalOutflows: bigint; internalMoves: bigint; externalInflows: bigint; burns: bigint; decodedAbsolute: bigint; counts: Counts }>();
  for (const entry of entries) {
    countsByKind[entry.kind]++; countEntry(counts, entry);
    if (entry.kind === "unsupported" && entry.category) countsByCategory[entry.category]++;
    if (!entry.asset) continue;
    const sums = assets.get(entry.asset) ?? { decimals: new Set<number>(), externalOutflows: 0n, internalMoves: 0n, externalInflows: 0n, burns: 0n, decodedAbsolute: 0n, counts: emptyCounts() };
    if (entry.decimals != null) sums.decimals.add(entry.decimals);
    countEntry(sums.counts, entry); assets.set(entry.asset, sums);
    if (entry.amountRaw == null) continue;
    const amount = BigInt(entry.amountRaw);
    sums.decodedAbsolute += amount < 0n ? -amount : amount;
    if (entry.executedAt == null || !entry.receiptSignature || !isMatched(entry) || entry.basis !== "observed") continue;
    if (amount < 0n) throw new Error("ledger: decoded token amount cannot be negative");
    if (entry.kind === "transfer") {
      if (entry.sourceControl === "dao-controlled" && entry.destinationControl === "external") sums.externalOutflows += amount;
      if (entry.sourceControl === "dao-controlled" && entry.destinationControl === "dao-controlled") sums.internalMoves += amount;
      if (entry.sourceControl === "external" && entry.destinationControl === "dao-controlled") sums.externalInflows += amount;
    }
    if (entry.kind === "burn" && entry.sourceControl === "dao-controlled") sums.burns += amount;
  }
  return { assets: [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([asset, s]): LedgerAssetSummary => {
    if (s.externalOutflows + s.internalMoves + s.burns > s.decodedAbsolute) throw new Error(`ledger: movements exceed decoded amounts for ${asset}`);
    const decimals = s.decimals.size === 1 ? [...s.decimals][0] : null;
    const net = s.externalInflows - s.externalOutflows - s.burns;
    return { asset, decimals, counts: s.counts,
      externalOutflowsRaw: String(s.externalOutflows), externalOutflowsDisplay: display(s.externalOutflows, decimals),
      internalMovesRaw: String(s.internalMoves), internalMovesDisplay: display(s.internalMoves, decimals),
      externalInflowsRaw: String(s.externalInflows), externalInflowsDisplay: display(s.externalInflows, decimals),
      burnsRaw: String(s.burns), burnsDisplay: display(s.burns, decimals),
      netChangeOfDaoControlledBalanceRaw: String(net), netChangeOfDaoControlledBalanceDisplay: display(net, decimals) };
  }), countsByKind, countsByCategory, countsByReconciliation: { matched: counts.matched, mismatch: counts.mismatch,
    "not-reconcilable": counts["not-reconcilable"], "not-executed": counts["not-executed"], "receipt-not-found": counts["receipt-not-found"] },
    unsupportedPrograms: unique(entries.filter(e => e.kind === "unsupported").map(e => e.programId)).sort() };
}
export type TreasuryLedger = {
  entries: LedgerEntry[]; summary: ReturnType<typeof ledgerSummary>; proposalsScanned: number; proposalsWithPayload: number;
  proposals: (LedgerProposal & { disposition: ProposalDisposition | "limit reached" })[]; notes: string[];
};
export const emptyTreasuryLedger = (note: string): TreasuryLedger => ({ entries: [], summary: ledgerSummary([]), proposalsScanned: 0, proposalsWithPayload: 0, proposals: [], notes: [note] });

/** Additional reads are restricted to inferred mint addresses and captured token owners.
 * A missing optional fixture must not discard the recorded ledger. */
export async function enrichLedgerMetadata(rpc: RecordingRpc, bundle: ProposalBundle, receipts: Receipt[], governances: string[]) {
  const rows = ledgerEntriesFromBundle(bundle, receipts);
  const notes: string[] = [];
  const ownerControls = new Map<string, OwnerControl>();
  const program = new PublicKey(bundle.programId);
  const governanceKeys = governances.map(g => new PublicKey(g));
  const daoOwners = [...governances, ...await Promise.all(governanceKeys.map(async g => (await getNativeTreasuryAddress(program, g)).toBase58()))];
  for (const asset of unique(rows.flatMap(row => row.asset ? [row.asset] : []))) {
    if (bundle.mints[asset]) continue;
    try {
      const mint = await readMintState(rpc, new PublicKey(asset));
      if (mint.value) bundle.mints[asset] = { ...mint.value, slot: mint.slot, evidenceId: mint.evidenceIds[0] };
      else notes.push(`${asset}: decimals unknown; mint absent or unsupported.`);
    } catch (error) {
      if (!missingOptionalFixture(rpc, error)) throw error;
      notes.push(`${asset}: decimals unknown; mint not captured.`);
    }
  }
  for (const owner of unique(rows.flatMap(row => [row.sourceOwner, row.destinationOwner].filter((o): o is string => o != null)))) {
    try {
      // Authority identity is checked with the same classifier as controller paths.
      // Realm membership is restricted to the recorded governance list, not merely
      // an account owned by the governance program (which could belong to another realm).
      const authority = await classifyAuthority(rpc, new PublicKey(owner), { program, governances: governanceKeys });
      ownerControls.set(owner, authority.kind === "native-treasury-pda" || governances.includes(authority.address) ? "dao-controlled" : "external");
    } catch (error) {
      if (!missingOptionalFixture(rpc, error)) throw error;
      // The token authority address is still captured in the receipt/account. Its
      // membership can be compared to the full realm list without an owner account.
      ownerControls.set(owner, classifyLedgerOwner(owner, daoOwners));
      notes.push(`${owner}: owner account not captured; control uses captured token authority and realm membership.`);
    }
  }
  return { notes, ownerControls };
}
function missingOptionalFixture(rpc: RecordingRpc, error: unknown): boolean {
  return rpc.opts.offline && error instanceof Error && error.message.startsWith("offline: fixture missing for getAccountInfo → ");
}

export async function buildTreasuryLedger(rpc: RecordingRpc, programId: PublicKey, programVersion: number, proposals: LedgerProposal[], options: {
  maxProposals?: number; nativeTreasuries?: string[]; governances?: string[];
} = {}): Promise<TreasuryLedger> {
  const max = options.maxProposals ?? 300;
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("ledger: maxProposals must be a nonnegative integer");
  const governances = unique(options.governances ?? proposals.map(p => p.governance));
  const allReceipts: Receipt[] = [];
  const treasuries = unique([...(options.nativeTreasuries ?? []), ...await Promise.all(governances.map(async g => (await getNativeTreasuryAddress(programId, new PublicKey(g))).toBase58()))]);
  const result: TreasuryLedger = { ...emptyTreasuryLedger("Totals include only decoded movements reconciled to successful receipts. DAO control means token authority is a native treasury PDA or governance account in the recorded realm list. Unknown owners are excluded from flow totals. Burns include DAO-controlled sources only; net = external inflows − external outflows − burns. MintTo is counted but excluded from this flow formula. Receipt deltas are transaction-wide; aggregate matches do not attribute a separate observed amount to each instruction. Unsupported counts overlap reconciliation counts. SOL instructions remain unsupported; no USD conversion."), proposalsScanned: proposals.length,
    proposalsWithPayload: proposals.filter(p => p.options.some(o => o.instructionsCount > 0)).length };
  let processed = 0;
  for (const proposal of proposals) {
    const disposition = proposalDisposition(proposal);
    const limited = disposition === "payload" && processed >= max;
    result.proposals.push({ ...proposal, disposition: limited ? "limit reached" : disposition });
    if (disposition !== "payload" || limited) continue;
    processed++;
    const evidenceStart = rpc.evidence.length;
    const bundle = await readProposalBundle(rpc, programId, programVersion, new PublicKey(proposal.proposal));
    if (bundle.proposal.governance !== proposal.governance) throw new Error("ledger: proposal governance changed since discovery");
    const receipts: Receipt[] = [];
    for (const [index, tx] of bundle.transactions.entries()) {
      const receipt = await findExecutionReceipt(rpc, tx, index);
      if (receipt) receipts.push(receipt);
    }
    allReceipts.push(...receipts);
    const metadata = await enrichLedgerMetadata(rpc, bundle, receipts, governances);
    result.notes.push(...metadata.notes);
    const expectedTxs = bundle.proposal.options.reduce((sum, o) => sum + o.instructionsCount, 0);
    if (bundle.transactions.length < expectedTxs) result.notes.push(`${proposal.proposal}: ${expectedTxs - bundle.transactions.length} proposal transaction account(s) missing.`);
    const evidence = rpc.evidence.slice(evidenceStart);
    const rows = ledgerEntriesFromBundle(bundle, receipts, [...treasuries, ...governances]);
    for (const row of rows) {
      if (row.sourceOwner) row.sourceControl = metadata.ownerControls.get(row.sourceOwner) ?? row.sourceControl;
      if (row.destinationOwner) row.destinationControl = metadata.ownerControls.get(row.destinationOwner) ?? row.destinationControl;
      // Include negative receipt searches and absent account reads in coverage evidence.
      row.evidenceIds = unique([...proposal.evidenceIds, ...row.evidenceIds, ...evidence.map(e => e.id)]);
      row.slots = unique([...row.slots, ...[proposal.slot, ...evidence.map(e => e.slot)].filter((slot): slot is number => slot != null)]);
    }
    result.entries.push(...rows);
  }
  if (result.proposals.some(p => p.disposition === "limit reached")) result.notes.push(`Ledger truncated: maxProposals=${max}; remaining executable proposals are listed as limit reached.`);
  reconcileLedgerEntries(result.entries, allReceipts);
  result.notes = unique(result.notes);
  result.summary = ledgerSummary(result.entries);
  return result;
}
