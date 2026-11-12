import type { EnginePlan, PlanRejectCode, QueryName, RunLimits } from "./contracts";
import { parseQueryRequest } from "./queries/request";
import { dataArray, dataRecord, exactKeys, isJson } from "./schemas";

export const QUERY_FIELDS: Record<QueryName, readonly string[]> = {
  dependencies: ["subject", "relations", "scope"], control: ["subject", "scope"],
  changes: ["subject", "beforeSnapshotId", "afterSnapshotId", "maxResults"], evidence: ["evidenceIds", "maxResults"],
};
export const LIMIT_KEYS = ["maxNodes", "maxDepth", "maxToolCalls", "maxTokens", "timeoutMs"] as const;
export type PlanValidation = { ok: true; plan: EnginePlan; limits: RunLimits }
  | { ok: false; code: PlanRejectCode; nodeId: string | null };
const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
const reject = (code: PlanRejectCode, nodeId: string | null = null): PlanValidation => ({ ok: false, code, nodeId });

/** Pure, whole-plan preflight. No storage, clock, dispatch or trace is touched. */
export function validatePlan(input: unknown, limits: unknown): PlanValidation {
  try {
    if (!exactKeys(input, ["version", "nodes", "outputNodeId"]) || input.version !== 1 || !dataArray(input.nodes) || typeof input.outputNodeId !== "string") return reject("schema");
    for (const n of input.nodes) {
      if (!exactKeys(n, ["id", "agent", "domain", "input", "dependsOn"]) || typeof n.id !== "string" || !idPattern.test(n.id)) return reject("schema");
      if (typeof n.agent !== "string" || typeof n.domain !== "string" || !dataRecord(n.input)
        || !dataArray(n.dependsOn) || !n.dependsOn.every(d => typeof d === "string")) return reject("schema", n.id);
      for (const v of Object.values(n.input)) {
        if (!(exactKeys(v, ["literal"]) && isJson(v.literal)) && !(exactKeys(v, ["ref"]) && typeof v.ref === "string")) return reject("schema", n.id);
      }
    }
    if (!isJson(input)) return reject("schema");
    if (!exactKeys(limits, LIMIT_KEYS) || !Object.values(limits).every(Number.isSafeInteger)) return reject("limit-invalid");
    const l = limits as unknown as RunLimits;
    if (l.maxNodes < 1 || l.maxNodes > 32 || l.maxDepth < 1 || l.maxDepth > 8 || l.maxToolCalls < 1 || l.maxTokens !== 0 || l.timeoutMs < 1 || l.timeoutMs > 600000) return reject("limit-invalid");
    const plan = structuredClone(input) as unknown as EnginePlan;
    if (plan.nodes.length > l.maxNodes) return reject("limit-exceeded");
    const ids = new Set<string>();
    for (const n of plan.nodes) { if (ids.has(n.id)) return reject("duplicate-id", n.id); ids.add(n.id); }
    for (const n of plan.nodes) if (!Object.hasOwn(QUERY_FIELDS, n.agent) && n.agent !== "render-review") return reject("unknown-agent", n.id);
    for (const n of plan.nodes) if (n.domain !== "protocol-review") return reject("bad-domain", n.id);
    const renders = plan.nodes.filter(n => n.agent === "render-review");
    if (renders.length !== 1 || renders[0].id !== plan.outputNodeId) return reject("output-node");
    const queries = plan.nodes.filter(n => n.agent !== "render-review");
    for (const n of queries) {
      if (Object.values(n.input).some(v => "ref" in v)) return reject("ref-in-query", n.id);
      if (n.dependsOn.length) return reject("dependency-mismatch", n.id);
      if (!exactKeys(n.input, QUERY_FIELDS[n.agent as QueryName])) return reject("query-input-invalid", n.id);
      try {
        parseQueryRequest({ name: n.agent, ...Object.fromEntries(Object.entries(n.input).map(([k, v]) => [k, "literal" in v ? v.literal : undefined])) });
      } catch { return reject("query-input-invalid", n.id); }
    }
    const render = renders[0];
    if (!Object.keys(render.input).length || !Object.keys(render.input).every(k => idPattern.test(k))) return reject("schema", render.id);
    if (Object.values(render.input).some(v => "literal" in v)) return reject("literal-in-render", render.id);
    const refs = new Set(Object.values(render.input).map(v => (v as { ref: string }).ref));
    const queryIds = new Set(queries.map(n => n.id));
    if ([...refs].some(r => !queryIds.has(r))) return reject("dangling-ref", render.id);
    if (new Set(render.dependsOn).size !== render.dependsOn.length || render.dependsOn.length !== refs.size || render.dependsOn.some(d => !refs.has(d))) return reject("dependency-mismatch", render.id);
    const unreachable = [...queryIds].sort().find(id => !refs.has(id));
    if (unreachable) return reject("unreachable", unreachable);
    if (l.maxToolCalls < queries.length) return reject("limit-invalid");
    if (l.maxDepth < 2) return reject("limit-exceeded");
    return { ok: true, plan, limits: { ...l } };
  } catch { return reject("schema"); }
}
