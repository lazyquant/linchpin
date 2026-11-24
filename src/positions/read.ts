import { readSolanaPositions } from "../solana/positions/read";
import type { SolanaRpcClient } from "../solana/positions/client";
import type { SolanaRegistry } from "../solana/positions/registry";
import { ID_PATTERN } from "../policy/evaluate";
import { PositionsRejected, type ReadInput, type ReadResult } from "./types";
export function isAbsentEvmPositionsModule(error: unknown, name: "read" | "client"): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND"
    && error.message.startsWith(`Cannot find module '../evm/positions/${name}' imported from `);
}
export class EthereumReaderLoadError extends Error {
  constructor() { super("ethereum reader failed to load"); }
}
export async function readPositions(input: ReadInput): Promise<ReadResult> {
  if(typeof input.snapshotId!=="string" || !ID_PATTERN.test(input.snapshotId)) throw new PositionsRejected("invalid-snapshot");
  if(!input.client) throw new PositionsRejected("missing-client");
  if(input.chain==="ethereum") {
    const mod=await import(`../evm/positions/${"read"}`).catch(error=>{
      if(isAbsentEvmPositionsModule(error,"read")) return null;
      throw new EthereumReaderLoadError();
    });
    if(mod) return mod.readEthereumPositions(input);
  }
  if(input.chain!=="solana") return {positions:[],receipts:[],notRead:[{subject:`${input.chain}:${input.address}`,reason:"chain-not-supported"}]};
  return readSolanaPositions({...input,client:input.client as SolanaRpcClient,registry:input.registry as SolanaRegistry | undefined});
}
