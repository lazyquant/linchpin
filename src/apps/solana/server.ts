/**
 * The app's loopback server. It binds 127.0.0.1 and nothing else. The document is served without the token and
 * holds no read. A read is returned by POST /api/positions alone, to a request that carries the launch token and
 * this server's own origin. Position reads use fixtures unless `live` selects the RPC endpoint. Mounted answers
 * may call their configured model. Nothing about a position read is logged or written.
 */
import { join } from "node:path";
import { normalizeCapture, loadCapture } from "../../adapters/kamino/index";
import { buildKaminoLendResults } from "../../adapters/kamino-lend/index";
import { buildKaminoSnapshots } from "../../adapters/kamino/index";
import { buildMarinadeSnapshots } from "../../engine/queries/marinade";
import { readPositions } from "../../positions/read";
import { PositionsRejected, type ReadResult } from "../../positions/types";
import { createSolanaRpcClient } from "../../solana/positions/client";
import { validateSolanaAddress } from "../../solana/positions/read";
import { validateSurface, receiptResolver } from "../../ui/validate";
import { PrivateTerms } from "./guard";
import { APP_ROOT, loadApp, readId } from "./load";
import type { AppData, ReadData } from "./model";
import { buildAssets, buildDocument, contentPolicy } from "./page";
import { replayClient, toReadData, type PositionContext } from "./positions";

export const APP_HOST = "127.0.0.1";
const MAX_BODY = 16384;
const MAX_ANSWER_BODY = 4096;
const SOURCES = ["recorded", "constructed", "live"] as const;

export interface ServerOptions {
  /** 1 to 65535, or 0 or nothing for a port the system picks. */
  port?: number;
  /** The loaded data. Left out, the server loads it itself, which takes about a minute. */
  data?: AppData;
  /** Whether a live read is offered. It needs `rpcUrl`. */
  live?: boolean;
  rpcUrl?: string;
  /** The answers handler. Without it the answers routes do not exist. */
  answers?: (request: Request) => Promise<Response>;
  deps?: { readPositions?: (input: { chain: string; address: string; snapshotId: string; client: unknown }) => Promise<ReadResult> };
  /** The repository root, when it is not the one this file sits in. */
  root?: string;
}

export interface AppServer { origin: string; port: number; token: string; stop(): Promise<void> }

/** Identifies a failure of listener creation, without retaining exception details. */
export class AppBindError extends Error {
  constructor() {
    super("The app listener could not be bound");
    this.name = "AppBindError";
  }
}

function bindServer(options: Parameters<typeof Bun.serve>[0]) {
  try {
    return Bun.serve(options);
  } catch {
    throw new AppBindError();
  }
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

const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" } });
const empty = (status: number): Response => new Response("", { status, headers: HEADERS });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Bound the privacy screen too: never buffer an unbounded ask before forwarding it. */
async function answerBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_ANSWER_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BODY) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The captures a position is joined to, read again from the committed fixtures. Quick: no tokenomics build. */
export function loadContext(root: string): PositionContext {
  const marinade = buildMarinadeSnapshots(join(root, "fixtures")).at(-1)!;
  const lend = buildKaminoLendResults(join(root, "fixtures/kamino-lend")).filter((result) => !result.snapshot.constructed).at(-1)!.snapshot;
  const sentora = buildKaminoSnapshots(join(root, "fixtures/kamino")).filter((snapshot) => !snapshot.constructed).at(-1)!;
  const report = normalizeCapture(loadCapture(join(root, "fixtures/kamino", sentora.id.replace("solana-mainnet-beta.kamino.", "")))).report;
  return { marinade, lend, sentora, sentoraReport: report };
}

