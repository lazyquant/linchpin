import { jsonRecord } from '../../policy/index';
import { parseAssetId } from '../intents/rules';
import { parseNearSubject } from '../reader/types';
export class PreflightRejected extends Error {
  constructor(readonly code: 'invalid-action') { super(code); this.name = 'PreflightRejected'; }
}
export type PreflightAction = { kind: 'intents-swap'; originAsset: string; destinationAsset: string } | { kind: 'contract-call'; receiver: string; method?: string };
export function parseAction(input: unknown): PreflightAction {
  const reject = (): never => { throw new PreflightRejected('invalid-action'); };
  if (!jsonRecord(input)) return reject();
  if (input.kind === 'intents-swap') {
    if (Object.keys(input).some(k => !['kind', 'originAsset', 'destinationAsset'].includes(k))) return reject();
    const { originAsset, destinationAsset } = input;
    if (typeof originAsset !== 'string' || typeof destinationAsset !== 'string' || [originAsset, destinationAsset].some(a => a.length > 256 || !parseAssetId(a))) return reject();
    return { kind: 'intents-swap', originAsset, destinationAsset };
  }
  if (input.kind === 'contract-call') {
    if (Object.keys(input).some(k => !['kind', 'receiver', 'method'].includes(k)) || typeof input.receiver !== 'string') return reject();
    const receiver = input.receiver.startsWith('near:') ? input.receiver : `near:mainnet:${input.receiver}`;
    const parsed = parseNearSubject(receiver);
    if (!parsed || parsed.kind !== null) return reject();
    if (Object.hasOwn(input, 'method')) {
      if (typeof input.method !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.method)) return reject();
      return { kind: 'contract-call', receiver, method: input.method };
    }
    return { kind: 'contract-call', receiver };
  }
  return reject();
}
