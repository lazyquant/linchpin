export const CLAIM_WINDOW_MS = 3_600_000;
export interface IdleClaim { text: string; lowPpm: number; highPpm: number; definition: "unallocated-buffer/total-assets" }
export interface ClaimComparison { result: "not-comparable" | "below-claimed-range" | "above-claimed-range" | "within-claimed-range"; reason: "claim-missing" | "observation-missing" | "time-window-mismatch" | null }
export function parseIdleClaim(markdown: string): IdleClaim | null {
  const m = /A typical vault holds (\d{1,2})[–-](\d{1,2})% of total assets in the buffer\./.exec(markdown);
  if (!m || Number(m[1]) > Number(m[2])) return null;
  return { text: m[0], lowPpm: Number(m[1]) * 10000, highPpm: Number(m[2]) * 10000, definition: "unallocated-buffer/total-assets" };
}
export function compareIdleClaim(claim: IdleClaim | null, observedPpm: bigint | number | string | null, claimRetrievedAt: string, observationRetrievedAt: string): ClaimComparison {
  if (claim === null) return { result: "not-comparable", reason: "claim-missing" };
  if (observedPpm === null) return { result: "not-comparable", reason: "observation-missing" };
  const delta = Math.abs(Date.parse(claimRetrievedAt) - Date.parse(observationRetrievedAt));
  if (!Number.isFinite(delta) || delta > CLAIM_WINDOW_MS) return { result: "not-comparable", reason: "time-window-mismatch" };
  const value = BigInt(observedPpm);
  return { result: value < BigInt(claim.lowPpm) ? "below-claimed-range" : value > BigInt(claim.highPpm) ? "above-claimed-range" : "within-claimed-range", reason: null };
}
