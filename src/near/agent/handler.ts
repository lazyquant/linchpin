import { ask } from "./planner";
import { parseAsk } from "./input";
import { preparedAnswers } from "./prepared";
import { codeOf } from "./errors";
import type { AskOptions } from "./types";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function createNearAgentHandler(options: Omit<AskOptions, "signal">): (request: Request) => Promise<Response> {
  let busy = false;
  let prepared: ReturnType<typeof preparedAnswers> | undefined;
  return async request => {
    const url = new URL(request.url), origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ codes: ["cross-origin"] }, 403);
    if (url.pathname === "/api/near-agent/prepared" && request.method === "GET") {
      try { return json(await (prepared ??= preparedAnswers(options.context))); }
      catch { prepared = undefined; return json({ codes: ["prepared-unavailable"] }, 500); }
    }
    if (url.pathname !== "/api/near-agent/ask" || request.method !== "POST") return json({ codes: ["not-found"] }, 404);
    if (Number(request.headers.get("Content-Length")) > 4096) return json({ codes: ["body-too-large"] }, 413);
    if (busy) return json({ codes: ["busy"] }, 409);
    busy = true;
    try {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 4096) { await reader.cancel(); return json({ codes: ["body-too-large"] }, 413); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let input;
      try { input = parseAsk(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), options.context); }
      catch { return json({ codes: ["invalid-request"] }, 400); }
      return json(await ask(input, { ...options, signal: request.signal }));
    } catch (error) { return json({ codes: [codeOf(error, "request-failed")] }, 500); }
    finally { busy = false; }
  };
}
