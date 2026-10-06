import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASES, type CaseId, type Result } from '../src/web/model';
import { ResearchService, api } from '../src/web/server';
import { runPipeline, ROOT } from '../src/web/runner';
import { CANNED_QUERIES, redactedNeo4jHost, runCannedLocal, MARINADE_REALM, type Neo4jDriverLike } from '../src/graph/neo4j';
import { type GraphAnswer, type GraphOptions } from '../src/web/graph';
import { graphEntityEvidence } from '../src/web/graph-view';

const baseline = new Map<CaseId, Result>();
const config = { uri: 'neo4j+s://uri-user:uri-password@graph.example:7687/private?token=secret', username: 'private-user', password: 'private-password', database: 'captured-cases' };
const request = (path = '', init?: RequestInit) => new Request(`http://127.0.0.1:8875/api/graph${path}`, init);
beforeAll(async () => { for (const c of CASES) baseline.set(c.id, await runPipeline(c.id)); }, 30_000);
function service(options: GraphOptions = { config: null }) {
  const research = new ResearchService(async id => structuredClone(baseline.get(id)!), 120_000, options);
  for (const [id, result] of baseline) research.results.set(id, structuredClone(result));
  return research;
}
function fake() {
  const calls: { cypher: string; params: object; config: Parameters<Neo4jDriverLike['executeQuery']>[2] & { transactionConfig?: { timeout: number } } }[] = [];
  let factories = 0, closes = 0;
  const research = service({ config, driverFactory: () => { factories++; return driver; } });
  const driver = { async executeQuery(cypher: string, params: object, options: Parameters<Neo4jDriverLike['executeQuery']>[2]) {
    calls.push({ cypher, params, config: options });
    const query = CANNED_QUERIES.find(q => q.cypher === cypher);
    return { records: (query ? runCannedLocal(research.graph.records, query.id).rows : []).map(row => ({ toObject: () => row })) };
  }, async close() { closes++; } };
  return { research, driver, calls, factories: () => factories, closes: () => closes };
}
async function get(research: ResearchService, path = ''): Promise<GraphAnswer> {
  const response = await api(research)(request(path)); expect(response.status).toBe(200); return response.json();
}

