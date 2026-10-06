/** Frontend-only development launcher while the API worktree is developed separately.
 * Start the research backend on 8877, then: bun run src/web/tokenomics-preview.ts
 * After integration, the normal web server serves this same frontend directly.
 */
import index from './index.html';
const backend = new URL(process.env.LINCHPIN_TOKENOMICS_BACKEND ?? 'http://127.0.0.1:8877');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname) || backend.protocol !== 'http:') throw new Error('Preview backend must be an HTTP loopback address');
const port = Number(process.env.LINCHPIN_WEB_PORT ?? 8876);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Preview port must be 1024–65535');
Bun.serve({
  hostname:'127.0.0.1', port, idleTimeout:150, routes:{'/':index}, development:false,
  async fetch(request) {
    const url=new URL(request.url);
    if (!url.pathname.startsWith('/api/') && !['/favicon.svg','/favicon.ico'].includes(url.pathname)) return new Response('Not found',{status:404});
    if(request.method==='POST'&&request.headers.get('origin')&&request.headers.get('origin')!==url.origin) return Response.json({error:'Same-origin requests only'},{status:403});
    const target=new URL(url.pathname+url.search,backend);
    const headers=new Headers(request.headers);headers.delete('host');if(headers.has('origin'))headers.set('origin',backend.origin);
    try { return await fetch(target,{method:request.method,headers,body:request.method==='GET'||request.method==='HEAD'?undefined:request.body,signal:AbortSignal.timeout(145_000),redirect:'error'}); }
    catch { return Response.json({error:'The local research backend is unavailable. Start it on port 8877, then retry.'},{status:503}); }
  },
});
console.log(`Linchpin tokenomics frontend: http://127.0.0.1:${port} · local API proxy ready`);
