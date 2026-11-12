import type { TokenomicsBuild } from '../tokenomics/build';
import type { ProtocolsResponse, SectionId, ProtocolId } from '../tokenomics/api';
import type { TokenomicsGraphService } from '../tokenomics/graph-service';
import { GraphError } from './graph';
import { TOKENOMICS_REGISTRY } from '../tokenomics/registry';
import { isProtocolId } from '../tokenomics/protocols';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export type ProtocolSlot = { build?: TokenomicsBuild; graph?: TokenomicsGraphService; error?: string };
export async function tokenomicsRoutes(build: TokenomicsBuild | undefined, request: Request, graph?: TokenomicsGraphService): Promise<Response> {
  return tokenomicsProtocolRoutes(new Map([['marinade', { build, graph }]]), request);
}
/** Only graph routes access Neo4j; all chain research uses the captured offline bundle. */
export async function tokenomicsProtocolRoutes(slots: Map<ProtocolId, ProtocolSlot>, request: Request): Promise<Response> {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
  if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== url.origin)
    return json({ error: 'Same-origin requests only' }, 403);
  if (parts[0] !== 'api' || parts[1] !== 'tokenomics' || (parts.length > 2 && (!isProtocolId(parts[2]) || !slots.has(parts[2])))) return json({ error: 'Resource not found' }, 404);
  const id = (parts[2] ?? 'marinade') as ProtocolId;
  const { build, graph } = slots.get(id) ?? {};
  if (parts.length > 2 && !build && slots.get(id)?.error) return json({ error: 'Tokenomics captured build is not ready', detail: slots.get(id)!.error }, 503);
  if (parts.length === 5 && parts[3] === 'graph' && parts[4] === 'load') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!build) return json({ error: 'Tokenomics captured build is not ready' }, 503);
    if (!graph) return json({ error: 'Neo4j is not configured' }, 409);
    try { return json(await graph.load()); }
    catch (error) { return json({ error: error instanceof GraphError ? error.message : 'Tokenomics graph load failed' }, error instanceof GraphError ? error.status : 502); }
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const known = parts.length === 2 || parts.length === 3 || parts.length === 4 && (parts[3] === 'evidence' || SECTIONS.includes(parts[3] as SectionId))
    || parts.length === 5 && parts[3] === 'export' && parts[4] === 'tokenomics.json';
  if (!known) return json({ error: 'Section or resource not found' }, 404);
  const ids = url.searchParams.getAll('id');
  if (parts[3] === 'evidence' && (ids.length > 200 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))))
    return json({ error: ids.length > 200 ? 'At most 200 evidence ids are allowed' : 'Evidence ids must be SHA-256 identifiers' }, 400);
  if (!build) return json({ error: 'Tokenomics captured build is not ready' }, 503);
  const needsGraph = parts.length <= 3 || parts[3] === 'graph' || parts[3] === 'export';
  const graphData = graph && needsGraph ? await graph.query() : build.bundle.graph.data;
  const bundle = { ...build.bundle, graph: { ...build.bundle.graph, data: graphData,
    ...(graph?.failure ? { status: 'failed' as const, error: graph.failure } : {}) } };
  if (parts.length === 2) {
    const response: ProtocolsResponse & { message?: string } = { protocols: [] };
    for (const entry of TOKENOMICS_REGISTRY) {
      const slot = slots.get(entry.id);
      if (!slot?.build) {
        if (slot?.error) response.message = slot.error;
        continue;
      }
      const { asOf, slotRange } = slot.build.evidence.metadata([...slot.build.evidence.records.keys()]);
      response.protocols.push({ id: entry.id, title: entry.title, ...(entry.question === undefined ? {} : { question: entry.question }), asOf, slotRange,
        sections: Object.fromEntries(SECTIONS.map(section => [section, section === 'graph' && slot.graph?.failure ? 'failed' : slot.build!.bundle[section].status])) as ProtocolsResponse['protocols'][number]['sections'] });
    }
    return json(response);
  }
  if (parts.length === 3) return json(bundle);
  if (parts[3] === 'evidence') return json(build.evidence.lookup(ids));
  if (parts[3] === 'export') return new Response(JSON.stringify(bundle, null, 2), { headers: {
    'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="linchpin-${id}-tokenomics.json"`, 'Cache-Control': 'no-store',
  } });
  return json(bundle[parts[3] as SectionId]);
}
export const SECTIONS: SectionId[] = ['answer', 'path', 'control', 'offsets', 'parameters', 'programs', 'participation', 'holders', 'flows', 'claims', 'graph'];
