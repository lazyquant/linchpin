import { REVIEW_CSS } from "../review/style";
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
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}</title><style>${REVIEW_CSS}
.table-wrap{overflow-x:auto}td{overflow-wrap:anywhere}small{display:block;color:var(--mut)}h2{margin-top:28px}details{margin:8px 0}p{max-width:110ch}.coverage{font-weight:600}
</style></head><body><header><h1>${esc(p.title)}</h1><div class="sub">Realm <code>${esc(realm)}</code> · slots ${p.asOfSlotRange[0]}–${p.asOfSlotRange[1]} · ${p.offline ? "offline replay" : "live"} · ${p.evidenceCount} evidence records</div></header>
<h2>Research question</h2><p>${esc(p.researchQuestion)}</p>
<h2>Controllers</h2>${table(["Subject", "Role", "Authority", "Kind", "Path / finding", "Status", "Slot"], controllers)}
<h2>Statements</h2>${p.statements.map(s => `<article><h3>${esc(s.id)} · ${esc(s.status)}</h3><p>${esc(s.text)}</p><small>${esc(s.topic)} · slot ${esc(s.slot ?? "unknown")}</small><details><summary>Evidence</summary><code>${esc(s.evidenceIds.join("\n"))}</code></details></article>`).join("")}
<h2>Claims</h2>${table(["Verbatim text", "Source", "Retrieved at", "Checkable", "Status"], claims)}
<h2>Unknowns queue</h2><ul>${p.unknowns.map(u => `<li>${esc(u.text)}<small>First seen: ${esc(u.firstSeen)}</small></li>`).join("")}</ul>
<p class="coverage">${esc(coverageLine(p))}</p><footer>Generated ${esc(p.generatedAt)} by Linchpin. Coverage counts controller paths in the declared boundary. Slice A covers control and supply; value-route flows remain claims.</footer></body></html>`;
}
