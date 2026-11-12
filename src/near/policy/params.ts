import { PolicyRejected } from '../../policy/registry';
import { isTime } from '../../engine/queries/request';
import { parseNearSubject } from '../reader/types';
export function bad(): never { throw new PolicyRejected('bad-params'); }
export function nearRootSubject(value: unknown): string {
  if (typeof value !== 'string' || parseNearSubject(value)?.kind !== null) return bad();
  return value;
}
export function roleName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) return bad(); return value;
}
export function isoTime(value: unknown): string { if (!isTime(value)) return bad(); return value; }
export function smallInt(value: unknown, min = 1, max = 1000): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return bad(); return value as number;
}
export function strings(value: unknown, max: number, parse: (v: unknown) => string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) return bad();
  const values = value.map(parse); if (new Set(values).size !== values.length) return bad(); return values;
}
export const FAMILIES = ['poa_bridge', 'hot_bridge', 'omni_bridge', 'near_withdrawal', 'undocumented'];
export const CLASSES = ['control', 'code', 'funds', 'parameter', 'text', 'other'];
export function enumeration(value: unknown, choices: string[]): string { if (typeof value !== 'string' || !choices.includes(value)) return bad(); return value; }
export function assetId(value: unknown): string {
  if (typeof value !== 'string' || !/^(nep141:|nep245:|1cs_v1:)\S+$/.test(value) || value.length > 256) return bad(); return value;
}
