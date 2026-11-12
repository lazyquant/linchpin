import { NOT_MAPPED_PREFIX } from '../tokenomics/protocols';
import type { BundleResponse, SectionId, Provenance } from '../tokenomics/api';
import { amount, title, parameterValue } from './tokenomics-view';
export type RetrievedFact = Provenance & { section: SectionId; text: string; id: string };
export type QuestionAnswer = { text: string; facts: RetrievedFact[]; sections: SectionId[]; query?: { title: string; rows: Record<string,string|number|null>[]; source: string }; limitations: string[] };
export function indexFacts(b: BundleResponse): RetrievedFact[] {
  const facts: RetrievedFact[]=[];
  const add=(section:SectionId,p:Provenance,id:string,text:string)=>facts.push({...p,section,id,text});
  if(b.answer.status==='ready'&&b.answer.data){for(const s of b.answer.data.statements)add('answer',s,s.id,s.text);for(const u of b.answer.data.unknowns)add('answer',u,u.id,`Unresolved: ${u.text}`);}
  if(b.path.status==='ready'&&b.path.data)for(const l of b.path.data.links)add('path',l,l.id,`${l.mechanism}: ${title(l.status)}. ${l.note}${l.observed?` Observed ${amount(l.observed.amount)} during ${l.observed.window.join(' — ')} across ${l.observed.transactions} transactions.`:' No observed flow amount attached.'}`);
  if(b.control.status==='ready'&&b.control.data){for(const c of b.control.data.controllers)add('control',c,c.id,`${c.label}: ${title(c.type)}. ${c.threshold ?? ''} ${c.note ?? ''}`);for(const r of b.control.data.rows){const c=b.control.data.controllers.find(c=>c.id===r.controllerId);add('control',r,r.id,`${r.target}: ${c?.type==='none'?'Authority absent in captured state':r.canChange}. Controller: ${c?.label ?? 'unresolved'}; required role ${r.role}; instruction ${r.instructions.join(', ') || 'not mapped'}; holder ${r.holder.label ?? r.holder.address}.`);}}
  if(b.parameters.status==='ready'&&b.parameters.data)for(const r of b.parameters.data.rows)add('parameters',r,r.id,`${r.label}: ${parameterValue(r.display,r.unit)}. Program ${r.program}, field ${r.field}. ${r.setBy.map(s=>`${s.instruction} requires ${s.role}; instruction-to-parameter link is ${s.basis}`).join('; ')}`);
  if(b.offsets.status==='ready'&&b.offsets.data)for(const r of b.offsets.data.rows)add('offsets',r,r.id,`${r.label}: ${r.amount?amount(r.amount):'Amount not available'}. ${r.note}${r.window?` Window ${r.window.join(' — ')}.`:''}`);
  if(b.claims.status==='ready'&&b.claims.data)for(const r of b.claims.data.rows)add('claims',r,r.id,`${r.chainResult}. Status ${r.status}. Claim: ${r.text}. ${r.note}`);
  if(b.participation.status==='ready'&&b.participation.data){const p=b.participation.data;for(const m of [...p.locking,...p.votingPower,...p.programs])add('participation',m,m.id,`${m.label}: ${m.amount?amount(m.amount):m.value}. ${m.note ?? ''}`);for(const r of p.topLockers)add('participation',r,`locker-${r.rank}`,`Locker rank ${r.rank}: ${r.authority.label ?? r.authority.address}, ${amount(r.amount)}.`);}
  if(b.holders.status==='ready'&&b.holders.data){for(const [asset,h] of Object.entries({MNDE:b.holders.data.mnde,mSOL:b.holders.data.msol})){for(const m of h.metrics)add('holders',m,m.id,`${asset} ${m.label}: ${m.amount?amount(m.amount):m.value}. ${m.note ?? ''}`);for(const r of h.top)add('holders',r,`${asset}-${r.rank}`,`${asset} holder rank ${r.rank}: ${r.owner.label ?? r.owner.address}; ${amount(r.amount)}.`);}for(const m of b.holders.data.mnde.float)add('holders',m,m.id,`${m.label}: ${m.amount?amount(m.amount):m.value}. ${m.note ?? ''}`);}
  if(b.programs.status==='ready'&&b.programs.data)for(const r of b.programs.data.rows)add('programs',r,r.id,`${r.idl?.name ?? r.address}: ${r.upgradeable?'upgradeable':'not upgradeable'}, authority ${r.upgradeAuthority?.label ?? r.upgradeAuthority?.address ?? 'not established'}. Newest sampled activity ${r.activity.newest ?? 'unavailable'}; dormant in sample ${r.activity.dormant ?? 'not established'}.`);
  if(b.flows.status==='ready'&&b.flows.data){const f=b.flows.data;for(const r of f.declaredRoutes)add('flows',r,r.id,`${r.program} ${r.instruction}: declared receiving account ${r.account} ${r.address ?? ''}. ${r.note}`);if(f.treasury.inflows)add('flows',f.treasury.inflows,'treasury-inflow',`Treasury inflows: ${amount(f.treasury.inflows.amount)}, window ${f.treasury.inflows.window.join(' — ')}.`);for(const r of f.buybacks.months)add('flows',r,r.month,`Buybacks ${r.month}: ${amount(r.mndeBought)} bought; ${amount(r.mndeSent)} sent to ${r.recipients} recipients; cost ${r.cost.map(amount).join(', ')}.`);}
  return facts;
}
const stop=new Set(['what','which','who','how','the','and','for','are','can','does','from','have','this','that','with','there','about','show','tell','give','please','holders','control','controls','change','changed']);
const tokens=(s:string)=>s.toLowerCase().match(/[a-z0-9]+/g)?.map(t=>t.length>3&&t.endsWith('s')?t.slice(0,-1):t).filter(t=>t.length>2&&!stop.has(t))??[];
export function answerQuestion(question:string,b:BundleResponse):QuestionAnswer {
  const q=question.toLowerCase(), words=tokens(question); let sections:SectionId[]=[];
  const topics: [RegExp, SectionId][] = [
    [/treasur/, 'offsets'],
    [/where[^?]*fee|fee[^?]*\b(go|goes|route|routed|destination|sent|collected)\b|value route/, 'path'],
    [/\bholders?\b|\bholds?\b|\bfloat\b/, 'holders'],
    [/govern|\bvot|\block|\bstak/, 'participation'],
    [/\bflows?\b|transaction|transfer/, 'flows'],
  ];
  // Only explicit control-target modifiers may connect a verb to a role.
  // The role must end the noun phrase, without a possessive or another object.
  // Other objects must retain their holders/flows coverage requirement.
  const addresses = question.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? [];
  const modifier = `(?:the|a|an|my|your|his|her|its|our|their|[a-z0-9]+['’]s|[a-z0-9]+s['’]|vault|kvault|program|lending|market|allocation|upgrade|admin|owner|klend|oracle${addresses.map(address => `|${address.toLowerCase()}`).join('')})`;
  const controlPhrase = new RegExp(`\\b(?:holds?\\s+|holder\\s+of\\s+|(?:(?:can|may|to)\\s+)transfer\\s+)(?:${modifier}\\s+){0,5}?(?:authority|authorities|admin|owner|role|roles|controller|controllers|signer|signers|multisig)\\b(?=\\s*(?:$|[?.!,;:]|(?:of|for|over|on|at|and|or)\\b))`, 'g');
  let coordinatedControl = false;
  const controlQuestion = q.replace(controlPhrase, (phrase, offset: number) => {
    // Validate addresses against the original case: base58 excludes 0, O, I and l.
    const original = question.slice(offset, offset + phrase.length);
    const validAddresses = original.split(/\s+/).every(word =>
      !/^[1-9a-z]{32,44}$/i.test(word) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word));
    const remainder = q.slice(offset + phrase.length);
    // Punctuation can introduce more objects; a single role clarification is
    // still pure control (for example, "authority: the multisig?").
    const roleClarification = /^\s*[,;:]\s*(?:the\s+)?(?:authority|authorities|admin|owner|role|roles|controller|controllers|signer|signers|multisig)\s*[?.!]*\s*$/.test(remainder);
    const coordinated = /^\s+(?:and|or)\b/.test(remainder)
      || (/^\s*[,;:]\s*[^?.!\s]/.test(remainder) && !roleClarification);
    if (validAddresses && coordinated) {
      coordinatedControl = true;
      return phrase;
    }
    return validAddresses ? '' : phrase;
  });
  const vaultAction = /\bwho\b.*\b(can|may)\b.*\b(lock|pause|freeze)\s+(?:the\s+)?vault\b/.test(q);
  const mappedControl = b.control.status === 'ready' && !!b.control.data?.rows.length
    && (controlQuestion !== q || coordinatedControl || vaultAction);
  // Coverage is collected independently of retrieval and before any return.
  // Only direct role objects (and vault control actions) remove topic meaning.
  const uncovered = topics.filter(([pattern, section]) => {
    const envelope = b[section];
    if (!pattern.test(q) || envelope.status !== 'pending'
      || !envelope.notes.some(note => note.startsWith(NOT_MAPPED_PREFIX))) return false;
    if ((section === 'holders' || section === 'flows') && !pattern.test(controlQuestion)) return false;
    if (section === 'participation' && mappedControl && vaultAction
      && !pattern.test(q.replace(/\b(lock|pause|freeze)\b/g, ''))) return false;
    return true;
  }).map(([, section]) => section);
  const coverage = uncovered.map(section => `${title(section)}: ${b[section].notes.join(' ')}`);
  // A fee unit can retrieve parameters, but must still disclose flow coverage.
  const feeUnit = /\bper[- ]transaction\b/.test(q);
  if (uncovered.length && !mappedControl && !feeUnit) {
    const section = uncovered[0]!, note = b[section].notes.find(note => note.startsWith(NOT_MAPPED_PREFIX))!;
    const end = note.indexOf('. ');
    return { text: `${end < 0 ? note : note.slice(0, end + 1)} This is reported as not mapped, not as absent.`, facts: [], sections: [section], query: undefined,
      limitations: coverage };
  }
  if(/unknown|unverified|unresolved|missing|uncertain/.test(q))sections=['answer','claims'];
  else if(/enforce|value path|reach|benefit/.test(q))sections=['path','answer'];
  else if(/who|control|authority|multisig|signer|change|admin|pause|mint|issu|freeze/.test(q))sections=['control','parameters','programs'];
  else if(/fee|parameter|cap|rewardfee|unstake/.test(q))sections=['parameters','path','claims'];
  else if(/lock|vot|participat|utility|gauge/.test(q))sections=['participation','control'];
  else if(/hold|float|concentrat|supply|distribut/.test(q))sections=['holders','answer'];
  else if(/flow|buyback|revenue|treasury|purchase/.test(q))sections=['flows','path','offsets'];
  else if(/offset|dilut|outflow|burn/.test(q))sections=['offsets','flows'];
  else if(/claim|document|contradict/.test(q))sections=['claims','answer'];
  else if(/program|deploy|upgrade|dormant/.test(q))sections=['programs','control'];
  else if(/path|enforce|reach|benefit|economic/.test(q))sections=['path','answer'];
  // Allocation questions concern the vault's state roles. With no mapped value
  // route, incidental vault mentions in fees and program code are not controls.
  const allocationControls = b.path.status === 'pending' && b.path.notes[0]?.startsWith(NOT_MAPPED_PREFIX)
    && /\bvault\b/.test(q) && /allocat/.test(q) && /who|control|authority|change|admin/.test(q)
    ? new Set(b.control.data?.rows.filter(r => ['allocationAdmin', 'vaultAdminAuthority'].includes(r.role)).map(r => r.id)) : null;
  const indexed=indexFacts(b).filter(f => !allocationControls || allocationControls.has(f.id));
  const ranked=indexed.map((f,i)=>({f,i,score:words.reduce((n,w)=>n+(f.text.toLowerCase().includes(w)?3:0),0)+(sections.includes(f.section)?4:0)})).filter(r=>r.score>0).sort((a,z)=>z.score-a.score||a.i-z.i);
  const cutoff=Math.max(1,(ranked[0]?.score??0)-3);
  const facts=ranked.filter(r=>r.score>=cutoff).slice(0,4).map(r=>r.f);
  const graph=b.graph.status==='ready'?b.graph.data:null;
  const graphMatch=graph?.queries.map(query=>({query,score:words.reduce((n,w)=>n+(`${query.question} ${query.title}`.toLowerCase().includes(w)?1:0),0)})).sort((a,z)=>z.score-a.score)[0];
  const query=graphMatch && graphMatch.score>=2 && /graph|depend|path|controller|program/.test(q) ? {title:graphMatch.query.title,rows:graphMatch.query.rows.slice(0,5),source:graph!.source}:undefined;
  const pending=[...new Set([...sections,...uncovered])].filter(s=>b[s].status!=='ready').map(s=>`${title(s)}: ${b[s].notes.join(' ')||b[s].error||'in progress'}`);
  const isBroad=!words.length||/research question|summari[sz]e|overview/.test(q);
  let text='Here are the closest supported records in the current research bundle.';
  if(sections[0]==='control'){const row=b.control.data?.rows.find(r=>r.id===facts[0]?.id),controller=b.control.data?.controllers.find(c=>c.id===row?.controllerId);if(row&&controller?.type==='none')text=`No ${row.role} is present for ${title(row.target)} in the captured state. The supporting mapping is ${Array.isArray(row.basis)?row.basis.join(' / '):row.basis}.`;else if(row)text=`${controller?.label??'An unresolved controller'} can change ${title(row.target)} through ${row.instructions.join(', ')||'an instruction not yet mapped'}, using the ${row.role} role. The supporting mapping is ${Array.isArray(row.basis)?row.basis.join(' / '):row.basis}.`;}
  else if(sections[0]==='parameters'&&facts[0])text=facts[0].text;
  else if(sections[0]==='path'&&b.answer.data)text=b.answer.data.shortAnswer.text;
  if(isBroad&&b.answer.status==='ready'&&b.answer.data){text=b.answer.data.shortAnswer.text;facts.splice(0,facts.length,...indexed.filter(f=>f.section==='answer').slice(0,5));sections=['answer','path','control','offsets'];}
  else if(!facts.length&&!query)text='I cannot establish an answer to that question from the captured research bundle. Try a specific fee, authority, value route, lockup or dependency; the missing evidence stays unresolved.';
  else if(/unknown|unverified|unresolved/.test(q)){const unknown=indexed.filter(f=>f.text.startsWith('Unresolved:'));if(unknown.length)facts.splice(0,facts.length,...unknown.slice(0,5));text='These questions remain unresolved in the recorded research.';}
  if (uncovered.length) text += ` The ${uncovered.map(title).join(', ')} part is not mapped in this capture.`;
  return {text,facts,sections:[...new Set([...sections,...facts.map(f=>f.section),...(query?['graph' as const]:[])])],query,limitations:pending};
}
