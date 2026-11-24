/**
 * The answer loop. A model is asked for tool calls and then for a surface; the loop runs the tools, writes the
 * data model, passes the surface through the gate, allows one repair and otherwise sends the fixed refusal. It
 * holds the limits: six tool calls, eight model calls, sixty seconds.
 */
import { canonical, sha256 } from "../chain/evidence";
import type { A2uiMessage, CoverageInput, SurfaceMeta } from "../ui/types";
import { validateSurface } from "../ui/validate";
import { answerMeta, composeAnswer, noModelSurface, refusalSurface, toNdjson } from "./compose";
import { GOLDEN } from "./golden";
import { SYSTEM_PROMPT } from "./prompt";
import type { RetrievalBackend } from "./retrieval";
import { DEFAULT_MAX_ROWS, TOOL_SPECS, ToolSession } from "./tools";

export type ToolCall = { id: string; name: string; input: unknown };
export type ModelTurn = { kind: "tools"; calls: ToolCall[] } | { kind: "answer"; answer: unknown };
export type ModelMessage =
  | { role: "user"; kind: "question"; question: string; protocol: string }
  | { role: "assistant"; turn: ModelTurn }
  | { role: "tool"; results: { id: string; name: string; output: unknown }[] }
  | { role: "user"; kind: "repair"; codes: string[] };
export type ModelRequest = { system: string; tools: typeof TOOL_SPECS; messages: ModelMessage[] };
export type ModelReply = { turn: ModelTurn; usage: { inputTokens: number | null; outputTokens: number | null } };

export interface PlannerModel {
  readonly id: string;
  next(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}

/** A model that could not answer. It carries a code and nothing of the provider's words. */
export class ModelError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ModelError";
    this.code = code;
  }
}

export type Script = { turns: ({ tools: { name: string; input: unknown }[] } | { answer: unknown })[] };

const copy = <T>(value: T): T => structuredClone(value);

/** The key a recorded reply is found by: the sha256 of the canonical request. */
export function requestSha256(request: ModelRequest): string {
  return sha256(canonical(request));
}

/**
 * A model that plays a fixed script: turn n on its n-th call, whatever the request holds. Tool calls get the ids
 * t1, t2 and so on across the script. `beforeTurn` is called with the position of the turn, counted from zero,
 * before the turn is returned.
 */
export class ScriptedModel implements PlannerModel {
  readonly id = "scripted";
  /** One deep copy per call, in call order. */
  readonly requests: ModelRequest[] = [];
  /** What each call returned, in call order. */
  readonly replies: ModelReply[] = [];
  private readonly script: Script;
  private readonly hooks: { beforeTurn?(index: number): void | Promise<void> };
  private calls = 0;
  private toolIds = 0;

  constructor(script: Script, hooks: { beforeTurn?(index: number): void | Promise<void> } = {}) {
    this.script = copy(script);
    this.hooks = hooks;
  }

  async next(request: ModelRequest, _signal: AbortSignal): Promise<ModelReply> {
    const index = this.calls++;
    this.requests.push(copy(request));
    await this.hooks.beforeTurn?.(index);
    const turn = this.script.turns[index];
    if (turn === undefined) throw new ModelError("script-exhausted");
    const reply: ModelReply = {
      turn: "tools" in turn
        ? { kind: "tools", calls: turn.tools.map((call) => ({ id: `t${++this.toolIds}`, name: call.name, input: copy(call.input) })) }
        : { kind: "answer", answer: copy(turn.answer) },
      usage: { inputTokens: null, outputTokens: null },
    };
    this.replies.push(copy(reply));
    return reply;
  }
}

/** A model that replays recorded replies, each found by the hash of the request that got it. */
export class ReplayModel implements PlannerModel {
  readonly id: string;
  private readonly entries: { requestSha256: string; reply: ModelReply }[];

  constructor(transcript: { modelId: string; entries: { requestSha256: string; reply: ModelReply }[] }) {
    this.id = transcript.modelId;
    this.entries = copy(transcript.entries);
  }

  async next(request: ModelRequest, _signal: AbortSignal): Promise<ModelReply> {
    const hash = requestSha256(request);
    const entry = this.entries.find((candidate) => candidate.requestSha256 === hash);
    if (!entry) throw new ModelError("replay-miss");
    return copy(entry.reply);
  }
}

export const MAX_TOOL_CALLS = 6;
export const MAX_MODEL_CALLS = 8;
export const DEADLINE_MS = 60000;

export type AnswerOutcome = {
  kind: "answer" | "repaired" | "refusal" | "no-model" | "aborted";
  messages: A2uiMessage[];
  ndjson: string;
  codes: string[];
  modelCalls: number;
  toolCalls: number;
  toolNames: string[];
  templateIds: string[];
  results: { id: string; rows: number }[];
  inputTokens: number | null;
  outputTokens: number | null;
};

const scopes = new WeakMap<RetrievalBackend, Map<string, { title: string; snapshotIds: string[] }>>();

/**
 * The title and snapshot ids of a protocol, read from the backend's coverage once per backend. A backend serves
 * one snapshot per protocol for as long as it lives, so the answer is kept.
 */
export function protocolScope(backend: RetrievalBackend, protocol: string): { title: string; snapshotIds: string[] } {
  let known = scopes.get(backend);
  if (!known) {
    known = new Map();
    scopes.set(backend, known);
  }
  let scope = known.get(protocol);
  if (!scope) {
    const coverage = backend.coverage(protocol);
    scope = { title: coverage.title, snapshotIds: [...coverage.snapshotIds] };
    known.set(protocol, scope);
  }
  return { title: scope.title, snapshotIds: [...scope.snapshotIds] };
}

