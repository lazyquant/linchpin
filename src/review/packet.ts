import { formatUnits } from "../chain/token-layout";
import { sha256 } from "../chain/evidence";
import type { ProposalBundle } from "../governance/reader";
import type { Decoded } from "../governance/decode";
import type { Effect } from "../governance/effects";
import type { Receipt, Reconciliation } from "../governance/receipt";
import type { SimulationRun } from "../governance/simulate";
import type { Claim, Coverage } from "../governance/claims";
import type { Graph } from "../graph/model";
import { mermaid, controlPath } from "../graph/build";
import { checks, dimensions, type CheckRow, type Dimensions } from "./checks";

export type Packet = { caseId: string; title: string; generatedAt: string; offline: boolean; bindingSha256: string; proposal: ProposalBundle["proposal"]; governance: ProposalBundle["governance"]; realm: ProposalBundle["realm"]; claimed: Claim[]; decoded: Decoded[]; effects: Effect[]; simulated: SimulationRun[]; observed: { receipt: Receipt | null; reconciliation: Reconciliation }; coverage: Coverage[]; checks: CheckRow[]; dimensions: Dimensions; controlPath: string[]; graph: Graph; evidenceCount: number; reviewDecision: { status: "not-recorded"; note: string } };

export function bindingHash(b: ProposalBundle): string {
  return sha256(JSON.stringify(b.transactions.map((t) => ({ a: t.address, i: t.instructions.map((ix) => [ix.programId, ix.accounts, ix.dataHex]) }))));
}

