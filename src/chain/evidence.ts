import { createHash } from "node:crypto";

export type Evidence = {
  id: string;            // sha256(method + canonical params + responseSha256)
  method: string;
  params: unknown;
  slot: number | null;   // context slot when the RPC returns one
  retrievedAt: string;   // ISO-8601 UTC
  rpcUrl: string;
  responseSha256: string;
  source: "rpc" | "fixture";
};

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString()
    : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v);
}

export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

export function fixtureKey(method: string, params: unknown): string {
  return `${method}-${sha256(canonical(params)).slice(0, 12)}`;
}
