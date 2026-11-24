import { canonical } from "../../chain/evidence";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { factsToResult, graphResult } from "../../ui/adapters";
import type { AnyResult, Cell, ResultRow, ResultSet } from "../../ui/types";
import { record } from "./errors";
import type { AskInput, AttestationMeta, NearAgentContext, ResponseBinding, SessionResult, SurfaceInput } from "./types";

export function coverageResult(id: string, notes: string[]): ResultSet {
  return { resultId: id, shape: "table", columns: [], coverage: "not-mapped", coverageNotes: [...new Set(notes)], rows: [], truncated: false };
}
export function reasonNotes(value: unknown): string[] {
  const notes = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (record(v)) {
      if (typeof v.code === "string" && Object.hasOwn(v, "subject") && Object.hasOwn(v, "ref")) notes.add(canonical(v));
      Object.values(v).forEach(visit);
    }
  };
  visit(value); return [...notes].sort();
}
function observed(receipts: EvidenceReceipt[]): { asOf: string | null; blockOrSlot: string | null } {
  const dates = receipts.map(r => r.observation.observedAt).sort();
  const blocks = receipts.flatMap(r => r.observation.blockOrSlot === null ? [] : [r.observation.blockOrSlot]);
  let blockOrSlot = blocks[0] ?? null;
  if (blockOrSlot !== null && blocks.every(b => /^[0-9]+$/.test(b))) for (const block of blocks) if (BigInt(block) > BigInt(blockOrSlot)) blockOrSlot = block;
  return { asOf: dates.at(-1) ?? null, blockOrSlot };
}
function apiReceipt(id: string, source: string, hash: string, at: string): EvidenceReceipt {
  return { id, source, responseSha256: hash, privacy: "public", observation: { chain: "near-ai", network: "cloud", blockOrSlot: null, blockHash: null, observedAt: at, retrievedAt: at, historicalState: "unknown" } };
}
function metadataRow(key: string, values: Record<string, Cell>, receipts: EvidenceReceipt[], basis = "reported"): ResultRow {
  return { rowKind: "fact", key, values, factIds: [], bases: [basis], evidenceIds: receipts.map(r => r.id),
    ...observed(receipts), snapshotIds: [] };
}
function table(id: string, rows: ResultRow[], columns: ResultSet["columns"]): ResultSet {
  return { resultId: id, shape: "table", columns, coverage: rows.length ? "mapped" : "not-mapped", coverageNotes: [], rows, truncated: false };
}
function sessionTable(session: SessionResult, snapshotIds: string[]): ResultSet {
  const receipts = new Set(session.receipts.map(r => r.id));
  const valid = session.facts.filter(f => f.evidenceIds.length && f.evidenceIds.every(id => receipts.has(id)));
  const { result, skipped } = factsToResult(valid, session.receipts, { id: session.id, shape: "table", snapshotIds,
    columns: [{ name: "subject", role: "subject", field: "subject" }, { name: "predicate", role: "label", field: "predicate" },
      { name: "object", role: "value", field: "object" }, { name: "status", role: "status", field: "status" },
      { name: "observedAt", role: "time", field: "observedAt" }] });
  const notes = reasonNotes(session.value);
  if (valid.length !== session.facts.length || skipped.length) notes.push("Some source facts lack resolvable evidence.");
  if (session.truncated) notes.push("Model context was limited to a bounded projection. The recorded result is retained.");
  if (session.isError) notes.push(`Tool result: ${typeof session.value.error === "string" ? session.value.error : "tool-failed"}`);
  if (!result.rows.length) notes.push("This tool returned no fact rows in the loaded public store.");
  result.coverage = !result.rows.length ? "not-mapped" : notes.length ? "partial" : "mapped";
  result.coverageNotes = notes; result.truncated = session.truncated;
  return result;
}
export function buildSurfaceInput(context: NearAgentContext, input: AskInput, authoritative: Record<string, unknown> | null,
  sessions: readonly SessionResult[], attestation: AttestationMeta, binding: ResponseBinding): SurfaceInput {
  const snapshot = context.store.snapshot(context.snapshotId)!;
  const receipts = new Map<string, EvidenceReceipt>();
  for (const session of sessions) for (const r of session.receipts) receipts.set(r.id, r);
  const results: AnyResult[] = sessions.map(s => sessionTable(s, [...context.snapshotIds]));
  const notes = authoritative ? reasonNotes(authoritative) : [];
  const seed = sessions[0], facts = new Map(sessions.flatMap(s => s.facts).map(f => [f.id, f]));
  const verdict = authoritative && record(authoritative.verdict) ? authoritative.verdict : authoritative;
  const rawRules = authoritative && Array.isArray(authoritative.applicable) ? authoritative.applicable : verdict && Array.isArray(verdict.rules) ? verdict.rules : [];
  const rules: ResultRow[] = [];
  for (const r of rawRules) {
    if (!record(r) || typeof r.ruleId !== "string" || typeof r.outcome !== "string") continue;
    const ids = Array.isArray(r.receiptIds) ? r.receiptIds.filter((v): v is string => typeof v === "string") : [];
    const factIds = Array.isArray(r.factIds) ? r.factIds.filter((v): v is string => typeof v === "string") : [];
    if (!ids.length || ids.some(id => !receipts.has(id)) || factIds.some(id => !facts.has(id))) {
      notes.push(`Rule ${r.ruleId}: ${r.outcome}; attached evidence is not available in this result.`); continue;
    }
    const used = ids.map(id => receipts.get(id)!);
    rules.push({ rowKind: r.outcome === "undetermined" ? "unknown" : "fact", key: r.ruleId,
      values: { rule: r.ruleId, outcome: r.outcome, status: r.outcome === "undetermined" || factIds.some(id => facts.get(id)?.status !== "verified") ? "unverified" : "verified" },
      factIds, bases: ["derived"], evidenceIds: ids, ...observed(used), snapshotIds: [...context.snapshotIds] });
  }
  if (rawRules.length) results.push(table("policy_rules", rules, [{ name: "rule", role: "label" }, { name: "outcome", role: "status" }, { name: "status", role: "status" }]));
  if (authoritative && input.kind !== "control" && verdict) {
    const values: Record<string, Cell> = { policy: input.policyId,
      outcome: typeof verdict.outcome === "string" ? verdict.outcome : null,
      status: verdict.outcome === "undetermined" ? "unverified" : "verified" };
    if (input.kind === "preflight") { values.gate = typeof authoritative.gate === "string" ? authoritative.gate : null; values.action = canonical(input.action); }
    const usedIds = [...new Set(rules.flatMap(r => r.evidenceIds))], usedFacts = [...new Set(rules.flatMap(r => r.factIds))];
    if (usedIds.length) {
      const row = metadataRow("authoritative", values, usedIds.map(id => receipts.get(id)!), "derived");
      row.factIds = usedFacts; row.snapshotIds = [...context.snapshotIds];
      results.unshift(table("authority", [row], Object.keys(values).map(name => ({ name, role: name === "action" ? "value" : name === "gate" || name === "outcome" || name === "status" ? "status" : "label" }))));
    } else notes.push(`Authoritative tool result: ${canonical(values)}; attached rule evidence is unavailable.`);
  }
  if (authoritative && record(authoritative.graph) && Array.isArray(authoritative.graph.nodes) && Array.isArray(authoritative.graph.edges)) {
    const nodes = authoritative.graph.nodes.flatMap(n => record(n) && typeof n.id === "string" && typeof n.label === "string" ? [{ id: n.id, label: n.label, isolated: true }] : []).sort((a, b) => a.id.localeCompare(b.id));
    const edgeIds = new Set(authoritative.graph.edges.flatMap(e => record(e) && typeof e.factId === "string" ? [e.factId] : []));
    const graph = graphResult(nodes.slice(0, 60), (seed?.facts ?? []).filter(f => edgeIds.has(f.id)), { id: "authority_graph", receipts: [...receipts.values()] });
    if (nodes.length > 60 || graph.skipped.length) {
      graph.result.coverage = "partial";
      graph.result.coverageNotes.push("The drawn graph is a bounded view; the complete authoritative graph is retained.");
      graph.result.truncated = true;
    }
    results.push(graph.result);
  }
  const unknownFacts: Fact[] = [...facts.values()].filter(f => f.object === "unknown" || f.basis === "unknown");
  const unknowns = factsToResult(unknownFacts, [...receipts.values()], { id: "unknown_facts", shape: "unknowns", snapshotIds: [...context.snapshotIds] });
  if (unknowns.result.rows.length) results.push(unknowns.result);
  if (sessions.some(s => s.truncated)) notes.push("The model received bounded context; complete recorded results remain in the authoritative answer.");
  if (!notes.length && !unknownFacts.length) notes.push("The selected public tool reported no additional coverage reason.");
  results.push(coverageResult("authority_gaps", notes));

  if (attestation.reportSha256 && attestation.source && attestation.observedAt) {
    const receipt = apiReceipt(`nai:report:${attestation.reportSha256}`, attestation.source, attestation.reportSha256, attestation.observedAt);
    receipts.set(receipt.id, receipt);
    results.push(table("attestation", [metadataRow("capture", { hardware: attestation.status, status: "unverified", source: attestation.source,
      hash: attestation.reportSha256, reports: attestation.modelReportCount, nonce: attestation.nonce, code: attestation.code }, [receipt])],
    [{ name: "hardware", role: "status" }, { name: "status", role: "status" }, { name: "hash", role: "value" }, { name: "source", role: "address" }, { name: "reports", role: "value" }, { name: "code", role: "note" }]));
  } else results.push(coverageResult("attestation", [`Hardware attestation: ${attestation.status}. ${attestation.code ?? "Report unavailable"}`]));
  const bindingRows: ResultRow[] = [], bindingNotes: string[] = [];
  for (const [i, check] of binding.turns.entries()) {
    if (check.signatureSha256 && check.source && check.observedAt) {
      const receipt = apiReceipt(`nai:signature:${check.signatureSha256}`, check.source, check.signatureSha256, check.observedAt);
      receipts.set(receipt.id, receipt);
      const fields: Record<string, Cell> = { kind: check.signatureKind, requestHash: check.requestSha256,
        responseHash: check.responseSha256, code: check.code };
      for (const [field, value] of Object.entries(fields)) bindingRows.push(metadataRow(`binding-${i}-${field}`,
        { state: check.status, status: "unverified", field, value }, [receipt], "derived"));
    } else bindingNotes.push(`Response binding: ${check.status}. ${check.code ?? "Signature unavailable"}`);
  }
  if (!binding.turns.length) bindingNotes.push("Response binding is unavailable for this answer.");
  const bindingResult = bindingRows.length ? table("binding", bindingRows, [{ name: "state", role: "status" }, { name: "status", role: "status" },
    { name: "field", role: "label" }, { name: "value", role: "value" }]) : coverageResult("binding", bindingNotes);
  if (bindingRows.length && bindingNotes.length) { bindingResult.coverage = "partial"; bindingResult.coverageNotes = bindingNotes; }
  results.push(bindingResult);
  const receiptRows = [...receipts.values()].map(r => metadataRow(r.id, { id: r.id, source: r.source, responseHash: r.responseSha256 }, [r]));
  results.push(table("receipts", receiptRows, [{ name: "id", role: "address" }, { name: "source", role: "address" }, { name: "responseHash", role: "value" }]));
  return { input, authoritative, sessions, results, receipts: [...receipts.values()], attestation, binding,
    meta: { title: "NEAR evidence", protocolTitle: "NEAR", question: input.kind === "control" ? `Recorded control of ${input.subject}` : input.kind === "policy" ? `Recorded policy ${input.policyId}` : `Recorded preflight under ${input.policyId}`,
      ...(input.kind === "control" ? { subjectId: input.subject } : {}), snapshotIds: [...context.snapshotIds], fromBlockOrSlot: snapshot.fromBlockOrSlot,
      toBlockOrSlot: snapshot.toBlockOrSlot, capturedAt: snapshot.observedTo, constructed: snapshot.constructed } };
}
