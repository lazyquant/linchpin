# Plan validation and certification harness

`src/harness/` is a deterministic module that validates an agent's plan before anything runs, meters its reliability and cost, runs it level by level with a trace record written **before** every call, and certifies a run against a stored baseline. It calls no model, no RPC and no network. It is a port of the harness mechanics in the "run it, do not edit it" cells of Denis Rothman's *Graph Engineering for AI Agents* labs (Python, standard library), with the labs' fixtures as its tests (`tests/harness.test.ts`). It changes nothing else in Linchpin; it is the shape intended for the bounded tool-using agent and for change detection on the agent side of the evidence graph.

## The pieces

| File | Lab | What it holds |
| --- | --- | --- |
| `plan.ts` | 1 | A plan is a list of steps `{ id, agent, input, redundancy?, gate? }`. A `$$id$$` token anywhere inside an input (`ref("id")`) means "the output of step `id`" and is a wait-for edge. `buildGraph` → nodes and producer→consumer edges; `topoLevels` → Kahn's levels (each level sorted) and whether the graph is acyclic; `structuralFlags` → acyclic, dangling references, agents outside the registry, orphans (outputs nobody reads except the terminal step), depth and levels; `findCycle` names one cycle; `defects` lists the flags in words. |
| `meter.ts` | 2, 3 | `nodeRho`, `P`, `E`, `regime` (reliability) and `nodeTokens` (cost); the formulas are below. |
| `gate2.ts` | 3 | `gate2`: the seven checks and one verdict; `seal`: the fingerprint of the contract. |
| `foreman.ts` | 5 | `foreman` runs only an authorised plan; `diffTraces`, `whatChanged`, `downstream`, `runTokens`; `certify`: the five-check certificate. |
| `materials.ts` | — | The typed loader for `registry.json` (agent → ρ, tokens per call) and `config.json` (the contract's bindings), `registerTool` and the parsers. |
| `pyjson.ts` | — | `pyDumps`: Python's `json.dumps` reproduced, so that seals and fingerprints match the labs byte for byte. |

The registry is a closed world: an agent that is not in it is unknown, which Gate 2 treats as unverifiable (ρ = 0), not as bad. Lab 4's knowledge-graph walk is **not** ported: Linchpin has its own evidence graph, with a basis and evidence ids on every edge. The few lines of that walk that Lab 5's trace fixture needs live in the test file only.

## The formulas

Every step has a reliability ρ (the probability that it is right) and a token cost, both read from the registry.

- **Plan reliability:** P = ρ₁ · ρ₂ · … · ρₙ over every step, orphans included. The plan is right only if every step is right.
- **Budget:** E = 1 + ln P. Regimes: `VIABLE` when E > 1 + ln `coin_toss` (P > 0.5 with the shipped config); `BELOW COIN TOSS (still paying)` when E > 0; `NEGATIVE ROI` when E > −1; `COMPLETE FAILURE` below that.
- **Redundancy** `"redundancy": k` (k agents do the step, a selector keeps a good answer): ρ′ = 1 − (1 − ρ)ᵏ; tokens × k. It assumes independent failures: the same faulty source gives the same error twice.
- **Gate** `"gate": { "detect": d }` (a Verifier checks the step and asks for one retry when it catches an error): ρ′ = ρ + (1 − ρ) · d · ρ; tokens + the Verifier's tokens + ⌊tokens · (1 − ρ)⌋ for the expected retry. The gate agent is `GATE_AGENT` (`"Verifier"`) and must be in the registry.
- **Gate 2**, seven checks, held to `config.json`: G2.1 acyclic; G2.2 references resolve; G2.3 agents in roster; G2.4 no orphan nodes; G2.5 depth ≤ `max_depth`; G2.6 projected tokens ≤ `token_budget`; G2.7 projected P ≥ `p_floor`. The verdict is the conjunction, never a mean; a `REJECT` names the failing checks.
- **Seal:** the first 16 hex characters of SHA-256 over `[registry, config]` serialised as Python's `json.dumps(…, sort_keys=True)`. Any change to any value in either file changes it. The shipped materials seal to `f00cf0f8019a3afb`, the labs' `SEAL`.

Put a repair where errors are most frequent (the Writer at 0.93, not the Verifier at 0.98) and judge it by what it buys per token. With the shipped values a gate on the Writer buys more P per 1,000 tokens than a backup on a Researcher.

## The Foreman and the trace

`foreman(plan, materials, options)` throws `Gate2Error` unless `gate2` says `PASS`: nothing authorises itself. It then runs the plan one level at a time; a step starts only when every step it reads has finished. For every node it writes one record before the call, `{ node, level, agent, assembled_prompt }`, where the assembled prompt is the step's input serialised with `pyDumps` and every `$$id$$` replaced by the producer's output; then, after the call, `output` and `tokens`, and for a gated step `gate: "passed"` and `gate_tokens`. Resolved input before output is what makes silent failures visible: an empty retrieval, a default template, a summary that dropped a clause.

Two hooks keep the module free of any domain:

- `options.tools`, keyed by agent name: `(step, { level, state }) => extra input entries` appended to the step's input before assembly. This is where a deterministic reader puts its result into the prompt (the labs' Researcher adds `retrieved`; Linchpin's readers would add query results with their evidence ids).
- `options.model`: `(agent, prompt) => output`. The default is `stub`, a CRC-32 fingerprint of the UTF-8 prompt, `Agent·xxxxxxxx`. The same prompt always gives the same output, so any change in what a node reads changes its output and ripples into every prompt downstream. `options.inject` names a node whose output gets ` [DRIFT]` appended, to rehearse a model or prompt change.

Reading a run: `diffTraces(base, run)` lists every node whose record differs from the baseline (structurally, key order ignored) or that is in only one of the two, the run's nodes in run order, then the baseline's nodes the run is missing; `whatChanged(b, t)` says in a few words which inputs are new, gone or changed and whether level, output, tokens or gate changed; `downstream(plan, node)` is everything reachable from a node; `runTokens(trace)` is what the run spent, gate checks included.

## The certificate

`certify(plan, run, baseline, materials, provenance)` returns five checks, one per lab, and a verdict that is `PASS` only if all five pass:

1. **Structural flags clean (Lab 1):** acyclic, no dangling reference, no unknown agent, no orphan.
2. **P ≥ floor, E viable (Lab 2):** P ≥ `p_floor` and the regime is `VIABLE`.
3. **Gate 2 verdict (Lab 3):** `PASS`.
4. **Provenance on every fact (Lab 4):** the `provenance` predicate over the run's trace. It is a parameter because the labs' facts carry a path through a toy graph while Linchpin's facts carry evidence ids and a basis; the test file shows the labs' version (a real path on every retrieved fact, within `max_hops`, and at least one fact).
5. **Trace diff vs baseline (Lab 5):** the run is non-empty and `diffTraces(baseline, run)` is empty.

A good change ships by being certified: run it, read the diff, approve it, store the new baseline. In Lab 5's fixture, one updated line in next month's knowledge graph (Initech hosts in EU-West) changes the record of `hop2` and of everything downstream of it (`hop3`, `write`, `verify`): drift is not slow.

## Registering a tool with a measured ρ

`registry.json` is the roster. To add one of Linchpin's own tools, give it a name, a reliability measured on a gold set (the share of answers that were right), and its tokens per call (0 for a deterministic reader that calls no model):

```ts
import { labMaterials, registerTool, gate2 } from "./src/harness";

const { registry, config } = labMaterials();
const ours = registerTool(registry, "DependenciesQuery", { rho: 0.998, tokens: 0 });
const verdict = gate2(plan, { registry: ours, config });
```

`registerTool` returns a new registry and refuses a name that is already registered. `loadMaterials(registryPath, configPath)` reads a registry and a contract from disk through the same parsers (`rho` in [0, 1], `tokens` a non-negative integer, the five config bindings finite numbers and no other key, so that the seal sees every binding). Re-seal after any change: the seal is the contract's identity, and a baseline certified under one seal says nothing about another.

## Parity with the labs, and known deviations

The labs' fingerprints depend on Python's default `json.dumps` formatting. `pyDumps` reproduces it: `", "` and `": "` separators, keys in insertion order (or sorted with `sortKeys`), `ensure_ascii` escaping (`\uXXXX`, lowercase, for anything outside `0x20–0x7E`, including `U+007F`), no escaping of `/`, Python's float `repr` (`0.1`, `1e-05`, `1e+16`). The tests pin the labs' seal and all six fingerprints of the certified release (`Researcher·e723c3ea`, `Librarian·7fafa77d`, `Researcher·13b80dc2`, `Researcher·f09d3a59`, `Writer·89e7dcf4`, `Verifier·ebba875a`), so the serialisation is verified, not assumed.

- The gate's expected retry uses Python's `int()` truncation on the same IEEE double expression, `tokens · (1 − ρ)`. For the Writer that is 2,600 · 0.06999999999999995 = 181.99999999999986 → 181, which is why the labs count 10,481 tokens and not 10,482.
- JavaScript has no int/float distinction: a registry value written as `1.0` serialises as `1`, where Python would write `1.0`. Write integers without a decimal point and the seals agree.
- `\w` in the reference token is ASCII in JavaScript and Unicode in Python; step ids are ASCII identifiers.
- Outputs are substituted into the assembled prompt textually, as the labs do; an output containing a quote would need escaping before `whatChanged` can parse the prompt. The stub's outputs never contain one.

## 2026-11-05 clarification: lab semantics versus the product executor

The trace described above is assembled **in memory** before calling the synchronous model callback, then appended only after the call returns. It is not durable write-ahead logging; a throwing callback does not return its prepared trace. Token totals come from the lab registry, and the `gate: passed` label models the lab gate rather than invoking a live verifier. These remain useful parity mechanics, not evidence of actual model usage or approval.

A separate asynchronous product executor with durable pre-dispatch events, timeouts, cancellation, actual usage, typed references and private trace storage is specified and not yet implemented. The current lab API and fixtures are preserved.
