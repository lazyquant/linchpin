import { PublicKey, type Connection, type GetProgramAccountsConfig, type AccountInfo } from "@solana/web3.js";
import { getGovernanceAccounts, getNativeTreasuryAddress, GovernanceAccountParser, Proposal, ProposalState, pubkeyFilter } from "@solana/spl-governance";
import type { RecordingRpc } from "../chain/rpc";
import type { Evidence } from "../chain/evidence";
import { formatUnits } from "../chain/token-layout";
import { readProposalBundle, type ProposalBundle } from "../governance/reader";
import { decodeInstruction, type Decoded } from "../governance/decode";
import { effectsFromDecoded } from "../governance/effects";
import { findExecutionReceipt, reconcileReceipt, type Receipt, type Reconciliation } from "../governance/receipt";
import { listGovernances } from "./classify";

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

export type LedgerEntry = {
  proposal: string; proposalName: string; governance: string; txAddress: string; optionIndex: number; txIndex: number; ixIndex: number;
  kind: Decoded["kind"]; programId: string; asset: string | null; amountRaw: string | null; amountDisplay: string | null; decimals: number | null;
  source: string | null; sourceOwner: string | null; destination: string | null; destinationOwner: string | null;
  sourceIsDaoTreasury: boolean; destinationIsDaoTreasury: boolean;
  executedAt: number | null; receiptSignature: string | null; receiptSlot: number | null;
  reconciliation: Reconciliation["status"]; basis: "decoded" | "observed"; evidenceIds: string[]; slots: number[]; notes: string[];
};
const unique = <T>(values: T[]) => [...new Set(values)];
const display = (amount: bigint, decimals: number | null) => decimals == null ? `${amount} raw (decimals unknown)` : formatUnits(amount, decimals);

/** One row per instruction, including unsupported and unexecuted payloads. */
export function ledgerEntriesFromBundle(bundle: ProposalBundle, receipts: Receipt[], nativeTreasuries: string[] = [bundle.governance.nativeTreasury]): LedgerEntry[] {
  const treasurySet = new Set(nativeTreasuries);
  return bundle.transactions.flatMap((tx, txIndex) => {
    const decoded = tx.instructions.map(decodeInstruction);
    const effects = effectsFromDecoded(decoded.map((decoded, ixIndex) => ({ txIndex, ixIndex, decoded })), bundle, { nativeTreasury: bundle.governance.nativeTreasury });
    const receipt = receipts.find(r => r.proposalTransaction === tx.address) ?? null;
    const reconciliation = reconcileReceipt(decoded, tx, receipt);
    // Receipts contain transaction-wide net balances, never per-instruction deltas.
    const expected = new Map<string, bigint>();
    const add = (account: string, amount: bigint) => expected.set(account, (expected.get(account) ?? 0n) + amount);
    for (const d of decoded) {
      if (d.kind === "burn" || d.kind === "transfer") add(d.source, -d.amountRaw);
      if (d.kind === "transfer" || d.kind === "mintTo") add(d.destination, d.amountRaw);
    }
    return decoded.map((d, ixIndex): LedgerEntry => {
      const source = d.kind === "burn" || d.kind === "transfer" ? d.source : d.kind === "setAuthority" ? d.target : d.kind === "createAccount" ? d.payer : null;
      const destination = d.kind === "transfer" || d.kind === "mintTo" ? d.destination : d.kind === "createAccount" ? d.account : null;
      const src = source ? bundle.tokenAccounts[source] : undefined;
      const dst = destination ? bundle.tokenAccounts[destination] : undefined;
      const observedSource = receipt?.tokenBalances.find(b => b.account === source);
      const observedDestination = receipt?.tokenBalances.find(b => b.account === destination);
      const effect = effects.find(e => e.id === `fx-${txIndex}-${ixIndex}-move`);
      const asset = "mint" in d ? d.mint ?? observedSource?.mint ?? (effect?.detail.asset as string | null) ?? observedDestination?.mint ?? dst?.mint ?? null : src?.mint ?? null;
      const mint = asset ? bundle.mints[asset] : undefined;
      // Only captured mint metadata establishes display units; unchecked amounts stay raw.
      const decimals = mint?.decimals ?? null;
      const amount = "amountRaw" in d ? d.amountRaw : null;
      const sourceOwner = observedSource?.owner ?? src?.owner ?? null;
      const destinationOwner = observedDestination?.owner ?? dst?.owner ?? (d.kind === "createAccount" ? d.owner : null);
      const movementAccounts = d.kind === "burn" ? [d.source] : d.kind === "transfer" ? [d.source, d.destination] : d.kind === "mintTo" ? [d.destination] : [];
      let status = reconciliation.status;
      if (tx.executedAt != null && receipt) {
        if (!movementAccounts.length) status = "not-reconcilable";
        else status = receipt.success && receipt.innerPrograms.includes(d.program) && movementAccounts.every(account => {
          const balance = receipt.tokenBalances.find(b => b.account === account);
          return balance && balance.mint === asset && BigInt(balance.deltaRaw) === expected.get(account);
        }) ? "matched" : "mismatch";
      }
      const evidenceIds = unique([bundle.proposal.evidenceId, bundle.governance.evidenceId, bundle.realm.evidenceId, tx.evidenceId,
        ...[src?.evidenceId, dst?.evidenceId, mint?.evidenceId].filter((id): id is string => !!id), ...(receipt?.evidenceIds ?? [])]);
      const slots = unique([src?.slot, dst?.slot, mint?.slot, receipt?.slot].filter((slot): slot is number => slot != null));
      return { proposal: bundle.proposal.address, proposalName: bundle.proposal.name, governance: bundle.governance.address,
        txAddress: tx.address, optionIndex: tx.optionIndex, txIndex: tx.index, ixIndex, kind: d.kind, programId: d.program, asset,
        amountRaw: amount?.toString() ?? null, amountDisplay: amount == null ? null : display(amount, decimals), decimals,
        source, sourceOwner, destination, destinationOwner,
        sourceIsDaoTreasury: sourceOwner != null && treasurySet.has(sourceOwner), destinationIsDaoTreasury: destinationOwner != null && treasurySet.has(destinationOwner),
        executedAt: tx.executedAt, receiptSignature: receipt?.signature ?? null, receiptSlot: receipt?.slot ?? null,
        reconciliation: status, basis: status === "matched" ? "observed" : "decoded", evidenceIds, slots,
        notes: unique([...reconciliation.notes, ...(d.kind === "unsupported" ? [d.reason] : []),
          ...(status === "matched" ? ["Instruction amount decoded; transaction net token balances matched."] : []),
          ...((src && !observedSource?.owner) || (dst && !observedDestination?.owner) ? ["Owner fallback uses account state at capture, not historical execution state."] : [])]) };
    });
  });
}

