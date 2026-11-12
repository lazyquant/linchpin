import { canonical, sha256 } from '../../chain/evidence';
import { buildEvidenceRecords } from './build';
import { collectSlice1Inputs } from './protocols';
import { EVIDENCE_TEMPLATES, runEvidenceLocal, templateParameters, type EvidenceRow } from './templates';
import { validateTemplateParameters } from './parameters';
import { loadEvidenceGraph, type EvidenceDriverLike } from './neo4j';
import type { CliDependencies } from './cli';

export function normalizeRows(rows: EvidenceRow[]): EvidenceRow[] {
  const normalize = (value: any, key = ''): any => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value.map(v=>normalize(v));
    if (typeof value === 'object') {
      if ('low' in value && 'high' in value) return /blockOrSlot/i.test(key) ? value.toString() : Number(value.toString());
      if ('year' in value && 'month' in value) return new Date(value.toString()).toISOString();
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,k)]));
    }
    return value;
  };
  return rows.map(r=>normalize(r)).sort((a,b)=>{const x=canonical(a),y=canonical(b);return x<y?-1:x>y?1:0;});
}
export async function runEvidenceNeo4j(driver: EvidenceDriverLike, id: string, params: Record<string, unknown>, database='neo4j'): Promise<EvidenceRow[]> {
  validateTemplateParameters(id,params);
  const template=EVIDENCE_TEMPLATES.find(t=>t.id===id);
  if(!template?.cypher) throw new Error(`Template Cypher unavailable: ${id}`);
  const result=await driver.executeQuery(template.cypher,templateParameters(params),{database});
  if (!result.records.length) {
    const scopedIds = id==='control'||id==='dependencies' ? [(params.scope as any).snapshotId] : id==='changes' ? [params.beforeSnapshotId,params.afterSnapshotId] : [];
    const fallback=await driver.executeQuery(`MATCH (c:Coverage) WHERE ($protocolId IS NULL OR c.protocolId=$protocolId) AND ($series IS NULL OR c.series=$series) AND (size($ids)=0 OR EXISTS {MATCH (s:Snapshot) WHERE s.id IN $ids AND s.series=c.series}) AND (NOT EXISTS {MATCH (:Entity {id:$subject})-[:PART_OF]->(:Protocol)} OR EXISTS {MATCH (:Entity {id:$subject})-[:PART_OF]->(p:Protocol) WHERE p.id=c.protocolId}) RETURN c{.*,rowKind:'coverage'} AS row`,{protocolId:null,series:null,subject:null,...params,ids:scopedIds},{database});
    return normalizeRows(fallback.records.length?fallback.records.map(r=>r.get('row')):[{rowKind:'coverage',protocolId:null,series:null,mechanic:id,status:'not-mapped',note:'no snapshot in scope'}]);
  }
  if (['evidence','shared-controllers','exposure'].includes(id)) {
    const rows=normalizeRows(result.records.map(r=>r.get('row')));
    for(const row of rows) {
      if(id==='evidence') delete row.id;
      else {
        for(const key of ['evidenceIds','snapshotIds','subjectIds','protocolIds','types','roles']) if(Array.isArray(row[key])) row[key]=[...new Set(row[key] as string[])].sort();
        row.key=sha256((row.factIds as string[]).join('|'));
      }
    }
    return normalizeRows(rows);
  }
  if (['control','dependencies','changes'].includes(id)) {
    const rows = normalizeRows(result.records.map(record => record.get('row')));
    for (const row of rows) {
      delete row.usable;
      delete row.expired;
      const path = row.path as string[];
      if (path.length) {
        const facts = path.map(id => rows.find(r => r.factId === id)!);
        row.factIds = path; row.bases = facts.map(f => f.basis); row.statuses = facts.map(f => f.status);
        row.evidenceIds = [...new Set(facts.flatMap(f => f.evidenceIds as string[]))].sort();
        row.snapshotIds = [...new Set(facts.map(f => f.snapshotId))].sort(); row.key = sha256(path.join('|'));
      }
    }
    return normalizeRows(rows);
  }
  return normalizeRows(result.records.map(record=>Object.fromEntries(template.columns.map(column=>[column,record.get(column)]))));
}
export async function parityMain(args: string[], env: Record<string,string|undefined>, deps: CliDependencies): Promise<number> {
  try {
    if(args.length && (args.length!==2 || args[0]!=='--requests')) {deps.err('Expected --requests <path>');return 2;}
    const uri=env.NEO4J_URI,password=env.NEO4J_PASSWORD;
    if(!uri||!password) {deps.err('Neo4j configuration missing');return 2;}
    const url=new URL(uri);
    if(!['bolt:','neo4j:','bolt+s:','bolt+ssc:','neo4j+s:','neo4j+ssc:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
      deps.err('Parity requires loopback Neo4j');return 2;
    }
    const requests: unknown=JSON.parse(deps.readText(args[1]??'tests/fixtures/evidence-graph-model/requests.json'));
    if(!Array.isArray(requests)||!requests.length) throw new Error('Invalid requests');
    for(const request of requests) {
      if(!request||typeof request.id!=='string'||typeof request.template!=='string') throw new Error('Invalid request');
      validateTemplateParameters(request.template,request.params);
    }
    // Refuse an incomplete implementation before destructive loading.
    const unavailable=EVIDENCE_TEMPLATES.filter(t=>!t.cypher && requests.some(r=>r.template===t.id)).map(t=>t.id);
    if(unavailable.length) {deps.err(`Parity unavailable: ${unavailable.join(', ')}`);return 1;}
    const records=buildEvidenceRecords(collectSlice1Inputs());
    const config={uri,password,username:env.NEO4J_USERNAME??'neo4j',database:env.NEO4J_DATABASE??'neo4j'};
    const driver=deps.createDriver(config);
    try {
      await loadEvidenceGraph(driver,records,{database:config.database,log:deps.out});
      let equal=true;
      for(const request of requests) {
        const local=normalizeRows(runEvidenceLocal(records,request.template,request.params).rows);
        const remote=await runEvidenceNeo4j(driver,request.template,request.params,config.database);
        const matches=canonical(local)===canonical(remote);equal&&=matches;
        if (!matches && env.EVIDENCE_PARITY_DEBUG === '1') deps.out(JSON.stringify({local,remote}));
        deps.out(`${request.template} ${request.id} neo4j=${remote.length} local=${local.length} ${matches?'equal':'differs'}`);
      }
      return equal?0:1;
    } finally {await driver.close();}
  } catch {deps.err('Evidence parity failed; connection details redacted');return 1;}
}
