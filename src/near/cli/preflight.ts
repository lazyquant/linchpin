import { canonical } from '../../chain/evidence';
import { generateFlowchartHtml } from '../../flowchart/index';
import { loadNearSnapshots } from '../reader/load';
import { CURRENT_NEAR_SNAPSHOT } from '../subjects/registry';
import { loadNearLibraries, loadNearPolicy, referencedSnapshots } from '../policy/index';
import { parseAction, preflight, toFlowchartInput } from '../preflight/index';
export async function run(args: string[]): Promise<number> {
  const options = new Map<string, string>();
  let action;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i]!;
      if (options.has(key)) throw new Error();
      if (['--json', '--offline'].includes(key)) options.set(key, 'true');
      else if (['--action', '--policy', '--snapshot', '--chart'].includes(key) && args[i + 1] && !args[i + 1]!.startsWith('--')) options.set(key, args[++i]!);
      else throw new Error();
    }
    if (!options.has('--action') || !options.has('--policy')) throw new Error();
  } catch { console.error('preflight-rejected usage'); return 2; }
  try { action = parseAction(JSON.parse(options.get('--action')!)); } catch { console.error('preflight-rejected invalid-action'); return 2; }
  const libs = await loadNearLibraries();
  let policy;
  try { policy = await loadNearPolicy(options.get('--policy')!, libs); } catch { console.error('preflight-rejected invalid-policy'); return 2; }
  try {
    const snapshotId = options.get('--snapshot') ?? CURRENT_NEAR_SNAPSHOT;
    const store = loadNearSnapshots([...new Set([snapshotId, ...referencedSnapshots(policy)])]);
    const result = preflight(action, policy, { store, snapshotId, libs });
    if (options.has('--chart')) await Bun.write(options.get('--chart')!, generateFlowchartHtml(toFlowchartInput(result), `Preflight ${policy.policyId}`));
    if (options.has('--json')) console.log(canonical(result));
    else {
      console.log(`gate: ${result.gate}\noutcome: ${result.outcome}\npolicy: ${result.policyId}\nsnapshot: ${result.snapshotId}`);
      for (const r of result.applicable) {
        console.log(`rule: ${r.ruleId} ${r.outcome} ${r.reasons.map(x => x.code).join(',') || 'none'}`);
        if (r.outcome === 'outside-policy') console.log(`outside the policy \`${result.policyId}\`: rule \`${r.ruleId}\``);
      }
      for (const r of result.unknowns) console.log(`unknown: ${r.code} ${r.subject ?? 'none'} ${r.ref ?? 'none'}`);
    }
    return result.gate === 'open' ? 0 : result.gate === 'human' ? 3 : 4;
  } catch { console.error('preflight-failed'); return 1; }
}
