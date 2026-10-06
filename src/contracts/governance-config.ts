import { PublicKey, type AccountInfo, type GetProgramAccountsFilter } from '@solana/web3.js';
import { Governance, GovernanceAccountParser, Realm, RealmConfigAccount, TokenOwnerRecord, VoteThresholdType, VoteTipping,
  getAccountTypes, getGovernanceSchemaForAccount, getNativeTreasuryAddress, getRealmConfigAddress,
  type GovernanceAccountClass, type GovernanceConfig, type VoteThreshold } from '@solana/spl-governance';
import bs58 from 'bs58';
import type { RecordingRpc } from '../chain/rpc';
import type { PackRegistry } from '../pack/build';
import { formatUnits } from '../chain/token-layout';
import { readMintState } from '../pack/classify';
import { provenance, type ContractsLayer, type Provenance } from './participation';
import { MSOL_UPGRADE_AUTHORITY, type readAuthorities } from './authorities';

export const CANNOT_PROPOSE = '18446744073709551615';
export type VotingBody = 'council-only' | 'community-only' | 'community-and-council' | 'no-proposals';
export type Threshold = { type: string; value: number | null; enabled: boolean };
export type VotingSide = { vote: Threshold; veto: Threshold; proposalMinimumRaw: string; canPropose: boolean; tipping: string };
export type GovernanceConfiguration = { community: VotingSide; council: VotingSide; votingTimeSeconds: number; votingCoolOffSeconds: number; instructionHoldUpSeconds: number };
export type ConfiguredGovernance = Provenance & { address: string; realm: string; program: string; nativeTreasury: string; votingBody: VotingBody; config: GovernanceConfiguration };
export type CouncilRecord = Provenance & { address: string; owner: string; depositedRaw: string; delegate: string | null };
export type ConfiguredRealm = Provenance & { address: string; program: string; name: string; communityMint: string; communityDecimals: number;
  councilMint: string | null; councilSupplyRaw: string | null; councilDecimals: number | null; councilMintAuthority: string | null;
  addins: { community: { voterWeight: string | null; maxVoterWeight: string | null }; council: { voterWeight: string | null; maxVoterWeight: string | null } };
  records: CouncilRecord[]; members: CouncilRecord[] };
export type GovernanceMapping = Provenance & { target: string; address: string | null; governance: string | null; realm: string | null; votingBody: VotingBody | null };
export type GovernanceLayer = Provenance & { realms: ConfiguredRealm[]; governances: ConfiguredGovernance[]; mappings: GovernanceMapping[];
  overlaps: (Provenance & { realm: string; multisig: string; owners: string[]; count: number; signerCount: number })[];
  evidence: RecordingRpc['evidence']; assumptions: string[] };

/** Derive fixed prefix offsets from every SDK account version, failing if they disagree. */
export function governanceFieldOffset(account: GovernanceAccountClass, field: string): number {
  const offsets = getAccountTypes(account).map(type => {
    const schema = getGovernanceSchemaForAccount(type);
    function size(t: unknown): number {
      if (typeof t === 'string') {
        const n = ({ u8: 1, u16: 2, u32: 4, u64: 8, pubkey: 32 } as Record<string, number>)[t];
        if (n) return n;
      }
      if (Array.isArray(t) && t.length === 1 && typeof t[0] === 'number') return t[0];
      if (typeof t === 'function' && schema.get(t)?.kind === 'struct') return schema.get(t).fields.reduce((n: number, f: [string, unknown]) => n + size(f[1]), 0);
      throw new Error(`Variable SDK layout before ${account.name}.${field}`);
    }
    let offset = 0;
    for (const [name, type] of schema.get(account).fields) { if (name === field) return offset; offset += size(type); }
    throw new Error(`Missing SDK field ${account.name}.${field}`);
  });
  if (new Set(offsets).size !== 1) throw new Error(`SDK versions disagree on ${account.name}.${field}`);
  return offsets[0];
}
export function parseGovernanceConfig(config: GovernanceConfig, hasCouncil = true): GovernanceConfiguration {
  const threshold = (t: VoteThreshold): Threshold => ({ type: VoteThresholdType[t.type], value: t.value ?? null, enabled: t.type !== VoteThresholdType.Disabled });
  const side = (s: 'community' | 'council'): VotingSide => {
    const minimum = (s === 'community' ? config.minCommunityTokensToCreateProposal : config.minCouncilTokensToCreateProposal).toString();
    const vote = threshold(config[`${s}VoteThreshold`]);
    return { vote, veto: threshold(config[`${s}VetoVoteThreshold`]), proposalMinimumRaw: minimum,
      canPropose: vote.enabled && (s === 'community' || hasCouncil) && minimum !== CANNOT_PROPOSE, tipping: VoteTipping[config[`${s}VoteTipping`]] };
  };
  return { community: side('community'), council: side('council'), votingTimeSeconds: config.baseVotingTime,
    votingCoolOffSeconds: config.votingCoolOffTime, instructionHoldUpSeconds: config.minInstructionHoldUpTime };
}
export function classifyVotingBody(config: GovernanceConfiguration, hasCouncil = true): VotingBody {
  if (!config.community.canPropose && !config.council.canPropose) return 'no-proposals';
  if (!config.community.vote.enabled && hasCouncil && config.council.vote.enabled) return 'council-only';
  if (!hasCouncil || !config.council.vote.enabled) return 'community-only';
  return 'community-and-council';
}
export function governanceThresholdText(g: ConfiguredGovernance, realm: ConfiguredRealm): string {
  const threshold = (t: Threshold) => t.enabled ? `${t.type === 'QuorumPercentage' ? 'quorum ' : ''}${t.value} %` : 'disabled';
  const minimum = (s: VotingSide, decimals: number, unit: string) => s.canPropose ? `${formatUnits(BigInt(s.proposalMinimumRaw), decimals)} ${unit} to propose` : 'cannot propose';
  return `community vote ${threshold(g.config.community.vote)}; ${minimum(g.config.community, realm.communityDecimals, 'community tokens')}; council vote ${threshold(g.config.council.vote)}; ${minimum(g.config.council, realm.councilDecimals ?? 0, 'council tokens')}; community veto ${threshold(g.config.community.veto)}; council veto ${threshold(g.config.council.veto)}`;
}

