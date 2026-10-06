import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CASES, present, withBaseline, type CaseId, type Result } from '../src/web/model';
import { compareState, stateFacts } from '../src/web/diff';
import { runPipeline, ROOT, type PipelineOptions, type Run } from '../src/web/runner';
import { ResearchService, api } from '../src/web/server';
import { RecordingRpc } from '../src/chain/rpc';
import { runOptions } from '../src/config';
import { formatUnits } from '../src/chain/token-layout';
import * as packModule from '../src/pack/build';

const baseline = new Map<CaseId, Result>();
const dirs: string[] = [];
const endpoint = 'https://alice:private-password@rpc.example/v2/private-api-key-123456?api-key=query-secret';
const env = { ...process.env };
beforeAll(async () => { for (const c of CASES) baseline.set(c.id, await runPipeline(c.id)); }, 30_000);
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ['LINCHPIN_RPC_URL', 'LINCHPIN_RPC_TIMEOUT_MS', 'LINCHPIN_RPC_MIN_INTERVAL_MS']) {
    if (env[key] == null) delete process.env[key]; else process.env[key] = env[key];
  }
});
const request = (path: string, method = 'GET') => new Request(`http://127.0.0.1:8875/api/${path}`, { method });
async function settled(run: Run) {
  for (let i = 0; i < 200 && run.status === 'running'; i++) await Bun.sleep(5);
  expect(run.status).not.toBe('running');
}
function fakeLive(id: CaseId = 'mip-14') {
  const result = structuredClone(baseline.get(id)!);
  result.packet.offline = false;
  const fact = result.packet.stateFacts!.find(f => f.id.startsWith('balance:'))!;
  const oldId = fact.evidenceIds[0], old = result.evidence.find(e => e.id === oldId)!;
  const raw = BigInt(fact.raw!) + 1_000_000_001n;
  fact.raw = String(raw); fact.value = formatUnits(raw, 9); fact.slot = 555_000_000; fact.evidenceIds = ['live-balance'];
  result.evidence = result.evidence.map(e => e.id === oldId ? { ...old, id: 'live-balance', slot: fact.slot, retrievedAt: '2026-10-06T14:00:00.000Z', source: 'rpc' } : e);
  return result;
}
function stubService(pipeline: typeof runPipeline, cap?: number) {
  const service = new ResearchService(async (id, emit, options) => { if (options?.outDir) dirs.push(options.outDir); return pipeline(id, emit, options); }, cap);
  for (const [id, result] of baseline) service.results.set(id, result);
  return service;
}

