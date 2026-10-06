import { PublicKey } from "@solana/web3.js";
import type { IdlField, IdlType, IdlTypeDefinition, LegacyIdl } from "./idl";

export type BorshValue = null | boolean | number | bigint | string | PublicKey | Uint8Array | BorshValue[] | { [key: string]: BorshValue };

/** Legacy Anchor Borsh, without account discriminators. Enum values use { variant, fields }. */
export class BorshReader {
  offset = 0;
  private remainingValues = 1_000_000;
  readonly data: Buffer;
  constructor(readonly idl: LegacyIdl, data: Uint8Array) { this.data = Buffer.from(data); }

  private take(size: number, path: string): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.data.length - this.offset)
      throw new Error(`${path}: read past end at byte ${this.offset} (need ${size}, have ${this.data.length - this.offset})`);
    const value = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  readDefinition(def: IdlTypeDefinition, path: string, depth = 0): BorshValue {
    if (depth > 128) throw new Error(`${path}: type nesting exceeds 128`);
    if (def.kind === "struct") return Object.fromEntries(def.fields.map(f => [f.name, this.read(f.type, `${path}.${f.name}`, depth + 1)]));
    if (def.kind === "enum") {
      const index = this.take(1, path)[0];
      const variant = def.variants[index];
      if (!variant) throw new Error(`${path}: unknown enum variant index ${index}`);
      const fields = variant.fields ?? [];
      if (!fields.length) return { variant: variant.name };
      const variantPath = `${path}.${variant.name}`;
      if (typeof fields[0] === "object" && "name" in fields[0])
        return { variant: variant.name, fields: Object.fromEntries((fields as IdlField[]).map(f => [f.name, this.read(f.type, `${variantPath}.${f.name}`, depth + 1)])) };
      return { variant: variant.name, fields: (fields as IdlType[]).map((t, i) => this.read(t, `${variantPath}[${i}]`, depth + 1)) };
    }
    throw new Error(`${path}: unknown type definition ${JSON.stringify(def)}`);
  }

  read(type: IdlType, path = "value", depth = 0): BorshValue {
    if (--this.remainingValues < 0) throw new Error(`${path}: decoding exceeds 1000000 values`);
    if (depth > 128) throw new Error(`${path}: type nesting exceeds 128`);
    if (typeof type === "string") {
      switch (type) {
        case "bool": {
          const tag = this.take(1, path)[0];
          if (tag > 1) throw new Error(`${path}: invalid bool tag ${tag}`);
          return tag === 1;
        }
        case "u8": return this.take(1, path).readUInt8();
        case "i8": return this.take(1, path).readInt8();
        case "u16": return this.take(2, path).readUInt16LE();
        case "i16": return this.take(2, path).readInt16LE();
        case "u32": return this.take(4, path).readUInt32LE();
        case "i32": return this.take(4, path).readInt32LE();
        case "u64": return this.take(8, path).readBigUInt64LE();
        case "i64": return this.take(8, path).readBigInt64LE();
        case "u128": case "i128": {
          const b = this.take(16, path);
          const v = b.readBigUInt64LE() | (b.readBigUInt64LE(8) << 64n);
          return type === "i128" ? BigInt.asIntN(128, v) : v;
        }
        case "f32": case "f64": {
          const v = type === "f32" ? this.take(4, path).readFloatLE() : this.take(8, path).readDoubleLE();
          if (!Number.isFinite(v)) throw new Error(`${path}: non-finite ${type}`);
          return v;
        }
        case "publicKey": return new PublicKey(this.take(32, path));
        case "string": case "bytes": {
          const b = this.take(this.take(4, path).readUInt32LE(), path);
          if (type === "bytes") return Buffer.from(b);
          try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
          catch { throw new Error(`${path}: invalid UTF-8 string`); }
        }
      }
    } else if (type && typeof type === "object") {
      if ("defined" in type) {
        const def = [...(this.idl.types ?? []), ...(this.idl.accounts ?? [])].find(t => t.name === type.defined);
        if (!def) throw new Error(`${path}: unknown defined type ${type.defined}`);
        return this.readDefinition(def.type, path, depth + 1);
      }
      if ("option" in type || "coption" in type) {
        const c = "coption" in type;
        const tag = c ? this.take(4, path).readUInt32LE() : this.take(1, path)[0];
        if (tag > 1) throw new Error(`${path}: invalid ${c ? "coption" : "option"} tag ${tag}`);
        return tag === 0 ? null : this.read(c ? type.coption : type.option, path, depth + 1);
      }
      if ("vec" in type || "array" in type) {
        const [element, length] = "vec" in type ? [type.vec, this.take(4, path).readUInt32LE()] : type.array;
        if (!Number.isSafeInteger(length) || length < 0 || length > this.remainingValues)
          throw new Error(`${path}: invalid or excessive collection length ${length}`);
        return Array.from({ length }, (_, i) => this.read(element, `${path}[${i}]`, depth + 1));
      }
    }
    throw new Error(`${path}: unknown type ${JSON.stringify(type)}`);
  }
}
