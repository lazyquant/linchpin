import { PublicKey } from "@solana/web3.js";
import { GovernanceAccountParser, Governance, Proposal, ProposalTransaction, Realm, getNativeTreasuryAddress, getProposalTransactionAddress, ProposalState, type ProgramAccount } from "@solana/spl-governance";
import type { RecordingRpc } from "../chain/rpc";
import { parseMint, parseTokenAccount, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, type MintState, type TokenAccountState } from "../chain/token-layout";

export type RawInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; dataHex: string };
export type ProposalTx = { address: string; optionIndex: number; index: number; holdUpTime: number; executedAt: number | null; executionStatus: number; instructions: RawInstruction[]; evidenceId: string };

export type ProposalBundle = {
  programId: string; programVersion: number;
  proposal: { address: string; name: string; descriptionLink: string; state: number; stateName: string; governance: string; governingTokenMint: string;
    options: { label: string; voteWeightRaw: string; voteResult: number; instructionsCount: number; instructionsExecutedCount: number }[];
    denyVoteWeightRaw: string | null; vetoVoteWeightRaw: string | null; draftAt: number | null; votingAt: number | null; votingCompletedAt: number | null; executingAt: number | null; closedAt: number | null; evidenceId: string };
  governance: { address: string; realm: string; governedAccount: string; nativeTreasury: string; baseVotingTime: number; votingCoolOffTime: number; minInstructionHoldUpTime: number; evidenceId: string };
  realm: { address: string; name: string; communityMint: string; councilMint: string | null; authority: string | null; evidenceId: string };
  transactions: ProposalTx[];
  tokenAccounts: Record<string, TokenAccountState & { slot: number | null; evidenceId: string }>;
  mints: Record<string, MintState & { slot: number | null; evidenceId: string }>;
};

const num = (v: any): number | null => (v == null ? null : Number(v.toString()));

export async function readProposalBundle(rpc: RecordingRpc, programId: PublicKey, programVersion: number, proposalPk: PublicKey): Promise<ProposalBundle> {
  const pInfo = await rpc.getAccountInfo(proposalPk);
  if (!pInfo.value) throw new Error(`proposal account not found: ${proposalPk.toBase58()}`);
  if (!pInfo.value.owner.equals(programId)) throw new Error(`proposal owner ${pInfo.value.owner.toBase58()} is not the expected governance program`);
  const proposal = GovernanceAccountParser(Proposal)(proposalPk, pInfo.value) as ProgramAccount<Proposal>;
  const a: any = proposal.account;

  const gInfo = await rpc.getAccountInfo(a.governance);
  if (!gInfo.value) throw new Error("governance account not found");
  const governance = GovernanceAccountParser(Governance)(a.governance, gInfo.value) as ProgramAccount<Governance>;
  const ga: any = governance.account;
  const rInfo = await rpc.getAccountInfo(ga.realm);
  if (!rInfo.value) throw new Error("realm account not found");
  const realm = GovernanceAccountParser(Realm)(ga.realm, rInfo.value) as ProgramAccount<Realm>;
  const ra: any = realm.account;
  const nativeTreasury = await getNativeTreasuryAddress(programId, a.governance);

  const transactions: ProposalTx[] = [];
  const options: any[] = a.options ?? [];
  for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
    const count = Number(options[optionIndex].instructionsCount ?? 0);
    for (let index = 0; index < count; index++) {
      const txPk = await getProposalTransactionAddress(programId, programVersion, proposalPk, optionIndex, index);
      const tInfo = await rpc.getAccountInfo(txPk);
      if (!tInfo.value) continue; // a missing transaction account stays visible as count > transactions.length
      const ptx = GovernanceAccountParser(ProposalTransaction)(txPk, tInfo.value) as ProgramAccount<ProposalTransaction>;
      const ta: any = ptx.account;
      transactions.push({ address: txPk.toBase58(), optionIndex, index, holdUpTime: Number(ta.holdUpTime), executedAt: num(ta.executedAt), executionStatus: Number(ta.executionStatus), evidenceId: tInfo.evidence.id,
        instructions: (ta.instructions ?? []).map((ix: any) => ({ programId: ix.programId.toBase58(), accounts: ix.accounts.map((m: any) => ({ pubkey: m.pubkey.toBase58(), isSigner: !!m.isSigner, isWritable: !!m.isWritable })), dataHex: Buffer.from(ix.data).toString("hex") })) });
    }
  }

  // Capture every token account and mint the instructions touch (owner → control edge; balance → share; decimals → units)
  const tokenAccounts: ProposalBundle["tokenAccounts"] = {}; const mints: ProposalBundle["mints"] = {};
  const touched = new Set<string>(transactions.flatMap((t) => t.instructions.flatMap((ix) => ix.accounts.map((m) => m.pubkey))));
  touched.add(a.governingTokenMint.toBase58());
  for (const addr of touched) {
    const info = await rpc.getAccountInfo(new PublicKey(addr));
    if (!info.value) continue;
    const owner = info.value.owner;
    if (!(owner.equals(TOKEN_PROGRAM) || owner.equals(TOKEN_2022_PROGRAM))) continue;
    if (info.value.data.length >= 165) tokenAccounts[addr] = { ...parseTokenAccount(info.value.data), slot: info.evidence.slot, evidenceId: info.evidence.id };
    else if (info.value.data.length >= 82) mints[addr] = { ...parseMint(info.value.data), slot: info.evidence.slot, evidenceId: info.evidence.id };
  }

  return {
    programId: programId.toBase58(), programVersion,
    proposal: { address: proposalPk.toBase58(), name: a.name, descriptionLink: a.descriptionLink, state: Number(a.state), stateName: ProposalState[a.state], governance: a.governance.toBase58(), governingTokenMint: a.governingTokenMint.toBase58(),
      options: options.map((o: any) => ({ label: o.label, voteWeightRaw: o.voteWeight.toString(), voteResult: Number(o.voteResult), instructionsCount: Number(o.instructionsCount), instructionsExecutedCount: Number(o.instructionsExecutedCount) })),
      denyVoteWeightRaw: a.denyVoteWeight?.toString() ?? null, vetoVoteWeightRaw: a.vetoVoteWeight?.toString() ?? null,
      draftAt: num(a.draftAt), votingAt: num(a.votingAt), votingCompletedAt: num(a.votingCompletedAt), executingAt: num(a.executingAt), closedAt: num(a.closedAt), evidenceId: pInfo.evidence.id },
    governance: { address: a.governance.toBase58(), realm: ga.realm.toBase58(), governedAccount: ga.governedAccount.toBase58(), nativeTreasury: nativeTreasury.toBase58(), baseVotingTime: Number(ga.config.baseVotingTime), votingCoolOffTime: Number(ga.config.votingCoolOffTime), minInstructionHoldUpTime: Number(ga.config.minInstructionHoldUpTime), evidenceId: gInfo.evidence.id },
    realm: { address: ga.realm.toBase58(), name: ra.name, communityMint: ra.communityMint.toBase58(), councilMint: ra.config?.councilMint?.toBase58() ?? null, authority: ra.authority?.toBase58() ?? null, evidenceId: rInfo.evidence.id },
    transactions, tokenAccounts, mints,
  };
}
