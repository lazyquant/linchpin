/**
 * The layer of a relation in the explorer. A layer is a display grouping chosen by this app, not a recorded fact:
 * Control is the control class of the vocabulary, Pricing and Code are named relations, Structure is the rest.
 */
import { VOCABULARY } from "../../engine/queries/vocabulary";
import { LAYERS } from "./strings";

const CODE = new Set(["OWNER_PROGRAM", "PROGRAM_DATA", "ISSUED_BY_PROGRAM"]);

export function classOf(predicate: string): string | null {
  const entry = (VOCABULARY as Record<string, { class: string } | undefined>)[predicate];
  return entry ? entry.class : null;
}

export function layerOf(predicate: string): string {
  if (classOf(predicate) === "control") return LAYERS[0].name;
  if (predicate === "PRICED_BY") return LAYERS[2].name;
  if (CODE.has(predicate)) return LAYERS[3].name;
  return LAYERS[1].name;
}
