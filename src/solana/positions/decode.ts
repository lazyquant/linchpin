import { PublicKey } from "@solana/web3.js";
import { parseTokenAccount } from "../../chain/token-layout";
export { parseTokenAccount };
export function unitsToDecimal(raw: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 315) throw new Error("invalid decimals");
  const digits = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, "0");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${raw < 0n ? "-" : ""}${decimals ? digits.slice(0, -decimals) : digits}${fraction ? "." + fraction : ""}`;
}
export function sfToDecimal(sf: bigint, decimals: number): string { return unitsToDecimal(sf * 5n ** 60n, 60 + decimals); }
export function decodeObligation(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.length !== 3344 || b.subarray(0, 8).toString("hex") !== "a8ce8d6a584caca7") throw new Error("invalid obligation");
  const key = (offset: number) => new PublicKey(b.subarray(offset, offset + 32)).toBase58();
  return {owner: key(64), market: key(32), lastUpdateSlot: b.readBigUInt64LE(16),
    deposits: Array.from({length:8}, (_, i) => ({reserve:key(96+i*136), amount:b.readBigUInt64LE(128+i*136)})),
    borrows: Array.from({length:5}, (_, i) => { const o=1208+i*200; return {reserve:key(o), amount:b.readBigUInt64LE(o+88)+(b.readBigUInt64LE(o+96)<<64n)}; })};
}
