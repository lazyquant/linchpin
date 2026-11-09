// The lab fixtures of Denis Rothman's "Graph Engineering for AI Agents" (Labs 1, 2, 3 and 5),
// reproduced exactly: the plans as given, the fixed plans of the debriefs, and the numbers the
// notebooks print. Lab 4's knowledge-graph walk is not part of src/harness (Linchpin has its own
// evidence graph); the few lines of it that Lab 5's trace fixture needs live here, in the test.
import { describe, expect, test } from "bun:test";
import { buildGraph, defects, findCycle, ref, refs, structuralFlags, topoLevels, type Plan, type Step } from "../src/harness/plan";
import { E, P, nodeRho, nodeTokens, regime } from "../src/harness/meter";
import { gate2, seal } from "../src/harness/gate2";
import { Gate2Error, certify, crc32, diffTraces, downstream, foreman, runTokens, stub, whatChanged, type Trace } from "../src/harness/foreman";
import { labMaterials, loadMaterials, parseConfig, parseRegistry, registerTool } from "../src/harness/materials";
import { pyDumps } from "../src/harness/pyjson";

const M = labMaterials();
const { registry: REGISTRY, config: CONFIG } = M;

// ---------------------------------------------------------------------------------------------
// The materials: registry.json and config.json as shipped with the labs
// ---------------------------------------------------------------------------------------------
describe("materials", () => {
  test("the shipped registry and config carry the lab values", () => {
    expect(REGISTRY).toEqual({
      Gate1: { rho: 0.99, tokens: 200 },
      Librarian: { rho: 0.97, tokens: 900 },
      Researcher: { rho: 0.95, tokens: 1800 },
      Writer: { rho: 0.93, tokens: 2600 },
      Verifier: { rho: 0.98, tokens: 700 },
      Summarizer: { rho: 0.96, tokens: 1200 },
    });
    expect(CONFIG).toEqual({ max_depth: 6, token_budget: 12000, p_floor: 0.8, coin_toss: 0.5, max_hops: 3 });
  });

  test("the seal of the shipped materials is the labs' SEAL", () => {
    expect(seal(M)).toBe("f00cf0f8019a3afb");
    expect(seal({ ...M, config: { ...CONFIG, p_floor: 0.81 } })).not.toBe("f00cf0f8019a3afb");
  });

  test("the loader reads the same files from disk", async () => {
    const loaded = await loadMaterials("src/harness/registry.json", "src/harness/config.json");
    expect(loaded).toEqual(M);
  });

  test("registerTool returns a new registry and leaves the old one alone", () => {
    const r2 = registerTool(REGISTRY, "DependenciesQuery", { rho: 0.999, tokens: 50 });
    expect(r2.DependenciesQuery).toEqual({ rho: 0.999, tokens: 50 });
    expect(REGISTRY).not.toHaveProperty("DependenciesQuery");
    expect(() => registerTool(REGISTRY, "Writer", { rho: 0.5, tokens: 1 })).toThrow(/already/);
  });

  test("the parsers reject malformed materials", () => {
    expect(() => parseRegistry({ X: { rho: 1.2, tokens: 10 } })).toThrow();
    expect(() => parseRegistry({ X: { rho: 0.5, tokens: -1 } })).toThrow();
    expect(() => parseRegistry({ X: { rho: "0.5", tokens: 10 } })).toThrow();
    expect(() => parseConfig({ max_depth: 6 })).toThrow();
    expect(() => parseConfig({ ...CONFIG, extra: 1 })).toThrow(/unknown bindings: extra/);
    expect(parseConfig({ max_depth: 6, token_budget: 12000, p_floor: 0.8, coin_toss: 0.5, max_hops: 3 })).toEqual(CONFIG);
  });
});

