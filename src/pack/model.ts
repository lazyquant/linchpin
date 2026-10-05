import type { TreasuryLedger } from "./ledger";
export type Status = "verified" | "claimed" | "contradiction" | "unresolved" | "outside-scope";
export type ControllerPath = { subject: string; subjectKind: "program" | "mint" | "account"; role: string; authorityType: "upgrade" | "mint" | "freeze" | "owner" | "stake" | "config"; authority: string | null; authorityKind: string; path: string[]; status: Status; claims: { text: string; source: string }[]; evidenceIds: string[]; slot: number | null; note: string };
export type Statement = { id: string; topic: "supply" | "governance" | "treasury"; text: string; status: Status; evidenceIds: string[]; slot: number | null };
export type PackClaim = { id: string; text: string; source: string; retrievedAt: string; checkable: boolean; status: Status; note: string };
export type Unknown = { id: string; text: string; firstSeen: string };
export type PackPacket = { pack: string; title: string; generatedAt: string; offline: boolean; asOfSlotRange: [number, number]; researchQuestion: string; controllerPaths: ControllerPath[]; statements: Statement[]; claims: PackClaim[]; unknowns: Unknown[]; ledger: TreasuryLedger; coverage: { total: number; verified: number; claimed: number; contradiction: number; unresolved: number }; evidenceCount: number };
