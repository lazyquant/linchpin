import { amountFact, type StateFact } from '../chain/state';
import { PublicKey } from "@solana/web3.js";
import type { RecordingRpc } from "../chain/rpc";
import { readProgramAuthority } from "../chain/program-authority";
import { formatUnits } from "../chain/token-layout";
import { associatedTokenAccount, classifyAuthority, listGovernances, readMintState, readTokenAccount, type AuthorityClassification } from "./classify";
import { supplyStatement, type KnownBurn, type SupplyClaim } from "./supply";
import type { ControllerPath, PackClaim, PackPacket, Status } from "./model";
import { deriveLiquidStakingAddresses } from "./derive";
import { MARINADE_PROGRAM_VERSION } from "../config";
import { buildTreasuryLedger, emptyTreasuryLedger, listRealmProposals } from "./ledger";

export type RegistryClaim = SupplyClaim & { certainty?: string; retrievedAt?: string };
type Entry = { id: string; address: string; role?: string; claims?: RegistryClaim[] };
export type PackRegistry = {
  pack: string; title: string; retrievedAt: string; researchQuestion: string; sources: Record<string, string>;
  programs: Entry[]; mints: Entry[]; accounts: Entry[];
  governance: { program: string; realm: string; councilMint: string; knownGovernances: { address: string }[]; claims: RegistryClaim[] };
  valueRouteClaims: (RegistryClaim & { id: string; check?: string })[]; unknownsSeed: string[];
};
export type PackFile = { pack: string; registry: string; docsCapture: string; title: string; burns?: Record<string, KnownBurn[]>; ledger?: { enabled: boolean; maxProposals?: number; programVersion?: number } };
export type DocsCapture = { retrievedAt: string };
const unique = (ids: string[]) => [...new Set(ids)];

// These are assertions in the supplied registry, not general natural-language inference.
// Council membership/thresholds cannot be inferred from a DAO account owner.
function expectedController(claim: RegistryClaim): string | null {
  if (/DAO holds upgrade authority/i.test(claim.text)) return "dao";
  if (/Upgrade authority: None/i.test(claim.text)) return "immutable";
  if (/ecosystem multisig/i.test(claim.text)) return "ecosystem-multisig";
  if (/council \(3\/5\).*upgrade authority|Upgrade authority: Marinade council/i.test(claim.text)) return "council";
  return null;
}

