import type { Outcome, RuleSpec, PublicRuleResult } from '../../policy/index';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import type { PreflightAction } from './action';
import { named, worst, type PreflightResult } from './preflight';
export interface PreflightNode { id: string; kind: 'action' | 'subject'; label: string; basis: 'claimed' | null; coverage: 'covered' | 'not-covered' | null; outcome: Outcome | 'no-rule' | null }
export interface PreflightEdge { from: string; to: string; predicate: string; factId: string; basis: string; receiptIds: string[] }
export function buildGraph(action: PreflightAction, touched: string[], rules: RuleSpec[], applicable: PublicRuleResult[], snapshot: NonNullable<ReturnType<EvidenceStore['snapshot']>>) {
  const label = action.kind === 'contract-call' ? `contract-call ${action.receiver.replace('near:mainnet:', '')}${action.method ? ` ${action.method}` : ''} (claimed)` : `intents-swap ${action.originAsset} to ${action.destinationAsset} (claimed)`;
  const nodes: PreflightNode[] = [{ id: 'action', kind: 'action', label, basis: 'claimed', coverage: null, outcome: null }];
  for (const subject of touched) {
    const outcomes = applicable.filter(r => rules.some(s => s.id === r.ruleId && named(s).includes(subject))).map(r => r.outcome);
    nodes.push({ id: subject, kind: 'subject', label: subject.replace('near:mainnet:', ''), basis: null, coverage: snapshot.subjects.includes(subject) ? 'covered' : 'not-covered', outcome: outcomes.length ? worst(outcomes) : 'no-rule' });
  }
  const edges: PreflightEdge[] = snapshot.facts.filter(f => touched.includes(f.subject) && touched.includes(f.object) && f.evidenceIds.length > 0).map(f => ({ from: f.subject, to: f.object, predicate: f.predicate, factId: f.id, basis: f.basis, receiptIds: [...f.evidenceIds].sort() })).sort((a, b) => a.factId.localeCompare(b.factId));
  return { nodes, edges };
}
export function toFlowchartInput(result: PreflightResult) {
  return { source: 'evidence-graph' as const, graph: { nodes: result.graph.nodes.map(n => ({ id: n.id, type: n.kind, label: n.kind === 'action' ? n.label : `${n.label} [${n.coverage === 'not-covered' ? n.coverage : n.outcome}]` })), edges: result.graph.edges.map(e => ({ from: e.from, to: e.to, type: e.predicate, basis: e.basis, evidenceIds: e.receiptIds })) } };
}
