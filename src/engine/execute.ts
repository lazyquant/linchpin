import type { EngineRunOutcome, EngineTraceEvent, PlanRejectCode, QueryRequest, RenderReviewEntry, RenderReviewInput, ReplayCapture, ReviewEnvelope, RunAccounting, RunFailCode, RunLimits, TraceSink } from "./contracts";
import type { EvidenceStore } from "./queries/snapshot";
import { canonical, sha256 } from "../chain/evidence";
import { parseQueryRequest } from "./queries/request";
import { resultSha256 } from "./queries/run";
import { resolveBlueprint } from "./blueprints";
import { createRegistry, type Registry } from "./registry";
import { RENDERER_VERSION, validateReview } from "./render";
import { exactKeys, isReviewEnvelope, validateQueryResult } from "./schemas";
import { FileTraceSink, isInsideRepository } from "./trace";
import { LIMIT_KEYS, validatePlan } from "./validate";

export const SETTLE_MS = 250;
export const TRACE_WRITE_MS = 1000;
export interface RunPlanInput {
  plan: unknown; limits: RunLimits; blueprintId: string; store: EvidenceStore; trace: TraceSink;
  registry?: Registry; blueprintRoot?: string;
}
const hash = (value: unknown) => sha256(canonical(value));
type WaitResult<T> = { kind: "value"; value: T } | { kind: "rejected" } | { kind: "deadline" } | { kind: "aborted" };

/** Observe a task once; detached rejection/fulfilment paths cannot affect run state. */
function bounded<T>(task: () => T | Promise<T>, deadline: number, signal?: AbortSignal, acknowledge = false): Promise<WaitResult<T>> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WaitResult<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal?.removeEventListener("abort", abort);
      resolve(signal?.aborted && !(acknowledge && result.kind === "value") ? { kind: "aborted" } : result);
    };
    const abort = () => {
      // Drain acknowledgements already queued in this turn before abandoning a write.
      if (acknowledge) abortTimer = setTimeout(() => finish({ kind: "aborted" }), 0);
      else finish({ kind: "aborted" });
    };
    if (signal?.aborted) { finish({ kind: "aborted" }); return; }
    if (performance.now() >= deadline) { finish({ kind: "deadline" }); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish({ kind: "deadline" }), Math.max(0, Math.ceil(deadline - performance.now())));
    try {
      Promise.resolve(task()).then(value => finish(performance.now() >= deadline ? { kind: "deadline" } : { kind: "value", value }),
        () => finish(performance.now() >= deadline ? { kind: "deadline" } : { kind: "rejected" }));
    } catch { finish(performance.now() >= deadline ? { kind: "deadline" } : { kind: "rejected" }); }
  });
}
function plannedLimits(limits: unknown): RunLimits | null {
  try {
    return exactKeys(limits, LIMIT_KEYS) && Object.values(limits).every(v => typeof v === "number")
      ? { ...limits } as unknown as RunLimits : null;
  } catch { return null; }
}
export function runPlan(input: RunPlanInput, signal?: AbortSignal): Promise<EngineRunOutcome> {
  return executePlan(input, signal);
}