export async function buildPack(rpc: RecordingRpc, registry: PackRegistry, options: {
  title?: string; docsCapture?: DocsCapture; burns?: Record<string, KnownBurn[]>; generatedAt?: string; ledger?: PackFile["ledger"]; ledgerRpc?: RecordingRpc;
} = {}): Promise<PackPacket> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const stateFacts: StateFact[] = []; const mintDecimals = new Map<string, number>();
  const paths: ControllerPath[] = []; const statements: PackPacket["statements"] = []; const claims: PackClaim[] = [];
  const unknowns = registry.unknownsSeed.map((text, i) => ({ id: `seed-${i + 1}`, text, firstSeen: registry.retrievedAt }));
  const discovery = await listGovernances(rpc, new PublicKey(registry.governance.program), new PublicKey(registry.governance.realm));
  stateFacts.push({ id: 'governance-list-size', label: 'Governance-list size', value: String(discovery.governances.length), raw: String(discovery.governances.length),
    slot: rpc.evidence.filter(e => discovery.evidenceIds.includes(e.id)).at(-1)?.slot ?? null, evidenceIds: discovery.evidenceIds });
  const ctx = { program: new PublicKey(registry.governance.program), governances: discovery.governances.map(g => new PublicKey(g.address)) };
  const classifications = new Map<string, AuthorityClassification>();
  const derivedAddresses = deriveLiquidStakingAddresses();
  const classify = async (address: string) => {
    let value = classifications.get(address);
    if (!value) { value = await classifyAuthority(rpc, new PublicKey(address), ctx); classifications.set(address, value); }
    return value;
  };
  const addClaim = (id: string, c: RegistryClaim, status: Status = "claimed", checkable = false, note = "Not checked in this slice.") => {
    claims.push({ id, text: c.text, source: registry.sources[c.source] ?? c.source,
      retrievedAt: c.retrievedAt ?? (c.source.startsWith("docs:") ? options.docsCapture?.retrievedAt : undefined) ?? registry.retrievedAt,
      status, checkable, note: c.certainty ? `${note} Source attachment uncertainty: ${c.certainty}.` : note });
  };
  const controller = (entry: Entry, subjectKind: ControllerPath["subjectKind"], authorityType: ControllerPath["authorityType"], a: AuthorityClassification): ControllerPath => {
    const path = [entry.address, a.address];
    let status: Status = "verified";
    let note = `Chain: ${authorityType} authority ${a.address} is ${a.kind}.`;
    let ids = a.evidenceIds;
    if (a.kind === "dao-governance-account" || a.kind === "native-treasury-pda") {
      const governance = a.kind === "native-treasury-pda" ? a.governance : a.address;
      const membership = discovery.governances.find(g => g.address === governance && g.realm === registry.governance.realm);
      if (membership) {
        if (path.at(-1) !== governance) path.push(governance);
        path.push(membership.realm); ids = unique([...ids, ...membership.evidenceIds]);
      }
      else { status = "unresolved"; note += " Governance membership in the declared realm is unverified."; }
    } else if (a.kind.startsWith("squads-")) note += " multisig members not read";
    else if (a.kind === "pda-no-account" || a.kind === "pda-system") {
      const derived = derivedAddresses.find(candidate => candidate.address === a.address);
      if (derived) {
        path.push(derived.program);
        note += ` program-derived address: seed '${derived.seed}' of the liquid-staking state`;
      } else {
        status = "unresolved";
        note += a.kind === "pda-no-account" ? " authority has no on-chain account; identity unknown" : " system-owned PDA; identity unknown";
      }
    } else if (a.kind === "program-owned" || a.kind === "token-account" || a.kind === "unsupported-account") {
      status = "unresolved"; note += ` Account owner ${a.owner}; signing/controller mechanism not established.`;
    } else if (a.kind === "wallet-no-account") { status = "unresolved"; note += " Authority has no on-chain account; identity unknown."; }
    else note += " Wallet address verified; operator identity not established.";
    return { subject: entry.address, subjectKind, role: entry.role ?? entry.id, authorityType, authority: a.address,
      authorityKind: a.kind, path, status, claims: entry.claims ?? [], evidenceIds: ids, slot: a.slot, note };
  };

  for (const entry of registry.programs) {
    const state = await readProgramAuthority(rpc, new PublicKey(entry.address));
    let row: ControllerPath;
    if (state.kind === "upgradeable" && state.upgradeAuthority) {
      row = controller(entry, "program", "upgrade", await classify(state.upgradeAuthority));
      row.evidenceIds = unique([...state.evidenceIds, ...row.evidenceIds]); row.slot = state.slot;
    } else {
      const immutable = state.kind === "upgradeable" && !state.upgradeable;
      row = { subject: entry.address, subjectKind: "program", role: entry.role ?? entry.id, authorityType: "upgrade", authority: null,
        authorityKind: immutable ? "immutable" : state.kind, path: [entry.address], status: immutable ? "verified" : "unresolved",
        claims: entry.claims ?? [], evidenceIds: state.evidenceIds, slot: state.kind === "upgradeable" ? state.slot : rpc.evidence.at(-1)?.slot ?? null,
        note: immutable ? "Chain: immutable program; upgrade authority is absent." : `Chain: ${state.kind}; upgrade control is unresolved.` };
      if (immutable) statements.push({ id: `${entry.id}-immutable`, topic: "governance", text: `${entry.role ?? entry.id}: immutable program.`, status: "verified", evidenceIds: row.evidenceIds, slot: row.slot });
    }
    const chain = row.authorityKind === "dao-governance-account" || row.authorityKind === "native-treasury-pda" ? "dao" : row.authorityKind;
    for (const [i, claim] of (entry.claims ?? []).entries()) {
      const expected = expectedController(claim);
      let status: Status = "claimed"; let note = "This claim is not established by the upgrade-authority read.";
      if (expected && row.status !== "unresolved") {
        status = expected === chain ? "verified" : "contradiction";
        note = `${row.note} ${status === "verified" ? "Agrees with" : "Disagrees with"} claim: “${claim.text}” (${claim.source}).`;
      } else if (expected) { status = "unresolved"; note = `${row.note} Claim identity cannot be checked.`; }
      addClaim(`${entry.id}-claim-${i + 1}`, claim, status, expected !== null, note);
    }
    const checks = claims.filter(c => c.id.startsWith(`${entry.id}-claim-`));
    if (checks.some(c => c.status === "contradiction")) {
      row.status = "contradiction";
      row.note += ` Contradicting claims: ${checks.filter(c => c.status === "contradiction").map(c => `“${c.text}” (${c.source})`).join("; ")}.`;
      row.note += ` Agreeing claim: ${checks.filter(c => c.status === "verified").map(c => `“${c.text}” (${c.source})`).join("; ") || "none"}.`;
    }
    paths.push(row);
  }

  for (const entry of registry.mints) {
    const read = await readMintState(rpc, new PublicKey(entry.address));
    stateFacts.push(amountFact(`supply:${entry.address}`, `${entry.id} supply`, read.value?.supplyRaw ?? null, read.value?.decimals ?? null, read.slot, read.evidenceIds));
    if (!read.value) {
      paths.push({ subject: entry.address, subjectKind: "mint", role: entry.id, authorityType: "mint", authority: null, authorityKind: "unreadable",
        path: [entry.address], status: "unresolved", claims: entry.claims ?? [], evidenceIds: read.evidenceIds, slot: read.slot, note: "Chain: mint absent or unsupported layout." });
      for (const [i, claim] of (entry.claims ?? []).entries()) addClaim(`${entry.id}-claim-${i + 1}`, claim, "unresolved", true, "Mint state unavailable.");
      continue;
    }
    const mint = read.value; mintDecimals.set(entry.address, mint.decimals);
    for (const authorityType of ["mint", "freeze"] as const) {
      const authority = authorityType === "mint" ? mint.mintAuthority : mint.freezeAuthority;
      const row: ControllerPath = authority ? controller(entry, "mint", authorityType, await classify(authority)) : {
        subject: entry.address, subjectKind: "mint", role: entry.id, authorityType, authority: null, authorityKind: "none", path: [entry.address],
        status: "verified", claims: entry.claims ?? [], evidenceIds: [], slot: read.slot, note: `Chain: ${authorityType} authority is absent.` };
      row.evidenceIds = unique([...read.evidenceIds, ...row.evidenceIds]); row.slot = read.slot; paths.push(row);
    }
    const council = entry.address === registry.governance.councilMint;
    const councilAgrees = mint.supplyRaw === 5n && mint.decimals === 0;
    statements.push({ id: `${entry.id}-state`, topic: council ? "governance" : "supply", text: `${entry.id}: supply ${formatUnits(mint.supplyRaw, mint.decimals)} (${mint.supplyRaw} raw), decimals ${mint.decimals}; mint authority ${mint.mintAuthority ?? "none"}; freeze authority ${mint.freezeAuthority ?? "none"}.${council ? ` ${councilAgrees ? "Agrees" : "Disagrees"} with docs claim: exactly 5, zero decimals.` : ""}`,
      status: council && !councilAgrees ? "contradiction" : "verified", evidenceIds: read.evidenceIds, slot: read.slot });
    const supply = supplyStatement({ mint: { ...mint, address: entry.address, slot: read.slot }, claims: entry.claims ?? [], burns: options.burns?.[entry.id] ?? [] });
    if (supply.capClaim) statements.push({ id: `${entry.id}-supply`, topic: "supply", text: `${entry.id}: ${supply.note} Cap claim: “${supply.capClaim.text}” (${supply.capClaim.source}). ${supply.knownBurns.map(b => `Historical burn input: ${b.amountRaw} raw; signature ${b.signature}; slot ${b.slot}; source ${b.source}.`).join(" ")}`,
      status: supply.capStatus === "contradicted" ? "contradiction" : "claimed", evidenceIds: read.evidenceIds, slot: read.slot });
    for (const [i, claim] of (entry.claims ?? []).entries()) {
      const claimedAddress = claim.text.match(/(?:auth(?:ority)?(?: \(PDA\))?|auth PDA)\s+([1-9A-HJ-NP-Za-km-z]{32,44})/i)?.[1];
      const seatClaim = council && /supply of exactly 5, at zero decimals/.test(claim.text);
      const status: Status = seatClaim ? councilAgrees ? "verified" : "contradiction" : claimedAddress ? claimedAddress === mint.mintAuthority ? "verified" : "contradiction" : supply.capClaim?.text === claim.text && supply.capStatus === "contradicted" ? "contradiction" : "claimed";
      addClaim(`${entry.id}-claim-${i + 1}`, claim, status, !!claimedAddress || seatClaim || supply.capClaim?.text === claim.text,
        seatClaim ? `Chain: supply ${mint.supplyRaw} raw, decimals ${mint.decimals}.` : claimedAddress ? `Chain: mint authority ${mint.mintAuthority}; address comparison only, PDA controller identity not established.` : supply.capClaim?.text === claim.text ? supply.note : undefined);
    }
  }

  // Classify registry accounts first so token owners can reuse captured classifications.
  for (const entry of registry.accounts) await classify(entry.address);
  for (const entry of registry.accounts) {
    const a = classifications.get(entry.address)!;
    const info = await rpc.getAccountInfo(new PublicKey(entry.address));
    let row: ControllerPath;
    if (a.kind === "token-account") {
      const token = await readTokenAccount(rpc, new PublicKey(entry.address));
      stateFacts.push(amountFact(`balance:${entry.address}`, `${entry.role ?? entry.id} balance`, token.value?.amountRaw ?? null, mintDecimals.get(a.mint) ?? null, token.slot, token.evidenceIds));
      try {
        row = controller(entry, "account", "owner", await classify(a.tokenOwner));
      } catch (error) {
        if (!rpc.opts.offline || !(error instanceof Error) || !error.message.startsWith("offline: fixture missing for getAccountInfo → ")) throw error;
        row = {
          subject: entry.address, subjectKind: "account", role: entry.role ?? entry.id, authorityType: "owner", authority: a.tokenOwner,
          authorityKind: "unclassified-token-owner", path: [entry.address, a.tokenOwner], status: "unresolved", claims: entry.claims ?? [], evidenceIds: [], slot: a.slot,
          note: `Chain: token authority ${a.tokenOwner}; owner not yet captured.`,
        };
      }
      row.evidenceIds = unique([...a.evidenceIds, ...row.evidenceIds]); row.slot = a.slot;
      row.note += ` Account classification: token-account; account program owner ${a.owner}.`;
      statements.push({ id: `${entry.id}-tokens`, topic: "treasury", text: `${entry.id}: ${token.value!.amountRaw} raw units of mint ${a.mint}; token owner ${a.tokenOwner}. This is one account, not aggregate treasury holdings.`, status: "verified", evidenceIds: token.evidenceIds, slot: token.slot });
    } else row = controller(entry, "account", "owner", a);
    paths.push(row);
    statements.push({ id: `${entry.id}-balance`, topic: "treasury", text: info.value ? `${entry.id}: ${info.value.lamports} lamports (${formatUnits(BigInt(info.value.lamports), 9)} SOL); account owner ${info.value.owner.toBase58()}; classification ${a.kind}.` : `${entry.id}: account absent at capture; no balance observed.`, status: "verified", evidenceIds: [info.evidence.id], slot: info.evidence.slot });
    const mnde = registry.mints.find(m => m.id === "mnde");
    if (mnde && (a.kind === "wallet" || a.kind === "wallet-no-account")) {
      const ata = await readTokenAccount(rpc, associatedTokenAccount(new PublicKey(entry.address), new PublicKey(mnde.address)));
      stateFacts.push(amountFact(`balance:${ata.address}`, `${entry.role ?? entry.id} MNDE balance`, ata.value?.amountRaw ?? null, mintDecimals.get(mnde.address) ?? null, ata.slot, ata.evidenceIds));
      statements.push({ id: `${entry.id}-mnde-ata`, topic: "treasury", text: `${entry.id}: MNDE ATA ${ata.address}: ${ata.value ? `${ata.value.amountRaw} raw MNDE` : "absent or unsupported token layout; no token balance observed"}.`, status: "verified", evidenceIds: ata.evidenceIds, slot: ata.slot });
    }
  }
  for (const [i, claim] of registry.governance.claims.entries()) addClaim(`governance-claim-${i + 1}`, claim);
  for (const claim of registry.valueRouteClaims) addClaim(claim.id, claim, "claimed", !!claim.check, claim.check ? `Not checked in Slice A: ${claim.check}.` : "Value-route claim; flows are outside Slice A.");
  for (const row of paths.filter(p => p.status === "unresolved")) {
    // Capture dates keep firstSeen stable across replays of the same evidence.
    const firstSeen = rpc.evidence.filter(e => row.evidenceIds.includes(e.id)).map(e => e.retrievedAt).sort()[0] ?? generatedAt;
    unknowns.push({ id: `${row.subject}-${row.authorityType}`, text: `${row.role} (${row.subject}), ${row.authorityType}: ${row.note}`, firstSeen });
  }
  let ledger = emptyTreasuryLedger("ledger disabled");
  if (options.ledger?.enabled) {
    const ledgerRpc = options.ledgerRpc ?? rpc;
    try {
      const proposals = await listRealmProposals(ledgerRpc, ctx.program, new PublicKey(registry.governance.realm));
      ledger = await buildTreasuryLedger(ledgerRpc, ctx.program, options.ledger.programVersion ?? MARINADE_PROGRAM_VERSION, proposals, {
        maxProposals: options.ledger.maxProposals, nativeTreasuries: discovery.governances.map(g => g.nativeTreasury), governances: discovery.governances.map(g => g.address),
      });
    } catch (error) {
      if (!ledgerRpc.opts.offline || !(error instanceof Error) || !error.message.startsWith("offline: fixture missing for ")) throw error;
      ledger = emptyTreasuryLedger("ledger not recorded yet");
    }
  }
  const evidence = options.ledgerRpc && options.ledgerRpc !== rpc ? [...rpc.evidence, ...options.ledgerRpc.evidence] : rpc.evidence;
  const slots = evidence.flatMap(e => e.slot == null ? [] : [e.slot]);
  const coverage = { total: paths.length, verified: 0, claimed: 0, contradiction: 0, unresolved: 0 };
  for (const row of paths) if (row.status !== "outside-scope") coverage[row.status]++;
  return { stateFacts, pack: registry.pack, title: options.title ?? registry.title, generatedAt, offline: rpc.opts.offline,
    asOfSlotRange: slots.length ? [Math.min(...slots), Math.max(...slots)] : [null, null], researchQuestion: registry.researchQuestion, controllerPaths: paths,
    statements, claims, unknowns, coverage, ledger, evidenceCount: evidence.length };
}