// ---------------------------------------------------------------------------------------------
// Python's json.dumps, reproduced: the fingerprints depend on it
// ---------------------------------------------------------------------------------------------
describe("pyDumps", () => {
  test("uses ', ' and ': ' separators, insertion order, ensure_ascii and Python float repr", () => {
    const value = { b: 1, c: 0.1, d: 1e-5, e: 1e16, f: "é·\u007f\n\"\\/", g: [true, null], h: { z: 1, y: 2 } };
    expect(pyDumps(value)).toBe('{"b": 1, "c": 0.1, "d": 1e-05, "e": 1e+16, "f": "\\u00e9\\u00b7\\u007f\\n\\"\\\\/", "g": [true, null], "h": {"z": 1, "y": 2}}');
  });

  test("sortKeys sorts every level", () => {
    expect(pyDumps({ z: 1, y: { b: 2, a: 1 } }, { sortKeys: true })).toBe('{"y": {"a": 1, "b": 2}, "z": 1}');
  });

  test("the reference token survives serialisation unchanged", () => {
    expect(pyDumps({ facts: [ref("resA"), ref("resB")] })).toBe('{"facts": ["$$resA$$", "$$resB$$"]}');
  });
});

// ---------------------------------------------------------------------------------------------
// Lab 1 · the structural inspector
// ---------------------------------------------------------------------------------------------
const BROKEN_PLAN: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "compliance brief structure" } },
  { id: "resA", agent: "Researcher", input: { topic_query: "GDPR Art.28" } },
  { id: "resB", agent: "Researcher", input: { topic_query: "DPA template" } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("resA"), ref("resB")] } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write"), loop: ref("polish") } },
  { id: "polish", agent: "Stylist", input: { draft: ref("verify") } },
  { id: "extra", agent: "Summarizer", input: { text: ref("resB") } },
  { id: "cite", agent: "Writer", input: { facts: ref("resC") } },
];

const LAB1_FIXED_A: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "compliance brief structure" } },
  { id: "resA", agent: "Researcher", input: { topic_query: "GDPR Art.28" } },
  { id: "resB", agent: "Researcher", input: { topic_query: "DPA template" } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("resA"), ref("resB")] } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") } },
];

describe("Lab 1 · correct the broken plan", () => {
  test("ref and refs: every $$id$$ token inside a nested input", () => {
    expect(ref("lib")).toBe("$$lib$$");
    expect(refs({ blueprint: ref("lib"), facts: [ref("resA"), { deep: ref("resB") }], plain: "no token" })).toEqual(new Set(["lib", "resA", "resB"]));
    expect(refs({ q: "GDPR Art.28" })).toEqual(new Set());
  });

  test("buildGraph: one producer->consumer edge per reference", () => {
    const { nodes, edges } = buildGraph(LAB1_FIXED_A);
    expect([...nodes.keys()]).toEqual(["lib", "resA", "resB", "write", "verify"]);
    expect(new Set(edges.map((e) => e.join("->")))).toEqual(new Set(["lib->write", "resA->write", "resB->write", "write->verify"]));
  });

  test("the broken plan yields exactly four defects", () => {
    const flags = structuralFlags(BROKEN_PLAN, REGISTRY);
    expect(flags).toEqual({
      acyclic: false,
      dangling_refs: ["resC"],
      unknown_agents: ["Stylist"],
      orphans: ["extra"],
      depth: null,
      levels: null,
    });
    expect(findCycle(BROKEN_PLAN)).toEqual(["verify", "polish", "verify"]);
    const left = defects(flags, BROKEN_PLAN);
    expect(left).toHaveLength(4);
    expect(left).toEqual([
      "cycle: verify -> polish -> verify",
      "dangling reference: resC",
      "unknown agent: Stylist",
      "orphan: extra",
    ]);
  });

  test("fixed plan A has no defects and three rounds", () => {
    const flags = structuralFlags(LAB1_FIXED_A, REGISTRY);
    expect(defects(flags, LAB1_FIXED_A)).toEqual([]);
    expect(findCycle(LAB1_FIXED_A)).toEqual([]);
    expect(flags.depth).toBe(3);
    expect(flags.levels).toEqual([["lib", "resA", "resB"], ["write"], ["verify"]]);
    const { nodes, edges } = buildGraph(LAB1_FIXED_A);
    expect(topoLevels(nodes, edges)).toEqual({ levels: [["lib", "resA", "resB"], ["write"], ["verify"]], acyclic: true });
  });

  test("a terminal other than the last step changes who is an orphan", () => {
    const flags = structuralFlags(LAB1_FIXED_A, REGISTRY, ["write"]);
    expect(flags.orphans).toEqual(["verify"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Lab 2 · the reliability meter
// ---------------------------------------------------------------------------------------------
const LAB2_GIVEN: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "compliance brief structure" } },
  { id: "resA", agent: "Researcher", input: { topic_query: "GDPR Art.28" } },
  { id: "resB", agent: "Researcher", input: { topic_query: "DPA template" } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("resA"), ref("resB")] } },
  { id: "extra", agent: "Summarizer", input: { text: ref("resB") }, redundancy: 2 },
  { id: "recap", agent: "Summarizer", input: { text: ref("write") }, gate: { detect: 0.9 } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") } },
];

const LAB2_FIXED_A: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "compliance brief structure" } },
  { id: "resA", agent: "Researcher", input: { topic_query: "GDPR Art.28" }, redundancy: 2 },
  { id: "resB", agent: "Researcher", input: { topic_query: "DPA template" } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("resA"), ref("resB")] }, gate: { detect: 0.9 } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") } },
];

