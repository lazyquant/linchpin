import { ask } from "./planner";
import { ScriptedModel } from "./model";
import { parseAsk, questionFor } from "./input";
import type { AskInput, AskResponse, NearAgentContext } from "./types";
import { SCRIPTED_LABEL } from "./web/strings";

export const PREPARED_INPUTS = [
  { kind: "control", subject: "near:mainnet:intents.near" },
  { kind: "preflight", action: { kind: "contract-call", receiver: "near:mainnet:contract.main.burrow.near" }, policyId: "quantrin-near-v1" },
  { kind: "policy", policyId: "quantrin-near-v1" },
] as const;
export const preparedModel = () => new ScriptedModel({ turns: [{ answer: { view: "subject-panel", results: ["r1"] } }] });
export async function prepareAnswer(input: unknown, context: NearAgentContext): Promise<AskResponse> {
  const at = Date.parse(context.store.snapshot(context.snapshotId)!.observedTo);
  const response = await ask(input, { context, model: preparedModel(), clock: () => at });
  return { ...response, kind: response.kind === "answer" ? "prepared" : response.kind };
}
export interface PreparedAnswer { id: string; input: AskInput; question: string; label: string; response: AskResponse }
export async function preparedAnswers(context: NearAgentContext): Promise<PreparedAnswer[]> {
  const answers: PreparedAnswer[] = [];
  for (const value of PREPARED_INPUTS) {
    const input = parseAsk(value, context);
    answers.push({ id: input.kind, input, question: questionFor(input), label: SCRIPTED_LABEL, response: await prepareAnswer(input, context) });
  }
  return answers;
}
