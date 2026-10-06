import { canonical, sha256 } from '../chain/evidence';
import type { Basis, BundleResponse, GraphData, GraphQueryResult, Provenance } from '../tokenomics/api';
import { CANNED_QUERIES, runCannedNeo4j, type CannedQuery, type Neo4jDriverLike } from './neo4j';

type Value = string | number | boolean | null | string[];
type Props = Record<string, Value>;
export const TG_LABELS = ['Governance', 'PathNode', 'Program', 'Parameter', 'Role', 'Authority', 'Controller', 'Member', 'Mint', 'TokenAccount', 'Claim', 'HolderGroup', 'Metric'] as const;
export const TG_RELATIONS = ['ROUTES_TO', 'SET_BY', 'HELD_BY', 'CONTROLLED_BY', 'MEMBER_OF', 'UPGRADE_AUTHORITY', 'MINT_AUTHORITY', 'FREEZE_AUTHORITY', 'CAN_CHANGE', 'CHECKS', 'HOLDS', 'LOCKS', 'VOTES_IN', 'VETOES'] as const;
export type TGNode = { id: string; labels: string[]; props: Props };
export type TGRelationship = { source: string; target: string; type: string; key: string; props: Props };
export type TokenomicsGraph = { nodes: TGNode[]; relationships: TGRelationship[] };
const basis = (p: Provenance) => Array.isArray(p.basis) ? p.basis : [p.basis];
const provenance = (p: Provenance): Props => ({ basis: basis(p), evidenceIds: p.evidenceIds, slot: p.slot, asOf: p.asOf });
const empty: Provenance = { basis: 'derived', evidenceIds: [], slot: null, asOf: null };

