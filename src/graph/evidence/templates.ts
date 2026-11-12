import { validateTemplateParameters } from './parameters';
import type { Fact, FactChange, QueryRequest, QueryResult, ReasonCode } from "../../engine/contracts";
import { canonical, sha256 } from "../../chain/evidence";
import { parseQueryRequest, SUBJECT_PATTERN } from "../../engine/queries/request";
import type { EvidenceSnapshot, EvidenceStore } from "../../engine/queries/snapshot";
import { VOCABULARY, type Predicate } from "../../engine/queries/vocabulary";

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const edgeOrder = (a: Fact, b: Fact) => cmp(a.predicate, b.predicate) || cmp(a.object, b.object) || cmp(a.id, b.id);
const factOrder = (a: Fact, b: Fact) => (a.path.length || 1) - (b.path.length || 1)
  || cmp(a.subject, b.subject) || edgeOrder(a, b) || cmp(canonical(a), canonical(b));
const factKey = (f: Fact) => `${f.subject}|${f.predicate}${VOCABULARY[f.predicate as Predicate].cardinality === "many" ? `|${f.object}` : ""}`;
const semantic = (f: Fact) => canonical({ object: f.object, status: f.status, basis: f.basis });

class Answer {
  readonly result: QueryResult = { outcome: "unknown", facts: [], receipts: [], unknowns: [], conflicts: [], truncated: false, snapshotIds: [], reasons: [], observations: [], changes: [] };
  constructor(readonly store: EvidenceStore) {}
  reason(code: ReasonCode, subject: string | null = null, ref: string | null = null) {
    this.result.reasons.push({ code, subject, ref });
  }
  observe(s: EvidenceSnapshot, asOf: string | null) {
    this.result.snapshotIds.push(s.id);
    this.result.observations.push({ snapshotId: s.id, chain: s.chain, network: s.network, constructed: s.constructed,
      observedFrom: s.observedFrom, observedTo: s.observedTo, fromBlockOrSlot: s.fromBlockOrSlot,
      toBlockOrSlot: s.toBlockOrSlot, freshUntil: s.freshUntil, asOf });
  }
  readers(s: EvidenceSnapshot, subject: string): boolean {
    const incomplete = s.readers.filter(r => r.subjects.includes(subject) && r.status !== "complete");
    for (const r of incomplete) this.reason("partial-reader", subject, r.id);
    return incomplete.length > 0;
  }
  truncate(subject: string) { this.result.truncated = true; this.reason("truncated", subject); }
  /** Conflicts are evaluated within one snapshot, never between the two sides of a change. */
  conflicts(facts: Fact[]): Fact[] {
    const objects = new Map<string, Set<string>>();
    for (const f of facts) {
      if (VOCABULARY[f.predicate as Predicate].cardinality !== "one") continue;
      const k = factKey(f), values = objects.get(k) ?? new Set<string>(); values.add(f.object); objects.set(k, values);
    }
    return facts.map(f => {
      const key = factKey(f);
      if (f.status === "conflicting" || (objects.get(key)?.size ?? 0) > 1) {
        this.result.conflicts.push(key); this.reason("conflict", f.subject, key);
        return { ...f, status: "conflicting" };
      }
      return f;
    });
  }
  quality(f: Fact) {
    if (f.object === "unknown" && VOCABULARY[f.predicate as Predicate].class === "control") this.reason("unknown-controller", f.subject, f.id);
    else if (f.object === "unknown" || f.basis === "unknown" || f.status === "unverified") this.reason("missing-coverage", f.subject, f.id);
    if (f.status === "missing") this.reason("missing-evidence", f.subject, f.id);
  }
  temporal(f: Fact, asOf: string): boolean {
    const at = Date.parse(asOf);
    if (f.validTo !== null && Date.parse(f.validTo) <= at) { this.reason("expired", f.subject, f.id); return false; }
    if (f.validFrom !== null && Date.parse(f.validFrom) > at) { this.reason("missing-history", f.subject, f.id); return false; }
    const permitted = f.evidenceIds.some(id => {
      const r = this.store.receipt(id);
      if (!r) { this.reason("missing-evidence", f.subject, id); return false; }
      const o = r.observation;
      if (Date.parse(o.observedAt) > at) return false;
      return o.historicalState === "current-only" || (o.historicalState === "pinned" || o.historicalState === "constructed") && f.validFrom !== null;
    });
    if (!permitted) this.reason("missing-history", f.subject, f.id);
    return permitted;
  }
  finish(evidence = false, subject: string | null = null): QueryResult {
    const r = this.result;
    r.facts = [...new Map(r.facts.map(f => [canonical(f), f])).values()].sort(factOrder);
    for (const f of r.facts) {
      this.quality(f);
      for (const id of f.evidenceIds) {
        const receipt = this.store.receipt(id);
        if (receipt) r.receipts.push(receipt); else this.reason("missing-evidence", f.subject, id);
      }
    }
    r.receipts = [...new Map(r.receipts.map(receipt => [receipt.id, receipt])).values()].sort((a, b) => cmp(a.id, b.id));
    const nonempty = evidence ? r.receipts.length > 0 : r.facts.length > 0;
    if (!nonempty && !r.reasons.some(reason => ["missing-subject", "missing-coverage", "incompatible-snapshots", "missing-evidence"].includes(reason.code))) this.reason("no-facts", subject);
    r.reasons = [...new Map(r.reasons.map(reason => [canonical(reason), reason])).values()].sort((a, b) => cmp(a.code, b.code) || cmp(a.subject ?? "", b.subject ?? "") || cmp(a.ref ?? "", b.ref ?? ""));
    r.unknowns = [...new Set(r.reasons.flatMap(reason => {
      const refersToEvidenceOrFact = ["missing-evidence", "missing-history", "expired", "unknown-controller"].includes(reason.code)
        || r.facts.some(f => f.id === reason.ref);
      return [reason.subject, refersToEvidenceOrFact ? reason.ref : null].filter((s): s is string => s !== null);
    }))].sort(cmp);
    r.conflicts = [...new Set(r.conflicts)].sort(cmp);
    r.snapshotIds = [...new Set(r.snapshotIds)].sort(cmp);
    r.observations = [...new Map(r.observations.map(o => [canonical(o), o])).values()].sort((a, b) => cmp(a.snapshotId, b.snapshotId));
    r.changes.sort((a, b) => cmp(a.key, b.key) || cmp(a.kind, b.kind) || cmp(canonical(a), canonical(b)));
    r.outcome = !nonempty ? "unknown" : r.reasons.length || r.truncated ? "partial" : "complete";
    return r;
  }
}

