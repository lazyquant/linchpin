import type { Fact } from '../../engine/contracts';
import { openStore, validateSnapshot } from '../../engine/queries/snapshot';
import { SUBJECT_PATTERN } from '../../engine/queries/request';
import { VOCABULARY, type Predicate } from '../../engine/queries/vocabulary';
import { canonical, sha256 } from '../../chain/evidence';
import { CORE_TYPES, PREDICATE_MECHANIC, checkVocabulary, type InfraLabel } from './schema';
import { BuildRejected, PROTOCOLS, seriesOf, type EvidenceInput, type ProtocolEntry } from './protocols';
export { BuildRejected } from './protocols';
export type Property = string | number | boolean | null | string[];
export interface NodeRecord { label: InfraLabel; kinds: string[]; id: string; props: Record<string, Property> }
export interface RelRecord { type: string; from: string; to: string; key: string; props: Record<string, Property> }
export interface EvidenceRecords { schemaVersion: 1; nodes: NodeRecord[]; relationships: RelRecord[] }
export function factKeyOf(fact: Fact): string { return `${fact.subject}|${fact.predicate}${VOCABULARY[fact.predicate as Predicate].cardinality === 'many' ? `|${fact.object}` : ''}`; }
const unique = (values: string[]) => [...new Set(values)].sort();
export function recordsSha256(records: EvidenceRecords): string { return sha256(canonical(records)); }
export function recordCounts(records: EvidenceRecords) {
  const labels: Record<string, number> = {}, types: Record<string, number> = {};
  for (const node of records.nodes) for (const label of [node.label,...node.kinds]) labels[label] = (labels[label] ?? 0) + 1;
  for (const rel of records.relationships) types[rel.type] = (types[rel.type] ?? 0) + 1;
  return { labels, types };
}
export function buildEvidenceRecords(inputs: EvidenceInput[], opts: {protocols?: ProtocolEntry[]; allowPrivate?: boolean} = {}): EvidenceRecords {
  checkVocabulary();
  const validated = inputs.map(input => ({...input, snapshot:validateSnapshot(input.snapshot)}));
  openStore(validated.map(input => input.snapshot));
  validated.sort((a,b) => {
    const x=a.snapshot,y=b.snapshot;
    return seriesOf(x.id).localeCompare(seriesOf(y.id)) || x.observedTo.localeCompare(y.observedTo) || (BigInt(x.toBlockOrSlot ?? '0') < BigInt(y.toBlockOrSlot ?? '0') ? -1 : BigInt(x.toBlockOrSlot ?? '0') > BigInt(y.toBlockOrSlot ?? '0') ? 1 : x.id.localeCompare(y.id));
  });
  if (!opts.allowPrivate && validated.some(({snapshot}) => snapshot.facts.some(f => f.privacy === 'private') || snapshot.receipts.some(r => r.privacy === 'private'))) throw new BuildRejected('private-input');
  const nodes = new Map<string, NodeRecord>(), relationships = new Map<string, RelRecord>();
  const node = (label: InfraLabel, id: string, props: Record<string, Property>) => {
    const value: NodeRecord = {label,id,kinds:[],props}; nodes.set(`${label}/${id}`,value); return value;
  };
  const rel = (type: string, from: string, to: string, props: Record<string, Property> = {}, key = `${type}|${from}|${to}`) => {
    const value = {type,from,to,key,props:{...props,key}}; relationships.set(`${type}/${key}`,value); return value;
  };
  const entity = (id: string) => {
    let result = nodes.get(`Entity/${id}`); if (result) return result;
    const [chain,network,...native] = id.split(':'); const parentId = id.includes('#') ? id.split('#')[0]! : undefined;
    result = node('Entity',id,{id,chain:chain!,network:network!,address:native.join(':').split('#')[0]!,schemaVersion:1,kindBasis:'decoded',kindFactIds:[],kindEvidenceIds:[],...(parentId ? {parentId} : {})}); return result;
  };
  const addKind = (id: string, kind: string, basis: string, facts: string[], evidence: string[], subkind?: string) => {
    const n = entity(id); n.kinds = unique([...n.kinds,kind]);
    n.props.kinds = n.kinds; if (basis === 'derived') n.props.kindBasis = basis;
    n.props.kindFactIds = unique([...(n.props.kindFactIds as string[]),...facts]);
    n.props.kindEvidenceIds = unique([...(n.props.kindEvidenceIds as string[]),...evidence]);
    if (subkind) n.props.subkind = subkind;
  };
  const newest = new Map<string,string>();
  for (const {snapshot:s} of validated) if (!s.constructed) newest.set(seriesOf(s.id),s.id);
  const projections = new Map<string,{type:string;from:string;to:string;role?:string;predicate:string;facts:NodeRecord[];conflict:boolean}>();
  for (const {snapshot:s,mechanics} of validated) {
    const {subjects,readers,names,receipts,facts,...scalars} = s;
    node('Snapshot',s.id,{...scalars,series:seriesOf(s.id),receiptIds:receipts.map(r=>r.id).sort()});
    for (const r of receipts) node('Receipt',r.id,{id:r.id,source:r.source,responseSha256:r.responseSha256,privacy:r.privacy,...r.observation});
    for (const id of subjects) {
      entity(id); const covering = readers.filter(r=>r.subjects.includes(id));
      rel('COVERS',s.id,id,{readers:covering.map(r=>r.id).sort(),readerStatuses:covering.map(r=>`${r.id}|${r.status}`).sort(),status:covering.some(r=>r.status==='failed') ? 'failed' : !covering.length || covering.some(r=>r.status==='partial') ? 'partial' : 'complete'});
    }
    const groups = new Map<string,Set<string>>();
    const survives = (f: Fact) => (f.validTo === null || f.validTo > s.observedTo) && (f.validFrom === null || f.validFrom <= s.observedTo) && f.evidenceIds.some(id => { const r = receipts.find(r => r.id === id)!; return r.observation.observedAt <= s.observedTo && (r.observation.historicalState === 'current-only' || (['pinned','constructed'].includes(r.observation.historicalState) && f.validFrom !== null)); });
    for (const f of facts.filter(survives)) { const key=factKeyOf(f); const group=groups.get(key) ?? new Set<string>();group.add(f.object);groups.set(key,group); }
    for (const f of facts) {
      entity(f.subject); const identity = SUBJECT_PATTERN.test(f.object); if (identity) entity(f.object);
      const evidence = f.evidenceIds.map(id=>receipts.find(r=>r.id===id)!);
      const blocks = evidence.flatMap(r=>r.observation.blockOrSlot === null ? [] : [r.observation.blockOrSlot]).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
      const mapping = Object.entries(CORE_TYPES).flatMap(([type,definition])=>definition.mappedFrom.filter(m=>m.predicate===f.predicate).map(m=>({type,...m})))[0];
      if (mapping && f.predicate==='holds-role' && new RegExp('^' + f.subject.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '#role(?:-admin)?:').test(f.object)) mapping.type='HAS_ROLE';
      const uid=`${s.id}/${f.id}`;
      const n = node('Fact',uid,{uid,id:f.id,snapshotId:s.id,subjectId:f.subject,predicate:f.predicate,...VOCABULARY[f.predicate as Predicate],field:`${f.subject}|${f.predicate}`,key:factKeyOf(f),basis:f.basis,status:f.status,privacy:f.privacy,evidenceIds:[...f.evidenceIds],path:[...f.path],validFrom:f.validFrom,validTo:f.validTo,...(identity?{objectId:f.object}:{objectValue:f.object}),blockOrSlot:blocks.at(-1)??null,asOf:evidence.map(r=>r.observation.observedAt).sort().at(-1)!,...(mapping?{coreType:mapping.type}:{})});
      rel('HAS_FACT',s.id,uid);rel('ABOUT',uid,f.subject);if(identity) rel('OBJECT',uid,f.object);
      for(const id of f.evidenceIds) rel('EVIDENCED_BY',uid,id);
      if(mapping && identity) {
        const key=sha256(`${mapping.type}|${f.subject}|${f.object}|${mapping.role??''}|${f.predicate}`);
        const p=projections.get(key)??{type:mapping.type,from:f.subject,to:f.object,role:mapping.role,predicate:f.predicate,facts:[],conflict:false};
        p.facts.push(n);p.conflict ||= survives(f) && (f.status==='conflicting' || (VOCABULARY[f.predicate as Predicate].cardinality==='one' && (groups.get(factKeyOf(f))?.size ?? 0)>1));projections.set(key,p);
      }
      if(s.chain==='near') {
        if(!f.subject.includes('#') && f.predicate==='has-code-hash' && f.object!=='none') addKind(f.subject,'Program','derived',[f.id],f.evidenceIds,'near.contract');
        if(!f.subject.includes('#') && ['vote-threshold','council-member'].includes(f.predicate)) addKind(f.subject,'Governance','derived',[f.id],f.evidenceIds,f.subject.endsWith('.sputnik-dao.near')?'sputnik.v2':undefined);
        for(const id of [f.subject,...(identity?[f.object]:[])]) {
          if(/#role(?:-admin)?:/.test(id)) addKind(id,'Role','derived',[f.id],f.evidenceIds);
          if(id.includes('#proposal:')) addKind(id,'Proposal','derived',[f.id],f.evidenceIds);
        }
      }
    }
    for(const e of mechanics?.entities??[]) {
      const kind = e.kind==='OracleSource'?'Oracle':e.kind==='Mint'?'Token':e.kind==='Authority'?(e.controllerType==='squads-v4-multisig'?'Multisig':null):e.kind;
      const subkinds:Record<string,string>={Vault:'kamino.kvault',Reserve:'klend.reserve',Market:'klend.market',OracleSource:'scope.oracle',Program:'solana.program',ProgramData:'solana.programdata',Mint:'spl.mint'};
      if(kind) addKind(e.id,kind,'decoded',[],e.evidenceIds,subkinds[e.kind]);
    }
  }
  // Constructed names may fill gaps, but never override a captured name.
  for(const {snapshot:s} of [...validated].sort((a,b)=>Number(b.snapshot.constructed)-Number(a.snapshot.constructed))) for(const [id,name] of Object.entries(s.names)) {
    const n=nodes.get(`Entity/${id}`);if(n) {n.props.name=name;n.props.nameSource=s.id;}
  }
  for(const [key,p] of projections) {
    p.facts.sort((a,b)=>a.id.localeCompare(b.id)); const props=p.facts.map(f=>f.props);
    const times=props.map(f=>f.asOf as string).sort();
    rel(p.type,p.from,p.to,{class:CORE_TYPES[p.type]!.class,predicate:p.predicate,...(p.role?{role:p.role}:{}),factIds:props.map(f=>f.id as string),factUids:p.facts.map(f=>f.id),snapshotIds:unique(props.map(f=>f.snapshotId as string)),bases:props.map(f=>f.basis as string),statuses:props.map(f=>f.status as string),conflict:p.conflict,firstObservedAt:times[0]!,lastObservedAt:times.at(-1)!,latest:props.some(f=>newest.get(seriesOf(f.snapshotId as string))===f.snapshotId)},key);
  }
  for(const p of opts.protocols??PROTOCOLS) {
    const scope=validated.filter(i=>seriesOf(i.snapshot.id)===p.series);if(!scope.length) continue;
    node('Protocol',p.id,{id:p.id,title:p.title,series:p.series,source:p.source});
    const members=p.memberRule==='snapshot-subjects'?unique(scope.flatMap(i=>i.snapshot.subjects)):p.members;
    for(const id of members) if(nodes.has(`Entity/${id}`)) rel('PART_OF',id,p.id,{source:p.source,scope:'registry'});
    for(const c of p.coverage) {
      if(c.status!=='not-mapped' && !scope.some(i=>i.snapshot.facts.some(f=>PREDICATE_MECHANIC[f.predicate]===c.mechanic))) throw new BuildRejected('unbacked-coverage');
      const id=`coverage:${p.id.replace(/^protocol:/,'')}:${p.series}:${c.mechanic}`;
      node('Coverage',id,{id,protocolId:p.id,series:p.series,...c});rel('HAS_COVERAGE',p.id,id);
    }
  }
  for(const n of nodes.values()) if(n.label==='Entity') n.props.kinds=n.kinds;
  return {schemaVersion:1,nodes:[...nodes.values()].sort((a,b)=>a.label.localeCompare(b.label)||a.id.localeCompare(b.id)),relationships:[...relationships.values()].sort((a,b)=>a.type.localeCompare(b.type)||a.key.localeCompare(b.key))};
}