/** The fixed surfaces pass the same validator as every other surface before they are sent. */
function checked(messages: A2uiMessage[], coverage: CoverageInput): A2uiMessage[] {
  if (!validateSurface(messages, { resolveEvidence: () => ({ missing: [] }), coverage }).ok) throw new Error("fixed-surface-invalid");
  return messages;
}

/**
 * Answers one question. `model: null` gives the fixed surface of a machine without a model. The outcome always
 * says how it ended; only `aborted` carries no messages.
 */
export async function answerQuestion(input: {
  question: string; protocol: string; backend: RetrievalBackend; model: PlannerModel | null;
  signal?: AbortSignal; clock?: () => number; maxRows?: number;
}): Promise<AnswerOutcome> {
  const { backend, protocol, model } = input;
  const clock = input.clock ?? Date.now;
  const start = clock();
  const scope = protocolScope(backend, protocol);
  const meta: SurfaceMeta = answerMeta(input.question, scope.title, scope.snapshotIds);
  const session = new ToolSession({ backend, protocol, maxRows: input.maxRows ?? DEFAULT_MAX_ROWS });
  const empty: CoverageInput = { mechanics: [], asked: [] };

  let modelCalls = 0;
  let toolCalls = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let tokensKnown = true;
  const outcome = (kind: AnswerOutcome["kind"], messages: A2uiMessage[], codes: string[]): AnswerOutcome => ({
    kind, messages, ndjson: toNdjson(messages), codes, modelCalls, toolCalls,
    toolNames: [...session.toolNames], templateIds: [...session.templateIds],
    results: session.results.map((result) => ({ id: result.resultId, rows: Array.isArray(result.rows) ? result.rows.length : 0 })),
    inputTokens: tokensKnown ? inputTokens : null, outputTokens: tokensKnown ? outputTokens : null,
  });
  const refusal = (codes: string[]): AnswerOutcome => outcome("refusal", checked(refusalSurface(meta, codes), empty), codes);
  const noModel = (): AnswerOutcome => {
    const served = new Set(backend.protocols().map((entry) => entry.id));
    const prepared = GOLDEN.filter((entry) => served.has(entry.protocol)).map(({ id, protocol: of, question }) => ({ id, protocol: of, question }));
    return outcome("no-model", checked(noModelSurface(meta, prepared), empty), []);
  };
  if (model === null) return noModel();

  // The caller's signal says the asker is gone; the timer says the answer took too long. Both stop the model call.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const gone = (): boolean => input.signal?.aborted === true;
  const late = (): boolean => deadline.signal.aborted || clock() - start >= DEADLINE_MS;

  const messages: ModelMessage[] = [{ role: "user", kind: "question", question: meta.question ?? "", protocol }];
  let repaired = false;
  try {
    for (;;) {
      if (gone()) return outcome("aborted", [], []);
      if (late()) return refusal(["deadline"]);
      if (modelCalls >= MAX_MODEL_CALLS) return refusal(["model-budget-exhausted"]);
      modelCalls++;
      let reply: ModelReply;
      try {
        reply = await model.next({ system: SYSTEM_PROMPT, tools: TOOL_SPECS, messages: copy(messages) }, signal);
      } catch (error) {
        if (gone()) return outcome("aborted", [], []);
        if (late()) return refusal(["deadline"]);
        if (error instanceof ModelError) return error.code === "model-not-configured" ? noModel() : refusal([error.code]);
        return refusal(["model-failed"]);
      }
      if (gone()) return outcome("aborted", [], []);
      if (late()) return refusal(["deadline"]);
      const usage = reply?.usage;
      if (typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number") {
        inputTokens = (inputTokens ?? 0) + usage.inputTokens;
        outputTokens = (outputTokens ?? 0) + usage.outputTokens;
      } else tokensKnown = false;

      const turn = reply?.turn;
      if (turn?.kind === "tools" && Array.isArray(turn.calls)) {
        messages.push({ role: "assistant", turn: copy(turn) });
        const results: { id: string; name: string; output: unknown }[] = [];
        for (const call of turn.calls) {
          if (gone()) return outcome("aborted", [], []);
          if (late()) return refusal(["deadline"]);
          let output: unknown;
          if (toolCalls >= MAX_TOOL_CALLS) output = { error: "tool-budget-exhausted" };
          else {
            toolCalls++;
            output = await session.call(call?.name, call?.input);
          }
          results.push({ id: String(call?.id), name: String(call?.name), output });
        }
        messages.push({ role: "tool", results: copy(results) });
        continue;
      }

      const answer = turn?.kind === "answer" ? turn.answer : null;
      messages.push({ role: "assistant", turn: { kind: "answer", answer: copy(answer) } });
      const coverage: CoverageInput = { mechanics: session.mechanics.map((entry) => ({ ...entry })), asked: [] };
      const composed = await composeAnswer({ answer, meta, results: session.results, coverage, backend, protocol });
      if (gone()) return outcome("aborted", [], []);
      if (composed.codes.length === 0) return outcome(repaired ? "repaired" : "answer", composed.messages, []);
      if (repaired) return refusal(composed.codes);
      repaired = true;
      messages.push({ role: "user", kind: "repair", codes: [...composed.codes] });
    }
  } finally {
    clearTimeout(timer);
  }
}
