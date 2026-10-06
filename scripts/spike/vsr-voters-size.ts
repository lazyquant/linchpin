// Read-only sizing spike (Claude, 2026-10-06): can all VSR Voter accounts of the MNDE registrar be fetched in one getProgramAccounts call?
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import registry from "../../packs/marinade/registry.json";
const c = new Connection(process.env.LINCHPIN_RPC_URL!, "confirmed");
const VSR = new PublicKey("VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS");
const MNDE = new PublicKey("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey");
const realm = new PublicKey((registry as any).governance.realm);
const [registrar] = PublicKey.findProgramAddressSync([realm.toBuffer(), Buffer.from("registrar"), MNDE.toBuffer()], VSR);
const disc = bs58.encode(createHash("sha256").update("account:Voter").digest().subarray(0, 8));
const t = Date.now();
const r = await c.getProgramAccounts(VSR, { filters: [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: 40, bytes: registrar.toBase58() } }] });
const bytes = r.reduce((s, a) => s + a.account.data.length, 0);
console.log(`voters for the MNDE registrar: ${r.length} · ${(bytes / 1e6).toFixed(1)} MB · ${Date.now() - t} ms · sizes ${[...new Set(r.map(a => a.account.data.length))].join(",")}`);
// quick sum of amount_deposited_native over used deposits (layout per VSR 0.2.x: disc 8, authority 32, registrar 32, deposits 32 x 80 bytes; entry: lockup 32 (start i64, end i64, kind u8, reserved), deposited u64 @32, initially locked u64 @40, is_used u8 @48)
let total = 0n, used = 0, voters = 0; const kinds = new Map<number, bigint>();
for (const a of r) { let any = false; for (let i = 0; i < 32; i++) { const o = 72 + i * 80, d = a.account.data; if (d[o + 48] !== 1) continue; const amt = d.readBigUInt64LE(o + 32); total += amt; used++; any = true; kinds.set(d[o + 16], (kinds.get(d[o + 16]) ?? 0n) + amt); } if (any) voters++; }
console.log(`used deposit entries ${used} · voters with deposits ${voters} · sum deposited ${(Number(total) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 })} MNDE (spike layout assumption; G3 decodes with the IDL)`);
console.log(`by lockup kind byte: ${[...kinds].map(([k, v]) => `${k}:${(Number(v) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 0 })}`).join("  ")}`);
