import { canonical } from '../../chain/evidence';
import { projectVerdict, type Policy, type Outcome, type PublicRuleResult, type RuleSpec } from '../../policy/index';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import { evaluateNearPolicy, type NearLibraries } from '../policy/index';
import { parseAction, type PreflightAction } from './action';
import { touchedSubjects } from './touched';
import { buildGraph, type PreflightNode, type PreflightEdge } from './graph';
export type Gate = 'open' | 'closed' | 'human';
export interface PreflightReason { code: string; subject: string | null; ref: string | null }
export interface PreflightContext { store: EvidenceStore; snapshotId: string; libs: NearLibraries }
export interface PreflightResult {
  schema: 'linchpin.preflight/1'; action: PreflightAction; policyId: string; snapshotId: string; evaluatedAt: string;
  touched: string[]; applicable: PublicRuleResult[]; notApplicable: string[]; unknowns: PreflightReason[];
  outcome: Outcome; gate: Gate; graph: { nodes: PreflightNode[]; edges: PreflightEdge[] };
}
export function named(rule: RuleSpec): string[] {
  const p = rule.params;
  return [p.contract, p.account, p.dao, p.subject, ...(Array.isArray(p.accounts) ? p.accounts : []),
    ...(rule.kind === 'unchanged-since' && Array.isArray(p.factKeys) ? p.factKeys.filter((v): v is string => typeof v === 'string').map(v => v.split('|')[0]) : [])].filter((v): v is string => typeof v === 'string');
}
export function worst(outcomes: Outcome[]): Outcome { return outcomes.includes('outside-policy') ? 'outside-policy' : outcomes.includes('undetermined') ? 'undetermined' : 'within-policy'; }
export function preflight(input: unknown, policy: Policy, ctx: PreflightContext): PreflightResult {
  const action = parseAction(input), snapshot = ctx.store.snapshot(ctx.snapshotId);
  if (!snapshot) throw new Error('missing-snapshot');
  const { touched, unknowns: raw } = touchedSubjects(action, ctx);
  const assets = action.kind === 'intents-swap' ? [action.originAsset, action.destinationAsset] : [];
  const rules = policy.rules.filter(r => named(r).some(s => touched.includes(s)) || typeof r.params.assetId === 'string' && assets.includes(r.params.assetId));
  const applicable = rules.length ? projectVerdict(evaluateNearPolicy({ ...policy, rules }, ctx.store, ctx.snapshotId, ctx.libs), snapshot.subjects).rules : [];
  if (!rules.length) raw.push({ code: 'no-applicable-rule', subject: null, ref: policy.policyId });
  const unknowns = [...new Map(raw.map(r => [canonical(r), r])).values()].sort((a, b) => a.code.localeCompare(b.code) || (a.subject ?? '').localeCompare(b.subject ?? '') || (a.ref ?? '').localeCompare(b.ref ?? '') || canonical(a).localeCompare(canonical(b)));
  const outcome = worst([...applicable.map(r => r.outcome), ...(unknowns.length ? ['undetermined' as const] : [])]);
  return { schema: 'linchpin.preflight/1', action, policyId: policy.policyId, snapshotId: ctx.snapshotId, evaluatedAt: snapshot.observedTo,
    touched, applicable, notApplicable: policy.rules.filter(r => !rules.includes(r)).map(r => r.id), unknowns, outcome,
    gate: outcome === 'within-policy' ? 'open' : outcome === 'outside-policy' ? 'closed' : 'human', graph: buildGraph(action, touched, rules, applicable, snapshot) };
}
