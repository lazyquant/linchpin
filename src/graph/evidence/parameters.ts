import { ID_PATTERN, SUBJECT_PATTERN, QueryRejected, isRecord, parseQueryRequest } from '../../engine/queries/request';

/** Validate before either local evaluation or a database call. */
export function validateTemplateParameters(id: string, params: unknown): asserts params is Record<string, unknown> {
  if (['control', 'dependencies', 'changes', 'evidence'].includes(id)) {
    if (!isRecord(params)) throw new QueryRejected('not-object');
    parseQueryRequest({...params, name:id});
    return;
  }
  const fields: Record<string, string[]> = {
    'entity-resolve':['text','protocolId','limit'], 'shared-controllers':['protocolId','snapshotIds','minSubjects'],
    exposure:['subject','maxHops','snapshotIds'], coverage:['protocolId','series'],
  };
  if (!fields[id]) throw new QueryRejected('unknown-name');
  if (!isRecord(params)) throw new QueryRejected('not-object');
  for (const key of Reflect.ownKeys(params)) {
    if (typeof key !== 'string' || !fields[id]!.includes(key)) throw new QueryRejected('extra-key');
    const d = Object.getOwnPropertyDescriptor(params,key)!;
    if (!d.enumerable || !('value' in d)) throw new QueryRejected('wrong-type');
  }
  for (const key of id==='entity-resolve'?['text','limit']:id==='exposure'?['subject','maxHops']:[]) {
    if (!Object.hasOwn(params,key)) throw new QueryRejected('missing-key');
  }
  for (const [key,value] of Object.entries(params)) {
    if (['limit','maxHops','minSubjects'].includes(key)) {
      if(typeof value!=='number') throw new QueryRejected('wrong-type');
      if(!Number.isFinite(value)) throw new QueryRejected('nonfinite-number');
      const maximum=key==='maxHops'?8:key==='limit'?500:Number.MAX_SAFE_INTEGER;
      if(!Number.isInteger(value)||value<1||value>maximum) throw new QueryRejected('unbounded-limit');
    } else if(key==='snapshotIds') {
      if(!Array.isArray(value)) throw new QueryRejected('wrong-type');
      for(const item of value) {
        if(typeof item!=='string') throw new QueryRejected('wrong-type');
        if(!ID_PATTERN.test(item)) throw new QueryRejected('malformed-id');
      }
      if(new Set(value).size!==value.length) throw new QueryRejected('duplicate-entry');
    } else {
      if(typeof value!=='string') throw new QueryRejected('wrong-type');
      if(key==='subject'&&!SUBJECT_PATTERN.test(value)) throw new QueryRejected('malformed-identity');
      if(['protocolId','series'].includes(key)&&!ID_PATTERN.test(value)) throw new QueryRejected('malformed-id');
    }
  }
}
