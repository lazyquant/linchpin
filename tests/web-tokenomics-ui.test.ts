import { describe,test,expect } from 'bun:test';
import type { BundleResponse, SectionId, Provenance } from '../src/tokenomics/api';
import { answerQuestion } from '../src/web/tokenomics-questions';
import { renderSection, pathPicture, graphPicture } from '../src/web/tokenomics-view';
const proof:Provenance={basis:'decoded',evidenceIds:['a'.repeat(64)],slot:123,asOf:'2026-10-06T08:00:00Z'};
function bundle():BundleResponse {
  const ids:SectionId[]=['answer','path','control','offsets','parameters','programs','participation','holders','flows','claims','graph'];
  const b=Object.fromEntries(ids.map(section=>[section,{protocol:'marinade',section,status:'pending',title:section,asOf:null,slotRange:null,evidenceCount:0,assumptions:[],notes:['Capture in progress'],data:null}])) as unknown as BundleResponse;
  b.answer={...b.answer,status:'ready',data:{question:'Can value reach MNDE holders?',shortAnswer:{status:'partly',text:'The fee route is decoded; onward transfers require an operator.'},statements:[{...proof,id:'fee',text:'Reward fee is 0 % in captured state.',status:'verified'}],unknowns:[{...proof,basis:'claimed',id:'unknown-flow',text:'Buyback receipts are not captured.'}]}};
  b.parameters={...b.parameters,status:'ready',data:{rows:[{...proof,id:'reward-fee',program:'Liquid staking',field:'rewardFee',label:'Reward fee',value:'0',display:'0 %',unit:'percent',setBy:[]}]}};
  b.control={...b.control,status:'ready',data:{controllers:[{...proof,id:'dao',type:'dao-governance',label:'Marinade DAO',address:'dao-address'}],rows:[{...proof,id:'fee-admin',target:'Reward fee',targetKind:'parameter',canChange:'Set reward fee',instructions:['configMarinade'],role:'adminAuthority',holder:{address:'dao-address'},controllerId:'dao'}]}};
  b.path={...b.path,status:'ready',data:{nodes:[{id:'a',label:'Activity',kind:'activity'},{id:'b',label:'MNDE holders',kind:'holders'}],links:[{...proof,basis:'claimed',id:'buyback',from:'a',to:'b',mechanism:'Buyback distribution',status:'claimed-only',parameters:[],observed:null,claims:[],controlledBy:[],note:'Claimed only; no receipt captured.'}]}};
  return b;
}
describe('tokenomics evidence UI boundaries',()=>{
  test('question retrieval attaches the controller and original provenance',()=>{
    const answer=answerQuestion('Who controls the reward fee?',bundle());
    expect(answer.facts.some(f=>f.text.includes('Marinade DAO'))).toBe(true);
    expect(answer.text).toContain('Marinade DAO');
    expect(answerQuestion('Who can change the fees?',bundle()).text).toContain('configMarinade');
    expect(answer.facts.every(f=>f.evidenceIds.includes('a'.repeat(64))&&f.asOf===proof.asOf)).toBe(true);
  });
  test('MNDE mint questions retain the asset identity and do not invent a controller',()=>{
    const b=bundle();b.control.data!.controllers.push({...proof,id:'none',type:'none',label:'No authority',address:null});b.control.data!.rows.push({...proof,id:'mint-mnde',target:'MNDE supply',targetKind:'mint',canChange:'Issue tokens',instructions:['MintTo'],role:'mintAuthority',holder:{address:'none'},controllerId:'none'});
    const a=answerQuestion('Can more MNDE be minted?',b);expect(a.text).toContain('No mintAuthority');expect(a.text).toContain('MNDE supply');expect(a.facts.some(f=>f.text.includes('Authority absent'))).toBe(true);
  });
  test('unsupported questions do not get invented answers',()=>{
    const answer=answerQuestion('Predict Bitcoin closing price tomorrow',bundle());
    expect(answer.facts).toHaveLength(0);expect(answer.text).toContain('cannot establish');
  });
  test('missing flow capture stays pending in both the view and question answer',()=>{
    expect(renderSection(bundle(),'flows')).toContain('In progress');
    expect(renderSection(bundle(),'flows')).not.toContain('0 MNDE');
    expect(answerQuestion('What buybacks flowed?',bundle()).limitations.join(' ')).toContain('Capture in progress');
  });
  test('claimed links are visible as claimed and do not gain an observed amount',()=>{
    const html=pathPicture(bundle().path.data!);
    expect(html).toContain('claimed-only');expect(html).toContain('claimed only');expect(html).toContain('Flow amount not observed');
    const answer=answerQuestion('Is the value path to MNDE holders enforced?',bundle());
    expect(answer.text).toContain('onward transfers require an operator');
    expect(answer.facts.find(f=>f.id==='buyback')?.basis).toBe('claimed');
  });
  test('untrusted claim text is escaped in rendered views',()=>{
    const b=bundle();b.answer.data!.statements[0].text='<img src=x onerror=alert(1)>';
    const html=renderSection(b,'overview');expect(html).toContain('&lt;img');expect(html).not.toContain('<img src=x');
  });
  test('exact token amounts are not rounded for presentation or questions',()=>{
    const b=bundle();b.offsets={...b.offsets,status:'ready',data:{rows:[{...proof,basis:'observed',id:'external',label:'External outflows',amount:{raw:'203378500270000000',decimals:9,display:'203,378,500.27',unit:'MNDE'},note:'Historical governance transfers'}]}};
    expect(renderSection(b,'offsets')).toContain('203,378,500.27 MNDE');
    expect(answerQuestion('Show external outflows',b).facts.some(f=>f.text.includes('203,378,500.27 MNDE'))).toBe(true);
  });
  test('graph filtering retains only matching actual entities, and Neo4j rows keep their source',()=>{
    const b=bundle();b.graph={...b.graph,status:'ready',data:{source:'neo4j',host:'neo4j.example',reason:null,configured:true,queries:[{id:'authority',title:'Program dependencies',question:'Which program dependencies exist?',cypher:'MATCH (n:TG) RETURN n',params:{},columns:['program'],rows:[{program:'Liquid staking'}]}],subgraph:{nodes:[{id:'a',label:'Liquid staking',type:'Program'},{id:'b',label:'MNDE',type:'Mint'}],edges:[]}}};
    expect(graphPicture(b.graph.data!,'Program')).toContain('Liquid staking');expect(graphPicture(b.graph.data!,'Program')).not.toContain('>MNDE<');
    expect(answerQuestion('Show graph program dependencies',b).query?.source).toBe('neo4j');
  });
});
