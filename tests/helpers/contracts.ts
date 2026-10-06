import { PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { accountDiscriminator } from "../../src/contracts/decode";
import type { IdlType, LegacyIdl } from "../../src/contracts/idl";
import { fixtureKey } from "../../src/chain/evidence";

export const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
export const vector = (name: string): LegacyIdl => JSON.parse(readFileSync(new URL(`../vectors/idl/${name}.json`, import.meta.url), "utf8"));
/** Test-only IDL writer. Values omitted by a test are zero/default, in declared field order. */
export function accountBytes(idl: LegacyIdl, name: string, values: Record<string, any> = {}) {
  function encode(type: IdlType, value: any): Buffer {
    if (typeof type === "object") {
      if ("defined" in type) {
        const d = [...(idl.types ?? []), ...(idl.accounts ?? [])].find(d => d.name === type.defined)!.type;
        if (d.kind === "struct") return Buffer.concat(d.fields.map(f => encode(f.type, value?.[f.name])));
        const index = value?.variant ? d.variants.findIndex(v => v.name === value.variant) : 0;
        if (index < 0) throw new Error("unknown test variant");
        return Buffer.concat([Buffer.from([index]), ...(d.variants[index].fields ?? []).map((f, i) => typeof f === "object" && "name" in f ? encode(f.type, value?.fields?.[f.name]) : encode(f as IdlType, value?.fields?.[i]))]);
      }
      if ("array" in type) return Buffer.concat(Array.from({ length: type.array[1] }, (_, i) => encode(type.array[0], value?.[i])));
      if ("vec" in type) return Buffer.concat([encode("u32", value?.length ?? 0), ...(value ?? []).map((v: any) => encode(type.vec, v))]);
      if ("option" in type || "coption" in type) return Buffer.concat([encode("option" in type ? "u8" : "u32", value == null ? 0 : 1), ...(value == null ? [] : [encode("option" in type ? type.option : type.coption, value)])]);
    }
    if (type === "publicKey") return new PublicKey(value ?? key(0)).toBuffer();
    if (type === "bool") return Buffer.from([value ? 1 : 0]);
    if (type === "string" || type === "bytes") { const b = Buffer.from(value ?? ""); return Buffer.concat([encode("u32", b.length), b]); }
    if (typeof type === "string" && /^[ui](8|16|32|64|128)$/.test(type)) {
      const bytes = Number(type.slice(1)) / 8, b = Buffer.alloc(bytes); let n = BigInt.asUintN(bytes * 8, BigInt(value ?? 0));
      for (let i = 0; i < bytes; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b;
    }
    throw new Error(`unsupported test type ${JSON.stringify(type)}`);
  }
  return Buffer.concat([accountDiscriminator(name), encode({ defined: name }, values)]);
}
export function hasFixture(method: string, params: unknown) {
  const path = new URL(`../../fixtures/marinade-contracts/${fixtureKey(method, params)}.json`, import.meta.url);
  return existsSync(path) || existsSync(new URL(`${path}.gz`));
}
