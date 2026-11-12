import { evaluatePolicy, parsePolicy, PolicyRejected, type Policy, type PolicyContext } from '../../policy/index';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import { createNearRegistry, nearRoleOf } from './registry';
import { NO_LIBRARIES, type NearLibraries } from './libraries';
import { nearRootSubject } from './params';
export const POLICIES_DIR = new URL('../../../fixtures/near/policies/', import.meta.url);
export async function loadNearPolicy(idOrPath: string, libs: NearLibraries = NO_LIBRARIES, directory = POLICIES_DIR): Promise<Policy> {
  let input: unknown;
  try { input = await Bun.file(/^[a-z0-9][a-z0-9-]{0,63}$/.test(idOrPath) ? new URL(`${idOrPath}.json`, directory) : idOrPath).json(); }
  catch { throw new PolicyRejected('policy-not-found'); }
  const policy = parsePolicy(input, createNearRegistry(libs)); policy.subjects.forEach(nearRootSubject); return policy;
}
export function nearPolicyContext(store: EvidenceStore, snapshotId: string, libs: NearLibraries = NO_LIBRARIES): PolicyContext {
  const snap = store.snapshot(snapshotId);
  if (!snap) throw new PolicyRejected('missing-snapshot');
  return { snapshotId, evaluatedAt: snap.observedTo, registry: createNearRegistry(libs), roleOf: nearRoleOf, positions: [], price: () => null };
}
export function evaluateNearPolicy(policy: Policy, store: EvidenceStore, snapshotId: string, libs: NearLibraries = NO_LIBRARIES) {
  policy.subjects.forEach(nearRootSubject);
  return evaluatePolicy(policy, store, nearPolicyContext(store, snapshotId, libs));
}
export function referencedSnapshots(policy: Policy): string[] { return [...new Set(policy.rules.filter(r => r.kind === 'unchanged-since').map(r => String(r.params.snapshotId)))].sort(); }
export function assertNoNumbersOutsideEvidence(value: unknown): void {
  function walk(v: unknown, evidence = false): void {
    if (typeof v === 'number' && !evidence) throw new Error('numeric-field');
    if (Array.isArray(v)) v.forEach(x => walk(x, evidence));
    else if (v && typeof v === 'object') for (const [key, item] of Object.entries(v)) walk(item, evidence || key === 'evidence');
  }
  walk(value);
}
