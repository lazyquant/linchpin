import type { View, Source, Finding, Path, CaseId } from './model';
import type { StateDiff } from './diff';
import type { Run } from './runner';
type Scope = { id: CaseId; label: string; kind: string; question: string; ready: boolean; hasLive: boolean };
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const short = (v: string, n = 7) => v.length > n * 2 ? `${v.slice(0, n)}…${v.slice(-4)}` : v;
const day = (v: string) => v ? v.slice(0, 10) : 'date unavailable';
let scopes: Scope[] = [], active: CaseId = 'marinade', view: View | null = null, tab = 'findings', pathIndex = 0, filter = 'all', showAll = false;
let run: Run | null = null, inspecting = 'activity', ledgerQuery = '', sourceQuery = '', sourceRequest = 0;
const runs = new Map<CaseId, Run>();
const selections = new Map<CaseId, 'captured' | 'live'>();
const selectedSource = () => selections.get(active) ?? 'captured';
let viewRequest = 0;
async function api<T>(url: string, init?: RequestInit): Promise<T> { const r = await fetch(url, init); if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error ?? `Request failed (${r.status}). Check the local server.`); } return r.json(); }
function notice(message: string) { $('#notice').textContent = message; $('#notice').classList.add('visible'); setTimeout(() => $('#notice').classList.remove('visible'), 4200); }
function animate(el: HTMLElement) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
function exportUrl(file: string) { return `/api/cases/${active}/export/${file}?source=${selectedSource()}`; }
function setTab(next: string) { tab = next; document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === next))); $('#content').setAttribute('aria-label', next === 'map' ? 'Control map' : next); render(); animate($('#content')); }
async function load(id: CaseId, source = selections.get(id) ?? 'captured') {
  selections.set(id, source); const request = ++viewRequest; ++sourceRequest;
  active = id; view = null; pathIndex = 0; filter = 'all', showAll = false; ledgerQuery = ''; run = runs.get(id) ?? null; inspecting = 'activity';
  history.replaceState(null, '', `/#${id}`); renderCases();
  const scope = scopes.find(c => c.id === id)!;
  $('#case-title').textContent = scope.label; $('#case-kind').textContent = scope.kind; $('#question').textContent = scope.question;
  $('#content').innerHTML = '<p class="empty">Opening the completed evidence…</p>'; $('#capture').textContent = ''; $('#evidence-count').textContent = ''; activity(); updateRun();
  try { const data = await api<View>(`/api/cases/${id}?source=${source}`); if (active !== id || request !== viewRequest) return; view = data; updateHeader(); render(); activity(); }
  catch (error) { if (active === id && request === viewRequest) $('#content').innerHTML = `<p class="error">${esc((error as Error).message)}</p>`; }
}
function renderCases() { $('#cases').innerHTML = scopes.map(c => `<button class="case-button ${c.id === active ? 'selected' : ''}" data-case="${c.id}" ${c.id === active ? 'aria-current="true"' : ''}>${esc(c.label)}<small>${esc(c.kind)}</small></button>`).join(''); }
function updateRun() {
  const current = runs.get(active), busy = current?.status === 'running';
  $('#run').textContent = busy && current?.source !== 'live' ? 'Research running…' : 'Run research ↗';
  $('#refresh').textContent = busy && current?.source === 'live' ? 'Refreshing…' : 'Refresh from chain ↗';
  ($('#run') as HTMLButtonElement).disabled = busy; ($('#refresh') as HTMLButtonElement).disabled = busy;
  $('#source-toggle').hidden = !scopes.find(c => c.id === active)?.hasLive;
  document.querySelectorAll<HTMLButtonElement>('[data-view-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.viewSource === selectedSource())));
}
function updateHeader() {
  if (!view) return;
  updateRun();
  $('#capture').textContent = view.freshness.source === 'live' ? `Live read ${view.freshness.retrievedAt.at(-1)} · slot ${view.freshness.slotRange[1] ?? 'unknown'} · ${view.freshness.rpcHost} · ${view.freshness.liveReads} reads` : `Captured ${day(view.capturedRange[0])}${day(view.capturedRange[0]) !== day(view.capturedRange[1]) ? ` – ${day(view.capturedRange[1])}` : ''} · offline replay`;
  $('#evidence-count').textContent = `${view.evidenceCount.toLocaleString()} evidence records`;
  $('#generation').textContent = `Built ${new Date(view.generatedAt).toLocaleTimeString()} · draft`;
}
function render() {
  if (!view) return;
  if (tab === 'findings') renderFindings();
  else if (tab === 'map') renderMap();
  else if (tab === 'timeline') renderTimeline();
  else renderMemo();
}
function diffPanel() {
  if (view?.freshness.source !== 'live') return '';
  const rows = view.stateDiff ?? [], changed = rows.filter(r => r.changed), unchanged = rows.filter(r => !r.changed);
  const table = (facts: StateDiff[]) => `<div class="table-wrap"><table class="state-diff"><thead><tr><th>Fact</th><th>Captured · slot, time</th><th>Current · slot, time</th><th></th></tr></thead><tbody>${facts.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.captured)}<small>Slot ${r.capturedSlot ?? 'unknown'}<br>${esc(r.capturedAt ?? 'Time unavailable')}</small></td><td>${esc(r.current)}<small>Slot ${r.currentSlot ?? 'unknown'}<br>${esc(r.currentAt ?? 'Time unavailable')}</small></td><td>${r.changed ? '<span class="changed-badge">changed</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  return `<section class="diff-panel"><div class="section-intro"><div><h2>Current vs captured</h2><p>${changed.length} changed facts · exact values with capture provenance</p></div></div>${changed.length ? table(changed) : '<p class="map-note">Nothing changed since capture.</p>'}${unchanged.length ? `<details><summary>${unchanged.length} unchanged facts · show</summary>${table(unchanged)}</details>` : ''}</section>`;
}
function liveMemoHeader() {
  return view ? `Live read at ${view.freshness.retrievedAt.at(-1)}, slot ${view.freshness.slotRange[1] ?? 'unknown'}, host ${view.freshness.rpcHost} · captured baseline ${(view.baselineRange ?? []).join(' — ')}` : '';
}
function renderFindings() {
  if (!view) return;
  const matched = view.findings.filter(f => filter === 'all' || filter === 'review' && ['unresolved', 'contradiction', 'needs review', 'conditional'].includes(f.status) || filter === 'supply' && /supply/i.test(`${f.title} ${f.text}`));
  const selected = filter === 'all' && !showAll && view.id === 'marinade' ? matched.slice(0, 6) : matched;
  $('#content').innerHTML = `${diffPanel()}<div class="section-intro"><div><h2>Findings & evidence</h2><p>Each finding retains its basis and supporting records.</p></div><select class="filter" id="finding-filter" aria-label="Filter findings"><option value="all">All findings</option><option value="review">Needs review</option><option value="supply">Token supply</option></select></div>${selected.map((f, i) => `<article class="finding" id="finding-${esc(f.id)}"><span class="number">${String(i + 1).padStart(2, '0')}</span><div><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p><div class="meta"><span class="status ${['unresolved', 'contradiction', 'needs review', 'conditional'].includes(f.status) ? 'review' : ''}">${esc(f.status)}</span><span>${esc(f.basis)}</span><button class="source-button" data-finding="${esc(f.id)}">Inspect sources · ${f.sourceIds.length} ↗</button></div></div></article>`).join('')}${!selected.length ? '<p class="empty">No findings match this filter.</p>' : ''}${matched.length > selected.length ? `<button id="show-all" class="secondary" style="margin-top:22px">Show all ${matched.length} findings ↓</button>` : ''}`;
  $('#finding-filter') && (($('#finding-filter') as HTMLSelectElement).value = filter);
}
function mapPaths(): Path[] {
  if (!view) return [];
  const paths = [...view.paths];
  const fx = view.graph.nodes.find(n => n.type === 'Effect' && n.label.startsWith('treasuryMovement'));
  if (fx) {
    const nodes = [fx.id]; let cur = fx.id;
    for (const edgeType of ['PRODUCES', 'CONTAINS_INSTRUCTION', 'HAS_TRANSACTION']) { const e = view.graph.edges.find(e => e.to === cur && e.type === edgeType); if (!e) break; nodes.unshift(e.from); cur = e.from; }
    const affects = view.graph.edges.find(e => e.from === fx.id && e.type === 'AFFECTS'); if (affects) nodes.push(affects.to);
    const edgeIds = view.graph.edges.filter(e => nodes.includes(e.from) && nodes.includes(e.to)).flatMap(e => e.evidenceIds);
    paths.push({ label: 'Proposal payload → economic effect', nodeIds: nodes, sourceIds: [...new Set(edgeIds)], status: 'decoded', note: 'Decoded instructions produce a token movement or supply effect. Execution receipts are inspected separately in the timeline.' });
  }
  return paths;
}
function renderMap() {
  if (!view) return;
  const paths = mapPaths(); const path = paths[pathIndex];
  if (!path) { $('#content').innerHTML = '<div class="section-intro"><h2>Control map</h2></div><p class="empty">This signaling proposal contains no executable token payload. There is no token movement control path to display.</p>'; return; }
  const coords = path.nodeIds.map((_, i) => ({ x: 18 + (Math.floor(i / 3) % 2 ? 2 - i % 3 : i % 3) * 220, y: 30 + Math.floor(i / 3) * 140 }));
  const height = Math.max(230, Math.ceil(path.nodeIds.length / 3) * 140 + 20);
  const lines = path.nodeIds.slice(1).map((id, i) => {
    const a = coords[i], b = coords[i + 1]; const edge = view!.graph.edges.find(e => e.from === path.nodeIds[i] && e.to === id);
    const sameRow = a.y === b.y, forward = b.x > a.x;
    const d = sameRow ? `M${forward ? a.x + 198 : a.x},${a.y + 36} L${forward ? b.x : b.x + 198},${b.y + 36}` : `M${a.x + 99},${a.y + 72} L${b.x + 99},${b.y}`;
    return `<path d="${d}" stroke="#8cac92" stroke-width="1.3" fill="none" marker-end="url(#arrow)"/><text x="${sameRow ? (a.x + b.x) / 2 + 99 : a.x + 110}" y="${sameRow ? a.y + 25 : a.y + 109}" text-anchor="${sameRow ? 'middle' : 'start'}" font-size="7" fill="#6b806f">${esc(edge?.type.replaceAll('_', ' ').toLowerCase() ?? 'control path')}</text>`;
  }).join('');
  const nodes = path.nodeIds.map((id, i) => { const n = view!.graph.nodes.find(n => n.id === id); const p = coords[i]; return `<g class="graph-node" role="button" tabindex="0" aria-label="Inspect ${esc(n?.label ?? id)}" data-node="${esc(id)}"><rect x="${p.x}" y="${p.y}" width="198" height="72" rx="4" fill="${i === 0 ? '#dfebdc' : '#fcfcf9'}" stroke="#cad8c9"/><text x="${p.x + 14}" y="${p.y + 19}" font-size="8" letter-spacing="1" fill="#6e8373">${esc(n?.type.toUpperCase() ?? 'ACCOUNT')}</text><text x="${p.x + 14}" y="${p.y + 39}" font-size="11" fill="#253e2d">${esc((n?.label ?? 'Account').slice(0, 28))}${(n?.label.length ?? 0) > 28 ? '…' : ''}</text><text x="${p.x + 14}" y="${p.y + 57}" font-family="monospace" font-size="8" fill="#6b7c6f">${esc(short(String(n?.props?.address ?? id.split(':').at(-1)), 9))}</text></g>`; }).join('');
  const edges = view.graph.edges.filter(e => path.nodeIds.includes(e.from) && path.nodeIds.includes(e.to));
  $('#content').innerHTML = `<div class="section-intro"><div><h2>Control & consequence</h2><p>Click an account or a relation to inspect its evidence.</p></div></div><div class="map-toolbar"><select id="path-select" aria-label="Select graph path">${paths.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('')}</select><a class="source-button" href="${exportUrl('graph.json')}">Export graph ↗</a></div><div class="graph-surface"><svg class="graph-svg" viewBox="0 0 675 ${height}" aria-label="${esc(path.label)}"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#8cac92"/></marker></defs>${lines}${nodes}</svg></div><p class="map-note">${esc(path.note)}<br>Path status: ${esc(path.status)}. This map is built from the declared boundary and decoded records.</p><div class="relation-list">${edges.map((e, i) => `<div class="relation"><strong>${esc(e.type.replaceAll('_', ' ').toLowerCase())}</strong><span>${esc(e.basis)} · ${(e.props?.status ? esc(e.props.status) + ' · ' : '')}<button class="source-button" data-edge="${i}">Inspect ${e.evidenceIds.length} records</button></span></div>`).join('')}</div>`;
  ($('#path-select') as HTMLSelectElement).value = String(pathIndex);
}
function renderTimeline() {
  if (!view) return;
  if (view.ledger) {
    const ledger = view.ledger;
    const selected = ledger.entries.filter(e => !ledgerQuery || `${e.proposalName} ${e.instructionLabel} ${e.asset} ${e.source} ${e.destination} ${e.reconciliation}`.toLowerCase().includes(ledgerQuery.toLowerCase()));
    $('#content').innerHTML = `<div class="section-intro"><div><h2>Governance treasury ledger</h2><p>${ledger.proposalsScanned} proposals scanned · ${ledger.entries.length} instruction rows · governance executions only</p></div></div><div class="table-wrap"><table><thead><tr><th>Asset mint</th><th>External outflows</th><th>Internal moves</th><th>Burns</th><th>Net DAO change</th></tr></thead><tbody>${ledger.summary.assets.map(a => `<tr><td title="${esc(a.asset)}">${esc(short(a.asset))}<small>${a.decimals ?? '?'} decimals</small></td><td>${esc(a.externalOutflowsDisplay)}</td><td>${esc(a.internalMovesDisplay)}</td><td>${esc(a.burnsDisplay)}</td><td>${esc(a.netChangeOfDaoControlledBalanceDisplay)}</td></tr>`).join('')}</tbody></table></div><p class="map-note">${view.freshness.source === 'live' ? 'This ledger replays committed historical fixtures; its proposals and receipts were not refreshed. ' : ''}Totals include reconciled, observed token flows. Internal moves do not reduce combined DAO holdings. Unsupported instructions remain separate.</p><div class="ledger-controls"><input id="ledger-search" type="search" placeholder="Search proposal, mint, account or receipt status" aria-label="Search ledger" value="${esc(ledgerQuery)}"></div><p class="map-note">Showing ${Math.min(selected.length, 60)} of ${selected.length} matching rows. Full ledger included in <a href="${exportUrl('packet.json')}">packet.json</a>.</p><div id="ledger-rows">${selected.slice(0, 60).map(e => `<article class="ledger-row"><button class="source-button" data-ledger="${ledger.entries.indexOf(e)}">Sources ↗</button><h3>${esc(e.proposalName)}</h3><p>${esc(e.instructionLabel)} · ${esc(e.amountDisplay ?? 'no token amount')}<br>${esc(short(e.asset ?? 'no asset'))} · ${esc(e.sourceControl)} → ${esc(e.destinationControl)}<br>${esc(e.reconciliation)} · ${esc(e.basis)} · slot ${e.receiptSlot ?? e.slot ?? 'unknown'}</p></article>`).join('')}</div>`;
  } else $('#content').innerHTML = `<div class="section-intro"><div><h2>Proposal → execution</h2><p>Historical events from the proposal account and execution receipts.</p></div></div>${view.timeline.map((t, i) => `<article class="timeline-item"><h3>${esc(t.label)}</h3><time>${esc(t.time)}</time><p>${esc(t.detail)}</p><button class="source-button" data-timeline="${i}">Inspect evidence ↗</button></article>`).join('')}`;
}
function renderMemo() {
  if (!view) return;
  const refs = [...new Set(view.findings.flatMap(f => f.sourceIds))];
  $('#content').innerHTML = `<div class="memo-toolbar"><span class="status">Draft · human review pending</span><a class="secondary" href="${exportUrl('memo.md')}">Export memo ↓</a><button id="print-memo" class="secondary">Print / save PDF</button></div><article class="memo"><h2>${esc(view.title)} — research memo</h2><p>${esc(view.question)}</p><p>${view.freshness.source === 'live' ? esc(liveMemoHeader()) : `Recorded evidence captured ${view.capturedRange.map(day).join(' — ')}. ${view.evidenceCount.toLocaleString()} evidence records. Generated ${esc(view.generatedAt)}.`}</p>${view.freshness.source === 'live' ? `<h3>What changed since capture</h3>${view.changedCount ? `<ul>${view.stateDiff!.filter(r => r.changed).map(r => `<li>${esc(r.label)}: ${esc(r.captured)} → ${esc(r.current)}</li>`).join('')}</ul>` : '<p>Nothing changed since capture</p>'}` : ''}<h3>Findings</h3>${view.findings.map(f => `<section><h4>${esc(f.title)}</h4><p>${esc(f.text)} ${f.sourceIds.map(id => `<button class="citation" data-source="${esc(id)}" aria-label="Inspect citation ${refs.indexOf(id) + 1}">[${refs.indexOf(id) + 1}]</button>`).join('')}</p><p class="source-meta">${esc(f.basis)} · ${esc(f.status)}</p></section>`).join('')}<h3>Unknowns & next evidence</h3><ul>${view.unknowns.map(u => `<li>${esc(u)}</li>`).join('')}</ul><h3>Source manifest</h3><p class="sources">${refs.map((id, i) => `[${i + 1}] ${esc(id)}`).join('<br>')}</p><p>Deterministic synthesis from the local checks. No live language model is used. Code references describe the decoder implementation, not a full smart-contract source audit.</p></article>`;
}
function activity() {
  inspecting = 'activity'; $('#inspector-title').textContent = 'Research activity';
  const current = runs.get(active);
  $('#inspector-body').innerHTML = current ? `<p class="activity-note">${current.status === 'running' ? current.source === 'live' ? 'Reading current state through the configured endpoint.' : 'Rebuilding the case from recorded evidence.' : current.status === 'completed' ? 'Research complete. Findings and the memo use this run’s results.' : esc(current.error)}<br><strong>${current.source === 'live' ? `Live · ${esc(current.rpcHost ?? 'host unavailable')} · ${current.events.at(-1)?.liveReads ?? current.events.filter(e => e.liveReads != null).at(-1)?.liveReads ?? 0} reads` : 'Offline · deterministic pipeline'}</strong></p><ol class="activity-list">${current.events.map(e => `<li><time>${esc(e.at.slice(11, 23))} UTC${e.evidenceCount != null ? ` · ${e.evidenceCount} records · ${e.liveReads ?? 0} live reads` : ''}</time>${esc(e.message)}</li>`).join('')}</ol>` : `<p class="activity-note">A completed example is open.<br>Run research to rebuild its findings and memo from the recorded inputs.</p><ol class="activity-list"><li>Read documented claims</li><li>Resolve controllers & decode instructions</li><li>Check recorded state & execution</li><li>Assemble cited findings and draft memo</li></ol><p class="activity-note">Data freshness is shown above. Replaying fixtures does not refresh the chain snapshot.</p>`;
  animate($('#inspector-body'));
}
async function inspectSources(title: string, ids: string[], code: string[] = [], context = '') {
  $('#inspector').classList.add('open'); inspecting = 'sources'; const request = ++sourceRequest; const caseId = active;
  $('#inspector-title').textContent = 'Evidence inspector';
  $('#inspector-body').innerHTML = `<p class="activity-note">${esc(title)}</p><p class="activity-note">Opening supporting records…</p>`;
  const query = ids.slice(0, 80).map(id => `id=${encodeURIComponent(id)}`).join('&');
  try {
    const data = ids.length ? await api<{items: Source[]; total: number; more: boolean}>(`/api/cases/${caseId}/sources?source=${selectedSource()}&${query}`) : {items: [], total: 0, more: false};
    if (request !== sourceRequest || caseId !== active || inspecting !== 'sources') return;
    if (ids.length > 80) { data.more = true; data.total = ids.length; }
    $('#inspector-body').innerHTML = `<p class="activity-note"><strong>${esc(title)}</strong>${context ? `<br>${esc(context)}` : ''}</p>${code.length ? `<div class="inspector-label">CODE / LOCAL RULES</div>${code.map(c => `<code class="code-ref">${esc(c)}</code>`).join('')}<p class="activity-note">These implement the check; they are not audited protocol source.</p>` : ''}${data.items.length ? data.items.map(sourceHtml).join('') : '<p class="activity-note">No direct supporting record is attached to this item. Treat it as unresolved or a research assumption.</p>'}${data.more ? `<p class="activity-note">Showing ${data.items.length} of ${data.total} records. Export the full evidence log below.</p>` : ''}<p class="inspector-label">REPRODUCIBLE EXPORTS</p><a class="source-button" href="${exportUrl('evidence.jsonl')}">Evidence log ↓</a> · <a class="source-button" href="${exportUrl('packet.json')}">Full packet ↓</a>`;
    animate($('#inspector-body'));
  } catch (e) { if (request === sourceRequest) $('#inspector-body').innerHTML = `<p class="error">${esc((e as Error).message)}</p>`; }
}
function sourceHtml(s: Source) { return `<details class="source-item"><summary>${s.kind === 'docs' ? 'DOCS / CLAIM' : 'DATA / RECORDED RESPONSE'}<br>${esc(s.title)}</summary><div class="source-meta">Captured ${esc(s.capturedAt)}<br>Slot ${s.slot ?? 'not applicable'}</div><code>ID ${esc(s.id)}${s.hash ? `<br>SHA-256 ${esc(s.hash)}` : ''}</code><pre>${esc(JSON.stringify(s.detail, null, 2))}</pre>${s.url ? `<a class="source-button" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Original source ↗</a>` : ''}</details>`; }
async function browseSources(q = '') {
  $('#inspector').classList.add('open'); inspecting = 'browse'; const request = ++sourceRequest, caseId = active;
  $('#inspector-title').textContent = 'Source library';
  if (!$('#source-search')) $('#inspector-body').innerHTML = '<input id="source-search" class="source-search" type="search" aria-label="Search evidence" placeholder="Search method, account, date or slot"><div id="source-results"></div>';
  try { const data = await api<{items: Source[]; total: number; more: boolean}>(`/api/cases/${caseId}/sources?source=${selectedSource()}&q=${encodeURIComponent(q)}`); if (request !== sourceRequest || caseId !== active || inspecting !== 'browse') return; $('#source-results').innerHTML = `<p class="activity-note">${data.total} matching sources${data.more ? ' · first 150 shown' : ''}</p>${data.items.map(sourceHtml).join('')}`; } catch (e) { notice((e as Error).message); }
}
async function startRun(source: 'captured' | 'live' = 'captured') {
  const caseId = active; if (source === 'live') await load(caseId, 'captured'); $('#inspector').classList.add('open'); inspecting = 'activity';
  try {
    const current = await api<Run>(`/api/cases/${caseId}/${source === 'live' ? 'refresh' : 'run'}`, {method: 'POST'}); runs.set(caseId, current); run = current; updateRun(); activity();
    const poll = async () => {
      try {
        const next = await api<Run>(`/api/runs/${current.id}`); runs.set(caseId, next);
        if (active === caseId) { run = next; updateRun(); if (inspecting === 'activity') activity(); }
        if (next.status === 'running') { setTimeout(poll, 300); return; }
        if (next.status === 'completed') {
          if (next.source === 'live') scopes.find(c => c.id === caseId)!.hasLive = true;
          if (active === caseId) { await load(caseId, next.source ?? 'captured'); notice(next.source === 'live' ? 'Live evidence captured. Compare current state with the captured example.' : 'Research complete. The captured example is open.'); }
        } else if (active === caseId) { await load(caseId, 'captured'); activity(); notice(next.error ?? 'Research failed.'); }
      } catch (e) { current.status = 'failed'; current.error = 'Connection to the local research server was interrupted.'; runs.set(caseId, current); updateRun(); if (active === caseId) { activity(); notice((e as Error).message); } }
    }; void poll();
  } catch (e) { notice((e as Error).message); }
}
document.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('button,a,[data-node]'); if (!target) return;
  if (target.dataset.case) void load(target.dataset.case as CaseId);
  else if (target.dataset.tab) setTab(target.dataset.tab);
  else if (target.id === 'run') void startRun();
  else if (target.id === 'refresh') void startRun('live');
  else if (target.dataset.viewSource) void load(active, target.dataset.viewSource as 'captured' | 'live');
  else if (target.id === 'open-example') { setTab('findings'); void load(active, 'captured'); }
  else if (target.id === 'activity-button') { $('#inspector').classList.add('open'); activity(); }
  else if (target.id === 'close-inspector') $('#inspector').classList.remove('open');
  else if (target.id === 'show-all') { showAll = true; renderFindings(); }
  else if (target.id === 'sources-button') void browseSources();
  else if (target.id === 'workflow-button') { $('#workflow').classList.toggle('expanded'); $('#workflow').scrollIntoView({behavior:'smooth', block:'center'}); }
  else if (target.id === 'print-memo') window.print();
  else if (target.dataset.finding && view) { const f = view.findings.find(f => f.id === target.dataset.finding)!; document.querySelectorAll('.finding').forEach(el => el.classList.toggle('selected', el.id === `finding-${f.id}`)); void inspectSources(f.title, f.sourceIds, f.code, `Basis: ${f.basis}; status: ${f.status}.`); }
  else if (target.dataset.source) void inspectSources('Memo citation', [target.dataset.source]);
  else if (target.dataset.node && view) { const n = view.graph.nodes.find(n => n.id === target.dataset.node)!; const edges = view.graph.edges.filter(e => e.from === n.id || e.to === n.id); void inspectSources(n.label, [...new Set(edges.flatMap(e => e.evidenceIds))], [], `${n.type} · ${n.id}`); }
  else if (target.dataset.edge && view) { const path = mapPaths()[pathIndex]; const edges = view.graph.edges.filter(e => path.nodeIds.includes(e.from) && path.nodeIds.includes(e.to)); const e = edges[Number(target.dataset.edge)]; void inspectSources(e.type, e.evidenceIds, [], `${e.basis} · ${String(e.props?.status ?? '')}`); }
  else if (target.dataset.timeline && view) { const t = view.timeline[Number(target.dataset.timeline)]; void inspectSources(t.label, t.sourceIds, ['src/governance/receipt.ts'], t.detail); }
  else if (target.dataset.ledger && view?.ledger) { const e = view.ledger.entries[Number(target.dataset.ledger)]; void inspectSources(e.proposalName, e.evidenceIds, ['src/pack/ledger.ts'], `${e.instructionLabel} · ${e.reconciliation}; raw amount ${e.amountRaw ?? 'none'}; ${e.notes.join('; ')}`); }
  else if (target.dataset.follow && view) {
    if (target.dataset.follow === 'control') { setTab('map'); const p = mapPaths()[pathIndex]; if (p) void inspectSources('Who controls the assets?', p.sourceIds, ['src/pack/classify.ts', 'src/graph/build.ts'], p.note); }
    else if (target.dataset.follow === 'memo') setTab('memo');
    else { $('#inspector').classList.add('open'); $('#inspector-title').textContent = 'Unverified & next evidence'; inspecting = 'unknowns'; $('#inspector-body').innerHTML = `<p class="activity-note">Limits of this research</p><ul class="unknowns">${view.unknowns.map(u => `<li>${esc(u)}</li>`).join('')}</ul>`; }
  }
});
document.addEventListener('keydown', e => { const target = e.target as HTMLElement; if ((e.key === 'Enter' || e.key === ' ') && target.hasAttribute('data-node')) { e.preventDefault(); target.dispatchEvent(new MouseEvent('click', {bubbles: true})); } if (target.matches('[role=tab]') && ['ArrowLeft','ArrowRight'].includes(e.key)) { const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')]; const next = tabs[(tabs.indexOf(target as HTMLButtonElement) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; next.focus(); setTab(next.dataset.tab!); } });
document.addEventListener('change', e => { const el = e.target as HTMLSelectElement; if (el.id === 'finding-filter') { filter = el.value; renderFindings(); } if (el.id === 'path-select') { pathIndex = Number(el.value); renderMap(); } });
let searchTimer: ReturnType<typeof setTimeout>;
document.addEventListener('input', e => { const el = e.target as HTMLInputElement; if (el.id === 'ledger-search') { ledgerQuery = el.value; const pos = el.selectionStart; renderTimeline(); $('#ledger-search').focus(); ($('#ledger-search') as HTMLInputElement).setSelectionRange(pos,pos); } if (el.id === 'source-search') { sourceQuery = el.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => void browseSources(sourceQuery), 180); } });
try { scopes = await api<Scope[]>('/api/cases'); const hash = location.hash.slice(1); await load(scopes.some(c => c.id === hash) ? hash as CaseId : 'marinade'); } catch (e) { $('#content').innerHTML = `<p class="error">${esc((e as Error).message)}</p>`; }
