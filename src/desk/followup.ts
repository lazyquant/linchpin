/**
 * Which response id the page's next question carries. The server accepts only an id it issued since its launch
 * and keeps the last 64 (`server.ts`), so an id the page holds can go stale: after a desk restart, or once the
 * id has fallen out of that list. A stale id answers 400, and it would answer 400 again on every later question.
 * Pure, so the rule is tested without a page.
 */

/**
 * The id to send next, after an ask that carried `sent` came back with `status` and, when answered, `returned`.
 * - Answered with an id: follow that answer.
 * - 400 on an ask that carried an id: drop the id. The failure is shown, nothing is sent again, and the next
 *   question starts a new conversation. The server gives one 400 for every refused request, so a follow-up it
 *   refused for another cause (a question over the length limit) starts a new conversation too.
 * - Anything else (the guard's 422, busy, an agent failure): keep the id; the conversation is still there.
 */
export function nextPreviousResponseId(sent: string | null, status: number, returned: unknown): string | null {
  if (status === 200 && typeof returned === "string") return returned;
  if (status === 400 && sent !== null) return null;
  return sent;
}
