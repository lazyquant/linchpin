import { SUBJECT_PATTERN } from "../../engine/queries/request";
import { VOCABULARY } from "../../engine/queries/vocabulary";
import { CORE_TYPES, NOT_PROJECTED, SchemaRejected, checkVocabulary } from "../evidence/schema";
import { TERMS, type PredicateTerm, type Term } from "./terms";

/**
 * Eight mechanical rules over the vocabulary, the registry and the public snapshots.
 * The linter reports; it repairs nothing. Pure: no I/O, no clock, the input is not mutated.
 */
export type RuleId = "VL1" | "VL2" | "VL3" | "VL4" | "VL5" | "VL6" | "VL7" | "VL8";
export interface LintFact { id: string; predicate: string; object: string; privacy: "public" | "private" }
export interface LintSnapshot { id: string; facts: readonly LintFact[] }
export interface LintInput {
  vocabulary: Record<string, { class: string }>;
  coreTypes: Record<string, { class: string; mappedFrom: readonly { predicate: string }[] }>;
  notProjected: readonly string[];
  terms: readonly Term[];
  /** Already restricted to the snapshots the rules read (the captured, not the constructed, ones). */
  snapshots: readonly LintSnapshot[];
}
export interface Finding {
  id: string; rule: RuleId; terms: string[]; severity: "blocking" | "notice";
  evidence: Record<string, unknown>; status: "open" | "waived";
}

const RELATION_CLASSES = new Set(["control", "dependency", "backing", "origin"]);
const STOP_WORDS = new Set(["by", "from", "to", "of", "in"]);
const FILLER_WORDS = new Set(["a", "an", "the", "of", "is", "for", "to", "by", "in"]);
const MIN_DEFINITION_LENGTH = 20;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Split on `_`, `-`, space and a lower-to-upper camel boundary; lowercase; drop empties. */
export function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\-\s]+/).map(w => w.toLowerCase()).filter(w => w.length > 0);
}
/** Lowercase with every `_`, `-` and space removed. */
export function norm(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, "");
}

export function defaultLintInput(snapshots: readonly LintSnapshot[]): LintInput {
  return { vocabulary: VOCABULARY, coreTypes: CORE_TYPES, notProjected: NOT_PROJECTED, terms: TERMS, snapshots };
}

function finding(rule: RuleId, terms: string[], severity: Finding["severity"], evidence: Record<string, unknown>): Finding {
  const sorted = [...terms].sort(compare);
  return { id: `${rule}:${sorted.join("+")}`, rule, terms: sorted, severity, evidence, status: "open" };
}

const termLabel = (term: Term): string => (term.type === "predicate" ? term.name : `${term.type}/${term.name}`);

// VL1: the evidence schema's own coverage check, reported instead of thrown.
function vl1(input: LintInput): Finding[] {
  const out: Finding[] = [];
  const copy: Record<string, { class: string }> = { ...input.vocabulary };
  const seen = new Set<string>();
  for (let round = 0; round <= Object.keys(input.vocabulary).length + 1; round++) {
    try { checkVocabulary(copy); break; } catch (error) {
      if (!(error instanceof SchemaRejected)) throw error;
      const detail = error.message.replace(/^Schema rejected: /, "");
      const colon = detail.indexOf(":");
      const predicate = colon < 0 ? detail : detail.slice(0, colon);
      if (seen.has(predicate)) break;
      seen.add(predicate);
      out.push(finding("VL1", [predicate], "blocking", { message: error.message }));
      if (!Object.hasOwn(copy, predicate)) break;
      delete copy[predicate];
    }
  }
  return out;
}

// VL2: a relation-class predicate that only ever points at values, never at an identity.
function vl2(input: LintInput): Finding[] {
  const facts: { snapshotId: string; fact: LintFact }[] = [];
  for (const snapshot of input.snapshots) for (const fact of snapshot.facts) if (fact.privacy === "public") facts.push({ snapshotId: snapshot.id, fact });
  const out: Finding[] = [];
  for (const [predicate, entry] of Object.entries(input.vocabulary)) {
    if (!RELATION_CLASSES.has(entry.class)) continue;
    const own = facts.filter(({ fact }) => fact.predicate === predicate);
    if (!own.length) continue;
    let identities = 0, values = 0, none = 0, unknown = 0;
    for (const { fact } of own) {
      if (fact.object === "none") none++;
      else if (fact.object === "unknown") unknown++;
      else if (SUBJECT_PATTERN.test(fact.object)) identities++;
      else values++;
    }
    if (identities > 0 || values === 0) continue;
    const examples = own.map(({ snapshotId, fact }) => ({ snapshotId, factId: fact.id }))
      .sort((a, b) => compare(`${a.snapshotId}\0${a.factId}`, `${b.snapshotId}\0${b.factId}`)).slice(0, 3);
    out.push(finding("VL2", [predicate], "blocking", {
      factsExamined: facts.length, predicateFacts: own.length, identityObjects: 0, objects: { value: values, none, unknown }, examples,
    }));
  }
  return out;
}

