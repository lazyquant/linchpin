// Read-only spike (Claude, 2026-10-06): voting configuration of the governances that hold Marinade authorities and treasuries.
import { Connection, PublicKey } from "@solana/web3.js";
import { getGovernance, getRealm, getNativeTreasuryAddress, VoteThresholdType } from "@solana/spl-governance";
const c = new Connection(process.env.LINCHPIN_RPC_URL!, "confirmed");
const MARINADE = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs"), DEFAULT = new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
const targets: [string, string, PublicKey][] = [
  ["admin authority (fees, roles)", "M5Fg6GipNvPzWgXNr5wj1EDcp8GB9J53cgyE7YGYLbL", MARINADE],
  ["DAO treasury B56RWQ (MNDE)", "8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq", MARINADE],
  ["Native proxy upgrade authority", "7iUtTuZAh2Len8LiC1u68gUMPMsKh9kce9bcbdGwtBZY", MARINADE],
  ["Emergency Council (pause)", "AnLvKtpy8Z3GWKgpZsCHuo2kykGKj1VoZBLVfthqfZx3", DEFAULT],
];
const thr = (t: any) => !t ? "-" : t.type === VoteThresholdType.Disabled ? "disabled" : `${VoteThresholdType[t.type]} ${t.value ?? ""}`;
// find the governance whose native treasury is J5BEce… (the docs' "Labs Treasury")
const LABS = "J5BEceL5z1EQ7JBqEFu4BfPN4PYCeQaW3GXrzXFfCzhs";
const realm = new PublicKey("899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo");
const govs = await c.getProgramAccounts(MARINADE, { filters: [{ memcmp: { offset: 1, bytes: realm.toBase58() } }], dataSlice: { offset: 0, length: 0 } });
for (const g of govs) { const nt = await getNativeTreasuryAddress(MARINADE, g.pubkey); if (nt.toBase58() === LABS) targets.push(["docs 'Labs Treasury' J5BEce", g.pubkey.toBase58(), MARINADE]); }
for (const [label, addr, program] of targets) {
  try {
    const g = await getGovernance(c, new PublicKey(addr)); const cfg: any = g.account.config;
    const r = await getRealm(c, g.account.realm);
    console.log(`${label} · governance ${addr.slice(0, 8)}… · realm "${r.account.name}" · community vote ${thr(cfg.communityVoteThreshold)} · council vote ${thr(cfg.councilVoteThreshold)} · community veto ${thr(cfg.communityVetoVoteThreshold)} · council veto ${thr(cfg.councilVetoVoteThreshold)} · min community to propose ${cfg.minCommunityTokensToCreateProposal?.toString()} · min council to propose ${cfg.minCouncilTokensToCreateProposal?.toString()} · voting ${cfg.baseVotingTime ?? cfg.maxVotingTime}s · hold-up ${cfg.minInstructionHoldUpTime}s · council mint ${r.account.config.councilMint?.toBase58().slice(0, 8) ?? "none"}`);
  } catch (e) { console.log(`${label} ${addr}: ${(e as Error).message.slice(0, 120)}`); }
}
