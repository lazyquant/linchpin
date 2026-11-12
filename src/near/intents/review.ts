import { canonical } from "../../chain/evidence";
import type { EvidenceReceipt, Fact, QueryReason, QueryRequest, QueryResult } from "../../engine/contracts";
import { resultSha256, runQuery } from "../../engine/queries/run";
import { controlSurface, historyFacts, parseNearSubject } from "../reader";
import { OFFCHAIN_DOCUMENTS, OMNI_PROGRAM, REPORTED_MINTS, TREASURY } from "./extension";
import { classifyAsset } from "./rules";
import { FAMILY_RECIPES, recipeHops, RECIPE_RELATIONS } from "./recipes";
import type { ChangeSection, ControlPower, ControlRow, IntentContext, IntentHop, IntentInput, IntentLeg, IntentReview, OriginSection } from "./types";
export const ORIGIN_IS_NOT_BACKING_TEXT = "Token origin is a label, not a claim. That this token was issued for an asset on another chain does not show that it can be exchanged for that asset, nor that it carries that chain's security. The facts below are the custody facts this review has; the reasons below are the ones it lacks.";
const n = (s: string) => `near:mainnet:${s}`;
const unique = (a: string[]) => [...new Set(a)].sort();
const reasonsSorted = (rs: QueryReason[]) => [...new Map(rs.map(r => [canonical(r), r])).values()].sort((a,b) => a.code.localeCompare(b.code) || (a.subject ?? "").localeCompare(b.subject ?? "") || (a.ref ?? "").localeCompare(b.ref ?? ""));
export function reviewIntent(input: IntentInput, ctx: IntentContext): IntentReview {
  const snapshot = ctx.store.snapshot(ctx.snapshotId), base = ctx.store.snapshot(ctx.baseSnapshotId);
  const scope = { asOf: ctx.asOf, snapshotId: ctx.snapshotId, maxHops: 3, maxResults: 500 };
  const facts = new Map<string, Fact>(), receipts = new Map<string, EvidenceReceipt>(), reasons: QueryReason[] = [], queries: IntentReview["queries"] = [], observations = new Map<string, IntentReview["observations"][number]>(), snapshotIds = new Set<string>();
  const cite = (f: Fact) => { if (!facts.has(f.id)) facts.set(f.id, f); for (const id of f.evidenceIds) { const r = ctx.store.receipt(id); if (r) receipts.set(id, r); else reasons.push({ code: "missing-evidence", subject: f.subject, ref: id }); } };
  const accept = (request: QueryRequest, result: QueryResult) => {
    queries.push({ request, outcome: result.outcome, resultSha256: resultSha256(result) }); result.facts.forEach(cite); result.receipts.forEach(r => receipts.set(r.id, r)); reasons.push(...result.reasons); result.observations.forEach(o => observations.set(canonical(o), o)); result.snapshotIds.forEach(id => snapshotIds.add(id)); return result;
  };
  const query = (request: QueryRequest) => accept(request, runQuery(ctx.store, request));
  const legs: IntentLeg[] = (input.kind === "asset" ? [{ side: "asset" as const, asset: input.assetId }] : [{ side: "origin" as const, asset: input.quote.record.request.originAsset }, { side: "destination" as const, asset: input.quote.record.request.destinationAsset }]).map(l => ({ side: l.side, classification: classifyAsset(l.asset, ctx.rules, ctx.routeEvidence), token: ctx.tokens.find(t => t.assetId === l.asset) ?? null }));
  for (const leg of legs) {
    const e = leg.classification.routeEvidence;
    if (e) { e.receipts.forEach(r => receipts.set(r.id, r)); reasons.push(...e.reasons); }
  }
  if (!ctx.offchain.some(d => d.id === "incident-2026-09-29")) reasons.push({ code: "missing-evidence", subject: null, ref: "document:incident-2026-09-29" });
  const families = [...new Set(legs.flatMap(l => l.classification.family ? [l.classification.family] : []))];
  for (const l of legs) if (l.classification.reason) reasons.push(l.classification.reason);
  const valid = legs.some(l => l.classification.parsed);
  const roots = valid ? unique([n("intents.near"), ...legs.flatMap(l => l.classification.nearContract ? [l.classification.nearContract] : []), ...families.flatMap(f => FAMILY_RECIPES[f].map(n))]) : [];
  for (const subject of roots) query({ name: "dependencies", subject, relations: RECIPE_RELATIONS, scope });
  // State facts needed by recipes are joined locally; the temporal control facts come from queries.
  const recipeFacts = snapshot?.facts ?? [];
  const specs = recipeHops(legs, recipeFacts);
  for (const d of ctx.offchain) specs.push({ role: "offchain", family: "common", subject: d.subject });
  for (const d of OFFCHAIN_DOCUMENTS) if (!ctx.offchain.some(x => x.id === d.id)) specs.push({ role: "offchain", family: "common", subject: n(`intents.near#offchain:${d.id}`), reasons: [{ code: "missing-evidence", subject: null, ref: `document:${d.id}` }] });
  const surfaces = new Map<string, ReturnType<typeof controlSurface>>();
  for (const h of specs) {
    if (!h.subject || h.role === "offchain") continue;
    const subject = h.subject;
    if (!surfaces.has(subject)) {
      const surface = controlSurface(ctx.store, ctx.snapshotId, subject, ctx.asOf); surfaces.set(subject, surface);
      for (let i = 0; i < surface.results.length; i++) {
        const nodes = unique(surface.results[0].facts.filter(f => f.predicate === "holds-role" && ["role", "role-admin"].includes(parseNearSubject(f.object)?.kind ?? "")).map(f => f.object));
        accept({ name: "control", subject: i === 0 ? subject : nodes[i - 1], scope: { ...scope, maxHops: 1 } }, surface.results[i]);
      }
    }
  }
  const get = (subject: string, predicate?: string) => [...facts.values()].filter(f => f.subject === subject && (!predicate || f.predicate === predicate));
  const evidence = (fs: Fact[]) => ({ factIds: unique(fs.map(f => f.id)), receiptIds: unique(fs.flatMap(f => f.evidenceIds)) });
  const chain: IntentHop[] = specs.map((h, index) => {
    if (h.viaFact) cite(h.viaFact);
    if (h.role === "offchain") for (const f of recipeFacts.filter(f => f.subject === h.subject && f.predicate === "claimed-document")) cite(f);
    const fs = [...facts.values()].filter(f => f.subject === h.subject || h.subject && f.subject.startsWith(`${h.subject}#role:`));
    const rs = [...h.reasons ?? [], ...surfaces.get(h.subject ?? "")?.reasons ?? []];
    if (!fs.length && !rs.length) rs.push({ code: "missing-subject", subject: h.subject, ref: ctx.snapshotId });
    reasons.push(...rs);
    return { index, role: h.role, family: h.family, subject: h.subject, label: h.subject?.replace(/^near:mainnet:/, "") ?? legs.find(l => !l.classification.nearContract)?.classification.assetId ?? "unknown", via: h.viaFact ? { kind: "fact", factId: h.viaFact.id } : { kind: "recipe", recipe: `${h.family}:${h.role}` }, ...evidence(fs), reasons: reasonsSorted(rs) };
  });
  const control: ControlRow[] = [];
  const row = (subject: string, power: ControlPower, holders: string[], detail: string, fs: Fact[], rs: QueryReason[] = [], kind: ControlRow["kind"] = "fact", count: number | null = holders.length) => { fs.forEach(cite); control.push({ subject, power, holders: unique(holders), count, detail, kind, ...evidence(fs), reasons: reasonsSorted(rs) }); reasons.push(...rs); };
  const deploymentSubject = n("ctl-intents.near#deployment:intents.near"), deployments = valid ? recipeFacts.filter(f => f.subject === deploymentSubject && f.predicate === "deployed-version") : [];
  deployments.forEach(cite);
  const versions = deployments.filter(f => { const at = f.object.slice(f.object.indexOf("@") + 1); return at !== "current" && Number.isFinite(Date.parse(at)); }).map(f => ({ version: f.object.slice(0, f.object.indexOf("@")), at: f.object.slice(f.object.indexOf("@") + 1), factId: f.id, receiptIds: f.evidenceIds })).sort((a,b) => a.at.localeCompare(b.at) || a.version.localeCompare(b.version));
  const current = deployments.find(f => f.object.endsWith("@current"))?.object.split("@")[0], latest = versions.filter(v => v.version === current).at(-1);
  for (const subject of [...new Set(chain.flatMap(h => h.subject && !h.subject.includes("#") && h.factIds.length ? [h.subject] : []))]) {
    const s = surfaces.get(subject); if (!s) continue;
    const own = get(subject), roles = (name: string) => get(`${subject}#role:${name}`, "holds-role"), holders = (name: string) => s.roles[name] ?? [];
    const upgrades = own.filter(f => ["upgraded-by", "owned-by", "has-full-access-key"].includes(f.predicate));
    if (upgrades.length) row(subject, "upgrade", unique([...s.upgradedBy, ...own.filter(f => ["owned-by", "has-full-access-key"].includes(f.predicate) && !["none", "unknown"].includes(f.object)).map(f => f.object)]), subject === n("intents.near") ? `${current ?? "unknown"} since ${latest?.at ?? "unknown"}` : "Code control: role grantees, owner and full-access keys where observed", [...upgrades, ...(subject === n("intents.near") ? deployments : [])], s.reasons.filter(r => r.code === "unknown-controller"));
    if (roles("PauseManager").length || s.paused.length) row(subject, "pause", holders("PauseManager"), `PauseManager ${holders("PauseManager").length}; paused ${s.paused.join(", ") || "unknown"}; UnpauseManager ${roles("UnpauseManager").length ? holders("UnpauseManager").length : "unknown"}`, [...roles("PauseManager"), ...roles("UnpauseManager"), ...own.filter(f => f.predicate === "paused")]);
    if (subject === n("intents.near") && roles("UnpauseManager").some(f => f.object === "none") && own.some(f => f.predicate === "has-full-access-key" && f.object === "none")) row(subject, "pause", s.superAdmins, `No account holds UnpauseManager; resuming needs a super admin: ${s.superAdmins.join(", ")}. intents.near has no full-access key.`, [...roles("UnpauseManager"), ...own.filter(f => f.predicate === "super-admin-of" || f.predicate === "has-full-access-key" && f.object === "none")], [], "interpretation");
    for (const name of ["UnrestrictedAccountLocker", "UnrestrictedAccountUnlocker"]) if (roles(name).length) row(subject, "freeze", holders(name), `${name}: ${holders(name).length} accounts`, roles(name));
    if (s.superAdmins.length) {
      const fs = own.filter(f => f.predicate === "super-admin-of"), details: string[] = [];
      for (const dao of s.superAdmins) {
        const council = get(dao, "council-member"), thresholds = get(`${dao}#role:council`, "vote-threshold");
        if (!council.length) continue;
        fs.push(...council, ...thresholds);
        const ks = thresholds.map(f => voteThresholdVotes(f.object, council.length));
        details.push(`${dao}: ${ks.length && ks.every(k => k !== null && k === ks[0]) ? `${ks[0]} of ${council.length}` : `council ${council.length}; thresholds ${thresholds.map(f => f.object).join(", ")}`}`);
      }
      row(subject, "grant-roles", s.superAdmins, details.join("; ") || "Super admins", fs);
    }
    if (subject.endsWith(".sputnik-dao.near")) {
      const read = ctx.reads.find(subject.slice("near:mainnet:".length), "call_function", "get_policy");
      const rs: QueryReason[] = read ? [] : [{ code: "missing-evidence", subject, ref: "get_policy" }];
      row(subject, "execution-delay", [], read ? `policy fields: ${Object.keys(read.value as object).sort().join(", ")}; none is a delay, timelock or hold` : "Policy read absent", [], rs, "fact", null);
      if (read) { receipts.set(read.receipt.id, read.receipt); control.at(-1)!.receiptIds.push(read.receipt.id); }
    }
  }
  if (families.includes("poa_bridge")) { const fs = get(n("omft.near"), "token-depositer"); row(n("omft.near"), "sign-withdrawals", fs.map(f => f.object), `TokenDepositer: ${fs.length} holders`, fs, fs.length ? [] : [{ code: "missing-evidence", subject: n("omft.near"), ref: "TokenDepositer" }]); }
  const mpcFacts = valid ? recipeFacts.filter(f => f.subject === n("v1.signer") && ["mpc-participant", "mpc-threshold"].includes(f.predicate)) : [];
  mpcFacts.forEach(cite); const participants = mpcFacts.filter(f => f.predicate === "mpc-participant"), threshold = mpcFacts.find(f => f.predicate === "mpc-threshold")?.object ?? null;
  if (families.includes("omni_bridge")) row(n("v1.signer"), "sign-withdrawals", participants.map(f => f.object), `threshold ${threshold ?? "unknown"}; ${participants.length} participants`, mpcFacts, mpcFacts.length ? [] : [{ code: "missing-evidence", subject: n("v1.signer"), ref: "state" }]);
  if (families.includes("hot_bridge")) row(n("v2_1.omni.hot.tg"), "sign-withdrawals", [], "Validator identities unknown", [], [{ code: "unknown-controller", subject: n("v2_1.omni.hot.tg"), ref: "hot-validator-identities" }], "fact", null);
  const changeRoots = valid ? ["intents.near", "ctl-intents.near", "intents.sputnik-dao.near", "omni.bridge.near", "v1.signer"].map(n) : [];
  const changeSubjects = unique([...changeRoots, ...(base?.subjects ?? []).filter(s => changeRoots.some(root => s.startsWith(`${root}#role:`)))]);
  const changes: ChangeSection = { pair: ctx.change, subjects: changeSubjects, changes: [], history: [], versions, mpc: { participants: participants.length, threshold, ...evidence(mpcFacts) } };
  if (ctx.change) for (const subject of changeSubjects) { const q = query({ name: "changes", subject, beforeSnapshotId: ctx.change.before, afterSnapshotId: ctx.change.after, maxResults: 500 }); changes.changes.push(...q.changes.map(c => ({ ...c, subject }))); }
  else if (valid) reasons.push({ code: "missing-history", subject: null, ref: "live-snapshot-pair" });
  for (const subject of changeRoots) {
    const h = historyFacts(ctx.store, subject, ctx.baseSnapshotId); reasons.push(...h.reasons);
    changes.history.push({ subject, events: h.events.map(e => { cite(e.source); cite(e.fact); return { at: e.at, kind: e.kind, factId: e.fact.id, sourceFactId: e.source.id, receiptIds: e.fact.evidenceIds }; }) });
  }
  const origin: OriginSection = { text: ORIGIN_IS_NOT_BACKING_TEXT, has: [], lacks: [{ code: "missing-coverage", subject: null, ref: "origin-chain-balance-not-read" }] };
  const custody = [...facts.values()].filter(f => (families.includes("poa_bridge") && (f.predicate === "token-depositer" || f.subject === TREASURY)) || (families.includes("omni_bridge") && (f.predicate === "mpc-threshold" || f.subject === OMNI_PROGRAM)) || (chain.some(h => h.role === "origin-artefact" && h.subject === f.subject) && ["MINT_AUTHORITY", "FREEZE_AUTHORITY"].includes(f.predicate)) || legs.some(l => l.classification.nearContract === f.subject) && ["owned-by", "has-full-access-key", "has-function-call-key"].includes(f.predicate));
  for (const f of custody) origin.has.push({ label: `${f.subject} ${f.predicate} ${f.object}`, ...evidence([f]) });
  const conflictSubjects = [OMNI_PROGRAM, ...REPORTED_MINTS.map(m => n(`intents.near#solana:${m}`))];
  for (const subject of conflictSubjects) if (custody.some(f => f.subject === subject)) origin.lacks.push({ code: "conflict", subject, ref: "report:solana-class-2026-10-22" });
  if (custody.some(f => f.subject === TREASURY)) {
    origin.lacks.push({ code: "conflict", subject: TREASURY, ref: "report:solana-class-2026-10-22" });
    if (custody.some(f => f.subject === TREASURY && f.object === "unknown")) origin.lacks.push({ code: "unknown-controller", subject: TREASURY, ref: "treasury-controller" });
  }
  let quote: IntentReview["quote"] = null;
  if (input.kind === "quote") {
    receipts.set(input.quote.receipt.id, input.quote.receipt); input.quote.facts.forEach(f => facts.set(f.id, f)); reasons.push(...input.quote.reasons);
    quote = { requestSha256: input.quote.record.requestSha256, correlationId: input.quote.correlationId, timestamp: input.quote.timestamp, signature: input.quote.signature, signatureVerified: false, factIds: input.quote.facts.map(f => f.id), receiptId: input.quote.receipt.id };
  }
  // Fixed origin and quote-availability notices stay in their sections; only
  // query, hop, extension and change reasons determine the outcome.
  const quoteNotRecorded: IntentReview["quoteNotRecorded"] = input.kind === "asset" ? structuredClone(ctx.quoteNotRecorded ?? { status: "not recorded" as const, reason: "No recorded dry quote is available for this asset review.", attempt: null }) : null;
  const unknowns = reasonsSorted(reasons), verifier = chain.find(h => h.role === "verifier");
  return { version: 1, reviewer: "near-intent-review/1", input: input.kind === "asset" ? { kind: "asset", assetId: input.assetId } : { kind: "quote", originAsset: input.quote.record.request.originAsset, destinationAsset: input.quote.record.request.destinationAsset, amount: input.quote.record.request.amount, requestSha256: input.quote.record.requestSha256 }, legs, families, quote, quoteNotRecorded, chain, control, changes, origin, offchain: structuredClone(ctx.offchain), unknowns,
    outcome: !verifier?.factIds.length ? "unknown" : unknowns.length || chain.some(h => h.reasons.length) ? "partial" : "complete", asOf: ctx.asOf, snapshotIds: [...snapshotIds].sort(), observations: [...observations.values()].sort((a,b) => canonical(a).localeCompare(canonical(b))), queries, facts: [...facts.values()].sort((a,b) => a.id.localeCompare(b.id)), receipts: [...receipts.values()].sort((a,b) => a.id.localeCompare(b.id)) };
}

/** Reader format: threshold|proposal kind|weight kind|quorum:n. Ratios require strictly more than n/d. */
export function voteThresholdVotes(object: string, members: number): number | null {
  const [threshold, , weight, quorum, ...extra] = object.split("|");
  if (extra.length || weight !== "RoleWeight" || quorum !== "quorum:0" || !Number.isSafeInteger(members) || members < 1) return null;
  if (/^[0-9]+$/.test(threshold)) { const n = Number(threshold); return Number.isSafeInteger(n) ? n : null; }
  const m = /^(\d+)\/(\d+)$/.exec(threshold);
  if (!m || BigInt(m[2]) === 0n) return null;
  const n = BigInt(m[1]) * BigInt(members) / BigInt(m[2]) + 1n;
  return Number(n > BigInt(members) ? BigInt(members) : n);
}
