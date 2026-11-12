import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectSlice1Inputs } from "../evidence/protocols";
import { defaultLintInput, lint, type Finding, type LintInput, type LintSnapshot } from "./lint";
import {
  QUESTIONS, createQuestionRuntime, evaluateQuestions, type CaseResult, type Question, type QuestionRuntime,
} from "./questions";
import type { TermRef } from "./terms";

/** The conformance report: questions, findings, waivers and a verdict, as deterministic JSON. */
export interface Waiver { findingId: string; reason: string; decision: string; by?: string; date?: string }
export class WaiversRejected extends Error {
  constructor(detail: string) { super(`Waivers rejected: ${detail}`); this.name = "WaiversRejected"; }
}
export interface ReportInputs { lint: LintInput; questions: readonly Question[]; runtime: QuestionRuntime; waivers: readonly Waiver[] }
export interface Report {
  reportVersion: 1;
  vocabularySha256: string;
  schemaSha256: string;
  snapshots: { id: string; constructed: boolean; facts: number; lint: boolean }[];
  questions: { id: string; yes: CaseResult; no: CaseResult }[];
  findings: Finding[];
  waivers: { applied: Waiver[]; stale: Waiver[]; unanswered: Waiver[] };
  definitions: { total: number; draft: number; reviewed: number };
  termsUsedByNoQuestion: TermRef[];
  verdict: "conformant" | "not-conformant";
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Recursively key-sorted copy, so equal data always prints to equal bytes. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");

export function parseWaivers(text: string): Waiver[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new WaiversRejected("not valid JSON"); }
  if (!Array.isArray(parsed)) throw new WaiversRejected("the top level must be a list");
  return parsed.map((entry, index): Waiver => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new WaiversRejected(`entry ${index} is not an object`);
    const record = entry as Record<string, unknown>;
    if (typeof record.findingId !== "string") throw new WaiversRejected(`entry ${index}: findingId must be a string`);
    for (const field of ["reason", "decision", "by", "date"]) {
      if (record[field] !== undefined && typeof record[field] !== "string") throw new WaiversRejected(`entry ${index}: ${field} must be a string`);
    }
    return {
      findingId: record.findingId, reason: (record.reason as string | undefined) ?? "", decision: (record.decision as string | undefined) ?? "",
      ...(typeof record.by === "string" ? { by: record.by } : {}), ...(typeof record.date === "string" ? { date: record.date } : {}),
    };
  });
}

const numberOf = (id: string): number => Number(id.replace(/\D+/g, ""));
const refKey = (ref: TermRef): string => `${ref.type}\0${ref.name}`;
const byTerm = (a: TermRef, b: TermRef): number => compare(a.type, b.type) || compare(a.name, b.name);
const byWaiver = (a: Waiver, b: Waiver): number => compare(a.findingId, b.findingId) || compare(a.reason, b.reason) || compare(a.decision, b.decision);

export function buildReport(inputs: ReportInputs): Report {
  const findings = lint(inputs.lint);
  const byId = new Map(findings.map(f => [f.id, f]));
  const applied: Waiver[] = [], stale: Waiver[] = [], unanswered: Waiver[] = [];
  for (const waiver of inputs.waivers) {
    const target = byId.get(waiver.findingId);
    if (!target) stale.push(waiver);
    else if (waiver.reason.trim() && waiver.decision.trim()) { target.status = "waived"; applied.push(waiver); }
    else unanswered.push(waiver);
  }
  const lintSnapshotIds = new Set(inputs.lint.snapshots.map(s => s.id));
  const questions = evaluateQuestions(inputs.questions, inputs.runtime)
    .sort((a, b) => numberOf(a.id) - numberOf(b.id) || compare(a.id, b.id));
  const used = new Set(inputs.questions.flatMap(q => q.terms.map(refKey)));
  const terms = inputs.lint.terms;
  const anyCaseFails = questions.some(q => q.yes.status === "fail" || q.no.status === "fail");
  const blockingOpen = findings.some(f => f.severity === "blocking" && f.status === "open");
  return {
    reportVersion: 1,
    vocabularySha256: sha256(inputs.lint.vocabulary),
    schemaSha256: sha256({ coreTypes: inputs.lint.coreTypes, notProjected: [...inputs.lint.notProjected].sort(compare) }),
    snapshots: inputs.runtime.snapshots().map(s => ({ id: s.id, constructed: s.constructed, facts: s.facts, lint: lintSnapshotIds.has(s.id) })),
    questions,
    findings,
    waivers: { applied: applied.sort(byWaiver), stale: stale.sort(byWaiver), unanswered: unanswered.sort(byWaiver) },
    definitions: {
      total: terms.length,
      draft: terms.filter(t => t.status === "draft").length,
      reviewed: terms.filter(t => t.status === "reviewed").length,
    },
    termsUsedByNoQuestion: terms.filter(t => !used.has(refKey(t))).map(t => ({ type: t.type, name: t.name })).sort(byTerm),
    verdict: anyCaseFails || blockingOpen ? "not-conformant" : "conformant",
  };
}

/** Key-sorted JSON, two-space indent, one trailing newline. */
export function renderReport(report: Report): string {
  return `${JSON.stringify(sortKeys(report), null, 2)}\n`;
}
export function exitCodeOf(report: Report): 0 | 1 {
  return report.verdict === "conformant" ? 0 : 1;
}

/** The real sources, the twelve questions and the committed snapshots of the first slice. */
export function loadDefaultInputs(root: string = join(import.meta.dir, "..", "..", "..")): Omit<ReportInputs, "waivers"> {
  const evidence = collectSlice1Inputs(root);
  const lintSnapshots: LintSnapshot[] = evidence.filter(i => !i.snapshot.constructed).map(i => ({
    id: i.snapshot.id,
    facts: i.snapshot.facts.map(f => ({ id: f.id, predicate: f.predicate, object: f.object, privacy: f.privacy })),
  }));
  return { lint: defaultLintInput(lintSnapshots), questions: QUESTIONS, runtime: createQuestionRuntime(evidence) };
}
