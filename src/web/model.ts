import type { Evidence } from '../chain/evidence';
import type { Packet } from '../review/packet';
import type { PackPacket } from '../pack/model';
import type { GEdge } from '../graph/model';
type DisplayGraph = { nodes: { id: string; type: string; label: string; props?: Record<string, unknown> }[]; edges: GEdge[] };

export const CASES = [
  { id: 'marinade', label: 'Marinade / MNDE', kind: 'Protocol research', question: 'Who controls Marinade, what can change MNDE supply, and what has the DAO treasury spent?', file: 'packs/marinade/pack.json' },
  { id: 'bonk-bip76', label: 'BonkDAO · BIP-76', kind: 'Historical review', question: 'What did BIP-76 authorize, which account lost tokens, and what does the execution prove?', file: 'cases/bonk-bip76.json' },
  { id: 'mip-14', label: 'Marinade · MIP-14', kind: 'Governance review', question: 'Did the MIP-14 payload burn 300 million MNDE, and what supports the 30% claim?', file: 'cases/mip-14.json' },
  { id: 'mip-14-opinion', label: 'MIP-14 · opinion vote', kind: 'Signaling control', question: 'Does an approved opinion vote itself contain an executable token burn?', file: 'cases/mip-14-opinion.json' },
] as const;
export type CaseId = typeof CASES[number]['id'];
export type Source = { id: string; kind: 'docs' | 'chain'; title: string; capturedAt: string; slot: number | null; hash?: string; url?: string; detail: unknown };
export type Finding = { id: string; title: string; text: string; status: string; basis: string; sourceIds: string[]; code: string[] };
export type Path = { label: string; nodeIds: string[]; sourceIds: string[]; note: string; status: string };
export type View = { id: CaseId; title: string; question: string; generatedAt: string; capturedRange: string[]; slotRange: (number | null)[]; evidenceCount: number; findings: Finding[]; paths: Path[]; graph: DisplayGraph; timeline: { label: string; time: string; detail: string; sourceIds: string[] }[]; unknowns: string[]; memo: string; ledger?: PackPacket['ledger']; binding?: string };
export type Result = { view: View; sources: Source[]; packet: Packet | PackPacket; evidence: Evidence[] };
const uniq = <T>(v: T[]) => [...new Set(v)];
const iso = (v: number | null) => v == null ? 'Time unavailable' : new Date(v * 1000).toISOString();
const url = (value: string) => /^https?:\/\//.test(value) ? value : undefined;

