import { readSolanaPositions } from "../solana/positions/read";
import type { SolanaRpcClient } from "../solana/positions/client";
import type { SolanaRegistry } from "../solana/positions/registry";
import { ID_PATTERN } from "../policy/evaluate";
import { PositionsRejected, type ReadInput, type ReadResult } from "./types";
export async function readPositions(input: ReadInput): Promise<ReadResult> {
  if(typeof input.snapshotId!=="string" || !ID_PATTERN.test(input.snapshotId)) throw new PositionsRejected("invalid-snapshot");
  if(!input.client) throw new PositionsRejected("missing-client");
  if(input.chain!=="solana") return {positions:[],receipts:[],notRead:[{subject:`${input.chain}:${input.address}`,reason:"chain-not-supported"}]};
  return readSolanaPositions({...input,client:input.client as SolanaRpcClient,registry:input.registry as SolanaRegistry | undefined});
}
