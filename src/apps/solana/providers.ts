/**
 * The protocols of the app, read through the repository's own builders from committed captures. Nothing is
 * computed about a protocol here: facts, coverage, gaps and tokenomics rows are copied into kit results.
 * Bun only; no network and no file written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_TARGETS, loadCapture, normalizeCapture, type KaminoReport, type VaultSlug } from "../../adapters/kamino/index";
import { buildKaminoLendResults } from "../../adapters/kamino-lend/index";
import { RecordingRpc } from "../../chain/rpc";
import { runOptions } from "../../config";
import type { EvidenceReceipt, Fact, FactChange, QueryReason } from "../../engine/contracts";
import { buildMarinadeSnapshots } from "../../engine/queries/marinade";
import { runQuery } from "../../engine/queries/run";
import { openStore, type EvidenceSnapshot } from "../../engine/queries/snapshot";
import { buildEvidenceRecords, type EvidenceRecords } from "../../graph/evidence/build";
import { PROTOCOLS, collectEvidenceInputs, type ProtocolEntry } from "../../graph/evidence/protocols";
import { runEvidenceLocal } from "../../graph/evidence/templates";
import { buildPack, type DocsCapture, type PackFile, type PackRegistry } from "../../pack/build";
import type { BundleResponse, ControlRow, EvidenceRecord, Provenance } from "../../tokenomics/api";
import { buildTokenomics } from "../../tokenomics/build";
import type { AnyResultV2, CaptureRecord, ChangesResult, CoverageInput, ReceiptRecord, ResultRow, ResultSet } from "../../ui/types";
import { classOf, layerOf } from "./layers";
import { PREFIX, RESULT, type PackData, type SeriesData } from "./model";
import {
  CHAIN_COLUMNS, FACT_COLUMNS, GAP_COLUMNS, changeRows, cmp, controlRows, factRows, gapRow, graphOf, plainObject, receiptRecord, rowOf, table, unique,
  type KindOf, type ReceiptIndex,
} from "./rows";
import { SURFACE_TITLES } from "./strings";

const KIND_ORDER = ["Market", "Vault", "Program", "Reserve", "Multisig", "Token"];
const PROTOCOLS_SOURCE = "src/graph/evidence/protocols.ts";

/** A named gap of a capture, as an adapter, a reader or a report states it. */
export interface GapInput { reason: "not-captured" | "not-computed" | "not-mapped" | "not-read"; item: string; account: string | null; detail: string | null; source: string }

/** Two captures compared: the changes a query returned, and the reasons it gave for what it could not compare. */
export interface ChangeInput { before: EvidenceSnapshot; after: EvidenceSnapshot; changes: FactChange[]; reasons: QueryReason[]; constructed: boolean; source: string }

export interface SeriesInput {
  id: string;
  title: string;
  kindLine: string;
  focus: string;
  current: EvidenceSnapshot;
  /** The captures listed in the header, oldest first. */
  captures: EvidenceSnapshot[];
  /** The control facts of the Control tab. */
  controlFacts: Fact[];
  /** Further chain groups, already as rows (rows that are not made of engine facts). */
  extraControl?: { title: string; rows: ResultRow[] }[];
  kindOf: KindOf;
  coverage: ProtocolEntry["coverage"] | null;
  gaps: GapInput[];
  change: ChangeInput | null;
  /** What the capture list says about where it comes from. */
  captureSource: string;
  /** Results added as they are: the value path of a protocol that has one. */
  extraResults?: AnyResultV2[];
}

const captureRecord = (snapshot: EvidenceSnapshot, shown: boolean, source: string): CaptureRecord => ({
  id: snapshot.id, observedFrom: snapshot.observedFrom, observedTo: snapshot.observedTo, fromBlockOrSlot: snapshot.fromBlockOrSlot, toBlockOrSlot: snapshot.toBlockOrSlot,
  facts: snapshot.facts.length, subjects: snapshot.subjects.length, shown, constructed: snapshot.constructed, source, evidenceIds: snapshot.receipts.map((receipt) => receipt.id).sort(cmp),
});

const gapRows = (gaps: GapInput[], constructed = false): ResultRow[] =>
  gaps.map((gap, at) => gapRow(`gap-${at}`, gap.reason, gap.source, { item: gap.item, account: gap.account, detail: gap.detail }, constructed));