function scoped(answer: Answer, request: Extract<QueryRequest, { name: "dependencies" | "control" }>): EvidenceSnapshot | undefined {
  const s = answer.store.snapshot(request.scope.snapshotId);
  answer.result.snapshotIds.push(request.scope.snapshotId);
  if (!s) { answer.reason("missing-coverage", request.subject, request.scope.snapshotId); return; }
  answer.observe(s, request.scope.asOf);
  if (!s.subjects.includes(request.subject)) { answer.reason("missing-subject", request.subject, s.id); return; }
  if (Date.parse(request.scope.asOf) > Date.parse(s.freshUntil)) answer.reason("stale", request.subject, s.id);
  answer.readers(s, request.subject);
  return s;
}
function dependencies(answer: Answer, request: Extract<QueryRequest, { name: "dependencies" }>) {
  const s = scoped(answer, request); if (!s) return;
  const queue = [{ subject: request.subject, depth: 0, path: [] as string[] }];
  const visited = new Set([request.subject]);
  const seenFacts = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (!s.subjects.includes(node.subject)) { answer.reason("missing-subject", node.subject, s.id); continue; }
    answer.readers(s, node.subject);
    const facts = answer.conflicts(answer.store.factsFrom(s.id, node.subject)
      .filter(f => request.relations.includes(f.predicate) && answer.temporal(f, request.scope.asOf))).sort(edgeOrder);
    for (const f of facts) {
      if (node.depth === request.scope.maxHops) { answer.truncate(request.subject); continue; }
      if (seenFacts.has(f.id)) continue;
      if (answer.result.facts.length === request.scope.maxResults) { answer.truncate(request.subject); return; }
      seenFacts.add(f.id);
      const path = [...node.path, f.id];
      answer.result.facts.push({ ...f, path: node.depth === 0 ? [] : path });
      if (SUBJECT_PATTERN.test(f.object) && !visited.has(f.object)) {
        visited.add(f.object); queue.push({ subject: f.object, depth: node.depth + 1, path });
      }
    }
  }
}
function control(answer: Answer, request: Extract<QueryRequest, { name: "control" }>) {
  const s = scoped(answer, request); if (!s) return;
  const facts = answer.conflicts(answer.store.factsFrom(s.id, request.subject)
    .filter(f => VOCABULARY[f.predicate as Predicate].class === "control" && answer.temporal(f, request.scope.asOf))).sort(factOrder);
  answer.result.facts = facts.slice(0, request.scope.maxResults);
  if (facts.length > request.scope.maxResults) answer.truncate(request.subject);
}
function group(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) { const key = factKey(f), bucket = groups.get(key) ?? []; bucket.push(f); groups.set(key, bucket); }
  for (const bucket of groups.values()) bucket.sort(factOrder);
  return groups;
}
function changes(answer: Answer, request: Extract<QueryRequest, { name: "changes" }>) {
  const before = answer.store.snapshot(request.beforeSnapshotId), after = answer.store.snapshot(request.afterSnapshotId);
  answer.result.snapshotIds.push(request.beforeSnapshotId, request.afterSnapshotId);
  if (before) answer.observe(before, null); if (after) answer.observe(after, null);
  if (!before || !after) { answer.reason("missing-coverage", request.subject); return; }
  if (before.chain !== after.chain || before.network !== after.network) { answer.reason("incompatible-snapshots", request.subject); return; }
  if (!before.subjects.includes(request.subject) || !after.subjects.includes(request.subject)) { answer.reason("missing-coverage", request.subject); return; }
  const beforePartial = answer.readers(before, request.subject), afterPartial = answer.readers(after, request.subject);
  // Compare each capture at its own boundary; never infer an earlier state from today's receipt.
  const read = (s: EvidenceSnapshot) => {
    if (Date.parse(s.observedTo) > Date.parse(s.freshUntil)) answer.reason("stale", request.subject, s.id);
    const all = answer.conflicts(answer.store.factsFrom(s.id, request.subject));
    const usable = all.filter(f => answer.temporal(f, s.observedTo));
    return { all, usable };
  };
  const bf = read(before), af = read(after), bg = group(bf.usable), ag = group(af.usable);
  answer.result.facts = [...new Map([...bf.all, ...af.all].map(f => [canonical(f), f])).values()].sort(factOrder);
  for (const key of [...new Set([...bg.keys(), ...ag.keys()])].sort(cmp)) {
    const b = bg.get(key) ?? [], a = ag.get(key) ?? [];
    // Ambiguous assertions cannot be collapsed to an arbitrarily selected controller/change.
    const bs = new Set(b.map(semantic)), as = new Set(a.map(semantic));
    if (bs.size > 1 || as.size > 1) { answer.reason("missing-coverage", request.subject, key); continue; }
    const b0 = b[0] ?? null, a0 = a[0] ?? null;
    let change: FactChange | undefined;
    if (!b0 && a0 && !beforePartial) change = { kind: "added", key, before: null, after: a0 };
    else if (b0 && !a0 && !afterPartial) change = { kind: "removed", key, before: b0, after: null };
    else if (b0 && a0 && semantic(b0) !== semantic(a0)) change = { kind: "changed", key, before: b0, after: a0 };
    // Missing temporal/evidential coverage is not an observed addition/removal either.
    if (change && (change.kind === "added" || change.kind === "removed")) {
      const missing = change.kind === "added" ? before : after;
      if (answer.store.factsFrom(missing.id, request.subject).some(f => factKey(f) === key)) {
        answer.reason("missing-coverage", request.subject, key); continue;
      }
    }
    if (change) answer.result.changes.push(change);
  }
  if (answer.result.facts.length > request.maxResults || answer.result.changes.length > request.maxResults) {
    answer.truncate(request.subject);
    answer.result.facts = answer.result.facts.slice(0, request.maxResults);
    const returned = new Set(answer.result.facts.map(canonical));
    answer.result.changes = answer.result.changes.filter(c => (!c.before || returned.has(canonical(c.before))) && (!c.after || returned.has(canonical(c.after)))).slice(0, request.maxResults);
  }
}
function evidence(answer: Answer, request: Extract<QueryRequest, { name: "evidence" }>) {
  for (const id of [...request.evidenceIds].sort(cmp)) {
    const receipt = answer.store.receipt(id);
    if (!receipt) { answer.reason("missing-evidence", null, id); continue; }
    answer.result.receipts.push(receipt);
    const snapshots = answer.store.snapshotsForReceipt(id);
    if (!snapshots.length) answer.reason("missing-coverage", null, id);
    for (const s of snapshots) answer.observe(s, null);
  }
}