/** Validate the complete graph before any writes or identifier interpolation. */
export function assertTokenomicsNamespace(graph: TokenomicsGraph) {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.labels.length !== 2 || n.labels[0] !== 'TG' || !TG_LABELS.includes(n.labels[1] as typeof TG_LABELS[number]) || n.labels.includes('Entity')) throw new Error('Invalid TG label; Entity is forbidden');
    if (ids.has(n.id)) throw new Error('Duplicate TG node id'); ids.add(n.id);
  }
  const keys = new Set<string>();
  for (const r of graph.relationships) {
    if (!TG_RELATIONS.includes(r.type as typeof TG_RELATIONS[number]) || ['TRANSFER', 'BURN'].includes(r.type)) throw new Error('Invalid TG relationship; TRANSFER and BURN are forbidden');
    if (!ids.has(r.source) || !ids.has(r.target)) throw new Error(`Missing TG relationship endpoint: ${r.type} ${r.source} -> ${r.target}`);
    if (!/^[a-f0-9]{64}$/.test(r.key) || r.props.key !== r.key || !Array.isArray(r.props.basis) || !Array.isArray(r.props.evidenceIds) || !('slot' in r.props)) throw new Error('Missing TG relationship provenance or key');
    if (keys.has(r.key)) throw new Error('Duplicate TG relationship key'); keys.add(r.key);
  }
}
export function buildTokenomicsGraph(bundle: BundleResponse): TokenomicsGraph {
  const nodes = new Map<string, TGNode>(), relationships = new Map<string, TGRelationship>();
  function node(id: string, type: typeof TG_LABELS[number], label: string, props: Props = {}, p = empty) {
    const old = nodes.get(id);
    if (old) return id;
    nodes.set(id, { id, labels: ['TG', type], props: { id, label, type, ...provenance(p), ...props } }); return id;
  }
  function rel(type: typeof TG_RELATIONS[number], source: string, target: string, p: Provenance, props: Props = {}, distinguish: Props = {}) {
    const key = sha256(canonical({ type, source, target, ...distinguish }));
    const prior = relationships.get(key)?.props;
    const slots = [prior?.slot, p.slot].filter((s): s is number => typeof s === 'number');
    const combined: Props = { ...provenance(p),
      basis: [...new Set([...(prior?.basis as string[] ?? []), ...basis(p)])],
      evidenceIds: [...new Set([...(prior?.evidenceIds as string[] ?? []), ...p.evidenceIds])],
      slot: slots.length ? Math.max(...slots) : null,
      asOf: [prior?.asOf, p.asOf].filter((s): s is string => typeof s === 'string').sort().at(-1) ?? null };
    relationships.set(key, { source, target, type, key, props: { ...combined, ...props, key } });
  }
  const path = bundle.path.data, control = bundle.control.data;
  for (const n of path?.nodes ?? []) node(`path:${n.id}`, 'PathNode', n.label, { address: n.address ?? null, kind: n.kind });
  for (const l of path?.links ?? []) rel('ROUTES_TO', `path:${l.from}`, `path:${l.to}`, l, { linkId: l.id, status: l.status, mechanism: l.mechanism,
    amountRaw: l.observed?.amount.raw ?? null, amount: l.observed?.amount.display ?? null, unit: l.observed?.amount.unit ?? null,
    windowStart: l.observed?.window[0] ?? null, windowEnd: l.observed?.window[1] ?? null, transactions: l.observed?.transactions ?? null, note: l.note }, { linkId: l.id });
  for (const c of control?.controllers ?? []) {
    node(c.id, 'Controller', c.label, { address: c.address, controllerType: c.type, realm: c.realm?.address ?? null, threshold: c.threshold ?? null, detailAddresses: (c.members ?? []).map(m => m.address), note: c.note ?? null }, c);
    for (const g of c.governances ?? []) {
      const gov = node(`governance:${g.address}`, 'Governance', g.address, { address: g.address, nativeTreasury: g.nativeTreasury, votingBody: g.votingBody }, c);
      rel(g.canVote ? 'VOTES_IN' : 'VETOES', c.id, gov, c, { side: g.side, thresholds: g.thresholds, canPropose: g.canPropose, canVote: g.canVote, canVeto: g.canVeto });
    }
    for (const m of ['multisig', 'council-realm'].includes(c.type) ? c.members ?? [] : []) {
      const member = node(`member:${m.address}`, 'Member', m.label ?? m.address, { address: m.address }, c);
      rel('MEMBER_OF', member, c.id, c, { detailKind: c.type === 'multisig' ? 'multisig member' : 'authority detail' });
    }
  }
  for (const program of bundle.programs.data?.rows ?? []) node(`program:${program.id}`, 'Program', program.id, { address: program.address }, program);
  for (const mint of ['MNDE', 'mSOL']) node(`mint:${mint.toLowerCase()}`, 'Mint', mint);
  for (const parameter of bundle.parameters.data?.rows ?? []) node(`parameter:${parameter.id}`, 'Parameter', parameter.label, { field: parameter.field, display: parameter.display, value: parameter.value }, parameter);
  const authority = (address: string, controller: string, p: Provenance) => {
    const id = node(`authority:${address}`, 'Authority', address, { address }, p);
    rel('CONTROLLED_BY', id, controller, p); return id;
  };
  for (const row of control?.rows ?? []) {
    const auth = authority(row.holder.address, row.controllerId, row);
    const role = node(`role:${row.id}`, 'Role', row.role, { role: row.role }, row);
    rel('HELD_BY', role, auth, row);
    const param = bundle.parameters.data?.rows.find(p => p.field === row.target);
    const target = row.targetKind === 'program-code' ? `program:${row.id.replace('control:program:', '')}` : row.targetKind === 'mint' ? `mint:${row.id.startsWith('control:council-mint:') ? row.id.slice('control:'.length) : row.id.split(':')[1]}` : param ? `parameter:${param.id}`
      : node(`target:${row.id}`, row.targetKind === 'treasury' ? 'TokenAccount' : 'Metric', row.target, {}, row);
    if (!nodes.has(target)) node(target, row.targetKind === 'program-code' ? 'Program' : row.targetKind === 'mint' ? 'Mint' : 'Metric', row.target, {}, row);
    const actingControllers = (row.controllerIds ?? [row.controllerId]).filter(id => id === row.controllerId || control?.controllers.find(c => c.id === id)?.governances?.some(g => g.address === row.governance && g.canVote));
    for (const id of actingControllers) {
      rel('CONTROLLED_BY', auth, id, row);
      rel('CAN_CHANGE', id, target, row, { what: row.canChange, role: row.role, instruction: row.instructions.join(', '), holder: row.holder.address, controlId: row.id, note: row.note ?? null }, { controlId: row.id });
    }
    if (row.governance) {
      const gov = node(`governance:${row.governance}`, 'Governance', row.governance, { address: row.governance }, row);
      rel('CAN_CHANGE', gov, target, row, { what: row.canChange, controlId: row.id, thresholds: row.note ?? null }, { controlId: row.id });
    }
    if (row.targetKind === 'program-code') rel('UPGRADE_AUTHORITY', target, auth, row);
    if (row.targetKind === 'mint') rel(row.role === 'mintAuthority' ? 'MINT_AUTHORITY' : 'FREEZE_AUTHORITY', target, auth, row);
  }
  // Parameters include every inferred setter, even when it is not a headline control row.
  for (const param of bundle.parameters.data?.rows ?? []) for (const setter of param.setBy) {
    if (!setter.controllerId) continue;
    const auth = authority(setter.holder.address, setter.controllerId, param);
    const role = node(`setter-role:${setter.role}:${setter.holder.address}`, 'Role', setter.role, { role: setter.role }, param);
    rel('HELD_BY', role, auth, param);
    rel('SET_BY', `parameter:${param.id}`, role, param, { instruction: setter.instruction }, { instruction: setter.instruction });
  }
  for (const claim of bundle.claims.data?.rows ?? []) {
    const id = node(`claim:${claim.id}`, 'Claim', claim.text, { claimId: claim.id, source: claim.source }, claim);
    const fact = node(`fact:${claim.id}`, 'Metric', claim.chainResult, { result: claim.chainResult }, claim);
    rel('CHECKS', id, fact, claim, { status: claim.status });
  }
  function holds(id: string, label: string, mint: string, raw: string, display: string, share: number | null | undefined, p: Provenance, note: string | null = null) {
    node(id, 'HolderGroup', label, { note }, p);
    rel('HOLDS', id, `mint:${mint}`, p, { amountRaw: raw, amount: display, share: share ?? null });
  }
  const holders = bundle.holders.data;
  for (const h of holders?.mnde.top ?? []) holds(`holder:mnde:${h.owner.address}`, h.role ?? h.owner.address, 'mnde', h.amount.raw, h.amount.display, h.amount.shareOfSupply, h);
  for (const m of holders?.mnde.float ?? []) if (m.amount) holds(`holder:${m.id}`, m.label, 'mnde', m.amount.raw, m.amount.display, m.amount.shareOfSupply, m, m.note ?? null);
  for (const h of holders?.msol.downstream ?? []) holds(`holder:msol:${h.entity}`, h.label ?? h.entity, 'msol', h.amount.raw, h.amount.display, h.amount.shareOfSupply, h, 'Top-account downstream groups can overlap.');
  for (const metric of [...(bundle.participation.data?.locking ?? []), ...(holders?.mnde.metrics ?? []), ...(holders?.msol.metrics ?? [])]) node(`metric:${metric.id}:${metric.amount?.unit ?? ''}`, 'Metric', metric.label, { value: metric.value }, metric);
  const locked = bundle.participation.data?.locking.find(m => m.id === 'locked-mnde');
  if (locked?.amount) {
    const lockers = node('holder:vsr-lockers', 'HolderGroup', 'MNDE lockers in VSR', {}, locked);
    rel('LOCKS', lockers, 'mint:mnde', locked, { amountRaw: locked.amount.raw, amount: locked.amount.display, share: locked.amount.shareOfSupply ?? null });
    for (const c of control?.controllers.filter(c => c.type === 'dao-governance' && c.label.includes('through VSR')) ?? []) rel('VOTES_IN', lockers, c.id, locked, { what: 'Registrar voting weight; participation estimate, not a vote execution' });
  }
  const graph = { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)), relationships: [...relationships.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  assertTokenomicsNamespace(graph); return graph;
}

