import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { PositionsRejected } from "./types";
import { validateSolanaAddress } from "../solana/positions/read";
export function parseAddressArg(value: string): {chain:string; address:string} {
  if(typeof value!=="string" || !/^[a-z][a-z0-9-]*:[^\s:]+$/.test(value)) throw new PositionsRejected("malformed-address");
  const split=value.indexOf(":"), chain=value.slice(0,split), address=value.slice(split+1);
  if(chain==="solana") validateSolanaAddress(address);
  return {chain,address};
}
export async function loadAddressesFile(home: string): Promise<{chain:string; address:string}[]> {
  let handle;
  try { handle=await open(join(home,".linchpin","addresses.json"),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
  catch(error) { throw new PositionsRejected((error as {code?:string}).code==="ENOENT"?"no-addresses":"addresses file must be mode 0600"); }
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || (stat.mode & 0o077)!==0) throw new PositionsRejected("addresses file must be mode 0600");
    let values:unknown;
    try { values=JSON.parse(await handle.readFile("utf8")); } catch { throw new PositionsRejected("invalid-addresses-file"); }
    if(!Array.isArray(values) || !values.length || values.some(v=>typeof v!=="string")) throw new PositionsRejected("invalid-addresses-file");
    return values.map(parseAddressArg);
  } finally { await handle.close(); }
}