export function present(id: CaseId, packet: Packet | PackPacket, evidence: Evidence[]): Result {
  const scope = CASES.find(c => c.id === id)!;
  const sources: Source[] = uniq(evidence.map(e => e.id)).map(id => {
    const e = evidence.find(e => e.id === id)!;
    return { id: e.id, kind: 'chain', title: e.method, capturedAt: e.retrievedAt, slot: e.slot, hash: e.responseSha256, detail: { method: e.method, params: e.params, replaySource: e.source } };
  });
  const dates = sources.map(s => s.capturedAt).sort();
  const slots = evidence.flatMap(e => e.slot == null ? [] : [e.slot]);
  const view: View = { id, title: scope.label, question: scope.question, generatedAt: packet.generatedAt, capturedRange: dates.length ? [dates[0], dates.at(-1)!] : [], slotRange: slots.length ? [Math.min(...slots), Math.max(...slots)] : [null, null], evidenceCount: packet.evidenceCount, findings: [], paths: [], graph: { nodes: [], edges: [] }, timeline: [], unknowns: [], memo: '' };
  if ('pack' in packet) {
    packet.claims.forEach(c => sources.push({ id: `doc:${c.id}`, kind: 'docs', title: c.source, capturedAt: c.retrievedAt, slot: null, url: url(c.source), detail: { claim: c.text, status: c.status, note: c.note } }));
    for (const [i, p] of packet.controllerPaths.entries()) {
      const docs = packet.claims.filter(c => p.claims.some(pc => pc.text === c.text)).map(c => `doc:${c.id}`);
      view.findings.push({ id: `control-${i}`, title: `${p.role || p.subjectKind} · ${p.authorityType}`, text: p.note, status: p.status, basis: 'observed account state vs documented claim', sourceIds: uniq([...docs, ...p.evidenceIds]), code: ['src/chain/program-authority.ts', 'src/pack/classify.ts', 'src/pack/build.ts'] });
      const nodePath = p.path.filter((address, j) => j === 0 || address !== p.path[j - 1]);
      view.paths.push({ label: `${p.role || p.subject.slice(0, 8)} · ${p.authorityType}`, nodeIds: nodePath, sourceIds: p.evidenceIds, status: p.status, note: p.note });
      nodePath.forEach((address, j) => {
        const dao = ['dao-governance-account', 'native-treasury-pda'].includes(p.authorityKind);
        const realm = dao && p.path.length >= 3 && address === p.path.at(-1);
        const governance = dao && address !== p.authority && address !== p.subject && address !== p.path.at(-1);
        const type = realm ? 'Realm' : governance ? 'Governance' : address === p.authority ? p.authorityKind === 'native-treasury-pda' ? 'NativeTreasury' : p.authorityKind === 'dao-governance-account' ? 'Governance' : 'Authority' : address === p.subject ? p.subjectKind === 'program' ? 'Program' : p.subjectKind === 'mint' ? 'Mint' : /Account classification: token-account/.test(p.note) ? 'TokenAccount' : 'Account' : 'Program';
        const label = realm ? 'Marinade DAO realm' : governance ? 'DAO governance' : address === p.subject ? p.role || p.subjectKind : address === p.authority ? p.authorityKind : 'Controlling program';
        const old = view.graph.nodes.find(n => n.id === address);
        if (!old) view.graph.nodes.push({ id: address, type, label, props: { address, status: p.status } });
        else if (['Realm', 'Governance', 'NativeTreasury'].includes(type)) { old.type = type; old.label = label; }
        if (j) {
          const previous = nodePath[j - 1];
          const relation = realm ? 'BELONGS_TO' : previous === p.subject && p.subject !== p.authority ? `${p.authorityType.toUpperCase()}_AUTHORITY` : dao ? 'TREASURY_OF' : 'DERIVED_BY';
          view.graph.edges.push({ from: previous, to: address, type: relation, basis: 'observed', evidenceIds: p.evidenceIds, props: { pathStatus: p.status } });
        }
      });
    }
    packet.statements.forEach(s => view.findings.push({ id: s.id, title: s.topic === 'supply' ? 'Token supply' : s.topic === 'treasury' ? 'Treasury mechanism' : 'Governance', text: s.text, status: s.status, basis: 'chain state and declared research boundary', sourceIds: uniq([...s.evidenceIds, ...packet.claims.filter(c => s.text.includes(c.text)).map(c => `doc:${c.id}`), ...evidence.filter(e => e.method === 'getTransaction' && Array.isArray(e.params) && s.text.includes(String(e.params[0]))).map(e => e.id)]), code: ['src/pack/build.ts', s.topic === 'supply' ? 'src/pack/supply.ts' : 'src/pack/ledger.ts'] }));
    view.ledger = packet.ledger;
    for (const a of packet.ledger.summary.assets) {
      const entries = packet.ledger.entries.filter(e => e.asset === a.asset && e.basis === 'observed' && (e.reconciliation === 'matched' || e.reconciliation.startsWith('matched (aggregate of ')));
      view.findings.push({ id: `ledger-${a.asset}`, title: `Treasury flows · ${a.asset.slice(0, 8)}…`, text: `External outflows ${a.externalOutflowsDisplay}; internal moves ${a.internalMovesDisplay}; burns ${a.burnsDisplay}; net DAO-controlled balance change ${a.netChangeOfDaoControlledBalanceDisplay}. Governance execution boundary only; ${a.decimals ?? 'unknown'} decimals.`, status: 'observed', basis: 'reconciled execution receipts', sourceIds: uniq(entries.flatMap(e => e.evidenceIds)), code: ['src/pack/ledger.ts'] });
    }
    view.unknowns = packet.unknowns.map(u => u.text);
    view.unknowns.push('The treasury ledger covers governance executions; it does not establish the complete buyback / revenue / reward route.');
    view.timeline = packet.ledger.entries.filter(e => e.receiptSignature).map(e => ({ label: e.proposalName, time: iso(e.executedAt), detail: `${e.instructionLabel} · ${e.amountDisplay ?? 'no token amount'} · ${e.reconciliation}`, sourceIds: e.evidenceIds }));
  } else {
    view.graph = packet.graph; view.binding = packet.bindingSha256;
    packet.claimed.forEach(c => sources.push({ id: `doc:${c.id}`, kind: 'docs', title: c.source, capturedAt: c.retrievedAt, slot: null, url: url(c.sourceRef ?? c.source), detail: { claim: c.text, status: 'claimed', sourceRef: c.sourceRef } }));
    const propIds = [packet.proposal.evidenceId, packet.governance.evidenceId].filter(Boolean);
    const codeByCheck: Record<string, string[]> = { 'Claim coverage': ['src/governance/claims.ts'], 'Observed execution': ['src/governance/receipt.ts'], 'Voting outcome': ['src/review/checks.ts'] };
    const types: Record<string, string[]> = { 'Treasury movement': ['treasuryMovement'], 'Supply change': ['supplyChange', 'mint'], 'Control change': ['controlChange'], 'Account creation': ['accountCreation'], 'Unknown / unsupported': ['unknown'] };
    packet.checks.forEach((check, i) => {
      const effects = packet.effects.filter(e => types[check.check]?.includes(e.type));
      const payloadIds = packet.graph.edges.filter(e => e.type === 'CONTAINS_INSTRUCTION' || e.type === 'PRODUCES').flatMap(e => e.evidenceIds);
      const receipts = check.check === 'Observed execution' || check.check === 'Treasury movement' ? packet.observed.receipts.flatMap(r => r.evidenceIds) : [];
      view.findings.push({ id: `check-${i}`, title: check.check, text: check.result, status: check.needsReview ? 'needs review' : 'checked', basis: check.basis, sourceIds: uniq([...propIds, ...effects.flatMap(e => e.evidenceIds), ...payloadIds, ...receipts, ...(check.check === 'Claim coverage' ? packet.claimed.map(c => `doc:${c.id}`) : [])]), code: codeByCheck[check.check] ?? ['src/governance/decode.ts', 'src/governance/effects.ts', 'src/review/checks.ts'] });
    });
    for (const sim of packet.simulated) view.findings.push({ id: `sim-${sim.id}-${sim.txIndex}-${sim.ixIndex}`, title: `${sim.kind} simulation`, text: `${sim.label}: ${sim.success ? 'success' : 'failed'}. Assumptions: ${sim.assumptions.join('; ')}. This conditional preview does not establish historical authorization or safety.`, status: 'conditional', basis: 'simulated', sourceIds: sim.evidenceIds, code: ['src/governance/simulate.ts'] });
    if (packet.controlPath.length) view.paths.push({ label: 'Token account → DAO control', nodeIds: packet.controlPath, sourceIds: packet.graph.edges.filter(e => ['OWNED_BY', 'TREASURY_OF', 'BELONGS_TO'].includes(e.type) && packet.controlPath.includes(e.from) && packet.controlPath.includes(e.to)).flatMap(e => e.evidenceIds), status: 'observed', note: 'Account ownership and the governance treasury derivation establish this control path at capture.' });
    view.timeline = [
      { label: 'Voting completed', time: iso(packet.proposal.votingCompletedAt), detail: `Proposal state ${packet.proposal.stateName}; token weights are not voter counts.`, sourceIds: [packet.proposal.evidenceId] },
      ...packet.observed.receipts.map(r => ({ label: `Execution · transaction ${r.txIndex + 1}`, time: iso(r.blockTime), detail: `Slot ${r.slot} · ${r.success ? 'successful receipt' : 'failed receipt'} · ${packet.proposal.votingCompletedAt != null && r.blockTime != null ? `+${r.blockTime - packet.proposal.votingCompletedAt}s after voting` : 'timing unavailable'} · ${r.signature}`, sourceIds: r.evidenceIds }))
    ];
    view.unknowns = ['A replay uses recorded captures. Current account state is not the historical pre-execution state.', 'A human review decision has not been recorded.'];
    if (packet.effects.some(e => e.type === 'unknown')) view.unknowns.push('Unsupported instructions remain unresolved; receipt success does not decode their meaning.');
    if (id === 'bonk-bip76') view.unknowns.push('Voter counts, concentration and vote buying are reported claims, not established by this review. The source token account is not proof of all DAO assets. This is a retrospective reconstruction.');
    if (id === 'mip-14') view.unknowns.push('The 30% denominator uses claimed pre-burn supply; the historical pre-burn mint state was not captured.');
  }
  if (id === 'marinade') {
    const highlights = ['mnde-state', 'control-19', 'ledger-MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', 'control-4', 'control-5', 'mnde-supply'];
    view.findings.sort((a, b) => (highlights.includes(a.id) ? highlights.indexOf(a.id) : 100) - (highlights.includes(b.id) ? highlights.indexOf(b.id) : 100));
    const preferred = view.paths.findIndex(p => p.label.includes('MNDE token account'));
    if (preferred >= 0) view.paths.unshift(...view.paths.splice(preferred, 1));
    const edges = new Map<string, GEdge>();
    for (const e of view.graph.edges) { const key = `${e.from}:${e.to}:${e.type}`; const old = edges.get(key); if (old) old.evidenceIds = uniq([...old.evidenceIds, ...e.evidenceIds]); else edges.set(key, e); }
    view.graph.edges = [...edges.values()];
  }
  // Never create dangling citations or label an unrelated source as proof.
  const known = new Set(sources.map(s => s.id));
  view.findings.forEach(f => f.sourceIds = uniq(f.sourceIds).filter(s => known.has(s)));
  view.paths.forEach(p => p.sourceIds = uniq(p.sourceIds).filter(s => known.has(s)));
  view.timeline.forEach(t => t.sourceIds = uniq(t.sourceIds).filter(s => known.has(s)));
  view.memo = makeMemo(view, sources);
  return { view, sources, packet, evidence };
}