/** Engine changes between two captures: one `changes` query per subject of either, in id order. */
export function engineChanges(before: EvidenceSnapshot, after: EvidenceSnapshot, source: string): ChangeInput {
  const store = openStore([before, after]);
  const changes: FactChange[] = [];
  const reasons: QueryReason[] = [];
  for (const subject of unique([...before.subjects, ...after.subjects]).sort(cmp)) {
    const result = runQuery(store, { name: "changes", subject, beforeSnapshotId: before.id, afterSnapshotId: after.id, maxResults: 500 });
    changes.push(...result.changes);
    reasons.push(...result.reasons);
  }
  return { before, after, changes, reasons, constructed: before.constructed || after.constructed, source };
}

/** One series of a pack from its captures. Also returns the receipts its rows cite. */
export function seriesFromSnapshots(input: SeriesInput): { series: SeriesData; receipts: ReceiptRecord[] } {
  const snapshot = input.current;
  const receiptList: EvidenceReceipt[] = [...snapshot.receipts, ...(input.change ? [...input.change.before.receipts, ...input.change.after.receipts] : []), ...input.captures.flatMap((capture) => capture.receipts)];
  const receipts: ReceiptIndex = new Map(receiptList.map((receipt) => [receipt.id, receipt]));
  const facts = [...snapshot.facts].sort((a, b) => cmp(a.subject, b.subject) || cmp(a.predicate, b.predicate) || cmp(a.object, b.object) || cmp(a.id, b.id));
  const results: Record<string, AnyResultV2> = {};
  const put = (result: AnyResultV2): void => {
    results[result.resultId] = result;
  };

  // Control: chain rows by the kind of the controlled account, then members and thresholds.
  const control = controlRows(input.controlFacts, receipts, snapshot.id);
  const groupOf = (row: ResultRow): string => {
    const kind = input.kindOf(String(row.values.target))?.kind.split(" · ")[0];
    return kind !== undefined && KIND_ORDER.includes(kind) ? kind : SURFACE_TITLES.otherAccounts;
  };
  const controlGroups: { resultId: string; title: string }[] = [];
  const addGroup = (title: string, rows: ResultRow[]): void => {
    if (rows.length === 0) return;
    const resultId = `control-${controlGroups.length}`;
    controlGroups.push({ resultId, title });
    put(table(resultId, "chain", CHAIN_COLUMNS, rows, { total: rows.length }));
  };
  const titles = input.kindOf === NO_KINDS ? [SURFACE_TITLES.recordedAuthorities] : [...KIND_ORDER, SURFACE_TITLES.otherAccounts];
  for (const title of titles) addGroup(title, input.kindOf === NO_KINDS ? control.chain : control.chain.filter((row) => groupOf(row) === title));
  for (const group of input.extraControl ?? []) addGroup(group.title, group.rows);
  put(table(RESULT.members, "table", [["multisig", "subject"], ["member", "address"], ["status", "status"]],
    control.members.map((fact) => rowOf([fact], { multisig: fact.subject, member: fact.object, status: fact.status }, receipts, snapshot.id))));
  put(table(RESULT.thresholds, "table", [["multisig", "subject"], ["threshold", "amount"], ["status", "status"]],
    facts.filter((fact) => fact.predicate === "MULTISIG_THRESHOLD").map((fact) => rowOf([fact], { multisig: fact.subject, threshold: plainObject(fact.object), status: fact.status }, receipts, snapshot.id))));

  // Dependencies: the graph, every edge fact, every state fact.
  const graph = graphOf(snapshot.subjects, facts, receipts, snapshot.names, { classOf, layerOf, kindOf: input.kindOf });
  put(graph);
  const edgeIds = new Set(graph.edges.map((edge) => edge.key));
  put(table(RESULT.edges, "table", FACT_COLUMNS, factRows(facts.filter((fact) => edgeIds.has(fact.id)), receipts, snapshot.id, layerOf, input.kindOf)));
  put(table(RESULT.state, "table", FACT_COLUMNS, factRows(facts.filter((fact) => !edgeIds.has(fact.id)), receipts, snapshot.id, layerOf, input.kindOf)));

  // Unknowns: facts recorded as unknown or unverified, then the named gaps.
  const unknownFacts = facts.filter((fact) => fact.object === "unknown" || fact.basis === "unknown" || fact.status === "unverified");
  put(table(RESULT.unknowns, "unknowns", [["account", "subject"], ["relation", "label"], ["value", "value"], ["status", "status"]],
    unknownFacts.map((fact) => ({ ...rowOf([fact], { account: fact.subject, relation: fact.predicate, value: fact.object, status: fact.status }, receipts, snapshot.id), rowKind: "unknown" as const })),
    { total: unknownFacts.length }));
  const readers = snapshot.readers.filter((reader) => reader.status !== "complete")
    .map((reader): GapInput => ({ reason: "not-read", item: `reader ${reader.id}`, account: null, detail: `status ${reader.status}`, source: `readers of snapshot ${snapshot.id}` }));
  const coverageGap: GapInput[] = input.coverage === null
    ? [{ reason: "not-mapped", item: "coverage not recorded", account: null, detail: "The evidence graph holds no coverage rows for this protocol.", source: PROTOCOLS_SOURCE }]
    : [];
  const gaps = [...coverageGap, ...readers, ...input.gaps];
  if (gaps.length > 0) put(table(RESULT.gaps, "unknowns", GAP_COLUMNS, gapRows(gaps), { total: gaps.length }));

  // Value path: for a series with coverage rows, the three mechanics as coverage rows of a result that is not mapped.
  const coverage: CoverageInput | null = input.coverage === null ? null : { mechanics: input.coverage.map(({ mechanic, status, note }) => ({ mechanic, status, note })), asked: [] };
  if (input.coverage !== null && !(input.extraResults ?? []).some((result) => result.resultId === RESULT.path)) {
    const routed = input.coverage.filter((entry) => ["fees", "treasury", "flows"].includes(entry.mechanic));
    put(table(RESULT.value, "table", [["mechanic", "label"], ["note", "note"]], routed.map((entry): ResultRow => ({
      rowKind: "coverage", key: entry.mechanic, values: { mechanic: entry.mechanic, note: entry.note }, factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [snapshot.id],
    })), { coverage: "not-mapped", coverageNotes: routed.map((entry) => entry.note), total: routed.length }));
  }
  for (const result of input.extraResults ?? []) put(result);

  // Changes: two captures compared, or the gap that says there is nothing to compare. Never "no change" for missing history.
  if (input.change) {
    const rows = changeRows(input.change.changes, receipts, input.change.constructed);
    const changes: ChangesResult = {
      resultId: RESULT.changes, shape: "changes", coverage: "mapped", coverageNotes: [], captureIds: [input.change.before.id, input.change.after.id], rows, truncated: false, total: rows.length,
      ...(input.change.constructed ? { constructed: true as const } : {}),
    };
    put(changes);
    const seen = new Set<string>();
    const notes = input.change.reasons.filter((reason) => reason.code !== "unknown-controller" && reason.code !== "no-facts").filter((reason) => {
      const key = `${reason.code}|${reason.subject}|${reason.ref}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((reason): GapInput => ({ reason: "not-computed", item: reason.code, account: reason.subject, detail: reason.ref, source: input.change!.source }));
    if (notes.length > 0) put(table(RESULT.changeNotes, "unknowns", GAP_COLUMNS, gapRows(notes, input.change.constructed), { total: notes.length }));
  } else {
    put(table(RESULT.changesGap, "unknowns", GAP_COLUMNS, [gapRow("nothing-to-compare", "not-captured", `captures on record for this series: ${input.captures.map((capture) => capture.id).join(", ")}`, {
      item: "nothing to compare", account: null, detail: "A change needs two recorded captures of the same accounts; this series has one.",
    })], { total: 1 }));
  }

  const series: SeriesData = {
    id: input.id, title: input.title, focus: input.focus, snapshotId: snapshot.id,
    meta: {
      title: input.title, subjectId: input.focus, kind: input.kindLine, snapshotIds: [snapshot.id], fromBlockOrSlot: snapshot.fromBlockOrSlot, toBlockOrSlot: snapshot.toBlockOrSlot,
      capturedAt: snapshot.observedTo, captures: input.captures.map((capture) => captureRecord(capture, capture.id === snapshot.id, input.captureSource)),
    },
    coverage, results, controlGroups,
  };
  return { series, receipts: unique(receiptList).map(receiptRecord) };
}

/** A series whose captures record no kind for any account. */
export const NO_KINDS: KindOf = () => null;

/** The index row of a pack: counts over the latest recorded capture of each series. A scope row; a count has no receipt. */
export function packIndex(packId: string, latest: EvidenceSnapshot[], captures: number, notMapped: string): ResultSet {
  const newest = [...latest].sort((a, b) => cmp(a.observedTo, b.observedTo)).at(-1)!;
  const unknown = latest.reduce((sum, snapshot) => sum + snapshot.facts.filter((fact) => fact.object === "unknown" || fact.basis === "unknown" || fact.status === "unverified").length, 0);
  return table(`index-${packId}`, "table", [
    ["latest capture", "time"], ["slot", "value"], ["facts", "amount"], ["accounts", "amount"], ["captures", "amount"], ["unknown facts", "amount"], ["mechanics not mapped", "note"],
  ], [{
    rowKind: "scope", key: packId, factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: latest.map((snapshot) => snapshot.id),
    scopeSource: `counted from the loaded snapshots ${latest.map((snapshot) => snapshot.id).join(", ")}`,
    values: {
      "latest capture": newest.observedTo, slot: newest.toBlockOrSlot, facts: latest.reduce((sum, snapshot) => sum + snapshot.facts.length, 0),
      accounts: latest.reduce((sum, snapshot) => sum + snapshot.subjects.length, 0), captures, "unknown facts": unknown, "mechanics not mapped": notMapped,
    },
  }]);
}

/* ---------- the Kamino family: through the evidence graph's records ---------- */

export interface KaminoFamily { records: EvidenceRecords; snapshots: EvidenceSnapshot[] }

export function loadKaminoFamily(root: string): KaminoFamily {
  const inputs = collectEvidenceInputs(root).filter((input) => input.snapshot.chain === "solana");
  return { records: buildEvidenceRecords(inputs), snapshots: inputs.map((input) => input.snapshot) };
}

function recordKinds(records: EvidenceRecords): KindOf {
  const kinds = new Map<string, { kind: string; basis: string }>();
  for (const node of records.nodes) {
    if (node.label === "Entity" && node.kinds.length > 0) kinds.set(node.id, { kind: node.kinds.join(" · "), basis: String(node.props.kindBasis ?? "decoded") });
  }
  return (id) => kinds.get(id) ?? null;
}

/** The control facts of a capture as the evidence graph's control template returns them, one hop from every subject. */
function templateControlFacts(records: EvidenceRecords, snapshot: EvidenceSnapshot): Fact[] {
  const byId = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  const scope = { snapshotId: snapshot.id, asOf: snapshot.observedTo, maxHops: 1, maxResults: 500 };
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const subject of [...snapshot.subjects].sort(cmp)) {
    for (const row of runEvidenceLocal(records, "control", { subject, scope }).rows) {
      const factId = row.rowKind === "coverage" ? undefined : row.factId;
      if (typeof factId !== "string" || seen.has(factId) || !byId.has(factId)) continue;
      seen.add(factId);
      out.push(byId.get(factId)!);
    }
  }
  return out;
}

function templateChanges(records: EvidenceRecords, before: EvidenceSnapshot, after: EvidenceSnapshot): ChangeInput {
  const changes: FactChange[] = [];
  const reasons: QueryReason[] = [];
  for (const subject of unique([...before.subjects, ...after.subjects]).sort(cmp)) {
    const result = runEvidenceLocal(records, "changes", { subject, beforeSnapshotId: before.id, afterSnapshotId: after.id, maxResults: 500 });
    changes.push(...result.changes);
    reasons.push(...result.reasons);
  }
  return { before, after, changes, reasons, constructed: false, source: `changes template of the evidence graph over ${before.id} and ${after.id}` };
}

const seriesSnapshots = (family: KaminoFamily, prefix: string): EvidenceSnapshot[] =>
  family.snapshots.filter((snapshot) => snapshot.id.startsWith(prefix) && !snapshot.constructed).sort((a, b) => cmp(a.observedTo, b.observedTo));
const protocolOf = (series: string): ProtocolEntry => PROTOCOLS.find((entry) => entry.series === series)!;
const notMappedOf = (entries: ProtocolEntry[]): string => unique(entries.flatMap((entry) => entry.coverage.filter((row) => row.status === "not-mapped").map((row) => row.mechanic))).join(", ");

export function kaminoLendPack(root: string, family: KaminoFamily): { pack: PackData; receipts: ReceiptRecord[]; latest: EvidenceSnapshot } {
  const snapshots = seriesSnapshots(family, "solana-mainnet-beta.kamino-lend.main-market-");
  const current = snapshots.at(-1)!;
  const result = buildKaminoLendResults(join(root, "fixtures/kamino-lend")).find((candidate) => candidate.snapshot.id === current.id)!;
  const directory = current.id.replace("solana-mainnet-beta.kamino-lend.", "");
  const manifest = JSON.parse(readFileSync(join(root, "fixtures/kamino-lend", directory, "manifest.json"), "utf8")) as { target: { market: string } };
  const entry = protocolOf("kamino-lend.main-market");
  const source = `src/adapters/kamino-lend for snapshot ${current.id}`;
  const gaps: GapInput[] = [
    ...result.gaps.map((gap): GapInput => ({ reason: "not-captured", item: gap.code, account: gap.subject, detail: gap.detail, source: `${source} (${gap.source})` })),
    ...result.coverage.map((note): GapInput => ({ reason: "not-captured", item: note.id, account: note.subject, detail: note.detail, source: `${source} (coverage note ${note.code})` })),
  ];
  const built = seriesFromSnapshots({
    id: "main-market", title: entry.title, kindLine: "The market account, its reserves, price accounts, mints, programs and the multisigs behind its authorities",
    focus: `${PREFIX}${manifest.target.market}`, current, captures: snapshots, controlFacts: templateControlFacts(family.records, current), kindOf: recordKinds(family.records),
    coverage: entry.coverage, gaps, change: snapshots.length > 1 ? templateChanges(family.records, snapshots[0], current) : null,
    captureSource: `src/adapters/kamino-lend/index.ts#buildKaminoLendResults over fixtures/kamino-lend/${directory}`,
  });
  return {
    pack: {
      id: "kamino-lend", title: "Kamino Lend", line: "Main market: the market account, its reserves, price accounts, mints, programs and multisigs",
      builder: "src/adapters/kamino-lend/index.ts#buildKaminoLendResults", fixtures: ["fixtures/kamino-lend"],
      index: packIndex("kamino-lend", [current], snapshots.length, notMappedOf([entry])), series: [built.series],
    },
    receipts: built.receipts, latest: current,
  };
}

export function kaminoVaultsPack(root: string, family: KaminoFamily): { pack: PackData; receipts: ReceiptRecord[]; sentora: { snapshot: EvidenceSnapshot; report: KaminoReport } } {
  const kindOf = recordKinds(family.records);
  const series: SeriesData[] = [];
  const receipts: ReceiptRecord[] = [];
  const latest: EvidenceSnapshot[] = [];
  const entries: ProtocolEntry[] = [];
  let captures = 0;
  let sentora: { snapshot: EvidenceSnapshot; report: KaminoReport } | null = null;
  for (const slug of Object.keys(VAULT_TARGETS) as VaultSlug[]) {
    const snapshots = seriesSnapshots(family, `solana-mainnet-beta.kamino.${slug}-`);
    const current = snapshots.at(-1)!;
    const fixtures = slug === "sentora-pyusd" ? "fixtures/kamino" : `fixtures/kamino-vaults/${slug}`;
    const directory = current.id.replace("solana-mainnet-beta.kamino.", "");
    const result = normalizeCapture(loadCapture(join(root, fixtures, directory)));
    const entry = protocolOf(`kamino.${slug}`);
    const source = `src/adapters/kamino for snapshot ${current.id}`;
    const report = result.report;
    if (slug === "sentora-pyusd") sentora = { snapshot: current, report };
    const gaps: GapInput[] = [
      ...result.gaps.map((gap): GapInput => ({ reason: "not-captured", item: gap.code, account: gap.subject, detail: gap.detail, source: `${source} (${gap.source})` })),
      ...unique([...report.missing, ...report.notCaptured]).map((name): GapInput => ({ reason: "not-captured", item: name, account: null, detail: null, source: `${source} (adapter report)` })),
      ...report.notComputed.map((name): GapInput => ({ reason: "not-computed", item: name, account: null, detail: null, source: `${source} (adapter report)` })),
    ];
    const built = seriesFromSnapshots({
      id: slug, title: entry.title, kindLine: "One kVault: the vault, the reserves it allocates to, their markets and price accounts",
      focus: `${PREFIX}${VAULT_TARGETS[slug].vault}`, current, captures: snapshots, controlFacts: templateControlFacts(family.records, current), kindOf,
      coverage: entry.coverage, gaps, change: snapshots.length > 1 ? templateChanges(family.records, snapshots[0], current) : null,
      captureSource: `src/adapters/kamino/index.ts#buildKaminoSnapshots over ${fixtures}`,
    });
    series.push(built.series);
    receipts.push(...built.receipts);
    latest.push(current);
    entries.push(entry);
    captures += snapshots.length;
  }
  return {
    pack: {
      id: "kamino-vaults", title: "Kamino vaults", line: "Six recorded kVaults: each vault, the reserves it allocates to, their markets and price accounts",
      builder: "src/adapters/kamino/index.ts#buildKaminoSnapshots", fixtures: ["fixtures/kamino", "fixtures/kamino-vaults"],
      index: packIndex("kamino-vaults", latest, captures, notMappedOf(entries)), series,
    },
    receipts, sentora: sentora!,
  };
}

/* ---------- Marinade: engine snapshots, and the tokenomics sections built in process ---------- */

const MSOL = `${PREFIX}mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So`;
const TOKENOMICS_SOURCE = "src/tokenomics/sections.ts";

/** The tokenomics bundle of the captured Marinade pack, replayed from fixtures. No network, no file written. */
export async function buildMarinadeBundle(root: string): Promise<{ bundle: BundleResponse; records: Map<string, EvidenceRecord> }> {
  const json = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), "utf8")) as T;
  const options = runOptions({ offline: true, record: false, refresh: false, rpcUrl: "http://127.0.0.1:1", fixturesDir: join(root, "fixtures"), outDir: join(root, "out") });
  const rpc = new RecordingRpc(options, "marinade-pack");
  const config = json<PackFile>("packs/marinade/pack.json");
  const packet = await buildPack(rpc, json<PackRegistry>(config.registry), { title: config.title, docsCapture: json<DocsCapture>(config.docsCapture), burns: config.burns, ledger: config.ledger });
  if (rpc.counts.live !== 0) throw new Error("the offline replay of the Marinade pack attempted a live read");
  const build = await buildTokenomics({ root, packResult: { packet, evidence: rpc.evidence } });
  return { bundle: build.bundle as BundleResponse, records: build.evidence.records };
}

