import { captureSnapshot, constructSnapshot, probeUnknownBlock } from "./capture";
export async function runSnapshotCommand(args: string[]): Promise<number> {
  try {
    if (args[0] === "--probe-unknown-block") {
      const archivalUrl = process.env.LINCHPIN_NEAR_ARCHIVAL_RPC_URL;
      if (!archivalUrl) throw new Error("Set LINCHPIN_NEAR_ARCHIVAL_RPC_URL for the probe");
      await probeUnknownBlock({ archivalUrl }); console.log("unknown-block probe recorded");
    } else if (args[0] === "--construct") {
      const index = args.indexOf("--from");
      if (args[1] !== "intents-locker-added" || index < 0 || !args[index + 1]) throw new Error("Use --construct intents-locker-added --from <id>");
      console.log(JSON.stringify(await constructSnapshot(args[1], args[index + 1]), null, 2));
    } else {
      if (!args[0]) throw new Error("Use snapshot <id> [--dry-run]");
      console.log(JSON.stringify(await captureSnapshot({ snapshotId: args[0], dryRun: args.includes("--dry-run") }), null, 2));
    }
    return 0;
  } catch (e) { console.error(e instanceof Error ? e.message : "NEAR capture failed"); return 1; }
}
if (import.meta.main) process.exitCode = await runSnapshotCommand(process.argv.slice(2));
