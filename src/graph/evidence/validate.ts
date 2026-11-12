import { RELATIONSHIP_CONTRACTS, CORE_TYPES, INFRA_LABELS, KIND_LABELS, EVIDENCE_TYPES, checkVocabulary, generateSchema } from './schema';
import type { EvidenceRecords } from './build';
import { isTime } from '../../engine/queries/request';
export class RecordsRejected extends Error { constructor(readonly code: string) { super(`Records rejected: ${code}`); } }
export function validateEvidenceRecords(records: EvidenceRecords, schema: ReturnType<typeof generateSchema> = generateSchema()): void {
  checkVocabulary();
  const fail = (code: string): never => { throw new RecordsRejected(code); };
  if (JSON.stringify(schema ?? {}).includes('"reversed":true')) fail('reversed-mapping');
  if(records.schemaVersion !== 1) fail('wrong-type');
  const ids = new Set<string>(), keys = new Set<string>();
  for(const n of records.nodes) {
    if(!(INFRA_LABELS as readonly string[]).includes(n.label)) fail('unknown-label');
    if(n.kinds.some(k=>!(KIND_LABELS as readonly string[]).includes(k))) fail('unknown-kind');
    if(!n.id || !n.props[n.label==='Fact'?'uid':'id']) fail('missing-property');
    for(const [key,type] of Object.entries(schema.labels[n.label]!.required)) {
      if(!Object.hasOwn(n.props,key)) fail('missing-property');
      const value=n.props[key];
      if(value===null && type.includes('|null')) continue;
      if(type==='string[]' ? !Array.isArray(value) || !value.every(x=>typeof x==='string') : type==='integer' ? typeof value!=='number' || !Number.isInteger(value) : type==='boolean' ? typeof value!=='boolean' : typeof value!=='string') fail('wrong-type');
    }
    if(n.props.coreType !== undefined && !Object.hasOwn(CORE_TYPES,String(n.props.coreType))) fail('unknown-type');
    if(n.label==='Fact' && (Object.hasOwn(n.props,'objectId')===Object.hasOwn(n.props,'objectValue'))) fail('missing-property');
    if(ids.has(n.id)) fail('wrong-type'); ids.add(n.id);
    if(n.label==='Fact' && (!Array.isArray(n.props.evidenceIds) || !n.props.evidenceIds.length)) fail('empty-evidence');
    for(const [k,v] of Object.entries(n.props)) {
      if(v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean' && !(Array.isArray(v) && v.every(x=>typeof x==='string'))) fail('wrong-type');
      if(/^(blockOrSlot|fromBlockOrSlot|toBlockOrSlot)$/.test(k) && v!==null && (typeof v!=='string' || !/^\d+$/.test(v) || BigInt(v)>9223372036854775807n)) fail('wrong-type');
      if(/^(asOf|observedAt|retrievedAt|observedFrom|observedTo|freshUntil|validFrom|validTo)$/.test(k) && v!==null && !isTime(v)) fail('wrong-type');
    }
  }
  for(const r of records.relationships) {
    if(!Object.hasOwn(CORE_TYPES,r.type) && !(EVIDENCE_TYPES as readonly string[]).includes(r.type)) fail('unknown-type');
    if(!ids.has(r.from)||!ids.has(r.to)||!r.key) fail('missing-property');
    const contract=RELATIONSHIP_CONTRACTS[r.type]!;
    if(!contract.endpoints.from.includes(records.nodes.find(n=>n.id===r.from)!.label) || !contract.endpoints.to.includes(records.nodes.find(n=>n.id===r.to)!.label)) fail('wrong-type');
    for(const [key,type] of Object.entries({...contract.required,...contract.optional})) {
      if(!Object.hasOwn(r.props,key)) {if(Object.hasOwn(contract.required,key)) fail('missing-property'); else continue;}
      const value=r.props[key];
      if(type==='string[]' ? !Array.isArray(value)||!value.every(x=>typeof x==='string') : type==='boolean' ? typeof value!=='boolean' : type==='datetime' ? !isTime(value) : typeof value!=='string') fail('wrong-type');
    }
    if(r.props.key!==r.key) fail('wrong-type');
    if(keys.has(`${r.type}/${r.key}`)) fail('wrong-type'); keys.add(`${r.type}/${r.key}`);
  }
}
