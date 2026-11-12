import { buildKaminoSnapshots, loadCapture, normalizeCapture, type KaminoMechanics } from '../../adapters/kamino';
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
export function seriesOf(snapshotId: string): string {
  if (/^solana-mainnet-beta\.kamino\.sentora-pyusd-/.test(snapshotId)) return 'kamino.sentora-pyusd';
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
];
export function collectSlice1Inputs(root = '.'): EvidenceInput[] {
  const snapshots = buildKaminoSnapshots(`${root}/fixtures/kamino`);
  return [
    ...snapshots.map(snapshot => ({snapshot, mechanics: normalizeCapture(loadCapture(`${root}/fixtures/kamino/${snapshot.id.replace('solana-mainnet-beta.kamino.', '')}`)).mechanics})),
    ...SLICE1_SNAPSHOT_IDS.filter(id => id.startsWith('near-')).map(id => ({snapshot:buildNearSnapshot(id, {root:`${root}/fixtures/near`})})),
  ];
}
