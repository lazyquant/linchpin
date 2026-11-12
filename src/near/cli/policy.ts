import { canonical } from '../../chain/evidence';
import { projectVerdict } from '../../policy/index';
import { loadNearSnapshots } from '../reader/load';
import { CURRENT_NEAR_SNAPSHOT } from '../subjects/registry';
import { evaluateNearPolicy, loadNearLibraries, loadNearPolicy, referencedSnapshots } from '../policy/index';
export function option(args: string[], name: string, fallback?: string): string | undefined {
  const at = args.indexOf(name); if (at < 0) return fallback;
  const v = args[at + 1]; if (!v || v.startsWith('--')) throw new Error('missing-option-value'); return v;
}
export function policyArgument(args: string[]): string { if (!args[0] || args[0].startsWith('--')) throw new Error('policy-required'); return args[0]; }
export async function run(args: string[]): Promise<number> {
  try {
    const libs = await loadNearLibraries(), policy = await loadNearPolicy(policyArgument(args), libs), snapshotId = option(args, '--snapshot', CURRENT_NEAR_SNAPSHOT)!;
    const store = loadNearSnapshots([...new Set([snapshotId, ...referencedSnapshots(policy)])]);
    const verdict = projectVerdict(evaluateNearPolicy(policy, store, snapshotId, libs), store.snapshot(snapshotId)!.subjects);
    if (args.includes('--json')) console.log(canonical(verdict));
    else { console.log(`verdict ${verdict.outcome}`); for (const r of verdict.rules) console.log(canonical(r)); }
    return 0;
  } catch { console.error('policy-failed'); return 1; }
}