import type { EvidenceReceipt } from '../../engine/contracts';
import type { EvidenceRecords } from './build';
export type EvidenceRow = Record<string, unknown>;

/** Reconstruct only the storage indexes, from persisted graph properties. No engine execution. */
function recordStore(records: EvidenceRecords): EvidenceStore {
  const receipts = new Map<string, EvidenceReceipt>();
  for (const n of records.nodes.filter(n => n.label === 'Receipt')) {
    const {id, source, responseSha256, privacy, ...observation} = n.props;
    receipts.set(n.id, {id, source, responseSha256, privacy, observation} as unknown as EvidenceReceipt);
  }
  const snapshots = new Map<string, EvidenceSnapshot>();
  for (const n of records.nodes.filter(n => n.label === 'Snapshot')) {
    const covers = records.relationships.filter(r => r.type === 'COVERS' && r.from === n.id);
    const facts = records.nodes.filter(f => f.label === 'Fact' && f.props.snapshotId === n.id).map(n => {
      const p = n.props;
      return {uid:p.uid,snapshotId:p.snapshotId,id:p.id,subject:p.subjectId,predicate:p.predicate,object:p.objectId ?? p.objectValue,basis:p.basis,status:p.status,privacy:p.privacy,evidenceIds:p.evidenceIds,path:p.path,validFrom:p.validFrom,validTo:p.validTo} as Fact;
    });
    const ids = new Set(n.props.receiptIds as string[] ?? facts.flatMap(f => f.evidenceIds));
    snapshots.set(n.id, {...n.props,version:1,subjects:covers.map(r=>r.to),names:{},facts,receipts:[...ids].map(id=>receipts.get(id)!),readers:covers.flatMap(r=>(r.props.readerStatuses as string[] ?? []).map(value=>{const [id,status]=value.split('|');return {id,status,subjects:[r.to]};}))} as EvidenceSnapshot);
  }
  return {snapshot:id=>snapshots.get(id),receipt:id=>receipts.get(id),factsFrom:(id,subject)=>snapshots.get(id)?.facts.filter(f=>f.subject===subject)??[],snapshotsForReceipt:id=>[...snapshots.values()].filter(s=>s.receipts.some(r=>r.id===id))};
}

