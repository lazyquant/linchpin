import { PublicKey } from "@solana/web3.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export type TokenAccountState = { mint: string; owner: string; amountRaw: bigint };
export type MintState = { supplyRaw: bigint; decimals: number; mintAuthority: string | null; freezeAuthority: string | null };

export function parseTokenAccount(data: Uint8Array): TokenAccountState {
  const b = Buffer.from(data);
  if (b.length < 165) throw new Error(`token account too short: ${b.length}`);
  return { mint: new PublicKey(b.subarray(0, 32)).toBase58(), owner: new PublicKey(b.subarray(32, 64)).toBase58(), amountRaw: b.readBigUInt64LE(64) };
}

export function parseMint(data: Uint8Array): MintState {
  const b = Buffer.from(data);
  if (b.length < 82) throw new Error(`mint too short: ${b.length}`);
  const mintAuthority = b.readUInt32LE(0) === 1 ? new PublicKey(b.subarray(4, 36)).toBase58() : null;
  const freezeAuthority = b.readUInt32LE(46) === 1 ? new PublicKey(b.subarray(50, 82)).toBase58() : null;
  return { supplyRaw: b.readBigUInt64LE(36), decimals: b[44], mintAuthority, freezeAuthority };
}

export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n; const v = neg ? -raw : raw;
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
