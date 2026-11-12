import type { EvidenceReceipt, Fact, QueryReason } from "../../engine/contracts";
import { buildNearSnapshot, nearReads, readNearManifest } from "../reader/load";
import { parseSputnikPolicy } from "../reader/mappers";
import { isNearAccountId, nearSubject, parseNearSubject, type SputnikPolicy } from "../reader/types";
import { NEAR_REGISTRY } from "../subjects/registry";
import { decodeProposal } from "./decode";
import { classify } from "./effect";
import { governanceChanges } from "./history";
import { emptyMath, executionMath, proposalExpiry } from "./math";
import { daoControls, governanceStore, intersectFor } from "./reach";
import { GOVERNANCE_VERSION, type GovernanceContext, type GovernanceReport, type ProposalSummary, type ReviewSentence, type TouchingProposal } from "./types";
export function loadPolicy(ctx: GovernanceContext, dao: string): { policy: SputnikPolicy; receipt: EvidenceReceipt } | null {
  const read = nearReads(ctx.snapshotId,{root:ctx.root}).find(dao,"call_function","get_policy");
  if (!read) return null; try { return {policy:parseSputnikPolicy(read.value),receipt:read.receipt}; } catch { return null; }
}
export const SENTENCE_TEMPLATES = {
  control: (x:string) => `This proposal changes who controls ${x}.`,
  funds: (x:string,y:string) => `This proposal moves funds from ${x} to ${y}.`,
  code: (x:string) => `This proposal changes the code of ${x}.`,
  parameter: (x:string) => `This proposal sets a parameter of ${x}.`,
} as const;
function sentences(facts: Fact[]): ReviewSentence[] {
  const result: ReviewSentence[]=[];
  for (const [predicate,template] of [["touches-control-of","control"],["touches-code-of","code"],["changes-parameter-of","parameter"]] as const) for (const f of facts.filter(f => f.predicate === predicate)) result.push({template,text:SENTENCE_TEMPLATES[template](f.object),factIds:[f.id]});
  const targets=facts.filter(f=>f.predicate === "moves-funds-to");
  for (const from of facts.filter(f=>f.predicate === "moves-funds-from")) { if (!targets.length) result.push({template:"funds",text:SENTENCE_TEMPLATES.funds(from.object,"unknown"),factIds:[from.id]}); for (const to of targets) result.push({template:"funds",text:SENTENCE_TEMPLATES.funds(from.object,to.object),factIds:[from.id,to.id]}); }
  return result;
}
function account(dao:string): string { const p=dao.startsWith("near:") ? parseNearSubject(dao) : null; const a=p?.kind === null ? p.account : dao; if (!isNearAccountId(a)) throw new TypeError("Invalid DAO account"); return a; }
type Options = { forSubject?: string; compareSnapshotId?: string };
function review(ctx: GovernanceContext, input: string, id: number | null, opts: Options): GovernanceReport {
  const dao=account(input), subject=nearSubject(dao);
  if (opts.forSubject && !parseNearSubject(opts.forSubject)) throw new TypeError("Invalid intersection subject");
  readNearManifest(ctx.snapshotId,{root:ctx.root});
  const base=buildNearSnapshot(ctx.snapshotId,{root:ctx.root}), policy=loadPolicy(ctx,dao);
  const all=base.facts.filter(f=>f.predicate === "proposal" && parseNearSubject(f.subject)?.account === dao).map(f=>decodeProposal(f,policy?.policy,policy?.receipt,ctx.registry)).sort((a,b)=>a.id-b.id);
  const selected=all.filter(p=>id === null ? p.status === "InProgress" : p.id === id);
  const derived=governanceStore(ctx,policy ? selected : []), snapshot=derived.store.snapshot(derived.snapshotId)!, governance=governanceChanges(ctx,dao,opts.compareSnapshotId);
  const reasons: QueryReason[]=[];
  if (!base.subjects.includes(subject)) reasons.push({code:"missing-subject",subject,ref:ctx.snapshotId});
  else if (id !== null && !selected.length) { const first=all[0]?.id, last=all.at(-1)?.id; reasons.push(first !== undefined && id < first ? {code:"missing-coverage",subject,ref:`${dao}#proposals:${first}-${last}`} : {code:"missing-subject",subject:nearSubject(dao,"proposal",String(id)),ref:ctx.snapshotId}); }
  const proposals=selected.map(p=>{
    const reasons: QueryReason[]=[], facts=derived.reach.get(p.proposalSubject) ?? [], receipt=derived.store.receipt(p.evidenceIds[0]);
    let math=emptyMath(p.policyLabel), expiry=null;
    if (!policy || !receipt) reasons.push({code:"missing-evidence",subject,ref:"get_policy"});
    else {
      if (p.decoded.kind !== "unknown-kind") math=executionMath(policy.policy,p.proposal);
      try { if (p.submittedAt !== "unknown") expiry=proposalExpiry(p.proposal,policy.policy,receipt,policy.receipt); } catch { reasons.push({code:"missing-coverage",subject:p.proposalSubject,ref:p.factId}); }
    }
    if (p.decoded.kind === "unknown-kind" || math.reason) reasons.push({code:"missing-coverage",subject:p.proposalSubject,ref:p.factId});
    const d=p.decoded;
    if ("receiver_id" in d && !isNearAccountId(d.receiver_id)) reasons.push({code:"missing-coverage",subject:p.proposalSubject,ref:p.proposalSubject});
    if (d.kind === "FunctionCall") for (const a of classify(p,ctx.registry).actions) if (a.ruleId === "A07") { const action=d.actions[a.index], args=action.args as Record<string,unknown>|null; if (action.argsFormat !== "json" || !args || typeof args.receiver_id !== "string" || !isNearAccountId(args.receiver_id)) reasons.push({code:"missing-coverage",subject:p.proposalSubject,ref:p.proposalSubject}); }
    const intersection=opts.forSubject ? intersectFor(derived.store,derived.snapshotId,facts,opts.forSubject) : null;
    return {decoded:p,effect:classify(p,ctx.registry),math,expiry,reach:facts,daoControls:daoControls(base,subject),intersection,sentences:sentences(facts),reasons};
  });
  const receipts=new Map(base.receipts.map(r=>[r.id,r]));
  const supporting=new Map<string,Fact>();
  const summaryPredicates=["council-member","vote-threshold","proposal-period","bond"];
  for(const f of base.facts) if(parseNearSubject(f.subject)?.account === dao && summaryPredicates.includes(f.predicate)) supporting.set(f.id,f);
  for (const comparison of [governance.beforeSnapshotId,governance.afterSnapshotId]) if (comparison && comparison !== ctx.snapshotId) { const compared=buildNearSnapshot(comparison,{root:ctx.root}); for (const r of compared.receipts) receipts.set(r.id,r); for(const f of compared.facts) if(parseNearSubject(f.subject)?.account === dao && summaryPredicates.includes(f.predicate)) supporting.set(f.id,f); }
  const used=new Set<string>();
  for (const p of proposals) { p.decoded.evidenceIds.forEach(id=>used.add(id)); for (const f of [...p.reach,...p.daoControls]) f.evidenceIds.forEach(id=>used.add(id)); if (policy) used.add(policy.receipt.id); for (const hop of p.intersection?.hops ?? []) for (const id of hop.chainFactIds) {const f=base.facts.find(f=>f.id===id);if(f) supporting.set(f.id,f);} }
  for (const e of governance.history) for (const f of [e.source,e.fact]) f.evidenceIds.forEach(id=>used.add(id));
  for (const c of governance.changes) for (const f of [c.before,c.after]) f?.evidenceIds.forEach(id=>used.add(id));
  // Policy summary and observation metadata remain attributable in empty sweeps.
  if (policy) used.add(policy.receipt.id);
  const allReasons=[...reasons,...governance.reasons,...proposals.flatMap(p=>[...p.reasons,...p.intersection?.reasons ?? []])];
  for(const reason of allReasons) {const f=base.facts.find(f=>f.id === reason.ref);if(f) supporting.set(f.id,f);}
  for(const f of supporting.values()) f.evidenceIds.forEach(id=>used.add(id));
  const {chain,network,constructed,observedFrom,observedTo,fromBlockOrSlot,toBlockOrSlot,freshUntil}=snapshot;
  return {version:GOVERNANCE_VERSION,mode:id === null ? "open":"proposal",dao,snapshotId:ctx.snapshotId,governanceSnapshotId:derived.snapshotId,constructed,observation:{snapshotId:ctx.snapshotId,chain,network,constructed,observedFrom,observedTo,fromBlockOrSlot,toBlockOrSlot,freshUntil,asOf:observedTo},forSubject:opts.forSubject ?? null,proposals,governance,receipts:[...receipts.values()].filter(r=>used.has(r.id)).sort((a,b)=>a.id.localeCompare(b.id)),supportingFacts:[...supporting.values()].sort((a,b)=>a.id.localeCompare(b.id)),reasons:allReasons};
}
export function reviewProposal(ctx:GovernanceContext,dao:string,id:number,opts:Options={}):GovernanceReport { if (!Number.isSafeInteger(id)||id<0) throw new TypeError("Invalid proposal id"); return review(ctx,dao,id,opts); }
export function sweepOpen(ctx:GovernanceContext,dao:string,opts:Options={}):GovernanceReport { return review(ctx,dao,null,opts); }
const summary=(p:GovernanceReport["proposals"][number],constructed:boolean):ProposalSummary=>({dao:p.decoded.dao,id:p.decoded.id,proposalSubject:p.decoded.proposalSubject,status:p.decoded.status,state:p.expiry?.state ?? null,effectClass:p.effect.effectClass,constructed,factIds:[p.decoded.factId,...p.reach.map(f=>f.id)]});
export function openProposals(ctx:GovernanceContext,dao:string):ProposalSummary[] { const r=sweepOpen(ctx,dao);return r.proposals.map(p=>summary(p,r.constructed)); }
export function proposalsTouching(ctx:GovernanceContext,subject:string,daos?:string[]):TouchingProposal[] { return (daos ?? (ctx.registry ?? NEAR_REGISTRY).filter(e=>e.account.endsWith(".sputnik-dao.near")).map(e=>e.account)).flatMap(dao=>{const r=sweepOpen(ctx,dao,{forSubject:subject});return r.proposals.filter(p=>p.intersection!.hops.length).map(p=>({...summary(p,r.constructed),hops:p.intersection!.hops}));}).sort((a,b)=>a.dao.localeCompare(b.dao)||a.id-b.id); }
