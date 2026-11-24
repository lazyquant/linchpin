import { clone, NearAgentError } from "./errors";
import type { PlannerModel, PlannerReply, PlannerRequest } from "./types";

export interface Script {
  turns: ({ tools: { name: string; input: unknown }[] } | { answer: unknown })[];
}
export class ScriptedModel implements PlannerModel {
  readonly id = "scripted";
  readonly mode = "scripted" as const;
  readonly requests: PlannerRequest[] = [];
  readonly replies: PlannerReply[] = [];
  private turns = 0;
  private toolIds = 0;
  private script: Script;
  constructor(script: Script, private hooks: { beforeTurn?(index: number, signal: AbortSignal): void | Promise<void> } = {}) {
    this.script = clone(script);
  }
  async next(request: PlannerRequest, signal: AbortSignal): Promise<PlannerReply> {
    if (signal.aborted) throw new NearAgentError("aborted");
    const at = this.turns++;
    this.requests.push(clone(request));
    await this.hooks.beforeTurn?.(at, signal);
    if (signal.aborted) throw new NearAgentError("aborted");
    const turn = this.script.turns[at];
    if (!turn) throw new NearAgentError("script-exhausted");
    const reply: PlannerReply = { turn: "tools" in turn
      ? { kind: "tools", calls: turn.tools.map(t => ({ id: `t${++this.toolIds}`, name: t.name, input: clone(t.input) })) }
      : { kind: "answer", answer: clone(turn.answer) }, usage: { inputTokens: null, outputTokens: null } };
    this.replies.push(clone(reply)); return reply;
  }
}