export function runEvidenceLocal(records: EvidenceRecords, id: string, params: Record<string, unknown>) {
  validateTemplateParameters(id, params);
  const store = recordStore(records), answer = new Answer(store);
  const routes = new Map<string,{hop:number;viaFactIds:string[]}>();
  let rows: EvidenceRow[] = [];
  if (['control','dependencies','changes','evidence'].includes(id)) {
    const request = parseQueryRequest({...params,name:id});
    if (request.name === 'control') {
      const queue = [{subject:request.subject,hop:1,viaFactIds:[] as string[]}], visited = new Set<string>();
      for (const node of queue) {
        if(visited.has(node.subject)) continue; visited.add(node.subject);
        const part = new Answer(store); control(part,{...request,subject:node.subject});
        for(const f of part.result.facts) {
          if(!routes.has(f.id)) routes.set(f.id,{hop:node.hop,viaFactIds:node.viaFactIds});
          if(node.hop<request.scope.maxHops && SUBJECT_PATTERN.test(f.object)) queue.push({subject:f.object,hop:node.hop+1,viaFactIds:[...node.viaFactIds,f.id]});
        }
        answer.result.facts.push(...part.result.facts); answer.result.reasons.push(...part.result.reasons);
        answer.result.conflicts.push(...part.result.conflicts); answer.result.observations.push(...part.result.observations);answer.result.snapshotIds.push(...part.result.snapshotIds);answer.result.truncated ||= part.result.truncated;
      }
    } else if(request.name==='dependencies') dependencies(answer,request);
    else if(request.name==='changes') changes(answer,request);
    else evidence(answer,request);
    answer.finish(id==='evidence','subject' in request?request.subject:null);
    rows = answer.result.facts.map(f=>{
      const n = records.nodes.find(n=>n.label==='Fact' && n.props.uid===(f as Fact & {uid:string}).uid)!;
      const rowAnswer = new Answer(store);
      const snapshotId = String(n.props.snapshotId);
      rowAnswer.temporal(f, id === 'changes' ? store.snapshot(snapshotId)!.observedTo : (params.scope as {asOf:string}).asOf);
      rowAnswer.quality(f);
      const reason = rowAnswer.result.reasons.filter(r=>r.ref===f.id).map(r=>r.code).sort(cmp)[0] ?? null;
      const change=answer.result.changes.find(c=>canonical(c.after??c.before)===canonical(f));
      const pathFacts=f.path.map(id=>answer.result.facts.find(f=>f.id===id)!);
      return {objectId:null,objectValue:null,...n.props,rowKind:id==='changes'?'fact':['unknown','none'].includes(f.object)?'unknown':f.path.length?'path':'fact',factId:f.id,status:f.status,path:f.path,reason,...(id==='control'?routes.get(f.id):{}),...(f.path.length?{factIds:f.path,bases:pathFacts.map(f=>f.basis),statuses:pathFacts.map(f=>f.status),evidenceIds:[...new Set(pathFacts.flatMap(f=>f.evidenceIds))].sort(),snapshotIds:[...new Set(pathFacts.map(f=>records.nodes.find(n=>n.label==='Fact'&&n.props.uid===(f as Fact & {uid:string}).uid)?.props.snapshotId))].sort(),key:sha256(f.path.join('|'))}:{}),...(id==='changes'?{changeKind:change?.kind??null,changeKey:change?.key??null,beforeFactId:change?.before?.id??null,afterFactId:change?.after?.id??null}:{})};
    });
    if(id==='evidence') rows=answer.result.receipts.map(r=>({rowKind:'receipt',receiptId:r.id,source:r.source,responseSha256:r.responseSha256,privacy:r.privacy,...r.observation,snapshotIds:store.snapshotsForReceipt(r.id).map(s=>s.id).sort()}));
  } else if(id==='entity-resolve') {
    rows=records.nodes.filter(n=>n.label==='Entity' && (n.id===params.text||n.props.address===params.text||String(n.props.name??'').toLowerCase().includes(String(params.text).toLowerCase())) && (!params.protocolId||records.relationships.some(r=>r.type==='PART_OF'&&r.from===n.id&&r.to===params.protocolId))).sort((a,b)=>cmp(a.id,b.id)).slice(0,Number(params.limit)).map(n=>({rowKind:'scope',entityId:n.id,protocolId:params.protocolId??null,source:n.props.nameSource??null,kinds:n.kinds,name:n.props.name??null,nameSource:n.props.nameSource??null}));
   } else if(id==='shared-controllers' || id==='exposure') {
    const snapshots=records.nodes.filter(n=>n.label==='Snapshot');
    const selected = Array.isArray(params.snapshotIds) ? params.snapshotIds as string[] : [...new Set(snapshots.map(n=>n.props.series))].flatMap(series=>snapshots.filter(n=>n.props.series===series&&!n.props.constructed).sort((a,b)=>cmp(String(b.props.observedTo),String(a.props.observedTo))||cmp(b.id,a.id)).slice(0,1).map(n=>n.id));
    const edges=records.nodes.filter(n=>n.label==='Fact' && selected.includes(String(n.props.snapshotId)) && n.props.objectId && n.props.coreType && n.props.class===(id==='exposure'?'dependency':'control'));
    const pathRow=(facts:typeof edges)=>({rowKind:'path',factIds:facts.map(f=>f.props.id),bases:facts.map(f=>f.props.basis),statuses:facts.map(f=>f.props.status),evidenceIds:[...new Set(facts.flatMap(f=>f.props.evidenceIds as string[]))].sort(),snapshotIds:[...new Set(facts.map(f=>f.props.snapshotId))].sort(),key:sha256(facts.map(f=>f.props.id).join('|'))});
    if(id==='shared-controllers') {
      for(const controllerId of [...new Set(edges.map(f=>String(f.props.objectId)))].sort()) {
        const facts=edges.filter(f=>f.props.objectId===controllerId && (!params.protocolId||records.relationships.some(r=>r.type==='PART_OF'&&r.from===f.props.subjectId&&r.to===params.protocolId)));
        const subjectIds=[...new Set(facts.map(f=>String(f.props.subjectId)))].sort();
        if(subjectIds.length<Number(params.minSubjects??2)) continue;
        rows.push({...pathRow(facts),controllerId,subjectIds,subjectCount:subjectIds.length,protocolIds:[...new Set(records.relationships.filter(r=>r.type==='PART_OF'&&subjectIds.includes(r.from)).map(r=>r.to))].sort(),types:[...new Set(facts.map(f=>f.props.coreType))].sort(),roles:[...new Set(records.relationships.filter(r=>r.to===controllerId&&subjectIds.includes(r.from)&&r.props.role).map(r=>r.props.role))].sort()});
      }
    } else {
      const queue=[{subject:String(params.subject),facts:[] as typeof edges}],visited=new Set([String(params.subject)]);
      for(const node of queue) {
        if(node.facts.length>=Number(params.maxHops)) continue;
        const candidates=edges.filter(f=>f.props.objectId===node.subject).map(f=>({subject:String(f.props.subjectId),facts:[f,...node.facts]})).sort((a,b)=>cmp(a.facts.map(f=>f.props.id).sort().join('|'),b.facts.map(f=>f.props.id).sort().join('|')));
        for(const candidate of candidates) if(!visited.has(candidate.subject)) {visited.add(candidate.subject);queue.push(candidate);rows.push({...pathRow(candidate.facts),dependentId:candidate.subject,hop:candidate.facts.length});}
      }
    }
  } else if(id!=='coverage') throw new Error(`Unknown template: ${id}`);
  if(!rows.length) {
    const scopedIds=answer.result.snapshotIds;
    const series=new Set(records.nodes.filter(n=>n.label==='Snapshot'&&scopedIds.includes(n.id)).map(n=>n.props.series));
    const memberProtocols=records.relationships.filter(r=>r.type==='PART_OF'&&r.from===params.subject).map(r=>r.to);
    rows=records.nodes.filter(n=>n.label==='Coverage'&&(!params.protocolId||n.props.protocolId===params.protocolId)&&(!params.series||n.props.series===params.series)&&(!scopedIds.length||series.has(n.props.series))&&(!memberProtocols.length||memberProtocols.includes(String(n.props.protocolId)))).map(n=>({rowKind:'coverage',...n.props}));
  }
  if(!rows.length) rows=[{rowKind:'coverage',protocolId:null,series:null,mechanic:id,status:'not-mapped',note:'no snapshot in scope'}];
  return {...answer.result,rows};
}

