import { beforeAll, describe, expect, test } from 'bun:test';
import neo4j from 'neo4j-driver';
import { runPipeline } from '../src/web/runner';
import { CASES, type Result, type View } from '../src/web/model';
import type { PackPacket } from '../src/pack/model';
import { buildGraphRecords, cypherBatches, loadNeo4j, CANNED_QUERIES, runCannedLocal, runCannedNeo4j,
  neo4jConfigFromEnv, redactedNeo4jHost, MARINADE_REALM, MNDE_MINT, formatMnde, type GraphRecords, type Neo4jDriverLike } from '../src/graph/neo4j';
import { parseArgs } from '../scripts/load-neo4j';

let records: GraphRecords;
const inputs: { caseId: string; view: View; packet: Result['packet'] }[] = [];
beforeAll(async () => {
  for (const c of CASES) inputs.push({ caseId: c.id, ...await runPipeline(c.id) });
  records = buildGraphRecords(inputs);
}, 120_000);

function fakeDriver(rows: Record<string, unknown>[] = []) {
  const calls: { cypher: string; params: object; config: { database: string; routing: 'READ' | 'WRITE' } }[] = [];
  const driver: Neo4jDriverLike = { async executeQuery(cypher, params, config) {
    calls.push({ cypher, params, config });
    return { records: rows.map(row => ({ toObject: () => row })) };
  } };
  return { driver, calls };
}
function smallView(): View {
  return { ...inputs[0].view, graph: { nodes: [{ id: 'test-id', type: 'Token Account; DROP', label: 'parameter-only sentinel',
    props: { password: 'do-not-copy', url: 'https://private.invalid', path: '/tmp/private', amountRaw: 99n, decimals: 9 } }], edges: [] }, evidenceCount: 1, slotRange: [null, null] };
}

describe('Neo4j index of real offline cases', () => {
  test('entities and relationships have stable identities and valid endpoints', () => {
    const ids = new Set(records.nodes.map(n => n.id));
    expect(ids.size).toBe(records.nodes.length);
    for (const n of records.nodes) {
      expect(n.id.length).toBeGreaterThan(0); expect(n.props.type.length).toBeGreaterThan(0);
      expect(n.props.cases.length).toBeGreaterThan(0); expect(n.props.id).toBe(n.id);
    }
    for (const r of records.relationships) {
      expect(ids.has(r.source)).toBe(true); expect(ids.has(r.target)).toBe(true);
      expect(r.key).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(new Set(records.relationships.map(r => r.key)).size).toBe(records.relationships.length);
    expect(buildGraphRecords([...inputs].reverse())).toEqual(records);
    expect(() => JSON.stringify(records)).not.toThrow();
  });
  test('ledger produces observed exact movements and exactly one 300 million MNDE burn', () => {
    const movements = records.relationships.filter(r => r.props.case === 'marinade' && ['TRANSFER', 'BURN'].includes(r.type));
    expect(movements.length).toBeGreaterThanOrEqual(100);
    const burns = movements.filter(r => r.type === 'BURN');
    expect(burns).toHaveLength(1); expect(burns[0].props.amountRaw).toBe('300000000000000000');
    expect(burns[0].target).toBe(MNDE_MINT);
    for (const r of movements) {
      expect(r.props.basis).toBe('observed'); expect(r.props.slot).toBeGreaterThan(0);
      expect(r.props.executedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      for (const [key, value] of Object.entries(r.props)) if (/amount/i.test(key) && value != null) expect(typeof value).toBe('string');
      expect(r.props.proposal).toBeTruthy(); expect(r.props.evidenceIds).not.toHaveLength(0);
    }
    expect(records.relationships.some(r => r.type === 'INSTRUCTED' && r.props.program && r.props.category)).toBe(true);
  });
  test('shared controller ids unify the pack and proposal presentations', () => {
    const rows = runCannedLocal(records, 'shared-controllers').rows;
    const realm = rows.find(r => r.entity === MARINADE_REALM)!;
    expect(realm.type).toBe('Realm'); expect(realm.cases).toBe('marinade,mip-14,mip-14-opinion');
    expect(realm.inboundControlEdges).toBeGreaterThan(0);
  });
  test('control paths reach the realm from the MIP-14 treasury token account', () => {
    const rows = runCannedLocal(records, 'paths-to-realm').rows;
    const path = rows.find(r => r.start === 'GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi' && String(r.cases).includes('mip-14'))!;
    expect(path).toBeDefined(); expect(path.hops).toBe(3); expect(path.startType).toBe('TokenAccount');
    expect(String(path.path).endsWith(MARINADE_REALM)).toBe(true); expect(path.bases).toBe('observed,observed,observed');
  });
  test('external MNDE destinations reconcile exactly to the packet summary', () => {
    const rows = runCannedLocal(records, 'mnde-external-destinations').rows;
    const packet = inputs.find(i => i.caseId === 'marinade')!.packet as PackPacket;
    const summary = packet.ledger.summary.assets.find(a => a.asset === MNDE_MINT)!;
    const total = rows.reduce((sum, row) => sum + BigInt(String(row.totalRaw)), 0n);
    expect(total.toString()).toBe(summary.externalOutflowsRaw);
    expect(formatMnde(total.toString())).toBe(summary.externalOutflowsDisplay);
    expect(formatMnde(total.toString())).toBe('203,378,500.27');
    for (const row of rows) { expect(row.destinationControl).toBe('external'); expect(typeof row.totalRaw).toBe('string'); }
    for (let i = 1; i < rows.length; i++) expect(BigInt(String(rows[i - 1].totalRaw)) >= BigInt(String(rows[i].totalRaw))).toBe(true);
  });
  test('inventory includes all entities and ledger relationships with fixture evidence coverage', () => {
    const rows = runCannedLocal(records, 'case-inventory').rows;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.nodes).toBeGreaterThan(0); expect(row.relationships).toBeGreaterThan(0); expect(row.evidence).toBeGreaterThan(0);
      expect(row.nodes).toBe(records.nodes.filter(n => n.props.cases.includes(String(row.case))).length);
      expect(row.relationships).toBe(records.relationships.filter(r => r.props.case === row.case).length);
      expect([row.slotMin, row.slotMax]).toEqual(inputs.find(i => i.caseId === row.case)!.view.slotRange);
    }
  });
  test('partial graph construction preserves only selected case memberships', () => {
    const partial = buildGraphRecords(inputs.filter(i => i.caseId === 'mip-14'));
    expect(runCannedLocal(partial, 'case-inventory').rows).toHaveLength(1);
    expect(runCannedLocal(partial, 'shared-controllers').rows).toHaveLength(0);
    expect(partial.nodes.every(n => n.props.cases.join() === 'mip-14')).toBe(true);
  });
});

