import type { GraphRecords } from '../graph/neo4j';
import type { TokenomicsGraph } from '../graph/tokenomics-neo4j';

export type GraphOrigin = { source: 'neo4j' | 'local'; host: string | null; reason: string | null; retrievedAt: string };
export type GraphCounts = { nodes: number; relationships: number; byNamespace: { governance: number; tokenomics: number }; byLabel: Record<string, number> };
export type GraphOverview = GraphOrigin & GraphCounts;
export type ProposalDependency = { address: string; caseRole: string; caseLabel: string; tokenomicsType: string; tokenomicsLabel: string; links: string[] };
export type GovernanceTouch = { caseId: string; sharedAccounts: number; examples: string[]; entityLabels: string[] };
export type ProposalBridge = GraphOrigin & { rows: ProposalDependency[] };
export type GovernanceBridge = GraphOrigin & { rows: GovernanceTouch[] };
export const SUMMARY_QUERIES = [
  'MATCH (n) RETURN count(n) AS count',
  'MATCH ()-[r]->() RETURN count(r) AS count',
  'MATCH (n:Entity) RETURN count(n) AS count',
  'MATCH (n:TG) RETURN count(n) AS count',
  "MATCH (n) UNWIND labels(n) AS l WITH l WHERE l <> 'Entity' AND l <> 'TG' RETURN l, count(*) AS count",
];
export const PROPOSAL_BRIDGE_CYPHER = `MATCH (c:Entity) WHERE $case IN c.cases
MATCH (t:TG {address: c.id})
OPTIONAL MATCH (t)-[r]-(u:TG)
WITH c, t, collect(DISTINCT type(r) + ' · ' + coalesce(u.label, u.id))[0..6] AS links
RETURN c.id AS address, c.type AS caseRole, c.label AS caseLabel, head([l IN labels(t) WHERE l <> 'TG']) AS tokenomicsType, coalesce(t.label, t.id) AS tokenomicsLabel, links
ORDER BY tokenomicsType, caseLabel`;
export const GOVERNANCE_BRIDGE_CYPHER = `MATCH (t:TG) MATCH (c:Entity {id: t.address})
UNWIND c.cases AS caseId
RETURN caseId, count(DISTINCT c) AS sharedAccounts, collect(DISTINCT t.label)[0..8] AS examples, collect(DISTINCT c.label) AS entityLabels
ORDER BY sharedAccounts DESC`;
export function localGraphCounts(governance: GraphRecords, tokenomics: TokenomicsGraph): GraphCounts {
  const counts = new Map<string, number>();
  for (const label of [...governance.nodes.map(n => n.label), ...tokenomics.nodes.flatMap(n => n.labels)])
    if (label !== 'Entity' && label !== 'TG') counts.set(label, (counts.get(label) ?? 0) + 1);
  return { nodes: governance.nodes.length + tokenomics.nodes.length,
    relationships: governance.relationships.length + tokenomics.relationships.length,
    byNamespace: { governance: governance.nodes.length, tokenomics: tokenomics.nodes.length }, byLabel: Object.fromEntries(counts) };
}
export function localProposalDependencies(governance: GraphRecords, tokenomics: TokenomicsGraph, caseId: string): ProposalDependency[] {
  const nodes = new Map(tokenomics.nodes.map(n => [n.id, n]));
  const rows: ProposalDependency[] = [];
  for (const c of governance.nodes.filter(n => n.props.cases.includes(caseId))) {
    for (const t of tokenomics.nodes.filter(n => n.props.address === c.id)) {
      const links = new Set<string>();
      for (const r of tokenomics.relationships) {
        const other = r.source === t.id ? r.target : r.target === t.id ? r.source : undefined;
        const u = other === undefined ? undefined : nodes.get(other);
        if (u) links.add(`${r.type} · ${u.props.label ?? u.id}`);
      }
      rows.push({ address: c.id, caseRole: c.props.type, caseLabel: c.props.label,
        tokenomicsType: t.labels[1], tokenomicsLabel: String(t.props.label ?? ''), links: [...links].slice(0, 6) });
    }
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return rows.sort((a, b) => compare(a.tokenomicsType, b.tokenomicsType) || compare(a.caseLabel, b.caseLabel));
}
export function localGovernanceTouches(governance: GraphRecords, tokenomics: TokenomicsGraph): GovernanceTouch[] {
  const entities = new Map(governance.nodes.map(n => [n.id, n]));
  const groups = new Map<string, { addresses: Set<string>; examples: Set<string>; labels: Set<string> }>();
  for (const t of tokenomics.nodes) {
    const c = typeof t.props.address === 'string' ? entities.get(t.props.address) : undefined;
    if (!c) continue;
    for (const caseId of c.props.cases) {
      let group = groups.get(caseId);
      if (!group) groups.set(caseId, group = { addresses: new Set(), examples: new Set(), labels: new Set() });
      group.addresses.add(c.id); group.labels.add(c.props.label);
      if (t.props.label != null) group.examples.add(String(t.props.label));
    }
  }
  return [...groups].map(([caseId, g]) => ({ caseId, sharedAccounts: g.addresses.size, examples: [...g.examples].slice(0, 8), entityLabels: [...g.labels] }))
    .sort((a, b) => b.sharedAccounts - a.sharedAccounts);
}
export function graphCount(value: unknown): number {
  const count = Number(String(value));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid graph count');
  return count;
}
