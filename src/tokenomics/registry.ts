import type { ProtocolId } from './api';
import type { TokenomicsBuild } from './build';
import { QUESTION } from './sections';
import { loadTokenomicsBundle } from './cache';
import { buildKaminoTokenomics, KAMINO_QUERY_IDS } from './kamino';
import { PROTOCOL_VIEW } from './protocols';
import { MARINADE_GRAPH_PROFILE, TOKENOMICS_QUERIES } from '../graph/tokenomics-neo4j';

export type ProtocolEntry = {
  id: ProtocolId; title: string; question?: string; coverage: string | null; namespace: string;
  cache: { kind: 'digest'; directory: 'out/tokenomics/marinade' } | { kind: 'none'; reason: string };
  mints: { id: string; label: string; address: string }[]; queryIds: string[];
  load(root: string, context: { marinadePack?: Parameters<typeof loadTokenomicsBundle>[0]['packResult'] }): Promise<TokenomicsBuild>;
};
export const TOKENOMICS_REGISTRY: readonly ProtocolEntry[] = [
  { id: 'marinade', title: PROTOCOL_VIEW.marinade.title, question: QUESTION, coverage: null, namespace: MARINADE_GRAPH_PROFILE.namespace,
    cache: { kind: 'digest', directory: 'out/tokenomics/marinade' }, mints: MARINADE_GRAPH_PROFILE.mints, queryIds: TOKENOMICS_QUERIES.map(q => q.id),
    load: async (root, context) => {
      if (!context.marinadePack) throw new Error('Captured Marinade pack is required');
      return loadTokenomicsBundle({ root, packResult: context.marinadePack });
    } },
  { id: 'kamino', title: PROTOCOL_VIEW.kamino.title, coverage: PROTOCOL_VIEW.kamino.coverage, namespace: 'TGKamino',
    cache: { kind: 'none', reason: 'replayed in memory from the committed capture at start' }, mints: [], queryIds: KAMINO_QUERY_IDS,
    load: async root => buildKaminoTokenomics({ root }) },
];
