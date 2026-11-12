/** Adapters from engine facts and receipts to the kit's results. They copy; they do not interpret. */
import type { EvidenceReceipt, Fact } from "../engine/contracts";
import type { BlockOrSlot, Cell, ColumnRole, GraphEdge, GraphNode, GraphResult, ResultRow, ResultSet } from "./types";

export type FactField = "subject" | "predicate" | "object" | "status" | "validFrom" | "validTo" | "observedAt";
export interface FactColumn { name: string; role: ColumnRole; field: FactField }

const DEFAULT_COLUMNS: FactColumn[] = [
  { name: "subject", role: "subject", field: "subject" },
  { name: "predicate", role: "label", field: "predicate" },
  { name: "object", role: "value", field: "object" },
  { name: "status", role: "status", field: "status" },
];

const DECIMAL = /^[0-9]+$/;

/** The block and time a set of receipts gives one fact: the greatest block, the latest observation time. Values are returned as stored. */
function observed(receipts: EvidenceReceipt[]): { blockOrSlot: BlockOrSlot; asOf: string | null } {
  const blocks = receipts.map((receipt) => receipt.observation.blockOrSlot).filter((block): block is string => block !== null);
  let blockOrSlot: BlockOrSlot = null;
  if (blocks.length > 0) {
    blockOrSlot = blocks[0];
    if (blocks.every((block) => DECIMAL.test(block))) {
      for (const block of blocks) if (BigInt(block) > BigInt(blockOrSlot)) blockOrSlot = block;
    }
  }
  let asOf: string | null = null;
  for (const receipt of receipts) {
    const at = receipt.observation.observedAt;
    if (typeof at === "string" && (asOf === null || at > asOf)) asOf = at;
  }
  return { blockOrSlot, asOf };
}

function receiptIndex(receipts: EvidenceReceipt[]): Map<string, EvidenceReceipt> {
  return new Map(receipts.map((receipt) => [receipt.id, receipt]));
}

/**
 * One row per fact, in input order. A fact that cites an evidence id with no receipt gets no row and one entry in
 * `skipped`. A fact that cites nothing keeps its row; the row then reads "no evidence" and the validator refuses it.
 */
export function factsToResult(
  facts: Fact[],
  receipts: EvidenceReceipt[],
  opts: { id: string; shape: "table" | "chain" | "path" | "unknowns"; columns?: FactColumn[]; snapshotIds?: string[] },
): { result: ResultSet; skipped: { factId: string; reason: "missing-receipt"; evidenceIds: string[] }[] } {
  const byId = receiptIndex(receipts);
  const columns = opts.columns ?? DEFAULT_COLUMNS;
  const rows: ResultRow[] = [];
  const skipped: { factId: string; reason: "missing-receipt"; evidenceIds: string[] }[] = [];
  for (const fact of facts) {
    const missing = fact.evidenceIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      skipped.push({ factId: fact.id, reason: "missing-receipt", evidenceIds: missing });
      continue;
    }
    const { blockOrSlot, asOf } = observed(fact.evidenceIds.map((id) => byId.get(id)!));
    const values: Record<string, Cell> = {};
    for (const column of columns) values[column.name] = column.field === "observedAt" ? asOf : fact[column.field];
    rows.push({
      rowKind: opts.shape === "unknowns" || fact.object === "unknown" || fact.basis === "unknown" ? "unknown" : "fact",
      key: fact.id,
      values,
      factIds: [fact.id],
      bases: [fact.basis],
      evidenceIds: [...fact.evidenceIds],
      blockOrSlot,
      asOf,
      snapshotIds: [...(opts.snapshotIds ?? [])],
    });
  }
  return {
    result: {
      resultId: opts.id,
      shape: opts.shape,
      columns: columns.map(({ name, role }) => ({ name, role })),
      coverage: "mapped",
      coverageNotes: [],
      rows,
      truncated: false,
    },
    skipped,
  };
}

/**
 * A graph whose every edge is one fact. A fact is a relation when its subject and its object are both given nodes.
 * A node no edge names is kept and marked isolated. With `receipts`, an edge takes its block and time from them and a
 * fact citing a receipt that is not among them is skipped; without, both are `null`.
 */
export function graphResult(
  nodes: { id: string; label?: string }[],
  facts: Fact[],
  opts: { id?: string; receipts?: EvidenceReceipt[] } = {},
): { result: GraphResult; skipped: { factId: string; reason: "not-a-relation" | "missing-receipt" }[] } {
  const ids = new Set(nodes.map((node) => node.id));
  const byId = opts.receipts ? receiptIndex(opts.receipts) : null;
  const edges: GraphEdge[] = [];
  const skipped: { factId: string; reason: "not-a-relation" | "missing-receipt" }[] = [];
  const named = new Set<string>();
  for (const fact of facts) {
    if (!ids.has(fact.subject) || !ids.has(fact.object)) {
      skipped.push({ factId: fact.id, reason: "not-a-relation" });
      continue;
    }
    let seen: { blockOrSlot: BlockOrSlot; asOf: string | null } = { blockOrSlot: null, asOf: null };
    if (byId) {
      if (fact.evidenceIds.some((id) => !byId.has(id))) {
        skipped.push({ factId: fact.id, reason: "missing-receipt" });
        continue;
      }
      seen = observed(fact.evidenceIds.map((id) => byId.get(id)!));
    }
    named.add(fact.subject);
    named.add(fact.object);
    edges.push({
      key: fact.id,
      from: fact.subject,
      to: fact.object,
      relation: fact.predicate,
      factIds: [fact.id],
      bases: [fact.basis],
      evidenceIds: [...fact.evidenceIds],
      blockOrSlot: seen.blockOrSlot,
      asOf: seen.asOf,
    });
  }
  const outNodes: GraphNode[] = nodes.map((node) => ({ id: node.id, label: node.label ?? node.id, isolated: !named.has(node.id) }));
  return {
    result: { resultId: opts.id ?? "graph", shape: "graph", coverage: "mapped", coverageNotes: [], nodes: outNodes, edges, truncated: false },
    skipped,
  };
}
