import type { Fact, RenderReviewInput, Review, ReviewClaim, ReviewEnvelope } from "./contracts";
import { canonical } from "../chain/evidence";
import { resultSha256 } from "./queries/run";
import { isReviewEnvelope } from "./schemas";

export const RENDERER_VERSION = "1";
export const BANNED_WORDS = Object.freeze(["should", "recommend", "safe", "unsafe", "score", "rating", "buy", "sell"]);
export type ReviewHeader = Omit<ReviewEnvelope, "results" | "review">;
type Entries = ReviewEnvelope["results"];
const unique = <T>(values: T[]): T[] => {
  const seen = new Set<string>();
  return values.filter(value => { const key = canonical(value); if (seen.has(key)) return false; seen.add(key); return true; });
};

/** The only claim templates. Their order follows result entries, then entry order. */
export function renderClaims(results: Entries): ReviewClaim[] {
  const claims: ReviewClaim[] = [];
  for (const { nodeId, request, result } of results) {
    if (request.name !== "changes") {
      result.facts.forEach((f, index) => {
        const obs = f.evidenceIds.map(id => {
          const r = result.receipts.find(r => r.id === id);
          return r ? `observed ${r.observation.observedAt} at slot ${r.observation.blockOrSlot ?? "unknown"}` : `receipt ${id} not returned`;
        }).join("; ");
        claims.push({ text: `Fact: ${f.subject} ${f.predicate} ${JSON.stringify(f.object)} (basis ${f.basis}, status ${f.status}; ${obs}).`,
          factIds: [f.id], evidenceIds: [...f.evidenceIds], kind: "fact", template: "fact", source: { nodeId, field: "facts", index } });
      });
    } else {
      result.changes.forEach((c, index) => {
        const describe = (f: Fact) => `${JSON.stringify(f.object)} (basis ${f.basis}, status ${f.status})`;
        const sides = [c.before, c.after].filter((f): f is Fact => f !== null);
        const text = c.kind === "added" ? `now ${describe(c.after!)}` : c.kind === "removed" ? `was ${describe(c.before!)}` : `from ${describe(c.before!)} to ${describe(c.after!)}`;
        claims.push({ text: `Change (${c.kind}): ${c.key} ${text} between ${request.beforeSnapshotId} and ${request.afterSnapshotId}.`,
          factIds: sides.map(f => f.id), evidenceIds: unique(sides.flatMap(f => f.evidenceIds)), kind: "fact", template: "change", source: { nodeId, field: "changes", index } });
      });
      if (result.outcome === "complete" && !result.changes.length && !result.reasons.length) {
        claims.push({ text: `Unchanged: no change for ${request.subject} between ${request.beforeSnapshotId} and ${request.afterSnapshotId} across ${result.facts.length} facts and ${result.receipts.length} receipts.`,
          factIds: result.facts.map(f => f.id), evidenceIds: result.receipts.map(r => r.id), kind: "fact", template: "unchanged", source: { nodeId, field: "result", index: null } });
      }
    }
    result.reasons.forEach((r, index) => claims.push({ text: `Unknown (${r.code}): subject ${r.subject ?? "none"}, ref ${r.ref ?? "none"}.`,
      factIds: [], evidenceIds: [], kind: "unknown", template: "unknown", source: { nodeId, field: "reasons", index } }));
  }
  return claims;
}
export function buildReview(results: Entries): Review {
  const claims = renderClaims(results);
  const privateCitation = claims.some(c => {
    const result = results.find(e => e.nodeId === c.source.nodeId)!.result;
    const facts = [...result.facts, ...result.changes.flatMap(c => [c.before, c.after].filter((f): f is Fact => f !== null))];
    return facts.some(f => c.factIds.includes(f.id) && f.privacy === "private")
      || result.receipts.some(r => c.evidenceIds.includes(r.id) && r.privacy === "private");
  });
  return {
    claims, unknowns: unique(results.flatMap(e => e.result.unknowns)), snapshotIds: unique(results.flatMap(e => e.result.snapshotIds)),
    observations: structuredClone(unique(results.flatMap(e => e.result.observations))), policy: "not-evaluated", privacy: privateCitation ? "private" : "public",
  };
}
export function renderReview(input: RenderReviewInput, header: ReviewHeader): ReviewEnvelope {
  const results = Object.keys(input).sort().map(key => ({ key, ...structuredClone(input[key]) }));
  return { ...header, results, review: buildReview(results) };
}
export type ReviewValidation = { ok: true } | { ok: false; code: "schema" | "result-hash" | "interpretation" | "empty-evidence" | "unresolved-evidence" | "banned-word" | "claims-mismatch" | "review-mismatch" };
export function validateReview(envelope: unknown): ReviewValidation {
  if (!isReviewEnvelope(envelope)) return { ok: false, code: "schema" };
  const { results, review } = envelope;
  if (results.some(e => e.resultSha256 !== resultSha256(e.result))) return { ok: false, code: "result-hash" };
  if (review.claims.some(c => c.kind === "interpretation")) return { ok: false, code: "interpretation" };
  if (review.claims.some(c => c.kind === "fact" && !c.evidenceIds.length)) return { ok: false, code: "empty-evidence" };
  if (review.claims.some(c => c.evidenceIds.some(id => !results.find(e => e.nodeId === c.source.nodeId)?.result.receipts.some(r => r.id === id)))) return { ok: false, code: "unresolved-evidence" };
  const banned = new RegExp(`\\b(${BANNED_WORDS.join("|")})\\b`, "i");
  if (review.claims.some(c => banned.test(c.text.replace(/"(?:[^"\\]|\\.)*"/g, "")))) return { ok: false, code: "banned-word" };
  if (canonical(review.claims) !== canonical(renderClaims(results))) return { ok: false, code: "claims-mismatch" };
  if (canonical(review) !== canonical(buildReview(results))) return { ok: false, code: "review-mismatch" };
  return { ok: true };
}
