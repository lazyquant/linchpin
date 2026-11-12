import { jsonRecord, projectVerdict } from '../../policy/index';
import { runQuery } from '../../engine/queries/run';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import { controlSurface } from '../reader/control';
import { parseNearSubject } from '../reader/types';
import { NEAR_REGISTRY } from '../subjects/registry';
import { assetId as parseAsset, evaluateNearPolicy, loadNearPolicy, NEAR_TRAVERSAL_RELATIONS, readLibraryReview, readProposals, missingLibrary, type NearLibraries } from '../policy/index';
import { RpcError } from './jsonrpc';
export const SERVER_CAPS = { maxResults: 200, maxHops: 4, timeoutMs: 5000, maxBodyBytes: 65536 } as const;
type Schema = { type: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; enum?: readonly string[]; minimum?: number; maximum?: number; maxLength?: number; pattern?: string; items?: Schema; minItems?: number; maxItems?: number; uniqueItems?: boolean };
const str: Schema = { type: 'string', maxLength: 256 }, subject: Schema = { ...str, pattern: '^(near:mainnet:)?[a-z0-9][a-z0-9._~-]*(#[a-z-]+:[A-Za-z0-9._~-]+)?$' };
const maxResults: Schema = { type: 'integer', minimum: 1, maximum: 100000 };
const definition = (name: string, description: string, properties: Record<string, Schema>, required: string[] = []) => ({ name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } as Schema, annotations: { readOnlyHint: true } });
export const TOOLS = [
  definition('linchpin_subjects', 'List public NEAR subjects and snapshot coverage.', { chain: { type: 'string', enum: ['rhea', 'intents', 'governance', 'mpc'] }, maxResults }),
  definition('linchpin_dependencies', 'Read bounded dependency facts and receipts.', { subject, relations: { type: 'array', items: { type: 'string', enum: NEAR_TRAVERSAL_RELATIONS }, minItems: 1, maxItems: 8, uniqueItems: true }, maxHops: { type: 'integer', minimum: 1, maximum: 64 }, maxResults }, ['subject']),
  definition('linchpin_control', 'Read control facts, roles and receipts for a public subject.', { subject, maxResults }, ['subject']),
  definition('linchpin_changes', 'Compare recorded dependency facts between snapshots.', { subject, before: str, after: str, maxResults }, ['subject']),
  definition('linchpin_evidence', 'Read public evidence receipts by identifier.', { evidenceIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 128 } }, maxResults }, ['evidenceIds']),
  definition('linchpin_intent_review', 'Read asset route coverage and receipted observations.', { assetId: { ...str, pattern: '^(nep141:|nep245:|1cs_v1:)\\S+$' } }, ['assetId']),
  definition('linchpin_governance_review', 'Read proposal effects and explicit coverage gaps.', { dao: subject, proposalId: { type: 'integer', minimum: 0, maximum: 1000000000 } }, ['dao']),
  definition('linchpin_policy_verdict', 'Evaluate a server policy over recorded public evidence.', { policyId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' } }, ['policyId']),
] as const;
function valid(v: unknown, s: Schema): boolean {
  if (s.type === 'object') return jsonRecord(v) && (s.required ?? []).every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => s.properties?.[k] !== undefined && valid(v[k], s.properties[k]!));
  if (s.type === 'string') return typeof v === 'string' && v.length > 0 && (!s.maxLength || v.length <= s.maxLength) && (!s.enum || s.enum.includes(v)) && (!s.pattern || new RegExp(s.pattern).test(v));
  if (s.type === 'integer') return Number.isSafeInteger(v) && Number(v) >= (s.minimum ?? -Infinity) && Number(v) <= (s.maximum ?? Infinity);
  if (s.type === 'array') return Array.isArray(v) && v.length >= (s.minItems ?? 0) && v.length <= (s.maxItems ?? Infinity) && (!s.uniqueItems || new Set(v).size === v.length) && v.every(x => valid(x, s.items!));
  return false;
}
export function validateArguments(name: string, input: unknown): Record<string, any> {
  const tool = TOOLS.find(t => t.name === name); if (!tool) throw new RpcError(-32601);
  if (!valid(input, tool.inputSchema)) throw new RpcError(-32602);
  const args = { ...(input as Record<string, any>) };
  for (const key of ['subject', 'dao']) if (key in args) {
    const s = String(args[key]).startsWith('near:') ? args[key] : `near:mainnet:${args[key]}`;
    const p = parseNearSubject(s); if (!p || p.kind === 'holder' || key === 'dao' && p.kind !== null) throw new RpcError(-32602); args[key] = s;
  }
  if ('assetId' in args) { try { parseAsset(args.assetId); } catch { throw new RpcError(-32602); } }
  return args;
}
export interface ToolContext { store: EvidenceStore; snapshotId: string; libs: NearLibraries; policiesDir?: URL; now?: () => number }
export async function callTool(name: string, input: unknown, o: ToolContext): Promise<{ value: Record<string, unknown>; isError: boolean }> {
  const args = validateArguments(name, input), clock = o.now ?? Date.now, started = clock();
  // The cap is checked between steps; it cannot interrupt synchronous work, so a cold first call can overrun it and return timeout. `near serve` warms the evaluation before it listens.
  const check = () => { if (clock() - started > SERVER_CAPS.timeoutMs) throw new Error('timeout'); };
  const clamped: string[] = [];
  for (const key of ['maxResults', 'maxHops'] as const) if (args[key] > SERVER_CAPS[key]) { args[key] = SERVER_CAPS[key]; clamped.push(key); }
  const max = args.maxResults ?? SERVER_CAPS.maxResults, hops = args.maxHops ?? SERVER_CAPS.maxHops;
  const snapshot = o.store.snapshot(o.snapshotId); if (!snapshot) return { value: { error: 'missing-snapshot' }, isError: true };
  const scope = { snapshotId: o.snapshotId, asOf: snapshot.observedTo, maxResults: max, maxHops: hops };
  const query = (request: Parameters<typeof runQuery>[1]) => { check(); const result = runQuery(o.store, request); check(); return result; };
  let value: unknown;
  try {
    check();
    switch (name) {
      case 'linchpin_subjects': {
        const entries = NEAR_REGISTRY.filter(e => !args.chain || e.chains.includes(args.chain));
        value = { subjects: entries.slice(0, max).map(({ account, subject, chains, yields }) => ({ account, subject, chains, yields, inSnapshot: snapshot.subjects.includes(subject) })), truncated: entries.length > max }; break;
      }
      case 'linchpin_dependencies': {
        const relations = args.relations ?? NEAR_TRAVERSAL_RELATIONS.filter(r => snapshot.facts.some(f => f.predicate === r));
        value = relations.length ? query({ name: 'dependencies', subject: args.subject, relations, scope }) : { outcome: 'unknown', reasons: [{ code: 'missing-coverage', subject: args.subject, ref: null }] }; break;
      }
      case 'linchpin_control': {
        check(); value = controlSurface(o.store, o.snapshotId, args.subject, snapshot.observedTo, max); check(); break;
      }
      case 'linchpin_changes': {
        const before = args.before ?? o.snapshotId, after = args.after ?? o.snapshotId;
        if (!o.store.snapshot(before) || !o.store.snapshot(after)) throw new RpcError(-32602);
        value = query({ name: 'changes', subject: args.subject, beforeSnapshotId: before, afterSnapshotId: after, maxResults: max }); break;
      }
      case 'linchpin_evidence': value = query({ name: 'evidence', evidenceIds: args.evidenceIds, maxResults: max }); break;
      case 'linchpin_intent_review': value = readLibraryReview(o.libs, 'intents', o.snapshotId, args.assetId); break;
      case 'linchpin_governance_review': value = !o.libs.governance ? missingLibrary('near-governance-review') : args.proposalId === undefined ? readProposals(o.libs, 'openProposals', o.snapshotId, args.dao) : readLibraryReview(o.libs, 'governance', o.snapshotId, args.dao, args.proposalId); break;
      case 'linchpin_policy_verdict': {
        let policy; try { policy = await loadNearPolicy(args.policyId, o.libs, o.policiesDir); } catch { return { value: { error: 'unknown-policy' }, isError: true }; }
        check(); value = { snapshotId: o.snapshotId, verdict: projectVerdict(evaluateNearPolicy(policy, o.store, o.snapshotId, o.libs), snapshot.subjects), libraries: o.libs.status }; break;
      }
    }
    check();
    if (!jsonRecord(value)) return { value: { error: 'invalid-result' }, isError: true };
    let truncated = false;
    function bound(v: unknown): unknown {
      if (Array.isArray(v)) { if (v.length > max) truncated = true; return v.slice(0, max).map(bound); }
      if (jsonRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bound(x)])); return v;
    }
    const bounded = bound(value) as Record<string, unknown>;
    if (truncated || clamped.length) bounded.truncated = true;
    if (clamped.length) bounded.clamped = clamped;
    return { value: bounded, isError: false };
  } catch (e) {
    if (e instanceof RpcError) throw e;
    return { value: { error: e instanceof Error && e.message === 'timeout' ? 'timeout' : 'tool-failed' }, isError: true };
  }
}