// Fixed Cypher fragments only; request values are always parameters.
const temporal = `(f.validTo IS NULL OR f.validTo > at) AND (f.validFrom IS NULL OR f.validFrom <= at) AND EXISTS { MATCH (f)-[:EVIDENCED_BY]->(r:Receipt) WHERE r.observedAt <= at AND (r.historicalState = 'current-only' OR (r.historicalState IN ['pinned','constructed'] AND f.validFrom IS NOT NULL)) }`;
// Row reason is the lexically first engine reason referring to this snapshot-scoped
// fact: expired, missing-coverage, missing-evidence, missing-history, unknown-controller.
// Quality reasons coexist with temporal reasons; missing evidence outranks unknown controller.
const quality = `CASE WHEN f.expired THEN 'expired' WHEN (coalesce(f.objectValue = 'unknown', false) AND f.class <> 'control') OR (NOT (coalesce(f.objectValue = 'unknown', false) AND f.class = 'control') AND (f.basis = 'unknown' OR f.status = 'unverified')) THEN 'missing-coverage' WHEN f.status = 'missing' THEN 'missing-evidence' WHEN NOT f.usable THEN 'missing-history' WHEN coalesce(f.objectValue = 'unknown', false) AND f.class = 'control' THEN 'unknown-controller' ELSE null END`;
// Conflict marking mirrors the engine (src/engine/queries/run.ts): control and dependencies mark
// conflicts among facts that pass the temporal filter; changes marks them over every fact of each
// snapshot before the filter (run.ts changes(): conflicts(factsFrom(...)) then temporal). Review R12.
const collectFactsWith = (prefilter: boolean) => `MATCH (e:Entity)<-[:ABOUT]-(f:Fact) WHERE f.snapshotId IN ids
WITH f, CASE WHEN $scope IS NULL THEN head([(snap:Snapshot)-[:HAS_FACT]->(f) | snap.observedTo]) ELSE datetime($scope.asOf) END AS at
WITH f, (f.validTo IS NOT NULL AND f.validTo <= at) AS expired, ${temporal} AS usable
ORDER BY f.subjectId, f.predicate, coalesce(f.objectId,f.objectValue), f.id
WITH collect(f{.*, objectId:f.objectId, objectValue:f.objectValue, validFrom:f.validFrom, validTo:f.validTo, blockOrSlot:f.blockOrSlot, usable:usable, expired:expired}) AS raw
WITH [f IN raw | f{.*, status: CASE WHEN ${prefilter ? '' : 'f.usable AND '}f.cardinality = 'one' AND any(g IN raw WHERE ${prefilter ? '' : 'g.usable AND '}g.snapshotId=f.snapshotId AND g.key=f.key AND coalesce(g.objectId,g.objectValue)<>coalesce(f.objectId,f.objectValue)) THEN 'conflicting' ELSE f.status END}] AS facts`;
const collectFacts = collectFactsWith(false);
const collectFactsChanges = collectFactsWith(true);
export function traversalCypher(control: boolean): string {
 return `WITH [$scope.snapshotId] AS ids
${collectFacts}
WITH [f IN facts WHERE f.usable AND ${control ? "f.class = 'control'" : 'f.predicate IN $relations'}] AS facts
WITH facts, reduce(st={queue:[{subject:$subject, path:[]}], visited:[$subject], rows:[]}, step IN range(0,size(facts)) |
 CASE WHEN step >= size(st.queue) THEN st ELSE
 reduce(acc=st, f IN [f IN facts WHERE f.subjectId=st.queue[step].subject AND size(st.queue[step].path)<$scope.maxHops]${control ? '[0..$scope.maxResults]' : ''} |
 CASE WHEN ${control ? 'false' : 'size(acc.rows)>=$scope.maxResults'} THEN acc ELSE
 {queue:acc.queue + CASE WHEN f.objectId IS NOT NULL AND NOT f.objectId IN acc.visited THEN [{subject:f.objectId,path:st.queue[step].path+[f.id]}] ELSE [] END,
 visited:acc.visited + CASE WHEN f.objectId IS NOT NULL AND NOT f.objectId IN acc.visited THEN [f.objectId] ELSE [] END,
 rows:acc.rows + [f{.*, path:${control ? 'f.path' : 'CASE WHEN size(st.queue[step].path)=0 THEN [] ELSE st.queue[step].path+[f.id] END'}, ${control ? 'hop:size(st.queue[step].path)+1, viaFactIds:st.queue[step].path,' : ''} factId:f.id, reason:${quality}, rowKind:CASE WHEN f.objectValue IN ['unknown','none'] THEN 'unknown' WHEN ${control ? 'size(f.path)' : 'size(st.queue[step].path)'}>0 THEN 'path' ELSE 'fact' END}]} END) END) AS result
UNWIND result.rows AS row
RETURN row`;
}
export const changesCypher = `WITH [$beforeSnapshotId,$afterSnapshotId] AS ids
${collectFactsChanges}
MATCH (b:Snapshot {id:$beforeSnapshotId})-[bc:COVERS]->(e:Entity {id:$subject})<- [ac:COVERS]-(a:Snapshot {id:$afterSnapshotId})
WHERE b.chain=a.chain AND b.network=a.network
WITH facts,b,a,bc,ac
UNWIND [f IN facts WHERE f.subjectId=$subject] AS f
WITH facts,b,a,bc,ac,f ORDER BY f.subjectId,f.predicate,coalesce(f.objectId,f.objectValue),f.id,f.snapshotId
WITH facts,b,a,bc,ac,collect(f) AS ordered
UNWIND ordered[0..$maxResults] AS f
WITH facts,b,a,bc,ac,f,
 [g IN facts WHERE g.key=f.key AND g.snapshotId=b.id AND g.usable] AS before,
 [g IN facts WHERE g.key=f.key AND g.snapshotId=a.id AND g.usable] AS after
WITH facts,f, before, after,bc,ac,head(before) AS bf,head(after) AS af
WITH f,bf,af, CASE
 WHEN size(before)=0 AND size(after)=1 AND none(g IN facts WHERE g.key=f.key AND g.snapshotId=$beforeSnapshotId) AND none(s IN bc.readerStatuses WHERE NOT s ENDS WITH '|complete') THEN 'added'
 WHEN size(after)=0 AND size(before)=1 AND none(g IN facts WHERE g.key=f.key AND g.snapshotId=$afterSnapshotId) AND none(s IN ac.readerStatuses WHERE NOT s ENDS WITH '|complete') THEN 'removed'
 WHEN size(before)=1 AND size(after)=1 AND (coalesce(bf.objectId,bf.objectValue)<>coalesce(af.objectId,af.objectValue) OR bf.status<>af.status OR bf.basis<>af.basis) THEN 'changed'
 ELSE null END AS kind
WITH f,bf,af,CASE WHEN f.uid=coalesce(af.uid,bf.uid) THEN kind ELSE null END AS kind
RETURN f{.*,factId:f.id,rowKind:'fact',reason:${quality},changeKind:kind,changeKey:CASE WHEN kind IS NOT NULL THEN f.key ELSE null END,beforeFactId:CASE WHEN kind IS NOT NULL THEN bf.id ELSE null END,afterFactId:CASE WHEN kind IS NOT NULL THEN af.id ELSE null END} AS row`;

