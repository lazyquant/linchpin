import index from './index.html';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildGraphRecords } from '../graph/neo4j';
import { GraphService, GraphError, type GraphOptions, type GraphAnswer } from './graph';
import { graphSummary } from './graph-view';
import { DEFAULT_RPC_URL } from '../config';
import { redactedRpcUrl, redactSecrets } from '../chain/rpc';
import { CASES, present, withBaseline, makeMemo, type CaseId, type Result } from './model';
import { runPipeline, liveDirectory, saveResult, ROOT, type Run } from './runner';
import type { TokenomicsBuild } from '../tokenomics/build';
import { loadTokenomicsBundle } from '../tokenomics/cache';
import { TokenomicsGraphService } from '../tokenomics/graph-service';
import { tokenomicsRoutes } from './tokenomics-routes';

export class ResearchService {
  results = new Map<CaseId, Result>();
  liveResults = new Map<CaseId, Result>();
  runs = new Map<string, Run>();
  tokenomics?: TokenomicsBuild;
  private graphService?: GraphService;
  private tokenomicsGraphService?: TokenomicsGraphService;
  get tokenomicsGraph() {
    if (!this.tokenomics) return undefined;
    return this.tokenomicsGraphService ??= new TokenomicsGraphService(this.tokenomics.bundle, this.graphOptions);
  }
  constructor(private pipeline = runPipeline, private refreshTimeoutMs = 120_000, private graphOptions: GraphOptions = {}) {}
  get graph() {
    return this.graphService ??= new GraphService(buildGraphRecords([...this.results].map(([caseId, result]) => ({ caseId, ...result }))), this.graphOptions);
  }
  async prepare() {
    for (const c of CASES) this.results.set(c.id, await this.pipeline(c.id));
    this.publishGraph(this.graph.local());
  }
  private publishGraph(answer: GraphAnswer) {
    const summary = graphSummary(answer); if (!summary) return;
    for (const result of [...this.results.values(), ...this.liveResults.values()]) {
      result.view.crossCaseGraph = summary;
      result.view.memo = makeMemo(result.view, result.sources);
      const file = join(ROOT, result.view.freshness.dir ?? `out/web/${result.view.id}`, 'memo.md');
      if (existsSync(file)) writeFileSync(file, result.view.memo);
    }
  }
  async graphAnswer(id?: string) {
    const answer = await this.graph.query(id); this.publishGraph(answer); return answer;
  }
  async close() { await this.graphService?.close(); await this.tokenomicsGraphService?.close(); }
  start(caseId: CaseId, source: 'captured' | 'live' = 'captured'): Run {
    const existing = [...this.runs.values()].find(r => r.caseId === caseId && r.status === 'running');
    if (existing) return existing;
    for (const [id, r] of this.runs) if (this.runs.size >= 64 && r.status !== 'running') this.runs.delete(id);
    const run: Run = { id: crypto.randomUUID(), caseId, source, status: 'running', events: [], rpcHost: null };
    this.runs.set(run.id, run);
    void this.execute(run);
    return run;
  }
  private async execute(run: Run) {
    const live = run.source === 'live', endpoint = process.env.LINCHPIN_RPC_URL ?? DEFAULT_RPC_URL;
    const scrub = (text: string) => redactSecrets(text, endpoint);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const captured = this.results.get(run.caseId);
      if (live && !captured) throw new Error('Captured baseline is not ready');
      if (live) run.rpcHost = redactedRpcUrl(endpoint);
      const outDir = live ? liveDirectory(run.caseId) : undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        if (live) timer = setTimeout(() => {
          const error = new Error(`Refresh timed out after ${this.refreshTimeoutMs / 1000} seconds. The captured example remains available.`);
          controller.abort(error); reject(error);
        }, this.refreshTimeoutMs);
      });
      const result = await Promise.race([this.pipeline(run.caseId, event => {
        if (run.status === 'running' && !controller.signal.aborted) run.events.push({ ...event, message: scrub(event.message) });
      }, { source: run.source, outDir, signal: controller.signal }), timeout]);
      controller.signal.throwIfAborted();
      if (live) {
        const current = withBaseline(present(run.caseId, result.packet, result.evidence, { rpcHost: run.rpcHost!, dir: relative(ROOT, outDir!) }), captured!);
        if (this.graphService) {
          current.view.crossCaseGraph = captured!.view.crossCaseGraph;
          current.view.memo = makeMemo(current.view, current.sources);
        }
        saveResult(current, outDir!);
        this.liveResults.set(run.caseId, current);
      } else if (!captured) this.results.set(run.caseId, result);
      else if (captured.view.crossCaseGraph) {
        // The offline pipeline writes a case-only memo. Keep its web artifact
        // aligned with the captured view, including the cross-case retrieval.
        writeFileSync(join(ROOT, 'out/web', run.caseId, 'memo.md'), captured.view.memo);
      }
      run.status = 'completed';
    } catch (error) {
      run.status = 'failed';
      run.error = scrub(`${live ? 'Refresh' : 'Recorded research'} failed: ${error instanceof Error ? error.message : String(error)} The captured example remains available.`);
      run.events.push({ at: new Date().toISOString(), message: run.error });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
/** Bun closes a connection after 10 s without response bytes by default, which cut Neo4j loads (up to the 120 s load cap) and slow Aura answers. Must exceed that cap and stay within Bun's 255 s maximum. */
export const SERVER_IDLE_TIMEOUT_SECONDS = 150;
const exports = { 'memo.md': 'text/markdown; charset=utf-8', 'packet.json': 'application/json', 'graph.json': 'application/json', 'evidence.jsonl': 'application/x-ndjson' } as const;
export function api(service: ResearchService) {
  return async (request: Request): Promise<Response> => {
    const u = new URL(request.url); const parts = u.pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && (u.pathname === '/favicon.svg' || u.pathname === '/favicon.ico')) return new Response(
      readFileSync(join(ROOT, 'favicon.svg'), 'utf8'),
      { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } },
    );
    if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== u.origin) return json({ error: 'Same-origin requests only' }, 403);
    if (parts[0] === 'api' && parts[1] === 'tokenomics') {
      try { return await tokenomicsRoutes(service.tokenomics, request, service.tokenomicsGraph); }
      finally { if (request.method === 'POST' && parts[3] === 'graph' && parts[4] === 'load') service.graph.invalidateSummary(); }
    }
    if (parts[0] === 'api' && parts[1] === 'graph') {
      try {
        if (request.method === 'GET' && parts.length === 3 && ['summary', 'proposal-dependencies', 'governance-cases'].includes(parts[2])) {
          const tokenomics = service.tokenomicsGraph?.graph;
          if (!tokenomics) return json({ error: 'Tokenomics captured build is not ready' }, 503);
          if (parts[2] === 'summary') return json(await service.graph.summary(tokenomics));
          if (parts[2] === 'governance-cases') return json(await service.graph.governanceTouches(tokenomics));
          const caseId = u.searchParams.get('case');
          if (!CASES.some(c => c.id === caseId)) return json({ error: 'Case not found' }, 404);
          return json(await service.graph.proposalDependencies(tokenomics, caseId!));
        }
        if (request.method === 'GET' && parts.length <= 3) return json(await service.graphAnswer(parts[2]));
        if (request.method === 'POST' && parts[2] === 'load' && parts.length === 3) return json(await service.graph.load());
        return json({ error: 'Method not allowed' }, 405);
      } catch (error) {
        return json({ error: error instanceof GraphError ? error.message : 'Graph request failed' }, error instanceof GraphError ? error.status : 500);
      }
    }
    if (request.method === 'GET' && u.pathname === '/api/cases') return json(CASES.map(({file, ...c}) => ({ ...c, ready: service.results.has(c.id), hasLive: service.liveResults.has(c.id) })));
    if (parts[1] === 'runs' && request.method === 'GET' && parts.length === 3) {
      const run = service.runs.get(parts[2]); return run ? json(run) : json({ error: 'Run not found' }, 404);
    }
    const scope = CASES.find(c => c.id === parts[2]);
    if (parts[1] !== 'cases' || !scope) return json({ error: 'Case not found' }, 404);
    if (request.method === 'POST' && ['run', 'refresh'].includes(parts[3]) && parts.length === 4) return json(service.start(scope.id, parts[3] === 'refresh' ? 'live' : 'captured'), 202);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const source = u.searchParams.get('source') ?? 'captured';
    if (!['captured', 'live'].includes(source)) return json({ error: 'Source must be captured or live' }, 400);
    const result = (source === 'live' ? service.liveResults : service.results).get(scope.id);
    if (!result && source === 'live') return json({ error: 'No live result yet. Refresh from chain to capture current evidence.' }, 404);
    if (!result) return json({ error: 'Completed example not ready' }, 503);
    if (parts.length === 3) return json(result.view);
    if (parts[3] === 'sources' && parts.length === 4) {
      const query = (u.searchParams.get('q') ?? '').toLowerCase().slice(0, 250);
      const ids = u.searchParams.getAll('id');
      const matches = result.sources.filter(s => (!ids.length || ids.includes(s.id)) && (!query || `${s.title} ${s.id} ${s.capturedAt} ${s.slot} ${JSON.stringify(s.detail)}`.toLowerCase().includes(query)));
      return json({ total: matches.length, items: matches.slice(0, 150), more: matches.length > 150 });
    }
    if (parts[3] === 'export' && parts.length === 5 && Object.hasOwn(exports, parts[4])) {
      const file = parts[4] as keyof typeof exports;
      const body = source === 'live' ? readFileSync(join(ROOT, result.view.freshness.dir!, file), 'utf8') : file === 'memo.md' ? result.view.memo : file === 'evidence.jsonl' ? result.evidence.map(e => JSON.stringify(e)).join('\n') + '\n' : JSON.stringify(file === 'graph.json' ? result.view.graph : result.packet, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
      return new Response(body, { headers: { 'Content-Type': exports[file], 'Content-Disposition': `attachment; filename="linchpin-${scope.id}-${source === 'live' ? file.replace(/(\.[^.]+)$/, '-live$1') : file}"`, 'Cache-Control': 'no-store' } });
    }
    return json({ error: 'Resource not found' }, 404);
  };
}

if (import.meta.main) {
  const service = new ResearchService();
  console.log('Preparing four completed examples from recorded fixtures…');
  await service.prepare();
  service.tokenomics = await loadTokenomicsBundle({ root: ROOT, packResult: service.results.get('marinade')! });
  process.once('SIGINT', () => { void service.close().catch(() => {}).finally(() => process.exit(0)); });
  const port = Number(process.env.LINCHPIN_WEB_PORT ?? 8875);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('LINCHPIN_WEB_PORT must be an integer from 1024 to 65535');
  const handler = api(service);
  const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS, routes: { '/': index }, fetch: handler, development: false });
  console.log(`Linchpin research workspace: ${server.url} · captured examples ready · live refresh available`);
}
