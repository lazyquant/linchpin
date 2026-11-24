/**
 * The request handler: one route that answers a question as three messages, one per line, and one route that
 * returns the prepared answers. Every other path is 404, so an application can hand its requests to it. A
 * question is the only free text a request carries; one that holds an address or a token quantity is refused
 * before any tool or model is called.
 */
import { TOKENOMICS_REGISTRY } from "../tokenomics/registry";
import { CATALOG } from "../ui/catalog";
import { anthropicModelFromEnv } from "./anthropic";
import { addressRuns, loadBundleBackend, templatesSha256 } from "./bundle-backend";
import { appendTrace, cacheKey, insideRepository, normaliseQuestion } from "./log";
import { pinnedAnswers } from "./pinned";
import { ModelError, answerQuestion, protocolScope, type AnswerOutcome, type PlannerModel } from "./planner";
import { PROMPT_SHA256 } from "./prompt";
import type { RetrievalBackend, TemplateDescriptor } from "./retrieval";

export const ASK_PATH = "/api/answers/ask";
export const PINNED_PATH = "/api/answers/pinned";
export const MAX_BODY_BYTES = 4096;
export const MAX_QUESTION_CHARACTERS = 600;
const MAX_CACHED_ANSWERS = 256;

export interface AnswersHandlerOptions {
  /** Default: the backend over the committed captures, loaded when the first request arrives. */
  backend?: RetrievalBackend | Promise<RetrievalBackend>;
  /** The model for one ask, or `null` when there is none. Default: the adapter named by the environment. */
  model?: (ask: { question: string; protocol: string }) => PlannerModel | null;
  clock?: () => number;
  /** The trace file. It must lie outside the repository. Without it nothing is logged. */
  logPath?: string | null;
  maxRows?: number;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const NDJSON_HEADERS = { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const refuse = (status: number, code: string): Response => new Response(JSON.stringify({ error: code }), { status, headers: JSON_HEADERS });

function modelFromEnvironment(): PlannerModel | null {
  try {
    return anthropicModelFromEnv();
  } catch (error) {
    if (error instanceof ModelError) return null;
    throw error;
  }
}

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MINT_LABELS = [...new Set(TOKENOMICS_REGISTRY.flatMap((entry) => entry.mints.map((mint) => mint.label)))].map(escapeForPattern);
const NUMBER = "\\d[\\d,]*(?:\\.\\d+)?";
/** A number next to a registry token symbol, in either order, with or without whitespace between, in any case. */
const QUANTITY = MINT_LABELS.length > 0
  ? new RegExp(`(?:${NUMBER}\\s*(?:${MINT_LABELS.join("|")})(?![\\p{L}\\p{N}]))|(?:(?<![\\p{L}\\p{N}])(?:${MINT_LABELS.join("|")})\\s*${NUMBER})`, "iu")
  : null;

/** Whether a question holds what this surface never takes: an address the evidence does not already hold, or a token quantity. */
export function holdsPrivateContent(question: string, knownAddresses: ReadonlySet<string>): boolean {
  if (addressRuns(question).some((run) => !knownAddresses.has(run))) return true;
  return QUANTITY !== null && QUANTITY.test(question);
}

interface Scope {
  backend: RetrievalBackend;
  protocols: Set<string>;
  knownAddresses: ReadonlySet<string>;
  /** The backend's part of a cache key, read on the first ask that reaches the cache. */
  backendKey: { id: string; version: string; templatesSha256: string } | null;
}

/** What a request check needs from the backend: its protocol ids and the addresses its evidence holds. */
function scopeOf(backend: RetrievalBackend): Scope {
  const holder = backend as RetrievalBackend & { knownAddresses?: () => ReadonlySet<string> };
  return {
    backend, protocols: new Set(backend.protocols().map((protocol) => protocol.id)),
    knownAddresses: typeof holder.knownAddresses === "function" ? holder.knownAddresses() : new Set<string>(), backendKey: null,
  };
}

function backendKeyOf(scope: Scope): { id: string; version: string; templatesSha256: string } {
  if (scope.backendKey === null) {
    const descriptors: Record<string, TemplateDescriptor[]> = {};
    for (const protocol of scope.protocols) descriptors[protocol] = scope.backend.templates(protocol);
    scope.backendKey = { id: scope.backend.id, version: scope.backend.version, templatesSha256: templatesSha256(descriptors) };
  }
  return scope.backendKey;
}

type Ask = { question: string; protocol: string };

/** The request body, read chunk by chunk and abandoned as soon as it exceeds `limit` bytes; `null` when it does. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** The body of an ask, or `null` when it is not one. */
async function readAsk(request: Request, protocols: Set<string>): Promise<Ask | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    const bytes = await readCapped(request, MAX_BODY_BYTES);
    if (bytes === null) return null;
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "question" && key !== "protocol" && key !== "previous")) return null;
  if (typeof fields.question !== "string" || typeof fields.protocol !== "string") return null;
  const question = fields.question.trim();
  const length = [...question].length;
  if (length < 1 || length > MAX_QUESTION_CHARACTERS) return null;
  if (!protocols.has(fields.protocol)) return null;
  if (fields.previous !== undefined && (typeof fields.previous !== "string" || !/^[0-9a-f]{64}$/.test(fields.previous))) return null;
  return { question, protocol: fields.protocol };
}

