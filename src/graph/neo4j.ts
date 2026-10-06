import { createHash } from 'node:crypto';
import type { View } from '../web/model';
import type { LedgerEntry, TreasuryLedger } from '../pack/ledger';
import registry from '../../packs/marinade/registry.json';

type Value = string | number | boolean | null | string[] | number[];
type Props = Record<string, Value>;
export type NodeRecord = { id: string; label: string; props: Props & { id: string; type: string; label: string; cases: string[] } };
export type RelRecord = { source: string; target: string; type: string; key: string; props: Props };
type CaseStats = { nodes: number; relationships: number; evidence: number; slotRange: [number | null, number | null] };
export type GraphRecords = { nodes: NodeRecord[]; relationships: RelRecord[]; stats: { cases: Record<string, CaseStats> } };
export interface Neo4jDriverLike {
  executeQuery(cypher: string, params: object, config: { database: string; routing: 'WRITE' | 'READ' }): Promise<{ records: { toObject(): Record<string, unknown> }[] }>;
}
export type CannedQuery = { id: string; title: string; question: string; cypher: string; params: Record<string, unknown>; columns: string[] };
export type QueryResult = Omit<CannedQuery, 'params'> & { rows: Record<string, string | number | null>[] };

export const MARINADE_REALM = registry.governance.realm;
export const MNDE_MINT = registry.mints.find(m => m.id === 'mnde')!.address;
// Explicit relation vocabulary: unfamiliar relations fail instead of silently losing semantics.
export const RELATION_TYPES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  'CONTROLS', 'OWNS', 'OWNED_BY', 'BELONGS_TO', 'TREASURY_OF', 'DERIVED_BY',
  'MINT_AUTHORITY_OF', 'UPGRADE_AUTHORITY_OF', 'FREEZE_AUTHORITY_OF',
  'UPGRADE_AUTHORITY', 'MINT_AUTHORITY', 'FREEZE_AUTHORITY', 'OWNER_AUTHORITY', 'STAKE_AUTHORITY', 'CONFIG_AUTHORITY',
  'TRANSFER', 'BURN', 'EXECUTED', 'PROPOSED', 'PROPOSED_IN', 'OF_MINT', 'HAS_TRANSACTION',
  'CONTAINS_INSTRUCTION', 'CREATES', 'DEBITS', 'BURNS_FROM', 'CREDITS', 'PRODUCES',
  'AFFECTS', 'CONFIRMS', 'FAILS', 'PREVIEWS', 'DESCRIBES', 'INSTRUCTED', 'MOVED',
].map(t => [t, t])));
export const CONTROL_TYPES = [
  'CONTROLS', 'OWNS', 'OWNED_BY', 'BELONGS_TO', 'TREASURY_OF', 'DERIVED_BY',
  'MINT_AUTHORITY_OF', 'UPGRADE_AUTHORITY_OF', 'FREEZE_AUTHORITY_OF',
  'UPGRADE_AUTHORITY', 'MINT_AUTHORITY', 'FREEZE_AUTHORITY', 'OWNER_AUTHORITY', 'STAKE_AUTHORITY', 'CONFIG_AUTHORITY',
];
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
function safeLabel(value: string): string {
  const label = value.replace(/[^A-Za-z0-9_]/g, '_');
  const result = /^[A-Za-z]/.test(label) ? label : `Entity_${label}`;
  if (!identifier.test(result)) throw new Error('Invalid graph label');
  return result;
}
function relation(value: string): string {
  const type = RELATION_TYPES[safeLabel(value.toUpperCase())];
  if (!type) throw new Error('Unsupported graph relation');
  return type;
}
const sorted = (values: string[]) => [...new Set(values)].sort();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const slot = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Address prefixes are presentation aliases, not distinct on-chain entities.
function entityId(id: string): string {
  return id.replace(/^(realm|gov|treasury|proposal|ta|acct|mint|ptx):([1-9A-HJ-NP-Za-km-z]{32,44})$/, '$2');
}
// Only structured descriptive fields are copied. Never copy arbitrary detail/source/config maps.
const descriptive = ['address', 'name', 'role', 'decimals', 'program', 'asset', 'authority', 'owner', 'derivation'];
function safeText(value: string): string {
  if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:^|\s)(?:\/|~\/|\.\.?\/|[A-Za-z]:\\))\S*/i.test(value)) throw new Error('Graph text contains a URL or local path');
  return value;
}
function descriptions(props: Record<string, unknown> = {}): Props {
  const result: Props = {};
  for (const key of descriptive) {
    const v = props[key];
    if (typeof v === 'string') result[key] = safeText(v);
    else if (typeof v === 'number' && Number.isFinite(v)) result[key] = v;
  }
  return result;
}
const iso = (seconds: number | null) => seconds == null ? null : new Date(seconds * 1000).toISOString();
function ledgerFlow(row: LedgerEntry): string {
  if (row.kind === 'burn') return row.sourceControl === 'dao-controlled' ? 'burns' : 'unclassified';
  if (row.sourceControl === 'dao-controlled' && row.destinationControl === 'external') return 'externalOutflows';
  if (row.sourceControl === 'dao-controlled' && row.destinationControl === 'dao-controlled') return 'internalMoves';
  if (row.sourceControl === 'external' && row.destinationControl === 'dao-controlled') return 'externalInflows';
  return 'unclassified';
}

