import type { ModelProjection, ReviewEnvelope } from "./contracts";

export function projectForModel(envelope: ReviewEnvelope, publicSubjects: readonly string[]): ModelProjection {
  const allowed = new Set(publicSubjects);
  const facts = new Set<string>();
  const unknowns = new Set<string>();
  const projection: ModelProjection = {
    request: { blueprintId: envelope.blueprintId, publicFacts: [], unknowns: [], maxOutputTokens: 0 },
    dropped: { facts: 0, unknowns: 0 },
  };
  for (const { result } of envelope.results) {
    for (const f of result.facts) {
      if (facts.has(f.id)) continue;
      facts.add(f.id);
      if (f.privacy !== "public" || !allowed.has(f.subject)
        || !f.evidenceIds.every(id => result.receipts.some(r => r.id === id && r.privacy === "public"))) {
        projection.dropped.facts++; continue;
      }
      projection.request.publicFacts.push({ id: f.id, subject: f.subject, predicate: f.predicate, object: f.object,
        basis: f.basis, status: f.status, evidenceIds: [...f.evidenceIds], path: [...f.path],
        validFrom: f.validFrom, validTo: f.validTo, privacy: f.privacy });
    }
    for (const r of result.reasons) {
      const key = `${r.code}:${r.subject ?? ""}`;
      if (unknowns.has(key)) continue;
      unknowns.add(key);
      if (r.subject !== null && allowed.has(r.subject)) projection.request.unknowns.push(key);
      else projection.dropped.unknowns++;
    }
  }
  return projection;
}