// VL3: the same last word under different classes.
function vl3(input: LintInput): Finding[] {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(input.vocabulary)) {
    const key = words(name).at(-1);
    if (key === undefined || STOP_WORDS.has(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const out: Finding[] = [];
  for (const [keyWord, members] of groups) {
    if (members.length < 2) continue;
    if (new Set(members.map(m => input.vocabulary[m]!.class)).size < 2) continue;
    out.push(finding("VL3", members, "blocking", {
      keyWord, classes: Object.fromEntries([...members].sort(compare).map(m => [m, input.vocabulary[m]!.class])),
    }));
  }
  return out;
}

// VL4: names equal after normalising that map to different core types, or of which one is unmapped.
function vl4(input: LintInput): Finding[] {
  const mappedTo = new Map<string, string>();
  for (const [type, contract] of Object.entries(input.coreTypes)) for (const m of contract.mappedFrom) if (!mappedTo.has(m.predicate)) mappedTo.set(m.predicate, type);
  const notProjected = new Set(input.notProjected);
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(input.vocabulary)) groups.set(norm(name), [...(groups.get(norm(name)) ?? []), name]);
  const out: Finding[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const mapping = Object.fromEntries([...members].sort(compare).map(m => [m, notProjected.has(m) ? "unmapped" : mappedTo.get(m) ?? "unmapped"]));
    const values = Object.values(mapping);
    if (values.includes("unmapped") || new Set(values).size > 1) out.push(finding("VL4", members, "blocking", { mappedTo: mapping }));
  }
  return out;
}

// VL5: a kind that is established only by its relation to another entity.
function vl5(input: LintInput): Finding[] {
  return input.terms.filter(t => t.type === "kind" && t.establishedBy === "relation-to-other")
    .map(t => finding("VL5", [t.name], "blocking", { establishedBy: "relation-to-other" }));
}

// VL6: a core type whose mapped predicates mix a current state with a proposed effect or a designed route.
function vl6(input: LintInput): Finding[] {
  const predicates = new Map<string, PredicateTerm>();
  for (const t of input.terms) if (t.type === "predicate") predicates.set(t.name, t);
  const out: Finding[] = [];
  for (const [type, contract] of Object.entries(input.coreTypes)) {
    const asserts: Record<string, string> = {};
    for (const m of contract.mappedFrom) { const term = predicates.get(m.predicate); if (term) asserts[m.predicate] = term.asserts; }
    if (new Set(Object.values(asserts)).size > 1) out.push(finding("VL6", [type], "blocking", { asserts }));
  }
  return out;
}

// VL7: a missing, very short or name-repeating definition. Never one finding per draft entry.
function vl7(input: LintInput): Finding[] {
  const out: Finding[] = [];
  for (const term of input.terms) {
    const text = term.definition.trim();
    const own = new Set([...words(term.name), ...FILLER_WORDS]);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const problem = text.length === 0 ? "missing" : tokens.every(t => own.has(t)) ? "repeats-name" : text.length < MIN_DEFINITION_LENGTH ? "short" : null;
    if (!problem) continue;
    const severity = problem === "missing" || term.status === "reviewed" ? "blocking" : "notice";
    out.push(finding("VL7", [termLabel(term)], severity, { problem, status: term.status }));
  }
  return out;
}

// VL8: a predicate that no public fact in any examined snapshot uses.
function vl8(input: LintInput): Finding[] {
  const used = new Set<string>();
  let examined = 0;
  for (const snapshot of input.snapshots) for (const fact of snapshot.facts) if (fact.privacy === "public") { used.add(fact.predicate); examined++; }
  return Object.keys(input.vocabulary).filter(p => !used.has(p))
    .map(p => finding("VL8", [p], "notice", { factsExamined: examined, predicateFacts: 0, snapshots: input.snapshots.length }));
}

export function lint(input: LintInput): Finding[] {
  const all = [...vl1(input), ...vl2(input), ...vl3(input), ...vl4(input), ...vl5(input), ...vl6(input), ...vl7(input), ...vl8(input)];
  return all.sort((a, b) => compare(a.id, b.id));
}
