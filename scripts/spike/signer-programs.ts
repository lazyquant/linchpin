// Read-only spike (Claude, 2026-10-06): which program signs for off-curve authorities? Looks at recent transactions that include each address.
import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection(process.env.LINCHPIN_RPC_URL!, "confirmed");
const targets: Record<string, string> = {
  "liquid-staking adminAuthority": "42VJbDihcS81YJPbuhHnHgvo1ehu42j8VK9sNwrnAarR",
  "liquid-staking pauseAuthority": "AjGjLWx7vbzgPNxPSQUPjLNjeavQCHVS9VoJNWpnyP6n",
  "mSOL program upgrade authority": "551FBXSXdhcRDDkdcb3ThDRg84Mwe5Zs6YjJ1EEoyzBp",
};
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
for (const [label, addr] of Object.entries(targets)) {
  const sigs = await c.getSignaturesForAddress(new PublicKey(addr), { limit: 20 });
  const tops = new Map<string, number>(); let newest = 0, oldest = Infinity;
  for (const s of sigs) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); if (!tx?.meta) continue;
    newest = Math.max(newest, tx.blockTime ?? 0); oldest = Math.min(oldest, tx.blockTime ?? Infinity);
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    for (const ix of tx.transaction.message.compiledInstructions) { const p = keys.get(ix.programIdIndex)!.toBase58(); tops.set(p, (tops.get(p) ?? 0) + 1); }
  }
  const fmt = (t: number) => (isFinite(t) && t ? new Date(t * 1000).toISOString().slice(0, 10) : "-");
  console.log(`${label} ${short(addr)}: ${sigs.length} recent txs (${fmt(oldest)} … ${fmt(newest)}) · top-level programs: ${[...tops].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${short(p)}×${n}`).join(" ") || "none"}`);
}
