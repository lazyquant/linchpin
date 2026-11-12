import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrivatePosition } from '../../engine/contracts';
import { loadBook, parseBook, PositionRejected } from '../../review/position/book';
import { isNearAccountId, parseNearSubject } from '../reader/types';
export { PositionRejected } from '../../review/position/book';
export function parseNearBook(input: unknown): PrivatePosition[] {
  const positions = parseBook(input);
  positions.forEach((p, i) => {
    const s = parseNearSubject(p.subject);
    if (!s || s.kind !== null && s.kind !== 'holder') throw new PositionRejected('malformed-subject', i, 'subject');
    const parts = p.unit.split(':');
    if (!(p.unit === 'near' || parts[0] === 'nep141' && parts.length === 2 && isNearAccountId(parts[1]!)
      || parts[0] === 'nep245' && parts.length >= 3 && isNearAccountId(parts[1]!) && parts.slice(2).join(':').length > 0)) throw new PositionRejected('malformed-unit', i, 'unit');
  });
  return positions;
}
export function positionRoot(position: PrivatePosition): string {
  const s = parseNearSubject(position.subject);
  if (!s || s.kind !== null && s.kind !== 'holder') throw new PositionRejected('malformed-subject');
  return `near:mainnet:${s.account}`;
}
export function resolveBookPath(flag: string | undefined, env: Record<string, string | undefined>) {
  if (flag !== undefined) return { path: flag, source: 'flag' as const };
  if (env.LINCHPIN_NEAR_POSITIONS) return { path: env.LINCHPIN_NEAR_POSITIONS, source: 'env' as const };
  return { path: join(homedir(), '.linchpin', 'near-positions.json'), source: 'default' as const };
}
export async function loadNearBook(opts: { path?: string; env?: Record<string, string | undefined> } = {}): Promise<{ positions: PrivatePosition[]; source: 'flag' | 'env' | 'default' | 'none' }> {
  const selected = resolveBookPath(opts.path, opts.env ?? process.env);
  if (selected.source === 'default' && !await Bun.file(selected.path).exists()) return { positions: [], source: 'none' };
  return { positions: parseNearBook(await loadBook(selected.path)), source: selected.source };
}
