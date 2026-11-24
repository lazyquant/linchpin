import { jsonRecord } from '../../policy/index';
import { nearChain } from '../private/chains';
import { readRoute, readLibraryReview, missingLibrary } from '../policy/index';
import type { PreflightAction } from './action';
import type { PreflightContext, PreflightReason } from './preflight';
export function touchedSubjects(action: PreflightAction, ctx: PreflightContext) {
  const touched = new Set<string>(), unknowns: PreflightReason[] = [];
  if (action.kind === 'contract-call') {
    touched.add(action.receiver);
    const chain = nearChain(ctx.store, ctx.snapshotId, action.receiver);
    chain.facts.forEach(f => touched.add(f.subject)); unknowns.push(...chain.reasons);
    if (!ctx.store.snapshot(ctx.snapshotId)!.subjects.includes(action.receiver)) unknowns.push({ code: 'missing-subject', subject: action.receiver, ref: ctx.snapshotId });
  } else {
    touched.add('near:mainnet:intents.near');
    for (const asset of new Set([action.originAsset, action.destinationAsset])) {
      const route = readRoute(ctx.libs, asset, ctx.snapshotId);
      if (!route?.family || route.family === 'undocumented') unknowns.push({ code: 'missing-coverage', subject: null, ref: asset });
      const review = readLibraryReview(ctx.libs, 'intents', ctx.snapshotId, asset);
      if (jsonRecord(review) && Array.isArray(review.chain) && Array.isArray(review.unknowns)) {
        for (const hop of review.chain) if (jsonRecord(hop) && typeof hop.subject === 'string') touched.add(hop.subject);
        unknowns.push(...review.unknowns as PreflightReason[]);
      } else unknowns.push(...(jsonRecord(review) && Array.isArray(review.reasons) ? review.reasons as PreflightReason[] : missingLibrary('near-intent-review').reasons));
    }
  }
  return { touched: [...touched].sort(), unknowns };
}
