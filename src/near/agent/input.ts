import { parseAction } from "../preflight/action";
import { parseNearSubject } from "../reader/types";
import { NearAgentError, record } from "./errors";
import type { AskInput, NearAgentContext } from "./types";

const invalid = (): never => { throw new NearAgentError("invalid-request"); };
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Reflect.ownKeys(value).some(k => typeof k !== "string" || !allowed.includes(k))) invalid();
}
export function parseAsk(value: unknown, context: Pick<NearAgentContext, "subjects" | "assets" | "policies">): AskInput {
  if (!record(value)) return invalid();
  if (value.kind === "control") {
    keys(value, ["kind", "subject"]);
    if (typeof value.subject !== "string") return invalid();
    const subject = value.subject.startsWith("near:") ? value.subject : `near:mainnet:${value.subject}`;
    if (!parseNearSubject(subject) || subject.includes("#holder:") || !context.subjects.has(subject)) return invalid();
    return { kind: "control", subject };
  }
  if (value.kind !== "policy" && value.kind !== "preflight") return invalid();
  keys(value, value.kind === "policy" ? ["kind", "policyId"] : ["kind", "action", "policyId"]);
  if (typeof value.policyId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.policyId) || !context.policies.has(value.policyId)) return invalid();
  if (value.kind === "policy") return { kind: "policy", policyId: value.policyId };
  if (!record(value.action) || Object.hasOwn(value.action, "method")) return invalid();
  let action;
  try { action = parseAction(value.action); } catch { return invalid(); }
  if (action.kind === "contract-call") {
    if (!context.subjects.has(action.receiver)) return invalid();
  } else if (!context.assets.has(action.originAsset) || !context.assets.has(action.destinationAsset)) return invalid();
  return { kind: "preflight", policyId: value.policyId, action };
}
export function questionFor(input: AskInput): string {
  if (input.kind === "control") return `Show the recorded control of ${input.subject}.`;
  if (input.kind === "policy") return `Show the recorded verdict of policy ${input.policyId}.`;
  return `Show the recorded preflight of ${JSON.stringify(input.action)} under policy ${input.policyId}.`;
}
