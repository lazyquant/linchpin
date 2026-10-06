import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { RecordingRpc } from "../chain/rpc";
import { readProgramAuthority } from "../chain/program-authority";
import { classifyAuthority, listGovernances, readTokenAccount, type AuthorityClassification } from "../pack/classify";
import type { PackRegistry } from "../pack/build";
import { readOnChainIdl, type LegacyIdl } from "./idl";
import { accountDiscriminator, decodeAccountAs, toPlain, type PlainValue } from "./decode";
import { instructionInventory, matchingStateFields, parameterControl, stateFieldPaths } from "./inventory";

export type ContractsInput = {
  pack: string;
  singletons: { id: string; program: string; account: string; address?: string; derive?: { seeds: string[] } }[];
  enumerate: { program: string; account: string; mode: "full" | "count" }[];
};
export type Basis = "decoded" | "declared" | "inferred" | "derived";
type Provenance = { evidenceIds: string[]; slot: number | null; basis: Basis };
type ObjectValue = { [key: string]: PlainValue };
const unique = (ids: string[]) => [...new Set(ids)];
function object(value: PlainValue, path: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected a decoded struct`);
  return value;
}
function field(value: PlainValue, path: string): PlainValue {
  let current = value;
  for (const key of path.split(".")) {
    const obj = object(current, path);
    if (!(key in obj)) throw new Error(`${path}: missing decoded field`);
    current = obj[key];
  }
  return current;
}
function address(value: PlainValue, path: string): string {
  const v = field(value, path);
  if (typeof v !== "string") throw new Error(`${path}: expected public key`);
  return new PublicKey(v).toBase58();
}

export const CONTRACT_ASSUMPTIONS = [
  "IDL layouts and instruction accounts are declarations; decoding does not establish program behaviour or enforcement.",
  "Fee.basisPoints is basis points (1/10000); FeeCents.bpCents is hundredths of a basis point (1/1000000).",
  "SOL caps, targets, minima, availableReserveBalance and circulatingTicketBalance are lamports; msolSupply is raw mSOL units; circulatingTicketCount is a count.",
  "msolPrice is a u64 scaled by 2^32, interpreted as SOL per mSOL per the supplied Marinade source convention; source was not independently fetched. The 1–3 sanity range is a heuristic, not a valuation guarantee.",
  "stakeSystem.stakeList and validatorSystem.validatorList identify accounts through their List.account member; other List members are metadata.",
  "Argument-to-field links and signer-role holders use normalized names and explicit aliases, not verified instruction semantics. pause/resume → paused is an explicit instruction-name inference.",
  "Registrar seeds are realm, UTF-8 registrar, MNDE mint under the VSR program, as declared in contracts.json.",
  "Registrar voting weight factors remain raw scaled integers; no factor denominator is assumed. digitShift remains the signed IDL integer; lockupSaturationSecs is seconds.",
  "All four voting-mint slots are retained, including zero public keys. Zero mint/grant authority keys are not interpreted as an active mint or an effective grant authority.",
  "Authority classifications describe account ownership/PDA matches, not operator identity, multisig thresholds, or proven signing capability; an account reference is not itself a controller.",
  "Separate RPC reads may have different slots; each row retains its primary observation slot and evidence links, and the layer exposes the full slot range.",
];

const PARAMETER_UNITS: Record<string, string> = {
  rewardFee: "basis points", delayedUnstakeFee: "hundredths of a basis point", withdrawStakeAccountFee: "hundredths of a basis point",
  depositSolFee: "hundredths of a basis point", depositStakeAccountFee: "hundredths of a basis point",
  "liqPool.treasuryCut": "basis points", "liqPool.lpMinFee": "basis points", "liqPool.lpMaxFee": "basis points",
  "liqPool.lpLiquidityTarget": "lamports", stakingSolCap: "lamports", "liqPool.liquiditySolCap": "lamports", minDeposit: "lamports", minWithdraw: "lamports",
  maxStakeMovedPerEpoch: "basis points", paused: "boolean", msolPrice: "SOL per mSOL × 2^32", msolSupply: "raw mSOL units",
  availableReserveBalance: "lamports", circulatingTicketBalance: "lamports", circulatingTicketCount: "count",
};
const AUTHORITY_FIELDS = ["adminAuthority", "validatorSystem.managerAuthority", "pauseAuthority", "operationalSolAccount", "treasuryMsolAccount", "msolMint", "liqPool.lpMint", "liqPool.msolLeg", "stakeSystem.stakeList", "validatorSystem.validatorList"];
export type AuthorityRow = Provenance & { field: string; stateField: string; address: string; classification: AuthorityClassification & { basis: Basis }; balance?: ReturnType<typeof toPlain> };
type Singleton = Provenance & { id: string; program: string; address: string; account: string; value: ObjectValue; bytesRead: number; trailingBytes: number; derivation: (Provenance & { seeds: string[]; bump: number }) | null };
type Signer = Provenance & { role: string; holderField: string | null; holder: string | null; classification: (AuthorityClassification & { basis: Basis }) | null; unresolved?: string };
type Setting = Provenance & { instruction: string; argPath: string | null; stateField: string; signerRoles: string[]; matchMethod: string; signers: Signer[] };

export async function readContractsLayer(rpc: RecordingRpc, registry: PackRegistry, contracts: ContractsInput) {
  const evidenceStart = rpc.evidence.length;
  const discovery = await listGovernances(rpc, new PublicKey(registry.governance.program), new PublicKey(registry.governance.realm));
  const context = { program: new PublicKey(registry.governance.program), governances: discovery.governances.map(g => new PublicKey(g.address)) };
  const classificationCache = new Map<string, AuthorityClassification & { basis: Basis }>();
  const classify = async (key: string) => {
    let c = classificationCache.get(key);
    if (!c) {
      const result = await classifyAuthority(rpc, new PublicKey(key), context);
      c = { ...result, evidenceIds: unique([...result.evidenceIds, ...discovery.evidenceIds]), basis: result.kind === "native-treasury-pda" ? "derived" : "decoded" };
      classificationCache.set(key, c);
    }
    return c;
  };
  const programs = [];
  const idls = new Map<string, { idl: LegacyIdl; evidenceIds: string[]; slot: number | null }>();
  for (const entry of registry.programs) {
    const key = new PublicKey(entry.address);
    const authority = await readProgramAuthority(rpc, key);
    const authoritySlot = "slot" in authority ? authority.slot : rpc.evidence.at(-1)?.slot ?? null;
    const classification = authority.kind === "upgradeable" && authority.upgradeAuthority ? await classify(authority.upgradeAuthority) : null;
    const idl = await readOnChainIdl(rpc, key);
    const declared = { evidenceIds: idl.evidenceIds, slot: idl.slot, basis: "declared" as const };
    const instructions = idl.kind === "idl" ? instructionInventory(idl.idl).map(i => ({ ...i, ...declared,
      args: i.args.map(a => ({ ...a, ...declared })), accounts: i.accounts.map(a => ({ ...a, ...declared })) })) : [];
    if (idl.kind === "idl") idls.set(entry.id, idl);
    programs.push({ id: entry.id, address: entry.address, basis: "decoded" as const, slot: idl.slot,
      evidenceIds: unique([...authority.evidenceIds, ...idl.evidenceIds, ...(classification?.evidenceIds ?? [])]),
      upgradeAuthority: { ...authority, basis: "decoded" as const, slot: authoritySlot, classification },
      idl: { ...idl, basis: "declared" as const },
      idlDerivation: { address: idl.idlAddress, program: entry.address, seed: "anchor:idl", basis: "derived" as const, slot: idl.slot, evidenceIds: idl.evidenceIds },
      inventory: { ...declared, instructionCount: instructions.length, accountTypes: idl.kind === "idl" ? (idl.idl.accounts ?? []).map(a => a.name) : [], instructions } });
  }
  const programKey = (id: string) => {
    const entry = registry.programs.find(p => p.id === id);
    if (!entry) throw new Error(`contracts: unknown registry program ${id}`);
    return new PublicKey(entry.address);
  };
  const requiredIdl = (id: string) => {
    const idl = idls.get(id);
    if (!idl) throw new Error(`contracts: ${id} has no on-chain IDL; cannot decode configured accounts`);
    return idl;
  };
  const seedBytes = (seed: string): Buffer => {
    if (seed === "realm") return new PublicKey(registry.governance.realm).toBuffer();
    if (seed.startsWith("utf8:")) return Buffer.from(seed.slice(5), "utf8");
    if (seed.startsWith("mint:")) {
      const mint = registry.mints.find(m => m.id === seed.slice(5));
      if (!mint) throw new Error(`contracts: unknown seed ${seed}`);
      return new PublicKey(mint.address).toBuffer();
    }
    throw new Error(`contracts: unsupported PDA seed ${seed}`);
  };
  const singletons: Singleton[] = [];
  for (const entry of contracts.singletons) {
    const program = programKey(entry.program);
    const idl = requiredIdl(entry.program);
    if (!!entry.address === !!entry.derive) throw new Error(`contracts: ${entry.id} needs exactly one address or derivation`);
    const derived = entry.derive ? PublicKey.findProgramAddressSync(entry.derive.seeds.map(seedBytes), program) : null;
    const key = derived ? derived[0] : new PublicKey(entry.address!);
    const read = await rpc.getAccountInfo(key);
    if (!read.value) throw new Error(`contracts: singleton ${entry.id} missing at ${key}`);
    if (!read.value.owner.equals(program)) throw new Error(`contracts: ${entry.id} owner mismatch`);
    const decoded = decodeAccountAs(idl.idl, entry.account, read.value.data);
    const provenance = { basis: "decoded" as const, slot: read.evidence.slot, evidenceIds: unique([read.evidence.id, ...idl.evidenceIds]) };
    singletons.push({ ...entry, address: key.toBase58(), ...decoded, value: object(toPlain(decoded.value), entry.id), ...provenance,
      derivation: derived ? { seeds: entry.derive!.seeds, bump: derived[1], ...provenance, basis: "derived" } : null });
  }
  const enumerations = [];
  for (const entry of contracts.enumerate) {
    if (entry.mode !== "full" && entry.mode !== "count") throw new Error(`contracts: unsupported enumeration mode ${entry.mode}`);
    const program = programKey(entry.program);
    const idl = requiredIdl(entry.program);
    if (!idl.idl.accounts?.some(a => a.name === entry.account)) throw new Error(`contracts: unknown ${entry.program} account ${entry.account}`);
    const filters = [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator(entry.account)) } }];
    const read = await rpc.getProgramAccounts(program, filters, entry.mode === "count" ? { offset: 0, length: 0 } : undefined);
    const provenance = { basis: "decoded" as const, slot: read.evidence.slot, evidenceIds: unique([read.evidence.id, ...idl.evidenceIds]) };
    const accounts = entry.mode === "count" ? undefined : read.value.map(a => {
      if (!a.account.owner.equals(program)) throw new Error(`contracts: ${a.pubkey} enumeration owner mismatch`);
      const decoded = decodeAccountAs(idl.idl, entry.account, a.account.data);
      return { address: a.pubkey.toBase58(), ...decoded, value: toPlain(decoded.value), ...provenance };
    });
    enumerations.push({ ...entry, count: read.value.length, ...provenance, ...(accounts === undefined ? {} : { accounts }) });
  }
  const state = singletons.find(s => s.id === "liquid-staking-state");
  const registrarState = singletons.find(s => s.id === "vsr-registrar-mnde");
  if (!state || !registrarState) throw new Error("contracts: liquid-staking State and MNDE Registrar singletons are required");
  const stateProvenance: Provenance = { basis: "decoded", slot: state.slot, evidenceIds: state.evidenceIds };
  const parameters = Object.entries(PARAMETER_UNITS).map(([path, unit]) => {
    const value = field(state.value, path);
    const raw = unit === "basis points" ? field(value, "basisPoints") : unit === "hundredths of a basis point" ? field(value, "bpCents") : value;
    if (path === "msolPrice") {
      const scaled = BigInt(String(raw));
      const solPerMsol = Number(scaled) / 2 ** 32;
      return { field: path, value, raw, unit, ...stateProvenance, scaling: { divisor: "4294967296", assumption: CONTRACT_ASSUMPTIONS[3], solPerMsol,
        sanityCheck: { min: 1, max: 3, passed: scaled >= 2n ** 32n && scaled <= 3n * 2n ** 32n } } };
    }
    return { field: path, value, raw, unit, ...stateProvenance, scaling: undefined };
  });
  const authorities: AuthorityRow[] = [];
  for (const path of AUTHORITY_FIELDS) {
    const stateField = path.endsWith("List") ? `${path}.account` : path;
    const key = address(state.value, stateField);
    const classification = await classify(key);
    const row: AuthorityRow = { field: path, stateField, address: key, classification, ...stateProvenance,
      evidenceIds: unique([...state.evidenceIds, ...classification.evidenceIds]) };
    if (path === "treasuryMsolAccount" || path === "liqPool.msolLeg") {
      const balance = await readTokenAccount(rpc, new PublicKey(key));
      row.balance = toPlain({ ...balance, unit: "raw token units", basis: "decoded" });
      row.evidenceIds = unique([...row.evidenceIds, ...balance.evidenceIds]);
    }
    authorities.push(row);
  }
  const liquidIdl = requiredIdl("liquid-staking");
  const inferred = parameterControl(liquidIdl.idl, state.account);
  const paths = stateFieldPaths(liquidIdl.idl, state.account);
  const inventory = instructionInventory(liquidIdl.idl);
  // These no-argument instructions cannot be discovered by argument matching.
  const pauseLinks = inventory.filter(i => ["pause", "resume"].includes(i.name)).map(i => ({ instruction: i.name, argPath: null, stateField: "paused", signerRoles: i.signerRoles, basis: "inferred" as const }));
  const links: Setting[] = [];
  for (const link of [...inferred.links, ...pauseLinks]) {
    const signers = [];
    for (const role of link.signerRoles) {
      const matches = matchingStateFields(role, paths);
      const holderField = matches.length === 1 ? matches[0] : null;
      let holder: string | null = null;
      if (holderField) {
        const candidate = field(state.value, holderField);
        if (typeof candidate === "string") {
          try { holder = new PublicKey(candidate).toBase58(); } catch { /* A name match is insufficient for a non-address field. */ }
        }
      }
      const classification = holder ? await classify(holder) : null;
      signers.push({ role, holderField, holder, classification, basis: "inferred" as const, slot: state.slot,
        evidenceIds: unique([...state.evidenceIds, ...liquidIdl.evidenceIds, ...(classification?.evidenceIds ?? [])]),
        ...(holder ? {} : { unresolved: "Signer role has no unique public-key field in State" }) });
    }
    links.push({ ...link, matchMethod: link.argPath === null ? "instruction-name alias" : "argument-name match", signers, slot: state.slot,
      evidenceIds: unique([...state.evidenceIds, ...liquidIdl.evidenceIds, ...signers.flatMap(s => s.evidenceIds)]) });
  }
  const controls = unique([...parameters.map(p => p.field), ...links.map(l => l.stateField)]).map(parameter => {
    const settings = links.filter(l => l.stateField === parameter);
    return { parameter, settings, basis: "inferred" as const, slot: state.slot,
      evidenceIds: unique([...state.evidenceIds, ...liquidIdl.evidenceIds, ...settings.flatMap(s => s.evidenceIds)]),
      ...(settings.length ? {} : { unresolved: "No setting instruction found by name matching" }) };
  });
  const registrarProvenance: Provenance = { basis: "decoded", slot: registrarState.slot, evidenceIds: registrarState.evidenceIds };
  const realmAuthorityKey = address(registrarState.value, "realmAuthority");
  const realmAuthorityClassification = await classify(realmAuthorityKey);
  const mintSlots = field(registrarState.value, "votingMints");
  if (!Array.isArray(mintSlots)) throw new Error("Registrar.votingMints: expected array");
  const votingMints = [];
  for (const [index, mint] of mintSlots.entries()) {
    const grantAuthority = address(mint, "grantAuthority");
    const classification = await classify(grantAuthority);
    votingMints.push({ index, mint: address(mint, "mint"), digitShift: field(mint, "digitShift"), baselineVoteWeightScaledFactor: field(mint, "baselineVoteWeightScaledFactor"),
      maxExtraLockupVoteWeightScaledFactor: field(mint, "maxExtraLockupVoteWeightScaledFactor"), lockupSaturationSecs: field(mint, "lockupSaturationSecs"),
      grantAuthority: { address: grantAuthority, classification, ...registrarProvenance, evidenceIds: unique([...registrarState.evidenceIds, ...classification.evidenceIds]) },
      ...registrarProvenance, evidenceIds: unique([...registrarState.evidenceIds, ...classification.evidenceIds]) });
  }
  const registrar = { address: registrarState.address, realm: address(registrarState.value, "realm"), governingTokenMint: address(registrarState.value, "realmGoverningTokenMint"),
    realmAuthority: { address: realmAuthorityKey, classification: realmAuthorityClassification, ...registrarProvenance, evidenceIds: unique([...registrarState.evidenceIds, ...realmAuthorityClassification.evidenceIds]) },
    votingMints, ...registrarProvenance };
  const expectedMint = (id: string) => {
    const mint = registry.mints.find(m => m.id === id);
    if (!mint) throw new Error(`contracts: missing registry mint ${id}`);
    return mint.address;
  };
  const checks = [
    { field: "State.msolMint", actual: address(state.value, "msolMint"), expected: expectedMint("msol"), ...stateProvenance },
    { field: "State.liqPool.lpMint", actual: address(state.value, "liqPool.lpMint"), expected: expectedMint("msol-sol-lp"), ...stateProvenance },
    { field: "Registrar.realm", actual: registrar.realm, expected: registry.governance.realm, ...registrarProvenance },
    { field: "Registrar.realmGoverningTokenMint", actual: registrar.governingTokenMint, expected: expectedMint("mnde"), ...registrarProvenance },
  ].map(c => ({ ...c, status: c.actual === c.expected ? "verified" : "contradiction" }));
  checks.push({ field: "Registrar.votingMints includes MNDE", actual: votingMints.some(m => m.mint === expectedMint("mnde")) ? expectedMint("mnde") : "absent", expected: expectedMint("mnde"),
    status: votingMints.some(m => m.mint === expectedMint("mnde")) ? "verified" : "contradiction", ...registrarProvenance });
  const rewardFee = field(state.value, "rewardFee.basisPoints");
  if (typeof rewardFee !== "number") throw new Error("State.rewardFee.basisPoints: expected number");
  const claim = registry.valueRouteClaims.find(c => c.id === "v1");
  if (!claim) throw new Error("contracts: registry value-route claim v1 missing");
  const claims = [{ id: "v1", text: claim.text, source: registry.sources[claim.source] ?? claim.source,
    status: rewardFee === 0 ? "verified" as const : "contradiction" as const,
    note: `Decoded rewardFee.basisPoints = ${rewardFee} basis points. ${rewardFee === 0 ? "Agrees with" : "Contradicts"} the registry claim that reward_fee is 0.`, ...stateProvenance }];
  const evidence = [...new Map(rpc.evidence.slice(evidenceStart).map(e => [e.id, e])).values()];
  const slots = evidence.flatMap(e => e.slot === null ? [] : [e.slot]);
  return { pack: contracts.pack, caseId: rpc.caseId, programs, singletons, enumerations, parameters, authorities,
    parameterControl: { controls, links, unmatched: inferred.unmatched.map(a => ({ ...a, basis: "inferred" as const, slot: liquidIdl.slot, evidenceIds: liquidIdl.evidenceIds })) },
    registrar, checks, claims, assumptions: CONTRACT_ASSUMPTIONS, evidence,
    asOfSlotRange: slots.length ? [Math.min(...slots), Math.max(...slots)] : [null, null] };
}
