import { formatUnits } from './token-layout';

/** A mutable fact, with the exact value and the read that established it. */
export type StateFact = { id: string; label: string; value: string; raw: string | null; slot: number | null; evidenceIds: string[] };
export function amountFact(id: string, label: string, raw: bigint | null, decimals: number | null, slot: number | null, evidenceIds: string[]): StateFact {
  return { id, label, value: raw == null ? 'Unavailable' : decimals == null ? `${raw} raw (decimals unknown)` : formatUnits(raw, decimals), raw: raw?.toString() ?? null, slot, evidenceIds };
}
