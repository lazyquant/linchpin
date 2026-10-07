/**
 * Tokenomics API contract, v1 (2026-10-06). Types only; no logic.
 * The server serves these shapes under /api/tokenomics; the research workspace renders them.
 * Treat this file as a stable contract: change it only together with both sides.
 * Every number the UI shows must come from one of these fields; every field carries provenance.
 */

/** How a fact is known. Show it next to every value. */
export type Basis =
  | 'declared'   // from a program's on-chain interface definition (IDL): structure, roles, accounts
  | 'decoded'    // from program account state decoded with that IDL at a slot
  | 'observed'   // from transactions (balances moved, instructions executed) in a stated window
  | 'derived'    // computed from other facts by a stated rule (PDA derivation, sums, formulas)
  | 'claimed'    // stated in documentation or forum text, not checked
  | 'reported'   // a third-party label (exchange, protocol name) with source and date
  | 'inferred';  // linked by name matching (e.g. instruction argument → state field)

export type SectionStatus = 'ready' | 'pending' | 'failed';
export type SectionId = 'answer' | 'path' | 'control' | 'offsets' | 'parameters' | 'programs' | 'participation' | 'holders' | 'flows' | 'claims' | 'graph';

export type Provenance = { basis: Basis | Basis[]; evidenceIds: string[]; slot: number | null; asOf: string | null };
export type Amount = { raw: string; decimals: number; display: string; unit: string; shareOfSupply?: number | null };
export type Address = { address: string; label?: string | null; kind?: string | null; labelBasis?: Basis | null };

/** GET /api/tokenomics → protocols and section readiness. */
export type ProtocolsResponse = { protocols: { id: 'marinade'; title: string; question: string; asOf: string | null; slotRange: [number, number] | null; sections: Record<SectionId, SectionStatus> }[] };

/** GET /api/tokenomics/marinade/:section → one envelope; GET /api/tokenomics/marinade → all envelopes keyed by section. */
export type SectionEnvelope<T> = {
  protocol: 'marinade'; section: SectionId; status: SectionStatus; title: string;
  asOf: string | null; slotRange: [number, number] | null; evidenceCount: number;
  assumptions: string[]; notes: string[]; data: T | null; error?: string;
};
export type BundleResponse = { [K in SectionId]: SectionEnvelope<SectionData[K]> };
export type SectionData = {
  answer: AnswerData; path: PathData; control: ControlData; offsets: OffsetsData; parameters: ParametersData; programs: ProgramsData;
  participation: ParticipationData; holders: HoldersData; flows: FlowsData; claims: ClaimsData; graph: GraphData;
};

/* ---------- answer: the research question ---------- */
export type LinkStatus = 'enforced-by-code' | 'operated-by-accounts' | 'claimed-only' | 'not-observed' | 'contradicted' | 'pending';
export type AnswerData = {
  question: string;                                   // "Is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?"
  shortAnswer: { status: 'yes' | 'no' | 'partly' | 'undetermined'; text: string };   // chain-first, neutral, at most two sentences
  statements: (Provenance & { id: string; text: string; status: LinkStatus | 'verified' | 'unresolved' })[];  // the 4–8 headline findings
  unknowns: (Provenance & { id: string; text: string })[];
};

/* ---------- path: activity → fees → treasury → buybacks → MNDE holders ---------- */
export type PathNode = { id: string; label: string; kind: 'activity' | 'fee' | 'account' | 'program' | 'mechanism' | 'holders' | 'governance'; address?: string | null };
export type ObservedFlow = Provenance & { window: [string, string]; transactions: number; amount: Amount; perDay?: Amount | null; byInstruction?: { instruction: string; amount: Amount; transactions: number }[];
  claims?: number; voterAuthorityClaims?: number; distinctClaimants?: number; voterAuthorityClaimants?: number;
  claimantShare?: number | null; claimedAmountShare?: number | null; voterAuthorityAmount?: Amount;
};
export type PathLink = Provenance & {
  id: string; from: string; to: string; mechanism: string; status: LinkStatus;
  parameters: { id: string; display: string }[];      // ids reference ParametersData rows
  observed: ObservedFlow | null; claims: string[];     // ids reference ClaimsData rows
  controlledBy: string[];                              // ids reference ControlData rows
  note: string;
};
export type PathData = { nodes: PathNode[]; links: PathLink[] };