const selectedFacts = `MATCH (s:Snapshot)
WHERE ($snapshotIds IS NOT NULL AND s.id IN $snapshotIds) OR ($snapshotIds IS NULL AND NOT s.constructed AND NOT EXISTS { MATCH (newer:Snapshot) WHERE newer.series=s.series AND NOT newer.constructed AND (newer.observedTo>s.observedTo OR (newer.observedTo=s.observedTo AND newer.id>s.id)) })
MATCH (s)-[:HAS_FACT]->(f:Fact) WHERE f.objectId IS NOT NULL AND f.coreType IS NOT NULL
WITH f ORDER BY f.uid
WITH collect(f{.*}) AS facts`;
const evidenceCypher = `MATCH (r:Receipt) WHERE r.id IN $evidenceIds
CALL (r) { MATCH (s:Snapshot) WHERE r.id IN s.receiptIds WITH s ORDER BY s.id RETURN collect(s.id) AS snapshotIds }
RETURN r{.*, id:null, receiptId:r.id, blockHash:r.blockHash, blockOrSlot:r.blockOrSlot, rowKind:'receipt', snapshotIds:snapshotIds} AS row`;
const sharedCypher = `${selectedFacts}
UNWIND [f IN facts WHERE f.class='control'] AS f
MATCH (e:Entity {id:f.subjectId})
WHERE $protocolId IS NULL OR EXISTS { MATCH (e)-[:PART_OF]->(p:Protocol {id:$protocolId}) }
WITH f.objectId AS controllerId, collect(f) AS fs, collect(DISTINCT f.subjectId) AS subjects
WHERE size(subjects)>=coalesce($minSubjects,2)
CALL (subjects) { UNWIND subjects AS subject MATCH (:Entity {id:subject})-[:PART_OF]->(p:Protocol) RETURN collect(DISTINCT p.id) AS protocols }
CALL (subjects,controllerId) { MATCH (e:Entity)-[r]->(:Entity {id:controllerId}) WHERE e.id IN subjects AND r.role IS NOT NULL RETURN collect(DISTINCT r.role) AS roles }
RETURN {rowKind:'path', factIds:[f IN fs|f.id], bases:[f IN fs|f.basis],statuses:[f IN fs|f.status],evidenceIds:reduce(a=[],f IN fs|a+f.evidenceIds),snapshotIds:[f IN fs|f.snapshotId], controllerId:controllerId, subjectIds:subjects,subjectCount:size(subjects),protocolIds:protocols,types:[f IN fs|f.coreType],roles:roles} AS row`;
const exposureCypher = `${selectedFacts.replace('ORDER BY f.uid', 'ORDER BY f.id, f.uid')}
WITH [f IN facts WHERE f.class='dependency'] AS facts
WITH facts, reduce(st={queue:[{subject:$subject,fs:[]}],visited:[$subject],rows:[]},step IN range(0,size(facts)) |
CASE WHEN step>=size(st.queue) THEN st ELSE
reduce(acc=st,f IN [f IN facts WHERE f.objectId=st.queue[step].subject AND size(st.queue[step].fs)<$maxHops] |
CASE WHEN f.subjectId IN acc.visited THEN acc ELSE {queue:acc.queue+[{subject:f.subjectId,fs:[f]+st.queue[step].fs}],visited:acc.visited+[f.subjectId],rows:acc.rows+[{subject:f.subjectId,fs:[f]+st.queue[step].fs}]} END) END) AS result
UNWIND result.rows AS item
RETURN {rowKind:'path',factIds:[f IN item.fs|f.id],bases:[f IN item.fs|f.basis],statuses:[f IN item.fs|f.status],evidenceIds:reduce(a=[],f IN item.fs|a+f.evidenceIds),snapshotIds:[f IN item.fs|f.snapshotId],dependentId:item.subject,hop:size(item.fs)} AS row`;

