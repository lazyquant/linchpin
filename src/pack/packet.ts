import { REVIEW_CSS } from "../review/style";
import { ledgerSummary, type LedgerEntry, type LedgerAssetSummary } from "./ledger";
import type { PackPacket } from "./model";
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const renderJson = (packet: PackPacket) => JSON.stringify(packet, null, 2);
export function coverageLine(p: PackPacket): string {
  const c = p.coverage;
  return `Coverage: ${c.total} controller paths · ${c.verified} verified · ${c.claimed} claimed · ${c.contradiction} contradiction · ${c.unresolved} unresolved`;
}
export function renderPackHtml(p: PackPacket, realm: string): string {
  const table = (headers: string[], rows: string[]) => `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const controllers = p.controllerPaths.map(r => `<tr><td><code>${esc(r.subject)}</code><small>${esc(r.subjectKind)}</small></td><td>${esc(r.role)}</td><td>${esc(r.authorityType)}<br><code>${esc(r.authority ?? "none")}</code></td><td>${esc(r.authorityKind)}</td><td><code>${r.path.map(esc).join(" → ")}</code><p>${esc(r.note)}</p><details><summary>Claims and evidence</summary>${r.claims.map(c => `<p>“${esc(c.text)}” · ${esc(c.source)}</p>`).join("")}<code>${esc(r.evidenceIds.join("\n"))}</code></details></td><td>${esc(r.status)}</td><td>${esc(r.slot ?? "unknown")}</td></tr>`);
  const claims = p.claims.map(c => `<tr><td>“${esc(c.text)}”<p class="notes">${esc(c.note)}</p></td><td>${esc(c.source)}</td><td>${esc(c.retrievedAt)}</td><td>${c.checkable ? "yes" : "no"}</td><td>${esc(c.status)}</td></tr>`);
  const short = (value: string | null, length = 12) => value == null ? "—" : value.length > length ? `${value.slice(0, length)}…` : value;
  const assetTable = (assets: LedgerAssetSummary[]) => table(["Asset mint", "External outflows", "Internal moves", "External inflows", "Burns", "Net DAO balance change", "Matched / mismatch / not-reconcilable / unsupported"], assets.map(a => `<tr><td><code>${esc(a.asset)}</code><small>Decimals: ${esc(a.decimals ?? "unknown")}</small></td>${[a.externalOutflowsDisplay, a.internalMovesDisplay, a.externalInflowsDisplay, a.burnsDisplay, a.netChangeOfDaoControlledBalanceDisplay].map(v => `<td>${esc(v)}</td>`).join("")}<td>${a.counts.matched} / ${a.counts.mismatch} / ${a.counts["not-reconcilable"]} / ${a.counts.unsupported}</td></tr>`));
  const entryTable = (entries: LedgerEntry[]) => table(["Kind / program", "Amount", "From → to / control", "Receipt status", "Evidence"], entries.map(e => `<tr><td>${esc(e.instructionLabel)}${e.category ? `<small>${esc(e.category)}</small>` : ""}<code>${esc(e.programId)}</code>${e.upgradeProgram ? `<small>Program account: ${esc(e.upgradeProgram)}</small>` : ""}</td><td>${esc(e.amountDisplay ?? "—")}<small title="${esc(e.asset)}">${esc(short(e.asset))}</small></td><td><code title="${esc(e.source)} → ${esc(e.destination)}">${esc(short(e.source))} → ${esc(short(e.destination))}</code><small>${esc(e.sourceControl)} → ${esc(e.destinationControl)}</small></td><td>${esc(e.reconciliation)}<small>${esc(e.basis)} · slot ${esc(e.slot ?? "unknown")}</small><code>${esc(e.receiptSignature)}</code><small>Observed account delta: ${esc(e.observedDeltaRaw ?? "unknown")} raw</small>${e.aggregateCount > 1 ? `<small>Aggregate expected delta: ${esc(e.aggregateExpectedDeltaRaw)} raw</small>` : ""}</td><td><details><summary>${e.evidenceIds.length} evidence records</summary><code>${esc(e.evidenceIds.join("\n"))}</code>${e.notes.map(n => `<p>${esc(n)}</p>`).join("")}</details></td></tr>`));
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of p.ledger.entries) { const group = groups.get(entry.proposal) ?? []; group.push(entry); groups.set(entry.proposal, group); }
  const ledgerGroups = [...groups].map(([address, entries]) => {
    const proposal = p.ledger.proposals.find(proposal => proposal.proposal === address);
    const timestamp = proposal?.votingCompletedAt ?? proposal?.executingAt ?? entries.find(e => e.executedAt != null)?.executedAt;
    const unsupported = entries.filter(e => e.kind === "unsupported");
    return `<article><h3>${esc(proposal?.name ?? entries[0].proposalName)}</h3><p>${timestamp == null ? "Date unknown" : esc(new Date(timestamp * 1000).toISOString().slice(0, 10))} · ${esc(proposal?.stateName ?? "State unknown")} · <code>${esc(address)}</code></p><h4>Proposal subtotals</h4>${assetTable(ledgerSummary(entries).assets)}${entryTable(entries.filter(e => e.kind !== "unsupported"))}${unsupported.length ? `<details><summary>Unsupported instructions (${unsupported.length})</summary>${entryTable(unsupported)}</details>` : ""}</article>`;
  }).join("");
  const countsLine = (counts: Record<string, number>) => Object.entries(counts).map(([kind, count]) => `${esc(kind)}: ${count}`).join(" · ");
  const ledgerProposals = p.ledger.proposals.map(p => `<tr><td title="${esc(p.proposal)}">${esc(short(p.name, 60))}</td><td>${esc(p.stateName)}</td><td>${esc(p.disposition)}</td></tr>`);
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}</title><style>${REVIEW_CSS}
.table-wrap{overflow-x:auto}td{overflow-wrap:anywhere}small{display:block;color:var(--mut)}h2{margin-top:28px}details{margin:8px 0}p{max-width:110ch}.coverage{font-weight:600}
</style></head><body><header><h1>${esc(p.title)}</h1><div class="sub">Realm <code>${esc(realm)}</code> · slots ${p.asOfSlotRange[0] ?? "unknown"}–${p.asOfSlotRange[1] ?? "unknown"} · ${p.offline ? "offline replay" : "live"} · ${p.evidenceCount} evidence records</div></header>
<h2>Research question</h2><p>${esc(p.researchQuestion)}</p>
<h2>Controllers</h2>${table(["Subject", "Role", "Authority", "Kind", "Path / finding", "Status", "Slot"], controllers)}
<h2>Statements</h2>${p.statements.map(s => `<article><h3>${esc(s.id)} · ${esc(s.status)}</h3><p>${esc(s.text)}</p><small>${esc(s.topic)} · slot ${esc(s.slot ?? "unknown")}</small><details><summary>Evidence</summary><code>${esc(s.evidenceIds.join("\n"))}</code></details></article>`).join("")}
<h2>DAO treasury ledger (from governance)</h2>
${assetTable(p.ledger.summary.assets)}
<p>Instruction counts: ${countsLine(p.ledger.summary.countsByKind)}</p>
<p>Unsupported categories: ${countsLine(p.ledger.summary.countsByCategory)}</p>
<p>Reconciliation counts: ${countsLine(p.ledger.summary.countsByReconciliation)}</p>
${p.ledger.notes.map(note => `<p>${esc(note)}</p>`).join("")}
<p>${p.ledger.proposalsScanned} proposals scanned · ${p.ledger.proposalsWithPayload} with payload</p>
${ledgerGroups}
<details><summary>Proposal coverage</summary>${table(["Proposal", "State", "Payload status"], ledgerProposals)}</details>
<h2>Claims</h2>${table(["Verbatim text", "Source", "Retrieved at", "Checkable", "Status"], claims)}
<h2>Unknowns queue</h2><ul>${p.unknowns.map(u => `<li>${esc(u.text)}<small>First seen: ${esc(u.firstSeen)}</small></li>`).join("")}</ul>
<p class="coverage">${esc(coverageLine(p))}</p><footer>Generated ${esc(p.generatedAt)} by Linchpin. Coverage counts controller paths in the declared boundary. The ledger covers governance payloads; broader value-route flows remain claims.</footer></body></html>`;
}
