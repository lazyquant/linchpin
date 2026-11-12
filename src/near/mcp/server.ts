import { createHash, timingSafeEqual } from 'node:crypto';
import { canonical } from '../../chain/evidence';
import { jsonRecord } from '../../policy/registry';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import type { NearLibraries } from '../policy/libraries';
import { version } from '../../../package.json';
import { callTool, SERVER_CAPS, TOOLS } from './tools';
import { assertPublicResponse, projectPublic, publicEvidenceStore } from './privacy';
import { parseRpc, RpcError, rpcError } from './jsonrpc';
export { SERVER_CAPS, TOOLS };
export const MCP_PATH = '/mcp';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export interface McpOptions { token: string; snapshotId: string; store: EvidenceStore; libs: NearLibraries; policiesDir?: URL; accessLog?: (line: string) => void; now?: () => number; allowedOrigins?: string[] }
export class McpConfigError extends Error { constructor(readonly code: 'token-missing' | 'token-too-short') { super(code); } }
const hash = (text: string) => createHash('sha256').update(text).digest();
function validate(o: McpOptions) {
  if (!o.token) throw new McpConfigError('token-missing');
  if (o.token.length < 32) throw new McpConfigError('token-too-short');
}
export function createMcpHandler(o: McpOptions): (req: Request) => Promise<Response> {
  validate(o); o = { ...o, store: publicEvidenceStore(o.store) }; const credentialHash = hash(`Bearer ${o.token}`);
  return async req => {
    const now = o.now ?? Date.now, started = now(); let body = '', responseText = '', status = 500, rpcMethod: string | null = null, tool: string | null = null;
    const send = (code: number, text = '', headers: Record<string, string> = {}) => { status = code; responseText = text; return new Response(text || null, { status: code, headers }); };
    const json = (value: unknown) => { const projected = projectPublic(value); assertPublicResponse(projected); return send(200, canonical(projected), { 'Content-Type': 'application/json' }); };
    let id: string | number | null = null;
    try {
      if (!timingSafeEqual(hash(req.headers.get('authorization') ?? ''), credentialHash)) return send(401, '', { 'WWW-Authenticate': 'Bearer' });
      if (new URL(req.url).pathname !== MCP_PATH) return send(404);
      if (req.method !== 'POST') return send(405, '', { Allow: 'POST' });
      const origin = req.headers.get('origin'); if (origin && !(o.allowedOrigins ?? []).includes(origin)) return send(403);
      const protocol = req.headers.get('MCP-Protocol-Version'); if (protocol && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocol)) return send(400);
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return send(415);
      if (Number(req.headers.get('content-length')) > SERVER_CAPS.maxBodyBytes) return send(413);
      const reader = req.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      if (reader) for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length; if (bytes > SERVER_CAPS.maxBodyBytes) { await reader.cancel(); return send(413); } chunks.push(part.value);
      }
      body = Buffer.concat(chunks).toString('utf8');
      const rpc = parseRpc(body); id = rpc.id ?? null;
      rpcMethod = ['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized'].includes(rpc.method) ? rpc.method : 'unknown';
      if (!Object.hasOwn(rpc, 'id')) return send(202);
      let result: unknown;
      switch (rpc.method) {
        case 'initialize': {
          const requested = rpc.params?.protocolVersion;
          result = { protocolVersion: typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'linchpin-near', version }, instructions: 'Read-only public evidence. Cite fact and receipt ids. Repeat coverage gaps. Position data is unavailable.' }; break;
        }
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': {
          const p = rpc.params;
          if (!jsonRecord(p) || typeof p.name !== 'string' || Object.keys(p).some(k => !['name', 'arguments'].includes(k))) throw new RpcError(-32602);
          tool = TOOLS.some(t => t.name === p.name) ? p.name : 'unknown';
          const r = await callTool(p.name, p.arguments ?? {}, o), value = projectPublic(r.value); assertPublicResponse(value);
          result = { content: [{ type: 'text', text: canonical(value) }], structuredContent: value, isError: r.isError }; break;
        }
        default: throw new RpcError(-32601);
      }
      return json({ jsonrpc: '2.0', id, result });
    } catch (e) { return json(rpcError(id, e instanceof RpcError ? e.code : -32603)); }
    finally {
      const line = canonical({ at: new Date(started).toISOString(), status, rpcMethod, tool, requestSha256: hash(body).toString('hex'), responseSha256: hash(responseText).toString('hex'), ms: Math.max(0, now() - started) });
      try { (o.accessLog ?? (line => console.error(line)))(line); } catch { /* Logging never includes exception payloads. */ }
    }
  };
}
export function startMcpServer(o: McpOptions & { port: number }): { url: string; stop(): Promise<void> } {
  const server = Bun.serve({ hostname: '127.0.0.1', port: o.port, fetch: createMcpHandler(o), maxRequestBodySize: SERVER_CAPS.maxBodyBytes + 1 });
  return { url: `http://127.0.0.1:${server.port}${MCP_PATH}`, async stop() { await server.stop(true); } };
}