const stringSchema={type:'string'};
const bounded={type:'integer',minimum:1,maximum:500};
const scopeSchema={type:'object',additionalProperties:false,required:['snapshotId','asOf','maxHops','maxResults'],properties:{snapshotId:stringSchema,asOf:{type:'string',format:'date-time'},maxHops:{type:'integer',minimum:1,maximum:8},maxResults:bounded}};
const schemas:Record<string,Record<string,unknown>>={
  'entity-resolve':{text:stringSchema,protocolId:stringSchema,limit:bounded},
  control:{subject:stringSchema,scope:scopeSchema},dependencies:{subject:stringSchema,scope:scopeSchema,relations:{type:'array',items:stringSchema,minItems:1,maxItems:16,uniqueItems:true}},
  changes:{subject:stringSchema,beforeSnapshotId:stringSchema,afterSnapshotId:stringSchema,maxResults:bounded},evidence:{evidenceIds:{type:'array',items:stringSchema,minItems:1,maxItems:500,uniqueItems:true},maxResults:bounded},
  'shared-controllers':{protocolId:stringSchema,snapshotIds:{type:'array',items:stringSchema},minSubjects:{type:'integer',minimum:1,default:2}},exposure:{subject:stringSchema,maxHops:{type:'integer',minimum:1,maximum:8},snapshotIds:{type:'array',items:stringSchema}},coverage:{protocolId:stringSchema,series:stringSchema},
};
const required:Record<string,string[]>={'entity-resolve':['text','limit'],control:['subject','scope'],dependencies:['subject','scope','relations'],changes:['subject','beforeSnapshotId','afterSnapshotId','maxResults'],evidence:['evidenceIds','maxResults'],'shared-controllers':[],exposure:['subject','maxHops'],coverage:[]};
const questions:Record<string,string>={'entity-resolve':'Which recorded entities match this identifier or name?',control:'Who can control this entity?',dependencies:'What does this entity depend on?',changes:'What changed between these observations?',evidence:'Which receipts support these assertions?','shared-controllers':'Which controllers control multiple subjects?',exposure:'Which entities depend on this subject?',coverage:'Which mechanics have recorded coverage?'};
const factColumns=['rowKind','factId','uid','key','subjectId','predicate','objectId','objectValue','basis','status','evidenceIds','blockOrSlot','asOf','snapshotId','path','reason'];
// Fixed templates; request values are supplied as parameters.

