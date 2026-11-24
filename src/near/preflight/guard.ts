import type { Policy } from '../../policy/index';
import { preflight, type PreflightContext, type PreflightResult } from './preflight';
export async function guard<T>(action: unknown, policy: Policy, ctx: PreflightContext, execute: (result: PreflightResult) => T | Promise<T>): Promise<{ result: PreflightResult; executed: boolean; value: T | null }> {
  const result = preflight(action, policy, ctx);
  if (result.gate !== 'open') return { result, executed: false, value: null };
  const value = await execute(structuredClone(result));
  return { result, executed: true, value };
}
