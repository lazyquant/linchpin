import { canonical } from '../../chain/evidence';
import { loadNearSnapshots } from '../reader/load';
import { captureSnapshot } from '../reader/capture';
import { loadNearLibraries, loadNearPolicy, referencedSnapshots } from '../policy/index';
import { loadNearBook } from '../private/book';
import { renderWatch, watchPolicy } from '../private/watch';
import { option, policyArgument } from './policy';
export async function run(args: string[]): Promise<number> {
  try {
    const before = option(args, '--before'), afterFlag = option(args, '--after'), record = option(args, '--record');
    if (!before || Boolean(afterFlag) === Boolean(record) || record && args.includes('--offline')) throw new Error();
    const after = afterFlag ?? record!; if (record) await captureSnapshot({ snapshotId: record });
    const libs = await loadNearLibraries(), policy = await loadNearPolicy(policyArgument(args), libs);
    const store = loadNearSnapshots([...new Set([before, after, ...referencedSnapshots(policy)])]);
    const positions = (await loadNearBook({ path: option(args, '--positions') })).positions;
    const old = option(args, '--positions-before'); const positionsBefore = old ? (await loadNearBook({ path: old })).positions : positions;
    const { events } = watchPolicy({ policy, store, before, after, libs, positions, positionsBefore });
    if (events.length) { if (args.includes('--json')) for (const e of events) console.log(canonical(e)); else console.log(renderWatch(events)); }
    return 0;
  } catch { console.error('watch-failed'); return 1; }
}
