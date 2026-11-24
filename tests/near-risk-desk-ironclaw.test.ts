import { expect, test } from "bun:test";
import { askIronclaw, IRONCLAW_MODEL, readResponse } from "../src/desk/ironclaw";

// The shape of a completed IronClaw 1.4.1 response, recorded 2026-11-13 (text shortened, usage dropped).
const COMPLETED = {
  id: "resp_829ef292d122474abca8232f9e1f1181", object: "response", created_at: 1794561119, status: "completed", model: "default",
  output: [{ type: "message", content: [{ type: "output_text", text: "A full-access key on a NEAR account is an unrestricted key." }] }],
};

test("a completed IronClaw 1.4.1 response is read", () => {
  expect(readResponse(COMPLETED)).toEqual({ responseId: COMPLETED.id, text: "A full-access key on a NEAR account is an unrestricted key.", toolCalls: null });
});

test("a turn that completed with status failed is not an answer", () => {
  expect(readResponse({ ...COMPLETED, status: "failed", error: { message: "tool failed" } })).toBeNull();
});

test("the request names the model IronClaw requires", async () => {
  let sent: Record<string, unknown> = {};
  const fake = (async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify(COMPLETED), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  const answer = await askIronclaw({ question: "q", config: { enabled: true, endpoint: "http://127.0.0.1:3000/api/v1/responses", token: "t" }, fetch: fake });
  expect(IRONCLAW_MODEL).toBe("default");
  expect(sent).toEqual({ model: "default", input: "q", stream: false });
  expect(answer.responseId).toBe(COMPLETED.id);
});

test("a failed turn surfaces as upstream", async () => {
  const fake = (async () => new Response(JSON.stringify({ ...COMPLETED, status: "failed" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  await expect(askIronclaw({ question: "q", config: { enabled: true, endpoint: "http://127.0.0.1:3000/api/v1/responses", token: "t" }, fetch: fake })).rejects.toMatchObject({ failure: "upstream" });
});