const definitions: { id: string; title: string; question: string; match: string; fields: Record<string, string> }[] = [
  { id: 'path-to-holders', title: 'Activity to holders', question: 'Which links move value, under what mechanism and in which window?',
    match: 'MATCH (a:TG:PathNode)-[r:ROUTES_TO]->(b:TG:PathNode)', fields: { link: 'r.linkId', from: 'a.label', to: 'b.label', status: 'r.status', mechanism: 'r.mechanism', amount: 'r.amount', unit: 'r.unit', windowStart: 'r.windowStart', windowEnd: 'r.windowEnd' } },
  { id: 'who-can-change', title: 'Who can change it', question: 'What can each controller change, through which role and instruction?',
    match: 'MATCH (c:TG:Controller)-[r:CAN_CHANGE]->(t:TG)', fields: { controller: 'c.label', target: 't.label', what: 'r.what', role: 'r.role', instruction: 'r.instruction', holder: 'r.holder' } },
  { id: 'parameter-control', title: 'Parameter control', question: 'Which instruction, role, authority and controller set each parameter?',
    match: 'MATCH (p:TG:Parameter)-[r:SET_BY]->(role:TG:Role)-[:HELD_BY]->(a:TG:Authority)-[:CONTROLLED_BY]->(c:TG:Controller)', fields: { parameter: 'p.label', value: 'p.display', instruction: 'r.instruction', role: 'role.label', holder: 'a.address', controller: 'c.label' } },
  { id: 'supply-control', title: 'Supply control', question: 'Who controls MNDE and mSOL minting and freezing?',
    match: 'MATCH (m:TG:Mint)-[r:MINT_AUTHORITY|FREEZE_AUTHORITY]->(a:TG:Authority)-[:CONTROLLED_BY]->(c:TG:Controller) WHERE m.id IN $mints', fields: { mint: 'm.label', authorityType: 'type(r)', authority: 'a.address', controller: 'c.label' } },
  { id: 'upgrade-control', title: 'Upgrade control', question: 'Who can upgrade each program, with which multisig threshold?',
    match: 'MATCH (p:TG:Program)-[:UPGRADE_AUTHORITY]->(a:TG:Authority)-[:CONTROLLED_BY]->(c:TG:Controller)', fields: { program: 'p.label', authority: 'a.address', controller: 'c.label', threshold: 'c.threshold' } },
  { id: 'who-votes-where', title: 'Who votes where', question: 'Which voting body acts through each governance, what does it control, and with which thresholds?',
    match: 'MATCH (c:TG:Controller)-[v:VOTES_IN|VETOES]->(g:TG:Governance)-[r:CAN_CHANGE]->(t:TG)',
    fields: { votingBody: 'c.label', governance: 'g.address', classification: 'g.votingBody', target: 't.label', what: 'r.what', thresholds: 'v.thresholds', side: 'v.side' } },
  { id: 'claims-vs-chain', title: 'Claims versus chain', question: 'What does the captured chain evidence establish for each claim?',
    match: 'MATCH (c:TG:Claim)-[r:CHECKS]->(f:TG:Metric)', fields: { claimId: 'c.claimId', claim: 'c.label', status: 'r.status', chainResult: 'f.result' } },
  { id: 'holders-and-float', title: 'Holders and float', question: 'Which groups hold each mint, and what custody exclusions define float?',
    match: 'MATCH (h:TG:HolderGroup)-[r:HOLDS]->(m:TG:Mint)', fields: { group: 'h.label', mint: 'm.label', amount: 'r.amount', amountRaw: 'r.amountRaw', share: 'r.share', note: 'h.note' } },
];
export const TOKENOMICS_QUERIES: CannedQuery[] = definitions.map(d => ({ id: d.id, title: d.title, question: d.question, params: d.id === 'supply-control' ? { mints: ['mint:mnde', 'mint:msol'] } : {},
  columns: Object.keys(d.fields), cypher: `${d.match}\nRETURN ${Object.entries(d.fields).map(([name, expr]) => `${expr} AS ${name}`).join(', ')}\nORDER BY ${Object.keys(d.fields).join(', ')}` }));
