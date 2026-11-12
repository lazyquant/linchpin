import type { Fact } from "../../engine/contracts";
import type { IntentReview } from "./types";
export function findBannedWords(text: string): string[] {
  return [...new Set(text.split("\n").filter(line => !line.startsWith("> ")).join("\n").match(/\b(backed|redeemable|safe|equivalent)\b/gi) ?? [])];
}
export function intentReviewJson(r: IntentReview): string { return JSON.stringify(r, null, 2) + "\n"; }
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const short = (s: string) => s.replace(/^near:mainnet:/, "");
const notes = (ids: string[]) => [...new Set(ids)].map(id => `[^${id}]`).join("");
export function renderIntentMarkdown(r: IntentReview): string {
  const byId = new Map(r.facts.map(f => [f.id, f]));
  const fs = (subject: string, predicate: string) => r.facts.filter(f => f.subject === `near:mainnet:${subject}` && f.predicate === predicate);
  const holders = (role: string) => fs(`intents.near#role:${role}`, "holds-role").filter(f => f.object !== "none");
  const upgrade = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "upgrade");
  const roles = r.control.find(c => c.subject === "near:mainnet:intents.near" && c.power === "grant-roles");
  const obs = r.observations.find(o => o.snapshotId.endsWith(".intents")) ?? r.observations[0];
  const title = r.input.kind === "asset" ? r.input.assetId : `${r.input.originAsset} → ${r.input.destinationAsset}`;
  const lines = [
    `# Intent review · ${title}`,
    `route family   ${r.families.join(" + ") || "unknown"} (rules ${r.legs[0]?.classification.sdkVersion ?? "unknown"})`,
    `verifier       intents.near · paused ${fs("intents.near", "paused").map(f => f.object).join(", ") || "unknown"}`,
    `upgrade        Upgrader → ${upgrade?.holders.map(short).join(", ") || "unknown"} · ${upgrade?.detail ?? "unknown"}`,
    `pause          PauseManager → ${holders("PauseManager").length} accounts · UnpauseManager → ${holders("UnpauseManager").length}`,
    `freeze         UnrestrictedAccountLocker → ${holders("UnrestrictedAccountLocker").length} accounts`,
    `roles          ${roles?.detail.replaceAll("near:mainnet:", "") ?? "unknown"} · no execution delay field`,
    `off-chain      ${r.offchain.map(d => d.id).join(", ") || "missing documents"} (claimed documents)`,
    `unknowns       ${r.unknowns.length} reasons · outcome ${r.outcome}`,
    `snapshot       ${r.snapshotIds.find(id => /^near-\d{4}-\d{2}-\d{2}$/.test(id)) ?? obs?.snapshotId.replace(/\.intents$/, "") ?? "unknown"} · blocks ${obs?.fromBlockOrSlot ?? "unknown"}–${obs?.toBlockOrSlot ?? "unknown"} · asOf ${r.asOf}`,
    "", "## Quote (claimed by 1Click)", "",
  ];
  const factLine = (f: Fact) => `${cell(short(f.subject))} · ${cell(f.predicate)} · ${cell(f.object)} [${f.basis}; ${f.status}] ${notes(f.evidenceIds)}`;
  if (r.quote) {
    lines.push(`Correlation ${cell(r.quote.correlationId)} · timestamp ${cell(r.quote.timestamp)} · signature recorded, verification not performed. ${notes([r.quote.receiptId])}`, "");
    for (const id of r.quote.factIds) { const f = byId.get(id); if (f) lines.push(`- ${factLine(f)}`); }
  } else {
    lines.push("not recorded", "", cell(r.quoteNotRecorded?.reason ?? "No recorded dry quote is available for this asset review."));
    const attempt = r.quoteNotRecorded?.attempt;
    if (attempt) lines.push("", `Evidence: ${attempt.endpointHost} · HTTP ${attempt.httpStatus} · recorded ${attempt.recordedDate} · request sha256 ${attempt.requestSha256} · response sha256 ${attempt.responseSha256}. Only the response hash and diagnostic were retained; no quote figures are recorded.`);
  }
  lines.push("", "## Route evidence", "");
  for (const { classification: c } of r.legs) {
    lines.push(`- ${cell(c.assetId)}: ${c.family ?? "undetermined"}${c.migrated_from ? `; migrated_from: ${c.migrated_from}` : ""}`);
    if (c.sdkMigration) lines.push(`  SDK ${c.sdkVersion} documented migration table: ${c.sdkMigration.listed ? "listed" : "not listed"}; ${c.sdkMigration.sourceFile}; sha256 ${c.sdkMigration.sha256}${c.sdkMigration.conflict ? "; conflict with recorded chain classification" : ""}.`);
    const e = c.routeEvidence;
    if (!e) continue;
    for (const [label, observation] of [["code hash", e.codeHash], ["source metadata", e.sourceMetadata], ["owner", e.owner], ["controller", e.controller], ["Omni mapping", e.mapping], ["Omni reverse mapping", e.reverseMapping], ["withdraw relayer (account fact only)", e.withdrawRelayer]] as const) {
      if (observation) lines.push(`  - ${label}: ${cell(typeof observation.value === "string" ? observation.value : JSON.stringify(observation.value))} · ${observation.basis}, ${observation.status} · block ${observation.receipt.observation.blockOrSlot ?? "unknown"} ${notes([observation.receipt.id])}`);
      else lines.push(`  - ${label}: undetermined`);
    }
  }
  lines.push("", "## Chain", "");
  for (const h of r.chain) {
    lines.push(`${h.index + 1}. **${h.role}** · ${cell(h.label)} · ${h.family} ${notes(h.receiptIds)}`);
    for (const reason of h.reasons) lines.push(`   - ${reason.code} · ${cell(reason.subject ?? "—")} · ${cell(reason.ref ?? "—")}`);
  }
  lines.push("", "## Control", "", "| Contract | Power | Holders / count | Evidence |", "|---|---|---|---|");
  for (const c of r.control) lines.push(`| ${cell(short(c.subject))} | ${c.power}${c.kind === "interpretation" ? " (interpretation)" : ""} | ${cell(c.holders.map(short).join(", ") || "—")} / ${c.count ?? "unknown"} | ${cell(c.detail)} ${notes(c.receiptIds)}${c.reasons.length ? ` · ${c.reasons.map(x => x.code).join(", ")}` : ""} |`);
  lines.push("", "## What changed", "", r.changes.pair ? `${r.changes.pair.constructed ? "Constructed comparison (constructed): " : "Observed comparison: "}${r.changes.pair.before} → ${r.changes.pair.after}` : "No live snapshot pair is available. The dated on-chain history follows.");
  for (const c of r.changes.changes) {
    lines.push("", `- ${c.kind} · ${cell(short(c.subject))}`);
    if (c.before) lines.push(`  - before: ${factLine(c.before)}`);
    if (c.after) lines.push(`  - after: ${factLine(c.after)}`);
  }
  lines.push("", "Controller versions:");
  for (const v of r.changes.versions) lines.push(`- ${v.version}@${v.at} ${notes(v.receiptIds)}`);
  lines.push("", `MPC observation: ${r.changes.mpc.participants} participants; threshold ${r.changes.mpc.threshold ?? "unknown"}. ${notes(r.changes.mpc.receiptIds)}`);
  for (const h of r.changes.history) if (h.events.length) { lines.push("", `History · ${short(h.subject)}`); for (const e of h.events) lines.push(`- ${e.at} · ${e.kind} · ${e.sourceFactId} ${notes(e.receiptIds)}`); }
  lines.push("", "## Origin is not backing", "", r.origin.text, "", "Custody facts:");
  for (const item of r.origin.has) lines.push(`- ${cell(item.label)} ${notes(item.receiptIds)}`);
  lines.push("", "Missing custody evidence:"); for (const reason of r.origin.lacks) lines.push(`- ${reason.code} · ${cell(reason.subject ?? "—")} · ${cell(reason.ref ?? "—")}`);
  lines.push("", "## Off-chain, permissioned", "");
  for (const d of r.offchain) lines.push(`- **${d.title}** — claimed by document: ${d.summary}. ${notes([d.receiptId])}`, `  Source: ${d.url} · retrieved ${d.retrievedAt} · sha256 ${d.sha256}`);
  lines.push("", "## Unknowns", "");
  const implicit = new Set(r.unknowns.filter(x => x.code === "missing-subject" && /^near:mainnet:[0-9a-f]{64}$/.test(x.subject ?? "")).map(x => x.subject));
  const grouped = new Map<string, Set<string>>();
  for (const f of r.facts) if (f.predicate === "holds-role" && f.subject.includes("#role:") && implicit.has(f.object)) { const name = f.subject.split("#role:")[1], set = grouped.get(name) ?? new Set(); set.add(f.object); grouped.set(name, set); }
  if (grouped.size) lines.push(`Implicit-account holders (not inferred): ${[...grouped].sort(([a],[b]) => a.localeCompare(b)).map(([role, ids]) => `${role} ${ids.size}`).join(", ")}.`, "");
  for (const reason of r.unknowns) lines.push(`- ${reason.code} · ${cell(reason.subject ?? "—")} · ${cell(reason.ref ?? "—")}`);
  if (!r.unknowns.length) lines.push("No unresolved query or recipe reasons.");
  lines.push("", "## Receipts", "");
  for (const e of r.receipts) lines.push(`[^${e.id}]: ${e.id} · ${e.source} · ${e.observation.blockOrSlot ?? "—"} · ${e.responseSha256.slice(0, 12)}`);
  return lines.join("\n") + "\n";
}
