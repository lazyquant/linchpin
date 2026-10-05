import type { Basis } from "../governance/effects";
export type NodeType = "Realm" | "Governance" | "NativeTreasury" | "TokenAccount" | "Mint" | "Proposal" | "ProposalTransaction" | "Instruction" | "Effect" | "SimulationRun" | "ExecutionReceipt" | "Claim" | "Mechanism" | "Program";
export type GNode = { id: string; type: NodeType; label: string; props?: Record<string, unknown> };
export type GEdge = { from: string; to: string; type: string; basis: Basis; evidenceIds: string[]; props?: Record<string, unknown> };
export type Graph = { nodes: GNode[]; edges: GEdge[] };
