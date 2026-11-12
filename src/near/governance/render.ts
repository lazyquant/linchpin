import type { Fact } from "../../engine/contracts";
import type { GovernanceReport } from "./types";
export { SENTENCE_TEMPLATES } from "./review";
export function renderGovernanceJson(report:GovernanceReport):string {return JSON.stringify(report,null,1)+"\n";}
const cell=(value:unknown):string=>String(value ?? "unknown").replaceAll("|","\\|").replace(/[\r\n]/g," ");
export function renderGovernanceMarkdown(r:GovernanceReport):string {
  const refs=new Map(r.receipts.map((receipt,i)=>[receipt.id,`[^r${i+1}]`]));
  const cite=(ids:string[])=>[...new Set(ids)].map(id=>refs.get(id) ?? "").join("");
  const fact=(f:Fact)=>`- ${f.id} · ${f.subject} · ${f.predicate} · ${cell(f.object)} · ${f.basis} · ${f.status} ${cite(f.evidenceIds)}`;
  const host=r.receipts[0]?.source.split(":")[1] ?? "unknown";
  const lines=[`# Governance review: ${r.dao} ${r.mode === "open" ? "open proposals" : r.proposals.length ? `#${r.proposals[0].decoded.id}` : "proposal"}`,"",`Snapshot: ${r.snapshotId} · blocks ${r.observation.fromBlockOrSlot}–${r.observation.toBlockOrSlot} · host ${host} · constructed: ${r.constructed ? "yes":"no"} · as of ${r.observation.observedTo}`,"","## Proposals",""];
  if(r.mode === "open") {
    lines.push("| id | kind | receiver · method | effect class | needed / approved (role, total) | expires (UTC) | state |","| --- | --- | --- | --- | --- | --- | --- |");
    for(const p of r.proposals) {const d=p.decoded.decoded;lines.push(`| ${p.decoded.id} | ${d.kind} | ${"receiver_id" in d ? cell(d.receiver_id):"—"}${d.kind === "FunctionCall" ? ` · ${d.actions.map(a=>cell(a.method_name)).join(", ")}`:""} | ${p.effect.effectClass} | ${p.math.needed ?? "unknown"} / ${p.math.approved ?? "unknown"} (${p.math.role ?? "unknown"}, ${p.math.totalMembers ?? "unknown"}) | ${p.expiry?.expiresAt ?? "unknown"} | ${p.expiry?.state ?? "unknown"}${r.constructed ? " · constructed":""} ${cite(p.decoded.evidenceIds)} |`);}
    lines.push("");
  }
  if(!r.proposals.length) lines.push(r.mode === "open" ? "No InProgress proposals in this snapshot." : "No recorded proposal for this request.","");
  for(const p of r.proposals) {
    const d=p.decoded, detail=d.decoded, c=cite(d.evidenceIds), pc=p.expiry ? cite([p.expiry.policyReceiptId]) : "";
    lines.push(`### Proposal ${d.id}`,"",`Decoded: ${detail.kind} · status ${d.status} · proposer ${cell(d.proposer)} · fact ${d.factId} ${c}`,"");
    if(detail.kind === "FunctionCall") {lines.push(`Receiver: ${cell(detail.receiver_id)} ${c}`,"");for(const a of detail.actions) lines.push(`Method: ${cell(a.method_name)} · argsFormat: ${a.argsFormat} · deposit ${a.deposit} · gas ${a.gas} ${c}`,"","```json",JSON.stringify(a.args,null,2),"```","");}
    else lines.push("```json",JSON.stringify(detail,null,2),"```",`Decoded source: ${d.factId} ${c}`,"");
    if(d.policyComparedWith) lines.push(`Policy diff compared with the policy read at block ${d.policyComparedWith.block ?? "unknown"}; for an executed proposal this is the policy after it. ${cite([d.policyComparedWith.receiptId])}`,"");
    lines.push(`Effect class: ${p.effect.effectClass} · rule ${p.effect.ruleId} ${c}`,"",`Execution: role ${p.math.role ?? "unknown"} · permission ${p.math.kindPermission ?? "unknown"} · needed ${p.math.needed ?? "unknown"} of ${p.math.totalMembers ?? "unknown"} · approve ${p.math.approved ?? "unknown"} / reject ${p.math.rejected ?? "unknown"} / remove ${p.math.removed ?? "unknown"} · executesOn ${p.math.executesOn ?? "null"} ${c}${pc}`,`Remaining members: ${p.math.remainingMembers.join(", ") || "none"} ${c}${pc}`,`Flags: ${p.math.flags.join(", ") || "none"} ${c}${pc}`,"");
    for(const role of p.math.roles) lines.push(`- ${role.role} · ${role.kindPermission} · threshold source ${role.policySource} · ${role.weightKind} · threshold ${JSON.stringify(role.threshold)} · quorum ${role.quorum} · needed ${role.needed ?? "unknown"} of ${role.totalMembers ?? "unknown"} · counts ${role.approved ?? "unknown"}/${role.rejected ?? "unknown"}/${role.removed ?? "unknown"} · remaining ${role.remainingMembers.join(", ") || "none"} ${c}${pc}`);
    if(p.expiry) lines.push("",`Expiry: submitted ${p.expiry.submittedAt} · period ${p.expiry.proposalPeriodNs} ns · expires ${p.expiry.expiresAt} · read block ${p.expiry.readBlock} at ${p.expiry.readAt} · ${p.expiry.state}${p.expiry.constructed ? " · constructed":""} ${c}${pc}`);
    lines.push("","Reach:",...p.reach.map(fact));if(!p.reach.length) lines.push("No derived reach facts.");
    lines.push("","What this DAO controls (as read):",...p.daoControls.map(fact));if(!p.daoControls.length) lines.push("No control facts recorded.");
    if(p.intersection) {const i=p.intersection;lines.push("",`Against ${i.forSubject}:`);if(!i.hops.length) lines.push(`No hop of ${i.forSubject}'s dependency chain (${i.reachable} subjects, snapshot ${i.snapshotId}) is touched by this proposal.`);else for(const h of i.hops) lines.push(`- hop ${h.hop} · ${h.subject} · ${h.predicate} · ${h.reachFactId} ${cite(p.reach.find(f=>f.id===h.reachFactId)!.evidenceIds)}`);}
    if(d.argAccounts.length) lines.push("",`Arguments name registry subjects: ${d.argAccounts.join(", ")} ${c}`);
    for(const s of p.sentences) lines.push("",`${s.text} (facts: ${s.factIds.join(", ")})`);
    lines.push("");
  }
  lines.push("## Changes to governance itself","","| at | kind | source |","| --- | --- | --- |");
  for(const e of r.governance.history) lines.push(`| ${e.at} | ${e.kind} | ${e.source.subject} · ${e.source.id} · ${e.fact.id} ${cite(e.fact.evidenceIds)} |`);
  if(r.governance.beforeSnapshotId) { lines.push("",`Comparison: ${r.governance.beforeSnapshotId} → ${r.governance.afterSnapshotId}`,"","| field | before | after |","| --- | --- | --- |");for(const s of r.governance.summary) lines.push(`| ${s.field} | ${cell(s.before)} | ${cell(s.after)} ${cite((r.supportingFacts ?? []).filter(f=>f.predicate === (s.field === "council-size" ? "council-member":s.field)).flatMap(f=>f.evidenceIds))} |`);for(const change of r.governance.changes) {lines.push("",`Change: ${change.kind}`);if(change.before) lines.push("Before:",fact(change.before));if(change.after) lines.push("After:",fact(change.after));}}
  else lines.push("","One live snapshot; a comparison pair is not recorded.");
  if(r.supportingFacts?.length) lines.push("", "Supporting evidence:", ...r.supportingFacts.map(fact));
  lines.push("","## Unknowns and reasons","");
  for(const reason of r.reasons) lines.push(`- ${reason.code} · ${reason.subject ?? "—"} · ${reason.ref ?? "—"} ${cite(r.supportingFacts?.find(f=>f.id === reason.ref)?.evidenceIds ?? [])}`);
  if(!r.reasons.length) lines.push("None recorded.");
  lines.push("","## Receipts","");
  for(const receipt of r.receipts) {const o=receipt.observation;lines.push(`${refs.get(receipt.id)}: ${receipt.id} · ${receipt.source} · block ${o.blockOrSlot ?? "unknown"} · ${o.blockHash ?? "unknown"} · response sha256 ${receipt.responseSha256} · retrieved ${o.retrievedAt} · ${o.historicalState}`);}
  return lines.join("\n")+"\n";
}
