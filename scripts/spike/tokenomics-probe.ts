// Read-only feasibility probe for the tokenomics dependency graph (Claude, 2026-10-06).
// Uses LINCHPIN_RPC_URL; prints no endpoint. Writes found IDLs to out/spike/idl/.
import { Connection, PublicKey } from "@solana/web3.js";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import registry from "../../packs/marinade/registry.json";

const url = process.env.LINCHPIN_RPC_URL; if (!url) throw new Error("LINCHPIN_RPC_URL missing");
const c = new Connection(url, "confirmed");
const disc = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8).toString("hex");
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
mkdirSync("out/spike/idl", { recursive: true });
const slot = await c.getSlot(); console.log(`slot ${slot}`);

console.log("\n== 1. Anchor IDL accounts on chain");
const idls: Record<string, any> = {};
for (const p of registry.programs as any[]) {
  const pid = new PublicKey(p.address);
  const base = PublicKey.findProgramAddressSync([], pid)[0];
  const addr = await PublicKey.createWithSeed(base, "anchor:idl", pid);
  const info = await c.getAccountInfo(addr);
  if (!info) { console.log(`  ${p.id.padEnd(22)} no IDL account (${short(addr.toBase58())})`); continue; }
  try {
    const len = info.data.readUInt32LE(40);
    const json = JSON.parse(inflateSync(info.data.subarray(44, 44 + len)).toString("utf8"));
    idls[p.id] = json; writeFileSync(`out/spike/idl/${p.id}.json`, JSON.stringify(json, null, 1));
    const accts = (json.accounts ?? []).map((a: any) => a.name);
    console.log(`  ${p.id.padEnd(22)} IDL ${json.name ?? json.metadata?.name} v${json.version ?? json.metadata?.version} spec=${json.metadata?.spec ?? "legacy"} · ${json.instructions?.length ?? 0} instructions · accounts [${accts.join(", ")}] · ${json.types?.length ?? 0} types`);
  } catch (e) { console.log(`  ${p.id.padEnd(22)} IDL account found (${info.data.length} B) but not decodable: ${(e as Error).message.slice(0, 80)}`); }
}

console.log("\n== 2. Liquid staking State account");
const STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const st = await c.getAccountInfo(STATE);
if (st) console.log(`  owner ${short(st.owner.toBase58())} · ${st.data.length} bytes · discriminator ${st.data.subarray(0, 8).toString("hex")} vs sha256("account:State")[0..8] ${disc("account:State")}`);
else console.log("  State account not found");

console.log("\n== 3. VSR registrar for MNDE");
const VSR = new PublicKey("VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS");
const realm = new PublicKey((registry as any).governance.realm);
const MNDE = new PublicKey("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey");
const [registrar] = PublicKey.findProgramAddressSync([realm.toBuffer(), Buffer.from("registrar"), MNDE.toBuffer()], VSR);
const reg = await c.getAccountInfo(registrar);
console.log(reg ? `  registrar ${short(registrar.toBase58())} · owner ${short(reg.owner.toBase58())} · ${reg.data.length} bytes · disc ${reg.data.subarray(0, 8).toString("hex")} vs Registrar ${disc("account:Registrar")}` : `  no registrar at ${short(registrar.toBase58())}`);

console.log("\n== 4. Observed program-to-program calls (8 recent transactions per program)");
for (const p of registry.programs as any[]) {
  const pid = new PublicKey(p.address);
  const sigs = await c.getSignaturesForAddress(pid, { limit: 8 });
  const counts = new Map<string, number>(); let txs = 0, last = 0;
  for (const s of sigs) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue; txs++; last = Math.max(last, tx.blockTime ?? 0);
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const top = tx.transaction.message.compiledInstructions;
    for (const inner of tx.meta.innerInstructions ?? []) {
      const caller = keys.get(top[inner.index].programIdIndex)?.toBase58();
      if (caller !== p.address) continue;
      for (const ix of inner.instructions) { const callee = keys.get(ix.programIdIndex)!.toBase58(); counts.set(callee, (counts.get(callee) ?? 0) + 1); }
    }
  }
  const list = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${short(k)}×${n}`).join(" ");
  console.log(`  ${p.id.padEnd(22)} ${String(txs).padStart(2)} txs · newest ${last ? new Date(last * 1000).toISOString().slice(0, 10) : "-"} · calls: ${list || "(none observed)"}`);
}

console.log("\n== 5. Largest holders (top 10 token accounts) and what owns them");
for (const [label, mint] of [["mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"], ["MNDE", MNDE.toBase58()]] as const) {
  const supply = await c.getTokenSupply(new PublicKey(mint));
  const largest = await c.getTokenLargestAccounts(new PublicKey(mint));
  console.log(`  ${label}: supply ${supply.value.uiAmountString}`);
  for (const a of largest.value.slice(0, 10)) {
    const acc = await c.getAccountInfo(a.address);
    const owner = new PublicKey(acc!.data.subarray(32, 64));
    const oi = await c.getAccountInfo(owner);
    const kind = oi ? `account owned by ${short(oi.owner.toBase58())}${oi.executable ? " (program)" : ""}` : PublicKey.isOnCurve(owner.toBytes()) ? "wallet (no account data)" : "PDA without account";
    const pct = (Number(a.uiAmountString) / Number(supply.value.uiAmountString) * 100).toFixed(2);
    console.log(`    ${short(a.address.toBase58())} ${a.uiAmountString?.padStart(18)} (${pct}%) · authority ${short(owner.toBase58())} · ${kind}`);
  }
}
