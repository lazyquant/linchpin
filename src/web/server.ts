import index from './index.html';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_RPC_URL } from '../config';
import { redactedRpcUrl, redactSecrets } from '../chain/rpc';
import { CASES, present, withBaseline, type CaseId, type Result } from './model';
import { runPipeline, liveDirectory, saveResult, ROOT, type Run } from './runner';

export class ResearchService {
  results = new Map<CaseId, Result>();
  liveResults = new Map<CaseId, Result>();
  runs = new Map<string, Run>();
  constructor(private pipeline = runPipeline, private refreshTimeoutMs = 120_000) {}
  async prepare() { for (const c of CASES) { this.results.set(c.id, await this.pipeline(c.id)); } }
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
        saveResult(current, outDir!);
        this.liveResults.set(run.caseId, current);
      } else if (!captured) this.results.set(run.caseId, result);
      run.status = 'completed';
    } catch (error) {
      run.status = 'failed';
      run.error = scrub(`${live ? 'Refresh' : 'Recorded research'} failed: ${error instanceof Error ? error.message : String(error)} The captured example remains available.`);
      run.events.push({ at: new Date().toISOString(), message: run.error });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const exports = { 'memo.md': 'text/markdown; charset=utf-8', 'packet.json': 'application/json', 'graph.json': 'application/json', 'evidence.jsonl': 'application/x-ndjson' } as const;
export function api(service: ResearchService) {
  return async (request: Request): Promise<Response> => {
    const u = new URL(request.url); const parts = u.pathname.split('/').filter(Boolean);
    if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== u.origin) return json({ error: 'Same-origin requests only' }, 403);
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
  const port = Number(process.env.LINCHPIN_WEB_PORT ?? 8875);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('LINCHPIN_WEB_PORT must be an integer from 1024 to 65535');
  const handler = api(service);
  const server = Bun.serve({ hostname: '127.0.0.1', port, routes: { '/': index }, fetch: handler, development: false });
  console.log(`Linchpin research workspace: ${server.url} · captured examples ready · live refresh available`);
}
