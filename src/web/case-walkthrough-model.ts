import type { Packet } from '../review/packet';
import type { BundleResponse, Provenance } from '../tokenomics/api';
export type WalkthroughFact = { label: string; text: string; basis: string; ids: string[]; asOf?: string | null; slot?: number | null };
export function units(raw: string | bigint, decimals: number): string {
  const n = BigInt(raw), negative = n < 0n, s = (negative ? -n : n).toString().padStart(decimals + 1, '0');
  const whole = decimals ? s.slice(0, -decimals) : s;
  const fraction = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? '.' + fraction : ''}`;
}
export function percent(raw: string | bigint, denominator: string, digits = 4, round = false): string | null {
  if (BigInt(denominator) <= 0n) return null;
  const scale = 10n ** BigInt(digits);
  const den = BigInt(denominator), scaled = BigInt(raw) * 100n * scale;
  return (Number((scaled + (round ? den / 2n : 0n)) / den) / Number(scale)).toFixed(digits);
}
export function bonkStory(packet: Packet) {
  const transfer = packet.decoded.find(d => d.kind === 'transfer');
  if (!transfer || transfer.kind !== 'transfer' || transfer.decimals == null) throw new Error('A decoded transfer with known decimals is required.');
  const index = packet.decoded.indexOf(transfer);
  const receipt = packet.observed.receipts.find(r => r.txIndex === index);
  const source = receipt?.tokenBalances.find(r => r.account === transfer.source);
  const destination = receipt?.tokenBalances.find(r => r.account === transfer.destination);
  const reconciliation = packet.observed.reconciliations.find(r => r.proposalTransaction === receipt?.proposalTransaction);
  const matched = !!receipt?.success && reconciliation?.status === 'matched' && reconciliation.expectedDeltaRaw === `-${transfer.amountRaw}` && reconciliation.observedDeltaRaw === `-${transfer.amountRaw}`;
  const approval = packet.proposal.options.find(o => o.label.toLowerCase() === 'approve')?.voteWeightRaw;
  const approveShare = approval && packet.proposal.maxVoteWeightRaw ? percent(approval, packet.proposal.maxVoteWeightRaw, 4, true) : null;
  const end = packet.proposal.votingCompletedAt;
  const first = packet.observed.receipts.filter(r => r.success && r.blockTime != null).sort((a,b) => a.blockTime! - b.blockTime!)[0];
  const creation = packet.decoded.find(d => d.kind === 'createAccount' && d.account === transfer.destination);
  const evidence = [...new Set([packet.proposal.evidenceId, packet.governance.evidenceId, ...(receipt?.evidenceIds ?? [])])];
  return { transfer, receipt, source, destination, matched, approval, approveShare,
    threshold: packet.proposal.voteThreshold?.type === 0 ? packet.proposal.voteThreshold.value : null,
    amount: units(transfer.amountRaw, transfer.decimals), remaining: source ? units(source.postRaw, transfer.decimals) : null,
    sourceBefore: source ? units(source.preRaw, transfer.decimals) : null,
    share: source ? percent(transfer.amountRaw, source.preRaw) : null,
    firstDelay: first?.blockTime != null && end != null ? first.blockTime - end : null,
    transferDelay: receipt?.blockTime != null && end != null ? receipt.blockTime - end : null,
    creationOwner: creation?.kind === 'createAccount' ? creation.owner : null,
    creationIndex: creation ? packet.decoded.indexOf(creation) + 1 : null,
    transferIndex: index + 1, evidence,
    facts: [
      {label:'Declared transfer',text:packet.claimed.find(c => c.id === 'c2')?.text ?? 'Transfer intent has no attached claim.',basis:'claimed',ids:['doc:c2',packet.proposal.evidenceId]},
      {label:'Decoded payload',text:`Proposal transaction ${index + 1} transfers ${units(transfer.amountRaw,transfer.decimals)} BONK from ${transfer.source} to ${transfer.destination}.`,basis:'decoded',ids:[packet.proposal.evidenceId,...packet.effects.flatMap(e=>e.evidenceIds)]},
      {label:'Execution receipt',text:matched ? `The receipt matches the decoded transfer. ${source ? units(source.postRaw,transfer.decimals) : 'Unknown'} BONK remained in this source account.` : 'The decoded transfer is not established as a matched successful receipt.',basis:'observed',ids:receipt?.evidenceIds ?? [],slot:receipt?.slot,asOf:receipt?.blockTime?new Date(receipt.blockTime*1000).toISOString():null},
      {label:'Vote threshold',text:`Approval used ${approveShare ?? 'unknown'}% of recorded maximum vote weight; stored threshold ${packet.proposal.voteThreshold?.value ?? 'unknown'}%. Voter concentration and vote buying were not analysed.`,basis:'decoded proposal state',ids:[packet.proposal.evidenceId]},
      {label:'Review limits',text:'Retrospective reconstruction of one BONK source account. Two metadata payloads remain unsupported. Simulations use later state; they do not establish historical approval or safety.',basis:'unresolved',ids:[packet.proposal.evidenceId]},
    ] satisfies WalkthroughFact[] };
}
export function mndeStory(b: BundleResponse) {
  const links = b.path.data?.links ?? [], rows = b.parameters.data?.rows ?? [];
  const get = (id: string) => links.find(l=>l.id === id);
  const parameter = (id:string) => rows.find(r=>r.id === id);
  const monthly = b.flows.data?.buybacks.months ?? [];
  const sum = (field:'mndeBought'|'mndeCreditedWithoutPayment') => monthly.reduce((n,r)=>n + BigInt(r[field]?.raw ?? '0'),0n).toString();
  const decimals = monthly[0]?.mndeBought.decimals ?? 9;
  const paid = monthly.length ? units(sum('mndeBought'),decimals) : null;
  const unpaid = monthly.length ? units(sum('mndeCreditedWithoutPayment'),decimals) : null;
  const claims = get('purchases-stakers'), buys = get('buyback-purchases');
  const fact = (label:string, p: Provenance, text:string):WalkthroughFact => ({label,text,basis:Array.isArray(p.basis)?p.basis.join(' + '):p.basis,ids:p.evidenceIds,asOf:p.asOf,slot:p.slot});
  const facts:WalkthroughFact[] = [];
  for(const id of ['lp-treasury','council-admin','vote-treasury','buyback-purchases','purchases-stakers']) {const l=get(id);if(l) { const f=fact(id==='buyback-purchases'?'Buyback wallet receipts':l.mechanism,l,l.note + (id==='buyback-purchases'&&paid&&unpaid?` Classification: ${paid} MNDE in same-transaction paid purchases; ${unpaid} MNDE in credits without same-transaction payment.`:'') + (l.observed ? ` Observed ${l.observed.amount.display} ${l.observed.amount.unit}; ${l.observed.window.join(' to ')}.`:'')); if(id==='buyback-purchases')f.basis+=' + derived'; facts.push(f); };}
  const tenPercent = b.claims.data?.rows.find(r=>r.id === 'v5');
  if(tenPercent) facts.push(fact('10% revenue allocation',tenPercent,`Claim status: ${tenPercent.status}. No same-window protocol-revenue denominator has been established; no allocation ratio is computed.`));
  return {get,parameter,paid,unpaid,claims,buys,facts,tenPercent,
    lp:parameter('liquid-staking:liqPool.treasuryCut'), withdraw:parameter('liquid-staking:withdrawStakeAccountFee'), reward:parameter('liquid-staking:rewardFee'),
    council:b.control.data?.controllers.find(c=>c.label.startsWith('Marinade DAO council')),
    shortAnswer:b.answer.data?.shortAnswer, asOf:b.answer.asOf,
  };
}
export function answerBonk(question:string, story:ReturnType<typeof bonkStory>):WalkthroughFact[] {
  if(/who|attacker|buying|voter|concentrat|wallets/.test(question.toLowerCase()))return [story.facts[3]!,story.facts[4]!];
  if(/vote|threshold|hold|delay|seconds/.test(question.toLowerCase()))return [story.facts[3]!,{label:'Execution timing',text:`The first receipt is ${story.firstDelay ?? 'unknown'} seconds after voting ended; the transfer receipt is ${story.transferDelay ?? 'unknown'} seconds after.`,basis:'observed',ids:story.evidence,slot:story.receipt?.slot}];
  if(/hidden|description|claim|proposal|intent/.test(question.toLowerCase()))return [story.facts[0]!,story.facts[1]!];
  if(/transfer|amount|remain|treasury|execution|receipt/.test(question.toLowerCase()))return [story.facts[1]!,story.facts[2]!];
  if(/simulat|safe|prevent|unknown|unverified|limit/.test(question.toLowerCase()))return [story.facts[4]!];
  return [];
}

export function walkthroughMemo(caseId:'bonk'|'mnde',facts:WalkthroughFact[],generatedAt:string):string {
  return `# ${caseId==='bonk'?'BonkDAO BIP-76':'MNDE tokenomics'} — evidence walkthrough\n\nDraft · human review pending. Generated ${generatedAt}. Questions retrieve evidence; no language model is used.\n\n${facts.map((f,i)=>`## ${f.label} [${i+1}]\n\n${f.text}\n\nBasis: ${f.basis}. As of: ${f.asOf??'See supporting record'}. Slot: ${f.slot??'See supporting record'}.\n\nReferences:\n${[...new Set(f.ids)].map(id=>'- '+id).join('\n')}`).join('\n\n')}\n\n${caseId==='bonk'?'Retrospective reconstruction. Proposal explicitly requests the transfer. This source account does not represent all DAO assets. Simulations use later state and do not establish historical approval or safety.':'Recorded mainnet state and sampled historical flows. The 10% allocation is unresolved. Current locker overlap does not establish historical eligibility or trace fungible purchased tokens.'}\n`;
}
