import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { getAccountTypes, Governance } from "@solana/spl-governance";
import bs58 from "bs58";
import { RecordingRpc } from "../src/chain/rpc";
import { UPGRADEABLE_LOADER } from "../src/chain/program-authority";
import { runOptions } from "../src/config";
import { buildPack, type PackRegistry, type PackFile } from "../src/pack/build";
import { coverageLine, renderJson, renderPackHtml } from "../src/pack/packet";

const config: PackFile = JSON.parse(readFileSync("packs/marinade/pack.json", "utf8"));
const registry: PackRegistry = JSON.parse(readFileSync(config.registry, "utf8"));
const docsCapture = JSON.parse(readFileSync(config.docsCapture, "utf8"));
function offlineRpc() {
  const rpc = new RecordingRpc(runOptions({ offline: true, rpcUrl: "http://127.0.0.1:1" }), "marinade-pack");
  rpc.connection.getAccountInfoAndContext = async () => { throw new Error("offline attempted network"); };
  rpc.connection.getProgramAccounts = async () => { throw new Error("offline attempted network"); };
  return rpc;
}
const generatedAt = "2026-10-06T12:00:00Z";
const rpc = offlineRpc();
const packet = await buildPack(rpc, registry, { ...config, docsCapture, generatedAt });
const program = (id: string) => packet.controllerPaths.find(p => p.subject === registry.programs.find(e => e.id === id)!.address)!;

test("offline pack covers the declared boundary with evidence and recorded context slots", () => {
  expect(packet.controllerPaths).toHaveLength(registry.programs.length + registry.mints.length * 2 + registry.accounts.length);
  expect(packet.offline).toBe(true);
  expect(packet.evidenceCount).toBe(rpc.evidence.length);
  expect(rpc.evidence.every(e => e.source === "fixture")).toBe(true);
  const ids = new Set(rpc.evidence.map(e => e.id));
  for (const row of [...packet.controllerPaths, ...packet.statements]) {
    expect(row.slot).not.toBeNull();
    expect(row.evidenceIds.length).toBeGreaterThan(0);
    expect(row.evidenceIds.every(id => ids.has(id))).toBe(true);
  }
  const { total, verified, claimed, contradiction, unresolved } = packet.coverage;
  expect(total).toBe(verified + claimed + contradiction + unresolved);
  expect(packet.asOfSlotRange).toEqual([Math.min(...rpc.evidence.map(e => e.slot!)), Math.max(...rpc.evidence.map(e => e.slot!))]);
});

test("recorded Native and council controllers follow derived treasury PDAs to the realm", () => {
  expect(program("native-staking-proxy")).toMatchObject({ status: "verified", authorityKind: "native-treasury-pda", path: [registry.programs.find(p => p.id === "native-staking-proxy")!.address, "6YAju4nd4t7kyuHV6NvVpMepMk11DgWyYjKVJUak2EEm", "7iUtTuZAh2Len8LiC1u68gUMPMsKh9kce9bcbdGwtBZY", registry.governance.realm] });
  expect(program("governance-program")).toMatchObject({ status: "verified", authorityKind: "dao-governance-account" });
  expect(packet.controllerPaths.find(p => p.role === "council-mint" && p.authorityType === "mint")).toMatchObject({ status: "verified", path: [registry.governance.councilMint, "26Pw2qvaHgnvHPD73pWr6EUWchpTF3bEzVbEoDPLS21D", "FsrqQfLGdFVtySSSsyZJUzVBA9bvGZSKyhp7nsJCqgJe", registry.governance.realm] });
  expect(packet.statements.find(s => s.id === "council-mint-state")).toMatchObject({ status: "verified" });
  expect(packet.claims.find(c => c.id === "council-mint-claim-1")?.status).toBe("verified");
});

test("unknown authority is unresolved, and every unresolved path and seed has a dated unknown", () => {
  expect(program("liquid-staking")).toMatchObject({ status: "unresolved", authorityKind: "pda-no-account" });
  for (const seed of registry.unknownsSeed) expect(packet.unknowns.some(u => u.text === seed && !!u.firstSeen)).toBe(true);
  for (const p of packet.controllerPaths.filter(p => p.status === "unresolved")) expect(packet.unknowns.some(u => u.id === `${p.subject}-${p.authorityType}` && !!u.firstSeen)).toBe(true);
});

test("recorded contradictions preserve both texts and identify the agreeing claim", () => {
  const row = program("validator-gauges");
  expect(row.status).toBe("contradiction");
  expect(row.note).toStartWith("Chain:");
  expect(row.note).toContain("Agreeing claim: “DAO holds upgrade authority for gauges”");
  expect(row.claims).toEqual(registry.programs.find(p => p.id === "validator-gauges")!.claims!);
  expect(program("liquidity-gauges").status).toBe("contradiction");
  expect(packet.claims.find(c => c.id === "governance-program-claim-1")?.status).toBe("claimed");
  expect(packet.claims.filter(c => /^v\d+$/.test(c.id)).every(c => c.status === "claimed")).toBe(true);
});

test("supply uses recorded state, not the older registry snapshot, and treasury token balances are exact", () => {
  expect(packet.statements.find(s => s.id === "mnde-supply")?.text).toContain("2,952.323033701 tokens unexplained");
  expect(packet.statements.find(s => s.id === "mnde-supply")?.text).toContain(config.burns!.mnde[0].signature);
  expect(packet.statements.find(s => s.id === "mnde-supply")?.status).toBe("claimed");
  expect(packet.statements.find(s => s.id === "buyback-accumulation-mnde-ata")?.text).toContain("raw MNDE");
  expect(packet.statements.find(s => s.id === "dao-treasury-mnde-token-account-tokens")?.text).toContain("raw units of mint MNDE");
});

