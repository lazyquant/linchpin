import { createHash } from "node:crypto";
import type { Materials } from "./materials";
import { E, P, nodeTokens } from "./meter";
import { structuralFlags, type Plan, type StructuralFlags } from "./plan";
import { pyDumps } from "./pyjson";

export const GATE2_CHECKS = ["G2.1 acyclic", "G2.2 references resolve", "G2.3 agents in roster", "G2.4 no orphan nodes", "G2.5 depth <= max_depth", "G2.6 tokens <= budget", "G2.7 projected P >= floor"] as const;
export type Gate2Check = (typeof GATE2_CHECKS)[number];
export interface Gate2Verdict { verdict: "PASS" | "REJECT"; checks: Record<Gate2Check, boolean>; failing: Gate2Check[]; P: number; E: number | null; tokens: number; flags: StructuralFlags }

/** Seven checks, one verdict: validate before anything runs. */
export function gate2(plan: Plan, materials: Materials): Gate2Verdict {
  const { registry, config } = materials;
  const flags = structuralFlags(plan, registry);
  const p = P(plan, registry);
  const tokens = plan.reduce((sum, step) => sum + nodeTokens(step, registry), 0);
  const checks: Record<Gate2Check, boolean> = {
    "G2.1 acyclic": flags.acyclic,
    "G2.2 references resolve": flags.dangling_refs.length === 0,
    "G2.3 agents in roster": flags.unknown_agents.length === 0,
    "G2.4 no orphan nodes": flags.orphans.length === 0,
    "G2.5 depth <= max_depth": flags.depth !== null && flags.depth <= config.max_depth,
    "G2.6 tokens <= budget": tokens <= config.token_budget,
    "G2.7 projected P >= floor": p >= config.p_floor,
  };
  const failing = GATE2_CHECKS.filter((name) => !checks[name]);
  return { verdict: failing.length ? "REJECT" : "PASS", checks, failing, P: p, E: p > 0 ? E(p) : null, tokens, flags };
}

/** Fingerprint the roster and contract: the workshop seal. */
export function seal(materials: Materials): string {
  return createHash("sha256").update(pyDumps([materials.registry, materials.config], { sortKeys: true }), "utf8").digest("hex").slice(0, 16);
}
