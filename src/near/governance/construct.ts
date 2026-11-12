import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import { restoredResponse } from "../reader/client";
import { nearReads, nearSnapshotDir, nearStoreSha256, readNearManifest, snapshotFromRecords, type NearSnapshotManifest } from "../reader/load";
import { requestSha256, type NearRecord } from "../reader/types";
import { NEAR_REGISTRY } from "../subjects/registry";
export type ConstructedGovernanceName="governance-expired"|"governance-kinds"|"governance-policy-changed";
const DAO="burrow.sputnik-dao.near";
function kinds(policy: any): unknown[] {
  const changed=structuredClone(policy),council=changed.roles.find((r:any)=>r.name === "council");council.kind.Group=council.kind.Group.filter((m:string)=>m !== "farbread8025.near");
  const hash="4zSoHkLjJWZm34Psd4Eq2WUXHELt6LxtKmUXpsZWAECp",recipient="linchpin-constructed-recipient.near";
  const action=(method_name:string,args:unknown,raw=false)=>({method_name,args:raw ? args:Buffer.from(JSON.stringify(args)).toString("base64"),deposit:"1",gas:"120000000000000"});
  const call=(receiver_id:string,method:string,args:unknown,raw=false)=>({FunctionCall:{receiver_id,actions:[action(method,args,raw)]}});
  return [
    {Transfer:{token_id:"",receiver_id:recipient,amount:"1000000000000000000000000",msg:null}},
    {ChangePolicy:{policy:changed}}, {ChangePolicyAddOrUpdateRole:{role:council}}, {ChangePolicyRemoveRole:{role:"council"}},
    {ChangePolicyUpdateDefaultVotePolicy:{vote_policy:{weight_kind:"RoleWeight",quorum:"0",threshold:[2,3]}}},
    {ChangePolicyUpdateParameters:{parameters:{proposal_bond:null,proposal_period:"259200000000000",bounty_bond:null,bounty_forgiveness_period:null}}},
    {UpgradeSelf:{hash}}, {UpgradeRemote:{receiver_id:"contract.main.burrow.near",method_name:"upgrade",hash}},
    {SetStakingContract:{staking_id:"linchpin-constructed-staking.near"}}, {FactoryInfoUpdate:{factory_info:{factory_id:"sputnik-dao.near",auto_update:true}}},
    {AddBounty:{bounty:{description:"constructed",token:"",amount:"1",times:1,max_deadline:"1"}}}, {BountyDone:{bounty_id:0,receiver_id:recipient}}, "Vote", {LinchpinConstructedKind:{}},
    call("contract.main.burrow.near","execute",{actions:[{IncreaseCollateral:{token_id:"wrap.near"}},{Withdraw:{token_id:"wrap.near"}}]}),
    call("contract.main.burrow.near","update_asset_limit","AAEC",true), call("linchpin-constructed-other.near","do_something",{}),
    call("wrap.near","ft_transfer",{receiver_id:recipient,amount:"1"}), call("aggregate-oracle.near","set_owner",{owner_id:"linchpin-constructed-owner.near"}),
    call("v2.ref-finance.near","upgrade","AAEC",true), call("dclv2.ref-labs.near","withdraw_asset",{token_id:"wrap.near",amount:"1"}),
    call("contract.main.burrow.near","storage_withdraw",{}), call("v2.ref-finance.near","add_guardians",{guardians:["linchpin-constructed-guardian.near"]}),
    call("contract.main.burrow.near","set_pause_operator",{pause_operator_id:"linchpin-constructed-pauser.near"}),
    {FunctionCall:{receiver_id:"omni.bridge.near",actions:[action("pa_pause_feature",{key:"ALL"}),action("acl_revoke_role",{role:"PauseManager",account_id:"bridge-ops.near"})]}},
    call("omft.near","add_full_access_key",{public_key:"ed25519:11111111111111111111111111111111"}),
    {ChangeConfig:{config:{name:"burrow",purpose:"constructed",metadata:""}}}, {AddMemberToRole:{role:"council"}},
  ];
}
export function constructGovernanceSnapshot(name:ConstructedGovernanceName,from:string,root="fixtures/near"):NearSnapshotManifest {
  if(!["governance-expired","governance-kinds","governance-policy-changed"].includes(name)) throw new Error("Unknown constructed snapshot");
  const id=`near-constructed-${name}`,dir=nearSnapshotDir(id,root),staging=`${dir}.partial`;
  if(existsSync(dir)||existsSync(staging)) throw new Error("Construction refuses to overwrite an existing directory");
  const source=readNearManifest(from,{root});if(source.constructed) throw new Error("Construction requires a live source");
  const records=nearReads(from,{root}).records.filter(r=>r.request.method === "query" && [DAO,"sputnik-dao.near"].includes(r.request.params.account_id)).map(r=>structuredClone(r));
  const method=(r:NearRecord,m:string)=>r.request.method === "query" && r.request.params.account_id === DAO && "method_name" in r.request.params && r.request.params.method_name === m;
  const policyRecord=records.find(r=>method(r,"get_policy")),last=records.find(r=>method(r,"get_last_proposal_id"));
  if(!policyRecord?.resultText || !last) throw new Error("Missing construction source policy");
  const policy=JSON.parse(policyRecord.resultText);
  let original:any;
  for(const r of records.filter(r=>method(r,"get_proposals"))) for(const p of JSON.parse(r.resultText!)) if(p.id === 1746) original=p;
  if(!original) throw new Error("Missing source proposal 1746");
  if(name === "governance-policy-changed") {
    policy.roles.find((r:any)=>r.name === "council").kind.Group=policy.roles.find((r:any)=>r.name === "council").kind.Group.filter((m:string)=>m !== "farbread8025.near");
    policy.default_vote_policy.threshold=[2,3];policy.proposal_period="259200000000000";policyRecord.resultText=JSON.stringify(policy);
  } else if(name === "governance-expired") {
    for(const r of records.filter(r=>method(r,"get_proposals")||method(r,"get_proposal"))) {
      const value=JSON.parse(r.resultText!),list=Array.isArray(value) ? value:[value];
      for(const p of list) if(p.id === 1746) {p.status="InProgress";p.submission_time="1791538938955922010";p.votes={"brhost.near":"Approve"};p.vote_counts={council:[1,0,0]};}
      r.resultText=JSON.stringify(value);
    }
  } else for(const [index,kind] of kinds(policy).entries()) {
    const proposal={id:900001+index,proposer:"linchpin-constructed-proposer.near",status:"InProgress",submission_time:original.submission_time,kind,votes:{},vote_counts:{}};
    const r=structuredClone(last);if(r.request.method !== "query" || r.request.params.request_type !== "call_function") throw new Error("Invalid construction source");
    r.request.params.method_name="get_proposal";r.request.params.args_base64=Buffer.from(JSON.stringify({id:proposal.id})).toString("base64");r.requestSha256=requestSha256(r.request);r.resultText=JSON.stringify(proposal);records.push(r);
  }
  for(const r of records) r.responseSha256=sha256(canonical(restoredResponse(r)));
  const heights=records.flatMap(r=>r.blockHeight === null ? []:[BigInt(r.blockHeight)]).sort((a,b)=>a<b ? -1:a>b ? 1:0);
  const m:NearSnapshotManifest={...source,snapshotId:id,constructed:true,constructedFrom:from,constructedChange:name === "governance-expired" ? "proposal 1746 reopened and backdated past its period":name === "governance-policy-changed" ? "council reduced to four, default threshold 2/3, period three days":"28 constructed proposal kinds and action cases",fromBlock:String(heights[0]),toBlock:String(heights.at(-1)),reads:records.length,files:{},storeSha256:"0".repeat(64)};
  // Validate all generated data before creating the destination.
  m.storeSha256=nearStoreSha256(snapshotFromRecords(m,records,NEAR_REGISTRY));
  mkdirSync(dirname(dir),{recursive:true});mkdirSync(staging);
  try {
    for(const r of records) {const file=`${r.requestSha256}.json`,bytes=JSON.stringify(r,null,1)+"\n";m.files[file]=sha256(bytes);writeFileSync(join(staging,file),bytes);}
    writeFileSync(join(staging,"manifest.json"),JSON.stringify(m,null,1)+"\n");
    if(existsSync(dir)) throw new Error("Destination appeared during construction");renameSync(staging,dir);return m;
  } catch(e) {rmSync(staging,{recursive:true,force:true});throw e;}
}
if(import.meta.main) {
  try {const args=process.argv.slice(2);if(args.length !== 3 || args[1] !== "--from") throw new Error("Use <name> --from <snapshot>");console.log(JSON.stringify(constructGovernanceSnapshot(args[0] as ConstructedGovernanceName,args[2]),null,1));}
  catch(e) {console.error(e instanceof Error ? e.message:"Construction failed");process.exitCode=1;}
}
