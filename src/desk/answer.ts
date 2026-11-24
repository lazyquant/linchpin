/**
 * An agent's prose, cut into text and ids. The prose is never a fact: it is shown as text under "unchecked
 * summary". A fact or receipt id in it is shown as a reference only when it resolves in the loaded snapshots.
 */
import type { DeskState } from "./state";
import { factIndex } from "./state";

export type AnswerSegment = { text: string } | { id: string; resolves: boolean };

/** A fact id (`nf:`) or receipt id (`nr:`): the prefix, a snapshot id and forty hex digits. */
const EVIDENCE_ID = /(?<![A-Za-z0-9])n[fr]:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9a-f]{40}(?![A-Za-z0-9])/g;

/** Whether an id is a fact of a loaded snapshot or a receipt of the store. */
export function idResolver(state: DeskState): (id: string) => boolean {
  const facts = factIndex(state);
  return (id) => facts.has(id) || state.store.receipt(id) !== undefined;
}

/** Splits the text at every evidence id, in order. Text between ids is kept as written. */
export function answerSegments(text: string, resolves: (id: string) => boolean): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(EVIDENCE_ID)) {
    const start = match.index ?? 0;
    if (start > at) segments.push({ text: text.slice(at, start) });
    segments.push({ id: match[0], resolves: resolves(match[0]) });
    at = start + match[0].length;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}