// Review finding R3 (run 038). The raw Cypher is published, but it is not the whole
// template: the supported call is runEvidenceNeo4j(driver, id, params), which validates
// the parameters, fills every Cypher parameter (templateParameters) and applies the
// post-processing below. Neo4j Community has no sha256 without APOC, so row keys
// cannot be computed in Cypher. A caller of the raw Cypher must pass cypherParams and
// apply postProcessing exactly.
const CYPHER_PARAM_DEFAULTS: Record<string, null> = { protocolId: null, series: null, scope: null, snapshotIds: null, minSubjects: null };
function cypherParamsOf(cypher: string): Record<string, { default: null | 'required' }> {
  const names = [...new Set([...cypher.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]!))].sort();
  return Object.fromEntries(names.map(n => [n, { default: n in CYPHER_PARAM_DEFAULTS ? null : 'required' as const }]));
}
/** Every parameter the template's Cypher references: validated params plus null defaults. */
export function templateParameters(params: Record<string, unknown>): Record<string, unknown> {
  return { ...CYPHER_PARAM_DEFAULTS, ...params };
}
const FALLBACK = 'When the query returns no rows, return the coverage rows of the asked scope (protocolId, series and the snapshots in scope; spec G11), or one not-mapped coverage row when no snapshot is in scope.';
const POST_PROCESSING: Record<string, string[]> = {
  'entity-resolve': ['Normalise Neo4j integers and temporals; sort rows canonically.', FALLBACK],
  coverage: ['Normalise Neo4j integers and temporals; sort rows canonically.', FALLBACK],
  evidence: ['Drop the internal id column.', 'Normalise and sort rows canonically.', FALLBACK],
  'shared-controllers': ['Deduplicate and sort evidenceIds, snapshotIds, subjectIds, protocolIds, types and roles.', 'key = sha256(factIds joined by "|").', 'Normalise and sort rows canonically.', FALLBACK],
  exposure: ['Deduplicate and sort evidenceIds and snapshotIds.', 'key = sha256(factIds joined by "|").', 'Normalise and sort rows canonically.', FALLBACK],
  control: ['Drop the internal columns usable and expired.', 'For a row with a non-empty path: factIds = path; bases and statuses from the rows of those fact ids in the same result; evidenceIds and snapshotIds as their sorted union; key = sha256(path joined by "|").', 'Normalise and sort rows canonically.', FALLBACK],
  dependencies: ['Drop the internal columns usable and expired.', 'For a row with a non-empty path: factIds = path; bases and statuses from the rows of those fact ids in the same result; evidenceIds and snapshotIds as their sorted union; key = sha256(path joined by "|").', 'Normalise and sort rows canonically.', FALLBACK],
  changes: ['Drop the internal columns usable and expired.', 'For a row with a non-empty path: as for control.', 'Normalise and sort rows canonically.', FALLBACK],
};
export const EVIDENCE_TEMPLATES=Object.keys(schemas).map(id=>({id,question:questions[id]!,params:{type:'object',additionalProperties:false,required:required[id]!,properties:schemas[id]!},cypher:id==='control'?traversalCypher(true):id==='dependencies'?traversalCypher(false):id==='changes'?changesCypher:id==='entity-resolve'?"MATCH (e:Entity) WHERE (e.id = $text OR e.address = $text OR toLower(coalesce(e.name, '')) CONTAINS toLower($text)) AND ($protocolId IS NULL OR EXISTS { MATCH (e)-[:PART_OF]->(p:Protocol) WHERE p.id = $protocolId }) RETURN 'scope' AS rowKind, e.id AS entityId, $protocolId AS protocolId, e.nameSource AS source, e.kinds AS kinds, e.name AS name, e.nameSource AS nameSource ORDER BY entityId LIMIT toInteger($limit)":id==='coverage'?'MATCH (c:Coverage) WHERE ($protocolId IS NULL OR c.protocolId = $protocolId) AND ($series IS NULL OR c.series = $series) RETURN c.id AS id, \'coverage\' AS rowKind, c.protocolId AS protocolId, c.series AS series, c.mechanic AS mechanic, c.status AS status, c.note AS note ORDER BY protocolId, series, mechanic':id==='evidence'?evidenceCypher:id==='shared-controllers'?sharedCypher:exposureCypher,columns:id==='entity-resolve'?['rowKind','entityId','protocolId','source','kinds','name','nameSource']:id==='coverage'?['id','rowKind','protocolId','series','mechanic','status','note']:['shared-controllers','exposure'].includes(id)?['rowKind','factIds','bases','statuses','evidenceIds','snapshotIds','key',...(id==='exposure'?['dependentId','hop']:['controllerId','subjectIds','subjectCount','protocolIds','types','roles'])]:id==='evidence'?['rowKind','receiptId','source','responseSha256','chain','network','blockOrSlot','blockHash','observedAt','retrievedAt','historicalState','privacy','snapshotIds']:[...factColumns,...(id==='changes'?['changeKind','changeKey','beforeFactId','afterFactId']:id==='control'?['hop','viaFactIds']:[])],limits:'Cannot establish unobserved historical state, completeness of a partial reader, or execution beyond recorded evidence.',twin:'runEvidenceLocal',entryPoint:'runEvidenceNeo4j',postProcessing:POST_PROCESSING[id]!})).map(t=>({...t,cypherParams:cypherParamsOf(t.cypher)}));
