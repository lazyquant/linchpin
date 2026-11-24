/**
 * From engine facts and receipts to kit rows. These functions copy: a row's fact ids, bases and evidence ids are
 * those of the facts it is made of, each once and in order, and its block or slot and time come from their receipts.
 */
import type { EvidenceReceipt, Fact, FactChange } from "../../engine/contracts";
import type { BlockOrSlot, Cell, ChangeRow, ChangeSide, ColumnRole, GraphEdge, GraphNode, GraphResult, ReceiptRecord, ResultRow, ResultSet } from "../../ui/types";

const DECIMAL = /^[0-9]+$/;
const IDENTITY = /^[a-z0-9-]+:[a-z0-9-]+:/;
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const unique = <T>(values: T[]): T[] => [...new Set(values)];
export const isIdentity = (value: string): boolean => IDENTITY.test(value);

export type ReceiptIndex = Map<string, EvidenceReceipt>;
export type KindOf = (id: string) => { kind: string; basis: string } | null;

export function receiptRecord(receipt: EvidenceReceipt): ReceiptRecord {
  return {
    id: receipt.id, source: receipt.source, responseSha256: receipt.responseSha256, blockOrSlot: receipt.observation.blockOrSlot,
    observedAt: receipt.observation.observedAt ?? null, historicalState: receipt.observation.historicalState, privacy: receipt.privacy,
    ...(receipt.observation.historicalState === "constructed" ? { constructed: true as const } : {}),
  };
}

/** The greatest block or slot and the latest observation time over the receipts of some facts. Values as stored. */
export function observedOf(evidenceIds: string[], receipts: ReceiptIndex): { blockOrSlot: BlockOrSlot; asOf: string | null } {
  const found = evidenceIds.map((id) => receipts.get(id)).filter((receipt): receipt is EvidenceReceipt => receipt !== undefined);
  const blocks = found.map((receipt) => receipt.observation.blockOrSlot).filter((block): block is string => block !== null);
  let blockOrSlot: BlockOrSlot = null;
  if (blocks.length > 0) {
    blockOrSlot = blocks[0];
    if (blocks.every((block) => DECIMAL.test(block))) for (const block of blocks) if (BigInt(block) > BigInt(blockOrSlot)) blockOrSlot = block;
  }
  let asOf: string | null = null;
  for (const receipt of found) {
    const at = receipt.observation.observedAt;
    if (typeof at === "string" && (asOf === null || at > asOf)) asOf = at;
  }
  return { blockOrSlot, asOf };
}

const isUnknownFact = (fact: Fact): boolean => fact.object === "unknown" || fact.basis === "unknown";

/** A row made of one or more facts. */
export function rowOf(facts: Fact[], values: Record<string, Cell>, receipts: ReceiptIndex, snapshotId: string, key = facts[0].id): ResultRow {
  const evidenceIds = unique(facts.flatMap((fact) => fact.evidenceIds));
  return {
    rowKind: facts.some(isUnknownFact) ? "unknown" : "fact",
    key, values,
    factIds: facts.map((fact) => fact.id),
    bases: unique(facts.map((fact) => fact.basis as string)),
    evidenceIds,
    ...observedOf(evidenceIds, receipts),
    snapshotIds: [snapshotId],
  };
}

export function table(resultId: string, shape: ResultSet["shape"], columns: [string, ColumnRole][], rows: ResultRow[], extra: Partial<ResultSet> = {}): ResultSet {
  return { resultId, shape, columns: columns.map(([name, role]) => ({ name, role })), coverage: "mapped", coverageNotes: [], rows, truncated: false, ...extra };
}

export const CHAIN_COLUMNS: [string, ColumnRole][] = [
  ["target", "address"], ["instruction", "instruction"], ["role", "role"], ["authority", "address"], ["controller", "address"], ["threshold", "amount"],
];
export const FACT_COLUMNS: [string, ColumnRole][] = [
  ["subject", "subject"], ["predicate", "label"], ["object", "value"], ["status", "status"], ["layer", "label"], ["subject kind", "label"], ["object kind", "label"],
];
export const GAP_COLUMNS: [string, ColumnRole][] = [["item", "label"], ["account", "address"], ["detail", "note"]];

/**
 * Control facts as chain rows. A fact that names an authority is one row; where the same set holds a
 * CONTROLLED_BY fact about that authority, the row carries its object as the controller and cites both facts.
 * A CONTROLLED_BY fact no row took is its own row. MULTISIG_MEMBER facts are returned apart, as members.
 */