describe('captured versus current state', () => {
  test.each(CASES.map(c => c.id))('%s offline packet compared with itself has no changes and retains provenance', id => {
    const result = baseline.get(id)!;
    const diff = compareState(result, result);
    expect(diff.changedCount).toBe(0);
    expect(diff.stateDiff.length).toBeGreaterThan(1);
    for (const row of diff.stateDiff) {
      expect(row.changed).toBe(false);
      expect(row.capturedSlot).not.toBeNull();
      expect(row.capturedAt).not.toBeNull();
      expect(row.evidenceIds.captured.length).toBeGreaterThan(0);
      expect(row.evidenceIds.current).toEqual(row.evidenceIds.captured);
    }
  });
  test('extracts all balances, supplies, controllers, proposal and conditional outcomes', () => {
    const pack = baseline.get('marinade')!;
    const facts = stateFacts(pack);
    expect(facts.filter(f => f.id.startsWith('authority:')).length).toBe('pack' in pack.packet ? pack.packet.controllerPaths.length : 0);
    for (const text of ['mnde supply', 'council-mint supply', 'Governance-list size', 'buyback', 'treasury']) expect(facts.some(f => f.label.includes(text))).toBe(true);
    expect(facts.filter(f => f.id.startsWith('balance:')).length).toBeGreaterThanOrEqual(4);
    const review = baseline.get('bonk-bip76')!;
    const rows = stateFacts(review);
    expect(rows.some(f => f.id === 'proposal-state')).toBe(true);
    expect(rows.some(f => f.id === 'latest-slot')).toBe(true);
    if ('caseId' in review.packet) expect(rows.filter(f => f.id.startsWith('simulation:'))).toHaveLength(review.packet.simulated.length);
    expect(rows.filter(f => f.id.startsWith('balance:')).length).toBeGreaterThan(1);
    expect(rows.some(f => f.id.startsWith('supply:'))).toBe(true);
  });
  test('changed treasury value retains exact units, raw strings, both slots, dates and evidence lists', () => {
    const captured = baseline.get('mip-14')!, current = fakeLive();
    const before = captured.packet.stateFacts!.find(f => f.id.startsWith('balance:'))!;
    const after = current.packet.stateFacts!.find(f => f.id === before.id)!;
    const diff = compareState(captured, current), row = diff.stateDiff.find(f => f.id === before.id)!;
    expect(row).toMatchObject({ changed: true, captured: before.value, current: after.value, capturedSlot: before.slot, currentSlot: 555_000_000,
      capturedAt: captured.evidence.find(e => e.id === before.evidenceIds[0])!.retrievedAt, currentAt: '2026-10-06T14:00:00.000Z',
      raw: { captured: before.raw, current: after.raw }, evidenceIds: { captured: before.evidenceIds, current: ['live-balance'] } });
    expect(diff.stateDiff.find(f => f.id === 'proposal-state')!.changed).toBe(false);
    expect(diff.changedCount).toBe(2); // Balance and latest slot.
  });
  test('missing accounts and skipped simulations stay visible rather than disappearing', () => {
    const captured = baseline.get('mip-14')!, current = structuredClone(captured);
    current.packet.stateFacts = current.packet.stateFacts!.filter(f => !f.id.startsWith('balance:'));
    if ('caseId' in current.packet) current.packet.simulated = [];
    const diff = compareState(captured, current);
    expect(diff.stateDiff.find(f => f.id.startsWith('balance:'))).toMatchObject({ changed: true, current: 'Unavailable' });
    expect(diff.stateDiff.find(f => f.id.startsWith('simulation:'))).toMatchObject({ changed: true, current: 'Not simulated' });
  });
});

