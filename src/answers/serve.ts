/**
 * The stand-alone launcher: one page on 127.0.0.1 with the answers handler behind it.
 *
 *   bun run src/answers/serve.ts [--port <n>] [--host 127.0.0.1|localhost]
 *
 * It binds the loopback address and nothing else. A host that is not loopback, or a port outside 1 to 65535,
 * ends it with one line on stderr and exit code 2 before anything is loaded.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBundleBackend } from "./bundle-backend";
import { createAnswersHandler } from "./handler";
import { PAGE_STYLE, answersPage } from "./web/page";

export const DEFAULT_PORT = 8791;
export const LOOPBACK = "127.0.0.1";
const USAGE = "usage: bun run src/answers/serve.ts [--port <n>] [--host 127.0.0.1|localhost]";

/** The launcher's arguments. Both accepted host names bind 127.0.0.1. */
export function parseServeArgs(argv: string[]): { host: string; port: number } | { error: string } {
  let port = DEFAULT_PORT;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    const value = argv[at + 1];
    if (flag === "--port") {
      if (value === undefined || !/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) return { error: `--port takes a whole number from 1 to 65535. ${USAGE}` };
      port = Number(value);
      at++;
    } else if (flag === "--host") {
      if (value !== LOOPBACK && value !== "localhost") return { error: `--host takes 127.0.0.1 or localhost; this page is served on the loopback address only. ${USAGE}` };
      at++;
    } else {
      return { error: `unknown argument. ${USAGE}` };
    }
  }
  return { host: LOOPBACK, port };
}

let script: Promise<string> | null = null;
/** The page script, built once per process for a browser. */
function pageScript(): Promise<string> {
  script ??= (async () => {
    const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./web/client.ts", import.meta.url))], target: "browser", format: "esm", minify: true });
    if (!built.success || built.outputs.length !== 1) throw new Error("page-script-not-built");
    return built.outputs[0].text();
  })();
  return script;
}

/** The page loads its one script from this origin, applies its one style element, and connects to this origin only. */
const CONTENT_POLICY = `default-src 'none'; script-src 'self'; style-src 'sha256-${createHash("sha256").update(PAGE_STYLE).digest("base64")}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const fixed = (body: string, type: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": type, "cache-control": "no-store", "content-security-policy": CONTENT_POLICY, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });

/**
 * Starts the page server on 127.0.0.1. Port 0 lets the system pick one. A request that names another host is
 * refused, so a page of another site cannot reach this server by a name that resolves to loopback.
 */
export async function startAnswersServer(opts: { port: number; handler: (request: Request) => Promise<Response> }): Promise<{ url: string; stop(): void }> {
  const page = answersPage();
  const code = await pageScript();
  const server = Bun.serve({
    hostname: LOOPBACK,
    port: opts.port,
    idleTimeout: 120,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== LOOPBACK && url.hostname !== "localhost") return new Response("", { status: 403 });
      if (request.method === "GET" && url.pathname === "/") return fixed(page, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/answers.js") return fixed(code, "text/javascript; charset=utf-8");
      return opts.handler(request);
    },
  });
  return { url: `http://${LOOPBACK}:${server.port}/`, stop: () => { void server.stop(true); } };
}

if (import.meta.main) {
  const args = parseServeArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(2);
  }
  try {
    const backend = loadBundleBackend();
    backend.catch(() => undefined);
    const handler = createAnswersHandler({ backend, logPath: process.env.LINCHPIN_AGENT_LOG || null });
    const server = await startAnswersServer({ port: args.port, handler });
    console.log(`answers ${server.url}`);
  } catch (error) {
    const known = error instanceof Error && (error.message === "log-inside-repository" || error.message === "page-script-not-built");
    console.error(known ? (error as Error).message : "the answers page could not start; the port may be in use");
    process.exit(2);
  }
}
