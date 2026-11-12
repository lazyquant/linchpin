import type { PrivatePosition } from '../../engine/contracts';
import type { NearReview } from './review';
import { positionRoot } from './book';
export function joinPositions(review: NearReview, positions: readonly PrivatePosition[]) {
  return positions.map(position => {
    const root = positionRoot(position), chain = review.chains.find(c => c.root === root) ?? null;
    const covered = chain !== null && review.snapshot.subjects.includes(root);
    return { position, root, coverage: covered ? 'covered' as const : 'uncovered' as const, reason: covered ? null : 'missing-subject' as const, chain: covered ? chain : null,
      intent: root === 'near:mainnet:intents.near' ? review.intents.find(i => i.assetId === position.unit)?.review ?? { outcome: 'unknown', reasons: [{ code: 'missing-coverage', subject: root, ref: null }] } : null };
  });
}
export type JoinedNearPosition = ReturnType<typeof joinPositions>[number];
