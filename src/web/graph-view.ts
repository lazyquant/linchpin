import type { GraphAnswer, CannedResult } from './graph';
import type { View } from './model';

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
    `| ${summary.query.columns.join(' | ')} |`, `| ${summary.query.columns.map(() => '---').join(' | ')} |`,
    ...summary.query.rows.map(row => `| ${summary.query.columns.map(c => cell(row[c])).join(' | ')} |`),
    ...(!summary.query.rows.length ? ['No shared controllers returned.'] : [])];
}
