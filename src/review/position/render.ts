import type { EvidenceReceipt, Fact, QueryReason } from "../../engine/index";
import type { NamedQuantity } from "../../adapters/kamino/index";
import { cmp, sortedUnique, type PublicPolicyVerdict } from "../../policy/index";
import type { EconomicsView } from "./economics";
import { toPublicReview, type PublicPositionReport } from "./export";
import type { PositionReport } from "./review";
export const POSITION_BANNED_WORDS = Object.freeze(["should", "recommend", "safe", "safety", "unsafe", "score", "rating", "buy", "sell", "guarantee", "guaranteed", "predict", "predicted", "loss"]);
export function findBannedWords(text: string): string[] {
  const prose = text.replace(/`[^`]*`/g, "").replace(/"(?:\\.|[^"\\])*"/g, "");
  return sortedUnique((prose.match(new RegExp(`\\b(?:${POSITION_BANNED_WORDS.join("|")})\\b`, "gi")) ?? []).map(s => s.toLowerCase()));
}
const code = (value: unknown) => "`" + String(value).replace(/`/g, "&#96;").replace(/[\r\n]/g, " ").replace(/\|/g, "&#124;").replace(/</g, "&lt;") + "`";
const quoted = (value: string) => JSON.stringify(value).replace(/</g, "&lt;");
function quantities(lines: string[], title: string, items: NamedQuantity[]) {
  lines.push(`### ${title}`, "");
  if (!items.length) lines.push("No captured items.", "");
  for (const q of items) lines.push(`- ${code(q.name)}: ${q.value} ${code(q.unit)}; window ${code(q.window)}; basis ${code(q.basis)}; slot ${code(q.asOfSlot ?? "unknown")}; receipts ${q.evidenceIds.map(code).join(", ")}.`);
  lines.push("");
}
function facts(lines: string[], title: string, values: Fact[]) {
  lines.push(`### ${title}`, "");
  for (const f of values) lines.push(`- ${code(f.subject)} → ${code(f.predicate)} → ${code(f.object)}; ${code(f.basis)}, ${code(f.status)}; fact ${code(f.id)}; receipts ${f.evidenceIds.map(code).join(", ")}.`);
  if (!values.length) lines.push("No captured facts.");
  lines.push("");
}
function economics(lines: string[], view: Omit<EconomicsView, "valuation">, privateView: boolean) {
  lines.push("## Economics", "", `Yield source: ${code(view.yieldSource.kind)}.`, "");
  quantities(lines, "Reserve allocations", view.yieldSource.allocations);
  quantities(lines, "Reward component", view.yieldSource.rewards);
  quantities(lines, "Rates and fees", view.rates);
  quantities(lines, "Idle assets", view.idle);
  quantities(lines, "Reported liquidity", view.liquidity);
  quantities(lines, "Withdrawal constraints", view.withdrawalConstraints);
  quantities(lines, "Utilization", view.utilization.items);
  lines.push(view.utilization.label, "", "### Missing constraints", "", `Queue: ${code(view.queue.status)}.`, "");
  for (const missing of view.missing) lines.push(`- ${code(missing)}`);
  lines.push("", "Not computed: " + view.notComputed.map(code).join(", ") + ".", "");
  if (privateView) lines.push("Valuation: unknown (missing price).", "");
  for (const claim of view.claims) lines.push(`Claim ${code(claim.id)}: ${claim.claim ? quoted(claim.claim.text) : "not captured"}; result ${code(claim.result)}; scope ${quoted(claim.scope)}; claimed receipts ${claim.claimEvidenceIds.map(code).join(", ")}; observation receipts ${claim.observationEvidenceIds.map(code).join(", ")}.`, "");
}
function verdict(lines: string[], value: PublicPolicyVerdict | null) {
  lines.push("## Policy verdict", "");
  if (!value) { lines.push("Not evaluated.", ""); return; }
  lines.push(`${code(value.policyId)}: ${code(value.outcome)}, evaluated at ${code(value.evaluatedAt)}.`, "",
    "| Rule | Outcome | Reasons | Facts | Receipts |", "|---|---|---|---|---|");
  for (const r of value.rules) lines.push(`| ${code(r.ruleId)} (${code(r.kind)}) | ${code(r.outcome)} | ${r.reasons.map(reason => code(reason.code)).join(", ")} | ${r.factIds.map(code).join(", ")} | ${r.receiptIds.map(code).join(", ")} |`);
  lines.push("");
}
function unknowns(lines: string[], reasons: QueryReason[]) {
  lines.push("## Unknowns", "");
  for (const r of reasons) lines.push(`- ${code(r.code)}; subject ${code(r.subject ?? "unknown")}; ref ${code(r.ref ?? "none")}.`);
  if (!reasons.length) lines.push("No query gaps reported.");
  lines.push("");
}
function receipts(lines: string[], items: EvidenceReceipt[]) {
  lines.push("## Receipts", "");
  for (const r of items) lines.push(`- ${code(r.id)} — source ${code(r.source)}; observed ${code(r.observation.observedAt)}; block/slot ${code(r.observation.blockOrSlot ?? "unknown")}; historical state ${code(r.observation.historicalState)}; response hash ${code(r.responseSha256)}.`);
  lines.push("");
}
export function renderMarkdown(report: PublicPositionReport | PositionReport): string {
  const privateView = report.privacy === "private", view = privateView ? toPublicReview(report) : report;
  const lines = ["# Position review", "", privateView ? report.label : view.label, "", "## Snapshot", "",
    `${code(view.snapshot.id)}; constructed: ${view.snapshot.constructed}; observed ${code(view.snapshot.observedFrom)} to ${code(view.snapshot.observedTo)}; slots ${code(view.snapshot.fromBlockOrSlot ?? "unknown")} to ${code(view.snapshot.toBlockOrSlot ?? "unknown")}.`,
    `Evaluation time: ${code(view.asOf)}.`, ""];
  if (privateView) {
    lines.push("## Local positions", "");
    for (const p of report.positions) lines.push(`- ${code(p.position.id)}: ${code(p.position.quantity)} ${code(p.position.unit)}; subject ${code(p.position.subject)}; coverage ${code(p.coverage)}${p.coverageReason ? ` (${code(p.coverageReason)})` : ""}; source ${code(p.position.source)}; book snapshot ${code(p.position.snapshotId)}.`);
    lines.push("");
  }
  for (const subject of view.subjects) {
    lines.push(`## Chain ${code(subject.subject)}`, "");
    facts(lines, "Dependencies", subject.dependencyFacts);
    facts(lines, "Controllers", subject.controlFacts);
    facts(lines, "State", subject.stateFacts);
    if (subject.economics) economics(lines, subject.economics, privateView);
    else lines.push("Economics: no captured source.", "");
  }
  verdict(lines, view.verdict);
  unknowns(lines, view.subjects.flatMap(s => s.reasons));
  receipts(lines, [...new Map(view.subjects.flatMap(s => s.receipts).map(r => [r.id, r])).values()].sort((a, b) => cmp(a.id, b.id)));
  return lines.join("\n").trimEnd() + "\n";
}
