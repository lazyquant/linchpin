// Read-only sizing probe (Claude, 2026-10-06): account counts per type via getProgramAccounts with dataSlice length 0.
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
const c = new Connection(process.env.LINCHPIN_RPC_URL!, "confirmed");
const disc = (n: string) => bs58.encode(createHash("sha256").update(`account:${n}`).digest().subarray(0, 8));
const MNDE = "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey", MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
async function count(label: string, program: string, filters: any[], slice = { offset: 0, length: 0 }) {
  const t = Date.now();
  try { const r = await c.getProgramAccounts(new PublicKey(program), { filters, dataSlice: slice }); console.log(`  ${label.padEnd(44)} ${String(r.length).padStart(7)} accounts · ${Date.now() - t} ms`); return r; }
  catch (e) { console.log(`  ${label.padEnd(44)} failed: ${(e as Error).message.slice(0, 90)}`); return []; }
}
const programs: Record<string, [string, string[]]> = {
  "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD": ["liquid-staking", ["State", "TicketAccountData"]],
  "VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS": ["vsr", ["Registrar", "Voter"]],
  "tovt1VkTE2T4caWoeFP6a2xSFoew5mNpd7FWidyyMuk": ["escrow-relocker", ["Escrow", "Gauge", "GaugeVoter", "GaugeVote", "Gaugemeister", "Realm"]],
  "va12L6Z9fa5aGJ7gxtJuQZ928nySAk5UetjcGPve3Nu": ["validator-gauges", ["MarinadeState"]],
  "LigadctxNRkZied3WuhX525vUhDkuhXNK5DyeijeDnh": ["liquidity-gauges", ["LiquidityGaugemeister"]],
  "MR2LqxoSbw831bNy68utpu5n4YqBH3AzDmddkgk9LQv": ["referral", ["GlobalState", "ReferralState"]],
  "dstK1PDHNoKN9MdmftRzsEbXP5T1FTBiQBm1Ee3meVd": ["directed-stake", ["Root", "VoteRecord"]],
  "mnspJQyF1KdDEs5c6YJPocYdY1esBgVQFufM2dY9oDk": ["native-staking-proxy", ["Root"]],
  "tokdh9ZbWPxkFzqsKqeAwLDk6J6a8NBZtQanVuuENxa": ["tokadapt", ["State"]],
};
console.log("== account counts by Anchor account type");
for (const [pid, [id, types]] of Object.entries(programs)) for (const t of types) await count(`${id} · ${t}`, pid, [{ memcmp: { offset: 0, bytes: disc(t) } }]);
console.log("== token holders (non-zero balances), amounts only");
for (const [label, mint] of [["MNDE", MNDE], ["mSOL", MSOL]] as const) {
  const r = await count(`${label} token accounts`, TOKEN.toBase58(), [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }], { offset: 64, length: 8 });
  const amounts = r.map(a => a.account.data.readBigUInt64LE(0)).filter(x => x > 0n).sort((a, b) => (b > a ? 1 : -1));
  const total = amounts.reduce((s, x) => s + x, 0n);
  const top = (n: number) => (Number(amounts.slice(0, n).reduce((s, x) => s + x, 0n) * 10000n / (total || 1n)) / 100).toFixed(2);
  console.log(`    non-zero ${amounts.length} · top 10 hold ${top(10)}% · top 100 hold ${top(100)}%`);
}
