import { Connection, PublicKey, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createBurnInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getNativeTreasuryAddress } from "@solana/spl-governance";
const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const programId = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs");
const governance = new PublicKey("8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq");
const treasuryTokenAccount = new PublicKey("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi");
const mint = new PublicKey("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey");
const authority = new PublicKey("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
const histFeePayer = new PublicKey("3rL9kgavDB2rdAjSsX8Yz91tToiF7fhAHx3Qgn4JLGEk");
const out: any = {};
// 1. authority derivation
const nativeTreasury = await getNativeTreasuryAddress(programId, governance);
out.nativeTreasuryOfGovernance = nativeTreasury.toBase58();
out.authorityIsNativeTreasury = nativeTreasury.equals(authority);
const authInfo = await conn.getAccountInfo(authority);
out.authorityAccount = { exists: !!authInfo, owner: authInfo?.owner.toBase58(), lamports: authInfo?.lamports, dataLen: authInfo?.data.length, onCurve: PublicKey.isOnCurve(authority.toBytes()) };
// token account owner check
const taInfo = await conn.getAccountInfo(treasuryTokenAccount);
out.treasuryTokenAccount = { owner: taInfo?.owner.toBase58(), dataLen: taInfo?.data.length, tokenOwner: taInfo ? new PublicKey(taInfo.data.subarray(32, 64)).toBase58() : null, amountRaw: taInfo ? taInfo.data.readBigUInt64LE(64).toString() : null };
// 2. choose a funded fee payer for simulation
const feeCandidates = [authority, histFeePayer, governance];
let feePayer = authority;
for (const c of feeCandidates) { const bal = await conn.getBalance(c); out[`balance_${c.toBase58().slice(0,6)}`] = bal / LAMPORTS_PER_SOL; if (bal > 10_000_000) { feePayer = c; break; } }
out.feePayerUsed = feePayer.toBase58();
async function simulate(label: string, amountRaw: bigint) {
  const ix = createBurnInstruction(treasuryTokenAccount, mint, authority, amountRaw, [], TOKEN_PROGRAM_ID);
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToLegacyMessage();
  const vtx = new VersionedTransaction(msg);
  const t0 = Date.now();
  const res = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [treasuryTokenAccount.toBase58(), mint.toBase58()] } });
  const v = res.value;
  const acct = v.accounts?.[0];
  let postAmount: string | null = null;
  if (acct?.data?.[0]) { const buf = Buffer.from(acct.data[0], "base64"); postAmount = buf.readBigUInt64LE(64).toString(); }
  const mintAcct = v.accounts?.[1];
  let postSupply: string | null = null;
  if (mintAcct?.data?.[0]) { const buf = Buffer.from(mintAcct.data[0], "base64"); postSupply = buf.readBigUInt64LE(36).toString(); }
  out[label] = { ms: Date.now() - t0, contextSlot: res.context.slot, err: v.err, unitsConsumed: v.unitsConsumed, logs: v.logs?.slice(0, 10), postTreasuryAmountRaw: postAmount, postMintSupplyRaw: postSupply, messageHashHex: Buffer.from(await crypto.subtle.digest("SHA-256", msg.serialize())).toString("hex").slice(0, 16) + "…" };
}
await simulate("sim_historical_payload_300M_today", 300_000_000_000_000_000n);
await simulate("sim_fixture_1_MNDE", 1_000_000_000n);
console.log(JSON.stringify(out, null, 1));
