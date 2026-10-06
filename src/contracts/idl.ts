import { PublicKey } from "@solana/web3.js";
import { inflateSync } from "node:zlib";
import { sha256 } from "../chain/evidence";
import type { RecordingRpc } from "../chain/rpc";

export type IdlType =
  | "bool" | "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64"
  | "u128" | "i128" | "f32" | "f64" | "string" | "bytes" | "publicKey"
  | { vec: IdlType } | { option: IdlType } | { coption: IdlType }
  | { array: [IdlType, number] } | { defined: string };
export type IdlField = { name: string; type: IdlType; docs?: string[] };
export type IdlTypeDefinition =
  | { kind: "struct"; fields: IdlField[] }
  | { kind: "enum"; variants: { name: string; fields?: IdlField[] | IdlType[] }[] };
export type IdlTypeDef = { name: string; type: IdlTypeDefinition; docs?: string[] };
export type IdlInstructionAccount =
  | { name: string; isMut: boolean; isSigner: boolean; isOptional?: boolean; docs?: string[] }
  | { name: string; accounts: IdlInstructionAccount[] };
export type IdlInstruction = { name: string; accounts: IdlInstructionAccount[]; args: IdlField[]; docs?: string[]; returns?: IdlType };
export type LegacyIdl = { version: string; name: string; instructions: IdlInstruction[]; accounts?: IdlTypeDef[]; types?: IdlTypeDef[] };

export function idlAddress(programId: PublicKey): Promise<PublicKey> {
  return PublicKey.createWithSeed(PublicKey.findProgramAddressSync([], programId)[0], "anchor:idl", programId);
}

export type OnChainIdl = {
  kind: "idl"; program: string; idlAddress: string; authority: string; idl: LegacyIdl;
  idlSha256: string; dataLength: number; slot: number | null; evidenceIds: string[];
} | { kind: "no-idl"; program: string; idlAddress: string; slot: number | null; evidenceIds: string[] };

export async function readOnChainIdl(rpc: Pick<RecordingRpc, "getAccountInfo">, programId: PublicKey): Promise<OnChainIdl> {
  const address = await idlAddress(programId);
  const read = await rpc.getAccountInfo(address);
  const base = { program: programId.toBase58(), idlAddress: address.toBase58(), slot: read.evidence.slot, evidenceIds: [read.evidence.id] };
  if (!read.value) return { kind: "no-idl", ...base };
  const data = read.value.data;
  if (!read.value.owner.equals(programId)) throw new Error(`IDL ${address}: unexpected owner ${read.value.owner}`);
  if (data.length < 44) throw new Error(`IDL ${address}: truncated header (need 44 bytes, got ${data.length})`);
  const dataLength = data.readUInt32LE(40);
  if (dataLength > data.length - 44) throw new Error(`IDL ${address}: compressed length ${dataLength} exceeds account data`);
  let json: Buffer;
  try { json = inflateSync(data.subarray(44, 44 + dataLength)); }
  catch (error) { throw new Error(`IDL ${address}: inflate failed`, { cause: error }); }
  let idl: LegacyIdl;
  try { idl = JSON.parse(json.toString("utf8")); }
  catch (error) { throw new Error(`IDL ${address}: JSON parsing failed`, { cause: error }); }
  if (!idl || typeof idl.name !== "string" || typeof idl.version !== "string" || !Array.isArray(idl.instructions))
    throw new Error(`IDL ${address}: unsupported legacy IDL structure`);
  return { kind: "idl", ...base, authority: new PublicKey(data.subarray(8, 40)).toBase58(), idl, idlSha256: sha256(json), dataLength };
}