describe("Lab 2 · repair the plan until it meets the contract", () => {
  test("the given plan reads P = 0.792 with orphans extra and recap", () => {
    expect(LAB2_GIVEN.map((s) => nodeRho(s, REGISTRY).toFixed(4))).toEqual(["0.9700", "0.9500", "0.9500", "0.9300", "0.9984", "0.9946", "0.9800"]);
    const p = P(LAB2_GIVEN, REGISTRY);
    expect(p).toBeCloseTo(0.792, 3);
    expect(p).toBeLessThan(CONFIG.p_floor);
    expect(E(p)).toBeCloseTo(0.767, 3);
    expect(regime(E(p), CONFIG.coin_toss)).toBe("VIABLE");
    expect(structuralFlags(LAB2_GIVEN, REGISTRY).orphans).toEqual(["extra", "recap"]);
  });

  test("fixed plan A: redundancy 2 on resA and a gate on the Writer give P = 0.891 >= 0.80", () => {
    expect(nodeRho(LAB2_FIXED_A[1]!, REGISTRY)).toBeCloseTo(0.9975, 6);
    expect(nodeRho(LAB2_FIXED_A[3]!, REGISTRY)).toBeCloseTo(0.98859, 5);
    const p = P(LAB2_FIXED_A, REGISTRY);
    expect(p).toBeCloseTo(0.891, 3);
    expect(p).toBeGreaterThanOrEqual(CONFIG.p_floor);
    expect(structuralFlags(LAB2_FIXED_A, REGISTRY).orphans).toEqual([]);
  });

  test("an agent outside the registry has rho 0", () => {
    expect(nodeRho({ id: "x", agent: "Stylist", input: {} }, REGISTRY)).toBe(0);
  });

  test("the regimes read the budget E = 1 + ln P", () => {
    expect(E(1)).toBe(1);
    expect(regime(E(0.9), 0.5)).toBe("VIABLE");
    expect(regime(E(0.45), 0.5)).toBe("BELOW COIN TOSS (still paying)");
    expect(regime(E(0.2), 0.5)).toBe("NEGATIVE ROI");
    expect(regime(E(0.1), 0.5)).toBe("COMPLETE FAILURE");
  });
});

// ---------------------------------------------------------------------------------------------
// Lab 3 · Gate 2: the cost meter and the seven checks
// ---------------------------------------------------------------------------------------------
const LAB3_GIVEN: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "compliance brief structure" } },
  { id: "resA", agent: "Researcher", input: { topic_query: "GDPR Art.28" }, redundancy: 2 },
  { id: "resB", agent: "Researcher", input: { topic_query: "DPA template" }, redundancy: 2 },
  { id: "resC", agent: "Researcher", input: { topic_query: "SCC 2021" }, redundancy: 2 },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("resA"), ref("resB"), ref("resC")] } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") }, gate: { detect: 0.9 } },
];

