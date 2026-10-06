import { PublicKey } from "@solana/web3.js";
import { GovernanceAccountParser, Governance, Realm, getAccountTypes } from "@solana/spl-governance";
import bs58 from "bs58";
import type { RecordingRpc } from "../chain/rpc";
import type { PackRegistry } from "../pack/build";
import { classifyAuthority, listGovernances, type AuthorityContext } from "../pack/classify";
import { decodeAccount, decodeAccountAs, toPlain } from "./decode";
import { readOnChainIdl, type LegacyIdl } from "./idl";
import { provenance, figure, type ContractsLayer } from "./participation";

export const MSOL_UPGRADE_AUTHORITY = "551FBXSXdhcRDDkdcb3ThDRg84Mwe5Zs6YjJ1EEoyzBp";
export const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SERUM_LAYOUT: LegacyIdl = { name: "coral_xyz_multisig_claimed", version: "claimed", instructions: [], accounts: [{ name: "Multisig", type: { kind: "struct", fields: [
  { name: "owners", type: { vec: "publicKey" } }, { name: "threshold", type: "u64" }, { name: "nonce", type: "u8" }, { name: "ownerSetSeqno", type: "u32" },
] } }] };
export const SQUADS_LAYOUT: LegacyIdl = { name: "squads_v4_claimed", version: "claimed", instructions: [], accounts: [{ name: "Multisig", type: { kind: "struct", fields: [
  { name: "createKey", type: "publicKey" }, { name: "configAuthority", type: "publicKey" }, { name: "threshold", type: "u16" }, { name: "timeLock", type: "u32" },
  { name: "transactionIndex", type: "u64" }, { name: "staleTransactionIndex", type: "u64" }, { name: "rentCollector", type: { option: "publicKey" } },
  { name: "bump", type: "u8" }, { name: "members", type: { vec: { defined: "Member" } } },
] } }], types: [{ name: "Member", type: { kind: "struct", fields: [{ name: "key", type: "publicKey" }, { name: "permissions", type: "u8" }] } }] };
export const AUTHORITY_ASSUMPTIONS = [
  "Newest 50 address signatures are an observation window, including failed transactions and null/pruned transaction responses; this is not complete signing or upgrade history.",
  "Top-level instructions and CPI account appearances do not prove signing or control. A PDA cannot be a transaction-level signer. Only a reproduced PDA derivation plus owned, decoded controller state resolves an authority.",
  "Governance uses [native-treasury, governance]; Serum-style signer uses [multisig]; Squads v4 vault uses [multisig, candidate, vault, u8 index 0..3]. Program ids and candidate accounts come from observed top-level instructions; all observed programs are tested so custom governance/multisig deployments need no guessed id.",
  "When no on-chain IDL exists, coral-xyz multisig layout (owners Vec<Pubkey>, threshold u64, nonce u8, owner_set_seqno u32) is claimed. Squads v4 fallback layout and member permission bitmask are likewise claimed, not independently fetched. Discriminator, owner and threshold bounds must match. Derivation proves an address relationship, not historical membership or operator identity.",
  "BPF Upgradeable Loader Upgrade is little-endian u32 tag 3; its second account is the upgraded program. Failed transactions are retained with succeeded=false. CPI upgrades are observations under their enclosing top-level instruction.",
];
export type ObservedInstruction = { index: number; program: string; accounts: string[]; dataHex: string };
const keyString = (v: any): string => typeof v === "string" ? v : v?.toBase58 ? v.toBase58() : typeof v?.pubkey === "string" ? v.pubkey : (() => { throw new Error("unsupported transaction account key"); })();
function instructionBytes(data: any): Buffer {
  if (typeof data === "string") return Buffer.from(bs58.decode(data));
  if (data instanceof Uint8Array || Array.isArray(data)) return Buffer.from(data);
  if (data?.type === "Buffer" && Array.isArray(data.data)) return Buffer.from(data.data);
  if (data && typeof data === "object") return Buffer.from(Object.values(data) as number[]);
  return Buffer.alloc(0);
}
/** Handles live web3 Message objects and their JSON fixture shapes, including lookup keys. */
export function transactionInstructions(tx: any) {
  const message = tx.transaction.message;
  const keys = [...(message.staticAccountKeys ?? message.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].map(keyString);
  const convert = (ix: any, index: number): ObservedInstruction => {
    const program = ix.programId ? keyString(ix.programId) : keys[ix.programIdIndex];
    const accounts = Array.from(ix.accountKeyIndexes ?? ix.accounts ?? [], (a: any) => typeof a === "number" ? keys[a] : keyString(a));
    if (!program || accounts.some(a => !a)) throw new Error("transaction instruction references missing account keys");
    return { index, program, accounts, dataHex: instructionBytes(ix.data).toString("hex") };
  };
  return { top: (message.compiledInstructions ?? message.instructions ?? []).map(convert) as ObservedInstruction[],
    inner: (tx.meta?.innerInstructions ?? []).flatMap((group: any) => group.instructions.map((ix: any, index: number) => ({ ...convert(ix, index), parentIndex: group.index }))) as (ObservedInstruction & { parentIndex: number })[],
    signers: keys.slice(0, message.header?.numRequiredSignatures ?? 0) };
}
export type Derivation = { kind: "governance" | "serum-multisig" | "squads-v4"; program: string; candidate: string; bump: number; vaultIndex?: number; seeds: string[] };
export function controllerDerivations(authority: string, ix: ObservedInstruction): Derivation[] {
  const program = new PublicKey(ix.program), matches: Derivation[] = [];
  for (const candidate of new Set(ix.accounts)) {
    const bytes = new PublicKey(candidate).toBuffer();
    const test = (kind: Derivation["kind"], seeds: Buffer[], labels: string[], vaultIndex?: number) => {
      const [key, bump] = PublicKey.findProgramAddressSync(seeds, program);
      if (key.toBase58() === authority) matches.push({ kind, program: ix.program, candidate, bump, seeds: labels, ...(vaultIndex === undefined ? {} : { vaultIndex }) });
    };
    test("governance", [Buffer.from("native-treasury"), bytes], ["utf8:native-treasury", candidate]);
    if (ix.program === SQUADS_V4) for (let i = 0; i < 4; i++) test("squads-v4", [Buffer.from("multisig"), bytes, Buffer.from("vault"), Buffer.from([i])], ["utf8:multisig", candidate, "utf8:vault", `u8:${i}`], i);
    else test("serum-multisig", [bytes], [candidate]);
  }
  return matches;
}
export async function resolveController(rpc: RecordingRpc, match: Derivation, context: AuthorityContext & { evidenceIds?: string[] }) {
  const key = new PublicKey(match.candidate), program = new PublicKey(match.program);
  const info = await rpc.getAccountInfo(key);
  const ids = [info.evidence.id];
  const unresolved = (reason: string) => ({ status: "unresolved" as const, reason, derivation: match, evidenceIds: ids });
  if (!info.value || !info.value.owner.equals(program)) return unresolved("candidate missing or owned by another program");
  if (match.kind === "governance") {
    if (!getAccountTypes(Governance).includes(info.value.data[0])) return unresolved("candidate has a non-governance account type");
    let governance: Governance;
    try { governance = GovernanceAccountParser(Governance)(key, info.value).account; }
    catch { return unresolved("candidate is not decodable SPL Governance state"); }
    const realmInfo = await rpc.getAccountInfo(governance.realm); ids.push(realmInfo.evidence.id);
    if (!realmInfo.value || !realmInfo.value.owner.equals(program)) return unresolved("realm missing or owned by another program");
    if (!getAccountTypes(Realm).includes(realmInfo.value.data[0])) return unresolved("realm has a non-realm account type");
    let realm: Realm;
    try { realm = GovernanceAccountParser(Realm)(governance.realm, realmInfo.value).account; }
    catch { return unresolved("realm is not decodable SPL Governance state"); }
    return { status: "resolved" as const, basis: "derived" as const, derivation: match, program: match.program, governance: match.candidate, realm: governance.realm.toBase58(), realmName: realm.name, evidenceIds: ids };
  }
  const idl = await readOnChainIdl(rpc, program); ids.push(...idl.evidenceIds);
  let decoded: Record<string, any>;
  try { decoded = toPlain(idl.kind === "idl" ? decodeAccount(idl.idl, info.value.data).value : decodeAccountAs(match.kind === "squads-v4" ? SQUADS_LAYOUT : SERUM_LAYOUT, "Multisig", info.value.data).value) as Record<string, any>; }
  catch { return unresolved("multisig layout/discriminator could not be decoded"); }
  const members = match.kind === "squads-v4" ? decoded.members : decoded.owners;
  if (!Array.isArray(members) || decoded.threshold == null || BigInt(decoded.threshold) < 1n || BigInt(decoded.threshold) > BigInt(members.length)) return unresolved("invalid multisig members/threshold");
  if (match.kind === "serum-multisig" && Number(decoded.nonce) !== match.bump) return unresolved("stored signer nonce differs from derived bump");
  const owners = [];
  for (const member of members) {
    const address = typeof member === "string" ? member : member.key ?? member.pubkey;
    if (typeof address !== "string") return unresolved("unsupported multisig member layout");
    const classification = await classifyAuthority(rpc, new PublicKey(address), context); classification.evidenceIds.push(...(context.evidenceIds ?? [])); ids.push(...classification.evidenceIds);
    owners.push({ address, permissions: typeof member === "object" ? member.permissions : null, classification: toPlain(classification) });
  }
  return { status: "resolved" as const, basis: "derived" as const, derivation: match, program: match.program, multisig: match.candidate,
    layoutBasis: idl.kind === "idl" ? "declared" as const : "claimed" as const, layoutSource: idl.kind === "idl" ? idl.idlAddress : match.kind === "squads-v4" ? "Squads v4 claimed layout" : "coral-xyz multisig claimed layout",
    threshold: String(decoded.threshold), ownerSetSequenceNumber: decoded.ownerSetSeqno == null ? null : String(decoded.ownerSetSeqno), owners, members: match.kind === "squads-v4" ? owners : null, decoded, evidenceIds: ids };
}

export function authorityInputs(registry: PackRegistry, layer: ContractsLayer): string[] {
  const classifications = [...layer.authorities.map(a => a.classification), ...layer.programs.map(p => p.upgradeAuthority.classification), layer.registrar.realmAuthority.classification,
    ...layer.registrar.votingMints.map(m => m.grantAuthority.classification), ...layer.parameterControl.links.flatMap(l => l.signers.map(s => s.classification))];
  return [...new Set([...classifications.filter(c => c && ["native-treasury-pda", "pda-system", "pda-no-account", "wallet"].includes(c.kind)).map(c => c!.address), MSOL_UPGRADE_AUTHORITY,
    ...registry.accounts.filter(a => /^native-(staker-authority|exit-authority)/.test(a.id)).map(a => a.address)])].sort();
}
export async function readAuthorities(rpc: RecordingRpc, registry: PackRegistry, layer: ContractsLayer, inputs = authorityInputs(registry, layer)) {
  const start = rpc.evidence.length;
  const discovery = await listGovernances(rpc, new PublicKey(registry.governance.program), new PublicKey(registry.governance.realm));
  const context = { program: new PublicKey(registry.governance.program), governances: discovery.governances.map(g => new PublicKey(g.address)), evidenceIds: discovery.evidenceIds };
  const transactionCache = new Map<string, Awaited<ReturnType<RecordingRpc["getTransaction"]>>>();
  const resolutionCache = new Map<string, Awaited<ReturnType<typeof resolveController>>>();
  const results = [];
  for (const address of inputs) {
    const signatures = await rpc.getSignaturesForAddress(new PublicKey(address), 50);
    type Observation = { signature: string; blockTime: number | null; slot: number; evidenceIds: string[]; basis: "observed"; unavailable: boolean; topLevel: ObservedInstruction[]; controllerInstructions: ObservedInstruction[]; cpiAppearances: (ObservedInstruction & { parentIndex: number; enclosingProgram: string | null; basis: "observed" })[]; transactionSigner: boolean | null; succeeded: boolean | null };
    const observations: Observation[] = [];
    const resolutions: (Awaited<ReturnType<typeof resolveController>> & { observedSignature: string })[] = [];
    const upgrades = [];
    const ids = [signatures.evidence.id];
    for (const signature of signatures.value) {
      let read = transactionCache.get(signature.signature);
      if (!read) { read = await rpc.getTransaction(signature.signature); transactionCache.set(signature.signature, read); }
      ids.push(read.evidence.id);
      const base = { signature: signature.signature, blockTime: read.value?.blockTime ?? signature.blockTime ?? null, slot: read.value?.slot ?? signature.slot,
        evidenceIds: [signatures.evidence.id, read.evidence.id], basis: "observed" as const };
      if (!read.value) { observations.push({ ...base, unavailable: true, topLevel: [], controllerInstructions: [], cpiAppearances: [], transactionSigner: null, succeeded: null }); continue; }
      const tx = read.value, decoded = transactionInstructions(tx);
      const controllerInstructions = [];
      for (const ix of decoded.top) {
        const matches = controllerDerivations(address, ix);
        if (matches.length || [registry.governance.program, "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", SQUADS_V4].includes(ix.program) || /^msig/i.test(ix.program)) controllerInstructions.push(ix);
        for (const match of matches) {
          const cacheKey = JSON.stringify(match);
          let result = resolutionCache.get(cacheKey);
          if (!result) { result = await resolveController(rpc, match, context); resolutionCache.set(cacheKey, result); }
          ids.push(...result.evidenceIds);
          if (!resolutions.some(r => JSON.stringify(r.derivation) === cacheKey)) resolutions.push({ ...result, observedSignature: signature.signature, evidenceIds: [...base.evidenceIds, ...result.evidenceIds] });
        }
      }
      const cpiAppearances = decoded.inner.filter(ix => ix.accounts.includes(address)).map(ix => ({ ...ix, enclosingProgram: decoded.top[ix.parentIndex]?.program ?? null, basis: "observed" as const }));
      observations.push({ ...base, unavailable: false, topLevel: decoded.top, controllerInstructions, cpiAppearances, transactionSigner: decoded.signers.includes(address), succeeded: tx.meta == null ? null : tx.meta.err === null });
      if (address === MSOL_UPGRADE_AUTHORITY) for (const ix of [...decoded.top, ...decoded.inner]) {
        const data = Buffer.from(ix.dataHex, "hex");
        if (ix.program === LOADER && data.length >= 4 && data.readUInt32LE() === 3) upgrades.push({ ...base, programUpgraded: ix.accounts[1] ?? null, instruction: ix, succeeded: tx.meta == null ? null : tx.meta.err === null });
      }
    }
    const programs = [...new Set(observations.flatMap(o => o.topLevel.map(ix => ix.program)))].map(program => {
      const transactions = observations.filter(o => o.topLevel.some(ix => ix.program === program)), times = transactions.flatMap(t => t.blockTime === null ? [] : [t.blockTime]);
      return { program, transactions: transactions.length, instructions: transactions.reduce((n, t) => n + t.topLevel.filter(ix => ix.program === program).length, 0), oldestBlockTime: times.length ? Math.min(...times) : null, newestBlockTime: times.length ? Math.max(...times) : null };
    });
    results.push({ address, status: resolutions.some(r => r.status === "resolved") ? "resolved" : "unresolved", onCurve: PublicKey.isOnCurve(new PublicKey(address).toBytes()), programs, observations, resolutions, upgrades, evidenceIds: [...new Set(ids)] });
  }
  const evidence = [...new Map([...layer.evidence, ...rpc.evidence.slice(start)].map(e => [e.id, e])).values()];
  return { ...provenance(evidence, undefined, "observed"), assumptions: AUTHORITY_ASSUMPTIONS, evidence,
    authorities: results.map(r => { const p = provenance(evidence, r.evidenceIds, "observed"); return { ...r, ...p,
      programs: r.programs.map(program => ({ ...program, ...p })),
      observations: r.observations.map(o => ({ ...o, ...provenance(evidence, o.evidenceIds, "observed"), slot: o.slot })),
      resolutions: r.resolutions.map(s => ({ ...s, ...provenance(evidence, s.evidenceIds, s.status === "resolved" ? "derived" : "observed") })),
      upgrades: r.upgrades.map(u => ({ ...u, ...provenance(evidence, u.evidenceIds, "observed"), slot: u.slot })) }; }),
    resolved: figure(results.filter(r => r.status === "resolved").length, provenance(evidence, undefined, "derived")),
    unresolved: figure(results.filter(r => r.status === "unresolved").length, provenance(evidence, undefined, "observed")),
  };
}
