import type { GraphAnswer, CannedResult } from './graph';
import type { View } from './model';

const GRAPH_HEADERS: Record<string, string> = {
  entity: 'Entity', type: 'Type', label: 'Label', cases: 'Cases', inboundControlEdges: 'Inbound control edges',
  start: 'Start', startType: 'Start type', hops: 'Hops', path: 'Path', bases: 'Evidence basis per hop',
  destination: 'Destination', destinationControl: 'Destination control', proposals: 'Proposals',
  totalRaw: 'Total (raw)', totalDisplay: 'Total (MNDE)', firstExecutedAt: 'First executed', lastExecutedAt: 'Last executed',
  case: 'Case', nodes: 'Entities', relationships: 'Relations', evidence: 'Evidence records', slotMin: 'First slot', slotMax: 'Last slot',
};
export const graphHeader = (key: string) => Object.hasOwn(GRAPH_HEADERS, key) ? GRAPH_HEADERS[key] : key;
export const graphNumeric = (key: string) => ['inboundControlEdges', 'hops', 'proposals', 'totalRaw', 'totalDisplay', 'nodes', 'relationships', 'evidence', 'slotMin', 'slotMax'].includes(key);
export function graphCell(key: string, value: unknown): string {
  const text = String(value ?? '—');
  return key === 'cases' || key === 'bases' ? text.split(',').map(s => s.trim()).join(key === 'bases' ? ' → ' : ', ') : text;
}

export type GraphSummary = { source: 'neo4j' | 'local'; host: string | null; retrievedAt: string; query: CannedResult };
export function graphSummary(answer: GraphAnswer): GraphSummary | undefined {
  const query = answer.queries.find(q => q.id === 'shared-controllers');
  return query && { source: answer.source, host: answer.host, retrievedAt: answer.retrievedAt, query: { ...query, rows: query.rows.slice(0, 5) } };
}
export const graphSource = (summary: GraphSummary) => summary.source === 'neo4j' ? `Neo4j Aura ${summary.host}` : 'local graph';
export const canonicalGraphId = (id: string) => id.replace(/^(realm|gov|treasury|proposal|ta|acct|mint|ptx):([1-9A-HJ-NP-Za-km-z]{32,44})$/, '$2');
export function graphEntityEvidence(view: View, entity: string) {
  const node = view.graph.nodes.find(n => canonicalGraphId(n.id) === entity);
  if (!node) return null;
  return { node, ids: [...new Set(view.graph.edges.filter(e => e.from === node.id || e.to === node.id).flatMap(e => e.evidenceIds))] };
}
export function graphMemo(summary?: GraphSummary): string[] {
  if (!summary) return [];
  const cell = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  return ['', '## Cross-case graph', '', `${graphSource(summary)} · captured graph · retrieved ${summary.retrievedAt}.`, '',
    'Shared controllers · first five rows in entity order.', '',
    `| ${summary.query.columns.map(graphHeader).join(' | ')} |`, `| ${summary.query.columns.map(c => graphNumeric(c) ? '---:' : '---').join(' | ')} |`,
    ...summary.query.rows.map(row => `| ${summary.query.columns.map(c => cell(graphCell(c, row[c]))).join(' | ')} |`),
    ...(!summary.query.rows.length ? ['No shared controllers returned.'] : [])];
}
