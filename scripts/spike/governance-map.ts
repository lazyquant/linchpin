// Read-only spike (Claude, 2026-10-06): all governances of the Marinade DAO realm, their voting configuration and treasuries; council token holders of both realms.
import { Connection, PublicKey } from "@solana/web3.js";
import { getGovernanceAccounts, Governance, pubkeyFilter, getRealm, getNativeTreasuryAddress, VoteThresholdType } from "@solana/spl-governance";
const c = new Connection(process.env.LINCHPIN_RPC_URL!, "confirmed");
const MARINADE = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs");
const realm = new PublicKey("899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo");
const thr = (t: any) => !t ? "-" : t.type === VoteThresholdType.Disabled ? "off" : `${t.value}%`;
const govs = await getGovernanceAccounts(c, MARINADE, Governance, [pubkeyFilter(1, realm)!]);
const known: Record<string, string> = {
  "42VJbDihcS81YJPbuhHnHgvo1ehu42j8VK9sNwrnAarR": "liquid-staking admin authority", "B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG": "DAO treasury (MNDE 189.7 M)",
  "J5BEceL5z1EQ7JBqEFu4BfPN4PYCeQaW3GXrzXFfCzhs": "docs 'Labs Treasury' (MNDE 117.2 M)", "6YAju4nd4t7kyuHV6NvVpMepMk11DgWyYjKVJUak2EEm": "Native proxy upgrade authority",
};
console.log(`realm Marinade DAO: ${govs.length} governances`);
for (const g of govs) {
  const cfg: any = g.account.config, nt = (await getNativeTreasuryAddress(MARINADE, g.pubkey)).toBase58(), gov = g.pubkey.toBase58();
  console.log(`  ${gov.slice(0, 8)} community ${thr(cfg.communityVoteThreshold)} (veto ${thr(cfg.communityVetoVoteThreshold)}) · council ${thr(cfg.councilVoteThreshold)} (veto ${thr(cfg.councilVetoVoteThreshold)}) · propose: community ${cfg.minCommunityTokensToCreateProposal.toString().length > 15 ? "never" : (Number(cfg.minCommunityTokensToCreateProposal) / 1e9).toLocaleString()} MNDE, council ${cfg.minCouncilTokensToCreateProposal} · native treasury ${nt.slice(0, 8)}${known[nt] ? " = " + known[nt] : ""}${known[gov] ? " · governance = " + known[gov] : ""}`);
}
for (const [label, mint] of [["Marinade DAO council mint", "6MGwpuJ5YE1c8jJaF8FKurQdDJeYRf1adX76dovkXxRs"], ["Emergency Council mint", null]] as const) {
  let m = mint;
  if (!m) { const r = await getRealm(c, new PublicKey("kY9p6fzZQuYfRuHQSm3u6aLWA9c4Mid3ALWE9NaKEtW")); m = r.account.config.councilMint!.toBase58(); }
  const supply = await c.getTokenSupply(new PublicKey(m)); const largest = await c.getTokenLargestAccounts(new PublicKey(m));
  console.log(`${label} ${m.slice(0, 8)}…: supply ${supply.value.uiAmountString} (decimals ${supply.value.decimals})`);
  for (const a of largest.value.filter(x => Number(x.amount) > 0)) {
    const acc = await c.getAccountInfo(a.address); const owner = new PublicKey(acc!.data.subarray(32, 64)); const oi = await c.getAccountInfo(owner);
    console.log(`   holder token account ${a.address.toBase58().slice(0, 8)}… amount ${a.uiAmountString} · owner ${owner.toBase58().slice(0, 8)}… ${oi ? `owned by ${oi.owner.toBase58().slice(0, 8)}…` : "no account"} · onCurve ${PublicKey.isOnCurve(owner.toBytes())}`);
  }
}
// governance token-owner records hold deposited council tokens; count them per realm
for (const [label, prog, rlm, mint] of [["Marinade DAO", MARINADE, realm, "6MGwpuJ5YE1c8jJaF8FKurQdDJeYRf1adX76dovkXxRs"]] as const) {
  const tor = await c.getProgramAccounts(prog, { filters: [{ memcmp: { offset: 1, bytes: rlm.toBase58() } }, { memcmp: { offset: 33, bytes: mint } }] });
  console.log(`${label}: ${tor.length} token-owner records for the council mint (deposited council tokens)`);
  for (const t of tor) { const owner = new PublicKey(t.account.data.subarray(65, 97)); const amt = t.account.data.readBigUInt64LE(97); console.log(`   owner ${owner.toBase58()} deposited ${amt}`); }
}
