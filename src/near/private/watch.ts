import { canonical } from '../../chain/evidence';
import type { PrivatePosition, QueryReason } from '../../engine/contracts';
import { runQuery } from '../../engine/queries/run';
import type { EvidenceStore } from '../../engine/queries/snapshot';
import type { Outcome, Policy, RuleSpec } from '../../policy/types';
import { evaluateNearPolicy, readProposals, type NearLibraries } from '../policy/index';
import { positionRoot } from './book';
import { nearChain, ordered, reviewRoots, unique } from './chains';
export type WatchEvent =
  | { kind: 'dependency-changed'; cause: 'facts' | 'proposal' | 'verdict'; subject: string; constructed: boolean;
      changes: { kind: 'added' | 'removed' | 'changed'; key: string; beforeFactId: string | null; afterFactId: string | null }[];
      proposals: string[]; flippedRules: { ruleId: string; kind: string; before: Outcome; after: Outcome }[]; receiptIds: string[] }
  | { kind: 'position-changed'; root: string; change: 'added' | 'removed' | 'changed' };
export function ruleSubjects(rule: RuleSpec): string[] {
  const p = rule.params;
  if (rule.kind.startsWith('role-grantee-count-')) return [`${p.contract}#role:${p.role}`];
  if (rule.kind === 'unchanged-since') return ordered((p.factKeys as string[]).map(k => k.split('|')[0]!));
  if (Array.isArray(p.accounts)) return p.accounts as string[];
  return [String(p.contract ?? p.dao ?? p.account ?? p.subject ?? 'near:mainnet:intents.near')];
}
export function watchPolicy(i: { policy: Policy; store: EvidenceStore; before: string; after: string; libs: NearLibraries; positionsBefore?: PrivatePosition[]; positions?: PrivatePosition[]; query?: typeof runQuery }): { events: WatchEvent[]; unknowns: QueryReason[] } {
  const { policy, store, before, after, libs } = i, query = i.query ?? runQuery;
  const a = store.snapshot(before), b = store.snapshot(after); if (!a || !b) throw new Error('missing-snapshot');
  const roots = reviewRoots(policy), chains = roots.map(root => nearChain(store, after, root, query));
  const closure = ordered([...policy.subjects, ...[...a.subjects, ...b.subjects].filter(s => policy.subjects.some(root => s.startsWith(`${root}#role:`))), ...chains.flatMap(c => [c.root, ...c.facts.flatMap(f => [f.subject, f.object]).filter(s => a.subjects.includes(s) || b.subjects.includes(s))])]);
  const events: WatchEvent[] = [], unknowns: QueryReason[] = [];
  const event = (subject: string, cause: 'facts' | 'proposal' | 'verdict'): Extract<WatchEvent, { kind: 'dependency-changed' }> => ({ kind: 'dependency-changed', subject, cause, constructed: a.constructed || b.constructed, changes: [], proposals: [], flippedRules: [], receiptIds: [] });
  for (const subject of closure) {
    const r = query(store, { name: 'changes', subject, beforeSnapshotId: before, afterSnapshotId: after, maxResults: 500 }); unknowns.push(...r.reasons);
    if (r.changes.length) events.push({ ...event(subject, 'facts'), changes: r.changes.map(c => ({ kind: c.kind, key: c.key, beforeFactId: c.before?.id ?? null, afterFactId: c.after?.id ?? null })).sort((a, b) => a.key.localeCompare(b.key)), receiptIds: ordered(r.receipts.map(r => r.id)) });
  }
  const av = evaluateNearPolicy(policy, store, before, libs), bv = evaluateNearPolicy(policy, store, after, libs);
  for (const rule of policy.rules) {
    const previous = av.rules.find(r => r.ruleId === rule.id)!, next = bv.rules.find(r => r.ruleId === rule.id)!;
    if (previous.outcome === next.outcome) continue;
    const subjects = ruleSubjects(rule), flip = { ruleId: rule.id, kind: rule.kind, before: previous.outcome, after: next.outcome };
    let matching = events.filter((e): e is Extract<WatchEvent, { kind: 'dependency-changed' }> => e.kind === 'dependency-changed' && e.cause === 'facts' && subjects.some(s => e.subject === s || e.subject.startsWith(`${s}#`)));
    if (!matching.length) { const e = event(subjects[0]!, 'verdict'); events.push(e); matching = [e]; }
    for (const e of matching) { e.flippedRules.push(flip); e.receiptIds = ordered([...e.receiptIds, ...previous.receiptIds, ...next.receiptIds]); }
  }
  for (const root of roots) {
    const previous = readProposals(libs, 'proposalsTouching', before, root), next = readProposals(libs, 'proposalsTouching', after, root);
    if (previous.coverageGap || next.coverageGap) { unknowns.push({ code: 'missing-coverage', subject: root, ref: 'library:near-governance-review' }); continue; }
    const old = new Set(previous.proposals.filter(p => p.state === 'open').map(p => p.proposalSubject));
    const added = next.proposals.filter(p => p.state === 'open' && !old.has(p.proposalSubject));
    if (added.length) events.push({ ...event(root, 'proposal'), proposals: ordered(added.map(p => p.proposalSubject)), receiptIds: ordered(added.flatMap(p => p.factIds.flatMap(id => b.facts.filter(f => f.id === id).flatMap(f => f.evidenceIds)))) });
  }
  const old = new Map((i.positionsBefore ?? i.positions ?? []).map(p => [p.id, p])), current = new Map((i.positions ?? i.positionsBefore ?? []).map(p => [p.id, p]));
  for (const id of ordered([...old.keys(), ...current.keys()])) {
    const p = old.get(id), n = current.get(id);
    const change = !p ? 'added' : !n ? 'removed' : canonical([p.subject, p.unit, p.quantity]) !== canonical([n.subject, n.unit, n.quantity]) ? 'changed' : null;
    if (change) { const root = positionRoot((n ?? p)!); events.push({ kind: 'position-changed', root, change }); }
  }
  events.sort((a, b) => canonical([a.kind, a.kind === 'dependency-changed' ? a.subject : a.root, a.kind === 'dependency-changed' ? a.cause : a.change]).localeCompare(canonical([b.kind, b.kind === 'dependency-changed' ? b.subject : b.root, b.kind === 'dependency-changed' ? b.cause : b.change])));
  return { events, unknowns: unique(unknowns) };
}
export function renderWatch(events: WatchEvent[]): string {
  return events.map(e => e.kind === 'position-changed' ? `- position-changed ${e.change} ${e.root}` : `- dependency-changed ${e.subject} (${e.cause}${e.constructed ? ', constructed' : ''})\n${e.changes.map(c => `  ${c.kind} \`${c.key}\``).join('\n')}\n${e.flippedRules.map(r => `  ${r.ruleId}: ${r.before} → ${r.after}`).join('\n')}`).join('\n');
}