describe('parameterized batches and driver boundary', () => {
  test('labels are sanitized, descriptions allowlisted and values never interpolated', () => {
    const crafted = buildGraphRecords([{ caseId: 'test', view: smallView(), packet: {} }]);
    const batch = cypherBatches(crafted).nodeBatches[0];
    expect(crafted.nodes[0].label).toBe('Token_Account__DROP');
    expect(batch.cypher).toContain('SET n:Token_Account__DROP');
    expect(batch.cypher).not.toContain('parameter-only sentinel'); expect(batch.cypher).not.toContain('test-id');
    const serialized = JSON.stringify(crafted);
    for (const secret of ['do-not-copy', 'private.invalid', '/tmp/private', 'amountRaw']) expect(serialized).not.toContain(secret);
    crafted.nodes[0].label = 'Unsafe`) DELETE n';
    expect(() => cypherBatches(crafted)).toThrow('Unsafe Cypher identifier');
  });
  test('every batch has at most 500 rows, including large synthetic groups', () => {
    const base = buildGraphRecords([{ caseId: 'test', view: smallView(), packet: {} }]);
    const large: GraphRecords = { ...base, nodes: Array.from({ length: 1001 }, (_, i) => ({ ...base.nodes[0], id: `id-${i}`, props: { ...base.nodes[0].props, id: `id-${i}` } })),
      relationships: Array.from({ length: 1001 }, (_, i) => ({ source: 'id-0', target: `id-${i}`, type: 'TRANSFER', key: `key-${i}`, props: { key: `key-${i}` } })) };
    for (const data of [records, large]) {
      const batches = cypherBatches(data);
      for (const batch of [...batches.nodeBatches, ...batches.relBatches]) {
        expect(batch.params.rows.length).toBeLessThanOrEqual(500); expect(batch.cypher).toContain('UNWIND $rows AS row');
        expect(batch.cypher).not.toContain(MARINADE_REALM);
      }
    }
    expect(cypherBatches(large).nodeBatches.map(b => b.params.rows.length)).toEqual([500, 500, 1]);
    expect(cypherBatches(large).relBatches.map(b => b.params.rows.length)).toEqual([500, 500, 1]);
  });
  test('loader executes constraints, nodes, then relationships with explicit write routing', async () => {
    const { driver, calls } = fakeDriver();
    const counts = await loadNeo4j(driver, records, { database: 'test-db' });
    const batches = cypherBatches(records);
    expect(calls.map(c => c.cypher)).toEqual([...batches.constraints, ...batches.nodeBatches.map(b => b.cypher), ...batches.relBatches.map(b => b.cypher)]);
    expect(calls.every(c => c.config.database === 'test-db' && c.config.routing === 'WRITE')).toBe(true);
    expect(counts).toEqual({ nodes: records.nodes.length, relationships: records.relationships.length, batches: calls.length });
    expect(batches.nodeBatches[0].cypher).toContain('coalesce(n.cases, [])');
  });
  test('loader propagates failures without running remaining writes', async () => {
    let count = 0;
    const driver: Neo4jDriverLike = { async executeQuery() { count++; throw new Error('fake failure'); } };
    await expect(loadNeo4j(driver, records, { database: 'neo4j' })).rejects.toThrow('fake failure');
    expect(count).toBe(1);
  });
  test('all canned driver results have exactly the local columns and formatting', async () => {
    for (const query of CANNED_QUERIES) {
      const local = runCannedLocal(records, query.id);
      const fakeRows = local.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? neo4j.int(value) : value])));
      const { driver, calls } = fakeDriver(fakeRows);
      const remote = await runCannedNeo4j(driver, query.id, { database: 'neo4j' });
      expect(remote).toEqual(local); expect(remote.columns).toEqual(query.columns);
      expect(calls[0]).toEqual({ cypher: query.cypher, params: query.params, config: { database: 'neo4j', routing: 'READ' } });
      expect(query.cypher).not.toContain(MNDE_MINT); expect(query.cypher).not.toContain(MARINADE_REALM);
    }
  });
  test('exact decimal formatting retains raw units beyond signed 64-bit integers', () => {
    expect(formatMnde('18446744073709551615')).toBe('18,446,744,073.709551615');
    expect(formatMnde('1')).toBe('0.000000001'); expect(formatMnde('0')).toBe('0');
    expect(formatMnde('1000000000')).toBe('1');
  });
  test('unknown canned queries fail before driver access', async () => {
    const { driver, calls } = fakeDriver();
    expect(() => runCannedLocal(records, 'invalid')).toThrow('Unknown canned query');
    await expect(runCannedNeo4j(driver, 'invalid', { database: 'neo4j' })).rejects.toThrow('Unknown canned query');
    expect(calls).toHaveLength(0);
  });
  test('environment defaults and host redaction do not expose credentials', () => {
    expect(neo4jConfigFromEnv({})).toBeNull(); expect(neo4jConfigFromEnv({ NEO4J_URI: 'neo4j+s://host' })).toBeNull();
    expect(neo4jConfigFromEnv({ NEO4J_URI: 'neo4j+s://host', NEO4J_PASSWORD: 'secret' })).toEqual({ uri: 'neo4j+s://host', password: 'secret', username: 'neo4j', database: 'neo4j' });
    expect(neo4jConfigFromEnv({ NEO4J_URI: 'neo4j+s://host', NEO4J_PASSWORD: 'secret', NEO4J_USERNAME: 'custom', NEO4J_DATABASE: 'index' })?.database).toBe('index');
    expect(redactedNeo4jHost('neo4j+s://user:secret@host:7687/path?password=secret')).toBe('host');
    expect(redactedNeo4jHost('secret invalid uri')).toBe('(invalid host)');
  });
  test('CLI validates filters, deduplicates cases and defaults to all four', () => {
    expect(parseArgs(['--dry-run']).cases).toHaveLength(4);
    expect(parseArgs(['--case', 'mip-14', '--dry-run', '--case', 'mip-14'])).toEqual({ dryRun: true, cases: ['mip-14'] });
    expect(() => parseArgs(['--case'])).toThrow(); expect(() => parseArgs(['--case', 'unknown'])).toThrow(); expect(() => parseArgs(['--unknown'])).toThrow();
  });
});
