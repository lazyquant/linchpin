import { TOKENOMICS_NODES_CYPHER, TOKENOMICS_EDGES_CYPHER, tokenomicsSubgraph } from '../src/graph/tokenomics-neo4j';
import { loadTokenomicsBundle, tokenomicsDigest } from '../src/tokenomics/cache';
import { sameCouncilMembers } from '../src/tokenomics/councils';
import { hasGovernanceFixture } from './helpers/governance';
import { CANNED_QUERIES, type Neo4jDriverLike } from '../src/graph/neo4j';
import { buildTokenomicsGraph, assertTokenomicsNamespace, tokenomicsCypherBatches, loadTokenomicsNeo4j, TOKENOMICS_QUERIES, runTokenomicsLocal, runTokenomicsNeo4j } from '../src/graph/tokenomics-neo4j';
import { TokenomicsGraphService } from '../src/tokenomics/graph-service';
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTokenomics, type TokenomicsBuild } from '../src/tokenomics/build';
import { answerStatus, flowsSection, type SectionInputs } from '../src/tokenomics/sections';
import { evidenceIds, EvidenceIndex } from '../src/tokenomics/evidence';
import { api, ResearchService } from '../src/web/server';
import { runPipeline, ROOT } from '../src/web/runner';
import { SECTIONS, tokenomicsRoutes } from '../src/web/tokenomics-routes';
import { RecordingRpc } from '../src/chain/rpc';
import { runOptions } from '../src/config';
import { readContractsLayer, type ContractsInput } from '../src/contracts/marinade';
import { readParticipation } from '../src/contracts/participation';
import type { PackRegistry } from '../src/pack/build';
import type { PathData } from '../src/tokenomics/api';

let built: TokenomicsBuild, captured: Awaited<ReturnType<typeof runPipeline>>;
let participation: { locked: string; deposited: string; share: number | null; matched: number; mismatched: number; missing: number };
const service = new ResearchService(undefined, undefined, { config: null });
const request = (path: string, init?: RequestInit) => new Request(`http://localhost:8875${path}`, init);
const handler = (path: string, init?: RequestInit) => api(service)(request(path, init));
const base = '/api/tokenomics/marinade';
const read = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const noNetwork = Object.assign((): never => { throw new Error('Test forbids network'); }, { preconnect: globalThis.fetch.preconnect });

