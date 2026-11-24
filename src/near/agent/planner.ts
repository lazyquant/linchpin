import { TOOLS } from "../mcp/tools";
import { captureAttestation, unavailableAttestation } from "./attestation";
import { clone, codeOf, freeze, NearAgentError } from "./errors";
import { parseAsk, questionFor } from "./input";
import { NearAiModel } from "./nearai";
import { SYSTEM_PROMPT } from "./prompt";
import { buildSurfaceInput } from "./rows";
import { aggregateBindings, emptyBinding, verifyResponseBinding } from "./signature";
import { composeSurface } from "./surface";
import { ToolSession, MAX_TOOL_CALLS } from "./tools";
import type { AskOptions, AskResponse, AttestationCapture, BindingCheck, ModelMessage, PlannerModel, PlannerReply, PlannerRequest, TokenUsage } from "./types";
import { NO_MODEL_TEXT, REFUSAL_TEXT, SCRIPTED_LABEL } from "./web/strings";

export const MAX_MODEL_CALLS = 8;
export const ASK_DEADLINE_MS = 90000;
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // A caller can already be aborted when an in-process dependency returns its promise.
  void promise.catch(() => {});
  if (signal.aborted) return Promise.reject(new NearAgentError("aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new NearAgentError("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function nextModel(model: PlannerModel, request: PlannerRequest, signal: AbortSignal): Promise<PlannerReply> {
  try { return await model.next(request, signal); }
  catch (error) { throw new NearAgentError(codeOf(error, "model-failed")); }
}
export async function ask(value: unknown, options: AskOptions): Promise<AskResponse> {
  const input = parseAsk(value, options.context);
  const clock = options.clock ?? Date.now, started = clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASK_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const session = new ToolSession(input, options.context);
  const model = options.model === undefined ? new NearAiModel({ fetch: options.fetch, clock }) : options.model;
  const scripted = model?.mode === "scripted";
  let authoritative: Record<string, unknown> | null = null, modelCalls = 0, repaired = false;
  let attestation = unavailableAttestation(scripted ? "scripted-model" : "attestation-unavailable");
  let capture: AttestationCapture | null = null;
  const checks: BindingCheck[] = [], codes: string[] = [];
  const usage: TokenUsage = { inputTokens: null, outputTokens: null };
  const check = () => {
    if (clock() - started >= ASK_DEADLINE_MS || controller.signal.aborted) throw new NearAgentError("deadline");
    if (signal.aborted) throw new NearAgentError("aborted");
  };
  const finish = (kind: AskResponse["kind"], selection?: unknown, notice?: string): AskResponse => {
    const responseBinding = checks.length ? aggregateBindings(checks) : emptyBinding();
    const surfaceInput = buildSurfaceInput(options.context, input, authoritative, session.results, attestation, responseBinding);
    let composed = composeSurface(surfaceInput, selection, notice);
    if (composed.codes.length) {
      codes.push(...composed.codes); kind = "refusal";
      composed = composeSurface(surfaceInput, undefined, REFUSAL_TEXT);
      if (composed.codes.length) throw new NearAgentError("invalid-source-surface");
    }
    return { kind, authoritative: clone(authoritative), messages: composed.messages,
      model: { id: model?.id ?? null, mode: !model || modelCalls === 0 ? "none" : scripted ? "scripted" : "live",
        modelCalls, toolCalls: session.calls, label: scripted ? SCRIPTED_LABEL : null },
      attestation, responseBinding, codes: [...new Set(codes)], usage };
  };
  try {
    check();
    const seed = await cancellable(session.seed(), signal);
    authoritative = freeze(clone(seed.value));
    check();
    if (!model || model.configured && !model.configured()) {
      attestation = unavailableAttestation("model-not-configured");
      codes.push("model-not-configured"); return finish("no-model", undefined, NO_MODEL_TEXT);
    }
    if (!scripted) {
      capture = await cancellable(captureAttestation({ fetch: options.fetch ?? model.transport, clock, nonce: options.nonce, signal }), signal);
      attestation = capture.meta;
      check();
    }
    const messages: ModelMessage[] = [
      { role: "user", content: questionFor(input) },
      { role: "assistant", calls: [{ id: "seed", name: seed.name, input: input.kind === "control" ? { subject: input.subject } : input.kind === "policy" ? { policyId: input.policyId } : { action: input.action, policyId: input.policyId } }] },
      { role: "tool", id: "seed", name: seed.name, output: seed.forwarded },
    ];
    const selectionGuidance = (): ModelMessage => ({ role: "user", content:
      'Select a view over server result ids only. A valid minimal selection is {"view":"fact-table","results":["r1"]}. Results must be id strings, never objects or rows. Omit the optional summary. Return only the selection JSON.' });
    messages.push(selectionGuidance());
    for (;;) {
      check();
      if (modelCalls >= MAX_MODEL_CALLS) throw new NearAgentError("model-budget-exhausted");
      modelCalls++;
      const pending = nextModel(model, { system: SYSTEM_PROMPT, tools: TOOLS, messages: clone(messages) }, signal);
      // Observe rejection even if the immediate deadline check exits before awaiting it.
      void pending.catch(() => {});
      // A synchronous fake clock can expire during invocation, including a never-settling model.
      check();
      const reply = await cancellable(pending, signal);
      check();
      for (const key of ["inputTokens", "outputTokens"] as const) usage[key] = reply.usage[key] === null ? null : (usage[key] ?? 0) + reply.usage[key];
      if (reply.wire && capture) {
        const binding = await cancellable(verifyResponseBinding(reply.wire, capture, { fetch: options.fetch ?? model.transport, signal, clock }), signal);
        checks.push(binding); options.onWire?.(reply.wire, capture, binding); check();
      }
      if (reply.turn.kind === "tools") {
        if (!reply.turn.calls.length) throw new NearAgentError("model-invalid");
        messages.push({ role: "assistant", calls: reply.turn.calls, ...(reply.reasoning === undefined ? {} : { reasoning: reply.reasoning }) });
        for (const call of reply.turn.calls) {
          check();
          if (session.calls >= MAX_TOOL_CALLS) throw new NearAgentError("tool-budget-exhausted");
          const result = await cancellable(session.call(call.name, call.input), signal);
          check();
          messages.push({ role: "tool", id: call.id, name: call.name, output: result.forwarded });
        }
        messages.push(selectionGuidance());
        continue;
      }
      const surface = composeSurface(buildSurfaceInput(options.context, input, authoritative, session.results, attestation, aggregateBindings(checks)), reply.turn.answer);
      if (!surface.codes.length) return finish(repaired ? "repaired" : "answer", reply.turn.answer);
      codes.push(...surface.codes);
      if (repaired) return finish("refusal", undefined, REFUSAL_TEXT);
      repaired = true;
      // Rejected content is never echoed to the provider or retained in the transcript.
      messages.push({ role: "user", content: JSON.stringify({ codes: surface.codes }) });
    }
  } catch (error) {
    const code = clock() - started >= ASK_DEADLINE_MS || controller.signal.aborted ? "deadline" : signal.aborted ? "aborted" : codeOf(error, "request-failed");
    codes.push(code);
    return finish(code === "aborted" ? "aborted" : "refusal", undefined, REFUSAL_TEXT);
  } finally { clearTimeout(timer); }
}