/** Internal replay entry point: only replay.ts supplies a capture; ordinary callers use runPlan. */
export async function executePlan(input: RunPlanInput, signal?: AbortSignal, replay?: ReplayCapture): Promise<EngineRunOutcome> {
  const runId = crypto.randomUUID();
  const accounting: RunAccounting = { planned: plannedLimits(input.limits), queryCalls: 0, renderCalls: 0, modelTokens: 0 };
  const rejected = (code: PlanRejectCode, nodeId: string | null = null): EngineRunOutcome => ({ status: "rejected", runId, code, nodeId, dispatched: 0, accounting });
  const validation = validatePlan(input.plan, input.limits);
  if (!validation.ok) return rejected(validation.code, validation.nodeId);
  const { plan, limits } = validation;
  accounting.planned = { ...limits };
  try {
    if (input.trace instanceof FileTraceSink && isInsideRepository(input.trace.path)) return rejected("schema");
  } catch { return rejected("schema"); }
  let blueprint;
  try { blueprint = await resolveBlueprint(input.blueprintId, input.blueprintRoot); }
  catch (error) { return rejected((error as { code: string }).code === "blueprint-unknown" ? "blueprint-unknown" : "blueprint-mismatch"); }
  const allIds = plan.nodes.map(n => n.id).sort();
  if (signal?.aborted) return { status: "failed", runId, code: "aborted", nodeId: null, lastDurableSequence: 0, skipped: allIds, accounting };
  const registry = input.registry ?? createRegistry();
  const contracts = registry.contracts;
  const header = { runId, blueprintId: blueprint.id, blueprintSha256: blueprint.sha256, registrySha256: registry.sha256, planSha256: hash(plan) };
  const runDeadline = performance.now() + limits.timeoutMs;
  let lastDurableSequence = 0;
  let sequence = 0;
  let traceBroken = false;
  const dispatched = new Set<string>();
  const completed = new Map<string, RenderReviewEntry | ReviewEnvelope>();
  const counts = new Map<string, number>();
  let active: { nodeId: string; inputSha256: string; controller?: AbortController } | undefined;
  let envelope: ReviewEnvelope | undefined;

  async function append(phase: EngineTraceEvent["phase"], nodeId: string, inputSha256: string,
    extra: Partial<Pick<EngineTraceEvent, "outputSha256" | "acceptedEvidenceIds" | "reason">> = {}, cleanupDeadline?: number): Promise<boolean> {
    if (traceBroken) return false;
    const deadline = Math.min(performance.now() + TRACE_WRITE_MS, runDeadline, cleanupDeadline ?? Infinity);
    if (performance.now() >= deadline) { traceBroken = true; return false; }
    const event: EngineTraceEvent = { runId, sequence: ++sequence, nodeId, phase, inputSha256,
      registrySha256: header.registrySha256, blueprintSha256: header.blueprintSha256, modelId: null, actualTokens: 0,
      acceptedEvidenceIds: [], rejectedSourceIds: [], ...extra };
    // Stop observing a hung sink promptly on abort; an uncertain write poisons further appends.
    const result = await bounded(() => input.trace.append(structuredClone(event)), deadline, cleanupDeadline ? undefined : signal, true);
    if (result.kind === "value") { lastDurableSequence = event.sequence; return true; }
    traceBroken = true;
    return false;
  }
  async function fail(code: RunFailCode, nodeId: string | null, reason?: "replay-mismatch"): Promise<EngineRunOutcome> {
    // Leave room for the timer callback and outcome construction inside the settle bound.
    const cleanupDeadline = performance.now() + SETTLE_MS - 5;
    active?.controller?.abort();
    if (signal?.aborted) code = "aborted";
    else if (traceBroken) code = "trace-failed";
    else if (performance.now() >= runDeadline) code = "run-timeout";
    if (!traceBroken && performance.now() < runDeadline) {
      if (active) {
        const phase = ["aborted", "run-timeout", "handler-timeout"].includes(code) ? "cancelled" : "failed";
        await append(phase, active.nodeId, active.inputSha256, { reason: reason ?? code }, cleanupDeadline);
      }
      if (!traceBroken && performance.now() < Math.min(runDeadline, cleanupDeadline)) await append("run-failed", "", header.planSha256, { reason: reason ?? code }, cleanupDeadline);
    }
    if (signal?.aborted) code = "aborted";
    else if (traceBroken) code = "trace-failed";
    else if (performance.now() >= runDeadline) code = "run-timeout";
    return { status: "failed", runId, code, nodeId, lastDurableSequence,
      skipped: allIds.filter(id => !dispatched.has(id)), accounting };
  }

  if (replay !== undefined) {
    let valid = false;
    try {
      const queries = plan.nodes.filter(n => n.agent !== "render-review").map(n => n.id).sort();
      valid = replay.version === 1 && replay.planSha256 === header.planSha256 && replay.registrySha256 === header.registrySha256
        && replay.blueprintSha256 === header.blueprintSha256 && replay.rendererVersion === RENDERER_VERSION
        && canonical(replay.handlerVersions) === canonical(Object.fromEntries(contracts.map(c => [c.name, c.version])))
        && Array.isArray(replay.entries) && canonical(replay.entries.map(e => e.nodeId).sort()) === canonical(queries);
    } catch { valid = false; }
    if (!valid) return fail("output-invalid", null, "replay-mismatch");
  }

  while (completed.size < plan.nodes.length) {
    const node = plan.nodes.filter(n => !completed.has(n.id) && n.dependsOn.every(id => completed.has(id)))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
    if (signal?.aborted) return fail("aborted", node.id);
    if (performance.now() >= runDeadline) return fail("run-timeout", node.id);
    const contract = contracts.find(c => c.name === node.agent)!;
    if (node.agent !== "render-review" && ((counts.get(node.agent) ?? 0) >= contract.maxCalls || accounting.queryCalls >= limits.maxToolCalls)) return fail("budget-exhausted", node.id);
    let resolved: QueryRequest | RenderReviewInput;
    if (node.agent === "render-review") {
      resolved = Object.fromEntries(Object.keys(node.input).sort().map(key => [key, structuredClone(completed.get((node.input[key] as { ref: string }).ref) as RenderReviewEntry)]));
    } else {
      resolved = parseQueryRequest({ name: node.agent, ...Object.fromEntries(Object.entries(node.input).map(([key, v]) => [key, (v as { literal: unknown }).literal])) });
    }
    const inputSha256 = hash(resolved);
    if (!await append("prepared", node.id, inputSha256)) return fail("trace-failed", node.id);
    active = { nodeId: node.id, inputSha256 };
    if (signal?.aborted) return fail("aborted", node.id);
    if (performance.now() >= runDeadline) return fail("run-timeout", node.id);
    const controller = new AbortController();
    active.controller = controller;
    const started = performance.now();
    const callDeadline = Math.min(started + contract.timeoutMs, runDeadline);
    const timeoutMs = callDeadline - started;
    let replayMismatch = false;
    const result = await bounded(() => {
      dispatched.add(node.id);
      if (node.agent === "render-review") {
        accounting.renderCalls++;
        return registry.handler("render-review")(structuredClone(resolved as RenderReviewInput), header, { runId, signal: controller.signal, timeoutMs, store: input.store });
      }
      accounting.queryCalls++;
      counts.set(node.agent, (counts.get(node.agent) ?? 0) + 1);
      if (replay !== undefined) {
        try {
          const entry = replay.entries.find(e => e.nodeId === node.id)!;
          if (entry.inputSha256 !== inputSha256 || !validateQueryResult(entry.result) || resultSha256(entry.result) !== entry.resultSha256) {
            replayMismatch = true; return undefined;
          }
          return structuredClone(entry.result);
        } catch { replayMismatch = true; return undefined; }
      }
      return registry.handler(node.agent)(structuredClone(resolved as QueryRequest), { runId, signal: controller.signal, timeoutMs, store: input.store });
    }, callDeadline, signal);
    if (signal?.aborted || result.kind === "aborted") return fail("aborted", node.id);
    if (performance.now() >= runDeadline) return fail("run-timeout", node.id);
    if (result.kind === "deadline") return fail("handler-timeout", node.id);
    if (result.kind === "rejected") return fail("handler-rejected", node.id);
    if (replayMismatch) return fail("output-invalid", node.id, "replay-mismatch");
    let outputSha256: string;
    let acceptedEvidenceIds: string[] = [];
    if (node.agent === "render-review") {
      if (!isReviewEnvelope(result.value) || !validateReview(result.value).ok) return fail("output-invalid", node.id);
      envelope = structuredClone(result.value);
      completed.set(node.id, envelope);
      outputSha256 = hash(envelope);
    } else {
      if (!validateQueryResult(result.value)) return fail("output-invalid", node.id);
      const output = structuredClone(result.value);
      outputSha256 = resultSha256(output);
      completed.set(node.id, { nodeId: node.id, request: structuredClone(resolved as QueryRequest), result: output, resultSha256: outputSha256 });
      acceptedEvidenceIds = output.receipts.map(r => r.id);
    }
    if (!await append("succeeded", node.id, inputSha256, { outputSha256, acceptedEvidenceIds })) return fail("trace-failed", node.id);
    active = undefined;
  }
  if (signal?.aborted) return fail("aborted", null);
  if (!envelope || !validateReview(envelope).ok) return fail("output-invalid", plan.outputNodeId);
  if (!await append("run-succeeded", "", header.planSha256, { outputSha256: hash(envelope) })) return fail("trace-failed", null);
  return { status: "succeeded", runId, envelope, lastSequence: lastDurableSequence, accounting };
}
