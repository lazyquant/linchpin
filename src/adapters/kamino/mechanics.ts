import { PublicKey } from "@solana/web3.js";
export type EntityKind = "Vault" | "Reserve" | "Market" | "OracleSource" | "Program" | "ProgramData" | "Authority" | "Mint";
export interface Entity { id: string; kind: EntityKind; evidenceIds: string[]; controllerType?: "unknown" | "squads-v4-multisig" }
export const RELATION_ENDPOINTS = Object.freeze({
  ALLOCATES_TO: { from: ["Vault"], to: ["Reserve"] },
  IN_MARKET: { from: ["Reserve"], to: ["Market"] },
  PRICED_BY: { from: ["Reserve"], to: ["OracleSource"] },
  OWNER_PROGRAM: { from: ["Vault", "Reserve", "Market", "OracleSource"], to: ["Program"] },
  PROGRAM_DATA: { from: ["Program"], to: ["ProgramData"] },
  VAULT_ADMIN: { from: ["Vault"], to: ["Authority"] },
  ALLOCATION_ADMIN: { from: ["Vault"], to: ["Authority"] },
  MARKET_OWNER: { from: ["Market"], to: ["Authority"] },
  UPGRADE_AUTHORITY: { from: ["Program"], to: ["Authority"] },
  MULTISIG_MEMBER: { from: ["Authority"], to: ["Authority"] },
  CONFIG_AUTHORITY: { from: ["Authority"], to: ["Authority"] },
} satisfies Record<string, { from: EntityKind[]; to: EntityKind[] }>);
export type RelationKind = keyof typeof RELATION_ENDPOINTS;
export interface Relation { kind: RelationKind; from: string; to: string; evidenceIds: string[] }
export type Unit = "token-base-units" | "ctoken-base-units" | "bps" | "pct" | "ppm" | "weight" | "lamports" | "ratio";
export interface NamedQuantity { name: string; subject: string; value: string; unit: Unit; mint: string | null; decimals: number | null; window: string; basis: "decoded" | "reported" | "derived"; evidenceIds: string[]; inputs: string[]; asOfSlot: string | null }
export interface KaminoMechanics { entities: Entity[]; relations: Relation[]; quantities: NamedQuantity[] }
export class MechanicsRejected extends Error { constructor(readonly code: string) { super(`Mechanics rejected: ${code}`); this.name = "MechanicsRejected"; } }
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new MechanicsRejected(code); }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function exact(v: unknown, keys: string[], code = "schema"): asserts v is Record<string, unknown> {
  requireValue(object(v) && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)) && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => d.enumerable && "value" in d), code);
}
const ids = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)) && new Set(v).size === v.length;
const identity = (v: unknown) => { try { if (typeof v !== "string" || !v.startsWith("solana:mainnet-beta:")) return false; const key = v.slice(20); return new PublicKey(key).toBase58() === key; } catch { return false; } };
/** Returns an owned, validated model; endpoint kinds are checked before evidence is emitted. */
export function validateMechanics(input: unknown): KaminoMechanics {
  exact(input, ["entities", "relations", "quantities"]);
  requireValue(Array.isArray(input.entities) && Array.isArray(input.relations) && Array.isArray(input.quantities), "schema");
  const entities = new Map<string, EntityKind>();
  for (const e of input.entities) {
    requireValue(object(e), "schema"); exact(e, e.kind === "Authority" ? ["id", "kind", "evidenceIds", "controllerType"] : ["id", "kind", "evidenceIds"]);
    requireValue(identity(e.id) && ["Vault", "Reserve", "Market", "OracleSource", "Program", "ProgramData", "Authority", "Mint"].includes(e.kind as string) && ids(e.evidenceIds), "schema");
    if (e.kind === "Authority") requireValue(["unknown", "squads-v4-multisig"].includes(e.controllerType as string), "schema");
    requireValue(!entities.has(e.id as string), "duplicate-entity"); entities.set(e.id as string, e.kind as EntityKind);
  }
  for (const r of input.relations) {
    exact(r, ["kind", "from", "to", "evidenceIds"]);
    requireValue(typeof r.kind === "string" && typeof r.from === "string" && typeof r.to === "string" && ids(r.evidenceIds), "schema");
    requireValue(Object.hasOwn(RELATION_ENDPOINTS, r.kind), "unknown-relation");
    requireValue(entities.has(r.from) && entities.has(r.to), "unknown-entity");
    const rule = RELATION_ENDPOINTS[r.kind as RelationKind] as { from: readonly EntityKind[]; to: readonly EntityKind[] };
    requireValue(rule.from.includes(entities.get(r.from)!) && rule.to.includes(entities.get(r.to)!), "incompatible-endpoint");
  }
  const names = new Set<string>();
  for (const q of input.quantities) {
    exact(q, ["name", "subject", "value", "unit", "mint", "decimals", "window", "basis", "evidenceIds", "inputs", "asOfSlot"], "bad-quantity");
    requireValue(typeof q.name === "string" && q.name.length > 0 && !names.has(q.name) && identity(q.subject) && entities.has(q.subject as string), "bad-quantity"); names.add(q.name);
    requireValue(["token-base-units", "ctoken-base-units", "bps", "pct", "ppm", "weight", "lamports", "ratio"].includes(q.unit as string) && typeof q.value === "string" && (q.unit === "ratio" ? /^-?\d+(\.\d+)?$/ : /^\d+$/).test(q.value), "bad-quantity");
    const token = q.unit === "token-base-units" || q.unit === "ctoken-base-units";
    requireValue(token ? identity(q.mint) && Number.isInteger(q.decimals) && (q.decimals as number) >= 0 && (q.decimals as number) <= 18 : q.mint === null && q.decimals === null, "bad-quantity");
    requireValue(q.basis === "reported" ? ["current", "24h", "7d", "14d", "30d", "90d", "180d", "365d"].includes(q.window as string) : q.window === "point" || typeof q.window === "string" && /^\d+s$/.test(q.window), "bad-quantity");
    requireValue(typeof q.window === "string" && q.window.length > 0 && ["decoded", "reported", "derived"].includes(q.basis as string) && ids(q.evidenceIds) && Array.isArray(q.inputs) && q.inputs.every(v => typeof v === "string" && v.length > 0) && (q.basis === "derived" ? q.inputs.length > 0 : q.inputs.length === 0) && (q.asOfSlot === null || typeof q.asOfSlot === "string" && /^\d+$/.test(q.asOfSlot)), "bad-quantity");
  }
  for (const q of input.quantities as unknown as NamedQuantity[]) requireValue(q.inputs.every(name => names.has(name)), "bad-quantity");
  return structuredClone(input) as unknown as KaminoMechanics;
}
