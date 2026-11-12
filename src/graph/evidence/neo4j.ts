import { CORE_TYPES, INFRA_LABELS, KIND_LABELS } from './schema';
import type { EvidenceRecords } from './build';
import { validateEvidenceRecords } from './validate';
export interface EvidenceDriverLike { executeQuery(query: string, params?: Record<string, unknown>, config?: {database:string}): Promise<{records: {get(key:string): any}[]}> }
interface Statement { cypher:string; params:Record<string,unknown> }
export function evidenceLoadStatements(records: EvidenceRecords) {
  validateEvidenceRecords(records);
  const stmt=(cypher:string,params:Record<string,unknown>={}):Statement=>({cypher,params});
  const guard=[stmt('MATCH (n:Entity) WHERE n.schemaVersion IS NULL RETURN count(n) AS count'),stmt("SHOW CONSTRAINTS YIELD name WHERE name = 'entity_id' RETURN count(*) AS count")];
  const deletes=[...INFRA_LABELS.filter(l=>l!=='Entity'),'Entity'].map(l=>stmt(`MATCH (n:${l}) ${l==='Entity'?'WHERE n.schemaVersion IS NOT NULL ':''}WITH n LIMIT 1000 DETACH DELETE n RETURN count(*) AS count`));
  const constraints=INFRA_LABELS.map(l=>stmt(`CREATE CONSTRAINT eg_${l.toLowerCase()}_${l==='Fact'?'uid':'id'} IF NOT EXISTS FOR (n:${l}) REQUIRE n.${l==='Fact'?'uid':'id'} IS UNIQUE`));
  for(const [name,label,fields] of [['entity_address','Entity','address'],['fact_subject_snapshot','Fact','subjectId,snapshotId'],['fact_key','Fact','key'],['fact_field','Fact','field'],['fact_object','Fact','objectId'],['receipt_block','Receipt','blockOrSlot']]) constraints.push(stmt(`CREATE INDEX eg_${name} IF NOT EXISTS FOR (n:${label}) ON (${fields!.split(',').map(f=>`n.${f}`).join(', ')})`));
  constraints.push(stmt('CREATE FULLTEXT INDEX eg_names IF NOT EXISTS FOR (n:Entity|Protocol) ON EACH [n.name, n.address]'));
  const nodeBatches:Statement[]=[],relBatches:Statement[]=[];
  const groups=new Map<string,typeof records.nodes>();
  for(const n of [...records.nodes].sort((a,b)=>a.id.localeCompare(b.id))) {const label=[n.label,...n.kinds.slice().sort()].join(':');const g=groups.get(label)??[];g.push(n);groups.set(label,g);}
  for(const [label,nodes] of [...groups].sort()) for(let i=0;i<nodes.length;i+=500) {
    const slice=nodes.slice(i,i+500); const times=[...new Set(slice.flatMap(n=>Object.keys(n.props).filter(k=>/^(asOf|observedAt|retrievedAt|observedFrom|observedTo|freshUntil|validFrom|validTo)$/.test(k))))];
    const blocks=[...new Set(slice.flatMap(n=>Object.keys(n.props).filter(k=>/^(blockOrSlot|fromBlockOrSlot|toBlockOrSlot)$/.test(k))))];
    nodeBatches.push(stmt(`UNWIND $rows AS row MERGE (n:${label} {${slice[0]!.label==='Fact'?'uid':'id'}: row.id}) SET n += row.props${times.map(k=>` SET n.${k} = datetime(row.props.${k})`).join('')}${blocks.map(k=>` SET n.${k} = toInteger(row.props.${k})`).join('')}`,{rows:slice.map(n=>({id:n.id,props:n.props}))}));
  }
  const nodeById=new Map(records.nodes.map(n=>[n.id,n]));
  const rg=new Map<string,typeof records.relationships>();
  for(const r of [...records.relationships].sort((a,b)=>a.key.localeCompare(b.key))) {const a=nodeById.get(r.from)!,b=nodeById.get(r.to)!;const gkey=`${r.type}|${a.label}|${b.label}`;const g=rg.get(gkey)??[];g.push(r);rg.set(gkey,g);}
  for(const [key,rels] of [...rg].sort()) {const [type,a,b]=key.split('|');for(let i=0;i<rels.length;i+=500) relBatches.push(stmt(`UNWIND $rows AS row MATCH (a:${a} {${a==='Fact'?'uid':'id'}: row.from}), (b:${b} {${b==='Fact'?'uid':'id'}: row.to}) MERGE (a)-[r:${type} {key: row.key}]->(b) SET r += row.props`,{rows:rels.slice(i,i+500)}));}
  return {guard,deletes,constraints,nodeBatches,relBatches};
}
export function graphTypeCypher(_schema?:unknown) {return `CREATE GRAPH TYPE evidence IF NOT EXISTS { ${[...INFRA_LABELS,...KIND_LABELS].map(l=>`(:${l})`).join(', ')}, ${Object.keys(CORE_TYPES).map(t=>`(:Entity)-[:${t}]->(:Entity)`).join(', ')} }`;}
export async function loadEvidenceGraph(driver:EvidenceDriverLike,records:EvidenceRecords,opts:{database:string;enforceGraphType?:boolean;log?:(s:string)=>void}) {
  const statements=evidenceLoadStatements(records);const run=(s:Statement)=>driver.executeQuery(s.cypher,s.params,{database:opts.database});
  for(const s of statements.guard) if(Number((await run(s)).records[0]?.get('count')??0)>0) throw new Error('Run bun run scripts/load-neo4j.ts before loading evidence');
  for(const s of statements.deletes) while(Number((await run(s)).records[0]?.get('count')??0)>0) {}
  for(const s of statements.constraints) await run(s);
  if(opts.enforceGraphType) {const edition=(await driver.executeQuery('CALL dbms.components() YIELD edition RETURN edition',{}, {database:opts.database})).records[0]?.get('edition'); if(edition && edition!=='community') await driver.executeQuery(graphTypeCypher(),{}, {database:opts.database});else opts.log?.('Graph type skipped: community edition');} else opts.log?.('Graph type skipped: enforcement not requested');
  for(const s of [...statements.nodeBatches,...statements.relBatches]) await run(s);
}
