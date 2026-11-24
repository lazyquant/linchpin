/**
 * The desk's loopback server. It binds 127.0.0.1 and nothing else. Every route under /api/desk/ is refused with
 * an empty 403 unless the request names this server as its host, comes from this origin when it names one, and
 * carries the launch token. The page, its script and its stylesheet are served without the token and hold no
 * value. A view is served only when the kit's validator passes it.
 */
import { fileURLToPath } from "node:url";
import { canonical } from "../chain/evidence";
import { ruleSubjects } from "../near/private/watch";
import { KIT_CSS } from "../ui/page";
import { answerSegments, idResolver } from "./answer";
import type { AgentInfo, AnswerBody } from "./chrome";
import deskCss from "./desk.css" with { type: "text" };
import { guardHit, guardTerms } from "./guard";
import { AgentFailure, agentConfig, askIronclaw, IRONCLAW_TIMEOUT_MS, RESPONSE_ID } from "./ironclaw";
import { deskPage } from "./page";
import { DeskRejected, MAX_TYPED_ADDRESSES, nearPositions, parseDeskAddress, readAddress, type DeskDeps, type DeskState } from "./state";
import { DESK_STRINGS as S, DESK_TEXT as T } from "./strings";
import { isDeskView, servePositionsSurface, serveSurface } from "./surfaces";

export interface DeskTestHooks {
  /** Receipt ids taken out of what a surface may cite, to show that an unresolved citation refuses the view. */
  missingReceiptIds?: string[];
  /** How long the agent call may take; the default is sixty seconds. */
  ironclawTimeoutMs?: number;
}

export interface DeskServerOptions {
  state: DeskState;
  deps: DeskDeps;
  /** 1 to 65535, or 0 for a port the system picks. */
  port: number;
  /** One line per request: method, route and status. Never a body, a header, an address or the token. */
  log?: (line: string) => void;
  testHooks?: DeskTestHooks;
}

export interface DeskServer { origin: string; token: string; port: number; stop(): Promise<void> }

export const DESK_HOST = "127.0.0.1";
export const DESK_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'";
const MAX_BODY = 16384;
const MAX_QUESTION = 4000;
/** How many response ids of the agent the server keeps for a follow-up; the oldest is dropped first. */
export const MAX_ISSUED_RESPONSE_IDS = 64;