const LAB3_FIXED_A: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "compliance brief structure" } },
  { id: "resA", agent: "Researcher", input: { topic_query: "GDPR Art.28" } },
  { id: "resB", agent: "Researcher", input: { topic_query: "DPA template" } },
  { id: "resC", agent: "Researcher", input: { topic_query: "SCC 2021" } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("resA"), ref("resB"), ref("resC")] }, gate: { detect: 0.9 } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") } },
];

describe("Lab 3 · fit the plan to the contract", () => {
  test("the given plan costs 15,714 tokens at P = 0.893 and Gate 2 rejects it on tokens", () => {
    expect(LAB3_GIVEN.map((s) => nodeTokens(s, REGISTRY))).toEqual([900, 3600, 3600, 3600, 2600, 1414]);
    const v = gate2(LAB3_GIVEN, M);
    expect(v.tokens).toBe(15714);
    expect(v.P).toBeCloseTo(0.893, 3);
    expect(v.verdict).toBe("REJECT");
    expect(v.failing).toEqual(["G2.6 tokens <= budget"]);
    expect(v.flags.depth).toBe(3);
    expect(v.checks).toEqual({
      "G2.1 acyclic": true,
      "G2.2 references resolve": true,
      "G2.3 agents in roster": true,
      "G2.4 no orphan nodes": true,
      "G2.5 depth <= max_depth": true,
      "G2.6 tokens <= budget": false,
      "G2.7 projected P >= floor": true,
    });
  });

  test("fixed plan A: no redundancy, a gate on the Writer: 10,481 tokens, P = 0.806, PASS", () => {
    expect(LAB3_FIXED_A.map((s) => nodeTokens(s, REGISTRY))).toEqual([900, 1800, 1800, 1800, 3481, 700]);
    const v = gate2(LAB3_FIXED_A, M);
    expect(v.tokens).toBe(10481);
    expect(v.P).toBeCloseTo(0.806, 3);
    expect(v.verdict).toBe("PASS");
    expect(v.failing).toEqual([]);
    expect(v.E).toBeCloseTo(E(v.P), 12);
  });

  test("the gate's expected retry is truncated like Python's int()", () => {
    // 2600 * (1 - 0.93) is 181.99999999999986 in IEEE doubles: the labs count 181, not 182.
    expect(nodeTokens({ id: "w", agent: "Writer", input: {}, gate: { detect: 0.9 } }, REGISTRY)).toBe(2600 + 700 + 181);
  });

  test("Gate 2 fails the structural checks of Lab 1 by name", () => {
    const v = gate2(BROKEN_PLAN, M);
    expect(v.verdict).toBe("REJECT");
    expect(v.failing).toEqual(["G2.1 acyclic", "G2.2 references resolve", "G2.3 agents in roster", "G2.4 no orphan nodes", "G2.5 depth <= max_depth", "G2.7 projected P >= floor"]);
    expect(v.P).toBe(0);
    expect(v.E).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Lab 5 · the Foreman, the trace, the diff and the certificate
// ---------------------------------------------------------------------------------------------
type Line = readonly [source: string, relation: string, target: string, status: string];

const EDGES: Line[] = [
  ["Acme", "SUBCONTRACTS", "Globex", "in force"],
  ["Acme", "SUBCONTRACTS", "Initech", "in force"],
  ["Globex", "BOUND_BY", "DPA-17", "in force"],
  ["Globex", "HOSTS_IN", "US-East", "in force"],
  ["US-East", "REQUIRES", "SCC-22", "in force"],
  ["Initech", "HOSTS_IN", "US-East", "in force"],
];

const NEXT_MONTH: Line[] = [
  ["Acme", "SUBCONTRACTS", "Globex", "in force"],
  ["Acme", "SUBCONTRACTS", "Initech", "in force"],
  ["Globex", "BOUND_BY", "DPA-17", "in force"],
  ["Globex", "HOSTS_IN", "US-East", "in force"],
  ["US-East", "REQUIRES", "SCC-22", "in force"],
  ["Initech", "HOSTS_IN", "EU-West", "in force"],
];

const ANCHORS = ["Acme"]; // the entity Lab 4's question names

interface Fact { source: string; relation: string; node: string; hops: number; path: string[]; provenance: string }

/** Lab 4's walk from a named anchor: breadth-first, every path recorded, each node expanded once. */
function walk(anchor: string, edges: Line[], maxHops: number): Fact[] {
  const adj = new Map<string, [string, string][]>();
  for (const [s, r, d] of edges) adj.set(s, [...(adj.get(s) ?? []), [r, d]]);
  const facts: Fact[] = [];
  const seen = new Set([anchor]);
  let frontier: [string, string[]][] = [[anchor, [anchor]]];
  for (let hop = 0; hop < maxHops; hop++) {
    const nxt: [string, string[]][] = [];
    for (const [n, path] of frontier) {
      for (const [r, d] of adj.get(n) ?? []) {
        const p = [...path, `-${r}->`, d];
        facts.push({ source: n, relation: r, node: d, hops: hop + 1, path: p, provenance: p.join(" ") });
        if (!seen.has(d)) {
          seen.add(d);
          nxt.push([d, p]);
        }
      }
    }
    frontier = nxt;
  }
  return facts;
}

/** Lab 5's hop_facts: the Researcher's tool call. Hop 1 starts at the step's anchor; a Researcher that
 *  reads hop h walks hop h + 1 from the same anchor. Kept here on purpose: it is Lab 4's graph, not ours. */
function researcherTool(edges: Line[]) {
  const walked = new Map<string, [anchor: string, hop: number]>();
  return (step: Step) => {
    if ("anchor" in step.input) {
      walked.set(step.id, [String(step.input.anchor), 1]);
    } else {
      const before = [...refs(step.input)].sort().filter((p) => walked.has(p)).map((p) => walked.get(p)!);
      if (before.length === 0) return { retrieved: [] };
      walked.set(step.id, [before[0]![0], before[0]![1] + 1]);
    }
    const [anchor, hop] = walked.get(step.id)!;
    return { retrieved: walk(anchor, edges, hop).filter((f) => f.hops === hop).map((f) => f.provenance) };
  };
}

const stripArrows = (s: string) => s.replace(/^[->]+|[->]+$/g, "");

/** Every fact a run's Researchers retrieved, read back from their prompts (Lab 5's facts_of). */
function factsOf(trace: Trace): Fact[] {
  const facts: Fact[] = [];
  for (const t of trace) {
    const retrieved = (JSON.parse(t.assembled_prompt) as { retrieved?: string[] }).retrieved ?? [];
    for (const provenance of retrieved) {
      const p = provenance.split(" ");
      facts.push({ source: p[p.length - 3]!, relation: stripArrows(p[p.length - 2]!), node: p[p.length - 1]!, hops: Math.floor(p.length / 2), path: p, provenance });
    }
  }
  return facts;
}

/** Lab 4's path_is_real: starts at an anchor, every hop is a line of the graph, length matches, ends at the node. */
function pathIsReal(f: Fact, start: string[], edges: Line[]): boolean {
  const lines = new Set(edges.map(([s, r, d]) => `${s} ${r} ${d}`));
  const p = f.path;
  const hops: string[] = [];
  for (let i = 0; i + 2 < p.length; i += 2) hops.push(`${p[i]} ${stripArrows(p[i + 1]!)} ${p[i + 2]}`);
  return start.includes(p[0]!) && p[p.length - 1] === f.node && hops.length === f.hops && hops.every((h) => lines.has(h));
}

/** The certificate's Lab 4 check for this graph: a real path on every fact, within max_hops, and at least one fact. */
const provenanceOn = (edges: Line[]) => (run: Trace) => {
  const facts = factsOf(run);
  return facts.length > 0 && facts.every((x) => pathIsReal(x, ANCHORS, edges) && x.hops <= CONFIG.max_hops);
};

const LAB5_GIVEN: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "subcontractor data transfers" } },
  { id: "hop1", agent: "Researcher", input: { anchor: "Acme", filter: "in force" } },
  { id: "hop2", agent: "Researcher", input: { frontier: ref("hop1") } },
  { id: "hop3", agent: "Researcher", input: { frontier: ref("hop2") } },
  { id: "hop4", agent: "Researcher", input: { frontier: ref("hop3") } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("hop1"), ref("hop2"), ref("hop3"), ref("hop4")] }, gate: { detect: 0.9 } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") } },
];

