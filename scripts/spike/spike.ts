import { Connection, PublicKey } from "@solana/web3.js";
import * as gov from "@solana/spl-governance";
const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");
const programId = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs");
const cases: Record<string,string> = { mip14_exec: "EyeY8hrThBWw5MMtsAmNrnc7BoJGAtHsfsxVf17cG7E1", mip14_opinion: "Cxzr7LNNE2UnfLiZLrCkeKXBzqvdF5DGMQtgoD8GPMUp" };
const out: any = { rpc: RPC, programId: programId.toBase58(), sdkExportsSample: Object.keys(gov).filter(k => /^get(Proposal|Governance|Realm|Native|TokenOwner)|Version|ProposalState|ExecutionStatus/.test(k)) };
const s = (v: any) => v?.toBase58?.() ?? v?.toString?.() ?? v;
try { out.programVersion = await gov.getGovernanceProgramVersion(conn, programId); } catch (e) { out.programVersionError = String(e).slice(0,200); }
for (const [k, addr] of Object.entries(cases)) {
  const pk = new PublicKey(addr); const rec: any = {};
  try {
    const p = await gov.getProposal(conn, pk); const a: any = p.account;
    Object.assign(rec, { owner: s(p.owner), name: a.name, descriptionLink: a.descriptionLink, state: a.state, stateName: (gov as any).ProposalState?.[a.state], governance: s(a.governance), governingTokenMint: s(a.governingTokenMint), tokenOwnerRecord: s(a.tokenOwnerRecord), voteType: a.voteType, signatoriesCount: a.signatoriesCount, executionFlags: a.executionFlags });
    for (const f of ["draftAt","signingOffAt","votingAt","votingCompletedAt","executingAt","closedAt","votingAtSlot","denyVoteWeight","vetoVoteWeight","abstainVoteWeight","maxVoteWeight"]) if (a[f] != null) rec[f] = s(a[f]);
    rec.options = (a.options ?? []).map((o: any) => ({ label: o.label, voteWeight: s(o.voteWeight), voteResult: o.voteResult, instructionsCount: o.instructionsCount, instructionsExecutedCount: o.instructionsExecutedCount, transactionsCount: o.transactionsCount, transactionsExecutedCount: o.transactionsExecutedCount, instructionsNextIndex: o.instructionsNextIndex, transactionsNextIndex: o.transactionsNextIndex }));
    try {
      const g = await gov.getGovernance(conn, a.governance); const ga: any = g.account;
      rec.governanceAccount = { realm: s(ga.realm), governedAccount: s(ga.governedAccount), proposalCount: ga.proposalCount, activeProposalCount: s(ga.activeProposalCount), config: Object.fromEntries(Object.entries(ga.config ?? {}).map(([kk,vv]: any) => [kk, typeof vv === "object" && vv !== null && !vv.toBase58 && !vv.toString ? vv : s(vv)])) };
      const r = await gov.getRealm(conn, ga.realm); const ra: any = r.account;
      rec.realm = { pubkey: s(ga.realm), name: ra.name, communityMint: s(ra.communityMint), councilMint: s(ra.config?.councilMint), authority: s(ra.authority), communityVoterWeightAddin: s(ra.config?.communityVoterWeightAddin), reserved: undefined };
    } catch (e) { rec.governanceError = String(e).slice(0,200); }
    rec.transactions = [];
    const version = out.programVersion ?? 3;
    const optCount = Math.max(1, rec.options.length);
    for (let oi = 0; oi < optCount; oi++) {
      const n = rec.options[oi]?.transactionsCount ?? rec.options[oi]?.instructionsCount ?? 0;
      for (let ti = 0; ti < Math.max(n, 1); ti++) {
        try {
          const txPk = await gov.getProposalTransactionAddress(programId, version, pk, oi, ti);
          const info = await conn.getAccountInfo(txPk);
          if (!info) { rec.transactions.push({ optionIndex: oi, index: ti, address: s(txPk), exists: false }); continue; }
          const ptx = await gov.getGovernanceAccount(conn, txPk, gov.ProposalTransaction); const ta: any = ptx.account;
          rec.transactions.push({ optionIndex: oi, index: ti, address: s(txPk), exists: true, dataBytes: info.data.length, holdUpTime: ta.holdUpTime, executedAt: s(ta.executedAt), executionStatus: ta.executionStatus, instructions: (ta.instructions ?? []).map((ix: any) => ({ programId: s(ix.programId), accounts: (ix.accounts ?? []).map((m: any) => ({ pubkey: s(m.pubkey), isSigner: m.isSigner, isWritable: m.isWritable })), dataHex: Buffer.from(ix.data).toString("hex") })) });
        } catch (e) { rec.transactions.push({ optionIndex: oi, index: ti, error: String(e).slice(0,200) }); }
      }
    }
    const first = rec.transactions.find((t: any) => t.exists);
    if (first) {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(first.address), { limit: 30 });
      rec.txAccountSignatures = sigs.map(x => ({ signature: x.signature, slot: x.slot, blockTime: x.blockTime, err: x.err })).sort((a,b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      const execAt = Number(first.executedAt ?? 0);
      const cand = rec.txAccountSignatures.find((x: any) => execAt && x.blockTime && x.blockTime >= execAt - 5 && !x.err) ?? rec.txAccountSignatures.at(-1);
      if (cand) {
        const tx = await conn.getTransaction(cand.signature, { maxSupportedTransactionVersion: 0 });
        const keys = tx?.transaction.message.getAccountKeys?.({ accountKeysFromLookups: tx.meta?.loadedAddresses }) ;
        const keyList: string[] = keys ? Array.from({ length: keys.length }, (_, i) => s(keys.get(i))) : [];
        rec.executionTx = { signature: cand.signature, slot: tx?.slot, blockTime: tx?.blockTime, err: tx?.meta?.err ?? null, fee: tx?.meta?.fee, accountKeys: keyList, programIdsTopLevel: tx?.transaction.message.compiledInstructions?.map((ci: any) => keyList[ci.programIdIndex]), innerPrograms: tx?.meta?.innerInstructions?.flatMap(ii => ii.instructions.map((x: any) => keyList[x.programIdIndex])), preTokenBalances: tx?.meta?.preTokenBalances?.map(b => ({ idx: b.accountIndex, acct: keyList[b.accountIndex], mint: b.mint, owner: b.owner, ui: b.uiTokenAmount.uiAmountString })), postTokenBalances: tx?.meta?.postTokenBalances?.map(b => ({ idx: b.accountIndex, acct: keyList[b.accountIndex], mint: b.mint, owner: b.owner, ui: b.uiTokenAmount.uiAmountString })), logs: tx?.meta?.logMessages?.slice(0, 40) };
      }
    }
  } catch (e) { rec.error = String(e).slice(0,300); }
  out[k] = rec;
}
try { const t0 = Date.now(); const list = await (gov as any).getProposalsByGovernance(conn, programId, new PublicKey(out.mip14_exec.governance)); out.gpaProposalsForGovernance = { count: list.length, ms: Date.now() - t0, sample: list.slice(0, 6).map((p: any) => ({ pubkey: s(p.pubkey), name: p.account.name, state: p.account.state })) }; } catch (e) { out.gpaError = String(e).slice(0, 300); }
console.log(JSON.stringify(out, null, 1));
