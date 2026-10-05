import { PublicKey } from "@solana/web3.js";
import type { RecordingRpc } from "../chain/rpc";
import type { Decoded } from "./decode";
import type { ProposalTx } from "./reader";

export type Receipt = { txIndex: number; proposalTransaction: string; signature: string; slot: number; blockTime: number | null; success: boolean; programsInvoked: string[]; innerPrograms: string[]; governanceExecuteLogged: boolean; tokenBalances: { account: string; mint: string; owner: string | null; preRaw: string; postRaw: string; deltaRaw: string }[]; logs: string[]; evidenceIds: string[] };
export type AccountReconciliation = { account: string; expectedDeltaRaw: string; observedDeltaRaw: string | null; matched: boolean };
export type Reconciliation = { proposalTransaction?: string; accounts?: AccountReconciliation[]; status: "matched" | "mismatch" | "not-reconcilable" | "not-executed" | "receipt-not-found"; expectedDeltaRaw: string | null; observedDeltaRaw: string | null; account: string | null; notes: string[] };

const key = (tx: any, i: number): string => { const k = tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys; const list = [...(k ?? []).map((x: any) => (typeof x === "string" ? x : x.pubkey ?? x)), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])]; return String(list[i]); };

export async function findExecutionReceipt(rpc: RecordingRpc, ptx: ProposalTx, txIndex = 0): Promise<Receipt | null> {
  if (ptx.executedAt == null) return null;
  const sigs = await rpc.getSignaturesForAddress(new PublicKey(ptx.address), 50);
  const candidates = sigs.value.filter((s) => !s.err && s.blockTime != null && s.blockTime >= ptx.executedAt! - 5 && s.blockTime <= ptx.executedAt! + 5).sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  for (const c of candidates) {
    const tx = await rpc.getTransaction(c.signature);
    const t: any = tx.value; if (!t) continue;
    const logs: string[] = t.meta?.logMessages ?? [];
    const governanceExecuteLogged = logs.some((l) => l.includes("GOVERNANCE-INSTRUCTION: ExecuteTransaction"));
    if (!governanceExecuteLogged) continue;
    const top: string[] = (t.transaction.message.compiledInstructions ?? t.transaction.message.instructions ?? []).map((ci: any) => key(t, ci.programIdIndex));
    const inner: string[] = (t.meta?.innerInstructions ?? []).flatMap((ii: any) => ii.instructions.map((x: any) => key(t, x.programIdIndex)));
    const pre: any[] = t.meta?.preTokenBalances ?? []; const post: any[] = t.meta?.postTokenBalances ?? [];
    const indices = [...new Set([...pre, ...post].map((b) => b.accountIndex))];
    const tokenBalances = indices.map((index) => {
      const p = pre.find((b) => b.accountIndex === index); const q = post.find((b) => b.accountIndex === index);
      const preRaw = BigInt(p?.uiTokenAmount.amount ?? "0"); const postRaw = BigInt(q?.uiTokenAmount.amount ?? "0");
      return { account: key(t, index), mint: (p ?? q).mint, owner: p?.owner ?? q?.owner ?? null, preRaw: preRaw.toString(), postRaw: postRaw.toString(), deltaRaw: (postRaw - preRaw).toString() };
    });
    return { txIndex, proposalTransaction: ptx.address, signature: c.signature, slot: t.slot, blockTime: t.blockTime ?? null, success: t.meta?.err == null, programsInvoked: [...new Set(top)], innerPrograms: [...new Set(inner)], governanceExecuteLogged, tokenBalances, logs: logs.slice(0, 60), evidenceIds: [sigs.evidence.id, tx.evidence.id] };
  }
  return null;
}

export function reconcileReceipt(decoded: Decoded[], ptx: ProposalTx, receipt: Receipt | null): Reconciliation {
  if (ptx.executedAt == null) return { proposalTransaction: ptx.address, status: "not-executed", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["proposal transaction has no executedAt; nothing to observe"] };
  if (!receipt) return { proposalTransaction: ptx.address, status: "receipt-not-found", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transaction with GOVERNANCE-INSTRUCTION: ExecuteTransaction found near executedAt"] };
  const movements = decoded.filter((d) => d.kind === "burn" || d.kind === "transfer");
  const expectedBySource = new Map<string, bigint>();
  for (const d of movements) expectedBySource.set(d.source, (expectedBySource.get(d.source) ?? 0n) - d.amountRaw);
  // Receipt balances are net changes. Include credits/mints into a debited source.
  for (const d of decoded) {
    if ((d.kind === "transfer" || d.kind === "mintTo") && expectedBySource.has(d.destination)) {
      expectedBySource.set(d.destination, expectedBySource.get(d.destination)! + d.amountRaw);
    }
  }
  const accounts = [...expectedBySource].map(([account, expected]): AccountReconciliation => {
    const row = receipt.tokenBalances.find((b) => b.account === account);
    const programs = movements.filter((d) => d.source === account).map((d) => d.program);
    return { account, expectedDeltaRaw: expected.toString(), observedDeltaRaw: row?.deltaRaw ?? null,
      matched: receipt.success && !!row && BigInt(row.deltaRaw) === expected && programs.every((p) => receipt.innerPrograms.includes(p)) };
  });
  const notes: string[] = [];
  if (!receipt.success) notes.push("execution transaction failed on chain");
  if (!accounts.length) notes.push(`no decoded token movement in this transaction; receipt found, ${receipt.success ? "success" : "failed"}`);
  if (decoded.some((d) => d.kind === "unsupported")) notes.push("unsupported instructions remain unreconciled");
  for (const a of accounts) if (!a.matched) notes.push(`${a.account}: expected ${a.expectedDeltaRaw} raw, observed ${a.observedDeltaRaw ?? "no source account balance change"}`);
  const extras = receipt.programsInvoked.filter((p) => p !== "ComputeBudget111111111111111111111111111111" && !decoded.some((d) => d.program === p) && !p.startsWith("GovMaiH") && !p.startsWith("GovER5"));
  if (extras.length) notes.push(`other programs in the same transaction (not economic effects, kept visible): ${extras.join(", ")}`);
  const single = accounts.length === 1 ? accounts[0] : null;
  return { proposalTransaction: ptx.address, status: !accounts.length ? "not-reconcilable" : accounts.every((a) => a.matched) ? "matched" : "mismatch",
    expectedDeltaRaw: single?.expectedDeltaRaw ?? null, observedDeltaRaw: single?.observedDeltaRaw ?? null, account: single?.account ?? null, accounts, notes };
}
