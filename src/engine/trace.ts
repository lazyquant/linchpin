import { existsSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, basename, join, resolve, relative, isAbsolute, sep } from "node:path";
import type { EngineTraceEvent, TraceSink } from "./contracts";
import { canonical } from "../chain/evidence";
import { EngineError } from "./errors";

export function repositoryRoot(cwd = process.cwd()): string | null {
  let current: string;
  try { current = realpathSync(cwd); } catch { throw new EngineError("repository-path"); }
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
export function isInsideRepository(path: string): boolean {
  try { return insideRepository(path); } catch { throw new EngineError("path-invalid"); }
}
function insideRepository(path: string): boolean {
  const root = repositoryRoot();
  if (root === null) return false;
  let ancestor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (ancestor === parent) break;
    tail.unshift(basename(ancestor)); ancestor = parent;
  }
  const destination = resolve(realpathSync(ancestor), ...tail);
  const rel = relative(root, destination);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function memoryTraceSink(): TraceSink & { readonly events: EngineTraceEvent[] } {
  const events: EngineTraceEvent[] = [];
  return { events, async append(event) { events.push(structuredClone(event)); } };
}
export class FileTraceSink implements TraceSink {
  private chain: Promise<void> = Promise.resolve();
  constructor(public readonly path: string) {}
  append(event: EngineTraceEvent): Promise<void> {
    let line: string;
    try { line = canonical(event) + "\n"; } catch { return Promise.reject(new EngineError("trace-write")); }
    const write = this.chain.then(async () => {
      try { if (isInsideRepository(this.path)) throw new EngineError("trace-path"); }
      catch { throw new EngineError("trace-path"); }
      let handle;
      try {
        handle = await open(this.path, "a", 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(line);
        await handle.sync();
      } catch { throw new EngineError("trace-write"); }
      finally { if (handle) await handle.close().catch(() => {}); }
    });
    // A failed append poisons this sink: no queued append can hide an uncertain write.
    this.chain = write;
    return write;
  }
}
export function fileTraceSink(path: string): FileTraceSink { return new FileTraceSink(path); }
export async function readTrace(path: string): Promise<EngineTraceEvent[]> {
  try {
    return (await Bun.file(path).text()).split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  } catch { throw new EngineError("trace-read"); }
}
