// Read-only spike (Claude, 2026-10-06): how many recent transactions of the flow accounts use a version the client cannot parse?
import { Connection, PublicKey } from "@solana/web3.js";
const url = process.env.LINCHPIN_RPC_URL!;
const c = new Connection(url, "confirmed");
const targets = { "treasury mSOL account": "B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR", "buyback wallet": "BBaQsiRo744NAYaqL3nKRfgeJayoqVicEQsEnLpfsJ6x" };
for (const [label, addr] of Object.entries(targets)) {
  const sigs = await c.getSignaturesForAddress(new PublicKey(addr), { limit: 60 });
  const versions = new Map<string, number>(); let parsedFail = 0;
  for (const s of sigs) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }) }).then(r => r.json());
    const v = String(r.result?.version ?? (r.error ? "error" : "?")); versions.set(v, (versions.get(v) ?? 0) + 1);
    if (v === "1") { try { await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); } catch { parsedFail++; } }
  }
  console.log(`${label}: ${sigs.length} newest txs · versions ${JSON.stringify(Object.fromEntries(versions))} · web3.js parse failures among v1: ${parsedFail}`);
}
