import type { EvidenceReceipt, QueryReason } from '../../engine/contracts';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import { runQuery } from '../../engine/queries/run';
import { projectVerdict, type Policy } from '../../policy/index';
import { evaluateNearPolicy, referencedSnapshots, type NearLibraries, readProposals, readLibraryReview } from '../policy/index';
import { historyFacts } from '../reader/history';
import { nearChain, ordered, reviewRoots, unique } from './chains';
/** Public representation uses decimal strings for descriptive numeric metadata. */
export type NumberStrings<T> = T extends number ? string : T extends (infer U)[] ? NumberStrings<U>[] : T extends object ? { [K in keyof T]: NumberStrings<T[K]> } : T;
export function numberStrings<T>(value: T): NumberStrings<T> {
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'number' ? String(v) : v));
}
export function buildNearReview(policy: Policy, store: EvidenceStore, snapshotId: string, libs: NearLibraries, deps: { query?: typeof runQuery; before?: string } = {}) {
  const s = store.snapshot(snapshotId); if (!s) throw new Error('missing-snapshot');
  const chains = reviewRoots(policy).map(root => nearChain(store, snapshotId, root, deps.query));
  const subjects = ordered(chains.flatMap(c => [c.root, ...c.facts.flatMap(f => [f.subject, f.object])]).filter(subject => s.subjects.includes(subject) && (!subject.includes('#') || subject.endsWith('.sputnik-dao.near'))));
  const history = subjects.map(subject => historyFacts(store, subject, snapshotId)).map(h => ({ ...h, events: h.events.filter(e => Date.parse(e.at) >= Date.parse(s.observedTo) - 90 * 86400000 && e.at <= s.observedTo) }));
  const governance = chains.map(c => ({ root: c.root, ...readProposals(libs, 'proposalsTouching', snapshotId, c.root) }));
  const intents = ordered(policy.rules.filter(r => r.kind === 'route-family-in').map(r => String(r.params.assetId))).map(assetId => ({ assetId, review: readLibraryReview(libs, 'intents', snapshotId, assetId) }));
  const verdict = evaluateNearPolicy(policy, store, snapshotId, libs), publicVerdict = projectVerdict(verdict, s.subjects);
  const query = deps.query ?? runQuery;
  const changes = deps.before ? chains.map(c => query(store, { name: 'changes', subject: c.root, beforeSnapshotId: deps.before!, afterSnapshotId: snapshotId, maxResults: 500 })) : [];
  const unknowns = unique([
    ...chains.flatMap(c => c.reasons), ...history.flatMap(h => h.reasons), ...changes.flatMap(c => c.reasons),
    ...governance.filter(g => g.coverageGap).map(g => ({ code: 'missing-coverage', subject: g.root, ref: 'library:near-governance-review' })),
    ...verdict.rules.filter(r => r.outcome === 'undetermined').flatMap(r => r.reasons.map(reason => ({ ...reason, ruleId: r.ruleId }))),
  ]);
  const usedFacts = new Set(verdict.rules.flatMap(r => r.factIds));
  const policyFacts = [...new Map([snapshotId, ...referencedSnapshots(policy)].flatMap(id => store.snapshot(id)?.facts ?? []).filter(f => usedFacts.has(f.id)).map(f => [f.id, f])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const receiptIds = ordered([...chains.flatMap(c => c.receiptIds), ...history.flatMap(h => h.events.flatMap(e => e.source.evidenceIds)), ...verdict.rules.flatMap(r => r.receiptIds), ...changes.flatMap(c => c.receipts.map(r => r.id))]);
  const receipts = receiptIds.map(id => store.receipt(id)).filter((r): r is EvidenceReceipt => !!r);
  const snapshot = { snapshotId: s.id, observedFrom: s.observedFrom, observedTo: s.observedTo, fromBlockOrSlot: s.fromBlockOrSlot, toBlockOrSlot: s.toBlockOrSlot, constructed: s.constructed, subjects: s.subjects };
  return { policyId: policy.policyId, snapshot, policyFacts, chains: numberStrings(chains), history: numberStrings(history), governance: numberStrings(governance), intents: numberStrings(intents), changes: numberStrings(changes), verdict, publicVerdict, unknowns, receipts, libraries: libs.status };
}
export type NearReview = ReturnType<typeof buildNearReview>;
