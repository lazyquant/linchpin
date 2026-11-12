import { canonical } from '../../chain/evidence';
import type { Fact, QueryReason } from '../../engine/contracts';
import { runQuery } from '../../engine/queries/run';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import type { Policy } from '../../policy/types';
import { controlSurface, type NearControlSurface } from '../reader/control';
import { NEAR_TRAVERSAL_RELATIONS } from '../policy/registry';
export interface NearChain { root: string; facts: Fact[]; receiptIds: string[]; reasons: QueryReason[]; controls: NearControlSurface[] }
export const unique = <T>(values: T[]): T[] => [...new Map(values.map(v => [canonical(v), v])).values()];
export const ordered = (values: string[]) => [...new Set(values)].sort();
export function reviewRoots(policy: Policy): string[] {
  return ordered([...policy.subjects, 'near:mainnet:contract.main.burrow.near', 'near:mainnet:intents.near', 'near:mainnet:v1.signer']);
}
export function nearChain(store: EvidenceStore, snapshotId: string, root: string, query: typeof runQuery = runQuery): NearChain {
  const snapshot = store.snapshot(snapshotId); if (!snapshot) throw new Error('missing-snapshot');
  const predicates = new Set(snapshot.facts.map(f => f.predicate));
  const relations = NEAR_TRAVERSAL_RELATIONS.filter(r => predicates.has(r));
  const dependency = relations.length ? query(store, { name: 'dependencies', subject: root, relations, scope: { snapshotId, asOf: snapshot.observedTo, maxHops: 4, maxResults: 500 } }) : null;
  const subjects = ordered([root, ...(dependency?.facts ?? []).flatMap(f => [f.subject, f.object]).filter(s => snapshot.subjects.includes(s))]);
  const controls = subjects.map(s => controlSurface(store, snapshotId, s, snapshot.observedTo));
  const facts = [...new Map([...(dependency?.facts ?? []), ...controls.flatMap(c => c.results.flatMap(r => r.facts))].map(f => [f.id, f])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return { root, facts, receiptIds: ordered(facts.flatMap(f => f.evidenceIds)), reasons: unique([...(dependency?.reasons ?? []), ...controls.flatMap(c => c.reasons)]), controls };
}
