/**
 * The desk's one outgoing call for the agent panel: a question to IronClaw's Responses API on this machine.
 * The shape follows IronClaw 1.4.1's `docs/api/responses.mdx` and was checked against a running 1.4.1 on 2026-11-13:
 * `model` is required (`"default"` routes to the configured provider), and the text is in `output[].content[]`.
 * A turn that completes with `status: "failed"`, or an answer in another form, gives the `upstream` failure.
 * The bearer token is read at call time and appears in no result and no error.
 */
/** IronClaw requires a model name; `"default"` is its placeholder for the provider configured in its settings. */
export const IRONCLAW_MODEL = "default";
export type AgentDisabledReason = "url-invalid" | "url-not-loopback" | "token-missing";
export type AgentConfig = { enabled: true; endpoint: string; token: string } | { enabled: false; reason: AgentDisabledReason };
export type AgentFailureCause = "unauthorized" | "unreachable" | "timeout" | "upstream";

export class AgentFailure extends Error {
  constructor(readonly failure: AgentFailureCause) {
    super(failure);
    this.name = "AgentFailure";
  }
}

export interface AgentAnswer {
  responseId: string | null;
  text: string;
  /** Tool call names as the response reports them, or `null` when it reports none. */
  toolCalls: string[] | null;
}

export const DEFAULT_IRONCLAW_URL = "http://127.0.0.1:3000";
export const IRONCLAW_PATH = "/api/v1/responses";
export const IRONCLAW_TIMEOUT_MS = 60000;
export const RESPONSE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Reads the panel's configuration from the environment, at call time. A base that is not plain loopback HTTP disables the panel. */
export function agentConfig(env: Record<string, string | undefined>): AgentConfig {
  let base: URL;
  try {
    base = new URL(env.LINCHPIN_IRONCLAW_URL || DEFAULT_IRONCLAW_URL);
  } catch {
    return { enabled: false, reason: "url-invalid" };
  }
  if (base.protocol !== "http:" || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") return { enabled: false, reason: "url-invalid" };
  if (!LOOPBACK_HOSTS.has(base.hostname)) return { enabled: false, reason: "url-not-loopback" };
  const token = env.LINCHPIN_IRONCLAW_TOKEN;
  if (typeof token !== "string" || token === "") return { enabled: false, reason: "token-missing" };
  return { enabled: true, endpoint: `${base.origin}${base.pathname.replace(/\/+$/, "")}${IRONCLAW_PATH}`, token };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The answer text and the tool call names of a response body; `null` when the body holds no answer text. */
export function readResponse(body: unknown): AgentAnswer | null {
  if (!isRecord(body) || body.status === "failed") return null;
  const output = Array.isArray(body.output) ? body.output.filter(isRecord) : [];
  const parts: string[] = [];
  for (const item of output) {
    for (const content of Array.isArray(item.content) ? item.content.filter(isRecord) : []) {
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  let text: string | null = parts.length > 0 ? parts.join("") : null;
  if (text === null && typeof body.output_text === "string") text = body.output_text;
  if (text === null) return null;
  const calls = output.filter((item) => typeof item.type === "string" && item.type.endsWith("_call")).map((item) => (typeof item.name === "string" && item.name !== "" ? item.name : (item.type as string)));
  return { responseId: typeof body.id === "string" ? body.id : null, text, toolCalls: calls.length > 0 ? calls : null };
}

/**
 * Sends one question. The body holds exactly `model: "default"`, `input`, `stream: false` and, when given,
 * `previous_response_id`.
 * Throws `AgentFailure` with the cause; an error never carries the token or what the other side answered.
 */
export async function askIronclaw(input: {
  question: string;
  previousResponseId?: string;
  config: Extract<AgentConfig, { enabled: true }>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<AgentAnswer> {
  const body: Record<string, unknown> = { model: IRONCLAW_MODEL, input: input.question, stream: false };
  if (input.previousResponseId !== undefined) body.previous_response_id = input.previousResponseId;
  const signal = AbortSignal.timeout(input.timeoutMs ?? IRONCLAW_TIMEOUT_MS);
  let parsed: unknown;
  try {
    const response = await (input.fetch ?? globalThis.fetch)(input.config.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${input.config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    if (response.status === 401) throw new AgentFailure("unauthorized");
    if (!response.ok) throw new AgentFailure("upstream");
    try {
      parsed = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AgentFailure("upstream");
    }
  } catch (error) {
    if (error instanceof AgentFailure) throw error;
    const name = error instanceof Error ? error.name : "";
    if (signal.aborted || name === "TimeoutError" || name === "AbortError") throw new AgentFailure("timeout");
    throw new AgentFailure("unreachable");
  }
  const answer = readResponse(parsed);
  if (answer === null) throw new AgentFailure("upstream");
  return answer;
}
