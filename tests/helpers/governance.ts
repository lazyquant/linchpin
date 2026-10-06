import { answerSection, controlSection, parametersSection, pathSection } from '../../src/tokenomics/sections';
import type { BundleResponse, ParticipationData, ProgramsData } from '../../src/tokenomics/api';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { Governance, Realm, RealmConfigAccount, TokenOwnerRecord, getGovernanceSchemaForAccount, getNativeTreasuryAddress, getRealmConfigAddress, type GovernanceAccountClass } from '@solana/spl-governance';
import bs58 from 'bs58';
import { key, hasFixture } from './contracts';
import { RecordingRpc } from '../../src/chain/rpc';
import { runOptions } from '../../src/config';
import { CANNOT_PROPOSE, governanceFieldOffset, readGovernanceConfig } from '../../src/contracts/governance-config';
import { MSOL_UPGRADE_AUTHORITY, type readAuthorities } from '../../src/contracts/authorities';
import type { ContractsLayer } from '../../src/contracts/participation';
import type { PackRegistry } from '../../src/pack/build';
import { TOKEN_PROGRAM } from '../../src/chain/token-layout';
import { EvidenceIndex } from '../../src/tokenomics/evidence';
import type { SectionInputs } from '../../src/tokenomics/sections';

/** Test-only writer walks the installed SDK schema, including its custom threshold encoding. */
export function sdkAccount(type: GovernanceAccountClass, accountType: number, values: Record<string, any>) {
  const schema = getGovernanceSchemaForAccount(accountType);
  function encode(t: any, v: any): Buffer {
    if (typeof t === 'function') return Buffer.concat(schema.get(t).fields.map(([field, kind]: [string, any]) => encode(kind, v?.[field])));
    if (Array.isArray(t) && typeof t[0] === 'number') return v ? Buffer.from(v) : Buffer.alloc(t[0]);
    if (t?.kind === 'option') return Buffer.concat([Buffer.from([v == null ? 0 : 1]), ...(v == null ? [] : [encode(t.type, v)])]);
    if (t === 'pubkey') return new PublicKey(v ?? key(0)).toBuffer();
    if (t === 'string') { const text = Buffer.from(v ?? ''); return Buffer.concat([encode('u32', text.length), text]); }
    if (t === 'VoteThreshold') return (v?.type ?? 2) === 2 ? Buffer.from([2]) : Buffer.from([v.type, v.value ?? 0]);
    if (/^u(8|16|32|64)$/.test(t)) { const bytes = Number(t.slice(1)) / 8, b = Buffer.alloc(bytes); let n = BigInt(v ?? 0); for (let i = 0; i < bytes; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b; }
    throw new Error(`Unsupported SDK test type ${t}`);
  }
  return encode(type, { ...values, accountType });
}
const info = (owner: string, data: Buffer): AccountInfo<Buffer> => ({ owner: new PublicKey(owner), data, executable: false, lamports: 1, rentEpoch: 0 });
const mint = (supply: bigint, decimals: number, authority: string | null = null) => {
  const b = Buffer.alloc(82); b.writeBigUInt64LE(supply, 36); b[44] = decimals; b[45] = 1;
  if (authority) { b.writeUInt32LE(1); new PublicKey(authority).toBuffer().copy(b, 4); } return info(TOKEN_PROGRAM.toBase58(), b);
};
export const dao = key(31), emergency = key(32), daoProgram = key(30), emergencyProgram = key(33), communityMint = key(34), councilMint = key(35), emergencyMint = key(36), vsr = key(37);
export const governanceKeys = [40, 41, 42, 43, 44].map(key);
export const configuration = (community: boolean, council: boolean, minCommunity = community ? '200000000000000' : CANNOT_PROPOSE, minCouncil = council ? '1' : CANNOT_PROPOSE) => ({
  communityVoteThreshold: { type: community ? 0 : 2, value: community ? 2 : undefined }, councilVoteThreshold: { type: council ? 0 : 2, value: council ? 50 : undefined },
  communityVetoVoteThreshold: { type: 2 }, councilVetoVoteThreshold: { type: council ? 0 : 2, value: council ? 50 : undefined },
  minCommunityTokensToCreateProposal: minCommunity, minCouncilTokensToCreateProposal: minCouncil, baseVotingTime: 86400, minInstructionHoldUpTime: 3600,
  votingCoolOffTime: 1800, communityVoteTipping: 0, councilVoteTipping: 1,
});
export async function syntheticGovernance() {
  const infos = new Map<string, AccountInfo<Buffer>>();
  const treasuries = await Promise.all(governanceKeys.map((g, n) => getNativeTreasuryAddress(new PublicKey(n === 4 ? emergencyProgram : daoProgram), new PublicKey(g)).then(k => k.toBase58())));
  for (const [address, program, council, name] of [[dao, daoProgram, councilMint, 'Marinade DAO'], [emergency, emergencyProgram, emergencyMint, 'Marinade DAO Emergency Council']]) {
    infos.set(address, info(program, sdkAccount(Realm, 16, { communityMint, name, config: { councilMint: council, useCommunityVoterWeightAddin: address === dao ? 1 : 0 } })));
    infos.set((await getRealmConfigAddress(new PublicKey(program), new PublicKey(address))).toBase58(), info(program, sdkAccount(RealmConfigAccount, 11, {
      realm: address, communityTokenConfig: { voterWeightAddin: address === dao ? vsr : null }, councilTokenConfig: {},
    })));
    infos.set(council, mint(address === dao ? 5n : 3n, 0, governanceKeys[0]));
    for (const [n, deposit] of (address === dao ? [[60, '1'], [61, '4'], [62, '0']] : [[60, '1'], [63, '2']])) {
      infos.set(key(Number(n) + (address === dao ? 10 : 20)), info(program, sdkAccount(TokenOwnerRecord, Number(n) % 2 ? 2 : 17, {
        realm: address, governingTokenMint: council, governingTokenOwner: key(Number(n)), governingTokenDepositAmount: deposit,
        governanceDelegate: Number(n) === 60 ? key(90) : null,
      })));
    }
  }
  infos.set(communityMint, mint(1000000000000000000n, 9));
  const configs = [configuration(false, true), configuration(true, true), configuration(true, false), configuration(true, true, CANNOT_PROPOSE, CANNOT_PROPOSE), configuration(false, true)];
  governanceKeys.forEach((g, n) => infos.set(g, info(n === 4 ? emergencyProgram : daoProgram, sdkAccount(Governance, 18, { realm: n === 4 ? emergency : dao, config: configs[n] }))));
  const rpc = new RecordingRpc(runOptions({ record: false, offline: false, minIntervalMs: 0, rpcUrl: 'http://127.0.0.1:1' }), 'marinade-contracts');
  rpc.connection.getAccountInfoAndContext = async k => ({ context: { slot: 42 }, value: infos.get(k.toBase58()) ?? null });
  rpc.connection.getProgramAccounts = (async (program: PublicKey, options: any) => ({ context: { slot: 42 }, value: [...infos].filter(([, a]) => a.owner.equals(program) && options.filters.every((f: any) => {
    const bytes = Buffer.from(bs58.decode(f.memcmp.bytes)); return a.data.subarray(f.memcmp.offset, f.memcmp.offset + bytes.length).equals(bytes);
  })).map(([address, account]) => ({ pubkey: new PublicKey(address), account })) })) as any;
  const fields = ['rewardFee', 'liqPool.lpMinFee', 'liqPool.lpMaxFee', 'liqPool.treasuryCut', 'withdrawStakeAccountFee', 'delayedUnstakeFee'];
  const layer = { evidence: [], assumptions: [],
    authorities: ['adminAuthority', 'pauseAuthority', 'validatorSystem.managerAuthority', 'treasuryMsolAccount'].map((field, n) => ({ field, address: [treasuries[0], treasuries[4], key(99), key(98)][n], classification: { kind: n < 2 ? 'native-treasury-pda' : 'wallet' } })),
    programs: [{ id: 'liquid-staking', address: key(100), upgradeAuthority: { kind: 'upgradeable', upgradeAuthority: MSOL_UPGRADE_AUTHORITY, evidenceIds: [] }, inventory: { instructions: [] } },
      { id: 'native-staking-proxy', address: key(101), upgradeAuthority: { kind: 'upgradeable', upgradeAuthority: treasuries[2], evidenceIds: [] }, inventory: { instructions: [] } }],
    parameters: fields.map(field => ({ field, raw: 0, unit: 'basis points' })),
    parameterControl: { links: ['configMarinade', 'configLp', 'changeAuthority', 'pause', 'resume'].map(instruction => ({ instruction,
      stateField: instruction === 'configMarinade' ? 'rewardFee' : instruction === 'configLp' ? 'liqPool.treasuryCut' : instruction === 'changeAuthority' ? 'treasuryMsolAccount' : 'paused',
      signers: [{ role: ['pause', 'resume'].includes(instruction) ? 'pauseAuthority' : 'adminAuthority', holder: ['pause', 'resume'].includes(instruction) ? treasuries[4] : treasuries[0] }] })), },
    registrar: { address: key(110), realm: dao, governingTokenMint: communityMint },
  } as unknown as ContractsLayer;
  // All synthetic source objects have empty provenance; the reader supplies real recorder evidence for governance accounts.
  layer.authorities.forEach(a => a.evidenceIds = []);
  const authorities = { evidence: [], assumptions: [], authorities: [
    { address: treasuries[4], resolutions: [{ status: 'resolved', realm: emergency, program: emergencyProgram, realmName: 'Marinade DAO Emergency Council', governance: governanceKeys[4] }], evidenceIds: [] },
    { address: MSOL_UPGRADE_AUTHORITY, resolutions: [{ status: 'resolved', derivation: { kind: 'serum-multisig' }, multisig: key(111), program: key(112), threshold: '2', layoutBasis: 'claimed',
      owners: [60, 61, 64].map(n => ({ address: key(n) })), evidenceIds: [] }], evidenceIds: [] },
  ] } as unknown as Awaited<ReturnType<typeof readAuthorities>>;
  const registry = { pack: 'marinade', governance: { realm: dao, program: daoProgram }, mints: [{ id: 'mnde', address: communityMint }], programs: [{ id: 'vsr', address: vsr }],
    accounts: [{ id: 'dao-treasury', address: treasuries[1] }, { id: 'labs-treasury', address: treasuries[2] }] } as unknown as PackRegistry;
  const governance = await readGovernanceConfig(rpc, registry, layer, authorities);
  const evidence = new EvidenceIndex(governance.evidence.map(e => ({ ...e, source: 'fixture', fixture: null })));
  const i = { governance, layer, authorities, registry, evidence, registryId: governance.evidence[0].id,
    pack: { controllerPaths: [{ subject: key(98), authority: key(99), authorityKind: 'wallet', path: [], authorityType: 'owner' }] },
    participation: { nativeProxy: { authorities: [] }, vsr: { shareOfSupply: { value: 0 } } },
    holders: { mnde: { owners: treasuries.slice(1, 3).map(owner => ({ owner, amountRaw: '1000000000' })) }, classifications: [] },
    flows: { routes: [], treasury: { window: { oldestBlockTime: null, newestBlockTime: null }, transactions: [], byInstruction: [] },
      treasuryAuthority: { transfers: [] }, buybacks: { window: { oldestBlockTime: null, newestBlockTime: null }, transactions: [], months: [], voterAuthorityShare: { value: null } }, claims: [] },
  } as unknown as SectionInputs;
  return { i, rpc, infos, treasuries };
}
export function hasGovernanceFixture(registry: PackRegistry) {
  return hasFixture('getProgramAccounts', { programId: registry.governance.program, filters: [
    { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([17])) } },
    { memcmp: { offset: governanceFieldOffset(TokenOwnerRecord, 'realm'), bytes: registry.governance.realm } },
    { memcmp: { offset: governanceFieldOffset(TokenOwnerRecord, 'governingTokenMint'), bytes: '6MGwpuJ5YE1c8jJaF8FKurQdDJeYRf1adX76dovkXxRs' } },
  ] });
}

export async function syntheticAnswer() {
  const { i, treasuries } = await syntheticGovernance();
  const control = controlSection(i), parameters = parametersSection(i, control), path = pathSection(i, parameters, control, { rows: [] });
  const participation = { locking: ['locked-mnde', 'deposited-mnde'].map(id => ({ id, amount: { display: '0', shareOfSupply: 0 }, evidenceIds: [] })) } as unknown as ParticipationData;
  const programs = { rows: [{ id: 'liquid-staking', upgradeAuthority: { controllerId: control.rows.find(r => r.id === 'control:program:liquid-staking')!.controllerId }, activity: { dormant: false } }] } as unknown as ProgramsData;
  const answer = answerSection(i, path, control, parameters, participation, programs);
  const bundle = { path: { data: path }, control: { data: control }, programs: { data: programs }, parameters: { data: parameters },
    holders: { data: null }, claims: { data: null }, participation: { data: null } } as unknown as BundleResponse;
  return { i, treasuries, answer, path, control, parameters, bundle };
}