/**
 * Builds the handler. It throws `Error("log-inside-repository")` when the trace file would lie inside the
 * repository.
 */
export function createAnswersHandler(options: AnswersHandlerOptions = {}): (request: Request) => Promise<Response> {
  const logPath = options.logPath ?? null;
  if (logPath !== null && insideRepository(logPath)) throw new Error("log-inside-repository");
  const clock = options.clock ?? Date.now;
  const modelFor = options.model ?? modelFromEnvironment;
  let scope: Promise<Scope> | null = null;
  const loadScope = (): Promise<Scope> => {
    scope ??= Promise.resolve(options.backend ?? loadBundleBackend()).then(scopeOf);
    scope.catch(() => { scope = null; });
    return scope;
  };
  let pinned: Promise<string> | null = null;
  const cache = new Map<string, string>();
  let busy = false;

  const trace = (ask: Ask, key: string, modelId: string | null, outcome: Pick<AnswerOutcome, "codes" | "modelCalls" | "toolNames" | "templateIds" | "results" | "inputTokens" | "outputTokens">, started: number): void => {
    if (logPath === null) return;
    try {
      appendTrace(logPath, {
        answerId: crypto.randomUUID(), cacheKey: key, question: normaliseQuestion(ask.question), protocol: ask.protocol,
        tools: outcome.toolNames, templateIds: outcome.templateIds, results: outcome.results, codes: outcome.codes,
        modelId, modelCalls: outcome.modelCalls, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
        latencyMs: Math.max(0, clock() - started),
      });
    } catch {
      // A trace that cannot be written never changes a reply.
    }
  };

  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return refuse(404, "not-found");
    }
    const isAsk = request.method === "POST" && url.pathname === ASK_PATH;
    const isPinned = request.method === "GET" && url.pathname === PINNED_PATH;
    if (!isAsk && !isPinned) return refuse(404, "not-found");
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return refuse(403, "cross-origin");

    try {
      const current = await loadScope();
      if (isPinned) {
        pinned ??= pinnedAnswers(current.backend).then((document) => JSON.stringify(document));
        pinned.catch(() => { pinned = null; });
        return new Response(await pinned, { status: 200, headers: JSON_HEADERS });
      }

      const ask = await readAsk(request, current.protocols);
      if (ask === null) return refuse(400, "bad-request");
      if (holdsPrivateContent(ask.question, current.knownAddresses)) return refuse(422, "private-content");
      if (busy) return refuse(409, "busy");
      busy = true;
      try {
        const started = clock();
        const model = modelFor({ question: ask.question, protocol: ask.protocol });
        const key = cacheKey({
          question: ask.question, protocol: ask.protocol, snapshotIds: protocolScope(current.backend, ask.protocol).snapshotIds,
          backend: backendKeyOf(current), catalogId: CATALOG.id, promptSha256: PROMPT_SHA256, modelId: model?.id ?? "",
        });
        const cached = model === null ? undefined : cache.get(key);
        if (cached !== undefined) {
          trace(ask, key, model!.id, { codes: [], modelCalls: 0, toolNames: [], templateIds: [], results: [], inputTokens: null, outputTokens: null }, started);
          return new Response(cached, { status: 200, headers: NDJSON_HEADERS });
        }
        const outcome = await answerQuestion({ question: ask.question, protocol: ask.protocol, backend: current.backend, model, signal: request.signal, clock, maxRows: options.maxRows });
        if (outcome.kind === "aborted") return new Response(null, { status: 499, headers: { "cache-control": "no-store" } });
        if (outcome.kind === "answer" || outcome.kind === "repaired") {
          cache.set(key, outcome.ndjson);
          if (cache.size > MAX_CACHED_ANSWERS) cache.delete(cache.keys().next().value as string);
        }
        trace(ask, key, model?.id ?? null, outcome, started);
        return new Response(outcome.ndjson, { status: 200, headers: NDJSON_HEADERS });
      } finally {
        busy = false;
      }
    } catch {
      // The reason stays here: an error text can hold a path or a request.
      return refuse(500, "internal");
    }
  };
}
