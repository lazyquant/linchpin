import { beforeAll, expect, test, spyOn } from 'bun:test';
import { ResearchService, api } from '../src/web/server';
import { loadTokenomicsBundle } from '../src/tokenomics/cache';
import { ROOT } from '../src/web/runner';
import { GraphService } from '../src/web/graph';
import { graphOverviewText, proposalBridgeCard, governanceBridgeCard } from '../src/web/graph-overview-view';
import { localGraphCounts, localProposalDependencies, localGovernanceTouches, SUMMARY_QUERIES, PROPOSAL_BRIDGE_CYPHER, GOVERNANCE_BRIDGE_CYPHER, type GraphOverview, type ProposalBridge } from '../src/web/graph-overview';
import type { GraphRecords, Neo4jDriverLike } from '../src/graph/neo4j';
import type { TokenomicsGraph } from '../src/graph/tokenomics-neo4j';

const research = new ResearchService(undefined, 120_000, { config: null });
beforeAll(async () => {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(() => { throw new Error('No network allowed'); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    await research.prepare();
    research.tokenomics = await loadTokenomicsBundle({ root: ROOT, packResult: research.results.get('marinade')! }, { log: () => {} });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
}, 120_000);
const get = (path: string) => api(research)(new Request(`http://localhost/api/graph/${path}`));

test('summary counts both complete local namespaces without merging shared addresses', async () => {
  const response = await get('summary'); expect(response.status).toBe(200);
  const summary: GraphOverview = await response.json();
  expect(summary).toMatchObject({ source: 'local', host: null, reason: 'Neo4j is not configured', ...localGraphCounts(research.graph.records, research.tokenomicsGraph!.graph) });
  expect(summary.byNamespace).toEqual({ governance: 360, tokenomics: 585 });
  expect(summary.nodes).toBe(945);
  expect(summary.byLabel.Entity).toBeUndefined(); expect(summary.byLabel.TG).toBeUndefined();
  expect(Object.values(summary.byLabel).reduce((a, b) => a + b, 0)).toBe(summary.nodes);
  expect(graphOverviewText(summary)).toContain('Local graph · 945 nodes');
  expect(graphOverviewText(summary)).toContain('governance cases 360 · tokenomics 585');
});
test('MIP-14 joins the expected treasury, governance, realm and mint with all treasury roles', async () => {
  const response = await get('proposal-dependencies?case=mip-14'); expect(response.status).toBe(200);
  const answer: ProposalBridge = await response.json();
  const roles = (prefix: string) => answer.rows.filter(r => r.address.startsWith(prefix)).map(r => r.tokenomicsType);
  expect(roles('B56RWQ').sort()).toEqual(['Authority', 'HolderGroup', 'PathNode', 'PathNode']);
  expect(roles('8z6A4q')).toContain('Governance'); expect(roles('899YG3')).toContain('Controller'); expect(roles('MNDEFz')).toContain('Mint');
  expect(answer.rows.find(r => r.address.startsWith('B56RWQ') && r.tokenomicsType === 'HolderGroup')!.tokenomicsLabel).toBe('DAO treasury MNDE');
  for (const row of answer.rows) { expect(row.links.length).toBeLessThanOrEqual(6); expect(new Set(row.links).size).toBe(row.links.length); }
  const html = proposalBridgeCard(answer);
  expect(html).toContain(`${new Set(answer.rows.map(r => r.address)).size} of this case's accounts`);
  expect(html).toContain('In the protocol graph as');
  expect(proposalBridgeCard({ ...answer, rows: [] })).toContain('No shared accounts');
  expect((await get('proposal-dependencies?case=unknown')).status).toBe(404);
});
test('reverse bridge counts distinct accounts, not the number of tokenomics roles', async () => {
  const response = await get('governance-cases'); expect(response.status).toBe(200);
  const answer = await response.json();
  for (const row of answer.rows) {
    const proposal = localProposalDependencies(research.graph.records, research.tokenomicsGraph!.graph, row.caseId);
    expect(row.sharedAccounts).toBe(new Set(proposal.map(r => r.address)).size);
    expect(row.examples.length).toBeLessThanOrEqual(8); expect(row.entityLabels.length).toBeGreaterThan(0);
  }
  expect(governanceBridgeCard(answer)).toContain('data-case="mip-14"');
});

const config = { uri: 'neo4j+s://uri-user:uri-password@graph.example', username: 'private-user', password: 'private-password', database: 'captured' };
const empty: GraphRecords = { nodes: [], relationships: [], stats: { cases: {} } };
const tg: TokenomicsGraph = { nodes: [], relationships: [] };
test('Aura reads use documented Cypher, database, 20 s timeout, cache and host-only metadata', async () => {
  const calls: { cypher: string; params: object; config: object }[] = [];
  const driver: Neo4jDriverLike = { async executeQuery(cypher, params, options) {
    calls.push({ cypher, params, config: options });
    const index = SUMMARY_QUERIES.indexOf(cypher);
    const rows = index === 4 ? [{ l: 'Mint', count: { toString: () => '10' } }] : index >= 0 ? [{ count: { toString: () => String([1001, 2045, 400, 601][index]) } }]
      : cypher === PROPOSAL_BRIDGE_CYPHER ? [{ address: 'a', caseRole: 'Account', caseLabel: 'Treasury', tokenomicsType: 'Authority', tokenomicsLabel: 'Treasury', links: ['HOLDS · MNDE'] }]
      : [{ caseId: 'mip-14', sharedAccounts: { toString: () => '1' }, examples: ['Treasury'], entityLabels: ['Native treasury'] }];
    return { records: rows.map(row => ({ toObject: () => row })) };
  } };
  const graph = new GraphService(empty, { config, driverFactory: () => driver });
  const [summary, concurrent] = await Promise.all([graph.summary(tg), graph.summary(tg)]);
  expect(summary).toEqual(concurrent); expect(calls).toHaveLength(5);
  expect(summary).toMatchObject({ source: 'neo4j', host: 'graph.example', reason: null, nodes: 1001, relationships: 2045, byNamespace: { governance: 400, tokenomics: 601 }, byLabel: { Mint: 10 } });
  expect(graphOverviewText(summary)).toContain('1,001 nodes · 2,045 relationships');
  await graph.summary(tg); expect(calls).toHaveLength(5);
  const bridge = await graph.proposalDependencies(tg, 'mip-14'); expect(bridge.rows[0].links).toEqual(['HOLDS · MNDE']);
  expect(calls[5]).toMatchObject({ cypher: PROPOSAL_BRIDGE_CYPHER, params: { case: 'mip-14' } });
  expect((await graph.governanceTouches(tg)).rows[0].sharedAccounts).toBe(1);
  expect(calls[6].cypher).toBe(GOVERNANCE_BRIDGE_CYPHER);
  for (const call of calls) expect(call.config).toEqual({ database: 'captured', routing: 'READ', transactionConfig: { timeout: 20_000 } });
  graph.invalidateSummary(); await graph.summary(tg); expect(calls).toHaveLength(12);
  expect(JSON.stringify(summary)).not.toContain(config.uri);
});
test('failed and hanging Aura reads fall back exactly and scrub credentials', async () => {
  const records = research.graph.records, tokenomics = research.tokenomicsGraph!.graph;
  for (const hang of [false, true]) {
    const graph = new GraphService(records, { config, queryTimeoutMs: 10, driverFactory: () => ({ executeQuery: () => hang ? new Promise(() => {}) : Promise.reject(new Error(`${config.uri} ${config.username} ${config.password} uri-user uri-password`)) }) });
    const summary = await graph.summary(tokenomics), proposal = await graph.proposalDependencies(tokenomics, 'mip-14'), reverse = await graph.governanceTouches(tokenomics);
    expect(summary).toMatchObject({ source: 'local', host: null, ...localGraphCounts(records, tokenomics) });
    expect(proposal.rows).toEqual(localProposalDependencies(records, tokenomics, 'mip-14'));
    expect(reverse.rows).toEqual(localGovernanceTouches(records, tokenomics));
    for (const answer of [summary, proposal, reverse]) for (const secret of [config.uri, config.username, config.password, 'uri-user', 'uri-password']) expect(JSON.stringify(answer)).not.toContain(secret);
    if (hang) expect(summary.reason).toContain('TimeoutError');
  }
});
test('summary cache expires and also caches local fallbacks', async () => {
  let calls = 0;
  const graph = new GraphService(empty, { config, cacheMs: 10, driverFactory: () => ({ async executeQuery() { calls++; throw new Error('offline'); } }) });
  await graph.summary(tg); await graph.summary(tg); expect(calls).toBe(5);
  await Bun.sleep(15); await graph.summary(tg); expect(calls).toBe(10);
});