export type LedgerAssetSummary = { asset: string; decimals: number | null; outflowsRaw: string; inflowsRaw: string; burnsRaw: string; outflowsDisplay: string; inflowsDisplay: string; burnsDisplay: string };
export function ledgerSummary(entries: LedgerEntry[]) {
  const countsByKind: Record<Decoded["kind"], number> = { burn: 0, transfer: 0, mintTo: 0, createAccount: 0, setAuthority: 0, unsupported: 0 };
  const assets = new Map<string, { decimals: number | null; outflows: bigint; inflows: bigint; burns: bigint }>();
  for (const entry of entries) {
    countsByKind[entry.kind]++;
    if (!entry.asset || entry.amountRaw == null || entry.executedAt == null || !entry.receiptSignature || entry.reconciliation !== "matched" || entry.basis !== "observed") continue;
    const sums = assets.get(entry.asset) ?? { decimals: entry.decimals, outflows: 0n, inflows: 0n, burns: 0n };
    if (sums.decimals !== entry.decimals) sums.decimals = null;
    const amount = BigInt(entry.amountRaw);
    if (entry.sourceIsDaoTreasury && (entry.kind === "transfer" || entry.kind === "burn")) sums.outflows += amount;
    if (entry.destinationIsDaoTreasury && (entry.kind === "transfer" || entry.kind === "mintTo")) sums.inflows += amount;
    if (entry.kind === "burn") sums.burns += amount;
    assets.set(entry.asset, sums);
  }
  return { assets: [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([asset, s]): LedgerAssetSummary => ({ asset, decimals: s.decimals,
    outflowsRaw: String(s.outflows), inflowsRaw: String(s.inflows), burnsRaw: String(s.burns),
    outflowsDisplay: display(s.outflows, s.decimals), inflowsDisplay: display(s.inflows, s.decimals), burnsDisplay: display(s.burns, s.decimals) })),
    countsByKind, unsupportedPrograms: unique(entries.filter(e => e.kind === "unsupported").map(e => e.programId)).sort() };
}
export type TreasuryLedger = {
  entries: LedgerEntry[]; summary: ReturnType<typeof ledgerSummary>; proposalsScanned: number; proposalsWithPayload: number;
  proposals: (LedgerProposal & { disposition: ProposalDisposition | "limit reached" })[]; notes: string[];
};
export const emptyTreasuryLedger = (note: string): TreasuryLedger => ({ entries: [], summary: ledgerSummary([]), proposalsScanned: 0, proposalsWithPayload: 0, proposals: [], notes: [note] });

export async function buildTreasuryLedger(rpc: RecordingRpc, programId: PublicKey, programVersion: number, proposals: LedgerProposal[], options: {
  maxProposals?: number; nativeTreasuries?: string[];
} = {}): Promise<TreasuryLedger> {
  const max = options.maxProposals ?? 300;
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("ledger: maxProposals must be a nonnegative integer");
  const treasuries = unique([...(options.nativeTreasuries ?? []), ...await Promise.all(unique(proposals.map(p => p.governance)).map(async g => (await getNativeTreasuryAddress(programId, new PublicKey(g))).toBase58()))]);
  const result: TreasuryLedger = { ...emptyTreasuryLedger("Executed totals include only movements reconciled to successful receipts. Outflows/inflows are gross DAO native-treasury account movements; burns include all reconciled burns. SOL instructions remain unsupported; no USD conversion."), proposalsScanned: proposals.length,
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
    const expectedTxs = bundle.proposal.options.reduce((sum, o) => sum + o.instructionsCount, 0);
    if (bundle.transactions.length < expectedTxs) result.notes.push(`${proposal.proposal}: ${expectedTxs - bundle.transactions.length} proposal transaction account(s) missing.`);
    const evidence = rpc.evidence.slice(evidenceStart);
    const rows = ledgerEntriesFromBundle(bundle, receipts, treasuries);
    for (const row of rows) {
      // Include negative receipt searches and absent account reads in coverage evidence.
      row.evidenceIds = unique([...proposal.evidenceIds, ...row.evidenceIds, ...evidence.map(e => e.id)]);
      row.slots = unique([...row.slots, ...[proposal.slot, ...evidence.map(e => e.slot)].filter((slot): slot is number => slot != null)]);
    }
    result.entries.push(...rows);
  }
  if (result.proposals.some(p => p.disposition === "limit reached")) result.notes.push(`Ledger truncated: maxProposals=${max}; remaining executable proposals are listed as limit reached.`);
  result.summary = ledgerSummary(result.entries);
  return result;
}