describe('refresh service and source routes', () => {
  test('publishes isolated live views, sources and file exports without changing the captured result', async () => {
    process.env.LINCHPIN_RPC_URL = endpoint;
    const before = structuredClone(baseline.get('mip-14')!);
    const outputFiles = ['packet.json', 'graph.json', 'evidence.jsonl', 'memo.md'];
    const capturedFiles = outputFiles.map(f => readFileSync(join(ROOT, 'out/web/mip-14', f), 'utf8'));
    const service = stubService(async (_id, emit, options) => {
      expect(options?.source).toBe('live'); expect(options?.signal).toBeInstanceOf(AbortSignal);
      emit?.({ at: '2026-10-06T14:00:00.000Z', message: `Read ${endpoint}`, liveReads: 1, replayedReads: 0 });
      return fakeLive();
    });
    const handler = api(service);
    for (const path of ['', '/sources', '/export/memo.md']) expect((await handler(request(`cases/mip-14${path}?source=live`))).status).toBe(404);
    const started = await handler(request('cases/mip-14/refresh', 'POST'));
    expect(started.status).toBe(202);
    const run = service.runs.get((await started.json()).id)!; await settled(run);
    expect(run.status).toBe('completed'); expect(run.rpcHost).toBe('https://rpc.example');
    expect(JSON.stringify(run)).not.toContain('private'); expect(JSON.stringify(run)).not.toContain('query-secret');
    const captured = await (await handler(request('cases/mip-14'))).json();
    expect(captured).toEqual(before.view);
    expect(service.results.get('mip-14')).toEqual(before);
    expect(outputFiles.map(f => readFileSync(join(ROOT, 'out/web/mip-14', f), 'utf8'))).toEqual(capturedFiles);
    const live = await (await handler(request('cases/mip-14?source=live'))).json();
    expect(live.freshness).toMatchObject({ source: 'live', rpcHost: 'https://rpc.example', liveReads: 1, retrievedAt: ['2026-10-06T14:00:00.000Z', '2026-10-06T14:00:00.000Z'], slotRange: [555_000_000, 555_000_000] });
    expect(live.freshness.dir).toMatch(/^out\/web\/mip-14\/live\/\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
    expect(live.changedCount).toBe(2);
    expect(live.memo).toContain('Live read at 2026-10-06T14:00:00.000Z, slot 555000000, host https://rpc.example · captured baseline');
    expect(live.memo).toContain('## What changed since capture');
    const sources = await (await handler(request('cases/mip-14/sources?source=live&id=live-balance'))).json();
    expect(sources.items).toHaveLength(1); expect(sources.items[0].slot).toBe(555_000_000);
    expect((await (await handler(request('cases/mip-14/sources?id=live-balance'))).json()).items).toHaveLength(0);
    for (const file of outputFiles) {
      const exported = await handler(request(`cases/mip-14/export/${file}?source=live`));
      expect(exported.headers.get('content-disposition')).toContain(file.replace(/(\.[^.]+)$/, '-live$1'));
      expect(await exported.text()).toBe(readFileSync(join(ROOT, live.freshness.dir, file), 'utf8'));
      expect((await handler(request(`cases/mip-14/export/${file}`))).headers.get('content-disposition')).not.toContain('-live');
    }
    expect((await (await handler(request('cases'))).json()).find((c: { id: string }) => c.id === 'mip-14').hasLive).toBe(true);
  });
  test('unchanged live memo says nothing changed; captured memo is unchanged', () => {
    const result = baseline.get('marinade')!, memo = result.view.memo;
    const live = withBaseline(present('marinade', result.packet, result.evidence, { rpcHost: endpoint, dir: 'out/web/marinade/live/test' }), result);
    expect(live.view.memo).toContain('Nothing changed since capture');
    expect(result.view.memo).toBe(memo); expect(memo).not.toContain('What changed since capture');
  });
  test('one refresh per case and distinct directories for later refreshes', async () => {
    let finish!: (result: Result) => void, calls = 0;
    const service = stubService(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const first = service.start('mip-14', 'live');
    expect(service.start('mip-14', 'live')).toBe(first); expect(calls).toBe(1);
    finish(fakeLive()); await settled(first);
    const second = service.start('mip-14', 'live');
    expect(second.id).not.toBe(first.id); finish(fakeLive()); await settled(second);
    expect(dirs[0]).not.toBe(dirs[1]);
  });
  test.each(['throw', 'timeout'] as const)('%s reports failed, keeps captured current and ignores late completion', async kind => {
    process.env.LINCHPIN_RPC_URL = endpoint;
    let late!: (result: Result) => void, signal: AbortSignal | undefined;
    const service = stubService(async (_id, _emit, options) => {
      signal = options?.signal;
      if (kind === 'throw') throw new Error(`RPC unavailable ${endpoint} private-password query-secret`);
      return new Promise(resolve => { late = resolve; });
    }, 15);
    const before = structuredClone(service.results.get('mip-14'));
    const run = service.start('mip-14', 'live'); await settled(run);
    expect(run.status).toBe('failed'); expect(run.error).toContain(kind === 'timeout' ? 'timed out' : 'RPC unavailable');
    expect(run.error).not.toContain('private'); expect(run.error).not.toContain('query-secret');
    expect(signal?.aborted).toBe(true);
    if (kind === 'timeout') { late(fakeLive()); await Bun.sleep(5); }
    expect(service.results.get('mip-14')).toEqual(before); expect(service.liveResults.has('mip-14')).toBe(false);
    expect((await api(service)(request('cases/mip-14?source=live'))).status).toBe(404);
    expect((await (await api(service)(request(`runs/${run.id}`))).json()).status).toBe('failed');
  });
});

test('Marinade refresh records control reads through env options and passes only the offline RPC to the proposal ledger', async () => {
  process.env.LINCHPIN_RPC_URL = endpoint;
  process.env.LINCHPIN_RPC_TIMEOUT_MS = '4321'; process.env.LINCHPIN_RPC_MIN_INTERVAL_MS = '0';
  const original = packModule.buildPack;
  const offline = new RecordingRpc(runOptions({ offline: true, fixturesDir: join(ROOT, 'fixtures'), rpcUrl: 'http://127.0.0.1:1' }), 'marinade-pack');
  let ledgerRpc: RecordingRpc | undefined, liveRpc: RecordingRpc | undefined, programReads = 0;
  const stub = spyOn(packModule, 'buildPack').mockImplementation(async (rpc, registry, options) => {
    ledgerRpc = options?.ledgerRpc; liveRpc = rpc;
    expect(ledgerRpc).toBeInstanceOf(RecordingRpc); expect(ledgerRpc).not.toBe(rpc);
    expect(ledgerRpc!.opts).toMatchObject({ offline: true, record: false, fixturesDir: join(ROOT, 'fixtures') });
    expect(rpc.opts).toMatchObject({ offline: false, record: true, refresh: true, rpcUrl: endpoint, requestTimeoutMs: 4321, minIntervalMs: 0 });
    expect(rpc.opts.fixturesDir).toBe(join(rpc.opts.outDir, 'fixtures'));
    ledgerRpc!.connection.getProgramAccounts = async () => { throw new Error('Offline ledger attempted network'); };
    ledgerRpc!.connection.getAccountInfoAndContext = async () => { throw new Error('Offline ledger attempted network'); };
    rpc.connection.getAccountInfoAndContext = async pk => {
      // Extra owner classifications may be absent from the committed boundary.
      const read = await offline.getAccountInfo(pk).catch(error => {
        if (!String(error).includes('offline: fixture missing')) throw error;
        return { value: null };
      });
      return { context: { slot: 555_000_000 }, value: read.value };
    };
    rpc.connection.getProgramAccounts = (async (program, config) => {
      const filters = typeof config === 'object' ? config.filters ?? [] : [];
      expect(filters.some(f => 'memcmp' in f && f.memcmp.offset === 1 && f.memcmp.bytes === registry.governance.realm)).toBe(true);
      // A proposal scan filters by governance address, never by realm.
      programReads++;
      return { context: { slot: 555_000_000 }, value: (await offline.getProgramAccounts(program, filters)).value };
    }) as typeof rpc.connection.getProgramAccounts;
    return original(rpc, registry, options);
  });
  const service = stubService(runPipeline);
  try {
    const run = service.start('marinade', 'live'); await settled(run);
    expect(run.error).toBeUndefined(); expect(run.status).toBe('completed');
    expect(programReads).toBeGreaterThan(0); expect(programReads).toBeLessThan(10);
    expect(ledgerRpc!.counts.live).toBe(0); expect(ledgerRpc!.counts.replayed).toBeGreaterThan(277);
    expect(liveRpc!.counts.live).toBeGreaterThan(30);
    const result = service.liveResults.get('marinade')!;
    expect(result.view.ledger!.proposalsScanned).toBe(277);
    expect(result.view.ledger!.summary).toEqual(baseline.get('marinade')!.view.ledger!.summary);
    expect(result.view.freshness).toMatchObject({ liveReads: liveRpc!.counts.live, replayedReads: ledgerRpc!.counts.replayed, rpcHost: 'https://rpc.example' });
    expect(result.view.freshness.retrievedAt[0].slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(existsSync(join(ROOT, result.view.freshness.dir!, 'fixtures/marinade-pack'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-api-key');
  } finally { stub.mockRestore(); }
}, 15_000);

test('the refresh deadline aborts an in-flight fetch, stops retries and does not publish evidence', async () => {
  const controller = new AbortController();
  const dir = join(ROOT, 'out/web/mip-14/live/abort-test-' + crypto.randomUUID()); dirs.push(dir);
  const rpc = new RecordingRpc(runOptions({ offline: false, record: true, refresh: true, rpcUrl: endpoint, fixturesDir: join(dir, 'fixtures'), outDir: dir, minIntervalMs: 0, requestTimeoutMs: 30_000 }), 'mip-14', { signal: controller.signal });
  let fetchSignal: AbortSignal | null | undefined;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const stub = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetchSignal = init?.signal; started();
    return new Promise<Response>((_resolve, reject) => fetchSignal!.addEventListener('abort', () => reject(fetchSignal!.reason), { once: true }));
  }, { preconnect: fetch.preconnect }));
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const read = rpc.getBalance(PublicKey.default);
    const caught = read.catch(error => error);
    await start; controller.abort(new Error('Refresh deadline reached'));
    expect((await caught).message).toBe('Refresh deadline reached');
    expect(fetchSignal!.aborted).toBe(true); expect(stub).toHaveBeenCalledTimes(1);
    expect(rpc.counts).toEqual({ live: 0, replayed: 0, retries: 0 });
    expect(rpc.evidence).toHaveLength(0); expect(existsSync(join(dir, 'fixtures'))).toBe(false);
    await expect(rpc.getBalance(PublicKey.default)).rejects.toThrow('Refresh deadline reached');
    expect(stub).toHaveBeenCalledTimes(1);
  } finally { stub.mockRestore(); }
});