/** Starts the server. Listener failures throw AppBindError; loading failures remain distinct. */
export async function startServer(options: ServerOptions = {}): Promise<AppServer> {
  const root = options.root ?? APP_ROOT;
  const loaded = options.data ?? (await loadApp(root, { positions: false })).data;
  const live = options.live === true && typeof options.rpcUrl === "string" && options.rpcUrl !== "";
  const replayAddress = loaded.replayAddress ?? replayClient(root, "recorded").holder;
  const data: AppData = { ...loaded, mode: "served", positions: null, replayAddress, live, ask: { enabled: options.answers !== undefined } };
  const assets = await buildAssets();
  const page = buildDocument(data, assets);
  const policy = contentPolicy(assets);
  const token = newToken();
  const terms = new PrivateTerms();
  const resolveEvidence = receiptResolver(Object.keys(data.receipts));
  let context: PositionContext | null = null;
  let origin = "";
  let hostHeader = "";

  async function positions(request: Request): Promise<Response> {
    const given = request.headers.get("x-app-token");
    if (request.headers.get("host") !== hostHeader || request.headers.get("origin") !== origin || given === null || !sameText(given, token)) return empty(403);
    let body: unknown = null;
    try {
      const raw = await request.text();
      body = raw.length > MAX_BODY ? null : JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!isRecord(body) || typeof body.address !== "string" || !(SOURCES as readonly string[]).includes(body.source as string)) return json(400, { error: "malformed-request" });
    const source = body.source as ReadData["source"];
    const address = body.address;
    try {
      validateSolanaAddress(address);
    } catch {
      return json(400, { error: "malformed-address" });
    }
    if (source === "live" && !live) return json(400, { error: "live-not-enabled" });
    const read = options.deps?.readPositions ?? readPositions;
    let client: unknown;
    if (source === "live") client = createSolanaRpcClient({ url: options.rpcUrl!, timeoutMs: 30000, programAccounts: true });
    else {
      const replay = replayClient(root, source);
      // A replayed read answers for the holder of its fixture bodies and for no other address.
      if (!options.deps?.readPositions && address !== replay.holder) return json(400, { error: "address-not-in-replay" });
      client = replay.client;
    }
    try {
      const result = await read({ chain: "solana", address, snapshotId: readId(source), client });
      context ??= loadContext(root);
      const shaped = await toReadData(source, address, readId(source), result, context);
      terms.add(shaped);
      return json(200, shaped);
    } catch (error) {
      return json(error instanceof PositionsRejected ? 400 : 502, { error: error instanceof PositionsRejected ? error.code : "read-failed" });
    }
  }

  /** Forwards one request to the answers handler and sends its reply on only when the validator accepts it. */
  async function answers(request: Request, path: string): Promise<Response> {
    const handler = options.answers;
    if (!handler) return empty(404);
    const givenOrigin = request.headers.get("origin");
    if (givenOrigin !== null && givenOrigin !== origin) return json(403, { error: "cross-origin" });
    let raw = "";
    if (request.method === "POST") {
      try {
        const text = await answerBody(request);
        if (text === null) return json(400, { error: "bad-request" });
        raw = text;
      } catch { return json(400, { error: "bad-request" }); }
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json(400, { error: "malformed-request" }); }
      if (!isRecord(body)) return json(400, { error: "malformed-request" });
      // Decode string atoms, but retain exact number lexemes for the privacy screen.
      if (terms.hitJson(raw)) return json(422, { error: "private-value" });
    }
    let reply: Response;
    try {
      const headers = new Headers({ "content-type": "application/json" });
      if (givenOrigin !== null) headers.set("origin", givenOrigin);
      reply = await handler(new Request(`${origin}${path}`, { method: request.method, headers, signal: request.signal, ...(request.method === "POST" ? { body: raw } : {}) }));
    } catch {
      return json(502, { error: "answers-failed" });
    }
    const text = await reply.text();
    if (reply.status !== 200) {
      const codes: Record<number, string> = { 400: "bad-request", 403: "cross-origin", 409: "busy", 422: "private-content" };
      return json(codes[reply.status] ? reply.status : reply.status === 404 ? 404 : 502, { error: codes[reply.status] ?? "answers-failed" });
    }
    // W7 returns a JSON document, not one surface. Validate every embedded
    // surface against this app's receipts before any of it reaches the page.
    if (path === "/api/answers/pinned" && reply.headers.get("content-type")?.includes("application/json")) {
      try {
        const document: unknown = JSON.parse(text);
        if (!isRecord(document) || typeof document.label !== "string" || !Array.isArray(document.protocols) || !Array.isArray(document.answers)) return json(422, { refused: ["schema"] });
        const protocols = new Set<string>();
        for (const protocol of document.protocols) {
          if (!isRecord(protocol) || typeof protocol.id !== "string" || typeof protocol.title !== "string" || protocols.has(protocol.id)) return json(422, { refused: ["schema"] });
          protocols.add(protocol.id);
        }
        for (const answer of document.answers) {
          if (!isRecord(answer) || typeof answer.id !== "string" || typeof answer.question !== "string" || typeof answer.protocol !== "string" || !protocols.has(answer.protocol) || typeof answer.label !== "string" || typeof answer.ndjson !== "string") return json(422, { refused: ["schema"] });
          const messages = answer.ndjson.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
          const verdict = validateSurface(messages, { resolveEvidence });
          if (!verdict.ok) return json(422, { refused: verdict.codes });
        }
        return json(200, document);
      } catch { return json(422, { refused: ["schema"] }); }
    }
    let messages: unknown[];
    try {
      messages = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
    } catch {
      return json(422, { refused: ["schema"] });
    }
    const verdict = validateSurface(messages, { resolveEvidence });
    if (!verdict.ok) return json(422, { refused: verdict.codes });
    return new Response(text, { status: 200, headers: { ...HEADERS, "content-type": "application/x-ndjson; charset=utf-8" } });
  }

  const server = bindServer({
    hostname: APP_HOST,
    port: options.port ?? 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(page, { status: 200, headers: { ...HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": policy } });
      }
      if (url.pathname === "/api/positions" && request.method === "POST") return positions(request);
      if (url.pathname === "/api/answers/ask" && request.method === "POST") return answers(request, url.pathname);
      if (url.pathname === "/api/answers/pinned" && request.method === "GET") return answers(request, url.pathname);
      return empty(404);
    },
  });
  const port = server.port ?? options.port ?? 0;
  hostHeader = `${APP_HOST}:${port}`;
  origin = `http://${hostHeader}`;
  return { origin, port, token, stop: async () => { await server.stop(true); } };
}