describe('graph API without network access', () => {
  test('missing configuration returns four populated local queries and refuses loading', async () => {
    const research = service(), answer = await get(research);
    expect(answer).toMatchObject({ source: 'local', configured: false, host: null, scope: 'captured graph' });
    expect(answer.reason).toContain('not configured'); expect(answer.queries).toHaveLength(4);
    expect(Object.keys(answer.stats.cases).sort()).toEqual(CASES.map(c => c.id).sort());
    for (const query of answer.queries) {
      const expected = CANNED_QUERIES.find(q => q.id === query.id)!;
      expect(query.columns).toEqual(expected.columns); expect(query.params).toEqual(expected.params);
      expect(query.rows.length).toBeGreaterThan(0);
      expect(Object.keys(query.rows[0])).toEqual(expected.columns);
    }
    const response = await api(research)(request('/load', { method: 'POST' }));
    expect(response.status).toBe(409); expect((await response.json()).error).toContain('not configured');
  });
  test('driver is lazy, shared, read-routed, database-specific, bounded, cached and closed', async () => {
    const f = fake(); expect(f.factories()).toBe(0);
    const [answer, concurrent] = await Promise.all([get(f.research), get(f.research)]);
    expect(concurrent).toEqual(answer);
    expect(answer).toMatchObject({ source: 'neo4j', configured: true, host: redactedNeo4jHost(config.uri), reason: null });
    expect(f.factories()).toBe(1); expect(f.calls).toHaveLength(4);
    for (const call of f.calls) expect(call.config).toMatchObject({ database: config.database, routing: 'READ', transactionConfig: { timeout: 5_000 } });
    expect(await get(f.research)).toEqual(answer);
    const one = await get(f.research, '/shared-controllers');
    expect(one.queries).toEqual([answer.queries[0]]); expect(f.calls).toHaveLength(4);
    expect(JSON.stringify(answer)).not.toContain(config.password); expect(JSON.stringify(answer)).not.toContain(config.uri);
    await f.research.close(); expect(f.closes()).toBe(1);
  });
  test('single query runs only its own Cypher, and unknown ids never access the driver', async () => {
    const f = fake(); const answer = await get(f.research, '/paths-to-realm');
    expect(answer.queries).toHaveLength(1); expect(answer.queries[0].id).toBe('paths-to-realm'); expect(f.calls).toHaveLength(1);
    expect((await api(f.research)(request('/arbitrary-cypher'))).status).toBe(404); expect(f.calls).toHaveLength(1);
    expect((await get(service(), '/case-inventory')).queries).toHaveLength(1);
  });
  test('a single failed query discards all remote results and scrubs credentials', async () => {
    const research = service({ config, driverFactory: () => ({ async executeQuery(cypher) {
      if (cypher === CANNED_QUERIES[1].cypher) throw new TypeError(`Unavailable ${config.uri} ${config.username} ${config.password} uri-user uri-password ${encodeURIComponent(config.password)}`);
      return { records: [] };
    } }) });
    const answer = await get(research);
    expect(answer.source).toBe('local'); expect(answer.configured).toBe(true); expect(answer.reason).toContain('TypeError: Unavailable');
    for (const secret of [config.uri, config.username, config.password, 'uri-user', 'uri-password']) expect(JSON.stringify(answer)).not.toContain(secret);
    for (const query of answer.queries) expect(query.rows).toEqual(runCannedLocal(research.graph.records, query.id).rows);
  });
  test('driver creation failures are also scrubbed and fall back', async () => {
    const answer = await get(service({ config, driverFactory: () => { throw new Error(config.password); } }));
    expect(answer.source).toBe('local'); expect(answer.reason).not.toContain(config.password);
  });
  test('hanging queries reach the shortened wall-clock deadline and use local results', async () => {
    const research = service({ config, queryTimeoutMs: 10, driverFactory: () => ({ executeQuery: () => new Promise(() => {}) }) });
    const start = Date.now(); const answer = await get(research);
    expect(Date.now() - start).toBeLessThan(1_000); expect(answer.source).toBe('local');
    expect(answer.reason).toContain('TimeoutError'); expect(answer.queries.every(q => q.rows.length > 0)).toBe(true);
    expect((await get(research, '/shared-controllers')).source).toBe('local');
  });
  test('Aura cache expires, but a fallback is retried on the next request', async () => {
    let calls = 0, fail = false;
    const research = service({ config, cacheMs: 5, driverFactory: () => ({ async executeQuery() {
      calls++; if (fail) throw new Error('Temporarily unavailable'); return { records: [] };
    } }) });
    await get(research); expect(calls).toBe(4); await get(research); expect(calls).toBe(4);
    await Bun.sleep(10); fail = true; expect((await get(research)).source).toBe('local'); expect(calls).toBe(8);
    fail = false; expect((await get(research)).source).toBe('neo4j'); expect(calls).toBe(12);
  });
  test('load returns real counts, uses write routing, rejects other origins and invalidates cached reads', async () => {
    const f = fake(), handler = api(f.research);
    expect((await handler(request('/load', { method: 'POST', headers: { Origin: 'https://elsewhere.example' } }))).status).toBe(403);
    expect(f.factories()).toBe(0);
    await get(f.research);
    const response = await handler(request('/load', { method: 'POST', headers: { Origin: 'http://127.0.0.1:8875' } }));
    expect(response.status).toBe(200); const counts = await response.json();
    const writes = f.calls.filter(c => c.config.routing === 'WRITE');
    expect(counts).toEqual({ nodes: f.research.graph.records.nodes.length, relationships: f.research.graph.records.relationships.length, batches: writes.length, host: redactedNeo4jHost(config.uri) });
    expect(writes.length).toBeGreaterThan(1); expect(writes.every(c => c.config.database === config.database && c.config.transactionConfig!.timeout <= 120_000)).toBe(true);
    await get(f.research); expect(f.calls.filter(c => c.config.routing === 'READ')).toHaveLength(8); expect(f.factories()).toBe(1);
  });
  test('loads are serialized even after timeout, and late completion cannot start another batch', async () => {
    let finish!: (value: { records: [] }) => void, calls = 0;
    const research = service({ config, loadTimeoutMs: 15, driverFactory: () => ({ executeQuery() {
      calls++; return new Promise(resolve => { finish = resolve; });
    } }) });
    const handler = api(research), loading = handler(request('/load', { method: 'POST' }));
    expect((await handler(request('/load', { method: 'POST' }))).status).toBe(409);
    const timedOut = await loading; expect(timedOut.status).toBe(504); expect((await timedOut.json()).error).toContain('timed out');
    expect((await handler(request('/load', { method: 'POST' }))).status).toBe(409);
    finish({ records: [] }); await Bun.sleep(5); expect(calls).toBe(1);
    const retry = handler(request('/load', { method: 'POST' })); expect(calls).toBe(2); finish({ records: [] });
    // The next batch is now pending; let the request deadline terminate it.
    expect((await retry).status).toBe(504); finish({ records: [] }); await Bun.sleep(1);
  });
  test('write failures return a scrubbed error and release the load lock', async () => {
    const research = service({ config, driverFactory: () => ({ async executeQuery() { throw new Error(`${config.uri} ${config.password} ${config.username}`); } }) });
    for (let i = 0; i < 2; i++) {
      const response = await api(research)(request('/load', { method: 'POST' }));
      expect(response.status).toBe(502); const body = await response.text();
      expect(body).not.toContain(config.uri); expect(body).not.toContain(config.password); expect(body).not.toContain(config.username);
    }
  });
  test('startup memos include five shared rows, source and time without opening a driver', async () => {
    const f = fake(); await f.research.prepare(); expect(f.factories()).toBe(0);
    const view = f.research.results.get('marinade')!.view;
    expect(view.memo).toContain('## Cross-case graph'); expect(view.memo).toContain('local graph · captured graph');
    expect(view.crossCaseGraph!.query.rows).toEqual(runCannedLocal(f.research.graph.records, 'shared-controllers').rows.slice(0, 5)); expect(view.memo).toContain(view.crossCaseGraph!.retrievedAt);
    const answer = await get(f.research);
    expect(view.memo).toContain(`Neo4j Aura ${redactedNeo4jHost(config.uri)}`); expect(view.memo).toContain(answer.retrievedAt);
    expect(view.crossCaseGraph!.query.rows).toEqual(answer.queries[0].rows.slice(0, 5));
    const response = await api(f.research)(new Request('http://127.0.0.1:8875/api/cases/marinade/export/memo.md'));
    expect(await response.text()).toBe(view.memo);
  });
  test('an offline replay retains the cross-case section in the generated memo file', async () => {
    const research = new ResearchService(runPipeline, 120_000, { config: null });
    await research.prepare();
    const memo = research.results.get('mip-14')!.view.memo;
    const run = research.start('mip-14');
    for (let i = 0; i < 200 && run.status === 'running'; i++) await Bun.sleep(5);
    expect(run.status).toBe('completed');
    expect(readFileSync(join(ROOT, 'out/web/mip-14/memo.md'), 'utf8')).toBe(memo);
    expect(memo).toContain('## Cross-case graph');
  });
  test('canonical entity ids resolve review-case evidence and identify other cases', async () => {
    const research = service(), answer = await get(research);
    const evidence = graphEntityEvidence(research.results.get('mip-14')!.view, MARINADE_REALM)!;
    expect(evidence.node.id).toBe(`realm:${MARINADE_REALM}`); expect(evidence.ids.length).toBeGreaterThan(0);
    expect(evidence.ids.every(id => research.results.get('mip-14')!.sources.some(s => s.id === id))).toBe(true);
    expect(graphEntityEvidence(research.results.get('bonk-bip76')!.view, MARINADE_REALM)).toBeNull();
    expect(answer.entityCases[MARINADE_REALM]).toEqual(['marinade', 'mip-14', 'mip-14-opinion']);
  });
  test('captured graph records are built once and unaffected by live case views', async () => {
    const research = service(); const records = research.graph.records;
    research.liveResults.set('mip-14', { ...research.results.get('mip-14')!, view: { ...research.results.get('mip-14')!.view, graph: { nodes: [], edges: [] } } });
    expect(research.graph.records).toBe(records);
    expect((await get(research)).scope).toBe('captured graph');
  });
});
