import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { BorshReader } from "./borsh";
import type { LegacyIdl } from "./idl";

export const accountDiscriminator = (name: string): Buffer => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

export function decodeAccountAs(idl: LegacyIdl, name: string, data: Uint8Array) {
  const def = idl.accounts?.find(a => a.name === name);
  if (!def) throw new Error(`${name}: unknown account type`);
  if (data.length < 8 || !accountDiscriminator(name).equals(data.subarray(0, 8))) throw new Error(`${name}: account discriminator mismatch`);
  const reader = new BorshReader(idl, data.subarray(8));
  const value = reader.readDefinition(def.type, name);
  const bytesRead = 8 + reader.offset;
  return { type: name, value, bytesRead, trailingBytes: data.length - bytesRead };
}

export function decodeAccount(idl: LegacyIdl, data: Uint8Array) {
  const def = idl.accounts?.find(a => data.length >= 8 && accountDiscriminator(a.name).equals(data.subarray(0, 8)));
  if (!def) throw new Error(`account: unknown discriminator ${Buffer.from(data.subarray(0, 8)).toString("hex")}`);
  return decodeAccountAs(idl, def.name, data);
}

export type PlainValue = null | boolean | number | string | PlainValue[] | { [key: string]: PlainValue };
export function toPlain(value: unknown): PlainValue {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toPlain(v)]));
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new Error(`Cannot convert ${String(value)} to JSON-safe value`);
}