const governanceRecorded = hasGovernanceFixture(read<PackRegistry>('packs/marinade/registry.json'));
beforeAll(async () => {
  if (!governanceRecorded) return;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(noNetwork);
  try {
    captured = await runPipeline('marinade');
    // The only recorder property containing endpoint information must never enter responses.
    const tainted = { ...captured, evidence: captured.evidence.map(e => ({ ...e, rpcUrl: 'https://alchemy.com/v2/api-key-secret' })) };
    built = await buildTokenomics({ root: ROOT, packResult: tainted });
    service.tokenomics = built;
    const rpc = new RecordingRpc(runOptions({ offline: true, record: false, refresh: false, fixturesDir: join(ROOT, 'fixtures'), rpcUrl: 'http://127.0.0.1:1' }), 'marinade-contracts');
    const registry = read<PackRegistry>('packs/marinade/registry.json'), input = read<ContractsInput>('packs/marinade/contracts.json');
    const layer = await readContractsLayer(rpc, registry, input);
    const { vsr } = await readParticipation(rpc, registry, input, layer);
    participation = { locked: vsr.timeLocked.raw, deposited: vsr.totalDeposited.raw, share: vsr.timeLockedShareOfSupply.value,
      matched: vsr.reconciliation.matched.value, mismatched: vsr.reconciliation.mismatched.value, missing: vsr.reconciliation.missing.value };
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
}, 120_000);

  test('a dated window with only unavailable deltas does not become a zero inflow', () => {
    const input = { flows: { routes: [], treasury: { window: { oldestBlockTime: 1, newestBlockTime: 2 },
      transactions: [{ deltaRaw: null as string | null }], inflowRaw: { value: '0' }, byInstruction: [] }, treasuryAuthority: { transfers: [] }, buybacks: { months: [] } },
      registry: { mints: [] }, evidence: new EvidenceIndex([]) };
    expect(flowsSection(input as unknown as SectionInputs).treasury.inflows).toBeNull();
    input.flows.treasury.transactions[0].deltaRaw = '0';
    expect(flowsSection(input as unknown as SectionInputs).treasury.inflows?.amount.raw).toBe('0');
  });

describe.skipIf(!governanceRecorded)('tokenomics recorded backend', () => {

  test('build is offline and the reward fee resolves through admin to the Marinade DAO council', () => {
    expect(built.reads.live).toBe(0); expect(built.reads.replayed).toBeGreaterThan(0);
    const fee = built.bundle.parameters.data!.rows.find(r => r.field === 'rewardFee')!;
    expect(fee.value).toBe('0'); expect(fee.display).toBe('0.00 %');
    const setter = fee.setBy.find(s => s.instruction === 'configMarinade')!;
    expect(setter.role).toBe('adminAuthority'); expect(setter.basis).toBe('inferred');
    const controller = built.bundle.control.data!.controllers.find(c => c.id === setter.controllerId)!;
    expect(controller.type).toBe('council-realm'); expect(controller.realm?.name).toBe('Marinade DAO');
  });
  test('fee units, SOL units and price scaling preserve the exact raw values', () => {
    const rows = built.bundle.parameters.data!.rows;
    expect(rows.find(r => r.field === 'delayedUnstakeFee')).toMatchObject({ value: '2000', display: '0.20 %', unit: '%' });
    expect(rows.find(r => r.field === 'liqPool.treasuryCut')?.display).toBe('50.00 %');
    expect(rows.find(r => r.field === 'stakingSolCap')?.display).toBe('18,446,744,073.709551615 SOL');
    const price = rows.find(r => r.field === 'msolPrice')!;
    expect(price.unit).toBe('SOL per mSOL'); expect(Number(price.display.split(' ')[0])).toBe(Number(price.value) / 2 ** 32);
  });
  test('code upgrade, pause, mint supply and token ownership have distinct controllers', () => {
    const { rows, controllers } = built.bundle.control.data!;
    const controller = (id: string) => controllers.find(c => c.id === rows.find(r => r.id === id)?.controllerId)!;
    expect(controller('control:program:liquid-staking')).toMatchObject({ type: 'multisig', threshold: '6' });
    expect(controller('control:program:liquid-staking').members).toHaveLength(13);
    for (const row of rows.filter(r => r.instructions.some(ix => ['pause', 'resume'].includes(ix))))
      expect(controllers.find(c => c.id === row.controllerId)).toMatchObject({ type: 'council-realm', realm: { name: 'Marinade DAO Emergency Council' } });
    expect(controller('control:mnde:mint').type).toBe('none'); expect(controller('control:mnde:freeze').type).toBe('none');
    expect(controller('control:msol:mint').type).toBe('program'); expect(controller('control:treasury-msol').type).toBe('wallet');
    expect(rows.filter(r => r.targetKind === 'program-code')).toHaveLength(10);
    for (const ix of ['addValidator', 'removeValidator', 'setValidatorScore', 'emergencyUnstake', 'partialUnstake', 'configValidatorSystem']) {
      const row = rows.find(r => r.id === `control:${ix}`)!;
      expect(controllers.find(c => c.id === row.controllerId)?.type).toBe('wallet');
      expect(row.evidenceIds.length).toBeGreaterThan(0);
    }
  });
  test('locking, deposited totals, shares and reconciliation match the participation layer', () => {
    const metrics = built.bundle.participation.data!.locking;
    expect(metrics.find(m => m.id === 'locked-mnde')?.amount?.raw).toBe(participation.locked);
    expect(metrics.find(m => m.id === 'deposited-mnde')?.amount?.raw).toBe(participation.deposited);
    expect(metrics.find(m => m.id === 'locked-mnde')?.amount?.shareOfSupply).toBe(participation.share);
    for (const kind of ['matched', 'mismatched', 'missing'] as const) expect(metrics.find(m => m.id === `vault:${kind}`)?.value).toBe(String(participation[kind]));
    expect(built.bundle.participation.data!.topLockers).toHaveLength(20);
  });
  test('claims verify v1 and the captured delayed-unstake 0.2 percent fee', () => {
    const rows = built.bundle.claims.data!.rows;
    expect(rows.find(r => r.id === 'v1')?.status).toBe('verified');
    expect(rows.find(r => r.id === 'delayed-unstake-fee')).toMatchObject({ status: 'verified', text: 'Delayed unstaking of mSOL carries a 0.2 % protocol fee.' });
    for (let n = 2; n <= 9; n++) expect(rows.find(r => r.id === `v${n}`)?.status).not.toBe('claimed');
    expect(rows.some(r => r.id.startsWith('fee-statement:'))).toBe(true);
  });
  test('flows and holders are ready, windows and path vocabulary retain evidence scope', () => {
    for (const section of Object.values(built.bundle)) expect(section.status).toBe('ready');
    for (const section of ['holders', 'flows'] as const) {
      expect(built.bundle[section].evidenceCount).toBeGreaterThan(0);
      expect(built.evidence.lookup(evidenceIds(built.bundle[section])).missing).toEqual([]);
    }
    const links = built.bundle.path.data!.links;
    for (const link of links) expect(['enforced-by-code', 'operated-by-accounts', 'claimed-only', 'not-observed', 'contradicted', 'pending']).toContain(link.status);
    const purchase = links.find(l => l.id === 'buyback-purchases')!;
    expect(purchase.status).toBe('operated-by-accounts'); expect(BigInt(purchase.observed!.amount.raw)).toBeGreaterThan(0n);
    expect(purchase.observed!.transactions).toBeGreaterThan(0);
    expect(links.find(l => l.id === 'purchases-stakers')?.status).toBe('operated-by-accounts');
    expect(links.find(l => l.id === 'delayed-destination')?.status).toBe('pending');
    for (const date of purchase.observed!.window) expect(built.bundle.answer.data!.statements.find(s => s.id === 'buyback-route')!.text).toContain(date.slice(0, 10));
    expect(built.bundle.answer.data!.shortAnswer.status).toBe('partly');
    expect(built.bundle.answer.data!.statements).toHaveLength(10);
    expect(built.bundle.flows.data!.treasury.inflows?.byInstruction?.length).toBeGreaterThan(0);
    expect(built.bundle.holders.data!.mnde.top.length).toBeGreaterThan(0);
    expect(built.bundle.holders.data!.msol.downstream.length).toBeGreaterThan(0);
    expect(built.bundle.offsets.data!.rows.some(r => r.id === 'holders-pending')).toBe(false);
  });

  test('buyback credits without a same-transaction payment are reported next to purchases, never merged', () => {
    const purchase = built.bundle.path.data!.links.find(l => l.id === 'buyback-purchases')!;
    const rows = purchase.observed!.byInstruction!;
    expect(rows.length).toBe(2);
    expect(rows[0].instruction).toContain('same-transaction');
    expect(rows[1].instruction).toContain('without a same-transaction payment');
    expect(BigInt(rows[0].amount.raw) + BigInt(rows[1].amount.raw)).toBe(BigInt(purchase.observed!.amount.raw));
    expect(rows[0].transactions + rows[1].transactions).toBe(purchase.observed!.transactions);
    const text = built.bundle.answer.data!.statements.find(s => s.id === 'buyback-route')!.text;
    expect(text).toContain(`${rows[0].transactions} purchases`);
    expect(text).toContain(`${rows[1].transactions} transactions through program`);
    expect(text).toContain(purchase.observed!.amount.display);
    const months = built.bundle.flows.data!.buybacks.months;
    const credited = months.reduce((n, m) => n + BigInt(m.mndeCreditedWithoutPayment?.raw ?? '0'), 0n);
    expect(credited).toBe(BigInt(rows[1].amount.raw));
    expect([...months.map(m => m.month)]).toEqual([...months.map(m => m.month)].sort());
    expect(built.bundle.flows.data!.buybacks.creditPrograms!.length).toBeGreaterThan(0);
  }, 120_000);
  test('distributor claims, purchase months and recipient transfers retain exact recorded scope', () => {
    const path = built.bundle.path.data!, claims = path.links.find(l => l.id === 'purchases-stakers')!;
    expect(claims.observed).toMatchObject({ transactions: 4, claims: 4, voterAuthorityClaims: 4,
      amount: { raw: '15416329929463' }, voterAuthorityAmount: { raw: '15416329929463' }, claimantShare: 1, claimedAmountShare: 1 });
    expect(built.bundle.claims.data!.rows.find(c => c.id === 'v6')?.status).toBe('partly');
    const recipient = path.links.find(l => l.id === 'buyback-recipient:3HT41nesAgcoNDeGAVFKwss5mzScMH2Uik6pcP71xnhB')!;
    expect(recipient.mechanism).toContain('NewClaim ×4'); expect(recipient.mechanism).toContain('NewDistributor ×1');
    expect(recipient.mechanism).toContain('meRdrpyDCAbQxunjZSLmJ78GxQcn4fJUvqU93GoHZr1');
    expect(recipient.observed!.amount.raw).toBe('4244303363608441');
    const text = built.bundle.answer.data!.statements.find(s => s.id === 'buyback-route')!.text;
    expect(text).toContain('73 purchases paid with'); expect(text).toContain('4,475,493.127687976 MNDE'); expect(text).toContain('965.987819213 SOL');
    expect(text).toContain('2025-12: 3,819,939.280319603 MNDE'); expect(text).toContain('2026-01: 2,529,358.314054663 MNDE');
    expect(text).toContain('2026-02: 77,808.635710129 MNDE'); expect(text).toContain('2026-10: 4,244,303.363608441 MNDE');
    expect(text).toContain('4 of 4 claims observed so far (15,416.329929463 MNDE)');
    const short = built.bundle.answer.data!.shortAnswer.text;
    expect(short.startsWith('Program code routes')).toBe(true);
    expect(short.split(/\. (?=[A-Z])/)).toHaveLength(3);
    expect(short.indexOf('Moving treasury funds')).toBeLessThan(short.indexOf('The Marinade DAO council'));
    for (const s of built.bundle.answer.data!.statements) {
      expect(s.text.endsWith('.')).toBe(true);
      for (const match of s.text.matchAll(/(\d+(?:\.\d+)?) %/g)) expect(match[1]).toMatch(/\.\d{2}$/);
    }
  });
  test('council membership and Emergency Council seat control agree with graph provenance', () => {
    const control = built.bundle.control.data!, councils = control.controllers.filter(c => c.type === 'council-realm');
    const dao = councils.find(c => c.realm?.name === 'Marinade DAO')!, emergency = councils.find(c => c.realm?.name === 'Marinade DAO Emergency Council')!;
    expect(sameCouncilMembers(dao, emergency)).toBe(true);
    expect(sameCouncilMembers(dao, { ...emergency, members: emergency.members!.slice(1) })).toBe(false);
    expect(sameCouncilMembers({ ...dao, members: [] }, { ...emergency, members: [] })).toBe(false);
    const row = control.rows.find(r => r.id === `control:council-mint:${emergency.realm!.address}`)!;
    expect(row.controllerId).toBe(dao.id); expect(row.governance).toBe('FsrqQfLGdFVtySSSsyZJUzVBA9bvGZSKyhp7nsJCqgJe');
    expect(row.note).toContain('community voting disabled');
    const graph = buildTokenomicsGraph(built.bundle);
    expect(graph.relationships.filter(r => r.type === 'SAME_MEMBERS_AS')).toMatchObject([{ props: { basis: ['derived'], members: 5 } }]);
    expect(graph.relationships.some(r => r.type === 'CAN_CHANGE' && r.source === dao.id && r.props.controlId === row.id)).toBe(true);
    expect(graph.relationships.some(r => r.type === 'MINT_AUTHORITY' && r.source === `mint:council-mint:${emergency.realm!.address}`)).toBe(true);
    expect(built.bundle.answer.data!.statements.find(s => s.id === 'treasury-voting')!.text).toContain('1 council token to propose');
    expect(built.bundle.answer.data!.statements.find(s => s.id === 'msol-upgrade')!.text).toContain('is a current Marinade DAO council member.');
    for (const c of councils) { expect(c.threshold).not.toContain(' | '); expect(c.threshold!.length).toBeLessThan(110); }
    expect(dao.threshold).toContain('3 of 5'); expect(dao.threshold).toContain('40.00–50.00 %');
  });
  test('controllers separate voting bodies and group unresolved Native roles', () => {
    const { controllers } = built.bundle.control.data!;
    const dao = controllers.filter(c => c.type === 'dao-governance'); expect(dao).toHaveLength(1);
    expect(dao[0].label).toBe('Marinade DAO community — MNDE voters through VSR'); expect(dao[0].governances!.length).toBeGreaterThan(0);
    for (const kind of ['operator', 'alternateStaker']) {
      const group = controllers.find(c => c.id === `controller:native:${kind}`)!;
      expect(group.members!.length).toBeGreaterThan(0); expect(group.label).toContain('unresolved');
    }
    const locking = built.bundle.answer.data!.statements.find(s => s.id === 'locked-mnde')!.text;
    expect(locking).toContain('is deposited in VSR'); expect(locking).toContain('is under an active time lock');
    expect(built.bundle.answer.data!.statements.find(s => s.id === 'fee-control')!.text).toContain('MNDE holders cannot propose or vote there');
  });
  test('answer status follows directed activity-to-holder paths rather than link array order', () => {
    const path = built.bundle.path.data!;
    expect(answerStatus({ ...path, links: [...path.links].reverse() })).toBe('partly');
    expect(answerStatus({ ...path, links: path.links.map(l => ({ ...l, status: 'pending' })) })).toBe('undetermined');
    const detached: PathData = { ...path, links: path.links.filter(l => l.id !== 'treasury-onward') };
    expect(answerStatus(detached)).toBe('undetermined');
  });
  test('path references, graph endpoints and controller references all resolve', () => {
    const bundle = built.bundle, control = bundle.control.data!, path = bundle.path.data!;
    for (const row of [...control.rows, ...bundle.parameters.data!.rows.flatMap(r => r.setBy)])
      expect(control.controllers.some(c => c.id === row.controllerId)).toBe(true);
    for (const link of path.links) {
      expect(path.nodes.some(n => n.id === link.from)).toBe(true); expect(path.nodes.some(n => n.id === link.to)).toBe(true);
      for (const id of link.controlledBy) expect(control.rows.some(r => r.id === id)).toBe(true);
      for (const id of link.claims) expect(bundle.claims.data!.rows.some(r => r.id === id)).toBe(true);
      for (const param of link.parameters) expect(bundle.parameters.data!.rows.some(r => r.id === param.id)).toBe(true);
    }
    const graph = bundle.graph.data!;
    expect(graph.source).toBe('local'); expect(graph.queries).toHaveLength(8); expect(graph.host).toBeNull();
    for (const edge of graph.subgraph.edges) for (const id of [edge.from, edge.to]) expect(graph.subgraph.nodes.some(n => n.id === id)).toBe(true);
  });
  test('every envelope citation resolves with a real fixture filename and metadata covers its evidence', () => {
    for (const section of Object.values(built.bundle)) {
      const ids = evidenceIds(section), result = built.evidence.lookup(ids);
      expect(result.missing).toEqual([]); expect(section.evidenceCount).toBeGreaterThanOrEqual(ids.length);
      for (const record of result.items) { expect(record.fixture).not.toBeNull(); expect(existsSync(join(ROOT, record.fixture!))).toBe(true); }
      if (section.section !== 'graph' && section.section !== 'answer') expect(section).toMatchObject(built.evidence.metadata(ids));
    }
  });
  test('offsets use executed ledger transfers, explicit windows and captured balances', () => {
    const rows = built.bundle.offsets.data!.rows;
    const external = rows.find(r => r.id === 'dao-external-mnde')!;
    expect(external.amount?.raw).toBe('203378500270000000'); expect(external.basis).toBe('observed');
    expect(external.window).toEqual(['2023-05-10T19:23:02.000Z', '2026-03-15T12:50:29.000Z']);
    expect(rows.find(r => r.id === 'dao-mnde-held')?.amount?.raw).toBe('153600023536334850');
    expect(rows.filter(r => r.id.startsWith('dormant:'))).toHaveLength(3);
  });
  test('replay is byte-for-byte deterministic despite pack generation time and endpoint metadata', async () => {
    const replay = await buildTokenomics({ root: ROOT, packResult: { ...captured, packet: { ...captured.packet, generatedAt: '2099-01-01T00:00:00Z' } } });
    expect(JSON.stringify(replay.bundle)).toBe(JSON.stringify(built.bundle));
  }, 120_000);
  test('missing fixtures fail closed without attempting a live read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tokenomics-missing-'));
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(noNetwork);
    try {
      mkdirSync(join(root, 'packs/marinade'), { recursive: true });
      for (const file of ['pack.json', 'registry.json', 'contracts.json']) writeFileSync(join(root, 'packs/marinade', file), readFileSync(join(ROOT, 'packs/marinade', file)));
      await expect(buildTokenomics({ root, packResult: captured })).rejects.toThrow('offline: fixture missing');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});

describe.skipIf(!governanceRecorded)('tokenomics HTTP routes', () => {
  test('protocol index, bundle and every section are served', async () => {
    const index = await (await handler('/api/tokenomics')).json();
    expect(index.protocols[0].sections.flows).toBe('ready');
    expect(await (await handler(base)).json()).toEqual(built.bundle);
    for (const section of SECTIONS) expect(await (await handler(`${base}/${section}`)).json()).toEqual(built.bundle[section]);
  });
  test('unknown protocols, sections and nested paths return 404', async () => {
    for (const path of ['/api/tokenomics/other', `${base}/unknown`, `${base}/answer/extra`, `${base}/__proto__`, `${base}/export/.env`]) expect((await handler(path)).status).toBe(404);
  });
  test('evidence supports 200 ids, rejects 201 with 400, and preserves missing identifiers', async () => {
    const ids = [...built.evidence.records.keys()].slice(0, 200), query = ids.map(id => `id=${id}`).join('&');
    const response = await handler(`${base}/evidence?${query}`);
    expect(response.status).toBe(200); expect((await response.json()).items).toHaveLength(200);
    expect((await handler(`${base}/evidence?${query}&id=${ids[0]}`)).status).toBe(400);
    expect(await (await handler(`${base}/evidence?id=${'0'.repeat(64)}`)).json()).toEqual({ items: [], missing: ['0'.repeat(64)] });
  });
  test('cross-origin loader is 403 and unconfigured same-origin loader is 409', async () => {
    expect((await handler(`${base}/graph/load`, { method: 'POST', headers: { Origin: 'https://other.example' } })).status).toBe(403);
    for (const headers of [{ Origin: 'http://localhost:8875' }, undefined]) {
      const response = await handler(`${base}/graph/load`, { method: 'POST', headers });
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'Neo4j is not configured' });
    }
  });
  test('export has the download header and contains the exact bundle', async () => {
    const response = await handler(`${base}/export/tokenomics.json`);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="linchpin-marinade-tokenomics.json"');
    expect(await response.json()).toEqual(built.bundle);
  });
  test('all response variants omit recorder endpoints and credentials', async () => {
    const paths = ['/api/tokenomics', base, ...SECTIONS.map(s => `${base}/${s}`), `${base}/export/tokenomics.json`, `${base}/unknown`, `${base}/evidence?id=api-key`, `${base}/evidence?${[...built.evidence.records.keys()].slice(0, 200).map(id => `id=${id}`).join('&')}`];
    for (const path of paths) {
      const body = await (await handler(path)).text();
      expect(body).not.toContain('alchemy.com/v2'); expect(body).not.toContain('api-key'); expect(body).not.toContain('rpcUrl');
    }
    expect((await tokenomicsRoutes(undefined, request(`${base}/answer`))).status).toBe(503);
    expect((await handler(`${base}/answer`, { method: 'POST' })).status).toBe(405);
  });
});

