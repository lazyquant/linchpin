import type { View } from './model';

export function liveActivityIntro(view: View | null, running: boolean): string | null {
  if (running || view?.freshness.source !== 'live') return null;
  const f = view.freshness;
  const range = (view.baselineRange ?? []).map(date => date.slice(0, 10)).join(' — ') || 'date unavailable';
  return `Live result open · read ${f.retrievedAt.at(-1) ?? 'time unavailable'} via ${f.rpcHost ?? 'host unavailable'} · ${f.liveReads} live reads. Captured baseline ${range}. Run research replays recorded evidence; Refresh from chain reads current state again.`;
}