// Fixed release A: hop4 deleted with its reference, and hop1's filter deleted.
const LAB5_FIXED_A: Plan = [
  { id: "lib", agent: "Librarian", input: { intent_query: "subcontractor data transfers" } },
  { id: "hop1", agent: "Researcher", input: { anchor: "Acme" } },
  { id: "hop2", agent: "Researcher", input: { frontier: ref("hop1") } },
  { id: "hop3", agent: "Researcher", input: { frontier: ref("hop2") } },
  { id: "write", agent: "Writer", input: { blueprint: ref("lib"), facts: [ref("hop1"), ref("hop2"), ref("hop3")] }, gate: { detect: 0.9 } },
  { id: "verify", agent: "Verifier", input: { draft: ref("write") } },
];

// This morning's certified run, verbatim from the Lab 5 notebook (key order differs from a fresh record on purpose).
const BASELINE_TRACE: Trace = [
  { node: "hop1", level: 0, agent: "Researcher", output: "Researcher·e723c3ea", tokens: 1800,
    assembled_prompt: '{"anchor": "Acme", "retrieved": ["Acme -SUBCONTRACTS-> Globex", "Acme -SUBCONTRACTS-> Initech"]}' },
  { node: "lib", level: 0, agent: "Librarian", output: "Librarian·7fafa77d", tokens: 900,
    assembled_prompt: '{"intent_query": "subcontractor data transfers"}' },
  { node: "hop2", level: 1, agent: "Researcher", output: "Researcher·13b80dc2", tokens: 1800,
    assembled_prompt: '{"frontier": "Researcher·e723c3ea", "retrieved": ["Acme -SUBCONTRACTS-> Globex -BOUND_BY-> DPA-17", "Acme -SUBCONTRACTS-> Globex -HOSTS_IN-> US-East", "Acme -SUBCONTRACTS-> Initech -HOSTS_IN-> US-East"]}' },
  { node: "hop3", level: 2, agent: "Researcher", output: "Researcher·f09d3a59", tokens: 1800,
    assembled_prompt: '{"frontier": "Researcher·13b80dc2", "retrieved": ["Acme -SUBCONTRACTS-> Globex -HOSTS_IN-> US-East -REQUIRES-> SCC-22"]}' },
  { node: "write", level: 3, agent: "Writer", output: "Writer·89e7dcf4", tokens: 2600, gate: "passed", gate_tokens: 700,
    assembled_prompt: '{"blueprint": "Librarian·7fafa77d", "facts": ["Researcher·e723c3ea", "Researcher·13b80dc2", "Researcher·f09d3a59"]}' },
  { node: "verify", level: 4, agent: "Verifier", output: "Verifier·ebba875a", tokens: 700,
    assembled_prompt: '{"draft": "Writer·89e7dcf4"}' },
];

