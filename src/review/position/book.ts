import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PrivatePosition } from "../../engine/index";
import { DECIMAL_PATTERN, ID_PATTERN, POLICY_SUBJECT_PATTERN, jsonRecord } from "../../policy/index";
export const DEFAULT_BOOK_PATH = ".private/book.json";
export const DEFAULT_POLICY_PATH = ".private/policy.json";
export class PositionRejected extends Error {
  constructor(readonly code: string, readonly entryIndex = 0, readonly field = "book") {
    super(code === "book-not-found" ? "book not found" : code === "several-book-snapshots"
      ? "book has several snapshots; pass --book-snapshot" : `book entry ${entryIndex} ${field}: ${code}`);
    this.name = "PositionRejected";
  }
}
const FIELDS = ["id", "subject", "quantity", "unit", "snapshotId", "source", "fixtureKind"];
export function parseBook(input: unknown): PrivatePosition[] {
  if (!Array.isArray(input)) throw new PositionRejected("schema");
  const seen = new Set<string>();
  return Array.from(input, (entry: unknown, index) => {
    const fail = (code: string, field = "book"): never => { throw new PositionRejected(code, index, field); };
    if (!jsonRecord(entry)) return fail("schema");
    if (Object.keys(entry).some(k => !FIELDS.includes(k))) return fail("unexpected-field");
    for (const key of FIELDS) if (!Object.hasOwn(entry, key)) fail("missing-field", key);
    for (const key of ["id", "snapshotId"]) if (typeof entry[key] !== "string" || !ID_PATTERN.test(entry[key] as string)) fail("malformed-id", key);
    if (typeof entry.subject !== "string" || !POLICY_SUBJECT_PATTERN.test(entry.subject)) fail("malformed-subject", "subject");
    if (typeof entry.quantity !== "string" || entry.quantity.length > 80 || !DECIMAL_PATTERN.test(entry.quantity)) fail("malformed-quantity", "quantity");
    if (typeof entry.unit !== "string" || !entry.unit.length || entry.unit.length > 128 || /\s/.test(entry.unit)) fail("malformed-unit", "unit");
    if (entry.source !== "manual") fail("unsupported-source", "source");
    if (entry.fixtureKind !== "real-private" && entry.fixtureKind !== "synthetic") fail("bad-fixture-kind", "fixtureKind");
    const key = JSON.stringify([entry.id, entry.snapshotId]);
    if (seen.has(key)) fail("duplicate-position", "id");
    seen.add(key);
    return structuredClone(entry) as unknown as PrivatePosition;
  });
}
const danglingLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
/** Resolve existing symlink ancestors even when the destination does not exist. A link whose target is missing is followed too, since a write would follow it. */
export function resolvedLocalPath(path: string): string {
  try {
    let ancestor = resolve(path), hops = 0;
    const suffix: string[] = [];
    while (!existsSync(ancestor)) {
      if (danglingLink(ancestor)) {
        if (++hops > 40) throw new Error();
        ancestor = resolve(dirname(ancestor), readlinkSync(ancestor));
        continue;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error();
      suffix.unshift(basename(ancestor)); ancestor = parent;
    }
    return resolve(realpathSync(ancestor), ...suffix);
  } catch { throw new PositionRejected("invalid-path"); }
}
export function nearestRepository(path: string): string | null {
  let current = resolvedLocalPath(path);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
export function insidePath(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export async function loadBook(path = DEFAULT_BOOK_PATH): Promise<PrivatePosition[]> {
  let input: unknown;
  try { input = await Bun.file(path).text(); }
  catch { throw new PositionRejected("book-not-found"); }
  try { input = JSON.parse(input as string); }
  catch { throw new PositionRejected("malformed-json"); }
  const book = parseBook(input), destination = resolvedLocalPath(path), root = nearestRepository(destination);
  if (root && !insidePath(destination, join(root, ".private")) && book.some(p => p.fixtureKind === "real-private")) throw new PositionRejected("real-book-in-repository");
  return book;
}
export function selectBook(book: readonly PrivatePosition[], snapshotId?: string): PrivatePosition[] {
  const ids = [...new Set(book.map(p => p.snapshotId))];
  if (snapshotId === undefined && ids.length > 1) throw new PositionRejected("several-book-snapshots");
  if (snapshotId !== undefined && (!ID_PATTERN.test(snapshotId) || !ids.includes(snapshotId))) throw new PositionRejected("book-snapshot-not-found", 0, "snapshotId");
  return book.filter(p => p.snapshotId === (snapshotId ?? ids[0]));
}