export function controlRows(facts: Fact[], receipts: ReceiptIndex, snapshotId: string): { chain: ResultRow[]; members: Fact[] } {
  const ordered = [...facts].sort((a, b) => cmp(a.subject, b.subject) || cmp(a.predicate, b.predicate) || cmp(a.object, b.object) || cmp(a.id, b.id));
  const members = ordered.filter((fact) => fact.predicate === "MULTISIG_MEMBER");
  const controlled = ordered.filter((fact) => fact.predicate === "CONTROLLED_BY");
  const taken = new Set<string>();
  const chain: ResultRow[] = [];
  for (const fact of ordered) {
    if (fact.predicate === "MULTISIG_MEMBER" || fact.predicate === "CONTROLLED_BY") continue;
    const joined = controlled.find((candidate) => candidate.subject === fact.object);
    if (joined) taken.add(joined.id);
    chain.push(rowOf(joined ? [fact, joined] : [fact], {
      target: fact.subject, instruction: null, role: fact.predicate, authority: fact.object, controller: joined ? joined.object : null, threshold: null,
    }, receipts, snapshotId));
  }
  for (const fact of controlled) {
    if (taken.has(fact.id)) continue;
    chain.push(rowOf([fact], { target: fact.subject, instruction: null, role: fact.predicate, authority: fact.object, controller: null, threshold: null }, receipts, snapshotId));
  }
  return { chain, members };
}

/** One row per fact with the columns a fact card reads. */
export function factRows(facts: Fact[], receipts: ReceiptIndex, snapshotId: string, layerOf: (predicate: string) => string, kindOf: KindOf): ResultRow[] {
  return facts.map((fact) => rowOf([fact], {
    subject: fact.subject, predicate: fact.predicate, object: fact.object, status: fact.status, layer: layerOf(fact.predicate),
    "subject kind": kindOf(fact.subject)?.kind ?? null, "object kind": isIdentity(fact.object) ? kindOf(fact.object)?.kind ?? null : null,
  }, receipts, snapshotId));
}

/**
 * The graph of a capture: a node for every subject and every identity a fact names, an edge for every fact that
 * is not a state fact and whose object is an identity, `none` or `unknown`.
 */
export function graphOf(
  subjects: string[], facts: Fact[], receipts: ReceiptIndex, names: Record<string, string>,
  opts: { classOf: (predicate: string) => string | null; layerOf: (predicate: string) => string; kindOf: KindOf },
): GraphResult {
  const relations = facts.filter((fact) => opts.classOf(fact.predicate) !== "state" && (isIdentity(fact.object) || fact.object === "none" || fact.object === "unknown"));
  const ids = unique([...subjects, ...facts.map((fact) => fact.subject), ...relations.filter((fact) => isIdentity(fact.object)).map((fact) => fact.object)]).sort(cmp);
  const named = new Set(relations.flatMap((fact) => [fact.subject, fact.object]));
  const nodes: GraphNode[] = ids.map((id) => {
    const node: GraphNode = { id, label: id, isolated: !named.has(id) };
    const kind = opts.kindOf(id);
    if (kind) {
      node.kind = kind.kind;
      node.kindBasis = kind.basis;
    }
    if (typeof names[id] === "string" && names[id] !== "") node.name = names[id];
    return node;
  });
  const edges: GraphEdge[] = relations.map((fact) => ({
    key: fact.id, from: fact.subject, to: fact.object, relation: fact.predicate, factIds: [fact.id], bases: [fact.basis],
    evidenceIds: [...fact.evidenceIds], ...observedOf(fact.evidenceIds, receipts), layer: opts.layerOf(fact.predicate),
  }));
  return { resultId: "graph", shape: "graph", coverage: "mapped", coverageNotes: [], nodes, edges, truncated: false, total: edges.length };
}

/** The value of a state fact as recorded, without the `amount:` marker of the vocabulary. */
export const plainObject = (object: string): string => (object.startsWith("amount:") ? object.slice("amount:".length) : object);

function changeSide(fact: Fact | null, receipts: ReceiptIndex): ChangeSide {
  if (fact === null) return { absent: true, reason: "not in this capture" };
  return { value: plainObject(fact.object), bases: [fact.basis], evidenceIds: [...fact.evidenceIds], factIds: [fact.id], ...observedOf(fact.evidenceIds, receipts) };
}

export function changeRows(changes: FactChange[], receipts: ReceiptIndex, constructed = false): ChangeRow[] {
  return changes.map((change) => ({
    kind: change.kind, key: change.key, before: changeSide(change.before, receipts), after: changeSide(change.after, receipts),
    ...(constructed ? { constructed: true as const } : {}),
  }));
}

/** A row that states a named gap: what is absent, why, and where the statement comes from. Scope, never evidence. */
export function gapRow(key: string, reason: "not-captured" | "not-computed" | "not-mapped" | "not-read", source: string, values: Record<string, Cell>, constructed = false): ResultRow {
  return {
    rowKind: "scope", key, values, factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [], scopeSource: source, reason,
    ...(constructed ? { constructed: true as const } : {}),
  };
}

/** The first rows of a result, with the count of all of them. */
export function lead<T extends { rows: unknown[]; truncated: boolean; total?: number }>(result: T, resultId: string, count = 3): T {
  return { ...result, resultId, rows: result.rows.slice(0, count), truncated: result.rows.length > count, total: result.rows.length };
}