export function buildGraphRecords(inputs: { caseId: string; view: View; packet: unknown }[]): GraphRecords {
  const nodes = new Map<string, NodeRecord>();
  const relationships = new Map<string, RelRecord>();
  const stats: GraphRecords['stats'] = { cases: {} };
  const ordered = [...inputs].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const priority = (type: string) => ['Account', 'Authority', 'Wallet', 'TokenAccount', 'Mint', 'Program', 'NativeTreasury', 'Governance', 'Realm', 'Proposal'].indexOf(type);
  function node(id: string, type: string, label: string, caseId: string, extra: Props = {}) {
    id = safeText(entityId(id));
    if (!id || !type) throw new Error('Graph node needs an id and type');
    const previous = nodes.get(id);
    const props = { ...previous?.props, ...extra, id, type, label: safeText(label), cases: sorted([...(previous?.props.cases ?? []), caseId]) };
    // A ledger fallback must not demote a known token account or governance identity.
    if (previous && priority(previous.props.type) >= priority(type)) {
      props.type = previous.props.type; props.label = previous.props.label;
    }
    nodes.set(id, { id, label: safeLabel(props.type), props });
    return id;
  }
  function edge(caseId: string, source: string, type: string, target: string, label: string, props: Props) {
    source = entityId(source); target = entityId(target); type = relation(type); label = safeText(label);
    if (!nodes.has(source) || !nodes.has(target)) throw new Error('Graph edge references a missing node');
    const key = hash(`${caseId}|${source}|${type}|${target}|${label}`);
    const previous = relationships.get(key);
    relationships.set(key, { source, target, type, key, props: { ...props, case: caseId, label, key,
      evidenceIds: sorted([...(previous?.props.evidenceIds as string[] ?? []), ...(props.evidenceIds as string[] ?? [])]) } });
  }
  for (const { caseId, view, packet } of ordered) {
    if (stats.cases[caseId]) throw new Error('Duplicate case input');
    safeText(caseId);
    for (const n of view.graph.nodes) node(n.id, n.type, n.label, caseId, descriptions(n.props));
    for (const e of view.graph.edges) edge(caseId, e.from, e.type, e.to, String(e.props?.label ?? ''), {
      basis: e.basis, evidenceIds: e.evidenceIds, slot: slot(e.props?.slot),
    });
    if (caseId === 'marinade' && packet && typeof packet === 'object' && 'ledger' in packet) {
      const ledger = packet.ledger as TreasuryLedger;
      for (const row of ledger.entries) {
        const executedAt = iso(row.executedAt);
        node(row.proposal, 'Proposal', row.proposalName, caseId, { name: safeText(row.proposalName), case: caseId, executedAt });
        // The instruction identity in the label preserves repeated identical payments.
        const label = `${row.instructionLabel} [${row.txAddress}:${row.optionIndex}:${row.txIndex}:${row.ixIndex}]`;
        const common: Props = { proposal: row.proposal, proposalName: safeText(row.proposalName), basis: row.basis,
          reconciliation: row.reconciliation, receiptSignature: row.receiptSignature, slot: slot(row.receiptSlot ?? row.slot),
          executedAt, evidenceIds: row.evidenceIds };
        const observed = row.basis === 'observed' && row.executedAt != null && row.receiptSignature != null
          && (row.reconciliation === 'matched' || row.reconciliation.startsWith('matched (aggregate of '));
        if (observed && row.source && row.asset && row.amountRaw != null && (row.kind === 'burn' || (row.kind === 'transfer' && row.destination))) {
          if (!/^\d+$/.test(String(row.amountRaw))) throw new Error('Invalid token amount');
          const source = node(row.source, 'Account', row.source, caseId);
          const target = row.kind === 'burn' ? node(row.asset, 'Mint', row.asset, caseId) : node(row.destination!, 'Account', row.destination!, caseId);
          edge(caseId, source, row.kind.toUpperCase(), target, label, { ...common, asset: row.asset,
            amountRaw: String(row.amountRaw), amountDisplay: row.amountDisplay == null ? null : String(row.amountDisplay), decimals: row.decimals,
            flow: ledgerFlow(row), sourceControl: row.sourceControl, destinationControl: row.destinationControl });
        } else {
          node(row.programId, 'Program', row.programId, caseId);
          edge(caseId, row.proposal, 'INSTRUCTED', row.programId, label, { ...common, program: row.programId, category: row.category });
        }
      }
    }
    const members = [...nodes.values()].filter(n => n.props.cases.includes(caseId));
    const caseStats: CaseStats = { nodes: members.length, relationships: [...relationships.values()].filter(r => r.props.case === caseId).length,
      evidence: view.evidenceCount, slotRange: [slot(view.slotRange[0]), slot(view.slotRange[1])] };
    stats.cases[caseId] = caseStats;
    // Persist inventory provenance on an existing entity, without synthetic evidence nodes.
    // Per-case keys allow partial loads to retain the other cases' metadata.
    const anchor = members.sort((a, b) => a.id.localeCompare(b.id))[0];
    if (anchor) Object.assign(anchor.props, {
      [`inventoryEvidence_${caseId}`]: caseStats.evidence,
      [`inventorySlotMin_${caseId}`]: caseStats.slotRange[0], [`inventorySlotMax_${caseId}`]: caseStats.slotRange[1],
    });
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...relationships.values()].sort((a, b) => a.key.localeCompare(b.key)), stats };
}

