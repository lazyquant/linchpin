import { gate2 } from "./gate2";
import { GATE_AGENT, type Materials } from "./materials";
import { regime } from "./meter";
import { REF, buildGraph, topoLevels, type Input, type Plan, type Step } from "./plan";
import { pyDumps } from "./pyjson";

export interface TraceRecord { node: string; level: number; agent: string; assembled_prompt: string; output: string; tokens: number; gate?: "passed"; gate_tokens?: number }
export type Trace = TraceRecord[];
export interface ToolContext { level: number; state: Readonly<Record<string, string>> }
export type Tool = (step: Step, ctx: ToolContext) => Input | undefined;
export type Model = (agent: string, prompt: string) => string;
export interface ForemanOptions { tools?: Readonly<Record<string, Tool>>; model?: Model; inject?: string }
export class Gate2Error extends Error { override name = "Gate2Error"; }

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  return c >>> 0;
});

/** The IEEE CRC-32 fingerprint of a byte sequence. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** A deterministic model stand-in: fingerprint everything the node read. */
export function stub(agent: string, prompt: string): string {
  return `${agent}·${crc32(new TextEncoder().encode(prompt)).toString(16).padStart(8, "0")}`;
}

/** Run an authorized plan level by level and trace every call. */
export function foreman(plan: Plan, materials: Materials, options: ForemanOptions = {}): { trace: Trace; levels: string[][] } {
  if (gate2(plan, materials).verdict !== "PASS") throw new Gate2Error("Gate 2 has not authorized this plan.");
  const { nodes, edges } = buildGraph(plan);
  const { levels } = topoLevels(nodes, edges);
  const state: Record<string, string> = Object.create(null);
  const trace: Trace = [];
  for (const [level, names] of levels.entries()) for (const node of names) {
    const step = nodes.get(node)!;
    const inp = { ...step.input };
    const extra = options.tools?.[step.agent]?.(step, { level, state });
    if (extra) Object.assign(inp, extra);
    const prompt = pyDumps(inp).replace(REF, (_, id: string) => {
      if (state[id] === undefined) throw new Error(`Unresolved reference: ${id}`);
      return state[id];
    });
    const record = { node, level, agent: step.agent, assembled_prompt: prompt };
    const output = (options.model ?? stub)(step.agent, prompt) + (node === options.inject ? " [DRIFT]" : "");
    const complete: TraceRecord = Object.assign(record, { output, tokens: materials.registry[step.agent].tokens });
    if (step.gate) { complete.gate = "passed"; complete.gate_tokens = materials.registry[GATE_AGENT].tokens; }
    state[node] = output;
    trace.push(complete);
  }
  return { trace, levels };
}

/** Every changed node: run order first, then missing baseline nodes. */
export function diffTraces(base: Trace, run: Trace): string[] {
  const b = new Map(base.map((t) => [t.node, t]));
  const r = new Map(run.map((t) => [t.node, t]));
  const order = [...run.map((t) => t.node), ...base.filter((t) => !r.has(t.node)).map((t) => t.node)];
  return order.filter((n) => pyDumps(b.get(n), { sortKeys: true }) !== pyDumps(r.get(n), { sortKeys: true }));
}

/** In a few words, how one node differs from its baseline record. */
export function whatChanged(b: TraceRecord | undefined, t: TraceRecord | undefined): string {
  if (!b) return "new node";
  if (!t) return "missing from the run";
  const pb = JSON.parse(b.assembled_prompt) as Input;
  const pt = JSON.parse(t.assembled_prompt) as Input;
  const keys = [...Object.keys(pt), ...Object.keys(pb).filter((k) => !Object.hasOwn(pt, k))];
  const words = keys.filter((k) => pyDumps(pb[k], { sortKeys: true }) !== pyDumps(pt[k], { sortKeys: true }))
    .map((k) => `'${k}' ` + (!Object.hasOwn(pb, k) ? "is new" : !Object.hasOwn(pt, k) ? "is gone" : "changed"));
  for (const k of ["level", "output", "tokens", "gate"] as const) if (b[k] !== t[k]) words.push(`${k} changed`);
  return words.join(", ") || "same";
}

/** Every node reachable along the edges. */
export function downstream(plan: Plan, node: string): Set<string> {
  const { edges } = buildGraph(plan);
  const reach = new Set<string>();
  const frontier = [node];
  while (frontier.length) {
    const n = frontier.pop()!;
    for (const [a, b] of edges) if (a === n && !reach.has(b)) { reach.add(b); frontier.push(b); }
  }
  return reach;
}

/** Tokens actually spent: every call, including the gates' checks. */
export function runTokens(trace: Trace): number { return trace.reduce((sum, t) => sum + t.tokens + (t.gate_tokens ?? 0), 0); }
export type ProvenanceCheck = (run: Trace) => boolean;
export const CERTIFICATE_CHECKS = ["Structural flags clean (Lab 1)", "P >= floor, E viable (Lab 2)", "Gate 2 verdict (Lab 3)", "Provenance on every fact (Lab 4)", "Trace diff vs baseline (Lab 5)"] as const;
export type CertificateCheck = (typeof CERTIFICATE_CHECKS)[number];
export interface Certificate { verdict: "PASS" | "FAIL"; checks: Record<CertificateCheck, boolean>; failing: CertificateCheck[] }

/** Five checks, one per lab: the verdict is a conjunction, never a mean. */
export function certify(plan: Plan, run: Trace, base: Trace, materials: Materials, provenance: ProvenanceCheck): Certificate {
  const v = gate2(plan, materials);
  const f = v.flags;
  const checks: Record<CertificateCheck, boolean> = {
    "Structural flags clean (Lab 1)": f.acyclic && !f.dangling_refs.length && !f.unknown_agents.length && !f.orphans.length,
    "P >= floor, E viable (Lab 2)": v.E !== null && v.P >= materials.config.p_floor && regime(v.E, materials.config.coin_toss) === "VIABLE",
    "Gate 2 verdict (Lab 3)": v.verdict === "PASS",
    "Provenance on every fact (Lab 4)": provenance(run),
    "Trace diff vs baseline (Lab 5)": run.length > 0 && diffTraces(base, run).length === 0,
  };
  const failing = CERTIFICATE_CHECKS.filter((name) => !checks[name]);
  return { verdict: failing.length ? "FAIL" : "PASS", checks, failing };
}