describe.skipIf(!governanceRecorded)('tokenomics TG graph and service', () => {
  const config = { uri: 'neo4j+s://reader:uri-secret@aura.example:7687', username: 'graph-reader', password: 'password-secret', database: 'neo4j' };
  function fake(changed = false) {
    const graph = buildTokenomicsGraph(built.bundle), calls: { cypher: string; params: any; config: any }[] = [];
    let wrote = false;
    const driver: Neo4jDriverLike = { async executeQuery(cypher, params, config) {
      calls.push({ cypher, params, config });
      if (cypher === TOKENOMICS_NODES_CYPHER || cypher === TOKENOMICS_EDGES_CYPHER) return { records: tokenomicsSubgraph(graph)[cypher === TOKENOMICS_NODES_CYPHER ? 'nodes' : 'edges'].map(row => ({ toObject: () => row })) };
      const query = TOKENOMICS_QUERIES.find(q => q.cypher === cypher);
      if (query) return { records: runTokenomicsLocal(graph, query.id).rows.map(row => ({ toObject: () => row })) };
      const canned = CANNED_QUERIES.find(q => q.cypher === cypher);
      if (canned) {
        const row = Object.fromEntries(canned.columns.map(c => [c, ['inboundControlEdges', 'hops', 'proposals', 'nodes', 'relationships', 'evidence', 'slotMin', 'slotMax'].includes(c) ? 1 : 'recorded']));
        if (changed && wrote && canned.id === CANNED_QUERIES[0].id) row[canned.columns[0]] = 'changed';
        return { records: [{ toObject: () => row }] };
      }
      wrote = true; return { records: [] };
    } };
    return { graph, driver, calls };
  }
  test('namespace rejects forbidden governance-case labels, relationships and unsafe interpolation before writing', async () => {
    const { graph, driver, calls } = fake();
    for (const type of ['TRANSFER', 'BURN', 'X`) DELETE n']) {
      const invalid = { ...graph, relationships: [{ ...graph.relationships[0], type }] };
      expect(() => assertTokenomicsNamespace(invalid)).toThrow();
      await expect(loadTokenomicsNeo4j(driver, invalid, config)).rejects.toThrow();
    }
    for (const labels of [['TG', 'Entity'], ['Entity', 'Metric'], ['TG', 'Metric', 'Entity'], ['TG', 'X`) DELETE n']])
      expect(() => tokenomicsCypherBatches({ ...graph, nodes: [{ ...graph.nodes[0], labels }] })).toThrow();
    expect(calls).toHaveLength(0);
    for (const r of graph.relationships) {
      expect(r.key).toMatch(/^[a-f0-9]{64}$/); expect(r.props.key).toBe(r.key); expect(r.props.evidenceIds).toBeArray(); expect(r.props).toHaveProperty('slot');
    }
  });
  test('loader surrounds parameterized batches with all four READ regression queries', async () => {
    const { graph, driver, calls } = fake();
    // Force more than two full batches of one label, without decoding any fixture again.
    for (let n = 0; n < 1201; n++) graph.nodes.push({ id: `test:${n}`, labels: ['TG', 'Metric'], props: { id: `test:${n}`, label: 'Literal value containing ` and $' } });
    const result = await loadTokenomicsNeo4j(driver, graph, config);
    expect(result.regression).toBe('unchanged'); expect(result.changedQueries).toEqual([]);
    expect(calls.slice(0, 4).map(c => c.cypher)).toEqual(CANNED_QUERIES.map(q => q.cypher));
    expect(calls.slice(-4).map(c => c.cypher)).toEqual(CANNED_QUERIES.map(q => q.cypher));
    expect(calls[4].cypher).toBe('CREATE CONSTRAINT tg_id IF NOT EXISTS FOR (n:TG) REQUIRE n.id IS UNIQUE');
    const writes = calls.filter(c => c.config.routing === 'WRITE');
    expect(writes.length).toBe(result.batches);
    let seenRelationship = false;
    for (const call of writes.filter(c => c.params.rows)) {
      expect(call.params.rows.length).toBeLessThanOrEqual(500); expect(call.params.rows.length).toBeGreaterThan(0);
      expect(call.cypher).toContain('UNWIND $rows'); expect(call.cypher).not.toContain('Literal value');
      if (call.cypher.includes('MERGE (a)-[r:')) seenRelationship = true;
      else expect(seenRelationship).toBe(false);
      expect(call.cypher).not.toContain(':Entity'); expect(call.cypher).not.toContain(':TRANSFER'); expect(call.cypher).not.toContain(':BURN');
    }
    for (const call of [...calls.slice(0, 4), ...calls.slice(-4)]) expect(call.config.routing).toBe('READ');
  });
  test('regression reports the differing governance-case query ids and fails the API graph envelope', async () => {
    const { driver } = fake(true);
    const service = new TokenomicsGraphService(built.bundle, { config, driverFactory: () => driver });
    const loaded = await tokenomicsRoutes(built, request(`${base}/graph/load`, { method: 'POST' }), service);
    const result = await loaded.json();
    expect(result.regression).toBe('changed'); expect(result.changedQueries).toEqual([CANNED_QUERIES[0].id]);
    const response = await (await tokenomicsRoutes(built, request(`${base}/graph`), service)).json();
    expect(response.status).toBe('failed'); expect(response.error).toContain(CANNED_QUERIES[0].id); expect(response.data.source).toBe('local');
  });
  test('all eight local and Neo4j query columns and rows agree; configured API uses READ and caches', async () => {
    const { graph, driver, calls } = fake();
    expect(TOKENOMICS_QUERIES).toHaveLength(8);
    const supply = runTokenomicsLocal(graph, 'supply-control');
    expect(supply.rows).toHaveLength(4);
    expect([...new Set(supply.rows.map(r => r.mint))].sort()).toEqual(['MNDE', 'mSOL']);
    for (const edge of graph.relationships.filter(r => ['MINT_AUTHORITY', 'FREEZE_AUTHORITY'].includes(r.type)))
      expect(graph.nodes.find(n => n.id === edge.source)?.labels).toEqual(['TG', 'Mint']);
    const parameters = runTokenomicsLocal(graph, 'parameter-control');
    expect(parameters.rows.some(r => r.parameter === 'reward Fee' && r.role === 'adminAuthority' && String(r.controller).startsWith('Marinade DAO council ('))).toBe(true);
    for (const edge of graph.relationships.filter(r => r.type === 'MEMBER_OF')) expect(['multisig', 'council-realm']).toContain(String(graph.nodes.find(n => n.id === edge.target)?.props.controllerType));

    for (const q of TOKENOMICS_QUERIES) {
      const local = runTokenomicsLocal(graph, q.id), remote = await runTokenomicsNeo4j(driver, q.id, config);
      expect(local.columns).toEqual(q.columns); expect(remote).toEqual(local); expect(local.rows.length).toBeGreaterThan(0);
      for (const row of local.rows) expect(Object.keys(row)).toEqual(q.columns);
    }
    calls.length = 0;
    const service = new TokenomicsGraphService(built.bundle, { config, driverFactory: () => driver });
    const response = await (await tokenomicsRoutes(built, request(`${base}/graph`), service)).json();
    expect(response.status).toBe('ready'); expect(response.data.source).toBe('neo4j'); expect(response.data.host).toBe('aura.example'); expect(calls).toHaveLength(10);
    await service.query(); expect(calls).toHaveLength(10);
    for (const call of calls) { expect(call.config.routing).toBe('READ'); expect(call.config.transactionConfig.timeout).toBe(5000); }
    expect(response.data.subgraph).toEqual(service.local().subgraph);
  });
  test('a matching query snapshot with stale picture edges falls back instead of claiming Aura provenance', async () => {
    const { driver } = fake();
    const service = new TokenomicsGraphService(built.bundle, { config, driverFactory: () => ({ async executeQuery(cypher, params, options) {
      const response = await driver.executeQuery(cypher, params, options);
      return cypher === TOKENOMICS_EDGES_CYPHER ? { records: response.records.slice(1) } : response;
    } }) });
    const answer = await service.query();
    expect(answer.source).toBe('local');
    expect(answer.reason).toContain('picture differs');
    expect(answer.subgraph).toEqual(service.local().subgraph);
  });
  test('unconfigured and unavailable Neo4j return local API data with scrubbed reasons', async () => {
    let opened = 0;
    const local = new TokenomicsGraphService(built.bundle, { config: null, driverFactory: () => { opened++; throw new Error('must stay lazy'); } });
    expect((await local.query()).source).toBe('local'); expect(opened).toBe(0);
    const unavailable = new TokenomicsGraphService(built.bundle, { config, driverFactory: () => ({ async executeQuery() { throw new Error(`${config.uri} ${config.password} ${config.username} uri-secret`); } }) });
    const response = await (await tokenomicsRoutes(built, request(`${base}/graph`), unavailable)).json();
    expect(response.data.source).toBe('local'); expect(response.data.queries).toHaveLength(8);
    for (const secret of [config.uri, config.username, config.password, 'uri-secret']) expect(response.data.reason).not.toContain(secret);
    const missing = new TokenomicsGraphService(built.bundle, { config, driverFactory: () => ({ async executeQuery() { return { records: [] }; } }) });
    expect((await missing.query()).reason).toContain('snapshot differs');
  });
  test('query deadlines fall back locally and load deadlines retain serialization until the in-flight write settles', async () => {
    const { driver } = fake();
    const timeout = new TokenomicsGraphService(built.bundle, { config, queryTimeoutMs: 5, driverFactory: () => ({ executeQuery: () => new Promise(() => {}) }) });
    expect((await timeout.query()).reason).toContain('timed out');
    let settle!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const service = new TokenomicsGraphService(built.bundle, { config, loadTimeoutMs: 50, driverFactory: () => ({ async executeQuery(cypher, params, cfg) {
      if (cfg.routing === 'WRITE') { entered(); await new Promise<void>(resolve => { settle = resolve; }); return { records: [] }; }
      return driver.executeQuery(cypher, params, cfg);
    } }) });
    const first = service.load();
    const rejected = expect(first).rejects.toMatchObject({ status: 504 });
    await started;
    await expect(service.load()).rejects.toMatchObject({ status: 409 });
    await rejected;
    await expect(service.load()).rejects.toMatchObject({ status: 409 });
    settle();
  });
});