type Batch = { cypher: string; params: { rows: object[] } };
export function cypherBatches(records: GraphRecords): { constraints: string[]; nodeBatches: Batch[]; relBatches: Batch[] } {
  const nodeBatches: Batch[] = [], relBatches: Batch[] = [];
  function batches<T>(rows: T[], group: (row: T) => string, query: (label: string) => string, destination: Batch[]) {
    const groups = new Map<string, T[]>();
    for (const row of rows) { const label = group(row); if (!identifier.test(label)) throw new Error('Unsafe Cypher identifier');
      groups.set(label, [...(groups.get(label) ?? []), row]); }
    for (const [label, values] of [...groups].sort(([a], [b]) => a.localeCompare(b)))
      for (let i = 0; i < values.length; i += 500) destination.push({ cypher: query(label), params: { rows: values.slice(i, i + 500) as object[] } });
  }
  batches(records.nodes, n => n.label, label => `UNWIND $rows AS row
MERGE (n:Entity {id: row.id})
WITH n, row, reduce(cases = coalesce(n.cases, []), c IN row.props.cases | CASE WHEN c IN cases THEN cases ELSE cases + c END) AS cases
SET n += row.props, n.cases = cases
SET n:${label}`, nodeBatches);
  batches(records.relationships, r => { if (!RELATION_TYPES[r.type]) throw new Error('Unsupported graph relation'); return r.type; }, type => `UNWIND $rows AS row
MATCH (a:Entity {id: row.source}), (b:Entity {id: row.target})
MERGE (a)-[r:${type} {key: row.key}]->(b)
SET r += row.props
SET r.slot = toInteger(row.props.slot), r.decimals = toInteger(row.props.decimals)`, relBatches);
  return { constraints: ['CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE'], nodeBatches, relBatches };
}
export function neo4jConfigFromEnv(env: Record<string, string | undefined> = process.env) {
  if (!env.NEO4J_URI || !env.NEO4J_PASSWORD) return null;
  return { uri: env.NEO4J_URI, username: env.NEO4J_USERNAME || 'neo4j', password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE || 'neo4j' };
}
export function redactedNeo4jHost(uri: string): string {
  try { return new URL(uri).hostname; } catch { return '(invalid host)'; }
}
export async function loadNeo4j(driver: Neo4jDriverLike, records: GraphRecords, opts: { database: string }) {
  const batches = cypherBatches(records);
  const config = { database: opts.database, routing: 'WRITE' as const };
  for (const query of batches.constraints) await driver.executeQuery(query, {}, config);
  for (const batch of [...batches.nodeBatches, ...batches.relBatches]) await driver.executeQuery(batch.cypher, batch.params, config);
  return { nodes: records.nodes.length, relationships: records.relationships.length,
    batches: batches.constraints.length + batches.nodeBatches.length + batches.relBatches.length };
}

