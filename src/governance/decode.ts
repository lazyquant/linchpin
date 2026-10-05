import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../chain/token-layout";
import type { RawInstruction } from "./reader";

export const DECODER_VERSION = "spl-token-legacy@1";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export type Decoded =
  | { kind: "createAccount"; program: string; account: string; owner: string; mint: string; payer: string; idempotent: boolean; decoderVersion: string }
  | { kind: "burn"; program: string; amountRaw: bigint; decimals: number | null; source: string; mint: string; authority: string; decoderVersion: string }
  | { kind: "transfer"; program: string; amountRaw: bigint; decimals: number | null; source: string; mint: string | null; destination: string; authority: string; decoderVersion: string }
  | { kind: "mintTo"; program: string; amountRaw: bigint; decimals: number | null; mint: string; destination: string; authority: string; decoderVersion: string }
  | { kind: "setAuthority"; program: string; authorityType: string; target: string; currentAuthority: string; newAuthority: string | null; decoderVersion: string }
  | { kind: "unsupported"; program: string; reason: string; dataHex: string; decoderVersion: string };

const AUTHORITY_TYPES = ["mintTokens", "freezeAccount", "accountOwner", "closeAccount"];
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);

export function decodeInstruction(ix: RawInstruction): Decoded {
  const program = ix.programId;
  const isToken = program === TOKEN_PROGRAM.toBase58() || program === TOKEN_2022_PROGRAM.toBase58();
  const data = Buffer.from(ix.dataHex, "hex");
  const a = (i: number) => ix.accounts[i]?.pubkey ?? "";
  if (program === ASSOCIATED_TOKEN_PROGRAM) {
    const create = ix.dataHex === "" || ix.dataHex === "00" || ix.dataHex === "01";
    if (create && ix.accounts.length >= 6) return { kind: "createAccount", program, account: a(1), owner: a(2), mint: a(3), payer: a(0), idempotent: ix.dataHex === "01", decoderVersion: DECODER_VERSION };
    return { kind: "unsupported", program, reason: create ? "malformed associated token account creation: requires six accounts" : ix.dataHex === "02" ? "recover nested not supported" : "associated token instruction not supported", dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  }
  if (!isToken) return { kind: "unsupported", program, reason: "program not supported by this decoder", dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  if (data.length < 1) return { kind: "unsupported", program, reason: "empty data", dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  const tag = data[0];
  try {
    switch (tag) {
      case 3: return { kind: "transfer", program, amountRaw: u64(data, 1), decimals: null, source: a(0), mint: null, destination: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 12: return { kind: "transfer", program, amountRaw: u64(data, 1), decimals: data[9], source: a(0), mint: a(1), destination: a(2), authority: a(3), decoderVersion: DECODER_VERSION };
      case 8: return { kind: "burn", program, amountRaw: u64(data, 1), decimals: null, source: a(0), mint: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 15: return { kind: "burn", program, amountRaw: u64(data, 1), decimals: data[9], source: a(0), mint: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 7: return { kind: "mintTo", program, amountRaw: u64(data, 1), decimals: null, mint: a(0), destination: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 14: return { kind: "mintTo", program, amountRaw: u64(data, 1), decimals: data[9], mint: a(0), destination: a(1), authority: a(2), decoderVersion: DECODER_VERSION };
      case 6: {
        const authorityType = AUTHORITY_TYPES[data[1]] ?? `type:${data[1]}`;
        const newAuthority = data[2] === 1 ? new PublicKey(data.subarray(3, 35)).toBase58() : null;
        return { kind: "setAuthority", program, authorityType, target: a(0), currentAuthority: a(1), newAuthority, decoderVersion: DECODER_VERSION };
      }
      default: return { kind: "unsupported", program, reason: `token instruction ${tag} not supported`, dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
    }
  } catch (e) {
    return { kind: "unsupported", program, reason: `malformed data: ${(e as Error).message}`, dataHex: ix.dataHex, decoderVersion: DECODER_VERSION };
  }
}