describe.skipIf(!governanceRecorded)('tokenomics disk cache', () => {
  async function withCache(check: (root: string, load: () => Promise<TokenomicsBuild>, logs: string[], calls: () => number) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'tokenomics-cache-')), logs: string[] = [];
    let calls = 0;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(noNetwork);
    const load = () => loadTokenomicsBundle({ root, packResult: captured }, { build: async () => { calls++; return built; }, log: s => logs.push(s) });
    try { await check(root, load, logs, () => calls); expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }
  test('cache hit preserves bundle export and evidence lookup without rebuilding', async () => withCache(async (_root, load, logs, calls) => {
    await load(); const hit = await load(); expect(calls()).toBe(1);
    expect(logs[0]).toMatch(/^tokenomics bundle: cache miss in \d+ ms$/); expect(logs[1]).toMatch(/^tokenomics bundle: cache hit in \d+ ms$/);
    for (const path of [base, `${base}/export/tokenomics.json`, `${base}/evidence?${[...built.evidence.records.keys()].slice(0, 200).map(id => `id=${id}`).join('&')}`, `${base}/unknown`])
      expect(await (await tokenomicsRoutes(hit, request(path))).text()).toBe(await (await tokenomicsRoutes(built, request(path))).text());
  }));
  test('fixture names, sizes, pack inputs and model version invalidate the digest', async () => withCache(async (root, load, _logs, calls) => {
    await load(); const original = tokenomicsDigest(root);
    for (const directory of ['fixtures/marinade-contracts', 'fixtures/marinade-pack', 'packs/marinade/sources/labels']) {
      mkdirSync(join(root, directory), { recursive: true });
      const file = join(root, directory, 'sample.json');
      const before = tokenomicsDigest(root); writeFileSync(file, '{}'); expect(tokenomicsDigest(root)).not.toBe(before);
      await load(); const added = tokenomicsDigest(root); writeFileSync(file, '{"changed":true}'); expect(tokenomicsDigest(root)).not.toBe(added);
      await load();
    }
    expect(calls()).toBe(7); expect(tokenomicsDigest(root)).not.toBe(original);
    expect(tokenomicsDigest(root, 'new-model-version')).not.toBe(tokenomicsDigest(root));
  }));
  test('corrupt JSON and altered payloads are ignored and rewritten', async () => withCache(async (root, load, _logs, calls) => {
    await load(); const file = join(root, 'out/tokenomics/marinade', `bundle-${tokenomicsDigest(root)}.json`);
    writeFileSync(file, '{truncated'); await load(); expect(calls()).toBe(2);
    const cached = JSON.parse(readFileSync(file, 'utf8')); cached.build.bundle.answer.data.shortAnswer.text = 'corrupt';
    writeFileSync(file, JSON.stringify(cached)); await load(); expect(calls()).toBe(3);
    expect((await load()).bundle).toEqual(built.bundle); expect(calls()).toBe(3);
  }));
});

describe('tokenomics bundle cache key', () => {
  test('a change in tokenomics source code changes the cache digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'linchpin-digest-'));
    mkdirSync(join(root, 'src/tokenomics'), { recursive: true });
    writeFileSync(join(root, 'src/tokenomics/sections.ts'), 'export const a = 1;\n');
    const before = tokenomicsDigest(root);
    writeFileSync(join(root, 'src/tokenomics/sections.ts'), 'export const a = 2;\n');
    expect(tokenomicsDigest(root)).not.toBe(before);
    rmSync(root, { recursive: true, force: true });
  });
});
