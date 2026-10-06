import type { Evidence } from '../chain/evidence';
import type { StateFact } from '../chain/state';
import type { Result } from './model';

export type StateDiff = { id: string; label: string; captured: string; capturedSlot: number | null; capturedAt: string | null; current: string; currentSlot: number | null; currentAt: string | null; changed: boolean; evidenceIds: { captured: string[]; current: string[] }; raw: { captured: string | null; current: string | null } };
const latest = (evidence: Evidence[]) => evidence.map(e => e.retrievedAt).sort().at(-1) ?? null;
const factTime = (fact: StateFact, evidence: Evidence[]) => {
  const reads = evidence.filter(e => fact.evidenceIds.includes(e.id));
  const atSlot = reads.filter(e => e.slot === fact.slot);
  return latest(atSlot.length ? atSlot : reads);
};

export function stateFacts({ packet, evidence }: Pick<Result, 'packet' | 'evidence'>): StateFact[] {
  const facts = [...(packet.stateFacts ?? [])];
  const fact = (id: string, label: string, value: string, evidenceIds: string[], slot?: number | null) => {
    const reads = evidence.filter(e => evidenceIds.includes(e.id));
    facts.push({ id, label, value, raw: value, slot: slot ?? reads.at(-1)?.slot ?? null, evidenceIds });
  };
  if ('pack' in packet) {
    for (const p of packet.controllerPaths) fact(`authority:${p.subject}:${p.authorityType}`, `${p.role} · ${p.authorityType} authority`, p.authority ?? (p.status === 'unresolved' ? 'Unresolved' : 'None'), p.evidenceIds, p.slot);
  } else {
    fact('proposal-state', 'Proposal state', packet.proposal.stateName, [packet.proposal.evidenceId]);
    for (const s of packet.simulated) {
      const detail = s.error == null ? s.logs[0] : typeof s.error === 'string' ? s.error : JSON.stringify(s.error);
      fact(`simulation:${s.kind}:${s.txIndex ?? 0}:${s.ixIndex ?? 'all'}`, `${s.kind} · transaction ${(s.txIndex ?? 0) + 1}${s.ixIndex == null ? '' : ` · instruction ${s.ixIndex + 1}`}`, `${s.success ? 'Succeeded' : 'Failed'}${detail ? ` · ${detail}` : ''}`, s.evidenceIds, s.contextSlot);
    }
    const slot = Math.max(...evidence.flatMap(e => e.slot == null ? [] : [e.slot]));
    if (Number.isFinite(slot)) fact('latest-slot', 'Latest slot', String(slot), evidence.filter(e => e.slot === slot).map(e => e.id), slot);
  }
  return facts;
}

export function compareState(captured: Pick<Result, 'packet' | 'evidence'>, current: Pick<Result, 'packet' | 'evidence'>): { stateDiff: StateDiff[]; changedCount: number } {
  const before = new Map(stateFacts(captured).map(f => [f.id, f]));
  const after = new Map(stateFacts(current).map(f => [f.id, f]));
  const missing = (id: string, evidence: Evidence[]): StateFact => {
    const address = /^(balance|supply):(.+)$/.exec(id)?.[2];
    const read = address ? evidence.filter(e => e.method === 'getAccountInfo' && (e.params as { pubkey?: string })?.pubkey === address).at(-1) : undefined;
    return { id, label: id, value: id.startsWith('simulation:') ? 'Not simulated' : 'Unavailable', raw: null, slot: read?.slot ?? null, evidenceIds: read ? [read.id] : [] };
  };
  const stateDiff = [...new Set([...before.keys(), ...after.keys()])].map(id => {
    const a = before.get(id) ?? missing(id, captured.evidence), b = after.get(id) ?? missing(id, current.evidence);
    return { id, label: before.get(id)?.label ?? b.label, captured: a.value, capturedSlot: a.slot, capturedAt: factTime(a, captured.evidence),
      current: b.value, currentSlot: b.slot, currentAt: factTime(b, current.evidence), changed: a.raw !== b.raw || a.value !== b.value,
      evidenceIds: { captured: [...new Set(a.evidenceIds)], current: [...new Set(b.evidenceIds)] }, raw: { captured: a.raw, current: b.raw } };
  });
  return { stateDiff, changedCount: stateDiff.filter(r => r.changed).length };
}
