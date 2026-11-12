import { homedir } from "node:os";
import { DEFAULT_RPC_URL } from "../config";
import { canonical } from "../chain/evidence";
import { ID_PATTERN } from "../policy/evaluate";
import { createSolanaRpcClient } from "../solana/positions/client";
import { loadAddressesFile, parseAddressArg } from "./addresses";
import { readPositions } from "./read";
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
    snapshotId??="solana-reader."+new Date(now()).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
    if(!ID_PATTERN.test(snapshotId)) throw new PositionsRejected("invalid-snapshot");
    const env=io.env??process.env;
    const client=createSolanaRpcClient({url:env.LINCHPIN_RPC_URL||DEFAULT_RPC_URL,timeoutMs:env.LINCHPIN_RPC_TIMEOUT_MS===undefined?30000:Number(env.LINCHPIN_RPC_TIMEOUT_MS),programAccounts:Boolean(env.LINCHPIN_RPC_URL),fetch:io.fetch,now});
    // JSON stays a single document; text announces the host before the first read.
    if(!json) out(`endpoint host: ${client.host}`);
    const results=[];
    for(const address of addresses) {
      const result=await readPositions({...address,snapshotId,client});
      results.push({address:`${address.chain}:${address.address}`,...result});
      if(!json) {
        for(const p of result.positions) out(`position ${p.subject} ${p.quantity} ${p.unit} receipts=${p.receiptIds.join(",")}`);
        for(const n of result.notRead) out(`not-read ${n.subject} ${n.reason}`);
        for(const r of result.receipts) out(`receipt ${r.id} ${r.source} slot=${r.observation.blockOrSlot} sha256=${r.responseSha256}`);
      }
    }
    if(json) out(canonical({endpointHost:client.host,results}));
    return 0;
  } catch(error) {
    err(error instanceof PositionsRejected ? ["usage","no-addresses"].includes(error.code)?USAGE:error.code : "positions read failed: invalid input or configuration");
    return 1;
  }
}
