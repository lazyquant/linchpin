import { PROPOSAL_BRIDGE_CYPHER, GOVERNANCE_BRIDGE_CYPHER } from './graph-overview';
import type { GraphOverview, GraphOrigin, ProposalBridge, GovernanceBridge } from './graph-overview';
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const graphOriginText = (g: GraphOrigin) => g.source === 'neo4j' ? `Neo4j Aura · ${g.host}` : 'Local graph';
export function graphOverviewText(g: GraphOverview): string {
  const n = (v: number) => v.toLocaleString('en-US');
  return `${graphOriginText(g)} · ${n(g.nodes)} nodes · ${n(g.relationships)} relationships · governance cases ${n(g.byNamespace.governance)} · tokenomics ${n(g.byNamespace.tokenomics)}`;
}
let summary: GraphOverview | undefined;
let pending: Promise<void> | undefined;
export const graphBadge = () => `<span class="graph-badge" data-graph-summary>${esc(summary ? graphOverviewText(summary) : 'Reading graph counts…')}</span>`;
export function refreshGraphOverview(): Promise<void> {
  return pending ??= (async () => {
    try {
      const response = await fetch('/api/graph/summary');
      if (!response.ok) throw new Error('Graph counts unavailable');
      summary = await response.json() as GraphOverview;
      document.querySelectorAll<HTMLElement>('[data-graph-summary]').forEach(el => { el.textContent = graphOverviewText(summary!); el.title = summary!.reason ?? `Retrieved ${summary!.retrievedAt}`; });
    } catch {
      document.querySelectorAll<HTMLElement>('[data-graph-summary]').forEach(el => { el.textContent = 'Graph counts unavailable'; });
    }
  })().finally(() => { pending = undefined; });
}
const queryDetails = (cypher: string, params: object) => `<details><summary>Cypher</summary><pre>${esc(cypher)}</pre><strong>Parameters</strong><pre>${esc(JSON.stringify(params, null, 2))}</pre></details>`;
const provenance = (g: GraphOrigin) => `<p class="map-note">${esc(graphOriginText(g))} · retrieved ${esc(g.retrievedAt)}${g.reason ? ` · ${esc(g.reason)}` : ''}</p>`;
export function proposalBridgeCard(g?: ProposalBridge, error = '', caseId = ''): string {
  return `<article class="graph-card"><h3>Proposal → protocol dependencies</h3><p>Which accounts this case touches also carry the protocol's tokenomics, and in what role?</p>${g ? `${provenance(g)}${g.rows.length ? `<div class="table-wrap"><table class="graph-table"><thead><tr><th>Account</th><th>In this case as</th><th>In the protocol graph as</th><th>Protocol links</th></tr></thead><tbody>${g.rows.map(r => `<tr><td><button class="source-button" data-graph-entity="${esc(r.address)}" title="${esc(r.address)}">${esc(r.address.slice(0, 6))}…${esc(r.address.slice(-4))}</button></td><td>${esc(r.caseLabel)}<small>${esc(r.caseRole)}</small></td><td>${esc(r.tokenomicsType)} · ${esc(r.tokenomicsLabel)}</td><td>${r.links.map(esc).join('<br>') || '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="map-note">No shared accounts</p>'}<p class="map-note">${new Set(g.rows.map(r => r.address)).size} of this case's accounts appear in the protocol's tokenomics graph.</p>` : `<p class="map-note">${esc(error || 'Reading shared accounts…')}</p>`}${queryDetails(PROPOSAL_BRIDGE_CYPHER, { case: caseId })}</article>`;
}
export function governanceBridgeCard(g?: GovernanceBridge, error = ''): string {
  return `<article class="tg-query"><h3>Governance cases touching this graph</h3><p>Cases sharing accounts with the protocol's tokenomics.</p>${g ? `${provenance(g)}${g.rows.length ? `<div class="table-wrap"><table class="graph-table"><thead><tr><th>Case</th><th>Shared accounts</th><th>Entities in the cases</th><th>Protocol examples</th></tr></thead><tbody>${g.rows.map(r => `<tr><td><button class="source-button" data-case="${esc(r.caseId)}">${esc(r.caseId)}</button></td><td>${r.sharedAccounts.toLocaleString('en-US')}</td><td><details><summary>${r.entityLabels.length} entity labels</summary>${r.entityLabels.map(esc).join('<br>')}</details></td><td>${r.examples.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="map-note">No shared accounts</p>'}` : `<p class="map-note">${esc(error || 'Reading shared accounts…')}</p>`}${queryDetails(GOVERNANCE_BRIDGE_CYPHER, {})}</article>`;
}
