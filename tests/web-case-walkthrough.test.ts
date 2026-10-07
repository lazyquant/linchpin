import { test, expect } from 'bun:test';
import type { Packet } from '../src/review/packet';
import type { BundleResponse } from '../src/tokenomics/api';
import { units, percent, bonkStory, mndeStory, answerBonk, walkthroughMemo } from '../src/web/case-walkthrough-model';

function packet(): Packet {
  return {caseId:'bonk-bip76',proposal:{evidenceId:'proposal',options:[{label:'Approve',voteWeightRaw:'88238338728379189'}],maxVoteWeightRaw:'8799471339760304184',voteThreshold:{type:0,value:1},votingCompletedAt:1000},governance:{evidenceId:'governance',minInstructionHoldUpTime:0},claimed:[{id:'c2',text:'Explicit transfer intent'}],decoded:[{kind:'transfer',source:'source',destination:'destination',amountRaw:442610445030596600n,decimals:5}],effects:[],observed:{receipts:[{txIndex:0,proposalTransaction:'payload',signature:'receipt',blockTime:1049,success:true,slot:431127240,evidenceIds:['receipt-evidence'],tokenBalances:[{account:'source',preRaw:'442610445030596633',postRaw:'33'},{account:'destination',preRaw:'0',postRaw:'442610445030596600'}]}],reconciliations:[{proposalTransaction:'payload',status:'matched',expectedDeltaRaw:'-442610445030596600',observedDeltaRaw:'-442610445030596600'}]}} as unknown as Packet;
}
test('Bonk uses historical receipt balances, preserves raw precision and uses max vote weight',()=>{
  const p=packet();p.stateFacts=[{id:'today',label:'Later source balance',value:'0.00033',raw:'33',slot:453664775,evidenceIds:[]}];
  const s=bonkStory(p);expect(s.amount).toBe('4,426,104,450,305.966');expect(s.remaining).toBe('0.00033');expect(s.share).toBe('99.9999');expect(s.approveShare).toBe('1.0028');expect(s.transferDelay).toBe(49);expect(s.matched).toBe(true);
});
test('successful receipt alone is not a matched transfer',()=>{
  const p=packet();p.observed.reconciliations[0]!.observedDeltaRaw='-1';expect(bonkStory(p).matched).toBe(false);
  p.observed.receipts[0]!.success=false;expect(bonkStory(p).matched).toBe(false);
});
test('unsupported questions and missing denominators stay unresolved',()=>{
  const p=packet();p.proposal.maxVoteWeightRaw=null;const s=bonkStory(p);expect(s.approveShare).toBe(null);expect(answerBonk('price next year',s)).toEqual([]);expect(answerBonk('Who was the attacker?',s).some(f=>f.text.includes('not analysed'))).toBe(true);expect(percent('1','0')).toBe(null);
});
test('MNDE paid purchases and credits without payment remain separate, with exact sums',()=>{
  const b={path:{data:{links:[]}},parameters:{data:{rows:[]}},control:{data:{controllers:[]}},claims:{data:{rows:[]}},answer:{data:null,asOf:null},flows:{data:{buybacks:{months:[{mndeBought:{raw:'4475493127687976',decimals:9},mndeCreditedWithoutPayment:{raw:'6388216115601440',decimals:9}}]}}}} as unknown as BundleResponse;
  const s=mndeStory(b);expect(s.paid).toBe('4,475,493.127687976');expect(s.unpaid).toBe('6,388,216.11560144');expect(s.tenPercent).toBe(undefined);expect(s.claims).toBe(undefined);
  expect(units('8799471339760304184',5)).toBe('87,994,713,397,603.04184');
});

test('memo export preserves receipt citations and human review limits',()=>{
 const story=bonkStory(packet());const memo=walkthroughMemo('bonk',story.facts,'2026-10-06T18:00:00Z');
 expect(memo).toContain('receipt-evidence');expect(memo).toContain('0.00033');expect(memo).toContain('Draft · human review pending');expect(memo).toContain('does not represent all DAO assets');expect(memo).toContain('no language model');
});