test("historical burn input matches the existing MIP-14 receipt", async () => {
  const receiptRpc = new RecordingRpc(runOptions({ offline: true, rpcUrl: "http://127.0.0.1:1" }), "mip-14");
  const burn = config.burns!.mnde[0];
  const { value: receipt } = await receiptRpc.getTransaction(burn.signature);
  expect(receipt!.slot).toBe(burn.slot);
  expect(receipt!.meta!.err).toBeNull();
  const pre = receipt!.meta!.preTokenBalances![0];
  const post = receipt!.meta!.postTokenBalances!.find(p => p.accountIndex === pre.accountIndex)!;
  expect((BigInt(pre.uiTokenAmount.amount) - BigInt(post.uiTokenAmount.amount)).toString()).toBe(burn.amountRaw);
});

test("JSON and light HTML preserve claim text and provenance, escape content, and need no network assets", () => {
  expect(JSON.parse(renderJson(packet))).toEqual(packet);
  const html = renderPackHtml(packet, registry.governance.realm);
  expect(html).toContain('data-theme="light"');
  expect(html).toContain(coverageLine(packet));
  expect(html).toContain(docsCapture.retrievedAt);
  expect(html).toContain(registry.governance.realm);
  expect(html).not.toContain("<script");
  expect(html).toContain("Marinade council (3/5) listed as upgrade authority");
  const hostile = renderPackHtml({ ...packet, title: '<script>alert("x")</script>', researchQuestion: "<img src=x>" }, "<realm>");
  expect(hostile).not.toContain("<img");
  expect(hostile).not.toContain("<script");
  expect(hostile).toContain("&lt;realm&gt;");
});

function synthetic(kind: "dao" | "squads" | "immutable" | "missing" | "foreign-realm" = "dao") {
  const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
  const govProgram = key(9), realm = key(8), governance = key(7), subject = key(6), programData = key(5);
  const account = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1, executable: false, rentEpoch: 0 });
  const gd = Buffer.alloc(236); gd[0] = getAccountTypes(Governance)[0]; realm.toBuffer().copy(gd, 1);
  const pd = Buffer.alloc(45); pd.writeUInt32LE(3); pd.writeBigUInt64LE(40n, 4); pd[12] = kind === "immutable" ? 0 : 1; governance.toBuffer().copy(pd, 13);
  const pr = Buffer.alloc(36); pr.writeUInt32LE(2); programData.toBuffer().copy(pr, 4);
  const r = new RecordingRpc(runOptions({ rpcUrl: "http://127.0.0.1:1", offline: false }), "synthetic-pack");
  r.connection.getAccountInfoAndContext = async address => ({ context: { slot: 42 }, value: address.equals(subject) ? account(UPGRADEABLE_LOADER, pr) : address.equals(programData) ? account(UPGRADEABLE_LOADER, pd) : kind === "missing" ? null : account(kind === "squads" ? new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf") : govProgram, gd) });
  (r.connection as any).getProgramAccounts = async (_id: PublicKey, options: { filters: { memcmp: { bytes: string } }[] }) => ({ context: { slot: 41 }, value: kind !== "foreign-realm" && bs58.decode(options.filters[0].memcmp.bytes)[0] === gd[0] ? [{ pubkey: governance, account: account(govProgram, gd) }] : [] });
  const input: PackRegistry = { pack: "synthetic", title: "Synthetic", retrievedAt: generatedAt, researchQuestion: "Who controls it?", sources: {},
    programs: [{ id: "synthetic-program", address: subject.toBase58(), claims: [{ text: "DAO holds upgrade authority for synthetic program", source: "governance-page" }, { text: "Marinade council (3/5) listed as upgrade authority", source: "contract-page" }] }], mints: [], accounts: [],
    governance: { program: govProgram.toBase58(), realm: realm.toBase58(), councilMint: key(4).toBase58(), knownGovernances: [], claims: [] }, valueRouteClaims: [], unknownsSeed: [] };
  return { r, input, subject, governance, realm };
}

test("synthetic conflicting claims with DAO authority produce a chain-first contradiction naming the agreeing claim", async () => {
  const { r, input, subject, governance, realm } = synthetic();
  const result = await buildPack(r, input);
  expect(result.controllerPaths[0]).toMatchObject({ status: "contradiction", path: [subject.toBase58(), governance.toBase58(), governance.toBase58(), realm.toBase58()] });
  expect(result.controllerPaths[0].note).toStartWith("Chain:");
  expect(result.controllerPaths[0].note).toContain("Agreeing claim: “DAO holds upgrade authority for synthetic program” (governance-page)");
  expect(result.claims.map(c => c.status)).toEqual(["verified", "contradiction"]);
});

test.each(["squads", "immutable", "foreign-realm"] as const)("synthetic %s keeps controller limits explicit", async kind => {
  const { r, input } = synthetic(kind); input.programs[0].claims = [];
  const result = await buildPack(r, input);
  if (kind === "squads") {
    expect(result.controllerPaths[0].status).toBe("verified");
    expect(result.controllerPaths[0].note).toContain("multisig members not read");
  } else if (kind === "immutable") {
    expect(result.statements[0]).toMatchObject({ status: "verified" });
    expect(result.statements[0].text).toContain("immutable program");
  } else {
    expect(result.controllerPaths[0].status).toBe("unresolved");
    expect(result.controllerPaths[0].path).toHaveLength(2);
  }
});