/* ---------- control: who can change it ---------- */
export type ControllerType = 'dao-governance' | 'council-realm' | 'multisig' | 'wallet' | 'program' | 'none' | 'unresolved';
export type Controller = Provenance & {
  id: string; type: ControllerType; label: string; address: string | null; program?: string | null;
  realm?: { address: string; name: string } | null; governance?: string | null;
  threshold?: string | null; members?: Address[]; note?: string;
  governances?: { address: string; nativeTreasury: string; votingBody: 'council-only' | 'community-only' | 'community-and-council' | 'no-proposals';
    side: 'community' | 'council'; canPropose: boolean; canVote: boolean; canVeto: boolean; thresholds: string }[];
};
export type ControlRow = Provenance & {
  id: string; target: string; targetKind: 'parameter' | 'program-code' | 'mint' | 'treasury' | 'role' | 'operations';
  canChange: string; instructions: string[]; role: string; holder: Address; controllerId: string; controllerIds?: string[]; governance?: string; note?: string;
};
export type ControlData = { rows: ControlRow[]; controllers: Controller[] };

/* ---------- offsets: what works against value reaching MNDE holders ---------- */
export type OffsetsData = { rows: (Provenance & { id: string; label: string; amount: Amount | null; window?: [string, string] | null; note: string })[] };

/* ---------- parameters ---------- */
export type ParameterRow = Provenance & {
  id: string; program: string; field: string; label: string; value: string; display: string; unit: string;
  setBy: { instruction: string; role: string; holder: Address; controllerId: string | null; basis: 'inferred' }[];
};
export type ParametersData = { rows: ParameterRow[] };

/* ---------- programs ---------- */
export type ProgramRow = Provenance & {
  id: string; address: string; idl: { name: string; version: string; instructions: number } | null;
  upgradeable: boolean; upgradeAuthority: (Address & { controllerId: string | null }) | null; lastDeploySlot: number | null;
  activity: { newest: string | null; oldestInWindow: string | null; txPerDay: number | null; dormant: boolean | null };
  upgrades: { time: string | null; slot: number | null; signature: string }[];
};
export type ProgramsData = { rows: ProgramRow[] };

/* ---------- participation: what MNDE does on chain ---------- */
export type Metric = Provenance & { id: string; label: string; value: string; amount?: Amount | null; note?: string };
export type ParticipationData = {
  locking: Metric[];                                   // VSR: voters, locked MNDE, share of supply, by lockup kind, by remaining lockup, top-10 share, reconciliation
  votingPower: Metric[];                               // derived from the registrar configuration
  topLockers: (Provenance & { rank: number; authority: Address; amount: Amount })[];
  programs: (Metric & { program: string })[];          // escrow relocker, gauges, directed stake, referral, Native, delayed unstake
};

/* ---------- holders and float (pending until G4) ---------- */
export type HoldersData = {
  mnde: { metrics: Metric[]; top: (Provenance & { rank: number; owner: Address; amount: Amount; role: string | null })[]; float: Metric[] };
  msol: { metrics: Metric[]; top: (Provenance & { rank: number; owner: Address; amount: Amount; program: string | null; label: string | null })[]; downstream: (Provenance & { entity: string; label: string | null; amount: Amount; accounts: number })[] };
};

/* ---------- flows (pending until G5) ---------- */
export type FlowsData = {
  declaredRoutes: (Provenance & { id: string; program: string; instruction: string; account: string; address: string | null; note: string })[];
  treasury: { inflows: ObservedFlow | null; outflows: (Provenance & { time: string; to: Address; amount: Amount; signature: string })[] };
  buybacks: { months: (Provenance & { month: string; mndeBought: Amount; cost: Amount[]; mndeSent: Amount; recipients: number; shareToLockers: number | null;
    /** MNDE credited with no payment in the same transaction (e.g. order-program fills); cost not observed. Optional, added 2026-10-06. */
    mndeCreditedWithoutPayment?: Amount; creditTransactions?: number })[];
    /** Programs (other than token, ATA, system, compute budget) in the credit-without-payment transactions. Optional. */
    creditPrograms?: string[] };
};

/* ---------- claims vs chain ---------- */
export type ClaimRow = Provenance & { id: string; text: string; source: string; status: 'verified' | 'contradiction' | 'unresolved' | 'partly' | 'claimed'; chainResult: string; note: string };
export type ClaimsData = { rows: ClaimRow[] };

/* ---------- graph (Neo4j :TG namespace, local fallback) ---------- */
export type GraphQueryResult = { id: string; title: string; question: string; cypher: string; params: Record<string, unknown>; columns: string[]; rows: Record<string, string | number | null>[] };
export type GraphData = {
  source: 'neo4j' | 'local'; host: string | null; reason: string | null; configured: boolean;
  queries: GraphQueryResult[];
  subgraph: { nodes: { id: string; label: string; type: string }[]; edges: { id: string; from: string; to: string; type: string; basis: Basis; label: string }[] };
};

/** GET /api/tokenomics/marinade/evidence?id=…&id=… (max 200 ids) → the evidence records behind any value. */
export type EvidenceRecord = { id: string; method: string; params: unknown; slot: number | null; retrievedAt: string; responseSha256: string; source: 'fixture' | 'rpc'; fixture: string | null };
export type EvidenceResponse = { items: EvidenceRecord[]; missing: string[] };
