import type { EvidenceReceipt, Fact, QueryReason, QueryResult } from "../../engine/contracts";
import { canonical } from "../../chain/evidence";
import { runQuery } from "../../engine/queries/run";
import type { EvidenceSnapshot, EvidenceStore } from "../../engine/queries/snapshot";
import { VOCABULARY, type Predicate } from "../../engine/queries/vocabulary";
import { controlSurface, nearChanges } from "../reader/control";
import { parseNearSubject } from "../reader/types";
import { NEAR_REGISTRY, type SubjectEntry } from "../subjects/registry";
import { decodeProposal } from "../governance/decode";
import { reach, intersectFor } from "../governance/reach";
import { FOR_RELATIONS } from "../governance/types";
import { GAP_TEXTS, SECTION_TITLES, factValue, factWhat } from "./templates";
import { PanelRejected, type PanelData, type PanelRow, type PanelSection } from "./types";

const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const unique = (a: string[]): string[] => [...new Set(a)].sort(cmp);
const ordered = (facts: Fact[]): Fact[] => [...new Map(facts.map(f => [f.id, f])).values()].sort((a,b) => cmp(a.subject,b.subject) || cmp(a.predicate,b.predicate) || cmp(a.id,b.id));
const owns = (root: string, subject: string): boolean => root === subject || subject.startsWith(root + "#");
const kindOf = (f: Fact): string => VOCABULARY[f.predicate as Predicate]?.class ?? "state";
function gap(what: string, value: typeof GAP_TEXTS[number]): PanelRow {
  return {what,value,basis:"unknown",status:"unverified",factIds:[],evidenceIds:[],gap:true};
}
function row(facts: Fact[], what?: string, value?: string): PanelRow {
  if (!facts.length) throw new PanelRejected("invalid-surface",null,["unresolved-fact"]);
  const fs=ordered(facts), f=fs[0], unknown=fs.some(f=>f.object === "unknown");
  const status=unknown || fs.some(f=>f.basis === "unknown") ? "unverified"
    : fs.some(f=>f.status === "conflicting") ? "conflicting"
    : fs.some(f=>f.status === "missing") ? "missing"
    : fs.some(f=>f.status === "unverified") ? "unverified" : "verified";
  return {what:what ?? factWhat(f),value:unknown ? "unknown" : value ?? factValue(f),
    basis:unique(fs.map(f=>f.basis)).join(", "),status,
    factIds:unique(fs.map(f=>f.id)),evidenceIds:unique(fs.flatMap(f=>f.evidenceIds)),gap:unknown,
    subject:f.subject,predicate:f.predicate};
}
/** Cache owned read copies for one projection batch; downstream query helpers only read them. */
export function createPanelReadStore(input:EvidenceStore):EvidenceStore {
  const snapshots=new Map<string,EvidenceSnapshot|undefined>(),facts=new Map<string,Fact[]>(),receipts=new Map<string,EvidenceReceipt|undefined>(),memberships=new Map<string,EvidenceSnapshot[]>();
  return {
    snapshot(id){if(!snapshots.has(id)) snapshots.set(id,input.snapshot(id));return snapshots.get(id);},
    factsFrom(id,subject){const key=JSON.stringify([id,subject]);if(!facts.has(key)) facts.set(key,input.factsFrom(id,subject));return facts.get(key)!;},
    receipt(id){if(!receipts.has(id)) receipts.set(id,input.receipt(id));return receipts.get(id);},
    snapshotsForReceipt(id){if(!memberships.has(id)) memberships.set(id,input.snapshotsForReceipt(id));return memberships.get(id)!;},
  };
}
export interface BuildPanelOptions { beforeSnapshotId?: string; registry?: readonly SubjectEntry[] }
/** The projection reads only the supplied store. Each row retains its original fact and receipt identities. */
export function buildPanel(inputStore: EvidenceStore, snapshotId: string, subject: string, opts: BuildPanelOptions = {}): PanelData {
  const store=createPanelReadStore(inputStore);
  const snapshot=store.snapshot(snapshotId), parsed=parseNearSubject(subject);
  if (!snapshot || !parsed || !snapshot.subjects.includes(subject)) throw new PanelRejected("missing-subject",subject);
  if (snapshot.chain !== "near" || snapshot.network !== "mainnet" ||
      snapshot.facts.some(f=>f.privacy !== "public") || snapshot.receipts.some(r=>r.privacy !== "public")) {
    throw new PanelRejected("invalid-document",subject);
  }
  const registry=opts.registry ?? NEAR_REGISTRY;
  const allFacts=new Map(snapshot.facts.map(f=>[f.id,f]));
  const receipts=new Map(snapshot.receipts.map(r=>[r.id,r]));
  const queries: QueryResult[]=[], reasons: QueryReason[]=[];
  const remember=(r:QueryResult) => { queries.push(r); reasons.push(...r.reasons); };
  const control=controlSurface(store,snapshotId,subject,snapshot.observedTo);
  control.results.forEach(remember);
  const controlFacts=ordered(control.results.flatMap(r=>r.facts));
  const controlRows: PanelRow[]=[];
  for (const f of controlFacts) {
    if (["role","role-admin"].includes(parseNearSubject(f.subject)?.kind ?? "")) continue;
    controlRows.push(row([f]));
  }
  for (const [role,members] of Object.entries(control.roles).sort(([a],[b])=>cmp(a,b))) {
    const fs=controlFacts.filter(f=>{
      const p=parseNearSubject(f.subject);
      return p?.account === parsed.account && (p.kind === "role" ? p.key : p.kind === "role-admin" ? "role-admin:" + p.key : null) === role && f.predicate === "holds-role";
    });
    if (fs.length) {
      const value=members.length ? members.map(s=>parseNearSubject(s)?.account ?? s).join(", ") : "none";
      const r=row(fs,"Role " + role,value); r.role=role; r.members=[...members]; controlRows.push(r);
    }
  }
  const deps=runQuery(store,{name:"dependencies",subject,relations:[...FOR_RELATIONS],
    scope:{snapshotId,asOf:snapshot.observedTo,maxHops:1,maxResults:500}});
  remember(deps);
  const reverse=ordered(snapshot.facts.filter(f=>f.object === subject));
  const state=ordered(snapshot.facts.filter(f=>owns(subject,f.subject) && kindOf(f) === "state" && f.predicate !== "proposal"));

  const proposalRows: PanelRow[]=[];
  for (const f of ordered(snapshot.facts.filter(f=>f.predicate === "proposal"))) {
    const p=decodeProposal(f,null,null,registry);
    if (p.status !== "InProgress") continue;
    const effects=reach(p,store,snapshotId,registry);
    const intersection=intersectFor(store,snapshotId,effects,subject);
    const d=p.decoded;
    const direct=p.daoSubject === subject || ("receiver_id" in d && "near:mainnet:" + d.receiver_id === subject);
    if (!direct && !intersection.hops.length) continue;
    reasons.push(...intersection.reasons);
    const supporting=intersection.hops.flatMap(h=>h.chainFactIds.map(id=>allFacts.get(id)).filter((f):f is Fact=>!!f));
    const r=row([f,...supporting],"Open proposal " + String(p.id) + " · " + p.status,f.object);
    proposalRows.push(r);
    if (d.kind === "unknown-kind") reasons.push({code:"missing-coverage",subject:p.proposalSubject,ref:f.id});
  }
  const changeRows: PanelRow[]=[];
  let comparison: PanelData["comparison"]=null;
  if (opts.beforeSnapshotId) {
    const before=store.snapshot(opts.beforeSnapshotId);
    if (!before || before.chain !== snapshot.chain || before.network !== snapshot.network ||
        before.facts.some(f=>f.privacy !== "public") || before.receipts.some(r=>r.privacy !== "public")) throw new PanelRejected("invalid-document",subject);
    for (const f of before.facts) allFacts.set(f.id,f);
    for (const r of before.receipts) receipts.set(r.id,r);
    comparison={beforeSnapshotId:before.id,afterSnapshotId:snapshotId,queries:[]};
    const subjects=unique([subject,...before.subjects.filter(s=>owns(subject,s)),...snapshot.subjects.filter(s=>owns(subject,s))]);
    for (const s of subjects) {
      const result=nearChanges(store,{name:"changes",subject:s,beforeSnapshotId:before.id,afterSnapshotId:snapshotId,maxResults:500});
      comparison.queries.push({subject:s,result}); reasons.push(...result.reasons);
      for (const c of result.changes) {
        const fs=[c.before,c.after].filter((f):f is Fact=>f !== null);
        const r=row(fs,c.kind + " · " + (c.after ?? c.before)!.predicate,c.after?.object ?? c.before!.object);
        r.change=structuredClone(c); changeRows.push(r);
      }
    }
    if (!changeRows.length) changeRows.push(gap("Changes","none read"));
  } else changeRows.push(gap("Changes","one capture only: nothing to compare"));

  const relations=ordered([...controlFacts,...deps.facts,...reverse].filter(f=>parseNearSubject(f.object) !== null));
  const section=(id:keyof typeof SECTION_TITLES,rows:PanelRow[],empty:typeof GAP_TEXTS[number]="none read"):PanelSection =>
    ({id,title:SECTION_TITLES[id],rows:rows.length ? rows : [gap(SECTION_TITLES[id],empty)]});
  const sections:PanelSection[]=[
    {id:"identity",title:SECTION_TITLES.identity,rows:[]},
    section("controls",controlRows),section("dependencies",deps.facts.map(f=>row([f]))),
    section("reverse",reverse.map(f=>row([f],f.subject+" · "+f.predicate,f.object))),section("state",state.map(f=>row([f]))),
    section("proposals",proposalRows,registry.find(e=>e.subject === subject)?.recipes.some(r=>r.kind === "sputnik-policy") ? "none read" : "not a DAO"),
    section("changes",changeRows),
  ];
  const usedIds=unique([...sections.flatMap(s=>s.rows.flatMap(r=>r.factIds)),...relations.map(f=>f.id)]);
  const facts=usedIds.map(id=>allFacts.get(id));
  if (facts.some(f=>!f)) throw new PanelRejected("invalid-surface",subject,["unresolved-fact"]);
  const usedFacts=ordered(facts as Fact[]);
  const evidenceIds=unique(usedFacts.flatMap(f=>f.evidenceIds));
  for (let i=0;i<evidenceIds.length;i+=500) {
    const q=runQuery(store,{name:"evidence",evidenceIds:evidenceIds.slice(i,i+500),maxResults:500});
    queries.push(q); reasons.push(...q.reasons);
  }
  const usedReceipts=evidenceIds.map(id=>receipts.get(id));
  if (usedReceipts.some(r=>!r || r.privacy !== "public")) throw new PanelRejected("invalid-surface",subject,["unresolved-evidence"]);
  const uniqueReasons=[...new Map(reasons.map(r=>[canonical(r),r])).entries()].sort(([a],[b])=>cmp(a,b)).map(([,r])=>r);
  const gaps:PanelRow[]=uniqueReasons.map(reason=>({...gap([reason.code,reason.subject,reason.ref].filter(x=>x !== null).join(" · "),"unknown"),reason:structuredClone(reason)}));
  if (!relations.length) gaps.push(gap("Relations","no relation recorded"));
  sections.push(section("gaps",gaps),section("receipts",usedFacts.map(f=>row([f]))));
  const heights=snapshot.receipts.flatMap(r=>r.observation.blockOrSlot === null ? [] : [BigInt(r.observation.blockOrSlot)]).sort((a,b)=>a < b ? -1 : a > b ? 1 : 0);
  return structuredClone({schema:"linchpin.near-panel/1",subject,account:parsed.account,kind:parsed.kind ?? "account",
    capture:{snapshotId,constructed:snapshot.constructed,label:snapshot.constructed ? "CONSTRUCTED" : "Recorded",
      fromBlockOrSlot:heights.length ? String(heights[0]) : null,toBlockOrSlot:heights.length ? String(heights.at(-1)) : null,
      capturedAt:snapshot.observedTo,observedFrom:snapshot.observedFrom,observedTo:snapshot.observedTo},
    sections,facts:usedFacts,receipts:usedReceipts as EvidenceReceipt[],relationFactIds:relations.map(f=>f.id),
    reasons:uniqueReasons,queries,comparison});
}

