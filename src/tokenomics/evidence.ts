import type { EvidenceRecord, Provenance, Basis } from './api';

export const unique = <T>(values: T[]): T[] => [...new Set(values)];
/** Also used to verify that every nested citation has an evidence record. */
export function evidenceIds(value: unknown): string[] {
  const ids = new Set<string>();
  function visit(v: unknown) {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    for (const [key, child] of Object.entries(v)) {
      if (key === 'evidenceIds' && Array.isArray(child)) child.forEach(id => ids.add(String(id)));
      else visit(child);
    }
  }
  visit(value); return [...ids];
}
export class EvidenceIndex {
  readonly records: Map<string, EvidenceRecord>;
  constructor(records: EvidenceRecord[]) { this.records = new Map(records.map(r => [r.id, r])); }
  lookup(ids: string[]) {
    return { items: unique(ids).flatMap(id => this.records.has(id) ? [this.records.get(id)!] : []), missing: unique(ids).filter(id => !this.records.has(id)) };
  }
  metadata(ids: string[]) {
    const { items, missing } = this.lookup(ids);
    if (missing.length) throw new Error('Tokenomics has unresolved evidence references');
    const slots = items.flatMap(e => e.slot === null ? [] : [e.slot]);
    return { asOf: items.map(e => e.retrievedAt).sort().at(-1) ?? null,
      slotRange: slots.length ? [Math.min(...slots), Math.max(...slots)] as [number, number] : null, evidenceCount: items.length };
  }
  provenance(value: unknown, basis: Basis | Basis[] = 'derived'): Provenance {
    const ids = evidenceIds(value), meta = this.metadata(ids);
    return { basis, evidenceIds: ids, slot: meta.slotRange?.[1] ?? null, asOf: meta.asOf };
  }
}