describe("Lab 5 · certify the final release", () => {
  test("the model stand-in is a CRC32 of the UTF-8 prompt", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode("Writer·x"))).toBe(0x6747fb68);
    expect(stub("Librarian", '{"intent_query": "subcontractor data transfers"}')).toBe("Librarian·7fafa77d");
    expect(stub("Verifier", '{"draft": "Writer·89e7dcf4"}')).toBe("Verifier·ebba875a");
  });

  test("the given release is rejected: 12,281 tokens, P = 0.765, and the Foreman refuses to run it", () => {
    const v = gate2(LAB5_GIVEN, M);
    expect(v.verdict).toBe("REJECT");
    expect(v.tokens).toBe(12281);
    expect(v.P).toBeCloseTo(0.765, 3);
    expect(v.failing).toEqual(["G2.6 tokens <= budget", "G2.7 projected P >= floor"]);
    expect(v.flags.depth).toBe(6);
    expect(() => foreman(LAB5_GIVEN, M, { tools: { Researcher: researcherTool(EDGES) } })).toThrow(Gate2Error);
    expect(() => foreman(LAB5_GIVEN, M, { tools: { Researcher: researcherTool(EDGES) } })).toThrow("Gate 2 has not authorized this plan.");
  });

  test("the fixed release runs level by level and reproduces the baseline trace, fingerprint for fingerprint", () => {
    const v = gate2(LAB5_FIXED_A, M);
    expect(v.verdict).toBe("PASS");
    expect(v.tokens).toBe(10481);
    expect(v.P).toBeCloseTo(0.806, 3);

    const { trace, levels } = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) } });
    expect(levels).toEqual([["hop1", "lib"], ["hop2"], ["hop3"], ["write"], ["verify"]]);
    expect(trace.map((t) => t.output)).toEqual([
      "Researcher·e723c3ea", "Librarian·7fafa77d", "Researcher·13b80dc2", "Researcher·f09d3a59", "Writer·89e7dcf4", "Verifier·ebba875a",
    ]);
    expect(trace.map((t) => t.assembled_prompt)).toEqual(BASELINE_TRACE.map((t) => t.assembled_prompt));
    expect(trace.map((t) => t.level)).toEqual([0, 0, 1, 2, 3, 4]);
    expect(trace[4]).toMatchObject({ node: "write", gate: "passed", gate_tokens: 700, tokens: 2600 });
    expect(trace[5]).not.toHaveProperty("gate");
    // The record is written before the call: its first keys are what the Foreman knew then.
    expect(Object.keys(trace[0]!)).toEqual(["node", "level", "agent", "assembled_prompt", "output", "tokens"]);
    expect(Object.keys(trace[4]!)).toEqual(["node", "level", "agent", "assembled_prompt", "output", "tokens", "gate", "gate_tokens"]);
    expect(diffTraces(BASELINE_TRACE, trace)).toEqual([]);
    expect(runTokens(trace)).toBe(10300);
    expect(runTokens(trace)).toBeLessThanOrEqual(v.tokens);
  });

  test("the fixed release is certified 5 of 5 against the baseline; a replay changes nothing", () => {
    const run = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) } }).trace;
    const again = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) } }).trace;
    const card = certify(LAB5_FIXED_A, run, BASELINE_TRACE, M, provenanceOn(EDGES));
    expect(card.verdict).toBe("PASS");
    expect(Object.values(card.checks).filter(Boolean)).toHaveLength(5);
    expect(card.checks).toEqual({
      "Structural flags clean (Lab 1)": true,
      "P >= floor, E viable (Lab 2)": true,
      "Gate 2 verdict (Lab 3)": true,
      "Provenance on every fact (Lab 4)": true,
      "Trace diff vs baseline (Lab 5)": true,
    });
    expect(card.failing).toEqual([]);
    expect(diffTraces(run, again)).toEqual([]);
    expect(certify(LAB5_FIXED_A, again, run, M, provenanceOn(EDGES)).verdict).toBe("PASS");
  });

  test("the given release certifies 1 of 5 when it was never run", () => {
    const card = certify(LAB5_GIVEN, [], BASELINE_TRACE, M, provenanceOn(EDGES));
    expect(card.verdict).toBe("FAIL");
    expect(card.checks["Structural flags clean (Lab 1)"]).toBe(true);
    expect(card.failing).toEqual(["P >= floor, E viable (Lab 2)", "Gate 2 verdict (Lab 3)", "Provenance on every fact (Lab 4)", "Trace diff vs baseline (Lab 5)"]);
  });

  test("next month, Initech hosts in EU-West: the diff names hop2 and its downstream hop3, write, verify", () => {
    const run = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) } }).trace;
    const next = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(NEXT_MONTH) } }).trace;
    const moved = diffTraces(run, next);
    expect(moved).toEqual(["hop2", "hop3", "write", "verify"]);
    expect(downstream(LAB5_FIXED_A, "hop2")).toEqual(new Set(["hop3", "write", "verify"]));
    expect(new Set(moved)).toEqual(new Set(["hop2", ...downstream(LAB5_FIXED_A, "hop2")]));
    expect(next.map((t) => t.output)).toEqual([
      "Researcher·e723c3ea", "Librarian·7fafa77d", "Researcher·2cdc3a51", "Researcher·ea5a7ce2", "Writer·cf3a9fac", "Verifier·583dc65b",
    ]);
    const runBy = new Map(run.map((t) => [t.node, t]));
    expect(next.map((t) => whatChanged(runBy.get(t.node), t))).toEqual([
      "same", "same", "'retrieved' changed, output changed", "'frontier' changed, output changed", "'facts' changed, output changed", "'draft' changed, output changed",
    ]);
    const card = certify(LAB5_FIXED_A, next, run, M, provenanceOn(NEXT_MONTH));
    expect(card.verdict).toBe("FAIL");
    expect(card.failing).toEqual(["Trace diff vs baseline (Lab 5)"]);
  });

  test("whatChanged names new, gone and changed inputs and a missing or new node", () => {
    const b = BASELINE_TRACE[0]!;
    expect(whatChanged(undefined, b)).toBe("new node");
    expect(whatChanged(b, undefined)).toBe("missing from the run");
    expect(whatChanged(b, b)).toBe("same");
    expect(whatChanged(b, { ...b, assembled_prompt: '{"anchor": "Acme", "filter": "in force"}', output: "Researcher·00000000" })).toBe("'filter' is new, 'retrieved' is gone, output changed");
    expect(whatChanged(b, { ...b, level: 1, tokens: 1 })).toBe("level changed, tokens changed");
  });

  test("an injected drift on one node spreads to everything downstream of it", () => {
    const run = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) } }).trace;
    const drifted = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) }, inject: "lib" }).trace;
    expect(drifted[1]!.output).toBe("Librarian·7fafa77d [DRIFT]");
    const moved = diffTraces(run, drifted);
    expect(moved).toEqual(["lib", "write", "verify"]);
    expect(new Set(moved)).toEqual(new Set(["lib", ...downstream(LAB5_FIXED_A, "lib")]));
  });

  test("diffTraces lists the run's changed nodes in run order, then the baseline's missing nodes", () => {
    const run = foreman(LAB5_FIXED_A, M, { tools: { Researcher: researcherTool(EDGES) } }).trace;
    expect(diffTraces(BASELINE_TRACE, run.slice(0, 4))).toEqual(["write", "verify"]);
    expect(diffTraces(BASELINE_TRACE.slice(0, 4), run)).toEqual(["write", "verify"]);
  });

  test("the Foreman runs without tools: a plain plan assembles its prompts from the registry alone", () => {
    const { trace } = foreman(LAB2_FIXED_A, M); // Lab 1's fixed plan is clean but reads P = 0.798: Gate 2 refuses it
    expect(() => foreman(LAB1_FIXED_A, M)).toThrow(Gate2Error);
    expect(trace.map((t) => t.node)).toEqual(["lib", "resA", "resB", "write", "verify"]);
    expect(trace[0]!.assembled_prompt).toBe('{"intent_query": "compliance brief structure"}');
    expect(trace[3]!.assembled_prompt).toBe(`{"blueprint": "${trace[0]!.output}", "facts": ["${trace[1]!.output}", "${trace[2]!.output}"]}`);
    expect(trace.every((t) => !t.assembled_prompt.includes("$$"))).toBe(true);
  });
});
