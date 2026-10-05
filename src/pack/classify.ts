import { PublicKey, SystemProgram, type Connection, type GetProgramAccountsConfig } from "@solana/web3.js";
import { getGovernanceAccounts, getNativeTreasuryAddress, Governance, pubkeyFilter } from "@solana/spl-governance";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { RecordingRpc } from "../chain/rpc";
import type { Evidence } from "../chain/evidence";
import { parseMint, parseTokenAccount, TOKEN_PROGRAM, type MintState, type TokenAccountState } from "../chain/token-layout";

const SQUADS_V4 = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const SQUADS_V3 = new PublicKey("SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu");

export type AuthorityContext = { program: PublicKey; governances: PublicKey[] };
type Provenance = { slot: number | null; evidenceIds: string[] };
type AuthorityBase = Provenance & { address: string; onCurve: boolean; owner: string | null };
export type AuthorityClassification = AuthorityBase & (
  | { kind: "dao-governance-account" | "squads-v4-account" | "squads-v3-account" | "wallet" | "pda-no-account" | "wallet-no-account" | "program-owned" }
  | { kind: "native-treasury-pda"; governance: string }
  // `owner` always means the on-chain account owner; tokenOwner is the token authority.
  | { kind: "token-account"; mint: string; tokenOwner: string; amountRaw: bigint }
);

export async function classifyAuthority(rpc: RecordingRpc, address: PublicKey, ctx: AuthorityContext): Promise<AuthorityClassification> {
  const info = await rpc.getAccountInfo(address);
  const base: AuthorityBase = { address: address.toBase58(), onCurve: PublicKey.isOnCurve(address.toBytes()), owner: info.value?.owner.toBase58() ?? null, slot: info.evidence.slot, evidenceIds: [info.evidence.id] };
  for (const governance of ctx.governances) {
    if (address.equals(await getNativeTreasuryAddress(ctx.program, governance)))
      return { ...base, kind: "native-treasury-pda", governance: governance.toBase58() };
  }
  if (!info.value) return { ...base, kind: base.onCurve ? "wallet-no-account" : "pda-no-account" };
  const { owner, data } = info.value;
  if (owner.equals(ctx.program)) return { ...base, kind: "dao-governance-account" };
  if (owner.equals(SQUADS_V4)) return { ...base, kind: "squads-v4-account" };
  if (owner.equals(SQUADS_V3)) return { ...base, kind: "squads-v3-account" };
  if (owner.equals(TOKEN_PROGRAM) && data.length === 165) {
    const token = parseTokenAccount(data);
    return { ...base, kind: "token-account", mint: token.mint, tokenOwner: token.owner, amountRaw: token.amountRaw };
  }
  if (owner.equals(SystemProgram.programId) && base.onCurve) return { ...base, kind: "wallet" };
  return { ...base, kind: "program-owned" };
}

export type StateRead<T> = Provenance & { address: string; value: T | null };

/** Nonexistent accounts and accounts outside the legacy SPL layout retain evidence but no parsed value. */
export async function readMintState(rpc: RecordingRpc, mint: PublicKey): Promise<StateRead<MintState>> {
  const info = await rpc.getAccountInfo(mint);
  return { address: mint.toBase58(), value: info.value?.owner.equals(TOKEN_PROGRAM) && info.value.data.length === 82 ? parseMint(info.value.data) : null, slot: info.evidence.slot, evidenceIds: [info.evidence.id] };
}

export async function readTokenAccount(rpc: RecordingRpc, account: PublicKey): Promise<StateRead<TokenAccountState>> {
  const info = await rpc.getAccountInfo(account);
  return { address: account.toBase58(), value: info.value?.owner.equals(TOKEN_PROGRAM) && info.value.data.length === 165 ? parseTokenAccount(info.value.data) : null, slot: info.evidence.slot, evidenceIds: [info.evidence.id] };
}

export function associatedTokenAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

export type GovernanceEntry = Provenance & { address: string; realm: string; nativeTreasury: string };

export async function listGovernances(rpc: RecordingRpc, program: PublicKey, realm: PublicKey): Promise<{ governances: GovernanceEntry[]; evidenceIds: string[] }> {
  const evidenceIds: string[] = [];
  const accountEvidence = new Map<string, Evidence>();
  // The installed SDK only uses commitment and getProgramAccounts. This adapter
  // routes all its account-type queries through record/replay, never the raw connection.
  const connection = {
    commitment: "confirmed",
    getProgramAccounts: async (programId: PublicKey, config: GetProgramAccountsConfig) => {
      const result = await rpc.getProgramAccounts(programId, config.filters ?? []);
      evidenceIds.push(result.evidence.id);
      for (const entry of result.value) accountEvidence.set(entry.pubkey.toBase58(), result.evidence);
      return result.value;
    },
  } as unknown as Connection;
  const accounts = await getGovernanceAccounts(connection, program, Governance, [pubkeyFilter(1, realm)!]);
  const governances = await Promise.all(accounts.map(async account => {
    const address = account.pubkey.toBase58();
    const evidence = accountEvidence.get(address)!;
    return { address, realm: account.account.realm.toBase58(), nativeTreasury: (await getNativeTreasuryAddress(program, account.pubkey)).toBase58(), slot: evidence.slot, evidenceIds: [evidence.id] };
  }));
  return { governances, evidenceIds };
}
