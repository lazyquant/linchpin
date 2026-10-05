import { PublicKey } from "@solana/web3.js";
import type { RecordingRpc } from "../chain/rpc";
import type { Decoded } from "./decode";
import type { ProposalTx } from "./reader";

export type Receipt = { signature: string; slot: number; blockTime: number | null; success: boolean; programsInvoked: string[]; innerPrograms: string[]; governanceExecuteLogged: boolean; tokenBalances: { account: string; mint: string; owner: string | null; preRaw: string; postRaw: string; deltaRaw: string }[]; logs: string[]; evidenceIds: string[] };
export type Reconciliation = { status: "matched" | "mismatch" | "not-executed" | "receipt-not-found"; expectedDeltaRaw: string | null; observedDeltaRaw: string | null; account: string | null; notes: string[] };

const key = (tx: any, i: number): string => { const k = tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys; const list = [...(k ?? []).map((x: any) => (typeof x === "string" ? x : x.pubkey ?? x)), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])]; return String(list[i]); };

export async function findExecutionReceipt(rpc: RecordingRpc, ptx: ProposalTx): Promise<Receipt | null> {
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
    const tokenBalances = pre.map((p) => { const q = post.find((x) => x.accountIndex === p.accountIndex); const preRaw = BigInt(p.uiTokenAmount.amount); const postRaw = BigInt(q?.uiTokenAmount.amount ?? "0"); return { account: key(t, p.accountIndex), mint: p.mint, owner: p.owner ?? null, preRaw: preRaw.toString(), postRaw: postRaw.toString(), deltaRaw: (postRaw - preRaw).toString() }; });
    return { signature: c.signature, slot: t.slot, blockTime: t.blockTime ?? null, success: t.meta?.err == null, programsInvoked: [...new Set(top)], innerPrograms: [...new Set(inner)], governanceExecuteLogged, tokenBalances, logs: logs.slice(0, 60), evidenceIds: [sigs.evidence.id, tx.evidence.id] };
  }
  return null;
}

export function reconcileReceipt(decoded: Decoded[], ptx: ProposalTx, receipt: Receipt | null): Reconciliation {
  if (ptx.executedAt == null) return { status: "not-executed", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["proposal transaction has no executedAt; nothing to observe"] };
  if (!receipt) return { status: "receipt-not-found", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no transaction with GOVERNANCE-INSTRUCTION: ExecuteTransaction found near executedAt"] };
  const d = decoded.find((x) => x.kind === "burn" || x.kind === "transfer");
  if (!d || (d.kind !== "burn" && d.kind !== "transfer")) return { status: "mismatch", expectedDeltaRaw: null, observedDeltaRaw: null, account: null, notes: ["no decoded token movement to reconcile"] };
  const expected = -d.amountRaw;
  const row = receipt.tokenBalances.find((b) => b.account === d.source);
  const notes: string[] = [];
  if (!receipt.success) notes.push("execution transaction failed on chain");
  if (!row) return { status: "mismatch", expectedDeltaRaw: expected.toString(), observedDeltaRaw: null, account: d.source, notes: [...notes, "source account has no token balance change in the receipt"] };
  const matched = receipt.success && BigInt(row.deltaRaw) === expected && receipt.innerPrograms.includes(d.program);
  const extras = receipt.programsInvoked.filter((p) => !["ComputeBudget111111111111111111111111111111"].includes(p) && p !== d.program && !p.startsWith("GovMaiH") && !p.startsWith("GovER5"));
  if (extras.length) notes.push(`other programs in the same transaction (not economic effects, kept visible): ${extras.join(", ")}`);
  return { status: matched ? "matched" : "mismatch", expectedDeltaRaw: expected.toString(), observedDeltaRaw: row.deltaRaw, account: d.source, notes };
}
