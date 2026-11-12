import type { EvidenceReceipt, Fact, QueryReason } from "../../../src/engine/contracts";
import type { ExitItem, PolicyContext, PolicyEvidence, PolicyPosition, PredicateRole, PriceEvidence } from "../../../src/policy/index";

/** Evaluation instants and age boundaries used by the synthetic policy cases. */
export const AT = "2026-11-09T17:04:20.763Z";
/** Eight days and one millisecond after AT. */
export const EIGHT_DAYS_LATER = "2026-11-17T17:04:20.764Z";
/** Eight days before AT: older than a seven-day limit. */
export const STALE = "2026-10-31T17:04:20.763Z";
/** Exactly seven days before AT: the inclusive boundary, therefore fresh. */
export const SEVEN_DAYS_EXACT = "2026-11-02T17:04:20.763Z";

export const identity = (key: string) => `solana:mainnet-beta:${key}`;
export const X = identity("X".repeat(32));
export const Y = identity("Y".repeat(32));
export const Z = identity("Z".repeat(32));

export function receipt(id: string, observedAt: string = AT, historicalState: "current-only" | "constructed" = "current-only"): EvidenceReceipt {
  return {
    id,
    source: `synthetic:${id}`,
    responseSha256: "0".repeat(64),
    privacy: "public",
    observation: {
      chain: "solana",
      network: "mainnet-beta",
      blockOrSlot: null,
      blockHash: null,
      observedAt,
      retrievedAt: observedAt,
      historicalState,
    },
  };
}

export function fact(
  id: string,
  subject: string,
  predicate: string,
  object: string,
  evidenceIds: string[],
  overrides: Partial<Fact> = {},
): Fact {
  return {
    id,
    subject,
    predicate,
    object,
    basis: "decoded",
    status: "verified",
    evidenceIds,
    path: [],
    validFrom: null,
    validTo: null,
    privacy: "public",
    ...overrides,
  };
}

export interface SyntheticSnapshot {
  id: string;
  subjects: string[];
  constructed?: boolean;
  receipts: EvidenceReceipt[];
  facts: Fact[];
}

/** A structural evidence store over plain synthetic snapshots; no engine code is involved. */
export function buildStore(snapshots: SyntheticSnapshot[]): PolicyEvidence {
  return {
    snapshot: (id) => {
      const s = snapshots.find((x) => x.id === id);
      return s && { id: s.id, subjects: [...s.subjects], constructed: s.constructed ?? false };
    },
    receipt: (id) => snapshots.flatMap((s) => s.receipts).find((r) => r.id === id),
    factsFrom: (snapshotId, subject) => snapshots.find((s) => s.id === snapshotId)?.facts.filter((f) => f.subject === subject) ?? [],
  };
}

export const roleOf = (predicate: string): PredicateRole | undefined => {
  if (predicate === "CONTROLLED_BY" || predicate === "VAULT_ADMIN" || predicate === "ALLOCATION_ADMIN") return "control";
  if (predicate === "PRICED_BY") return "oracle";
  if (predicate === "IDLE_RAW") return "idle";
  if (predicate === "AVAILABLE_LIQUIDITY_RAW") return "available-liquidity";
  if (predicate === "BORROWED_RAW") return "utilization-input";
  if (predicate === "DEPENDS_ON") return "dependency";
  if (predicate === "SUPPLY_RAW") return "state";
  return undefined;
};

export function position(input: {
  ref?: string;
  subject?: string;
  facts?: Fact[];
  exit?: ExitItem[];
  reasons?: QueryReason[];
  chainNull?: boolean;
  quantity?: string;
  unit?: string;
  inScope?: boolean;
} = {}): PolicyPosition {
  const ref = input.ref ?? "p1";
  return {
    positionRef: ref,
    subject: input.subject ?? X,
    quantity: input.quantity ?? "1",
    unit: input.unit ?? "u",
    inScope: input.inScope ?? true,
    chain: input.chainNull
      ? null
      : { snapshotId: "s1", facts: input.facts ?? [], reasons: input.reasons ?? [], exit: input.exit ?? [] },
  };
}

export function context(input: {
  positions: PolicyPosition[];
  snapshotId?: string;
  evaluatedAt?: string;
  registry: PolicyContext["registry"];
  price?: (unit: string) => PriceEvidence | null;
}): PolicyContext {
  return {
    evaluatedAt: input.evaluatedAt ?? AT,
    snapshotId: input.snapshotId ?? "s1",
    registry: input.registry,
    roleOf,
    positions: input.positions,
    price: input.price ?? (() => null),
  };
}

export function exitItem(role: ExitItem["role"], subject: string, receiptIds: string[], factIds: string[] = []): ExitItem {
  return { role, subject, name: `${role}:${receiptIds.join(",")}`, factIds, receiptIds };
}

/** Collect every receipt id referenced by any evidence-bearing field of a value. */
export function citedReceiptIds(value: unknown): string[] {
  const ids = new Set<string>();
  const citationKeys = new Set(["evidenceIds", "receiptIds", "claimEvidenceIds", "observationEvidenceIds"]);
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, inner] of Object.entries(node)) {
        if (citationKeys.has(key) && Array.isArray(inner)) inner.forEach((id) => typeof id === "string" && ids.add(id));
        else walk(inner);
      }
    }
  };
  walk(value);
  return [...ids].sort();
}

export function walkJson(value: unknown, visit: (value: unknown, path: string[]) => void, path: string[] = []): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walkJson(item, visit, [...path, String(index)]));
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) walkJson(inner, visit, [...path, key]);
}
