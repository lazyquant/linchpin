import { expect, test } from 'bun:test';
import { CORE_TYPES, NOT_PROJECTED, NOT_PROJECTED_REASONS } from '../src/graph/evidence/schema';
import { traversalCypher } from '../src/graph/evidence/templates';

test('proposal effects have no core projection mapping', () => {
  expect(CORE_TYPES.AFFECTS).toBeUndefined();
  for (const predicate of ['touches-control-of', 'touches-code-of', 'changes-parameter-of']) {
    expect(NOT_PROJECTED).toContain(predicate);
    expect(NOT_PROJECTED_REASONS[predicate]).toBe('proposed effect, not current control; its class is a later vocabulary decision');
    expect(Object.values(CORE_TYPES).flatMap(t => t.mappedFrom).some(m => m.predicate === predicate)).toBe(false);
  }
});

test('traversal conflict candidates must survive the temporal filter', () => {
  for (const control of [true, false]) expect(traversalCypher(control)).toContain('any(g IN raw WHERE g.usable AND g.snapshotId');
});

import { buildEvidenceRecords, collectSlice1Inputs, runEvidenceLocal, runEvidenceNeo4j, normalizeRows } from '../src/graph/evidence';
const latest = 'solana-mainnet-beta.kamino.sentora-pyusd-20261109T170418Z';
const early = 'solana-mainnet-beta.kamino.sentora-pyusd-20261109T163416Z';
const vault = 'solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK';
const scope = {snapshotId:latest,asOf:'2026-11-10T17:04:20.763Z',maxHops:1,maxResults:500};
const inputs = () => structuredClone(collectSlice1Inputs());

test('R1 expired sibling does not make a surviving control fact conflicting', () => {
  const data=inputs(), s=data.find(i=>i.snapshot.id===latest)!.snapshot;
  const admin=s.facts.find(f=>f.subject===vault&&f.predicate==='VAULT_ADMIN')!;
  s.facts.push({...admin,id:'expired-sibling',object:s.subjects.find(x=>x!==vault&&x!==admin.object)!,validFrom:null,validTo:'2026-11-01T00:00:00.000Z'});
  const rows=runEvidenceLocal(buildEvidenceRecords(data),'control',{subject:vault,scope}).rows;
  expect(rows.find(r=>r.factId===admin.id)?.status).toBe(admin.status);
  expect(rows.some(r=>r.factId==='expired-sibling')).toBe(false);
});

test('R2 repeated ids retain both snapshot identities and second-snapshot control', () => {
  const data=inputs(), first=data.find(i=>i.snapshot.id==='near-2026-11-09')!;
  data.push({snapshot:{...structuredClone(first.snapshot),id:'near-2026-11-10'}});
  const records=buildEvidenceRecords(data),subject='near:mainnet:intents.near';
  const rows=runEvidenceLocal(records,'changes',{subject,beforeSnapshotId:first.snapshot.id,afterSnapshotId:'near-2026-11-10',maxResults:500}).rows;
  expect(rows).toHaveLength(54);
  expect(new Set(rows.map(r=>r.uid)).size).toBe(54);
  for(const id of new Set(rows.map(r=>r.factId))) expect(rows.filter(r=>r.factId===id).map(r=>r.snapshotId).sort()).toEqual(['near-2026-11-09','near-2026-11-10']);
  expect(runEvidenceLocal(records,'control',{subject,scope:{...scope,snapshotId:'near-2026-11-10'}}).rows.every(r=>r.snapshotId==='near-2026-11-10')).toBe(true);
});

test('R4 temporal expiry and missing unknown controller use engine reason precedence', async () => {
  const data=inputs(), s=data.find(i=>i.snapshot.id===latest)!.snapshot;
  const admin=s.facts.find(f=>f.subject===vault&&f.predicate==='VAULT_ADMIN')!;
  admin.validTo='2026-11-01T00:00:00.000Z';
  const unknown=s.facts.find(f=>f.predicate==='CONTROLLED_BY'&&f.object==='unknown')!;
  unknown.status='missing';
  const records=buildEvidenceRecords(data);
  const changes=runEvidenceLocal(records,'changes',{subject:vault,beforeSnapshotId:early,afterSnapshotId:latest,maxResults:500}).rows;
  expect(changes.find(r=>r.factId===admin.id&&r.snapshotId===latest)?.reason).toBe('expired');
  const params={subject:unknown.subject,scope};
  const local=runEvidenceLocal(records,'control',params).rows;
  expect(local.find(r=>r.factId===unknown.id)?.reason).toBe('missing-evidence');
  // Stateful driver models persisted query rows, independently of the local runner.
  const state = structuredClone(local).map(r=>({...r,usable:true,expired:false}));
  let calls=0;
  const driver={async executeQuery(query:string) {
    calls++;
    expect(query).toContain("WHEN f.status = 'missing' THEN 'missing-evidence'");
    expect(query.indexOf("WHEN f.status = 'missing'")).toBeLessThan(query.lastIndexOf("THEN 'unknown-controller'"));
    return {records:state.map(row=>({get:()=>structuredClone(row)}))};
  }};
  expect(await runEvidenceNeo4j(driver,'control',params)).toEqual(normalizeRows(local));
  expect(calls).toBe(1);
});

// R3 (run 038 diff review): the published template contract is complete.
import { EVIDENCE_TEMPLATES as R3_TEMPLATES, templateParameters as r3Params } from '../src/graph/evidence/templates';
test('R3: every Cypher parameter is published, defaults fill the rest, post-processing is documented', () => {
  for (const t of R3_TEMPLATES as any[]) {
    const referenced = [...new Set([...String(t.cypher).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))].sort();
    expect(Object.keys(t.cypherParams).sort()).toEqual(referenced);
    for (const [name, spec] of Object.entries(t.cypherParams) as [string, any][])
      if (spec.default === 'required') expect(Object.keys(t.params.properties)).toContain(name);
    const filled = r3Params({});
    for (const [name, spec] of Object.entries(t.cypherParams) as [string, any][])
      if (spec.default === null) expect(name in filled).toBe(true);
    expect(t.entryPoint).toBe('runEvidenceNeo4j');
    expect(t.postProcessing.length).toBeGreaterThan(0);
  }
});

// R12 (GLM review of the fix commit): changes marks conflicts before the temporal filter,
// as the engine's changes() does; control and dependencies mark them after it.
import { changesCypher as r12Changes, traversalCypher as r12Traversal } from '../src/graph/evidence/templates';
test('R12: conflict marking follows the engine per template', () => {
  expect(r12Changes).toContain("CASE WHEN f.cardinality = 'one' AND any(g IN raw WHERE g.snapshotId=f.snapshotId");
  for (const control of [true, false]) expect(r12Traversal(control)).toContain("CASE WHEN f.usable AND f.cardinality = 'one' AND any(g IN raw WHERE g.usable AND g.snapshotId=f.snapshotId");
});
