/**
 * The cache key of an answer and the private trace. A trace line holds what was asked and how the answer was
 * composed: tool names, template ids, row counts, rule codes, token counts. It never holds a header, a key or a
 * receipt body, and its file must lie outside the repository.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { canonical, sha256 } from "../chain/evidence";

/** The question as it is keyed and logged: trimmed, runs of whitespace made one space, lower-cased. */
export function normaliseQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface CacheKeyFields {
  question: string;
  protocol: string;
  snapshotIds: string[];
  backend: { id: string; version: string; templatesSha256: string };
  catalogId: string;
  promptSha256: string;
  modelId: string;
}

/** The sha256 of the canonical object of the seven fields, with the question normalised. Changing one field changes the key. */
export function cacheKey(fields: CacheKeyFields): string {
  return sha256(canonical({
    question: normaliseQuestion(fields.question), protocol: fields.protocol, snapshotIds: fields.snapshotIds,
    backend: { id: fields.backend.id, version: fields.backend.version, templatesSha256: fields.backend.templatesSha256 },
    catalogId: fields.catalogId, promptSha256: fields.promptSha256, modelId: fields.modelId,
  }));
}

export interface TraceLine {
  answerId: string;
  cacheKey: string;
  question: string;
  protocol: string;
  tools: string[];
  templateIds: string[];
  results: { id: string; rows: number }[];
  codes: string[];
  modelId: string | null;
  modelCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

/** The path with every link on its existing part followed, so a link into the repository is seen as inside it. */
function real(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(relative(parent, existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

function inside(root: string, path: string): boolean {
  const between = relative(root, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

/** Whether a path lies inside the repository this module is part of. */
export function insideRepository(path: string): boolean {
  const target = resolve(path);
  return inside(REPOSITORY_ROOT, target) || inside(real(REPOSITORY_ROOT), real(target));
}

/** Appends one line to the trace. The line holds exactly the fields of `TraceLine`. */
export function appendTrace(logPath: string, line: TraceLine): void {
  const ordered: TraceLine = {
    answerId: line.answerId, cacheKey: line.cacheKey, question: line.question, protocol: line.protocol, tools: line.tools,
    templateIds: line.templateIds, results: line.results, codes: line.codes, modelId: line.modelId, modelCalls: line.modelCalls,
    inputTokens: line.inputTokens, outputTokens: line.outputTokens, latencyMs: line.latencyMs,
  };
  // The trace holds the questions people asked: readable by its owner only, whatever the umask.
  mkdirSync(dirname(resolve(logPath)), { recursive: true, mode: 0o700 });
  appendFileSync(resolve(logPath), `${JSON.stringify(ordered)}\n`, { mode: 0o600 });
  chmodSync(resolve(logPath), 0o600);
}