export async function readGovernanceConfig(rpc: RecordingRpc, registry: PackRegistry, layer: ContractsLayer, authorities: Awaited<ReturnType<typeof readAuthorities>>): Promise<GovernanceLayer> {
  const start = rpc.evidence.length;
  const realms: ConfiguredRealm[] = [], governances: ConfiguredGovernance[] = [];
  const discovered = new Map([[registry.governance.realm, registry.governance.program]]);
  for (const a of authorities.authorities) for (const r of a.resolutions) if (r.status === 'resolved' && r.realm) discovered.set(r.realm, r.program);
  const p = (ids: string[], basis: Provenance['basis'] = 'decoded') => provenance(rpc.evidence, ids, basis);
  function parse<T>(address: PublicKey, info: AccountInfo<Buffer> | null, program: PublicKey, type: GovernanceAccountClass): T {
    if (!info || !info.owner.equals(program) || !getAccountTypes(type).includes(info.data[0])) throw new Error(`governance: invalid ${type.name} ${address}`);
    return GovernanceAccountParser(type)(address, info).account as T;
  }
  async function enumerate<T>(program: PublicKey, type: GovernanceAccountClass, filters: GetProgramAccountsFilter[]) {
    const rows: { address: PublicKey; account: T; evidenceIds: string[] }[] = [], evidenceIds: string[] = [];
    for (const accountType of getAccountTypes(type)) {
      const result = await rpc.getProgramAccounts(program, [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([accountType])) } }, ...filters]);
      evidenceIds.push(result.evidence.id);
      for (const r of result.value) rows.push({ address: r.pubkey, account: parse<T>(r.pubkey, r.account, program, type), evidenceIds: [result.evidence.id] });
    }
    return { rows, evidenceIds };
  }
  for (const [address, programAddress] of discovered) {
    const key = new PublicKey(address), program = new PublicKey(programAddress);
    const read = await rpc.getAccountInfo(key), realm = parse<Realm>(key, read.value, program, Realm);
    const configKey = await getRealmConfigAddress(program, key), configRead = await rpc.getAccountInfo(configKey);
    const config = configRead.value ? parse<RealmConfigAccount>(configKey, configRead.value, program, RealmConfigAccount) : null;
    if (config && !config.realm.equals(key)) throw new Error('governance: realm config mismatch');
    if (!config && (realm.config.useCommunityVoterWeightAddin || realm.config.useMaxCommunityVoterWeightAddin)) throw new Error('governance: missing required voter-weight addin config');
    const communityMint = await readMintState(rpc, realm.communityMint);
    if (!communityMint.value) throw new Error('governance: missing community mint');
    const councilMint = realm.config.councilMint ? await readMintState(rpc, realm.config.councilMint) : null;
    if (councilMint && !councilMint.value) throw new Error('governance: missing council mint');
    const records: CouncilRecord[] = [], recordIds: string[] = [];
    if (realm.config.councilMint) {
      const result = await enumerate<TokenOwnerRecord>(program, TokenOwnerRecord, [
        { memcmp: { offset: governanceFieldOffset(TokenOwnerRecord, 'realm'), bytes: address } },
        { memcmp: { offset: governanceFieldOffset(TokenOwnerRecord, 'governingTokenMint'), bytes: realm.config.councilMint.toBase58() } },
      ]);
      recordIds.push(...result.evidenceIds);
      for (const r of result.rows) {
        if (!r.account.realm.equals(key) || !r.account.governingTokenMint.equals(realm.config.councilMint)) throw new Error('governance: council record filter mismatch');
        records.push({ address: r.address.toBase58(), owner: r.account.governingTokenOwner.toBase58(), depositedRaw: r.account.governingTokenDepositAmount.toString(),
          delegate: r.account.governanceDelegate?.toBase58() ?? null, ...p(r.evidenceIds) });
      }
    }
    records.sort((a, b) => a.owner.localeCompare(b.owner));
    const addin = (s: 'community' | 'council') => ({ voterWeight: config?.[`${s}TokenConfig`].voterWeightAddin?.toBase58() ?? null, maxVoterWeight: config?.[`${s}TokenConfig`].maxVoterWeightAddin?.toBase58() ?? null });
    realms.push({ address, program: programAddress, name: realm.name, communityMint: realm.communityMint.toBase58(), communityDecimals: communityMint.value.decimals,
      councilMint: realm.config.councilMint?.toBase58() ?? null, councilSupplyRaw: councilMint?.value?.supplyRaw.toString() ?? null,
      councilDecimals: councilMint?.value?.decimals ?? null, councilMintAuthority: councilMint?.value?.mintAuthority ?? null,
      addins: { community: addin('community'), council: addin('council') }, records, members: records.filter(r => BigInt(r.depositedRaw) > 0n),
      ...p([read.evidence.id, configRead.evidence.id, ...communityMint.evidenceIds, ...(councilMint?.evidenceIds ?? []), ...recordIds]) });
    const result = await enumerate<Governance>(program, Governance, [{ memcmp: { offset: governanceFieldOffset(Governance, 'realm'), bytes: address } }]);
    for (const r of result.rows) {
      if (!r.account.realm.equals(key)) throw new Error('governance: realm filter mismatch');
      const config = parseGovernanceConfig(r.account.config, !!realm.config.councilMint);
      governances.push({ address: r.address.toBase58(), realm: address, program: programAddress, nativeTreasury: (await getNativeTreasuryAddress(program, r.address)).toBase58(),
        config, votingBody: classifyVotingBody(config, !!realm.config.councilMint), ...p(r.evidenceIds, 'derived') });
    }
  }
  const evidence = [...new Map([...layer.evidence, ...authorities.evidence, ...rpc.evidence.slice(start)].map(e => [e.id, e])).values()];
  const targets = [
    ...layer.authorities.map(a => ({ target: a.field, address: a.address, evidenceIds: a.evidenceIds })),
    ...layer.programs.map(a => ({ target: `${a.id} upgrade authority`, address: a.upgradeAuthority.kind === 'upgradeable' ? a.upgradeAuthority.upgradeAuthority : null, evidenceIds: a.upgradeAuthority.evidenceIds })),
    ...authorities.authorities.map(a => ({ target: 'tracked authority', address: a.address, evidenceIds: a.evidenceIds })),
    ...realms.map(r => ({ target: `${r.name} council mint authority`, address: r.councilMintAuthority, evidenceIds: r.evidenceIds })),
    // Complete treasury index; the API joins this to ALL MNDE owners, not only top holders.
    ...governances.map(g => ({ target: 'native treasury', address: g.nativeTreasury, evidenceIds: g.evidenceIds })),
  ];
  const mappings = targets.map(t => {
    const g = governances.find(g => g.address === t.address || g.nativeTreasury === t.address);
    return { ...t, governance: g?.address ?? null, realm: g?.realm ?? null, votingBody: g?.votingBody ?? null,
      ...provenance(evidence, [...t.evidenceIds, ...(g?.evidenceIds ?? [])], 'derived') };
  });
  const multisig = authorities.authorities.find(a => a.address === MSOL_UPGRADE_AUTHORITY)?.resolutions.find(r => r.status === 'resolved' && r.derivation.kind === 'serum-multisig');
  const overlaps: GovernanceLayer['overlaps'] = multisig?.status === 'resolved' && multisig.owners ? realms.map(r => {
    const owners = [...new Set(r.members.map(m => m.owner))].filter(owner => multisig.owners!.some(m => m.address === owner));
    return { realm: r.address, multisig: multisig.multisig!, owners, count: owners.length, signerCount: multisig.owners!.length,
      ...provenance(evidence, [...r.evidenceIds, ...multisig.evidenceIds], 'derived') };
  }) : [];
  return { realms, governances: governances.sort((a, b) => a.address.localeCompare(b.address)), mappings, overlaps, evidence,
    ...provenance(evidence), assumptions: [
      'SDK-parsed governance configuration is current recorded state, not historical voting or proof of a proposal execution. Separate reads are not atomic.',
      'Council members are governing token owners with positive council deposits; delegates are reported separately. Membership overlap establishes shared addresses, not human identities.',
      'Disabled vote thresholds turn voting off; u64::MAX proposal minima prohibit proposals. Veto permission is reported separately from proposal creation.',
    ] };
}
