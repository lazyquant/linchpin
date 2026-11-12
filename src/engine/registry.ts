import type { HandlerName, QueryName, QueryRequest, RenderReviewInput, ToolContract, ReviewEnvelope } from "./contracts";
import type { EvidenceStore } from "./queries/snapshot";
import { canonical, sha256 } from "../chain/evidence";
import { runQuery } from "./queries/run";
import { renderReview, type ReviewHeader } from "./render";
import { QUERY_FIELDS } from "./validate";
import { dataRecord } from "./schemas";
import { EngineError } from "./errors";

export interface HandlerContext { runId: string; signal: AbortSignal; timeoutMs: number; store: EvidenceStore }
export type QueryHandler = (request: QueryRequest, ctx: HandlerContext) => unknown | Promise<unknown>;
type RenderHandler = (input: RenderReviewInput, header: ReviewHeader, ctx: HandlerContext) => ReviewEnvelope;
export interface Registry {
  readonly contracts: ToolContract[];
  readonly sha256: string;
  handler(name: QueryName): QueryHandler;
  handler(name: "render-review"): RenderHandler;
}
export interface RegistryOverrides {
  maxCalls?: Partial<Record<QueryName, number>>;
  timeoutMs?: Partial<Record<QueryName, number>>;
  handlers?: Partial<Record<QueryName, QueryHandler>>;
}
export function registrySha256(contracts: readonly ToolContract[]): string {
  return sha256(canonical([...contracts].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}
export const SHIPPED_REGISTRY_SHA256 = "301aa60246f8315cdc0f109d60b22d22225373690dabcf5b413bc94c32a08313";
export function createRegistry(overrides: RegistryOverrides = {}): Registry {
  if (!dataRecord(overrides) || Object.keys(overrides).some(k => !["maxCalls", "timeoutMs", "handlers"].includes(k))) throw new EngineError("registry-override");
  for (const [kind, values] of Object.entries(overrides)) {
    if (!dataRecord(values)) throw new EngineError("registry-override");
    for (const [name, value] of Object.entries(values)) {
      if (!Object.hasOwn(QUERY_FIELDS, name) || (kind === "handlers" ? typeof value !== "function" : !Number.isSafeInteger(value) || (value as number) <= 0)) throw new EngineError("registry-override");
    }
  }
  const settings: RegistryOverrides = overrides;
  const handlers = new Map<QueryName, QueryHandler>();
  const contracts: ToolContract[] = (Object.keys(QUERY_FIELDS) as QueryName[]).map(name => {
    handlers.set(name, settings.handlers?.[name] ?? (async (request, ctx) => runQuery(ctx.store, request)));
    const changed = [overrides.maxCalls, overrides.timeoutMs, overrides.handlers].some(v => v && Object.hasOwn(v, name));
    return { name, version: changed ? "1+override" : "1", readOnly: true,
      inputSchema: { kind: "query-request", name, fields: [...QUERY_FIELDS[name]], validator: "parseQueryRequest" },
      outputSchema: { kind: "query-result", validator: "validateQueryResult" },
      maxCalls: settings.maxCalls?.[name] ?? 32, timeoutMs: settings.timeoutMs?.[name] ?? 5000, reliability: { kind: "unmeasured" } };
  });
  contracts.push({ name: "render-review", version: "1", readOnly: true,
    inputSchema: { kind: "render-review-input", validator: "validateRenderInput" }, outputSchema: { kind: "review-envelope", validator: "validateReview" },
    maxCalls: 1, timeoutMs: 5000, reliability: { kind: "unmeasured" } });
  const hash = registrySha256(contracts);
  function handler(name: QueryName): QueryHandler;
  function handler(name: "render-review"): RenderHandler;
  function handler(name: HandlerName): QueryHandler | RenderHandler {
    if (name === "render-review") return (input, header, _ctx) => renderReview(input, header);
    const fn = handlers.get(name);
    if (!fn) throw new EngineError("unknown-agent");
    return fn;
  }
  // Callers receive copies of contract metadata; the bound implementation is fixed.
  return Object.freeze({ get contracts() { return structuredClone(contracts); }, sha256: hash, handler });
}
