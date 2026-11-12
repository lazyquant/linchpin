import { PublicKey } from "@solana/web3.js";
import { sha256 } from "../../chain/evidence";
import { accountBytes, decodeReserve, decodeMarket, isDecodeFailure, type AccountRecord, type DecodeFailure } from "../kamino/layout";
import { KLEND_PROGRAM, SQUADS_PROGRAM } from "./constants";
export { accountBytes, decodeProgram, decodeProgramDataHead, decodeSquadsMultisig, isDecodeFailure } from "../kamino/layout";
export type { AccountRecord, DecodeFailure } from "../kamino/layout";
const key = (b: Buffer, offset: number) => new PublicKey(b.subarray(offset, offset + 32)).toBase58();
function decode<T>(fn: () => T): T | DecodeFailure { try { return fn(); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : "Invalid account" }; } }
export function decodeLendReserve(a: unknown) { const r = decodeReserve(a); return isDecodeFailure(r) ? r : { ...r, tokenProgram: key(accountBytes(a), 408) }; }
export function decodeLendMarket(a: unknown) { const m = decodeMarket(a); return isDecodeFailure(m) ? m : { ...m, emergencyCouncil: key(accountBytes(a), 160), proposerAuthority: key(accountBytes(a), 3312) }; }
export function decodeGlobalConfig(a: unknown) { return decode(() => { const b = accountBytes(a); if ((a as AccountRecord).owner !== KLEND_PROGRAM || b.length !== 1032 || !b.subarray(0,8).equals(Buffer.from(sha256("account:GlobalConfig"), "hex").subarray(0,8))) throw new Error("Invalid GlobalConfig"); return { globalAdmin: key(b,8), feeCollector: key(b,72) }; }); }
export function decodeMintHead(a: unknown) { return decode(() => { const b = accountBytes(a); if (!["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes((a as AccountRecord).owner) || b.length < 82 || b[45] !== 1) throw new Error("Invalid mint"); const authority = (o: number) => { const tag = b.readUInt32LE(o); if (tag > 1) throw new Error("Invalid mint option"); return tag === 0 ? null : key(b,o+4); }; return { decimals: b[44]!, mintAuthority: authority(0), freezeAuthority: authority(46) }; }); }
export const squadsVaultPda = (ms: string, index = 0) => PublicKey.findProgramAddressSync([Buffer.from("multisig"), new PublicKey(ms).toBuffer(), Buffer.from("vault"), Buffer.from([index])], new PublicKey(SQUADS_PROGRAM))[0].toBase58();
export const globalConfigAddress = () => PublicKey.findProgramAddressSync([Buffer.from("global_config")], new PublicKey(KLEND_PROGRAM))[0].toBase58();
export const marketAuthorityAddress = (market: string) => PublicKey.findProgramAddressSync([Buffer.from("lma"), new PublicKey(market).toBuffer()], new PublicKey(KLEND_PROGRAM))[0].toBase58();
