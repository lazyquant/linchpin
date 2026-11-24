import { canonical } from "../../chain/evidence";
import { projectForModel } from "../../engine/privacy";
import { TOOLS, validateArguments } from "../mcp/tools";
import { publicEvidenceStore, projectPublic, assertPublicResponse } from "../mcp/privacy";
import { parseAction } from "../preflight/action";
import { clone, record } from "./errors";
import { resolvePublicFacts, forwardTool, projectionEnvelope } from "./projection";
import type { AskInput, NearAgentContext, SessionResult } from "./types";

export const MAX_TOOL_CALLS = 6;
export class ToolSession {
  readonly results: SessionResult[] = [];
  readonly context: NearAgentContext;
  calls = 0;
  constructor(readonly input: AskInput, context: NearAgentContext) {
    this.context = { ...context, store: publicEvidenceStore(context.store) };
  }
  seed(): Promise<SessionResult> {
    const input = this.input;
    return input.kind === "control" ? this.call("linchpin_control", { subject: input.subject })
      : input.kind === "policy" ? this.call("linchpin_policy_verdict", { policyId: input.policyId })
      : this.call("linchpin_preflight", { action: input.action, policyId: input.policyId });
  }
  async call(name: string, input: unknown): Promise<SessionResult> {
    if (this.calls >= MAX_TOOL_CALLS) return this.error(name, "tool-budget-exhausted", false);
    this.calls++;
    if (typeof name !== "string" || name.length > 128) return this.error("unknown", "unknown-tool");
    if (!TOOLS.some(t => t.name === name)) return this.error(name, "unknown-tool");
    let args: Record<string, unknown>;
    try { args = validateArguments(name, input); } catch { return this.error(name, "invalid-tool-input"); }
    if (name === "linchpin_preflight") {
      if (this.input.kind !== "preflight") return this.error(name, "action-mismatch");
      let action;
      try { action = parseAction(args.action); } catch { return this.error(name, "invalid-tool-input"); }
      if (args.policyId !== this.input.policyId || canonical(action) !== canonical(this.input.action)) return this.error(name, "action-mismatch");
    }
    try {
      const response = await this.context.dispatch(name, args, this.context);
      const value = projectPublic(response.value);
      assertPublicResponse(value);
      if (!record(value)) return this.error(name, "tool-failed");
      return this.add(name, value, response.isError);
    } catch { return this.error(name, "tool-failed"); }
  }
  private add(name: string, value: Record<string, unknown>, isError: boolean): SessionResult {
    const evidence = resolvePublicFacts(this.context, value);
    evidence.facts = projectForModel(projectionEnvelope(this.context, evidence.facts, evidence.receipts, evidence.reasons), [...this.context.subjects]).request.publicFacts;
    const action = name === "linchpin_preflight" && this.input.kind === "preflight" ? clone(this.input.action) : undefined;
    const forwarded = forwardTool(this.context, name, value, isError, evidence, action, `r${this.calls}`);
    const result: SessionResult = { id: `r${this.calls}`, name, value: clone(value), isError,
      ...evidence, forwarded: forwarded.value, truncated: forwarded.truncated };
    this.results.push(result); return result;
  }
  private error(name: string, code: string, retain = true): SessionResult {
    if (retain) return this.add(name, { error: code }, true);
    return { id: "budget", name, value: { error: code }, isError: true, facts: [], receipts: [], reasons: [],
      forwarded: { tool: name, isError: true, error: code, truncated: false }, truncated: false };
  }
}