export function makeMemo(view: View, sources: Source[]): string {
  const refs = uniq(view.findings.flatMap(f => f.sourceIds));
  const number = (id: string) => refs.indexOf(id) + 1;
  const citations = (f: Finding) => f.sourceIds.map(id => `[${number(id)}]`).join(' ');
  return [`# ${view.title} — research memo`, '', '**Draft · deterministic synthesis from recorded evidence · human review pending**', '', `Question: ${view.question}`, `Generated: ${view.generatedAt}`, `Captured: ${view.capturedRange.join(' — ')}; ${view.evidenceCount} evidence records.`, '', '## Findings', '', ...view.findings.map(f => `### ${f.title}\n\n${f.text}\n\nBasis: ${f.basis}; status: ${f.status}. ${citations(f)}\n`), ...(view.ledger ? ['## Governance treasury ledger', '', ...view.ledger.summary.assets.map(a => `- Mint ${a.asset}: external outflows ${a.externalOutflowsDisplay}; internal moves ${a.internalMovesDisplay}; burns ${a.burnsDisplay}; net DAO balance change ${a.netChangeOfDaoControlledBalanceDisplay}. Decimals: ${a.decimals ?? 'unknown'}.`), '', 'Totals are reconciled governance execution flows within the captured boundary. Full ledger rows and their evidence IDs are available in packet.json.'] : []), '', '## Unknowns and next evidence', '', ...view.unknowns.map(u => `- ${u}`), '', '## Sources', '', ...refs.map(id => { const s = sources.find(s => s.id === id)!; return `[${number(id)}] ${s.title}; captured ${s.capturedAt}; slot ${s.slot ?? 'not applicable'}; evidence ID ${s.id}${s.hash ? `; response SHA-256 ${s.hash}` : ''}${s.url ? `; ${s.url}` : ''}`; }), '', 'Code references describe the local decoder/check implementation; they are not a full smart-contract source audit. No live language model or vector search is used in this memo.', ''].join('\n');
}
