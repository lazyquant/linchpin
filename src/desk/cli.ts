/**
 * `linchpin desk <policy>`: checks every argument, loads the state, then binds the loopback server. A launch that
 * cannot be served prints one line, `desk: <cause>`, returns 2 and binds no port.
 */
import { readPositions } from "../positions/read";
import { startDesk, type DeskTestHooks } from "./server";
import { DeskRejected, loadDeskState, parseDeskAddress, type DeskDeps, type DeskOptions } from "./state";

export interface DeskIO {
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** Stops the server when it aborts. Without it the desk serves until it is interrupted. */
  signal?: AbortSignal;
  readPositions?: DeskDeps["readPositions"];
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  testHooks?: DeskTestHooks;
}

export const DEFAULT_DESK_PORT = 7430;
export const DESK_USAGE = "usage: linchpin desk <policy> [--snapshot <id>] [--before <snapshot>] [--address <chain>:<account>]... [--positions <file>] [--port <n>]";

function parseArgs(argv: string[]): { options: DeskOptions; port: number } {
  const options: DeskOptions = { policy: "", addresses: [] };
  let port = DEFAULT_DESK_PORT;
  const positional: string[] = [];
  // The desk binds this machine only: a host cannot be chosen, whatever its value.
  if (argv.some((arg) => arg === "--host" || arg.startsWith("--host="))) throw new DeskRejected("host-not-allowed (the desk binds 127.0.0.1 only)");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!["--snapshot", "--before", "--address", "--positions", "--port"].includes(arg)) throw new DeskRejected(DESK_USAGE);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new DeskRejected(DESK_USAGE);
    if (arg === "--snapshot") options.snapshot = value;
    else if (arg === "--before") options.before = value;
    else if (arg === "--positions") options.positionsFile = value;
    else if (arg === "--address") options.addresses.push(value);
    else {
      if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new DeskRejected("port-out-of-range (--port takes 1 to 65535)");
      port = Number(value);
    }
  }
  if (positional.length !== 1) throw new DeskRejected(DESK_USAGE);
  options.policy = positional[0];
  for (const address of options.addresses) parseDeskAddress(address);
  return { options, port };
}

export async function runDeskCommand(argv: string[], io: DeskIO = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const deps: DeskDeps = { readPositions: io.readPositions ?? readPositions, env: io.env ?? process.env, fetch: io.fetch, now: io.now ?? Date.now };
  let server: Awaited<ReturnType<typeof startDesk>>;
  try {
    const { options, port } = parseArgs(argv);
    const state = await loadDeskState(options, deps);
    server = await startDesk({ state, deps, port, log: io.log, testHooks: io.testHooks });
  } catch (error) {
    const cause = error instanceof DeskRejected ? error.code : "failed";
    err(`desk: ${cause}`);
    return 2;
  }
  out(`desk ${server.origin}/#token=${server.token}`);
  await new Promise<void>((resolve) => {
    if (io.signal) {
      if (io.signal.aborted) resolve();
      else io.signal.addEventListener("abort", () => resolve(), { once: true });
    } else {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }
  });
  await server.stop();
  return 0;
}
