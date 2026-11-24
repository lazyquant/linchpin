import type { Basis, EvidenceStatus, EvidenceReceipt, Fact, FactChange, QueryReason, QueryResult } from "../../engine/contracts";

export class PanelRejected extends Error {
  constructor(public readonly code: "missing-subject" | "invalid-document" | "invalid-surface", public readonly subject: string | null = null, public readonly codes: string[] = []) {
    super(code + (subject ? ": " + subject : "") + (codes.length ? " (" + codes.join(", ") + ")" : ""));
    this.name = "PanelRejected";
  }
}
export interface PanelRow {
  what: string; value: string; basis: string; status: EvidenceStatus;
  factIds: string[]; evidenceIds: string[]; gap: boolean;
  subject?: string; predicate?: string; role?: string; members?: string[];
  reason?: QueryReason; change?: FactChange;
}
export interface PanelSection { id: string; title: string; rows: PanelRow[] }
export interface PanelData {
  schema: "linchpin.near-panel/1"; subject: string; account: string; kind: string;
  capture: {
    snapshotId: string; constructed: boolean; label: string;
    fromBlockOrSlot: string | null; toBlockOrSlot: string | null;
    capturedAt: string; observedFrom: string; observedTo: string;
  };
  sections: PanelSection[]; facts: Fact[]; receipts: EvidenceReceipt[];
  relationFactIds: string[]; reasons: QueryReason[]; queries: QueryResult[];
  comparison: null | { beforeSnapshotId: string; afterSnapshotId: string; queries: { subject: string; result: QueryResult }[] };
}
export type FactBasis = Basis;

