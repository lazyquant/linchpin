import { graphResult } from "../../ui/adapters";
import { generateFlowchartHtml, FlowchartError, type FlowchartInput } from "../../flowchart";
import { parseNearSubject } from "../reader/types";
import { PanelRejected, type PanelData } from "./types";

export function panelChartInput(data:PanelData):FlowchartInput {
  const facts=data.relationFactIds.map(id=>data.facts.find(f=>f.id === id));
  if (facts.some(f=>!f)) throw new PanelRejected("invalid-surface",data.subject,["unresolved-fact"]);
  const nodes=[...new Set([data.subject,...facts.flatMap(f=>[f!.subject,f!.object])])].sort().map(id=>({id,type:parseNearSubject(id)?.kind ?? "account",label:id}));
  const projected=graphResult(nodes,facts.filter(f=>!!f),{receipts:data.receipts,id:"relations"});
  if (projected.skipped.length) throw new PanelRejected("invalid-surface",data.subject,["unresolved-evidence"]);
  return {source:"evidence-graph",graph:{nodes,edges:projected.result.edges.map(e=>({
    from:e.from,to:e.to,type:e.relation,basis:e.bases[0],
    evidenceIds:[...e.factIds,...e.evidenceIds],
  }))}};
}
export function panelChart(data:PanelData):string {
  try {return generateFlowchartHtml(panelChartInput(data),(data.capture.constructed ? "CONSTRUCTED · " : "")+data.account+" · "+data.capture.snapshotId);}
  catch(error) {if(error instanceof FlowchartError) throw new PanelRejected("invalid-surface",data.subject,error.problems.map(p=>p.code));throw error;}
}

