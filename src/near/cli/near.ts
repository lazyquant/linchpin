import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { runQuery } from "../../engine/queries/run";
import { NEAR_REGISTRY, CURRENT_NEAR_SNAPSHOT } from "../subjects/registry";
import { captureSnapshot } from "../reader/capture";
import { loadNearSnapshot, loadNearSnapshots, readNearManifest } from "../reader/load";
import { parseNearSubject } from "../reader/types";
const usage = "usage: linchpin near subjects [--json] | facts <account|subject> [--snapshot <id>] [--offline] | snapshot <id> [--record] [--dry-run] | diff <subject> <before> <after> [--max <n>] [--offline]";
function subject(value: string): string {
  if (!value) throw new Error("NEAR subject required");
  const s = value.startsWith("near:") ? value : `near:mainnet:${value}`;
  if (!parseNearSubject(s)) throw new Error("Invalid NEAR subject"); return s;
}
function printFact(f: Fact, receipts: EvidenceReceipt[]): void {
  console.log(`${f.id} ${f.subject} ${f.predicate} ${f.object} [${f.basis}]`);
  for (const id of f.evidenceIds) {
    const r = receipts.find(r => r.id === id); if (!r) throw new Error("Missing fact receipt");
    console.log(`  ${r.id} ${r.source.replace(/^near-rpc:/, "")} ${r.observation.blockOrSlot ?? "unknown"} ${r.responseSha256.slice(0, 12)}`);
  }
}
export async function runNearCommand(args: string[]): Promise<number> {
  const savedFetch = globalThis.fetch;
  if (args.includes("--offline")) globalThis.fetch = (() => { throw new Error("Network disabled in offline mode"); }) as unknown as typeof fetch;
  const option = (name: string, fallback?: string) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${name} value`); return args[i + 1]; };
  try {
    switch (args[0]) {
      case "subjects":
        if (args.includes("--json")) console.log(JSON.stringify(NEAR_REGISTRY, null, 2));
        else { console.log("account\tchains\trecipes\tyields"); for (const e of NEAR_REGISTRY) console.log(`${e.account}\t${e.chains.join(",")}\t${e.recipes.map(r => r.kind).join(",")}\t${e.yields.join(",")}`); }
        return 0;
      case "facts": {
        const s = subject(args[1]), id = option("--snapshot", CURRENT_NEAR_SNAPSHOT)!, store = loadNearSnapshot(id), snapshot = store.snapshot(id)!;
        if (!snapshot.subjects.includes(s)) console.log(`missing-subject ${s}`);
        else for (const f of snapshot.facts.filter(f => f.subject === s || f.subject.startsWith(`${s}#`))) printFact(f, snapshot.receipts);
        return 0;
      }
      case "snapshot": {
        if (!args[1]) throw new Error("Snapshot id required");
        if (args.includes("--record") && args.includes("--offline")) throw new Error("Recording requires network mode");
        const m = args.includes("--record") ? await captureSnapshot({ snapshotId: args[1], dryRun: args.includes("--dry-run") }) : readNearManifest(args[1]);
        console.log(JSON.stringify(m, null, 2)); return 0;
      }
      case "diff": {
        const s = subject(args[1]), before = args[2], after = args[3];
        if (!before || !after) throw new Error("Two snapshot ids required");
        const result = runQuery(loadNearSnapshots([before, after]), { name: "changes", subject: s, beforeSnapshotId: before, afterSnapshotId: after, maxResults: Number(option("--max", "500")) });
        console.log(`${result.outcome}: ${result.changes.length} changes`);
        for (const change of result.changes) { console.log(change.kind); if (change.before) { console.log("before"); printFact(change.before, result.receipts); } if (change.after) { console.log("after"); printFact(change.after, result.receipts); } }
        for (const r of result.reasons) console.log(`${r.code} ${r.subject ?? ""} ${r.ref ?? ""}`); return 0;
      }
      default: {
        const name = args[0];
        if (name && /^[a-z][a-z-]*$/.test(name) && name !== "near") {
          const url = new URL(`./${name}.ts`, import.meta.url);
          if (await Bun.file(url).exists()) { const command = await import(url.href); if (typeof command.run !== "function") throw new Error("NEAR command must export run"); return await command.run(args.slice(1)); }
        }
        console.log(usage); return 1;
      }
    }
  } catch (e) { console.error(e instanceof Error ? e.message : "NEAR command failed"); return 1; }
  finally { globalThis.fetch = savedFetch; }
}
