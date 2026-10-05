import { PublicKey } from "@solana/web3.js";
import type { RecordingRpc } from "./rpc";

export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export type ProgramAuthority =
  | { kind: "upgradeable"; program: string; programData: string; lastDeploySlot: number; upgradeAuthority: string | null; upgradeable: boolean; slot: number | null; evidenceIds: string[] }
  | { kind: "not-upgradeable-loader" | "not-found"; program: string; owner: string | null; evidenceIds: string[] };

export async function readProgramAuthority(rpc: RecordingRpc, program: PublicKey): Promise<ProgramAuthority> {
  const p = await rpc.getAccountInfo(program);
  if (!p.value) return { kind: "not-found", program: program.toBase58(), owner: null, evidenceIds: [p.evidence.id] };
  if (!p.value.owner.equals(UPGRADEABLE_LOADER) || p.value.data.length < 36 || p.value.data.readUInt32LE(0) !== 2)
    return { kind: "not-upgradeable-loader", program: program.toBase58(), owner: p.value.owner.toBase58(), evidenceIds: [p.evidence.id] };
  const programData = new PublicKey(p.value.data.subarray(4, 36));
  const d = await rpc.getAccountInfo(programData);
  if (!d.value) return { kind: "not-found", program: program.toBase58(), owner: null, evidenceIds: [p.evidence.id, d.evidence.id] };
  const b = d.value.data; const has = b[12] === 1;
  return { kind: "upgradeable", program: program.toBase58(), programData: programData.toBase58(), lastDeploySlot: Number(b.readBigUInt64LE(4)), upgradeAuthority: has ? new PublicKey(b.subarray(13, 45)).toBase58() : null, upgradeable: has, slot: d.evidence.slot, evidenceIds: [p.evidence.id, d.evidence.id] };
}
