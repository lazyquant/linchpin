import { NearAgentError, record } from "./errors";
import type { ModelMessage, PlannerModel, PlannerReply, PlannerRequest, ToolCall } from "./types";

export const NEARAI_BASE = "https://cloud-api.near.ai/v1";
export const NEARAI_MODEL = "z-ai/glm-5.3-flash";
export const MAX_OUTPUT_TOKENS = 1200;
export async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new NearAgentError("model-invalid"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}
export function jsonBytes(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new NearAgentError("model-invalid"); }
}
function providerMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") return { role: "tool", tool_call_id: message.id, content: JSON.stringify(message.output) };
  return { role: "assistant", content: message.content ?? null,
    ...(message.reasoning === undefined ? {} : { reasoning_content: message.reasoning }),
    ...(message.calls ? { tool_calls: message.calls.map(t => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}) };
}
function parseCall(value: unknown): ToolCall {
  if (!record(value) || typeof value.id !== "string" || !value.id || value.id.length > 128 || value.type !== "function"
    || !record(value.function) || typeof value.function.name !== "string" || !value.function.name || value.function.name.length > 128
    || typeof value.function.arguments !== "string") throw new NearAgentError("model-invalid");
  let input: unknown;
  try { input = JSON.parse(value.function.arguments); } catch { throw new NearAgentError("model-invalid"); }
  return { id: value.id, name: value.function.name, input };
}
const tokens = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export class NearAiModel implements PlannerModel {
  readonly id = NEARAI_MODEL;
  readonly mode = "live" as const;
  readonly transport: typeof fetch;
  private key: () => string | undefined;
  private clock: () => number;
  constructor(options: { fetch?: typeof fetch; key?: () => string | undefined; clock?: () => number } = {}) {
    this.transport = options.fetch ?? globalThis.fetch;
    this.key = options.key ?? (() => process.env.NEARAI_API_KEY);
    this.clock = options.clock ?? Date.now;
  }
  configured(): boolean { return !!this.key(); }
  async next(request: PlannerRequest, signal: AbortSignal): Promise<PlannerReply> {
    const key = this.key();
    if (!key) throw new NearAgentError("model-not-configured");
    const text = JSON.stringify({ model: NEARAI_MODEL, stream: false, temperature: 0, reasoning_effort: "low", max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "system", content: request.system }, ...request.messages.map(providerMessage)],
      tools: request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto" });
    let response: Response, bytes: Uint8Array;
    try {
      response = await this.transport(`${NEARAI_BASE}/chat/completions`, { method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "Accept-Encoding": "identity", "x-no-aliasing": "true" }, body: text });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new NearAgentError(response.status === 401 || response.status === 403 ? "model-auth" : response.status === 429 ? "model-quota" : "model-failed");
      }
      bytes = await responseBytes(response, 262144);
    } catch (error) {
      if (error instanceof NearAgentError) throw error;
      throw new NearAgentError("model-failed");
    }
    const body = jsonBytes(bytes);
    if (!record(body) || typeof body.id !== "string" || !body.id || body.id.length > 256 || body.model !== undefined && body.model !== NEARAI_MODEL
      || !Array.isArray(body.choices) || !record(body.choices[0]) || !record(body.choices[0].message)) throw new NearAgentError("model-invalid");
    const message = body.choices[0].message;
    const usage = record(body.usage) ? body.usage : {};
    const base = { usage: { inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens) },
      reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : undefined,
      wire: { requestBytes: new TextEncoder().encode(text), responseBytes: bytes, completionId: body.id, receivedAt: this.clock() } };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls.map(parseCall);
      if (new Set(calls.map(t => t.id)).size !== calls.length) throw new NearAgentError("model-invalid");
      return { ...base, turn: { kind: "tools", calls } };
    }
    if (typeof message.content !== "string") throw new NearAgentError("model-invalid");
    const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(message.content);
    let answer: unknown;
    try { answer = JSON.parse(fenced ? fenced[1] : message.content); } catch { throw new NearAgentError("model-invalid"); }
    return { ...base, turn: { kind: "answer", answer } };
  }
}
