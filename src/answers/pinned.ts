/**
 * Prepared answers: every reference question answered by its fixed script over the recorded evidence. Each one
 * says that a script composed it. They are what an offline page can show without a model.
 */
import { PINNED_LABEL } from "./compose";
import { GOLDEN } from "./golden";
import { ScriptedModel, answerQuestion, type PlannerModel } from "./planner";
import type { RetrievalBackend } from "./retrieval";

export { GOLDEN } from "./golden";
export type { GoldenEntry } from "./golden";

export type PinnedDocument = {
  label: string;
  protocols: { id: string; title: string }[];
  answers: { id: string; question: string; protocol: string; label: string; ndjson: string }[];
};

const collapse = (text: string): string => text.trim().replace(/\s+/g, " ");

/** A fresh scripted model for a question that is exactly a reference question of that protocol; `null` for any other. */
export function goldenModel(ask: { question: string; protocol: string }): PlannerModel | null {
  const entry = GOLDEN.find((candidate) => candidate.protocol === ask.protocol && candidate.question === collapse(ask.question));
  return entry ? new ScriptedModel(entry.script) : null;
}

/** The prepared answers of every reference question whose protocol the backend serves, in the order of the list. */
export async function pinnedAnswers(backend: RetrievalBackend): Promise<PinnedDocument> {
  const protocols = backend.protocols().map(({ id, title }) => ({ id, title }));
  const served = new Set(protocols.map((protocol) => protocol.id));
  const answers: PinnedDocument["answers"] = [];
  for (const entry of GOLDEN) {
    if (!served.has(entry.protocol)) continue;
    const outcome = await answerQuestion({ question: entry.question, protocol: entry.protocol, backend, model: new ScriptedModel(entry.script) });
    answers.push({ id: entry.id, question: entry.question, protocol: entry.protocol, label: PINNED_LABEL, ndjson: outcome.ndjson });
  }
  return { label: PINNED_LABEL, protocols, answers };
}
