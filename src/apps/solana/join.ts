/**
 * Which recorded subject a read position is joined to. A reader reports an account of a holder; no fact links
 * that account to a protocol capture. The join below is a statement of this app, cited as scope and never as
 * evidence: its source is the registry entry it rests on.
 */
import { VAULT_TARGETS } from "../../adapters/kamino/constants";
import type { EvidenceSnapshot } from "../../engine/queries/snapshot";
import { SOLANA_REGISTRY } from "../../solana/positions/registry";
import { PREFIX } from "./model";

const REGISTRY = "src/solana/positions/registry.ts";

export interface JoinContext { marinade: EvidenceSnapshot; lend: EvidenceSnapshot; sentora: EvidenceSnapshot }
export interface Join { pack: string; series: string; account: string; snapshot: EvidenceSnapshot; source: string }

/** The join of one account key, or the source line that says nothing joins it. */
export function joinOf(key: string, context: JoinContext): { join: Join | null; source: string } {
  const token = SOLANA_REGISTRY.tokens.find((entry) => entry.mint === key);
  if (token?.id === "kvault-share") {
    const source = `${REGISTRY}, token "kvault-share" recorded at ${token.recordedAt.path} slot ${token.recordedAt.slot}; the share mint is joined to its vault by this entry, not by a fact`;
    return { join: { pack: "kamino-vaults", series: "sentora-pyusd", account: `${PREFIX}${VAULT_TARGETS["sentora-pyusd"].vault}`, snapshot: context.sentora, source }, source };
  }
  if (token && context.marinade.subjects.includes(`${PREFIX}${key}`)) {
    const source = `${REGISTRY}, token "${token.id}" recorded at ${token.recordedAt.path} slot ${token.recordedAt.slot}; the mint is a subject of ${context.marinade.id}`;
    return { join: { pack: "marinade", series: "marinade", account: `${PREFIX}${key}`, snapshot: context.marinade, source }, source };
  }
  const reserve = SOLANA_REGISTRY.klendReserves.find((entry) => entry.reserve === key);
  if (reserve && context.lend.subjects.includes(`${PREFIX}${key}`)) {
    const source = `${REGISTRY}, reserve recorded at ${reserve.recordedAt.path} slot ${reserve.recordedAt.slot}; the reserve is a subject of ${context.lend.id}`;
    return { join: { pack: "kamino-lend", series: "main-market", account: `${PREFIX}${key}`, snapshot: context.lend, source }, source };
  }
  return { join: null, source: `${REGISTRY}: no entry joins this account to a recorded subject` };
}

/** The leg a position is: a deposit or a borrow of a registered reserve, by its unit; else a token balance. */
export function legOf(key: string, unit: string): string {
  const reserve = SOLANA_REGISTRY.klendReserves.find((entry) => entry.reserve === key);
  if (!reserve) return "token";
  return unit === reserve.collateralMint ? "klend-deposit" : "klend-borrow";
}
