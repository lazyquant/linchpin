import type { Fact } from '../../../engine/contracts';
import type { EvidenceStore } from '../../../engine/queries/snapshot';
import { evaluation, factUsableAt, reason, type PolicyContext, type PolicyEvidence, type RuleEvaluation, type RuleKind } from '../../../policy/index';
import { parameters } from '../../../policy/registry';
import { historyFacts } from '../../reader/history';
import { parseNearSubject } from '../../reader/types';
import { assetId, bad, CLASSES, enumeration, FAMILIES, isoTime, nearRootSubject, roleName, smallInt, strings } from '../params';
import { readProposals, readRoute, type NearLibraries } from '../libraries';
type Params = Record<string, any>;
function guard(store: PolicyEvidence, ctx: PolicyContext, subjects: string[], facts: Fact[]): RuleEvaluation | null {
  const snap = store.snapshot(ctx.snapshotId);
  if (!snap) return evaluation('undetermined', [reason('missing-snapshot', null, ctx.snapshotId)], facts);
  const missing = subjects.find(s => !snap.subjects.includes(s));
  if (missing) return evaluation('undetermined', [reason('missing-fact', missing)], facts);
  if (facts.some(f => !factUsableAt(f, store, ctx.evaluatedAt))) return evaluation('undetermined', [reason('observed-after-evaluation')], facts);
  const unknown = facts.find(f => f.object === 'unknown' || f.basis === 'unknown' || f.status !== 'verified');
  if (unknown) return evaluation('undetermined', [reason(ctx.roleOf(unknown.predicate) === 'control' ? 'unknown-controller' : 'missing-coverage', unknown.subject)], facts);
  return null;
}
const result = (ok: boolean, code: string, subject: string, facts: Fact[], ref: string | null = null) => evaluation(ok ? 'within-policy' : 'outside-policy', ok ? [] : [reason(code, subject, ref)], facts);
const missing = (subject: string, facts: Fact[] = [], code = 'missing-fact') => evaluation('undetermined', [reason(code, subject)], facts);
export function nearKinds(libs: NearLibraries): RuleKind[] {
  const kinds = ['no-full-access-keys', 'min-threshold', 'max-council-change-days', 'pause-operator-set', 'pause-state-is', 'role-grantee-count-max', 'role-grantee-count-min', 'oracle-enabled-is', 'no-upgrade-since', 'mpc-threshold-min', 'route-family-in', 'no-open-proposal-of-class', 'no-open-proposal-touching'];
  return kinds.map(kind => ({ kind, parse(input): Params {
    const fields: Record<string, string[]> = {
      'no-full-access-keys': ['accounts'], 'min-threshold': ['dao', 'num', 'denom'], 'max-council-change-days': ['dao', 'days'],
      'pause-operator-set': ['contract'], 'pause-state-is': ['contract', 'paused'], 'role-grantee-count-max': ['contract', 'role', 'n'],
      'role-grantee-count-min': ['contract', 'role', 'n'], 'oracle-enabled-is': ['contract', 'account'], 'no-upgrade-since': ['contract', 'isoDate'],
      'mpc-threshold-min': ['contract', 'n'], 'route-family-in': ['assetId', 'families'], 'no-open-proposal-of-class': ['dao', 'classes'], 'no-open-proposal-touching': ['subject'],
    };
    const p = { ...parameters(input, fields[kind]!) };
    for (const key of ['dao', 'contract', 'account', 'subject']) if (key in p) p[key] = nearRootSubject(p[key]);
    if ('accounts' in p) p.accounts = strings(p.accounts, 32, nearRootSubject);
    if ('num' in p) { p.num = smallInt(p.num, 1, 100); p.denom = smallInt(p.denom, 1, 100); if (Number(p.num) > Number(p.denom)) bad(); }
    if ('days' in p) p.days = smallInt(p.days, 1, 3650);
    if ('role' in p) p.role = roleName(p.role);
    if ('n' in p) p.n = smallInt(p.n, kind.endsWith('-max') ? 0 : 1);
    if ('paused' in p && typeof p.paused !== 'boolean') bad();
    if ('isoDate' in p) p.isoDate = isoTime(p.isoDate);
    if ('assetId' in p) p.assetId = assetId(p.assetId);
    if ('families' in p) p.families = strings(p.families, 5, v => enumeration(v, FAMILIES));
    if ('classes' in p) p.classes = strings(p.classes, 6, v => enumeration(v, CLASSES));
    return p;
  }, evaluate(p: Params, store, ctx) {
    const root: string = p.contract ?? p.dao ?? p.subject ?? p.accounts?.[0] ?? 'near:mainnet:intents.near';
    const snap = store.snapshot(ctx.snapshotId);
    if (!snap) return evaluation('undetermined', [reason('missing-snapshot', null, ctx.snapshotId)]);
    const get = (s: string, predicates: string[]) => store.factsFrom(ctx.snapshotId, s).filter(f => predicates.includes(f.predicate));
    if (kind === 'route-family-in') {
      const v = readRoute(libs, p.assetId, ctx.snapshotId);
      if (!v || v.family === null || v.reason !== null) return evaluation('undetermined', [reason('missing-coverage', null, v?.reason ?? 'library:near-intent-review')]);
      const r = result(p.families.includes(v.family), 'route-family-outside', root, [], v.family); r.factIds = v.factIds; r.receiptIds = v.receiptIds; return r;
    }
    if (kind.startsWith('no-open-proposal-')) {
      const g = guard(store, ctx, [root], []); if (g) return g;
      const v = readProposals(libs, kind.endsWith('-class') ? 'openProposals' : 'proposalsTouching', ctx.snapshotId, root);
      const facts = v.proposals.flatMap(p => p.factIds.flatMap(id => snap.subjects.flatMap(s => store.factsFrom(ctx.snapshotId, s).filter(f => f.id === id))));
      const checked = guard(store, ctx, [root], facts); if (checked) return checked;
      if (v.coverageGap) return evaluation('undetermined', [reason('missing-coverage', root, 'library:near-governance-review')], facts);
      const open = v.proposals.filter(v => v.state === 'open' && (!p.classes || p.classes.includes(v.effectClass)));
      const r = evaluation(open.length ? 'outside-policy' : 'within-policy', open.map(v => reason('open-proposal', root, v.proposalSubject)), facts);
      r.factIds = [...new Set([...r.factIds, ...v.proposals.flatMap(v => v.factIds)])]; return r;
    }
    if (kind === 'no-full-access-keys') {
      const facts = p.accounts.flatMap((s: string) => get(s, ['has-full-access-key'])) as Fact[];
      const g = guard(store, ctx, p.accounts, facts); if (g) return g;
      const absent = p.accounts.find((s: string) => !facts.some(f => f.subject === s)); if (absent) return missing(absent, facts);
      const key = facts.find(f => f.object !== 'none'); return result(!key, 'full-access-key', key?.subject ?? root, facts, key?.object ?? null);
    }
    if (kind.startsWith('role-grantee-count-')) {
      const subject = `${root}#role:${p.role}`, facts = get(subject, ['holds-role']);
      const g = guard(store, ctx, [root, subject], facts); if (g) return g;
      if (!facts.length) return missing(subject);
      const count = new Set(facts.filter(f => f.object !== 'none').map(f => f.object)).size;
      const max = kind.endsWith('-max'); const r = result(max ? count <= p.n : count >= p.n, max ? 'grantees-above-max' : 'grantees-below-min', subject, facts);
      r.evidence = { count, limit: p.n }; return r;
    }
    if (kind === 'min-threshold') {
      const subjects = snap.subjects.filter(s => s === root || s.startsWith(`${root}#role:`));
      const thresholds = subjects.flatMap(s => get(s, ['vote-threshold']));
      const members = subjects.flatMap(s => get(s, ['holds-role'])); const facts = [...thresholds, ...members];
      const g = guard(store, ctx, [root], facts); if (g) return g;
      if (!thresholds.length) return missing(root);
      let unsupported = false; const below: Fact[] = [];
      for (const f of thresholds) {
        const [t, , weight] = f.object.split('|');
        const roleMembers = members.filter(m => m.subject === f.subject && m.object !== 'none');
        if (weight !== 'RoleWeight' || roleMembers.some(m => m.object === 'everyone' || m.object.startsWith('token-holder:'))) { unsupported = true; continue; }
        let a: bigint, b: bigint;
        if (/^\d+\/\d+$/.test(t!)) [a, b] = t!.split('/').map(BigInt) as [bigint, bigint];
        else if (/^\d+$/.test(t!) && f.subject !== root && roleMembers.length) { a = BigInt(t!); b = BigInt(new Set(roleMembers.map(m => m.object)).size); }
        else { unsupported = true; continue; }
        if (b === 0n) { unsupported = true; continue; }
        if (a * BigInt(p.denom) < b * BigInt(p.num)) below.push(f);
      }
      if (unsupported) return missing(root, facts, 'unsupported-weight');
      return result(!below.length, 'below-threshold', root, facts, below[0]?.object.split('|')[1] ?? null);
    }
    if (kind === 'no-upgrade-since' || kind === 'max-council-change-days') {
      if (!('snapshotsForReceipt' in store)) return missing(root, [], 'missing-history');
      const es = store as EvidenceStore, all = es.snapshot(ctx.snapshotId)!.facts;
      const h = historyFacts(es, root, ctx.snapshotId);
      const history = h.events.filter(e => kind === 'no-upgrade-since' ? ['code-upgrade', 'code-deployed', 'self-upgrade', 'remote-upgrade'].includes(e.kind) : ['membership', 'policy'].includes(e.kind) && e.source.subject.startsWith(`${root}#proposal:`));
      const records = kind === 'no-upgrade-since'
        ? all.filter(f => f.predicate === 'deployed-version' && parseNearSubject(f.subject)?.key === parseNearSubject(root)?.account)
        : all.filter(f => f.predicate === 'proposal' && f.subject.startsWith(`${root}#proposal:`));
      const facts = [...new Map([...records, ...history.map(e => e.source), ...get(root, ['proposal-period'])].map(f => [f.id, f])).values()];
      const g = guard(store, ctx, [root], facts); if (g) return g;
      if (!records.length) return missing(root, facts, 'missing-history');
      const end = Date.parse(ctx.evaluatedAt), cutoff = kind === 'no-upgrade-since' ? Date.parse(p.isoDate) : end - p.days * 86400000;
      const recent = history.filter(e => (kind === 'no-upgrade-since' ? Date.parse(e.at) > cutoff : Date.parse(e.at) >= cutoff) && Date.parse(e.at) <= end);
      if (recent.length) return evaluation('outside-policy', recent.map(e => reason(kind === 'no-upgrade-since' ? 'upgraded-since' : 'council-changed', root, e.source.subject)), facts);
      if (kind === 'max-council-change-days') {
        const period = get(root, ['proposal-period'])[0];
        if (!period || !/^\d+$/.test(period.object)) return missing(root, facts, 'missing-history');
        const duration = Number(BigInt(period.object) / 1000000n);
        if (history.some(e => Date.parse(e.at) < cutoff && Date.parse(e.at) + duration >= cutoff)) return missing(root, facts, 'approval-time-unknown');
        const coverage = h.coverage.find(c => c.dao === root);
        const times = records.map(f => { try { return Date.parse(JSON.parse(f.object).submittedAt); } catch { return NaN; } });
        if (times.some(t => !Number.isFinite(t)) || !coverage || coverage.fromId > 0 && Math.min(...times) > cutoff) return missing(root, facts, 'missing-coverage');
      }
      return evaluation('within-policy', [], facts);
    }
    const predicates = kind === 'pause-operator-set' ? ['pause-operator'] : kind === 'pause-state-is' ? ['paused', 'contract-mode'] : kind === 'oracle-enabled-is' ? ['priced-by', 'legacy-oracle'] : ['mpc-threshold'];
    const facts = get(root, predicates);
    if (kind === 'pause-operator-set') facts.push(...get(`${root}#role:PauseManager`, ['holds-role']));
    const g = guard(store, ctx, [root], facts); if (g) return g;
    if (!facts.length) return missing(root);
    if (kind === 'pause-operator-set') return result(facts.some(f => f.object !== 'none' && parseNearSubject(f.object) !== null), 'no-pause-operator', root, facts);
    if (kind === 'pause-state-is') {
      const paused = facts.some(f => f.object !== (f.predicate === 'paused' ? 'false' : 'Running'));
      return result(paused === p.paused, 'paused-state', root, facts, facts.find(f => f.object !== (f.predicate === 'paused' ? 'false' : 'Running'))?.object ?? 'false');
    }
    if (kind === 'oracle-enabled-is') return result(facts.some(f => f.predicate === 'priced-by' && f.object === p.account), 'oracle-not-enabled', root, facts);
    if (facts.some(f => !/^\d+$/.test(f.object))) return missing(root, facts, 'missing-coverage');
    return result(facts.every(f => BigInt(f.object) >= BigInt(p.n)), 'threshold-below-min', root, facts);
  } }));
}
