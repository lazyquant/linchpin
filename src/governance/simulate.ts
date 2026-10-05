import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createBurnInstruction } from "@solana/spl-token";
import type { RecordingRpc } from "../chain/rpc";
import { sha256 } from "../chain/evidence";
import { parseMint, parseTokenAccount, TOKEN_PROGRAM } from "../chain/token-layout";
import type { RawInstruction } from "./reader";

export type SimulationRun = {
  id: string; kind: "historical-payload" | "fixture"; mode: "conditional-preview"; label: string;
  assumptions: string[]; feePayer: string; config: { sigVerify: false; replaceRecentBlockhash: true; commitment: "confirmed" };
  messageSha256: string; contextSlot: number | null; success: boolean; error: unknown; unitsConsumed: number | null; logs: string[];
  postState: { tokenAccounts: Record<string, string>; mintSupplies: Record<string, string> }; evidenceIds: string[];
};

export function toTransactionInstruction(ix: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.dataHex, "hex") });
}

/** A fixture that reuses the proposal's accounts but burns one whole token (10^decimals raw). Always labelled; never confused with the payload. */
export function fixtureBurn(source: PublicKey, mint: PublicKey, authority: PublicKey, decimals: number): TransactionInstruction {
  return createBurnInstruction(source, mint, authority, 10n ** BigInt(decimals), [], TOKEN_PROGRAM);
}

export async function simulateConditionalPreview(rpc: RecordingRpc, args: { kind: SimulationRun["kind"]; label: string; instructions: TransactionInstruction[]; feePayer: PublicKey; watch: { tokenAccounts: PublicKey[]; mints: PublicKey[] }; assumptions: string[] }): Promise<SimulationRun> {
  const message = new TransactionMessage({ payerKey: args.feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: args.instructions }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  const addresses = [...args.watch.tokenAccounts, ...args.watch.mints].map((p) => p.toBase58());
  const config = { sigVerify: false as const, replaceRecentBlockhash: true as const, commitment: "confirmed" as const, accounts: { encoding: "base64" as const, addresses } };
  const res = await rpc.simulate(tx, config);
  const v: any = res.value;
  const postState = { tokenAccounts: {} as Record<string, string>, mintSupplies: {} as Record<string, string> };
  (v.accounts ?? []).forEach((acct: any, i: number) => {
    if (!acct?.data?.[0]) return;
    const data = Buffer.from(acct.data[0], "base64"); const addr = addresses[i];
    if (i < args.watch.tokenAccounts.length) postState.tokenAccounts[addr] = parseTokenAccount(data).amountRaw.toString();
    else postState.mintSupplies[addr] = parseMint(data).supplyRaw.toString();
  });
  const messageSha256 = sha256(Buffer.from(message.serialize()));
  return { id: `sim-${messageSha256.slice(0, 12)}`, kind: args.kind, mode: "conditional-preview", label: args.label, assumptions: args.assumptions, feePayer: args.feePayer.toBase58(), config: { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }, messageSha256, contextSlot: res.evidence.slot, success: v.err == null, error: v.err ?? null, unitsConsumed: v.unitsConsumed ?? null, logs: v.logs ?? [], postState, evidenceIds: [res.evidence.id] };
}

export const PREVIEW_ASSUMPTIONS = [
  "signature verification disabled (sigVerify=false): the governance native-treasury PDA is marked as signer, which an ordinary transaction cannot do",
  "the recent blockhash is replaced by the RPC node; the run is not submittable",
  "state is the cluster's current state at contextSlot, not the pre-execution state of the historical proposal",
  "a successful preview does not prove that governance currently permits execution or that a vote has passed",
];
