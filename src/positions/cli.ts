import { homedir } from "node:os";
import { DEFAULT_RPC_URL } from "../config";
import { canonical } from "../chain/evidence";
import { ID_PATTERN } from "../policy/evaluate";
import { createSolanaRpcClient } from "../solana/positions/client";
import { loadAddressesFile, parseAddressArg } from "./addresses";
import { readPositions, isAbsentEvmPositionsModule, EthereumReaderLoadError } from "./read";
import { PositionsRejected } from "./types";
export interface PositionsIO {
  env?: Record<string,string | undefined>; home?:string; fetch?:typeof fetch; now?:()=>number;
  out?:(line:string)=>void; err?:(line:string)=>void;
}
const USAGE="usage: linchpin positions read [--address <chain>:<account>]... [--snapshot <id>] [--json]";
export async function runPositionsCommand(argv:string[], io:PositionsIO={}):Promise<number> {
  const out=io.out??console.log, err=io.err??console.error;
  try {
    if(argv[0]!=="read") throw new PositionsRejected("usage");
    const args:string[]=[];
    let snapshotId:string|undefined, json=false;
    for(let i=1;i<argv.length;i++) {
      const arg=argv[i];
      if(arg==="--json") json=true;
      else if(arg==="--address" || arg==="--snapshot") {
        const value=argv[++i];
        if(!value || value.startsWith("--")) throw new PositionsRejected("usage");
        if(arg==="--address") args.push(value); else snapshotId=value;
      } else throw new PositionsRejected("usage");
    }
    const addresses=args.length?args.map(parseAddressArg):await loadAddressesFile(io.home??homedir());
    const now=io.now??Date.now;
    snapshotId??="positions."+new Date(now()).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
    if(!ID_PATTERN.test(snapshotId)) throw new PositionsRejected("invalid-snapshot");
    const env=io.env??process.env;
    const client=createSolanaRpcClient({url:env.LINCHPIN_RPC_URL||DEFAULT_RPC_URL,timeoutMs:env.LINCHPIN_RPC_TIMEOUT_MS===undefined?30000:Number(env.LINCHPIN_RPC_TIMEOUT_MS),programAccounts:Boolean(env.LINCHPIN_RPC_URL),fetch:io.fetch,now});
    // JSON stays a single document; text announces the host before the first read.
    if(!json && addresses.some(a=>a.chain==="solana")) out(`endpoint host: ${client.host}`);
    let evmClient: unknown, evmHost: string | undefined;
    if(addresses.some(a=>a.chain==="ethereum") && env.LINCHPIN_EVM_RPC_URL) {
      const mod=await import(`../evm/positions/${"client"}`).catch(error=>{
        if(isAbsentEvmPositionsModule(error,"client")) return null;
        throw new EthereumReaderLoadError();
      });
      if(mod) {
        const c=mod.createEvmPositionsClient({url:env.LINCHPIN_EVM_RPC_URL,timeoutMs:30000,fetch:io.fetch,now});
        evmClient=c; evmHost=c.host;
        if(!json) out(`endpoint host: ${c.host}`);
      }
    }
    let exitCode=0;
    const results=[];
    for(const address of addresses) {
      if(address.chain==="ethereum" && !env.LINCHPIN_EVM_RPC_URL) {
        err("LINCHPIN_EVM_RPC_URL is required for ethereum addresses"); exitCode=1; continue;
      }
      const result=await readPositions({...address,snapshotId,client:address.chain==="ethereum"?(evmClient??{}):client});
      const endpointHost=address.chain==="solana"?client.host:address.chain==="ethereum"?evmHost:undefined;
      results.push({...(endpointHost?{endpointHost}:{}),address:`${address.chain}:${address.address}`,...result});
      if(!json) {
        if(result.coverageSnapshotId) out(`coverage: ${result.coverageSnapshotId}`);
        for(const p of result.positions) out(`position ${p.subject} ${p.quantity} ${p.unit} receipts=${p.receiptIds.join(",")}`);
        for(const setting of result.accountSettings??[]) {
          let label="";
          if(setting.value!=="none") {
            if(setting.label!==undefined) label=` label ${JSON.stringify(setting.label)} (${setting.labelSnapshotId})`;
            else {
              const mod=await import(`../evm/positions/${"read"}`);
              label=` label not in ${mod.latestEmodeLabelSnapshotId()}`;
            }
          }
          out(`setting ${setting.subject} ${setting.setting} ${setting.value}${label} receipts=${setting.receiptIds.join(",")}`);
        }
        for(const n of result.notRead) out(`not-read ${n.subject} ${n.reason}`);
        for(const r of result.receipts) out(`receipt ${r.id} ${r.source} slot=${r.observation.blockOrSlot} sha256=${r.responseSha256}`);
      }
    }
    if(json) {
      const hosts=[...new Set(results.flatMap(r=>r.endpointHost?[r.endpointHost]:[]))];
      out(canonical({...(hosts.length===1?{endpointHost:hosts[0]}:{}),results}));
    }
    return exitCode;
  } catch(error) {
    err(error instanceof EthereumReaderLoadError ? error.message : error instanceof PositionsRejected ? ["usage","no-addresses"].includes(error.code)?USAGE:error.code : "positions read failed: invalid input or configuration");
    return 1;
  }
}
