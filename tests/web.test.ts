import { describe, test, expect, beforeAll } from 'bun:test';
import { CASES } from '../src/web/model';
import { runPipeline, ROOT } from '../src/web/runner';
import { ResearchService, api, SERVER_IDLE_TIMEOUT_SECONDS } from '../src/web/server';
import { readFileSync } from 'node:fs';
import { liveActivityIntro } from '../src/web/activity-view';

const service = new ResearchService();
beforeAll(async () => { await service.prepare(); }, 120_000);
const request = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1:8875${path}`, init);

describe('local research workspace with real recorded evidence', () => {
  test('the browser bundle resolves the favicon and client modules', async () => {
    const build = await Bun.build({ entrypoints: [new URL('../src/web/index.html', import.meta.url).pathname], root: ROOT, target: 'browser' });
    expect(build.success).toBe(true);
    expect(build.outputs.some(output => output.path.endsWith('.svg'))).toBe(true);
  });
  test('legacy /favicon.ico requests get the same brand mark instead of a 404', async () => {
    const response = await api(service)(request('/favicon.ico'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
  });
  test('the guided walkthrough memo is served from stored research, with citations and review limits', async () => {
    const response = await api(service)(request('/api/walkthrough/bonk/memo.md'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toContain('linchpin-bonk-walkthrough-memo.md');
    const memo = await response.text();
    expect(memo).toContain('Draft · human review pending');
    expect(memo).toContain('0.00033');
    expect((await api(service)(request('/api/walkthrough/other/memo.md'))).status).toBe(404);
    expect((await api(service)(request('/api/walkthrough/bonk/memo.md', { method: 'POST' }))).status).toBe(405);
  });
  test('the server keeps connections open longer than the 120 s Neo4j load cap (Bun default is 10 s)', () => {
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(120);
    expect(SERVER_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });
  test('favicon serves the existing brand mark with a one-day cache', async () => {
    const response = await api(service)(request('/favicon.svg'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    const svg = await response.text();
    const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(html.match(/<path d="[^"]+"/)![0]);
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });
  test('live activity describes the displayed view, while captured and running intros stay unchanged', () => {
    const captured = service.results.get('marinade')!.view;
    const live = { ...captured, baselineRange: ['2026-09-30T12:00:00Z', '2026-10-02T14:00:00Z'],
      freshness: { ...captured.freshness, source: 'live' as const, retrievedAt: ['2026-10-06T14:00:00Z'], rpcHost: 'https://rpc.example', liveReads: 42 } };
    expect(liveActivityIntro(live, false)).toBe('Live result open · read 2026-10-06T14:00:00Z via https://rpc.example · 42 live reads. Captured baseline 2026-09-30 — 2026-10-02. Run research replays recorded evidence; Refresh from chain reads current state again.');
    expect(liveActivityIntro(captured, false)).toBeNull();
    expect(liveActivityIntro(live, true)).toBeNull();
    expect(liveActivityIntro(null, false)).toBeNull();
  });
  test('all four cases replay and each displayed citation resolves', () => {
    for (const c of CASES) {
      const r = service.results.get(c.id)!;
      expect(r.view.evidenceCount).toBeGreaterThan(0);
      expect(r.packet.offline).toBe(true);
      const ids = new Set(r.sources.map(s => s.id));
      for (const f of r.view.findings) for (const id of f.sourceIds) expect(ids.has(id)).toBe(true);
      expect(r.view.memo).toContain('human review pending');
    }
  });
  test('Bonk stays retrospective, includes receipts and does not turn claims into verified voter counts', () => {
    const r = service.results.get('bonk-bip76')!;
    expect(r.view.timeline.length).toBe(5);
    expect(r.view.unknowns.join(' ')).toContain('retrospective reconstruction');
    expect(r.view.unknowns.join(' ')).toContain('not established');
    expect(r.view.findings.find(f => f.title === 'Treasury movement')?.text).toContain('4,426,104,450,305.966');
    expect(r.view.paths[0].nodeIds.length).toBe(4);
  });
  test('Marinade includes real ledger scope and observed flow citations', () => {
    const r = service.results.get('marinade')!;
    expect(r.view.ledger!.proposalsScanned).toBe(277);
    expect(r.view.ledger!.entries.length).toBe(289);
    const path = r.view.paths[0];
    expect(path.nodeIds.map(id => r.view.graph.nodes.find(n => n.id === id)!.type)).toEqual(['TokenAccount', 'NativeTreasury', 'Governance', 'Realm']);
    expect(new Set(path.nodeIds).size).toBe(path.nodeIds.length);
    expect(r.view.findings.filter(f => f.id.startsWith('ledger-')).every(f => f.sourceIds.length > 0)).toBe(true);
    expect(r.view.unknowns.join(' ')).toContain('complete buyback');
  });
  test('signaling example has no invented burn control path or simulation', () => {
    const r = service.results.get('mip-14-opinion')!;
    expect(r.view.paths).toHaveLength(0);
    expect(r.view.findings.some(f => f.basis === 'simulated')).toBe(false);
  });
  test('run activity comes from an actual offline rebuild', async () => {
    const events: string[] = [];
    const r = await runPipeline('mip-14', e => events.push(e.message));
    expect(r.view.findings.length).toBeGreaterThan(0);
    expect(events.at(-1)).toContain('0 live reads');
    expect(events.join(' ')).toContain('reconciled 1 execution receipts');
  });
  test('routes reject unknown cases, arbitrary file paths and cross-origin writes', async () => {
    const handler = api(service);
    expect((await handler(request('/api/cases/../../.env'))).status).toBe(404);
    expect((await handler(request('/api/cases/mip-14/export/.env'))).status).toBe(404);
    expect((await handler(request('/api/cases/mip-14/run', {method:'POST', headers:{Origin:'https://elsewhere.example'}}))).status).toBe(403);
  });
  test('memo and evidence downloads preserve exact data and source hashes', async () => {
    const handler = api(service);
    const memo = await handler(request('/api/cases/bonk-bip76/export/memo.md'));
    expect(memo.headers.get('content-disposition')).toContain('attachment');
    expect(await memo.text()).toBe(service.results.get('bonk-bip76')!.view.memo);
    const evidence = await handler(request('/api/cases/bonk-bip76/export/evidence.jsonl'));
    const first = JSON.parse((await evidence.text()).split('\n')[0]);
    expect(first.responseSha256).toHaveLength(64);
    expect(first.id).toHaveLength(64);
  });
  test('failed rebuilds retain the completed example', async () => {
    const fail = new ResearchService(async () => { throw new Error('fixture unavailable'); });
    fail.results.set('mip-14', service.results.get('mip-14')!);
    const run = fail.start('mip-14');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(run.status).toBe('failed');
    expect(fail.results.get('mip-14')).toBe(service.results.get('mip-14'));
  });
});