const joinCypher = (list: string, separator: string) => `reduce(text = '', value IN ${list} | text + CASE WHEN text = '' THEN '' ELSE '${separator}' END + value)`;
// Sum decimal strings by columns. Neither IEEE-754 nor Neo4j's signed 64-bit
// integer range can truncate raw u64 amounts or a sum exceeding that range.
const digitSum = `s.carry + reduce(v = 0, amount IN amounts | v + coalesce(toInteger(substring(reverse(amount), i, 1)), 0))`;
const externalCypher = `MATCH (:Entity)-[r:TRANSFER]->(d:Entity)
WHERE r.flow = $flow AND r.asset = $mint
WITH d.id AS destination, collect(DISTINCT r.destinationControl) AS controls,
     count(DISTINCT r.proposal) AS proposals, collect(r.amountRaw) AS amounts,
     min(r.executedAt) AS firstExecutedAt, max(r.executedAt) AS lastExecutedAt
WITH *, reduce(width = 1, amount IN amounts | CASE WHEN size(amount) > width THEN size(amount) ELSE width END) AS width
WITH *, reduce(s = {raw: '', carry: 0}, i IN range(0, width + size(toString(size(amounts)))) |
     {raw: toString((${digitSum}) % 10) + s.raw, carry: (${digitSum}) / 10}) AS summed
WITH *, reduce(raw = '', digit IN split(summed.raw, '') | CASE WHEN raw = '' AND digit = '0' THEN '' ELSE raw + digit END) AS trimmed
WITH *, CASE WHEN trimmed = '' THEN '0' ELSE trimmed END AS totalRaw
WITH *, CASE WHEN size(totalRaw) < 10 THEN right('0000000000' + totalRaw, 10) ELSE totalRaw END AS padded
WITH *, substring(padded, 0, size(padded) - 9) AS whole, right(padded, 9) AS fraction
WITH *, reduce(text = '', i IN range(0, size(whole) - 1) |
     text + CASE WHEN i > 0 AND (size(whole) - i) % 3 = 0 THEN ',' ELSE '' END + substring(whole, i, 1)) AS grouped,
     reverse(reduce(text = '', digit IN split(reverse(fraction), '') |
       CASE WHEN text = '' AND digit = '0' THEN '' ELSE text + digit END)) AS fractional
RETURN destination, CASE WHEN size(controls) = 1 THEN controls[0] ELSE 'mixed' END AS destinationControl,
       proposals, totalRaw, grouped + CASE WHEN fractional = '' THEN '' ELSE '.' + fractional END AS totalDisplay,
       firstExecutedAt, lastExecutedAt
ORDER BY size(totalRaw) DESC, totalRaw DESC, destination`;

