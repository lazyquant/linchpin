import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTokenomics, type TokenomicsBuild } from '../src/tokenomics/build';
import { answerStatus } from '../src/tokenomics/sections';
import { evidenceIds } from '../src/tokenomics/evidence';
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
const service = new ResearchService();
const request = (path: string, init?: RequestInit) => new Request(`http://localhost:8875${path}`, init);
const handler = (path: string, init?: RequestInit) => api(service)(request(path, init));
const base = '/api/tokenomics/marinade';
const read = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const noNetwork = Object.assign((): never => { throw new Error('Test forbids network'); }, { preconnect: globalThis.fetch.preconnect });

beforeAll(async () => {
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
}, 30_000);

describe('tokenomics recorded backend', () => {
  test('build is offline and the reward fee resolves through admin to Marinade DAO', () => {
    expect(built.reads.live).toBe(0); expect(built.reads.replayed).toBeGreaterThan(0);
    const fee = built.bundle.parameters.data!.rows.find(r => r.field === 'rewardFee')!;
    expect(fee.value).toBe('0'); expect(fee.display).toBe('0 %');
    const setter = fee.setBy.find(s => s.instruction === 'configMarinade')!;
    expect(setter.role).toBe('adminAuthority'); expect(setter.basis).toBe('inferred');
    const controller = built.bundle.control.data!.controllers.find(c => c.id === setter.controllerId)!;
    expect(controller.type).toBe('dao-governance'); expect(controller.realm?.name).toBe('Marinade DAO');
  });
  test('fee units, SOL units and price scaling preserve the exact raw values', () => {
    const rows = built.bundle.parameters.data!.rows;
    expect(rows.find(r => r.field === 'delayedUnstakeFee')).toMatchObject({ value: '2000', display: '0.2 %', unit: '%' });
    expect(rows.find(r => r.field === 'liqPool.treasuryCut')?.display).toBe('50 %');
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
      expect(controllers.find(c => c.id === row.controllerId)).toMatchObject({ type: 'council-realm', label: 'Marinade DAO Emergency Council' });
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
    for (let n = 2; n <= 9; n++) expect(rows.find(r => r.id === `v${n}`)).toMatchObject({ status: 'claimed', note: 'checked in G5' });
  });
  test('missing optional layers stay pending and never imply zero flows or a yes answer', () => {
    for (const section of ['holders', 'flows'] as const) {
      expect(built.bundle[section].status).toBe('pending'); expect(built.bundle[section].data).toBeNull();
      expect(built.bundle[section].notes.length).toBeGreaterThan(0);
    }
    expect(built.bundle.path.data!.links.every(l => l.observed === null)).toBe(true);
    expect(built.bundle.path.data!.links.find(l => l.id === 'delayed-destination')?.status).toBe('pending');
    expect(built.bundle.answer.data!.shortAnswer.status).toBe('partly');
    expect(built.bundle.answer.data!.statements).toHaveLength(8);
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
    expect(graph.source).toBe('local'); expect(graph.queries).toEqual([]); expect(graph.host).toBeNull();
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
  }, 30_000);
  test('missing fixtures fail closed without attempting a live read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tokenomics-missing-'));
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(noNetwork);
    try {
      mkdirSync(join(root, 'packs/marinade'), { recursive: true });
      for (const file of ['pack.json', 'registry.json', 'contracts.json']) writeFileSync(join(root, 'packs/marinade', file), readFileSync(join(ROOT, 'packs/marinade', file)));
      await expect(buildTokenomics({ root, packResult: captured })).rejects.toThrow('offline: fixture missing');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('tokenomics HTTP routes', () => {
  test('protocol index, bundle and every section are served', async () => {
    const index = await (await handler('/api/tokenomics')).json();
    expect(index.protocols[0].sections.flows).toBe('pending');
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
  test('cross-origin loader is 403 and same-origin loader is 501', async () => {
    expect((await handler(`${base}/graph/load`, { method: 'POST', headers: { Origin: 'https://other.example' } })).status).toBe(403);
    for (const headers of [{ Origin: 'http://localhost:8875' }, undefined]) {
      const response = await handler(`${base}/graph/load`, { method: 'POST', headers });
      expect(response.status).toBe(501); expect(await response.json()).toEqual({ error: 'tokenomics graph loader not built yet' });
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
    expect(tokenomicsRoutes(undefined, request(`${base}/answer`)).status).toBe(503);
    expect((await handler(`${base}/answer`, { method: 'POST' })).status).toBe(405);
  });
});
