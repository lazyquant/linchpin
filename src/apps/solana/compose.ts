/**
 * The one way a surface reaches the page: validated first, interpreted only when accepted. A refused surface
 * returns its codes and no tree, so nothing of it can be drawn.
 */
import { interpret } from "../../ui/interpret";
import { UiRejected } from "../../ui/types";
import type { ResolveEvidence, SurfaceTree } from "../../ui/types";
import { validateSurface } from "../../ui/validate";

export type Rendered = { ok: true; tree: SurfaceTree } | { ok: false; codes: string[] };

/** A resolver over the receipt ids the app loaded, less any that a caller takes out. */
export function resolverOver(known: ReadonlySet<string>, extra: readonly string[] = [], dropped: readonly string[] = []): ResolveEvidence {
  const more = new Set(extra);
  const gone = new Set(dropped);
  return (ids) => ({ missing: ids.filter((id) => gone.has(id) || !(known.has(id) || more.has(id))) });
}

export function render(messages: unknown, resolveEvidence: ResolveEvidence): Rendered {
  const verdict = validateSurface(messages, { resolveEvidence });
  if (!verdict.ok) return { ok: false, codes: [...verdict.codes] };
  try {
    return { ok: true, tree: interpret(messages) };
  } catch (error) {
    // The kit refuses a drawing it cannot hold, such as a graph over its node limit.
    return { ok: false, codes: [error instanceof UiRejected ? error.code : "not-drawn"] };
  }
}
