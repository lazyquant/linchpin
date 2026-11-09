import type { Registry } from "./materials";
import { pyDumps } from "./pyjson";

export type Input = Record<string, unknown>;
export interface Step { id: string; agent: string; input: Input; redundancy?: number; gate?: { detect: number } }
export type Plan = readonly Step[];
export type Edge = readonly [producer: string, consumer: string];
export interface Graph { nodes: Map<string, Step>; edges: Edge[] }
export interface StructuralFlags { acyclic: boolean; dangling_refs: string[]; unknown_agents: string[]; orphans: string[]; depth: number | null; levels: string[][] | null }
export const REF = /\$\$(\w+)\$\$/g;

/** Write a reference token: the output of nodeId. */
export function ref(nodeId: string): string { return "$$" + nodeId + "$$"; }

/** Every node id referenced anywhere inside a nested input. */
export function refs(obj: unknown): Set<string> {
  return new Set([...pyDumps(obj).matchAll(REF)].map((match) => match[1]));
}

/** Nodes by id; one producer-to-consumer edge per reference. */
export function buildGraph(plan: Plan): Graph {
  const nodes = new Map(plan.map((step) => [step.id, step]));
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const step of plan) for (const dep of refs(step.input)) {
    const key = pyDumps([dep, step.id]);
    if (!seen.has(key)) { seen.add(key); edges.push([dep, step.id]); }
  }
  return { nodes, edges };
}

/** Kahn's algorithm, level by level. */
export function topoLevels(nodes: Map<string, Step>, edges: readonly Edge[]): { levels: string[][]; acyclic: boolean } {
  const indeg = new Map([...nodes.keys()].map((node) => [node, 0]));
  const succ = new Map<string, string[]>();
  for (const [a, b] of edges) if (nodes.has(a) && nodes.has(b)) {
    indeg.set(b, indeg.get(b)! + 1);
    if (!succ.has(a)) succ.set(a, []);
    succ.get(a)!.push(b);
  }
  let level = [...nodes.keys()].filter((node) => indeg.get(node) === 0);
  const levels: string[][] = [];
  let seen = 0;
  while (level.length) {
    levels.push([...level].sort());
    seen += level.length;
    const next: string[] = [];
    for (const node of level) for (const dest of succ.get(node) ?? []) {
      indeg.set(dest, indeg.get(dest)! - 1);
      if (indeg.get(dest) === 0) next.push(dest);
    }
    level = next;
  }
  return { levels, acyclic: seen === nodes.size };
}

/** The structural verdict: cycle, dangling refs, unknown agents, orphans, depth. */
export function structuralFlags(plan: Plan, registry: Registry, terminal?: readonly string[]): StructuralFlags {
  const { nodes, edges } = buildGraph(plan);
  const { levels, acyclic } = topoLevels(nodes, edges);
  const consumed = new Set(edges.map(([a]) => a));
  const outputs = terminal?.length ? terminal : plan.length ? [plan[plan.length - 1].id] : [];
  return {
    acyclic,
    dangling_refs: [...new Set(edges.filter(([a]) => !nodes.has(a)).map(([a]) => a))].sort(),
    unknown_agents: [...new Set(plan.filter((s) => !Object.hasOwn(registry, s.agent)).map((s) => s.agent))].sort(),
    orphans: [...nodes.keys()].filter((n) => !consumed.has(n) && !outputs.includes(n)).sort(),
    depth: acyclic ? levels.length : null,
    levels: acyclic ? levels : null,
  };
}

/** Name one cycle by walking back through nodes Kahn never released. */
export function findCycle(plan: Plan): string[] {
  const { nodes, edges } = buildGraph(plan);
  const { levels, acyclic } = topoLevels(nodes, edges);
  if (acyclic) return [];
  const released = new Set(levels.flat());
  const stuck = [...nodes.keys()].filter((n) => !released.has(n));
  const stuckSet = new Set(stuck);
  const pred = new Map(stuck.map((n) => [n, edges.filter(([a, b]) => b === n && stuckSet.has(a)).map(([a]) => a).sort()]));
  const walk: string[] = [];
  let n = stuck[0];
  while (!walk.includes(n)) { walk.push(n); n = pred.get(n)![0]; }
  const cycle = walk.slice(walk.indexOf(n)).reverse();
  const first = stuck.find((id) => cycle.includes(id))!;
  const i = cycle.indexOf(first);
  return [...cycle.slice(i), ...cycle.slice(0, i), first];
}

/** Name each structural defect. */
export function defects(flags: StructuralFlags, plan?: Plan): string[] {
  return [
    ...(!flags.acyclic ? ["cycle" + (plan?.length ? ": " + findCycle(plan).join(" -> ") : "")] : []),
    ...flags.dangling_refs.map((r) => `dangling reference: ${r}`),
    ...flags.unknown_agents.map((a) => `unknown agent: ${a}`),
    ...flags.orphans.map((o) => `orphan: ${o}`),
  ];
}
