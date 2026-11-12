import { open } from "node:fs/promises";
import type { Certificate, CertificateCheck, EngineRunOutcome, EngineTraceEvent, EnginePlan, HandlerName, ReplayCapture, ReviewEnvelope, RunLimits, TraceSink } from "./contracts";
import { canonical, sha256 } from "../chain/evidence";
import { EngineError } from "./errors";
import { executePlan } from "./execute";
import { BLUEPRINTS } from "./blueprints";
import { createRegistry, SHIPPED_REGISTRY_SHA256 } from "./registry";
import { RENDERER_VERSION, validateReview } from "./render";
import { isInsideRepository, memoryTraceSink } from "./trace";
import type { EvidenceStore } from "./queries/snapshot";

export function captureRun(outcome: EngineRunOutcome): ReplayCapture {
  if (outcome.status !== "succeeded") throw new EngineError("capture-not-succeeded");
  const e = outcome.envelope;
  const entries = new Map(e.results.map(r => [r.nodeId, { nodeId: r.nodeId, inputSha256: sha256(canonical(r.request)), resultSha256: r.resultSha256, result: structuredClone(r.result) }]));
  return { version: 1, planSha256: e.planSha256, registrySha256: e.registrySha256, blueprintSha256: e.blueprintSha256,
    rendererVersion: RENDERER_VERSION, handlerVersions: Object.fromEntries(createRegistry().contracts.map(c => [c.name, c.version])) as Record<HandlerName, string>,
    entries: [...entries.values()].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0) };
}
export async function writeCapture(capture: ReplayCapture, path: string): Promise<void> {
  try { if (isInsideRepository(path)) throw new EngineError("capture-path"); }
  catch { throw new EngineError("capture-path"); }
  let handle;
  try {
    const content = canonical(capture);
    handle = await open(path, "w", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content);
    await handle.sync();
  } catch { throw new EngineError("capture-write"); }
  finally { if (handle) await handle.close().catch(() => {}); }
}
export interface ReplayOptions { trace?: TraceSink; signal?: AbortSignal; blueprintId?: string; blueprintRoot?: string }
export function replayRun(plan: EnginePlan | unknown, capture: ReplayCapture, limits: RunLimits, options: ReplayOptions = {}): Promise<EngineRunOutcome> {
  // A bad header still reaches the replay check, rather than masquerading as an unknown blueprint.
  const blueprintId = options.blueprintId ?? Object.keys(BLUEPRINTS).find(id => BLUEPRINTS[id as keyof typeof BLUEPRINTS].sha256 === capture?.blueprintSha256) ?? "position-review-v1";
  const unavailable = (): never => { throw new EngineError("replay-store"); };
  const store: EvidenceStore = { snapshot: unavailable, receipt: unavailable, factsFrom: unavailable, snapshotsForReceipt: unavailable };
  return executePlan({ plan, limits, blueprintId, blueprintRoot: options.blueprintRoot, store, trace: options.trace ?? memoryTraceSink() }, options.signal, capture);
}
export type BaselineComparison = { status: "match" } | { status: "review-needed"; paths: string[] };
export function compareToBaseline(envelope: ReviewEnvelope, baseline: ReviewEnvelope): BaselineComparison {
  const withoutRun = ({ runId: _runId, ...rest }: ReviewEnvelope) => JSON.parse(canonical(rest));
  const paths: string[] = [];
  function compare(a: unknown, b: unknown, path: string) {
    if (canonical(a) === canonical(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length || i >= b.length) paths.push(`${path}[${i}]`);
        else compare(a[i], b[i], `${path}[${i}]`);
      }
    } else if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(aa), ...Object.keys(bb)])].sort()) {
        if (!Object.hasOwn(aa, key) || !Object.hasOwn(bb, key)) paths.push(`${path}.${key}`);
        else compare(aa[key], bb[key], `${path}.${key}`);
      }
    } else paths.push(path);
  }
  compare(withoutRun(envelope), withoutRun(baseline), "$");
  return paths.length ? { status: "review-needed", paths: paths.sort() } : { status: "match" };
}
export const REQUIRED_CHECKS = Object.freeze(["plan-valid", "trace-complete", "citations-valid", "offline-registry"]);
export function isCertified(cert: Certificate): boolean {
  return REQUIRED_CHECKS.every(name => cert.checks.some(c => c.name === name && c.required && c.passed))
    && cert.checks.every(c => !c.required || c.passed);
}
function traceDetail(outcome: EngineRunOutcome, events: EngineTraceEvent[]): string {
  if (!events.length) return "last-event";
  if (events.some((e, i) => e.sequence !== i + 1)) return "sequence-gap";
  let pending: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.phase === "prepared") {
      if (pending !== null || !e.nodeId || seen.has(e.nodeId)) return "unpaired-prepared";
      seen.add(e.nodeId); pending = e.nodeId;
    } else if (["succeeded", "failed", "cancelled"].includes(e.phase)) {
      if (pending === null || pending !== e.nodeId) return "unpaired-prepared";
      pending = null;
    } else if (e.phase === "run-succeeded" || e.phase === "run-failed") {
      if (pending !== null) return "unpaired-prepared";
      if (i !== events.length - 1 || e.nodeId !== "") return "last-event";
    } else return "last-event";
  }
  if (pending !== null) return "unpaired-prepared";
  const last = events.at(-1)!;
  if (last.phase !== (outcome.status === "succeeded" ? "run-succeeded" : "run-failed")) return "last-event";
  return "ok";
}
export function certify(outcome: EngineRunOutcome, trace: EngineTraceEvent[], options: { replay?: BaselineComparison } = {}): Certificate {
  const events = trace.filter(e => e.runId === outcome.runId);
  const checks: CertificateCheck[] = [];
  const add = (name: string, detail: string, required = true) => checks.push({ name, required, passed: detail === "ok", detail });
  add("plan-valid", outcome.status === "rejected" ? "rejected" : "ok");
  add("trace-complete", traceDetail(outcome, events));
  if (outcome.status === "succeeded") {
    const valid = validateReview(outcome.envelope);
    add("citations-valid", valid.ok ? "ok" : valid.code);
  } else add("citations-valid", "no-envelope");
  const hashes = outcome.status === "succeeded" ? [outcome.envelope.registrySha256] : events.map(e => e.registrySha256);
  add("offline-registry", !hashes.length ? "no-registry" : hashes.every(h => h === SHIPPED_REGISTRY_SHA256) ? "ok" : "registry-differs");
  if (options.replay) add("replay-match", options.replay.status === "match" ? "ok" : "review-needed", false);
  const certificate = { checks, passed: false };
  certificate.passed = isCertified(certificate);
  return certificate;
}
