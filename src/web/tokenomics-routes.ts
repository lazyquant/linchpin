import type { TokenomicsBuild } from '../tokenomics/build';
import type { ProtocolsResponse, SectionId } from '../tokenomics/api';
import { QUESTION } from '../tokenomics/sections';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
/** No filesystem reads, RPC requests or graph writes are performed by a route. */
export function tokenomicsRoutes(build: TokenomicsBuild | undefined, request: Request): Response {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
  if (request.method === 'POST' && request.headers.get('origin') && request.headers.get('origin') !== url.origin)
    return json({ error: 'Same-origin requests only' }, 403);
  if (parts[0] !== 'api' || parts[1] !== 'tokenomics' || (parts.length > 2 && parts[2] !== 'marinade')) return json({ error: 'Resource not found' }, 404);
  if (parts.length === 5 && parts[3] === 'graph' && parts[4] === 'load') {
    return request.method === 'POST' ? json({ error: 'tokenomics graph loader not built yet' }, 501) : json({ error: 'Method not allowed' }, 405);
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const known = parts.length === 2 || parts.length === 3 || parts.length === 4 && (parts[3] === 'evidence' || SECTIONS.includes(parts[3] as SectionId))
    || parts.length === 5 && parts[3] === 'export' && parts[4] === 'tokenomics.json';
  if (!known) return json({ error: 'Section or resource not found' }, 404);
  const ids = url.searchParams.getAll('id');
  if (parts[3] === 'evidence' && (ids.length > 200 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))))
    return json({ error: ids.length > 200 ? 'At most 200 evidence ids are allowed' : 'Evidence ids must be SHA-256 identifiers' }, 400);
  if (!build) return json({ error: 'Tokenomics captured build is not ready' }, 503);
  if (parts.length === 2) {
    const { asOf, slotRange } = build.evidence.metadata([...build.evidence.records.keys()]);
    const response: ProtocolsResponse = { protocols: [{ id: 'marinade', title: 'Marinade tokenomics', question: QUESTION, asOf, slotRange,
      sections: Object.fromEntries(SECTIONS.map(section => [section, build.bundle[section].status])) as ProtocolsResponse['protocols'][number]['sections'] }] };
    return json(response);
  }
  if (parts.length === 3) return json(build.bundle);
  if (parts[3] === 'evidence') return json(build.evidence.lookup(ids));
  if (parts[3] === 'export') return new Response(JSON.stringify(build.bundle, null, 2), { headers: {
    'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="linchpin-marinade-tokenomics.json"', 'Cache-Control': 'no-store',
  } });
  return json(build.bundle[parts[3] as SectionId]);
}
export const SECTIONS: SectionId[] = ['answer', 'path', 'control', 'offsets', 'parameters', 'programs', 'participation', 'holders', 'flows', 'claims', 'graph'];
