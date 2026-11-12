import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../chain/evidence";
import { buildDryQuoteRequest, captureIntentExtension, dryQuoteRequestSha256, fetchDryQuote, intentReviewJson, loadIntentContext, renderIntentMarkdown, reviewIntent, type IntentInput } from "../intents";
const usage = "usage: linchpin near intent --asset <id> [--offline] | --from <id> --to <id> --amount <int> [--record|--offline] [--snapshot <id>] [--before <id> --after <id>] [--out <dir>] | capture --snapshot <id> --record [--dry-run]";
export async function run(args: string[]): Promise<number> {
  try {
    const capture = args[0] === "capture", options = new Map<string, string>(), flags = new Set<string>();
    for (let i = capture ? 1 : 0; i < args.length; i++) {
      const key = args[i]; if (options.has(key) || flags.has(key)) throw new Error("Duplicate flag");
      if (["--record", "--offline", "--dry-run"].includes(key)) flags.add(key);
      else if (["--asset", "--from", "--to", "--amount", "--snapshot", "--before", "--after", "--out"].includes(key) && args[i + 1] && !args[i + 1].startsWith("--")) options.set(key, args[++i]);
      else throw new Error("Invalid or missing flag");
    }
    const opt = (k: string) => options.get(k);
    if (flags.has("--record") && flags.has("--offline")) throw new Error("Conflicting modes");
    if (capture) {
      if (!flags.has("--record") || !opt("--snapshot") || [...options.keys()].some(k => k !== "--snapshot") || flags.has("--offline")) throw new Error("Invalid capture flags");
      console.log(JSON.stringify(await captureIntentExtension({ snapshotId: opt("--snapshot")!, dryRun: flags.has("--dry-run") }), null, 2)); return 0;
    }
    if (flags.has("--dry-run") || !!opt("--before") !== !!opt("--after")) throw new Error("Invalid review flags");
    let input: IntentInput, slug: string;
    if (opt("--asset")) {
      if (["--from", "--to", "--amount"].some(k => options.has(k)) || flags.has("--record")) throw new Error("Invalid asset flags");
      input = { kind: "asset", assetId: opt("--asset")! }; slug = `asset-${sha256(input.assetId).slice(0, 12)}`;
    } else {
      if (!["--from", "--to", "--amount"].every(k => options.has(k))) throw new Error("Quote fields required");
      const request = buildDryQuoteRequest({ originAsset: opt("--from")!, destinationAsset: opt("--to")!, amount: opt("--amount")! });
      const quote = await fetchDryQuote(request, { mode: flags.has("--record") ? "record" : "offline" });
      if (!quote.ok) { console.error(`Quote refused: ${quote.error}; ${quote.reasons.map(r => `${r.code} ${r.ref}`).join("; ")}${quote.error === "missing-fixture" ? "; no dry quote recording exists for this request; use --asset <id> --offline for an on-chain asset review" : ""}${quote.failure ? `; ${quote.failure.cause}; HTTP ${quote.failure.httpStatus}; body sha256 ${quote.failure.responseSha256}` : ""}`); return 1; }
      input = { kind: "quote", quote }; slug = `quote-${dryQuoteRequestSha256(request).slice(0, 12)}`;
    }
    const ctx = loadIntentContext({ snapshotId: opt("--snapshot"), before: opt("--before"), after: opt("--after") });
    const review = reviewIntent(input, ctx), md = renderIntentMarkdown(review), json = intentReviewJson(review), out = opt("--out") ?? join("out/near/intent", slug);
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, "intent-review.md"), md); writeFileSync(join(out, "intent-review.json"), json); console.log(md.trimEnd()); return 0;
  } catch (e) { console.error(e instanceof Error ? e.message : "Intent review failed"); console.error(usage); return 1; }
}