const basesOf = (provenance: Provenance): string[] => unique(Array.isArray(provenance.basis) ? provenance.basis : [provenance.basis]);
function bundleRow(key: string, values: ResultRow["values"], sources: Provenance[], snapshotId: string, rowKind: ResultRow["rowKind"] = "fact"): ResultRow {
  const slots = sources.map((source) => source.slot).filter((slot): slot is number => slot !== null);
  const times = sources.map((source) => source.asOf).filter((time): time is string => time !== null).sort(cmp);
  return {
    rowKind, key, values, factIds: [], bases: unique(sources.flatMap(basesOf)), evidenceIds: unique(sources.flatMap((source) => source.evidenceIds)),
    blockOrSlot: slots.length > 0 ? Math.max(...slots) : null, asOf: times.at(-1) ?? null, snapshotIds: [snapshotId],
  };
}

function marinadeResults(bundle: BundleResponse, snapshotId: string): { results: AnyResultV2[]; control: { title: string; rows: ResultRow[] }[] } {
  const answer = bundle.answer.data!;
  const path = bundle.path.data!;
  const control = bundle.control.data!;
  const claims = bundle.claims.data!;
  const label = new Map(path.nodes.map((node) => [node.id, node.label]));
  const controllers = new Map(control.controllers.map((controller) => [controller.id, controller]));
  const findings = table(RESULT.findings, "table", [["finding", "note"], ["status", "status"]], [
    { rowKind: "scope", key: "short-answer", values: { finding: answer.shortAnswer.text, status: answer.shortAnswer.status }, factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [snapshotId], scopeSource: `${TOKENOMICS_SOURCE}, short answer to: ${answer.question}` },
    ...answer.statements.map((statement) => bundleRow(statement.id, { finding: statement.text, status: statement.status }, [statement], snapshotId)),
  ]);
  findings.total = findings.rows.length;
  const links = table(RESULT.path, "path", [
    ["from", "label"], ["to", "label"], ["mechanism", "label"], ["status", "status"], ["amount", "amount"], ["unit", "unit"], ["window", "time"], ["transactions", "amount"],
  ], path.links.map((link) => {
    // A link that is claimed only carries no amount, whatever was observed near it.
    const observed = link.status === "claimed-only" ? null : link.observed;
    return bundleRow(link.id, {
      from: label.get(link.from) ?? link.from, to: label.get(link.to) ?? link.to, mechanism: link.mechanism, status: link.status,
      amount: observed ? observed.amount.display : null, unit: observed ? observed.amount.unit : null,
      window: observed ? `${observed.window[0]} to ${observed.window[1]}` : null, transactions: observed ? observed.transactions : null,
    }, observed ? [link, observed] : [link], snapshotId);
  }));
  links.total = links.rows.length;
  const unknowns = table(RESULT.pathUnknowns, "unknowns", [["item", "note"]], answer.unknowns.map((unknown) => bundleRow(unknown.id, { item: unknown.text }, [unknown], snapshotId, "unknown")));
  const claimRows = table(RESULT.claims, "table", [["claim", "note"], ["source", "address"], ["chain result", "note"], ["status", "status"]],
    claims.rows.map((row) => bundleRow(row.id, { claim: row.text, source: row.source, "chain result": row.chainResult, status: row.status }, [row], snapshotId)));
  const controlRow = (row: ControlRow): ResultRow => {
    const controller = controllers.get(row.controllerId);
    return bundleRow(row.id, {
      target: row.target, instruction: row.instructions.length > 0 ? row.instructions.join(", ") : null, role: row.role,
      authority: row.holder.address !== "" ? row.holder.address : "none", controller: controller ? controller.label : null, threshold: controller?.threshold ?? null,
    }, controller ? [row, controller] : [row], snapshotId);
  };
  const kinds = unique(control.rows.map((row) => row.targetKind));
  return {
    results: [findings, links, unknowns, claimRows],
    control: (Object.keys(SURFACE_TITLES) as (keyof typeof SURFACE_TITLES)[]).filter((kind) => (kinds as string[]).includes(kind))
      .map((kind) => ({ title: SURFACE_TITLES[kind], rows: control.rows.filter((row) => row.targetKind === kind).map(controlRow) })),
  };
}

