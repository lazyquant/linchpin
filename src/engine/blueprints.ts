import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "../chain/evidence";
import { EngineError } from "./errors";

export const BLUEPRINTS = Object.freeze({
  "position-review-v1": Object.freeze({
    file: "position-review.json",
    sha256: "538f12df5b15e7b877805eb9261134d4c693d63bd8f1ef9d115922935e443824",
  }),
});
export function blueprintSha256(value: unknown): string { return sha256(canonical(value)); }
export async function resolveBlueprint(id: string, root = fileURLToPath(new URL("../../context/blueprints/", import.meta.url))): Promise<{ id: string; sha256: string }> {
  if (!Object.hasOwn(BLUEPRINTS, id)) throw new EngineError("blueprint-unknown");
  const expected = BLUEPRINTS[id as keyof typeof BLUEPRINTS];
  try {
    const value = await Bun.file(join(root, expected.file)).json();
    if (value?.id !== id || blueprintSha256(value) !== expected.sha256) throw new EngineError("blueprint-mismatch");
    return { id, sha256: expected.sha256 };
  } catch { throw new EngineError("blueprint-mismatch"); }
}
