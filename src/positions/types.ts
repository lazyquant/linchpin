import type { EvidenceReceipt, PrivatePosition } from "../engine/contracts";
export type NotReadReason = "not-covered" | "missing-decimals" | "rpc-method-unavailable" | "rpc-method-refused" | "rpc-error" | "timeout" | "malformed-response" | "chain-not-supported";
export interface NotRead { subject: string; reason: NotReadReason }
export type ReaderPosition = PrivatePosition & { receiptIds: string[] };
export interface AccountSetting { subject: string; setting: string; value: string; receiptIds: string[]; label?: string; labelSnapshotId?: string }
export interface ReadResult { accountSettings?: AccountSetting[]; coverageSnapshotId?: string; positions: ReaderPosition[]; receipts: EvidenceReceipt[]; notRead: NotRead[] }
export interface ReadInput { chain: string; address: string; snapshotId: string; client: unknown; registry?: unknown }
export class PositionsRejected extends Error {
  constructor(public readonly code: string) { super(code); this.name = "PositionsRejected"; }
}
