import { fileURLToPath } from "node:url";
import { KIT_CSS } from "../../ui/page";
import { createNearContext, warmContext } from "./context";
import { createNearAgentHandler } from "./handler";
import { agentPage, CONTROL_CSS } from "./web/page";
import type { NearAgentContext } from "./types";

export const DEFAULT_PORT = 8792;
export const LOOPBACK = "127.0.0.1";
export function parseServeArgs(args: string[]): { host: string; port: number } | { error: string } {
  let port = DEFAULT_PORT;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!, value = args[++i];
    if (seen.has(name)) return { error: "invalid-launch-options" };
    seen.add(name);
    if (name === "--host" && (value === LOOPBACK || value === "localhost")) continue;
    if (name === "--port" && value && /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) { port = Number(value); continue; }
    return { error: "invalid-launch-options" };
  }
  return { host: LOOPBACK, port };
}
let script: Promise<string> | undefined;
function pageScript(): Promise<string> {
  return script ??= (async () => {
    const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./web/client.ts", import.meta.url))], target: "browser", format: "esm", minify: true });
    if (!built.success || built.outputs.length !== 1) throw new Error("page-script-not-built");
    return built.outputs[0]!.text();
  })();
}
const headers = { "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export async function startNearAgentServer(options: { port?: number; context?: NearAgentContext; handler?: (request: Request) => Promise<Response> } = {}): Promise<{ url: string; stop(): void }> {
  const context = options.context ?? await createNearContext({ warm: false });
  await warmContext(context);
  const handler = options.handler ?? createNearAgentHandler({ context });
  const code = await pageScript(), page = agentPage(context.subjects);
  const server = Bun.serve({ hostname: LOOPBACK, port: options.port ?? DEFAULT_PORT, idleTimeout: 120, fetch: async request => {
    const url = new URL(request.url);
    if (![LOOPBACK, "localhost"].includes(url.hostname)) return new Response(null, { status: 403 });
    const fixed = (body: string, type: string) => new Response(body, { headers: { ...headers, "Content-Type": type } });
    if (request.method === "GET" && url.pathname === "/") return fixed(page, "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/client.js") return fixed(code, "text/javascript; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/kit.css") return fixed(KIT_CSS, "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/controls.css") return fixed(CONTROL_CSS, "text/css; charset=utf-8");
    return handler(request);
  } });
  return { url: `http://${LOOPBACK}:${server.port}/`, stop: () => { void server.stop(true); } };
}
if (import.meta.main) {
  const options = parseServeArgs(process.argv.slice(2));
  if ("error" in options) { console.error(options.error); process.exit(2); }
  try { console.log(`near-agent ${(await startNearAgentServer({ port: options.port })).url}`); }
  catch { console.error("readiness-failed"); process.exit(2); }
}
