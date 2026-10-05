import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { getAccountTypes, getNativeTreasuryAddress, Governance } from "@solana/spl-governance";
import bs58 from "bs58";
import { RecordingRpc } from "../src/chain/rpc";
import { UPGRADEABLE_LOADER } from "../src/chain/program-authority";
import { runOptions } from "../src/config";
import { buildPack, type PackRegistry, type PackFile } from "../src/pack/build";
import { coverageLine, renderJson, renderPackHtml } from "../src/pack/packet";
import { TOKEN_PROGRAM } from "../src/chain/token-layout";
import { deriveLiquidStakingAddresses, LIQUID_STAKING_PROGRAM } from "../src/pack/derive";

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

test("recorded liquid-staking authorities follow matching candidate seeds", () => {
  for (const seed of ["st_mint", "liq_mint", "withdraw", "reserve"]) {
    const derived = deriveLiquidStakingAddresses().find(candidate => candidate.seed === seed)!;
    const row = packet.controllerPaths.find(p => p.authority === derived.address)!;
    expect(row).toMatchObject({ status: "verified", path: [row.subject, derived.address, derived.program] });
    expect(row.note).toContain(`program-derived address: seed '${seed}' of the liquid-staking state`);
  }
  const reserve = packet.controllerPaths.find(p => p.authority === "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN")!;
  expect(reserve.authorityKind).toBe("pda-system");
});

test.each([
  ["B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR", "89SrbjbuNyqSqAALKBsKBqMSh463eLvzS4iVWCeArBgB"],
  ["8ZUcztoAEhpAeC2ixWewJKQJsSUGYSGPVAjkhDJYf5Gd", "7Q42pBSxR8bbWJkhSQZLDqpcR9xCv9z3zBSGPc7PdXkt"],
])("uncaptured treasury token owner stays unresolved for %s", async (subject, owner) => {
  expect(deriveLiquidStakingAddresses().some(candidate => candidate.address === owner)).toBe(false);
  // Explicitly exercise missing capture: later recordings may include this owner.
  const missingOwnerRpc = offlineRpc();
  const getAccountInfo = missingOwnerRpc.getAccountInfo.bind(missingOwnerRpc);
  missingOwnerRpc.getAccountInfo = async address => {
    if (address.toBase58() === owner) throw new Error("offline: fixture missing for getAccountInfo → synthetic missing owner");
    return getAccountInfo(address);
  };
  const missingOwnerPacket = await buildPack(missingOwnerRpc, registry, { ...config, docsCapture, generatedAt });
  const row = missingOwnerPacket.controllerPaths.find(p => p.subject === subject)!;
  expect(row).toMatchObject({ authority: owner, path: [subject, owner], status: "unresolved", authorityKind: "unclassified-token-owner" });
  expect(row.note).toContain("owner not yet captured");
  expect(row.evidenceIds.length).toBeGreaterThan(0);
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
  expect(result.controllerPaths[0]).toMatchObject({ status: "contradiction", path: [subject.toBase58(), governance.toBase58(), realm.toBase58()] });
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

async function syntheticTokenOwner(kind: "governance" | "treasury" | "derived-absent" | "derived-system" | "nonmatch" | "unsupported" | "other-program") {
  const { r, input, subject, governance, realm } = synthetic();
  input.programs = [];
  input.accounts = [{ id: "treasury-token", address: subject.toBase58() }];
  const govProgram = new PublicKey(input.governance.program);
  const derived = deriveLiquidStakingAddresses()[0];
  const owner = kind === "governance" ? governance : kind === "treasury" ? await getNativeTreasuryAddress(govProgram, governance)
    : kind === "nonmatch" || kind === "unsupported" ? PublicKey.findProgramAddressSync([Buffer.from("unmatched")], govProgram)[0] : new PublicKey(derived.address);
  const tokenData = Buffer.alloc(165);
  new PublicKey(input.governance.councilMint).toBuffer().copy(tokenData);
  owner.toBuffer().copy(tokenData, 32);
  const account = (program: PublicKey, data = Buffer.alloc(0)): AccountInfo<Buffer> => ({ owner: program, data, lamports: 1, executable: false, rentEpoch: 0 });
  const reads: string[] = [];
  r.connection.getAccountInfoAndContext = async address => {
    reads.push(address.toBase58());
    if (address.equals(subject)) return { context: { slot: 42 }, value: account(TOKEN_PROGRAM, tokenData) };
    if (!address.equals(owner)) throw new Error(`unexpected read: ${address}`);
    const value = kind === "derived-absent" ? null : kind === "governance" ? account(govProgram)
      : kind === "unsupported" ? account(TOKEN_PROGRAM, Buffer.alloc(82)) : kind === "other-program" ? account(LIQUID_STAKING_PROGRAM) : account(SystemProgram.programId);
    return { context: { slot: 43 }, value };
  };
  return { r, input, subject: subject.toBase58(), owner: owner.toBase58(), governance: governance.toBase58(), realm: realm.toBase58(), reads };
}

test.each(["governance", "treasury"] as const)("token owner read follows %s to its realm with evidence", async kind => {
  const s = await syntheticTokenOwner(kind);
  const result = await buildPack(s.r, s.input);
  const expectedPath = kind === "treasury" ? [s.subject, s.owner, s.governance, s.realm] : [s.subject, s.owner, s.realm];
  expect(result.controllerPaths[0]).toMatchObject({ status: "verified", path: expectedPath, slot: 42 });
  expect(s.reads.filter(address => address === s.owner)).toHaveLength(1);
  const ownerEvidence = s.r.evidence.find(e => e.method === "getAccountInfo" && (e.params as { pubkey: string }).pubkey === s.owner)!;
  expect(result.controllerPaths[0].evidenceIds).toContain(ownerEvidence.id);
  expect(result.controllerPaths[0].evidenceIds).toHaveLength(3);
});

test.each(["derived-absent", "derived-system", "nonmatch", "unsupported", "other-program"] as const)("token owner %s applies derivation only to supported matching PDAs", async kind => {
  const s = await syntheticTokenOwner(kind);
  const row = (await buildPack(s.r, s.input)).controllerPaths[0];
  if (kind.startsWith("derived-")) {
    expect(row).toMatchObject({ status: "verified", path: [s.subject, s.owner, LIQUID_STAKING_PROGRAM.toBase58()] });
    expect(row.note).toContain("program-derived address: seed 'st_mint' of the liquid-staking state");
  } else {
    expect(row).toMatchObject({ status: "unresolved", path: [s.subject, s.owner] });
    expect(row.note).not.toContain("program-derived address");
  }
});

test.each([false, true])("owner errors other than offline missing fixtures propagate (offline=%s)", async offline => {
  const s = await syntheticTokenOwner("nonmatch");
  const getAccountInfo = s.r.getAccountInfo.bind(s.r);
  // Keep synthetic reads in memory while testing the builder's offline error guard.
  const list = s.r.getProgramAccounts.bind(s.r);
  s.r.getProgramAccounts = async (...args) => { s.r.opts.offline = false; const result = await list(...args); s.r.opts.offline = offline; return result; };
  s.r.getAccountInfo = async address => {
    if (address.toBase58() === s.owner) throw new Error(offline ? "corrupt fixture" : "offline: fixture missing for getAccountInfo → synthetic");
    s.r.opts.offline = false; const result = await getAccountInfo(address); s.r.opts.offline = offline; return result;
  };
  await expect(buildPack(s.r, s.input)).rejects.toThrow(offline ? "corrupt fixture" : "offline: fixture missing");
});