export function buildPacket(args: { caseId: string; title: string; offline: boolean; bundle: ProposalBundle; decoded: Decoded[]; effects: Effect[]; sims: SimulationRun[]; receipt: Receipt | null; reconciliation: Reconciliation; claims: Claim[]; coverage: Coverage[]; graph: Graph; evidenceCount: number }): Packet {
  const b = args.bundle; const firstTa = Object.keys(b.tokenAccounts)[0];
  return { caseId: args.caseId, title: args.title, generatedAt: new Date().toISOString(), offline: args.offline, bindingSha256: bindingHash(b), proposal: b.proposal, governance: b.governance, realm: b.realm, claimed: args.claims, decoded: args.decoded, effects: args.effects, simulated: args.sims, observed: { receipt: args.receipt, reconciliation: args.reconciliation }, coverage: args.coverage, checks: checks(b, args.effects, args.coverage, args.reconciliation, args.receipt), dimensions: dimensions(b, args.effects, args.coverage, args.sims, args.reconciliation), controlPath: firstTa ? controlPath(args.graph, firstTa) : [], graph: args.graph, evidenceCount: args.evidenceCount, reviewDecision: { status: "not-recorded", note: "a human records approve / reject / needs-work against bindingSha256; a changed payload invalidates it" } };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const ts = (t: number | null) => (t == null ? "—" : new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC");

const short = (address: string) => `<span title="${esc(address)}">${esc(address.slice(0, 6))}…</span>`;

function decodedLine(d: Decoded, index: number, effects: Effect[]): string {
  if (d.kind === "unsupported") return `Unsupported instruction · program ${short(d.program)} · ${esc(d.reason)} <code>${esc(d.dataHex)}</code>`;
  if (d.kind === "setAuthority") return `Set ${esc(d.authorityType)} authority of ${short(d.target)}: ${short(d.currentAuthority)} → ${d.newAuthority == null ? "none" : short(d.newAuthority)}`;
  const effect = effects.find((e) => e.id === `fx-${index}-${d.kind === "transfer" ? "move" : "supply"}`);
  const decimals = effect?.detail.decimals ?? (d.kind === "burn" ? null : d.decimals);
  const amount = typeof decimals === "number" ? formatUnits(d.amountRaw, decimals) : `${d.amountRaw} raw`;
  if (d.kind === "burn") return `Burn ${amount} ${short(d.mint)} from ${short(d.source)} · authority ${short(d.authority)} · program ${short(d.program)}`;
  if (d.kind === "mintTo") return `Mint ${amount} to ${short(d.destination)} · authority ${short(d.authority)}`;
  const mint = d.mint ?? effect?.detail.asset;
  return `Transfer ${amount} ${typeof mint === "string" ? short(mint) : "tokens"} from ${short(d.source)} to ${short(d.destination)} · authority ${short(d.authority)}`;
}

export function renderHtml(p: Packet): string {
  const col = (title: string, basis: string, body: string) => `<section class="col ${basis}"><h2>${title}<small>${basis}</small></h2>${body}</section>`;
  const claimed = p.claimed.length ? `<ul>${p.claimed.map((c) => `<li>“${esc(c.text)}” <span class="src">${esc(c.source)} · ${esc(c.retrievedAt)}</span></li>`).join("")}</ul>` : "<p>No claims captured.</p>";
  const decoded = p.decoded.length ? `<ul>\n${p.decoded.map((d, i) => `<li>${decodedLine(d, i, p.effects)}</li>`).join("\n")}\n</ul>` + `<ul>${p.effects.map((e) => `<li>${esc(e.type)}: ${esc(e.detail.display ?? e.detail.amountDisplay ?? e.detail.reason)} ${e.flags.length ? `<em>[${esc(e.flags.join(", "))}]</em>` : ""}</li>`).join("")}</ul>` : "<p>No executable payload: this proposal is signaling only. Execution is unverified by definition.</p>";
  const simulated = p.simulated.length ? p.simulated.map((s) => `<div class="sim ${s.success ? "ok" : "fail"}"><b>${esc(s.kind)}</b> · ${s.success ? "success" : "failed"} · slot ${s.contextSlot} · ${esc(s.label)}<details><summary>assumptions and logs</summary><ul>${s.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul><pre>${esc(s.logs.join("\n"))}</pre>${s.error ? `<pre>${esc(JSON.stringify(s.error))}</pre>` : ""}</details></div>`).join("") : "<p>Not simulated.</p>";
  const r = p.observed.receipt; const rec = p.observed.reconciliation;
  const observed = r ? `<p><b>${esc(rec.status)}</b> · tx <code>${esc(r.signature)}</code> · slot ${r.slot} · ${ts(r.blockTime)}</p><ul>${r.tokenBalances.map((b) => `<li>${esc(b.account.slice(0, 8))}… ${esc(b.preRaw)} → ${esc(b.postRaw)} (Δ ${esc(b.deltaRaw)})</li>`).join("")}</ul>${rec.notes.length ? `<ul class="notes">${rec.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}` : `<p>${esc(rec.status)}: ${esc(rec.notes.join("; "))}</p>`;
  const checksHtml = `<table><tr><th>Check</th><th>Result</th><th>Basis</th><th>Review</th></tr>${p.checks.map((c) => `<tr class="${c.needsReview ? "review" : ""}"><td>${esc(c.check)}</td><td>${esc(c.result)}</td><td>${esc(c.basis)}</td><td>${c.needsReview ? "needs review" : "—"}</td></tr>`).join("")}</table>`;
  const dims = `<table>${Object.entries(p.dimensions).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
  const path = p.controlPath.length ? `<ol class="path">${p.controlPath.map((n) => `<li>${esc(p.graph.nodes.find((x) => x.id === n)?.label ?? n)}</li>`).join("")}</ol>` : "<p>No token account in the payload; no control path.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Linchpin review · ${esc(p.title)}</title>
<style>:root{--bg:#0f1115;--fg:#e8e8e8;--mut:#9aa0a6;--claimed:#c9a227;--decoded:#4f8ef7;--simulated:#a66bff;--observed:#2fb673;--unknown:#777;--border:#2a2f3a;--review:#2a2316}body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}h1{margin:0 0 4px}.sub{color:var(--mut);margin-bottom:20px}.cols{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.col{border:1px solid var(--border);border-radius:10px;padding:12px;min-height:160px}.col h2{font-size:15px;margin:0 0 8px;display:flex;justify-content:space-between}.col h2 small{font-weight:400;color:var(--mut)}.claimed h2{color:var(--claimed)}.decoded h2{color:var(--decoded)}.simulated h2{color:var(--simulated)}.observed h2{color:var(--observed)}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}tr.review td{background:var(--review)}code,pre{font:12px/1.4 ui-monospace,monospace;word-break:break-all;white-space:pre-wrap}.sim{border-left:3px solid var(--simulated);padding:6px 10px;margin:6px 0}.sim.fail{border-color:#e05555}.src{color:var(--mut);font-size:12px}.path li{margin:4px 0}.notes{color:var(--mut)}footer{color:var(--mut);margin-top:24px;font-size:12px}@media(max-width:900px){.cols{grid-template-columns:1fr}}@media (prefers-color-scheme: light){:root{--bg:#ffffff;--fg:#111;--mut:#666;--border:#ddd;--review:#fff6d6}}:root[data-theme="light"]{--bg:#ffffff;--fg:#111;--mut:#666;--border:#ddd;--review:#fff6d6}</style>
<script>if(new URLSearchParams(location.search).get("theme")==="light")document.documentElement.dataset.theme="light";</script></head><body>
<h1>${esc(p.title)}</h1><div class="sub">${esc(p.realm.name)} · proposal <code>${esc(p.proposal.address)}</code> · state ${esc(p.proposal.stateName)} · voting ${ts(p.proposal.votingAt)} → ${ts(p.proposal.votingCompletedAt)} · executed ${ts(p.proposal.executingAt)} · ${p.offline ? "offline replay" : "live"} · ${p.evidenceCount} evidence records · binding <code>${esc(p.bindingSha256.slice(0, 16))}…</code></div>
<div class="cols">${col("Claimed", "claimed", claimed)}${col("Decoded", "decoded", decoded)}${col("Simulated", "simulated", simulated)}${col("Observed", "observed", observed)}</div>
<h2>Control path</h2>${path}
<h2>Checks</h2>${checksHtml}
<h2>Review dimensions (kept separate)</h2>${dims}
<h2>Review decision</h2><p>${esc(p.reviewDecision.status)} — ${esc(p.reviewDecision.note)}</p>
<details><summary>Graph (mermaid source)</summary><pre class="mermaid">${esc(mermaid(p.graph))}</pre></details>
<footer>Generated ${esc(p.generatedAt)} by Linchpin. A simulation is a conditional preview, not proof of authorization or safety. Historical proposals are shown under today's state unless a receipt is present.</footer>
<script>if(navigator.onLine){const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";s.onload=()=>mermaid.initialize({startOnLoad:true,theme:"dark"});document.body.appendChild(s)}</script>
</body></html>`;
}