let bundle: Promise<string> | null = null;
/** The page script, built once per process from the desk's client module. */
export function clientBundle(): Promise<string> {
  bundle ??= (async () => {
    const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./client.ts", import.meta.url))], target: "browser", format: "esm", minify: true });
    if (!built.success || built.outputs.length !== 1) throw new DeskRejected("page-script-not-built");
    return built.outputs[0].text();
  })();
  return bundle;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const text = (body: string, type: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": type, "cache-control": "no-store", "content-security-policy": DESK_CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
const empty = (status: number): Response => new Response("", { status, headers: { "cache-control": "no-store" } });

async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new DeskRejected("bad-request");
  try {
    return JSON.parse(raw);
  } catch {
    throw new DeskRejected("bad-request");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Starts the server. Throws `DeskRejected("port-in-use")` when the port cannot be bound. */
export async function startDesk(options: DeskServerOptions): Promise<DeskServer> {
  const { state, deps } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const hooks = options.testHooks ?? {};
  const token = newToken();
  const script = await clientBundle();
  const page = deskPage();
  const stylesheet = `${KIT_CSS}\n${deskCss}`;
  let origin = "";
  let hostHeader = "";
  let asking = false;
  let reading: Promise<unknown> = Promise.resolve();
  // The response ids the agent returned to this server, oldest first. A follow-up may name one of these and no
  // other value, so what goes out as the previous response id is never text the page supplied.
  const issuedResponseIds = new Set<string>();
  const rememberResponseId = (id: string | null): void => {
    if (id === null || !RESPONSE_ID.test(id)) return;
    issuedResponseIds.delete(id);
    issuedResponseIds.add(id);
    for (const oldest of issuedResponseIds) {
      if (issuedResponseIds.size <= MAX_ISSUED_RESPONSE_IDS) break;
      issuedResponseIds.delete(oldest);
    }
  };

  const surfaceResponse = (served: ReturnType<typeof serveSurface>): Response =>
    served.ok ? json(200, served.messages) : json(500, { error: "view-refused", codes: served.codes });

  function positionsResponse(): Response {
    const served = servePositionsSurface(state, { missingReceiptIds: hooks.missingReceiptIds });
    if (!served.ok) return json(500, { error: "view-refused", codes: served.codes });
    const joined = new Map(nearPositions(state).map((item) => [item.entry, item.joined]));
    return json(200, {
      book: state.book,
      readerHost: state.readerHost,
      addresses: state.addresses.map(({ ordinal, chain, address, status, reason }) => ({ ordinal, chain, address, status, reason })),
      positions: state.positions.map((entry) => {
        const near = joined.get(entry);
        const nodes = new Set(near?.chain?.controls.map((control) => control.subject) ?? []);
        return {
          id: entry.position.id, subject: entry.position.subject, chain: entry.chain, root: entry.root,
          quantity: entry.position.quantity, unit: entry.position.unit, snapshotId: entry.position.snapshotId, source: entry.source,
          coverage: near ? near.coverage : "no-review", reason: near ? near.reason : S.noReviewYet,
          ruleIds: state.policy.rules.filter((rule) => ruleSubjects(rule).some((subject) => nodes.has(subject))).map((rule) => rule.id),
        };
      }),
      receipts: state.privateReceipts,
      surface: served.messages,
    });
  }

  async function addAddress(request: Request): Promise<Response> {
    let parsed: { chain: string; address: string };
    try {
      const body = await readJson(request);
      parsed = parseDeskAddress(isRecord(body) ? body.address : undefined);
    } catch {
      return json(400, { error: "malformed-address" });
    }
    // One read at a time: each adds to the same book.
    const run = reading.then(async () => {
      const known = state.addresses.some((entry) => entry.status === "read" && entry.chain === parsed.chain && entry.address === parsed.address);
      if (known) return json(200, { ok: true });
      if (state.addresses.filter((entry) => entry.origin === "typed").length >= MAX_TYPED_ADDRESSES) return json(429, { error: "too-many-addresses" });
      await readAddress(state, deps, parsed, "typed");
      return json(200, { ok: true });
    });
    reading = run.catch(() => undefined);
    return run;
  }

  function agentInfo(): AgentInfo {
    const config = agentConfig(deps.env);
    return config.enabled ? { enabled: true, reason: null, text: null } : { enabled: false, reason: config.reason, text: S.agentNotDemonstrated };
  }

  async function ask(request: Request): Promise<Response> {
    const config = agentConfig(deps.env);
    if (!config.enabled) return json(503, { enabled: false, reason: config.reason, text: S.agentNotDemonstrated });
    if (asking) return json(409, { error: "busy" });
    asking = true;
    try {
      let question: string;
      let previousResponseId: string | undefined;
      try {
        const body = await readJson(request);
        if (!isRecord(body)) throw new DeskRejected("bad-request");
        if (body.previousResponseId !== undefined) {
          if (typeof body.previousResponseId !== "string" || !RESPONSE_ID.test(body.previousResponseId) || !issuedResponseIds.has(body.previousResponseId)) throw new DeskRejected("bad-request");
          previousResponseId = body.previousResponseId;
        }
        if (isRecord(body.explain) && body.question === undefined) {
          // "Explain further" carries a rule id only; the desk writes the question from the rule's public subjects.
          const rule = state.policy.rules.find((candidate) => candidate.id === (body.explain as Record<string, unknown>).ruleId);
          if (!rule) throw new DeskRejected("bad-request");
          question = T.explainQuestion(rule.id, ruleSubjects(rule));
        } else if (typeof body.question === "string" && body.explain === undefined && body.question.trim() !== "" && body.question.length <= MAX_QUESTION) {
          question = body.question;
        } else throw new DeskRejected("bad-request");
      } catch {
        return json(400, { error: "bad-request" });
      }
      // The question is guarded. The previous response id is not: it is one the agent issued, checked above.
      if (guardHit(question, guardTerms(state))) return json(422, { error: "private-value" });
      try {
        const answer = await askIronclaw({ question, previousResponseId, config, fetch: deps.fetch, timeoutMs: hooks.ironclawTimeoutMs ?? IRONCLAW_TIMEOUT_MS });
        rememberResponseId(answer.responseId);
        const body: AnswerBody = { responseId: answer.responseId, heading: S.agentHeading, segments: answerSegments(answer.text, idResolver(state)), toolCalls: answer.toolCalls };
        return json(200, body);
      } catch (error) {
        const failure = error instanceof AgentFailure ? error.failure : "upstream";
        const message = failure === "unauthorized" ? S.errorUnauthorized : failure === "unreachable" ? S.errorUnreachable : failure === "timeout" ? S.errorTimeout : S.errorUpstream;
        return json(failure === "timeout" ? 504 : 502, { error: { cause: failure, message } });
      }
    } finally {
      asking = false;
    }
  }

  /** The route a request names, as a fixed word for the log; a path the desk does not serve is never written out. */
  async function route(request: Request, path: string): Promise<{ name: string; response: Response }> {
    const get = request.method === "GET";
    const post = request.method === "POST";
    if (!path.startsWith("/api/desk/")) {
      if (!get) return { name: "(other)", response: empty(path === "/" || path === "/desk.js" || path === "/desk.css" ? 405 : 404) };
      if (path === "/") return { name: "/", response: text(page, "text/html; charset=utf-8") };
      if (path === "/desk.js") return { name: path, response: text(script, "text/javascript; charset=utf-8") };
      if (path === "/desk.css") return { name: path, response: text(stylesheet, "text/css; charset=utf-8") };
      return { name: "(other)", response: empty(404) };
    }
    // The guard comes before anything else under /api/desk/.
    const requestOrigin = request.headers.get("origin");
    const given = request.headers.get("x-desk-token");
    if (request.headers.get("host") !== hostHeader || (requestOrigin !== null && requestOrigin !== origin) || (post && requestOrigin === null) || given === null || !sameText(given, token)) {
      return { name: "/api/desk/(refused)", response: empty(403) };
    }
    if (path.startsWith("/api/desk/surface/")) {
      const view = path.slice("/api/desk/surface/".length);
      if (!isDeskView(view)) return { name: "/api/desk/surface/(unknown)", response: json(404, { error: "unknown-view" }) };
      if (!get) return { name: path, response: empty(405) };
      return { name: path, response: surfaceResponse(serveSurface(view, state, { missingReceiptIds: hooks.missingReceiptIds })) };
    }
    if (path === "/api/desk/verdict") return { name: path, response: get ? new Response(canonical(state.review.publicVerdict), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : empty(405) };
    if (path === "/api/desk/positions") return { name: path, response: get ? positionsResponse() : empty(405) };
    if (path === "/api/desk/agent") return { name: path, response: get ? json(200, agentInfo()) : empty(405) };
    if (path === "/api/desk/addresses") return { name: path, response: post ? await addAddress(request) : empty(405) };
    if (path === "/api/desk/ask") return { name: path, response: post ? await ask(request) : empty(405) };
    return { name: "/api/desk/(unknown)", response: json(404, { error: "unknown-route" }) };
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: DESK_HOST,
      port: options.port,
      development: false,
      // The agent call may take a minute; a request is not cut before it answers.
      idleTimeout: 120,
      async fetch(request) {
        let name = "(other)";
        let response: Response;
        try {
          ({ name, response } = await route(request, new URL(request.url).pathname));
        } catch {
          response = empty(500);
        }
        log(`${request.method.replace(/[^A-Z]/g, "").slice(0, 8)} ${name} ${response.status}`);
        return response;
      },
      error() {
        return empty(500);
      },
    });
  } catch {
    throw new DeskRejected("port-in-use");
  }
  const port = server.port ?? options.port;
  hostHeader = `${DESK_HOST}:${port}`;
  origin = `http://${hostHeader}`;
  return { origin, token, port, stop: async () => { await server.stop(true); } };
}
