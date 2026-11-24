/**
 * The command of the Solana app.
 *
 *   bun run src/apps/solana/main.ts serve [--port <n>] [--live]
 *   bun run src/apps/solana/main.ts build [--out <dir>]
 *
 * `serve` binds the loopback address only. `build` writes one self-contained `index.html`. Arguments are checked
 * before anything is loaded or bound; a wrong one prints one line and exits 2.
 */
import { loadApp } from "./load";
import { createAnswersHandler, type AnswersHandlerOptions } from "../../answers/handler";
import type { AppData } from "./model";
import { buildAssets, buildDocument } from "./page";
import { AppBindError, startServer, type ServerOptions } from "./server";

export const USAGE = "usage: bun run src/apps/solana/main.ts serve [--port <n>] [--live] | build [--out <dir>]";
export const DEFAULT_PORT = 4406;
export const DEFAULT_OUT = "dist/solana-app";

/** Both launchers use this mount; tests may supply an offline backend and model. */
export function startAppServer(options: Omit<ServerOptions, "answers">, answers: AnswersHandlerOptions = {}) {
  return startServer({ ...options, answers: createAnswersHandler({ ...answers, logPath: answers.logPath === undefined ? process.env.LINCHPIN_AGENT_LOG || null : answers.logPath }) });
}

export type Command =
  | { command: "serve"; port: number; live: boolean }
  | { command: "build"; out: string }
  | { command: "refused"; line: string };

export function parseArgs(args: string[]): Command {
  const [command, ...rest] = args;
  if (command === "serve") {
    let port = DEFAULT_PORT;
    let live = false;
    for (let at = 0; at < rest.length; at++) {
      const arg = rest[at];
      if (arg === "--live") live = true;
      else if (arg === "--port") {
        const value = rest[++at];
        if (value === undefined || !/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) return { command: "refused", line: "solana-app: --port takes a number from 1 to 65535" };
        port = Number(value);
      } else if (arg === "--host" || arg.startsWith("--host=")) return { command: "refused", line: "solana-app: the server binds 127.0.0.1 only; --host is not accepted" };
      else return { command: "refused", line: USAGE };
    }
    return { command: "serve", port, live };
  }
  if (command === "build") {
    if (rest.length === 0) return { command: "build", out: DEFAULT_OUT };
    if (rest.length === 2 && rest[0] === "--out" && rest[1] !== "") return { command: "build", out: rest[1] };
    return { command: "refused", line: USAGE };
  }
  return { command: "refused", line: USAGE };
}

/** Runs a parsed command with data from `load`. Shared with a launcher that loads more than the public build. */
export async function run(parsed: Command, load: () => Promise<AppData>, name = "solana-app"): Promise<number> {
  if (parsed.command === "refused") {
    console.error(parsed.line);
    return 2;
  }
  const rpcUrl = process.env.LINCHPIN_RPC_URL;
  if (parsed.command === "serve" && parsed.live && (rpcUrl === undefined || rpcUrl === "")) {
    console.error(`${name}: --live needs LINCHPIN_RPC_URL`);
    return 2;
  }
  console.error(`${name}: reading the committed captures; this takes about a minute`);
  let bindPort: number | null = null;
  try {
    const data = await load();
    if (parsed.command === "build") {
      const file = `${parsed.out.replace(/\/+$/, "")}/index.html`;
      await Bun.write(file, buildDocument(data, await buildAssets()));
      console.log(file);
      return 0;
    }
    bindPort = parsed.port;
    const server = await startAppServer({ port: parsed.port, data, live: parsed.live, rpcUrl });
    console.log(`${name} ${server.origin}/#token=${server.token}`);
    return -1;
  } catch (error) {
    const binding = bindPort !== null && error instanceof AppBindError;
    // Arbitrary exception text can contain paths or request data. Keep the
    // diagnosis accurate without returning that text to the operator.
    console.error(binding ? `${name}: port ${bindPort} could not be bound` : `${name}: the app could not start`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await run(parseArgs(Bun.argv.slice(2)), async () => (await loadApp()).data);
  if (code >= 0) process.exitCode = code;
}
