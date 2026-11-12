import type { Fact } from '../../engine/contracts';
import { canonical } from '../../chain/evidence';
import type { NearReview } from './review';
import type { JoinedNearPosition } from './join';
export const NEAR_BANNED_WORDS = ['should', 'recommend', 'safe', 'unsafe', 'score', 'rating', 'buy', 'sell', 'exit'] as const;
export function findNearBannedWords(text: string): string[] {
  const unquoted = text.replace(/`[^`]*`/g, '').replace(/"(?:\\.|[^"\\])*"/g, '').replace(/<code>.*?<\/code>/gs, '');
  return NEAR_BANNED_WORDS.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(unquoted)).sort();
}
const cell = (v: unknown) => String(v ?? '').replace(/[\r\n]/g, ' ').replace(/\|/g, '&#124;').replace(/`/g, '&#96;');
const quote = (v: unknown) => '`' + cell(v) + '`';
export type NearReport = { review: NearReview; positions: JoinedNearPosition[] };
export function renderNearReport(report: NearReport | (NearReview & { positions?: JoinedNearPosition[] }), format: 'md' | 'html' = 'md'): string {
  const review = 'review' in report ? report.review : report;
  const positions = report.positions ?? [];
  const receipts = [...review.receipts].sort((a, b) => a.id.localeCompare(b.id));
  const refs = (f: Fact) => f.evidenceIds.map(id => { const n = receipts.findIndex(r => r.id === id); return n >= 0 ? `[^${n + 1}]` : '[receipt unavailable]'; }).join('');
  const factLine = (f: Fact) => `- ${quote(`${f.subject} ${f.predicate} ${f.object}`)} (${cell(f.basis)}, ${cell(f.status)}) ${refs(f)}`;
  const lines = [
    '# Private local report', '', `Policy: ${quote(review.policyId)}`, `Snapshot: ${quote(review.snapshot.snapshotId)}${review.snapshot.constructed ? ' · constructed' : ''}`,
    `Observed: ${review.snapshot.observedFrom} – ${review.snapshot.observedTo}`, `Blocks: ${review.snapshot.fromBlockOrSlot} – ${review.snapshot.toBlockOrSlot}`, '',
    '## Positions', '', '| id | root | unit | quantity | coverage | reason |', '|---|---|---|---|---|---|',
    ...positions.map(p => `| ${[p.position.id, p.root, p.position.unit, p.position.quantity, p.coverage, p.reason ?? ''].map(quote).join(' | ')} |`), '',
    '## Control per chain', '',
  ];
  for (const chain of review.chains) {
    lines.push(`### ${cell(chain.root)}`, '', '| subject | predicate | object | evidence |', '|---|---|---|---|');
    for (const f of chain.facts) lines.push(`| ${quote(f.subject)} | ${quote(f.predicate)} | ${quote(f.object)} | ${refs(f)} |`);
    lines.push('');
  }
  lines.push('## Open proposals', '');
  for (const g of review.governance) {
    lines.push(`### ${cell(g.root)}`);
    if (g.coverageGap) lines.push('Not available: `missing-coverage` (governance library absent or incomplete).');
    else for (const p of g.proposals.filter(p => p.state === 'open')) lines.push(`- ${quote(p.proposalSubject)} ${quote(p.effectClass)} · facts ${p.factIds.map(quote).join(', ')}`);
  }
  lines.push('', '## Route families and controllers', '');
  for (const i of review.intents) lines.push(`- ${quote(i.assetId)}: ${quote(canonical(i.review))}`);
  if (!review.intents.length) lines.push('Not available: `missing-coverage`.');
  lines.push('', '## Changes', '');
  for (const h of review.history) for (const e of h.events) lines.push(`- ${cell(e.at)} ${cell(e.kind)} ${quote(e.source.subject)} ${refs(e.source)}`);
  for (const change of review.changes) for (const c of change.changes) { lines.push(`- ${cell(c.kind)} ${quote(c.key)}`); if (c.before) lines.push(factLine(c.before)); if (c.after) lines.push(factLine(c.after)); }
  lines.push('', '## Policy verdict', '', review.verdict.outcome, '');
  const allFacts = [...review.policyFacts, ...review.chains.flatMap(c => c.facts), ...review.history.flatMap(h => h.events.map(e => e.source))];
  for (const r of review.verdict.rules) {
    lines.push(`### ${cell(r.ruleId)} · ${cell(r.kind)}`, '', r.outcome);
    for (const reason of r.reasons) lines.push(`- ${cell(reason.code)} ${quote(reason.subject ?? '')} ${quote(reason.ref ?? '')}`);
    for (const id of r.factIds) { const f = allFacts.find(f => f.id === id); lines.push(f ? factLine(f) : `- fact ${quote(id)} · receipts ${r.receiptIds.map(id => { const n = receipts.findIndex(r => r.id === id); return n < 0 ? quote(id) : `[^${n + 1}]`; }).join(' ')}`); }
    if (Object.keys(r.evidence).length) lines.push(`Evidence: ${quote(canonical(r.evidence))}`);
    lines.push('');
  }
  lines.push('## Unknowns', '');
  for (const reason of review.unknowns) lines.push(`- ${cell(reason.code)} ${quote(reason.subject ?? '')} ${quote(reason.ref ?? '')}${'ruleId' in reason ? ` · ${quote(reason.ruleId)}` : ''}`);
  for (const r of review.verdict.rules.filter(r => r.outcome === 'undetermined')) lines.push(`- ${cell(r.ruleId)}: undetermined`);
  for (const p of positions.filter(p => p.coverage === 'uncovered')) lines.push(`- ${quote(p.root)}: missing-subject`);
  lines.push('', '## Receipts', '');
  receipts.forEach((r, n) => lines.push(`[^${n + 1}]: ${r.id} · block ${r.observation.blockOrSlot ?? 'unknown'} · ${r.source.replace(/^near-rpc:/, '')} · sha256 ${r.responseSha256.slice(0, 12)}`));
  const md = lines.join('\n') + '\n';
  if (format === 'md') return md;
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Private local report</title><body><pre>' + escape(md).replace(/`([^`]*)`/g, '<code>$1</code>') + '</pre></body></html>\n';
}
