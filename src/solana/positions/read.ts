import { PublicKey } from "@solana/web3.js";
import { canonical, sha256 } from "../../chain/evidence";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "../../chain/token-layout";
import { KLEND_PROGRAM } from "../../adapters/kamino/constants";
import { ID_PATTERN, cmp } from "../../policy/evaluate";
import { PositionsRejected, type ReadResult, type NotReadReason } from "../../positions/types";
import { RpcFailure, type SolanaRpcClient } from "./client";
import { SOLANA_REGISTRY, type SolanaRegistry } from "./registry";
import { parseTokenAccount, decodeObligation, unitsToDecimal, sfToDecimal } from "./decode";
export function validateSolanaAddress(address: string): void {
  try { if (typeof address !== "string" || new PublicKey(address).toBase58() !== address) throw 0; } catch { throw new PositionsRejected("malformed-address"); }
}
function resultAccounts(result: unknown, program: string) {
  const r = result as {context?: {slot?: number}; value?: {pubkey: string; account: {owner: string; data: [string, string]}}[]};
  if (!r || !Number.isSafeInteger(r.context?.slot) || r.context!.slot! < 0 || !Array.isArray(r.value)) throw new RpcFailure("malformed-response");
  return {slot:r.context!.slot!, accounts:r.value.map(entry => {
    validateSolanaAddress(entry.pubkey);
    const a=entry.account;
    if (!a || a.owner !== program || !Array.isArray(a.data) || a.data.length!==2 || a.data[1]!=="base64" || typeof a.data[0]!=="string") throw new RpcFailure("malformed-response");
    const bytes=Buffer.from(a.data[0], "base64");
    if(bytes.toString("base64")!==a.data[0]) throw new RpcFailure("malformed-response");
    return {key:entry.pubkey, bytes};
  })};
}
export async function readSolanaPositions({address, snapshotId, client, registry=SOLANA_REGISTRY}: {address:string; snapshotId:string; client:SolanaRpcClient; registry?:SolanaRegistry}): Promise<ReadResult> {
  validateSolanaAddress(address);
  if (typeof snapshotId!=="string" || !ID_PATTERN.test(snapshotId)) throw new PositionsRejected("invalid-snapshot");
  if (!client || typeof client.call!=="function" || typeof client.host!=="string") throw new PositionsRejected("missing-client");
  const output: ReadResult={positions:[],receipts:[],notRead:[]};
  const subject=(key:string)=>`solana:mainnet-beta:${key}#holder:${address}`;
  const unread=(key:string, reason:NotReadReason)=>output.notRead.push({subject:subject(key),reason});
  const position=(kind:string,key:string,target:string,quantity:string,unit:string,receipt:string)=>output.positions.push({id:"solana-reader."+sha256(canonical([address,kind,key])).slice(0,48), subject:subject(target),quantity,unit:`solana:mainnet-beta:${unit}`,snapshotId,source:"reader",fixtureKind:"real-private",receiptIds:[receipt]});
  for (const program of [TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58(), KLEND_PROGRAM]) {
    const obligation=program===KLEND_PROGRAM;
    if(obligation && !client.programAccounts) { unread(program,"rpc-method-unavailable"); continue; }
    const method=obligation?"getProgramAccounts":"getTokenAccountsByOwner";
    const params=obligation ? [program,{encoding:"base64",commitment:"confirmed",withContext:true,filters:[{dataSize:3344},{memcmp:{offset:64,bytes:address}}]}] : [address,{programId:program},{encoding:"base64",commitment:"confirmed"}];
    let read: Awaited<ReturnType<SolanaRpcClient["call"]>>;
    try { read=await client.call(method,params); } catch(error) {
      const reason=error instanceof RpcFailure?error.reason:"rpc-error";
      for(const t of registry.tokens.filter(t=>t.tokenProgram===program)) unread(t.mint,reason);
      unread(program,reason); continue;
    }
    try {
      const {slot,accounts}=resultAccounts(read.result,program);
      const tokens=obligation?[]:accounts.map(a=>parseTokenAccount(a.bytes));
      const obligations=obligation?accounts.map(a=>({key:a.key,...decodeObligation(a.bytes)})):[];
      if([...tokens,...obligations].some(a=>a.owner!==address)) throw new RpcFailure("malformed-response");
      const responseSha256=sha256(canonical(read.result));
      const receipt="solana-read."+sha256(canonical({method,params,responseSha256})).slice(0,48);
      // Validate the entire call before publishing any positions or its receipt.
      const pending: (()=>void)[]=[];
      const sums=new Map<string,bigint>();
      for(const token of tokens) sums.set(token.mint,(sums.get(token.mint)??0n)+token.amountRaw);
      for(const [mint,amount] of sums) {
        if(amount===0n) continue;
        const t=registry.tokens.find(t=>t.mint===mint && t.tokenProgram===program);
        if(!t || t.decimals===null) { pending.push(()=>unread(mint,t?"missing-decimals":"not-covered")); continue; }
        const quantity=unitsToDecimal(amount,t.decimals);
        pending.push(()=>position("token",mint,mint,quantity,mint,receipt));
      }
      for(const o of obligations) for(const [kind,legs] of [["klend-deposit",o.deposits],["klend-borrow",o.borrows]] as const) for(const leg of legs) {
        if(leg.amount===0n || leg.reserve===PublicKey.default.toBase58()) continue;
        const reserve=registry.klendReserves.find(r=>r.reserve===leg.reserve);
        if(!reserve || reserve.decimals===null) { pending.push(()=>unread(leg.reserve,reserve?"missing-decimals":"not-covered")); continue; }
        const quantity=kind==="klend-deposit"?unitsToDecimal(leg.amount,reserve.decimals):sfToDecimal(leg.amount,reserve.decimals);
        pending.push(()=>position(kind,`${o.key}:${leg.reserve}`,leg.reserve,quantity,kind==="klend-deposit"?reserve.collateralMint:reserve.liquidityMint,receipt));
      }
      output.receipts.push({id:receipt,source:`${method}@${client.host}`,responseSha256,observation:{chain:"solana",network:"mainnet-beta",blockOrSlot:String(slot),blockHash:null,observedAt:read.retrievedAt,retrievedAt:read.retrievedAt,historicalState:"current-only"},privacy:"private"});
      pending.forEach(apply=>apply());
    } catch {
      for(const t of registry.tokens.filter(t=>t.tokenProgram===program)) unread(t.mint,"malformed-response");
      unread(program,"malformed-response");
    }
  }
  output.positions.sort((a,b)=>cmp(a.subject,b.subject)||cmp(a.unit,b.unit)||cmp(a.id,b.id));
  output.notRead=[...new Map(output.notRead.map(n=>[canonical(n),n])).values()].sort((a,b)=>cmp(a.subject,b.subject)||cmp(a.reason,b.reason));
  return output;
}
