import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../../chain/evidence';
import { loadNearSnapshots } from '../reader/load';
import { CURRENT_NEAR_SNAPSHOT } from '../subjects/registry';
import { loadNearLibraries, loadNearPolicy, referencedSnapshots } from '../policy/index';
import { loadNearBook } from '../private/book';
import { buildNearReview } from '../private/review';
import { joinPositions } from '../private/join';
import { renderNearReport } from '../private/render';
import { writeLocalReport } from '../private/report';
import { option, policyArgument } from './policy';
export async function run(args: string[]): Promise<number> {
  try {
    const libs = await loadNearLibraries(), policy = await loadNearPolicy(policyArgument(args), libs), snapshotId = option(args, '--snapshot', CURRENT_NEAR_SNAPSHOT)!, before = option(args, '--before');
    const format = option(args, '--format', 'md'); if (format !== 'md' && format !== 'html') throw new Error();
    const store = loadNearSnapshots([...new Set([snapshotId, ...referencedSnapshots(policy), ...(before ? [before] : [])])]);
    const review = buildNearReview(policy, store, snapshotId, libs, { before });
    const book = await loadNearBook({ path: option(args, '--positions') });
    const report = { review, positions: joinPositions(review, book.positions) };
    const path = option(args, '--out', join(homedir(), '.linchpin', 'reports', `near-review-${policy.policyId}-${snapshotId}.${format}`))!;
    writeLocalReport(path, renderNearReport(report, format));
    const jsonPath = option(args, '--json-out'); if (jsonPath) writeLocalReport(jsonPath, canonical(review) + '\n');
    console.log(`report ${path}`); console.log(`verdict ${review.verdict.outcome}`); return 0;
  } catch { console.error('review-failed'); return 1; }
}