export async function marinadePack(root: string): Promise<{ pack: PackData; receipts: ReceiptRecord[]; latest: EvidenceSnapshot }> {
  const snapshots = buildMarinadeSnapshots(join(root, "fixtures"));
  const current = snapshots.at(-1)!;
  const { bundle, records } = await buildMarinadeBundle(root);
  const tokenomics = marinadeResults(bundle, current.id);
  const focus = current.subjects.includes(MSOL) ? MSOL : [...current.subjects].sort(cmp)[0];
  const built = seriesFromSnapshots({
    id: "marinade", title: "Marinade", kindLine: "Liquid staking: mSOL, MNDE and the liquid-staking program", focus, current, captures: snapshots,
    controlFacts: current.facts.filter((fact) => classOf(fact.predicate) === "control"), extraControl: tokenomics.control, kindOf: NO_KINDS, coverage: null, gaps: [],
    change: snapshots.length > 1 ? engineChanges(snapshots[0], current, `changes query of the engine over ${snapshots[0].id} and ${current.id}`) : null,
    captureSource: "src/engine/queries/marinade.ts#buildMarinadeSnapshots over fixtures/marinade-pack and fixtures/marinade-contracts",
    extraResults: tokenomics.results,
  });
  built.series.meta.question = bundle.answer.data!.question;
  built.series.meta.protocolTitle = "Marinade";
  // Ask can use pack templates beyond the app's fixed views. Load the complete
  // public pack receipt set so the same resolver can check those answers too.
  // A tokenomics record supplies no historical state; retain that unknown.
  const known = new Set(built.receipts.map((receipt) => receipt.id));
  const bundleReceipts: ReceiptRecord[] = [...records.keys()].filter((id) => !known.has(id)).sort(cmp).map((id) => {
    const record = records.get(id)!;
    return { id, source: record.fixture ?? record.source, responseSha256: record.responseSha256, blockOrSlot: record.slot, observedAt: record.retrievedAt, historicalState: null, privacy: "public" };
  });
  return {
    pack: {
      id: "marinade", title: "Marinade", line: "Liquid staking: mSOL, MNDE, the liquid-staking program and the path of its fees",
      builder: "src/engine/queries/marinade.ts#buildMarinadeSnapshots; src/tokenomics/build.ts#buildTokenomics", fixtures: ["fixtures/marinade-pack", "fixtures/marinade-contracts", "packs/marinade"],
      index: packIndex("marinade", [current], snapshots.length, "coverage not recorded"), series: [built.series],
    },
    receipts: [...built.receipts, ...bundleReceipts], latest: current,
  };
}
