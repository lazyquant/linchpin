import { jsonRecord } from '../../policy/registry';
export class RpcError extends Error { constructor(readonly code: number) { super('rpc-error'); } }
export interface RpcRequest { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }
export function parseRpc(text: string): RpcRequest {
  let v: unknown; try { v = JSON.parse(text); } catch { throw new RpcError(-32700); }
  if (!jsonRecord(v) || v.jsonrpc !== '2.0' || typeof v.method !== 'string' || !v.method.length || Object.keys(v).some(k => !['jsonrpc', 'id', 'method', 'params'].includes(k))
    || 'id' in v && v.id !== null && typeof v.id !== 'string' && !(typeof v.id === 'number' && Number.isFinite(v.id)) || 'params' in v && !jsonRecord(v.params)) throw new RpcError(-32600);
  return v as unknown as RpcRequest;
}
export const rpcError = (id: unknown, code: number) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: code === -32700 ? 'Parse error' : code === -32600 ? 'Invalid Request' : code === -32601 ? 'Method not found' : code === -32602 ? 'Invalid params' : 'Internal error' } });
