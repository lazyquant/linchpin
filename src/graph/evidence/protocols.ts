import { buildKaminoSnapshots, loadCapture, normalizeCapture, type KaminoMechanics } from '../../adapters/kamino';
import { VAULT_TARGETS, isVaultSlug, type VaultSlug } from '../../adapters/kamino';
import { buildKaminoLendResults } from '../../adapters/kamino-lend';
import { buildNearSnapshot } from '../../near/reader/load';
import { NEAR_REGISTRY } from '../../near/subjects/registry';
import type { EvidenceSnapshot } from '../../engine/queries/snapshot';
import { MECHANICS, type Mechanic } from './schema';

export interface EvidenceInput { snapshot: EvidenceSnapshot; mechanics?: KaminoMechanics }
export interface ProtocolEntry {
  id: string; title: string; series: string; source: string;
  memberRule: 'snapshot-subjects' | 'near-registry'; members: string[];
  coverage: { mechanic: Mechanic; status: 'mapped' | 'partial' | 'not-mapped'; note: string }[];
}
export const SLICE1_SNAPSHOT_IDS = [
  'solana-mainnet-beta.kamino.sentora-pyusd-20261109T163416Z',
  'solana-mainnet-beta.kamino.sentora-pyusd-20261109T170418Z',
  'near-2026-11-09', 'near-constructed-intents-locker-added',
  'near-constructed-governance-expired', 'near-constructed-governance-kinds',
  'near-constructed-governance-policy-changed',
] as const;
export class BuildRejected extends Error {
  constructor(readonly code: string) { super(`Build rejected: ${code}`); this.name = 'BuildRejected'; }
}
export const KAMINO_VAULT_SLUGS = Object.keys(VAULT_TARGETS).filter((slug): slug is Exclude<VaultSlug, 'sentora-pyusd'> => isVaultSlug(slug) && slug !== 'sentora-pyusd');
const KAMINO_VAULT_NAMES: Record<Exclude<VaultSlug, 'sentora-pyusd'>, string> = {
  'rwa-usdc': 'RWA USDC',
  'steakhouse-hy-usdg': 'Steakhouse High Yield USDG',
  'kamino-commodity-yield': 'Kamino Institutional Commodity Yield',
  'ethena-pyusd-prime': 'Ethena PYUSD Prime',
  'allez-sol': 'Allez SOL',
};
export function seriesOf(snapshotId: string): string {
  if (/^solana-mainnet-beta\.kamino\.sentora-pyusd-/.test(snapshotId)) return 'kamino.sentora-pyusd';
  if (/^solana-mainnet-beta\.kamino-lend\.main-market-/.test(snapshotId)) return 'kamino-lend.main-market';
  for (const slug of KAMINO_VAULT_SLUGS) {
    if (snapshotId.startsWith(`solana-mainnet-beta.kamino.${slug}-`)) return `kamino.${slug}`;
  }
  if (/^near-(?:\d{4}-\d{2}-\d{2}|constructed-.+)$/.test(snapshotId)) return 'near.control-surface';
  throw new BuildRejected('unregistered-series');
}
export const PROTOCOLS: ProtocolEntry[] = [
  {id:'protocol:kamino', title:'Kamino', series:'kamino.sentora-pyusd', source:'src/adapters/kamino (snapshot subjects)', memberRule:'snapshot-subjects', members:[],
    coverage: MECHANICS.map(mechanic => ({mechanic, status: ['control','code-upgrade','dependencies'].includes(mechanic) ? 'mapped' : 'not-mapped', note: ['control','code-upgrade','dependencies'].includes(mechanic) ? `Kamino adapter maps ${mechanic} for the captured vault; external controller internals are unknown.` : `Kamino adapter does not map ${mechanic} in this capture; absence is not evidence of absence.`}))},
  ...(['rhea','intents','governance','mpc'] as const).map(slug => ({
    id:`protocol:${slug}`, title:slug, series:'near.control-surface', source:'src/near/subjects/registry.ts', memberRule:'near-registry' as const,
    members: NEAR_REGISTRY.filter(entry => entry.chains.includes(slug)).map(entry => entry.subject).sort(),
    coverage: MECHANICS.map(mechanic => ({mechanic, status: (['control','code-upgrade'].includes(mechanic) || (['governance','dependencies'].includes(mechanic) && slug !== 'mpc') || (mechanic === 'supply' && slug === 'intents') ? 'partial' : 'not-mapped') as 'partial' | 'not-mapped', note:`NEAR control-surface reader provides bounded ${mechanic} coverage only; it does not read complete protocol history, balances, or external controller state.`})),
  })),
  {id:'protocol:kamino-lend', title:'Kamino Lend main market', series:'kamino-lend.main-market', source:'src/adapters/kamino-lend (snapshot subjects)', memberRule:'snapshot-subjects', members:[],
    coverage: MECHANICS.map(mechanic => ({mechanic, status: ['control','code-upgrade','dependencies'].includes(mechanic) ? 'mapped' : 'not-mapped', note: ['control','code-upgrade','dependencies'].includes(mechanic) ? `Kamino Lend adapter maps ${mechanic} for the recorded main market; it does not read reserve status, Scope chain indices, multisig time locks, pending owner and admin, or the members of the Squads v3 global admin.` : `Kamino Lend adapter does not map ${mechanic} in this capture; absence is not evidence of absence. The capture leaves out reserve status, Scope chain indices, multisig time locks, pending owner and admin, and the members of the Squads v3 global admin.`}))},
  ...KAMINO_VAULT_SLUGS.map((slug): ProtocolEntry => ({
    id:`protocol:kamino-vault-${slug}`, title:`Kamino kVault ${KAMINO_VAULT_NAMES[slug]}`, series:`kamino.${slug}`, source:'src/adapters/kamino (snapshot subjects)', memberRule:'snapshot-subjects', members:[],
    coverage: MECHANICS.map(mechanic => ({mechanic, status: ['control','code-upgrade','dependencies'].includes(mechanic) ? 'mapped' : 'not-mapped', note: ['control','code-upgrade','dependencies'].includes(mechanic) ? `Kamino adapter maps ${mechanic} for the captured vault ${KAMINO_VAULT_NAMES[slug]}; external controller internals are unknown.` : `Kamino adapter does not map ${mechanic} in the ${KAMINO_VAULT_NAMES[slug]} capture; absence is not evidence of absence.`})),
  })),
];
export function collectSlice1Inputs(root = '.'): EvidenceInput[] {
  const snapshots = buildKaminoSnapshots(`${root}/fixtures/kamino`);
  return [
    ...snapshots.map(snapshot => ({snapshot, mechanics: normalizeCapture(loadCapture(`${root}/fixtures/kamino/${snapshot.id.replace('solana-mainnet-beta.kamino.', '')}`)).mechanics})),
    ...SLICE1_SNAPSHOT_IDS.filter(id => id.startsWith('near-')).map(id => ({snapshot:buildNearSnapshot(id, {root:`${root}/fixtures/near`})})),
  ];
}

export function collectEvidenceInputs(root = '.'): EvidenceInput[] {
  return [
    ...collectSlice1Inputs(root),
    ...buildKaminoLendResults(`${root}/fixtures/kamino-lend`).map(({snapshot, mechanics}) => ({snapshot, mechanics})),
    ...KAMINO_VAULT_SLUGS.flatMap(slug => {
      const dir = `${root}/fixtures/kamino-vaults/${slug}`;
      return buildKaminoSnapshots(dir).map(snapshot => ({snapshot, mechanics: normalizeCapture(loadCapture(`${dir}/${snapshot.id.replace('solana-mainnet-beta.kamino.', '')}`)).mechanics}));
    }),
  ];
}