type Row = GraphQueryResult['rows'][number];
const queryFor = (id: string) => { const q = TOKENOMICS_QUERIES.find(q => q.id === id); if (!q) throw new Error('Unknown tokenomics query'); return q; };
function sorted(rows: Row[], columns: string[]): Row[] {
  return rows.sort((a, b) => { for (const c of columns) { if (a[c] === b[c]) continue; if (a[c] === null) return 1; if (b[c] === null) return -1;
    if (typeof a[c] === 'number' && typeof b[c] === 'number') return a[c] - b[c]; return String(a[c]) < String(b[c]) ? -1 : 1; } return 0; });
}
export function runTokenomicsLocal(graph: TokenomicsGraph, id: string): GraphQueryResult {
  const q = queryFor(id), def = definitions.find(d => d.id === id)!, nodes = new Map(graph.nodes.map(n => [n.id, n])), rows: Row[] = [];
  const edges = (source: string, type: string) => graph.relationships.filter(r => r.source === source && r.type === type);
  const add = (bindings: Record<string, TGNode | TGRelationship>) => {
    const row: Row = {};
    for (const [column, expr] of Object.entries(def.fields)) { const [alias, key] = expr.split('.');
      const value = expr === 'type(r)' ? (bindings.r as TGRelationship).type : bindings[alias]?.props[key];
      row[column] = value === null || value === undefined ? null : typeof value === 'number' ? value : String(value);
    }
    rows.push(row);
  };
  for (const r of graph.relationships) {
    const a = nodes.get(r.source)!, b = nodes.get(r.target)!;
    if (id === 'path-to-holders' && r.type === 'ROUTES_TO') add({ a, r, b });
    if (id === 'who-can-change' && r.type === 'CAN_CHANGE' && a.labels.includes('Controller')) add({ c: a, r, t: b });
    if (id === 'claims-vs-chain' && r.type === 'CHECKS') add({ c: a, r, f: b });
    if (id === 'holders-and-float' && r.type === 'HOLDS') add({ h: a, r, m: b });
    if (id === 'supply-control' && (q.params.mints as string[]).includes(a.id) && ['MINT_AUTHORITY', 'FREEZE_AUTHORITY'].includes(r.type) || id === 'upgrade-control' && r.type === 'UPGRADE_AUTHORITY')
      for (const c of edges(b.id, 'CONTROLLED_BY')) add({ m: a, p: a, r, a: b, c: nodes.get(c.target)! });
    if (id === 'who-votes-where' && r.type === 'CAN_CHANGE' && a.labels.includes('Governance')) {
      for (const v of graph.relationships.filter(e => ['VOTES_IN', 'VETOES'].includes(e.type) && e.target === a.id && nodes.get(e.source)?.labels.includes('Controller')))
        add({ c: nodes.get(v.source)!, v, g: a, r, t: b });
    }
    if (id === 'parameter-control' && r.type === 'SET_BY') for (const held of edges(b.id, 'HELD_BY')) for (const controlled of edges(held.target, 'CONTROLLED_BY'))
      add({ p: a, r, role: b, a: nodes.get(held.target)!, c: nodes.get(controlled.target)! });
  }
  return { ...q, rows: sorted(rows, q.columns) };
}
export async function runTokenomicsNeo4j(driver: Neo4jDriverLike, id: string, opts: { database: string }): Promise<GraphQueryResult> {
  const q = queryFor(id), result = await driver.executeQuery(q.cypher, q.params, { database: opts.database, routing: 'READ' });
  const rows = result.records.map(r => { const object = r.toObject(), row: Row = {};
    for (const c of q.columns) row[c] = object[c] == null ? null : c === 'share' ? Number(String(object[c])) : String(object[c]); return row; });
  return { ...q, rows: sorted(rows, q.columns) };
}
export function tokenomicsSubgraph(graph: TokenomicsGraph): GraphData['subgraph'] {
  const selected = graph.relationships.filter(r => !['HOLDS', 'CHECKS'].includes(r.type)), ids = new Set(selected.flatMap(r => [r.source, r.target]));
  return { nodes: graph.nodes.filter(n => ids.has(n.id)).map(n => ({ id: n.id, type: n.labels[1], label: String(n.props.label) })),
    edges: selected.map(r => ({ id: r.key, from: r.source, to: r.target, type: r.type, basis: (r.props.basis as Basis[])[0], label: String(r.props.mechanism ?? r.props.what ?? r.props.instruction ?? r.type) })) };
}
export function tokenomicsCypherBatches(graph: TokenomicsGraph) {
  assertTokenomicsNamespace(graph);
  const batches = <T>(rows: T[], group: (r: T) => string, cypher: (type: string) => string) => {
    const result: { cypher: string; params: { rows: T[] } }[] = [];
    for (const type of [...new Set(rows.map(group))].sort()) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(type)) throw new Error('Unsafe TG identifier');
      const values = rows.filter(r => group(r) === type);
      for (let n = 0; n < values.length; n += 500) result.push({ cypher: cypher(type), params: { rows: values.slice(n, n + 500) } });
    }
    return result;
  };
  return { constraints: ['CREATE CONSTRAINT tg_id IF NOT EXISTS FOR (n:TG) REQUIRE n.id IS UNIQUE'],
    nodeBatches: batches(graph.nodes, n => n.labels[1], type => `UNWIND $rows AS row MERGE (n:TG {id: row.id}) SET n:${type} SET n = row.props`),
    relBatches: batches(graph.relationships, r => r.type, type => `UNWIND $rows AS row MATCH (a:TG {id: row.source}), (b:TG {id: row.target}) MERGE (a)-[r:${type} {key: row.key}]->(b) SET r = row.props`) };
}
export async function loadTokenomicsNeo4j(driver: Neo4jDriverLike, graph: TokenomicsGraph, opts: { database: string }) {
  const batches = tokenomicsCypherBatches(graph);
  const snapshot = async () => { const rows = new Map<string, string>();
    for (const q of CANNED_QUERIES) rows.set(q.id, canonical((await runCannedNeo4j(driver, q.id, opts)).rows.map(r => canonical(r)).sort())); return rows; };
  const before = await snapshot(), config = { database: opts.database, routing: 'WRITE' as const };
  for (const cypher of batches.constraints) await driver.executeQuery(cypher, {}, config);
  // Replace only this namespace so removed links do not survive a newer bundle.
  await driver.executeQuery('MATCH (n:TG) DETACH DELETE n', {}, config);
  for (const batch of [...batches.nodeBatches, ...batches.relBatches]) await driver.executeQuery(batch.cypher, batch.params, config);
  const after = await snapshot(), changedQueries = CANNED_QUERIES.filter(q => before.get(q.id) !== after.get(q.id)).map(q => q.id);
  return { nodes: graph.nodes.length, relationships: graph.relationships.length, batches: 2 + batches.nodeBatches.length + batches.relBatches.length,
    regression: changedQueries.length ? 'changed' as const : 'unchanged' as const, changedQueries };
}
