/**
 * The adapter for Anthropic's Messages API. Requests leave from the server only. The model id comes from
 * LINCHPIN_AGENT_MODEL and has no default; the key is read from the environment at each call and is never
 * returned, logged or put into an error. An error carries a code and nothing of the provider's words.
 */
import { canonical } from "../chain/evidence";
import { ModelError, type ModelMessage, type ModelReply, type ModelRequest, type ModelTurn, type PlannerModel } from "./planner";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const MAX_TOKENS = 16000;
export const MODEL_VARIABLE = "LINCHPIN_AGENT_MODEL";
const KEY_VARIABLE = "ANTHROPIC_API_KEY";
export const REPAIR_PREFIX = "The surface was rejected. Rule codes: ";

type Block = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of an answer as JSON: trimmed, one enclosing code fence removed. Text that does not parse gives `null`. */
function parseAnswer(text: string): unknown {
  let body = text.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced) body = fenced[1].trim();
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function turnOf(content: unknown[], stopReason: unknown): ModelTurn {
  const blocks = content.filter(isRecord);
  if (stopReason === "tool_use") {
    return {
      kind: "tools",
      calls: blocks.filter((block) => block.type === "tool_use").map((block) => ({ id: String(block.id), name: String(block.name), input: block.input })),
    };
  }
  if (stopReason === "end_turn") {
    const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");
    return { kind: "answer", answer: parseAnswer(text) };
  }
  throw new ModelError("model-stopped");
}

/** A turn as content blocks, for a turn this adapter did not receive itself. */
function blocksOf(turn: ModelTurn): Block[] {
  if (turn.kind === "tools") return turn.calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} }));
  return [{ type: "text", text: JSON.stringify(turn.answer) }];
}

class AnthropicModel implements PlannerModel {
  readonly id: string;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch | undefined;
  /** The content list of each reply as received, with the turn it was read as. It goes back unchanged. */
  private readonly received: { turn: string; content: unknown[] }[] = [];

  constructor(id: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch | undefined) {
    this.id = id;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  private messages(history: ModelMessage[]): { role: "user" | "assistant"; content: unknown }[] {
    const out: { role: "user" | "assistant"; content: unknown }[] = [];
    let replies = 0;
    for (const message of history) {
      if (message.role === "assistant") {
        const kept = this.received[replies++];
        out.push({ role: "assistant", content: kept && kept.turn === canonical(message.turn) ? kept.content : blocksOf(message.turn) });
      } else if (message.role === "tool") {
        out.push({
          role: "user",
          content: message.results.map((result) => {
            const block: Block = { type: "tool_result", tool_use_id: result.id, content: JSON.stringify(result.output ?? null) };
            if (isRecord(result.output) && typeof result.output.error === "string") block.is_error = true;
            return block;
          }),
        });
      } else if (message.kind === "question") {
        out.push({ role: "user", content: `Protocol: ${message.protocol}\nQuestion: ${message.question}` });
      } else {
        out.push({ role: "user", content: REPAIR_PREFIX + message.codes.join(", ") });
      }
    }
    return out;
  }

  async next(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    const key = this.env[KEY_VARIABLE];
    if (typeof key !== "string" || key === "") throw new ModelError("model-not-configured");
    const body = {
      model: this.id,
      max_tokens: MAX_TOKENS,
      system: request.system,
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      messages: this.messages(request.messages),
    };
    let status: number;
    let reply: unknown;
    try {
      const send = this.fetchImpl ?? fetch;
      const response = await send(ENDPOINT, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      status = response.status;
      reply = status === 200 ? await response.json() : null;
    } catch {
      // Nothing of the failure is kept: its message can hold the request.
      throw new ModelError("model-network");
    }
    if (status !== 200) throw new ModelError(`model-http-${status}`);
    if (!isRecord(reply) || !Array.isArray(reply.content)) throw new ModelError("model-bad-reply");
    const turn = turnOf(reply.content, reply.stop_reason);
    this.received.push({ turn: canonical(turn), content: reply.content });
    const usage = isRecord(reply.usage) ? reply.usage : {};
    return {
      turn,
      usage: {
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      },
    };
  }
}

/**
 * The model named by LINCHPIN_AGENT_MODEL. Without that variable it throws `ModelError("model-not-configured")`
 * and nothing is sent. One instance serves one answer: it keeps the replies of that conversation.
 */
export function anthropicModelFromEnv(deps: { env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}): PlannerModel {
  const env = deps.env ?? process.env;
  const id = env[MODEL_VARIABLE];
  if (typeof id !== "string" || id.trim() === "") throw new ModelError("model-not-configured");
  return new AnthropicModel(id, env, deps.fetch);
}
