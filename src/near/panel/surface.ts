import { factsToResult } from "../../ui/adapters";
import { instantiate } from "../../ui/templates";
import { validateSurface } from "../../ui/validate";
import { standalonePage } from "../../ui/page";
import type { A2uiMessage, ResultRow, ResultSet, ResolveEvidence } from "../../ui/types";
import { PanelRejected, type PanelData, type PanelRow } from "./types";

export function panelEvidenceResolver(data: PanelData): ResolveEvidence {
  const available=new Set(data.receipts.filter(r=>r.privacy === "public").map(r=>r.id));
  return ids=>({missing:ids.filter(id=>!available.has(id))});
}
function resultRow(data:PanelData,r:PanelRow,key:string,scope:string):ResultRow {
  const facts=r.factIds.map(id=>data.facts.find(f=>f.id === id));
  if (facts.some(f=>!f) || (!r.gap && !facts.length)) throw new PanelRejected("invalid-surface",data.subject,["unresolved-fact"]);
  const ids=[...new Set(facts.flatMap(f=>f!.evidenceIds))].sort();
  if (JSON.stringify(ids) !== JSON.stringify([...r.evidenceIds].sort())) throw new PanelRejected("invalid-surface",data.subject,["unresolved-evidence"]);
  const resolved=r.evidenceIds.map(id=>data.receipts.find(e=>e.id === id));
  if (resolved.some(e=>!e)) throw new PanelRejected("invalid-surface",data.subject,["unresolved-evidence"]);
  const mapped=factsToResult(facts.filter(f=>!!f),resolved.filter(e=>!!e),{id:"row",shape:"table",snapshotIds:[data.capture.snapshotId]});
  if (mapped.skipped.length) throw new PanelRejected("invalid-surface",data.subject,["unresolved-evidence"]);
  const blocks=resolved.flatMap(e=>e!.observation.blockOrSlot === null ? [] : [e!.observation.blockOrSlot!]);
  const block=blocks.reduce<string|null>((a,b)=>a === null || BigInt(b)>BigInt(a) ? b : a,null);
  const times=resolved.map(e=>e!.observation.observedAt).sort();
  const base:ResultRow={
    rowKind:r.factIds.length ? (r.gap ? "unknown" : "fact") : "scope",key,
    values:{what:r.what,value:r.value,status:r.status},factIds:[...r.factIds],
    bases:[...new Set(mapped.result.rows.flatMap(r=>r.bases))].sort(),evidenceIds:[...r.evidenceIds],
    blockOrSlot:block,asOf:times.at(-1) ?? null,snapshotIds:[data.capture.snapshotId],
  };
  if (!r.factIds.length) base.scopeSource=data.capture.snapshotId + " · " + scope;
  return base;
}
/** Values stay in bound rows; headers, chips and all styling belong to the shared kit. */
export function panelSurface(data:PanelData):A2uiMessage[] {
  const results:ResultSet[]=data.sections.filter(s=>s.id !== "identity").map(section=>{
    const rows=section.rows.map((r,i)=>resultRow(data,r,section.id+"-"+i,section.title));
    const columns:ResultSet["columns"]=[{name:"what",role:section.id === "gaps" ? "value" : "label"},{name:"value",role:"value"},{name:"status",role:"status"}];
    if (section.id === "receipts") {
      columns.push({name:"source",role:"note"},{name:"observed",role:"time"});
      rows.forEach((r,i)=>{
        const receipts=section.rows[i].evidenceIds.map(id=>data.receipts.find(e=>e.id === id)!);
        r.values.source=[...new Set(receipts.map(e=>e.source))].sort().join(", ");
        r.values.observed=[...new Set(receipts.map(e=>e.observation.observedAt))].sort().join(", ");
      });
    }
    return {resultId:section.id,shape:"table",columns,rows,
      coverage:section.rows.some(r=>r.gap) ? "partial" : "mapped",
      coverageNotes:section.rows.some(r=>r.gap && (r.value === "unknown" || r.value === "none read")) ? ["Capture scope; unresolved items are shown in the rows."] : [],
      truncated:false};
  });
  const messages=instantiate("subject-panel",{surfaceId:"near-panel",meta:{
    title:data.account,subjectId:data.subject,kind:data.kind,snapshotIds:[data.capture.snapshotId],
    fromBlockOrSlot:data.capture.fromBlockOrSlot,toBlockOrSlot:data.capture.toBlockOrSlot,
    capturedAt:data.capture.capturedAt,constructed:data.capture.constructed,
  },results,titles:Object.fromEntries(data.sections.map(s=>[s.id,s.title]))});
  const result=validateSurface(messages,{resolveEvidence:panelEvidenceResolver(data)});
  if (!result.ok) throw new PanelRejected("invalid-surface",data.subject,result.codes);
  return messages;
}
export function panelKitPage(data:PanelData,messages:unknown=panelSurface(data),resolveEvidence:ResolveEvidence=panelEvidenceResolver(data)):string {
  const result=validateSurface(messages,{resolveEvidence});
  if (!result.ok) throw new PanelRejected("invalid-surface",data.subject,result.codes);
  return standalonePage(messages,{title:data.account + " · captured public facts",lang:"en",resolveEvidence});
}