export const CANNED_QUERIES: CannedQuery[] = [
  { id: 'shared-controllers', title: 'Shared controllers', question: 'Which controllers appear in two or more recorded cases?',
    columns: ['entity', 'type', 'label', 'cases', 'inboundControlEdges'], params: { types: ['Governance', 'NativeTreasury', 'Realm', 'Program'], controlTypes: CONTROL_TYPES },
    cypher: `MATCH (n:Entity) WHERE n.type IN $types AND size(n.cases) >= 2
CALL { WITH n UNWIND n.cases AS c WITH c ORDER BY c RETURN collect(c) AS cases }
OPTIONAL MATCH (:Entity)-[r]->(n) WHERE type(r) IN $controlTypes
RETURN n.id AS entity, n.type AS type, n.label AS label, ${joinCypher('cases', ',')} AS cases, count(r) AS inboundControlEdges
ORDER BY entity` },
  { id: 'paths-to-realm', title: 'Paths to Marinade DAO', question: 'Which token accounts, programs and mints have a control path of up to four hops to the Marinade realm?',
    columns: ['start', 'startType', 'hops', 'path', 'bases', 'cases'], params: { realm: MARINADE_REALM, startTypes: ['TokenAccount', 'Program', 'Mint'], controlTypes: CONTROL_TYPES },
    cypher: `MATCH p = (s:Entity)-[*1..4]->(:Entity {id: $realm})
WHERE s.type IN $startTypes AND all(r IN relationships(p) WHERE type(r) IN $controlTypes)
CALL { WITH p UNWIND relationships(p) AS r WITH DISTINCT r.case AS c ORDER BY c RETURN collect(c) AS cases }
RETURN DISTINCT s.id AS start, s.type AS startType, length(p) AS hops,
       ${joinCypher('[n IN nodes(p) | n.id]', ' → ')} AS path,
       ${joinCypher('[r IN relationships(p) | r.basis]', ',')} AS bases, ${joinCypher('cases', ',')} AS cases
ORDER BY start, hops, path, bases, cases` },
  { id: 'mnde-external-destinations', title: 'MNDE external destinations', question: 'Where did reconciled external MNDE outflows go, and how much did each destination receive?',
    columns: ['destination', 'destinationControl', 'proposals', 'totalRaw', 'totalDisplay', 'firstExecutedAt', 'lastExecutedAt'], params: { mint: MNDE_MINT, flow: 'externalOutflows' }, cypher: externalCypher },
  { id: 'case-inventory', title: 'Recorded case inventory', question: 'How many entities, relationships and evidence records are indexed for each case, and at which slots?',
    columns: ['case', 'nodes', 'relationships', 'evidence', 'slotMin', 'slotMax'], params: {},
    cypher: `MATCH (n:Entity) UNWIND n.cases AS caseId
WITH caseId, count(n) AS nodes, max(n['inventoryEvidence_' + caseId]) AS evidence,
     min(n['inventorySlotMin_' + caseId]) AS slotMin, max(n['inventorySlotMax_' + caseId]) AS slotMax
CALL { WITH caseId MATCH (:Entity)-[r]->(:Entity) WHERE r.case = caseId RETURN count(r) AS relationships }
RETURN caseId AS case, nodes, relationships, coalesce(evidence, 0) AS evidence, slotMin, slotMax ORDER BY case` },
];
function canned(id: string): CannedQuery {
  const query = CANNED_QUERIES.find(q => q.id === id);
  if (!query) throw new Error('Unknown canned query');
  return query;
}
function result(query: CannedQuery, rows: QueryResult['rows']): QueryResult {
  const { params: _, ...metadata } = query;
  return { ...metadata, columns: [...metadata.columns], rows };
}
export function formatMnde(raw: string): string {
  const value = BigInt(raw); const padded = (value < 0n ? -value : value).toString().padStart(10, '0');
  const whole = padded.slice(0, -9).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = padded.slice(-9).replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function runCannedLocal(records: GraphRecords, id: string): QueryResult {
  const query = canned(id);
  const rows: QueryResult['rows'] = [];
  if (id === 'shared-controllers') {
    for (const n of records.nodes) if ((query.params.types as string[]).includes(n.props.type) && n.props.cases.length >= 2)
      rows.push({ entity: n.id, type: n.props.type, label: n.props.label, cases: sorted(n.props.cases).join(','),
        inboundControlEdges: records.relationships.filter(r => r.target === n.id && CONTROL_TYPES.includes(r.type)).length });
    rows.sort((a, b) => compare(String(a.entity), String(b.entity)));
  } else if (id === 'paths-to-realm') {
    const adjacency = new Map<string, RelRecord[]>();
    for (const r of records.relationships) if (CONTROL_TYPES.includes(r.type)) adjacency.set(r.source, [...(adjacency.get(r.source) ?? []), r]);
    const seen = new Set<string>();
    for (const start of records.nodes.filter(n => (query.params.startTypes as string[]).includes(n.props.type))) {
      function walk(current: string, ids: string[], edges: RelRecord[]) {
        if (current === query.params.realm && edges.length) {
          const row = { start: start.id, startType: start.props.type, hops: edges.length, path: ids.join(' → '),
            bases: edges.map(r => String(r.props.basis)).join(','), cases: sorted(edges.map(r => String(r.props.case))).join(',') };
          const key = JSON.stringify(row); if (!seen.has(key)) { seen.add(key); rows.push(row); }
        }
        if (edges.length === 4) return;
        // Cypher paths may revisit nodes but cannot reuse a relationship.
        for (const r of adjacency.get(current) ?? []) if (!edges.some(e => e.key === r.key)) walk(r.target, [...ids, r.target], [...edges, r]);
      }
      walk(start.id, [start.id], []);
    }
    rows.sort((a, b) => compare(String(a.start), String(b.start)) || Number(a.hops) - Number(b.hops)
      || compare(String(a.path), String(b.path)) || compare(String(a.bases), String(b.bases)) || compare(String(a.cases), String(b.cases)));
  } else if (id === 'mnde-external-destinations') {
    const groups = new Map<string, RelRecord[]>();
    for (const r of records.relationships) if (r.type === 'TRANSFER' && r.props.asset === query.params.mint && r.props.flow === query.params.flow)
      groups.set(r.target, [...(groups.get(r.target) ?? []), r]);
    for (const [destination, edges] of groups) {
      const totalRaw = edges.reduce((sum, r) => sum + BigInt(String(r.props.amountRaw)), 0n).toString();
      const dates = edges.flatMap(r => r.props.executedAt == null ? [] : [String(r.props.executedAt)]).sort();
      const controls = sorted(edges.flatMap(r => r.props.destinationControl == null ? [] : [String(r.props.destinationControl)]));
      rows.push({ destination, destinationControl: controls.length === 1 ? controls[0] : 'mixed', proposals: new Set(edges.map(r => r.props.proposal).filter(p => p != null)).size,
        totalRaw, totalDisplay: formatMnde(totalRaw), firstExecutedAt: dates[0] ?? null, lastExecutedAt: dates.at(-1) ?? null });
    }
    rows.sort((a, b) => { const x = BigInt(String(a.totalRaw)), y = BigInt(String(b.totalRaw)); return x > y ? -1 : x < y ? 1 : compare(String(a.destination), String(b.destination)); });
  } else {
    for (const [caseId, s] of Object.entries(records.stats.cases).sort(([a], [b]) => compare(a, b)))
      rows.push({ case: caseId, nodes: s.nodes, relationships: s.relationships, evidence: s.evidence, slotMin: s.slotRange[0], slotMax: s.slotRange[1] });
  }
  return result(query, rows);
}
export async function runCannedNeo4j(driver: Neo4jDriverLike, id: string, opts: { database: string }): Promise<QueryResult> {
  const query = canned(id);
  const response = await driver.executeQuery(query.cypher, query.params, { database: opts.database, routing: 'READ' });
  const numeric = new Set(['inboundControlEdges', 'hops', 'proposals', 'nodes', 'relationships', 'evidence', 'slotMin', 'slotMax']);
  const rows = response.records.map(record => {
    const object = record.toObject(); const row: QueryResult['rows'][number] = {};
    for (const column of query.columns) {
      const value = object[column];
      if (value == null) row[column] = null;
      else if (numeric.has(column)) {
        const number = Number(String(value)); if (!Number.isSafeInteger(number)) throw new Error('Query count or slot exceeds safe integer range');
        row[column] = number;
      } else row[column] = String(value);
    }
    return row;
  });
  return result(query, rows);
}
