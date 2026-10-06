// Read-only spike (Claude, 2026-10-06): what are the buyback wallet's October and July MNDE recipients?
import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection(process.env.LINCHPIN_RPC_URL!, "confirmed");
import flows from "../../out/contracts-marinade/flows.json";
const owners = new Set<string>();
for (const t of (flows as any).buybacks.transactions) for (const r of t.recipients ?? []) if (/^(Gb1Rjd|7iWnBR)/.test(r.owner ?? "")) owners.add(r.owner);
for (const o of owners) {
  const info = await c.getAccountInfo(new PublicKey(o));
  const sigs = await c.getSignaturesForAddress(new PublicKey(o), { limit: 10 });
  const progs = new Map<string, number>();
  for (const s of sigs) { const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null); if (!tx) continue; const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }); for (const ix of tx.transaction.message.compiledInstructions) { const p = keys.get(ix.programIdIndex)!.toBase58(); progs.set(p, (progs.get(p) ?? 0) + 1); } }
  console.log(`${o}: account ${info ? `owned by ${info.owner.toBase58()} (${info.data.length} bytes, executable ${info.executable})` : "none"} · onCurve ${PublicKey.isOnCurve(new PublicKey(o).toBytes())} · recent top-level programs ${JSON.stringify(Object.fromEntries(progs))}`);
}
