import { GATE_AGENT, type Registry } from "./materials";
import type { Plan, Step } from "./plan";

/** Reliability of one step, raised by its repair label. */
export function nodeRho(step: Step, registry: Registry): number {
  let rho = Object.hasOwn(registry, step.agent) ? registry[step.agent].rho : 0;
  if ((step.redundancy ?? 1) > 1) rho = 1 - (1 - rho) ** step.redundancy!;
  if (step.gate) rho += (1 - rho) * step.gate.detect * rho;
  return rho;
}

/** Probability Decay Theorem: every step must be right. */
export function P(plan: Plan, registry: Registry): number { return plan.reduce((p, step) => p * nodeRho(step, registry), 1); }
/** Sum of Exceptions budget: E = 1 + ln P. */
export function E(p: number): number { return 1 + Math.log(p); }
export type Regime = "VIABLE" | "BELOW COIN TOSS (still paying)" | "NEGATIVE ROI" | "COMPLETE FAILURE";
/** Read the budget against the coin toss. */
export function regime(e: number, coinToss = 0.5): Regime {
  if (e > 1 + Math.log(coinToss)) return "VIABLE";
  if (e > 0) return "BELOW COIN TOSS (still paying)";
  if (e > -1) return "NEGATIVE ROI";
  return "COMPLETE FAILURE";
}

/** Projected tokens: attempts, plus the gate's check and expected retry. */
export function nodeTokens(step: Step, registry: Registry): number {
  const { tokens, rho } = Object.hasOwn(registry, step.agent) ? registry[step.agent] : { tokens: 0, rho: 0 };
  let total = tokens * (step.redundancy ?? 1);
  if (step.gate) {
    if (!Object.hasOwn(registry, GATE_AGENT)) throw new Error(`Missing gate agent: ${GATE_AGENT}`);
    total += registry[GATE_AGENT].tokens + Math.trunc(tokens * (1 - rho));
  }
  return total;
}
