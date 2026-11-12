import type { EvidenceStore, EvidenceSnapshot } from '../../engine/queries/snapshot';
import type { Fact } from '../../engine/contracts';
import { jsonRecord } from '../../policy/registry';
const PRIVATE_FIELDS = new Set(['quantity', 'positionRef', 'positions', 'fixtureKind', 'inScope', 'holder']);
/** Project before serialization; private evidence and references to it are removed together. */
export function projectPublic(value: unknown): unknown {
  const removed = new Set<string>();
  function collect(v: unknown): void {
    if (Array.isArray(v)) v.forEach(collect);
    else if (jsonRecord(v)) { if (v.privacy === 'private' && typeof v.id === 'string') removed.add(v.id); Object.values(v).forEach(collect); }
  }
  collect(value);
  function walk(v: unknown): unknown {
    if (typeof v === 'string' && removed.has(v)) return undefined;
    if (Array.isArray(v)) return v.map(walk).filter(x => x !== undefined);
    if (!jsonRecord(v)) return v;
    if (v.privacy === 'private') return undefined;
    if (Array.isArray(v.evidenceIds) && v.evidenceIds.some(id => removed.has(String(id)))) return undefined;
    const verdict = typeof v.policyId === 'string' && Array.isArray(v.rules);
    return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, verdict && k === 'rules' ? (item as unknown[]).map(r => {
      if (!jsonRecord(r)) return walk(r); const { evidence: _e, ...rest } = r; return walk(rest);
    }) : walk(item)]).filter(([, v]) => v !== undefined));
  }
  return walk(value) ?? {};
}
export function assertPublicResponse(value: unknown): void {
  if (typeof value === 'string') { if (value.includes('#holder:')) throw new Error('private-response'); return; }
  if (Array.isArray(value)) { value.forEach(assertPublicResponse); return; }
  if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(key) || key === 'privacy' && v === 'private') throw new Error('private-response');
    assertPublicResponse(v);
  }
}

/** Filter before queries derive role lists or other scalar summaries from evidence. */
export function publicEvidenceStore(store: EvidenceStore): EvidenceStore {
  const cache = new Map<string, EvidenceSnapshot>();
  const factPublic = (f: Fact) => f.privacy === 'public' && !f.subject.includes('#holder:') && !f.object.includes('#holder:')
    && f.evidenceIds.every(id => store.receipt(id)?.privacy === 'public');
  const snapshot = (id: string): EvidenceSnapshot | undefined => {
    const found = cache.get(id); if (found) return found;
    const raw = store.snapshot(id); if (!raw) return undefined;
    const subjects = raw.subjects.filter(s => !s.includes('#holder:'));
    const value = { ...raw, subjects, facts: raw.facts.filter(factPublic), receipts: raw.receipts.filter(r => r.privacy === 'public'), names: Object.fromEntries(Object.entries(raw.names).filter(([k]) => subjects.includes(k))) };
    cache.set(id, value); return value;
  };
  return { snapshot, receipt(id) { const r = store.receipt(id); return r?.privacy === 'public' ? r : undefined; },
    factsFrom(id, subject) { return snapshot(id)?.facts.filter(f => f.subject === subject) ?? []; },
    snapshotsForReceipt(id) { return store.receipt(id)?.privacy === 'public' ? store.snapshotsForReceipt(id).flatMap(s => snapshot(s.id) ?? []) : []; },
  };
}
