import { buildEvidenceRecords } from "../evidence/build";
import { collectSlice1Inputs, type EvidenceInput, type ProtocolEntry } from "../evidence/protocols";
import { runEvidenceLocal } from "../evidence/templates";
import { TERMS, type TermRef } from "./terms";
import { join } from "node:path";

/**
 * Twelve competency questions for the core vocabulary. Each has a yes case and a no case, run offline
 * through the local twin of the evidence templates over the committed snapshots. An expected row is a
 * literal fact id of a named snapshot, or an explicit unknown, none, coverage or receipt row. A case
 * no committed snapshot can hold is `uncovered` and says what is missing; it is never invented.
 */
export interface FactRef { snapshotId: string; factId: string }
export type HistoricalState = "current-only" | "constructed" | "pinned" | "unknown";
export type ExpectedRow =
  | { rowKind: "fact"; fact: FactRef }
  | { rowKind: "unknown"; fact: FactRef; object: "unknown" | "none" }
  | { rowKind: "path"; facts: FactRef[]; unordered?: true }
  | { rowKind: "coverage"; mechanic: string; status: "mapped" | "partial" | "not-mapped" }
  | { rowKind: "receipt"; snapshotId: string; receiptId: string; historicalState: HistoricalState };
export interface ExpectedChange { kind: "added" | "removed" | "changed"; before: FactRef | null; after: FactRef | null }
export interface Expectation {
  /** Compared as a set with the actual rows. Absent: the rows are not compared. */
  rows?: ExpectedRow[];
  /** At least one row, and every actual row is a coverage row. */
  onlyCoverageRows?: true;
  /** Each "<code>:<subject>" must be among the actual reasons; an empty list means there must be none. */
  reasons?: string[];
  /** Reason codes that must not occur. */
  noReasons?: string[];
  /** Compared as a set; an empty list means no change at all. */
  changes?: ExpectedChange[];
}
export interface Step { template: string; params: Record<string, unknown> }
/** `expect[i]` checks step `i`. */
export interface QuestionCase { status: "covered" | "uncovered"; missing?: string; steps: Step[]; expect: Expectation[] }
export interface Question { id: string; question: string; useCase: string; terms: TermRef[]; yes: QuestionCase; no: QuestionCase }

const K1 = "solana-mainnet-beta.kamino.sentora-pyusd-20261109T163416Z";
const K2 = "solana-mainnet-beta.kamino.sentora-pyusd-20261109T170418Z";
const N = "near-2026-11-09";
const NC = "near-constructed-intents-locker-added";
const K2_AS_OF = "2026-11-09T17:04:20.763Z";
const N_AS_OF = "2026-11-09T19:33:38.487Z";

const VAULT = "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
const PROGRAM = "solana:mainnet-beta:KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const ADMIN = "solana:mainnet-beta:7fLxEftpppneavpueYgP2s7HhSGbWpj2jTCmAEwwqonY";
const ORACLE = "solana:mainnet-beta:3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";
const RESERVE_1 = "solana:mainnet-beta:2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN";
const BURROW = "near:mainnet:contract.main.burrow.near";
const NEAR_ORACLE = "near:mainnet:aggregate-oracle.near";
const IDLE_RECEIPT_K2 = "2e2635128c22faea2394f56dfd73b6dff91dbaf030bf5d91f36af2ebcf5a5daa";
const HASH_RECEIPT_NC = "nr:near-constructed-intents-locker-added:cba4d016e6ef8994405a33e21c1e49e928994ae6";

/** Fact ids, each resolved from the committed snapshot by subject, predicate and object. */
const F = {
  vOwnerProgram: "632f61b38ee1ec27d44d0b1bd0d5e4c3bcd62b814a9902c2ebf73d55b979a68a",
  programUpgradeAuthority: "907823c8d77c9c5cc46aadc91c1b529769e02f26a17a66c590cc7eb762ea681a",
  vaultAdmin: "3de7f904df43fdfaa706a7737228ab00c23f843120baf4e93c388d8963c33489",
  allocationAdmin: "624f867df03c2b5fee7ea5c8e980f6eb0d559631641224653cf7c5978cf26e95",
  adminControllerUnknown: "6c2d405f54a3c5dda709ecd8ccab90ab1e1b0af999b75fb477567af2fd88819d",
  allocatesTo1: "02ea89ae27c65ad8e0b3fc7b5d48a683e24f2aa6cfec31a20d97a9530882021d",
  allocatesTo2: "1793d7e0665b99250ff735c39c1fa67422ac64b8328a0d4c60feaec9fdb0954b",
  allocatesTo3: "2b6a28be673cdd075946566d23e1cdfdbe7de23a52ccb5d24d2e112ff196f7a9",
  allocatesTo4: "46b128ac093f00503772621ef83704b18e6990b2032eb717aa51e59a245896e1",
  allocatesTo5: "5342426c365577a7091615672a11ca01400e04ae6063fa2e9d7ab0fdf7ed2424",
  allocatesTo6: "58e9691a15e129763df7e54f7ac008fc5ac94deb129dcbf79d7a3c6d4bf3bfa8",
  allocatesTo7: "792cfeeebb6f7d4da6113db08b7838c3931c3b34438d34c4525a8ab300697340",
  pricedBy1: "5f924830223f6384172a6a3a33db7e2015c7ec1e7417cd099a250d0a6308c8af",
  pricedBy2: "44fbb4a0a4d8151b8ec033417851eca0d1ae70bfe599a86aba3bd2ad9d4d91d1",
  pricedBy3: "7924dc7e1cc580bc61f06084b4daf7205b800dc7101ab43160c886b278d40861",
  pricedBy4: "09f7aa6f84c465a4be97f5aa336494c4d3e19ce83fb3130073637b19d93c05e8",
  pricedBy5: "f92aa05c44fb8bf36b9baefaa57e38e04947e118caa499216d39d9be50c81485",
  pricedBy6: "5fa00ebc09f026d948ef748f94ac7ec90517c98a64f7ee000f6243f77c9f8386",
  pricedBy7: "468e4e4a851e3b6276f232e87303d115cbbcecd723fb0f19158dc5c22e9de255",
  vaultIdleBefore: "8ffe52182f3bd2ffa8f94eee25120f608657a8452eccd121d8aaf683c9967e38",
  vaultIdleAfter: "7a24f735be80b62c077dd7d308133f272da55a4d80547f198b8fcfb922ecce36",
  burrowContractMode: "nf:near-2026-11-09:c82519a301f878adfe3efe4a67e8511aad03b6b6",
  burrowFullAccessKeyNone: "nf:near-2026-11-09:d8ae9f39188c79dd540905832628d131e0642c60",
  burrowOwnedBy: "nf:near-2026-11-09:c3c3c48a7c309c1346507c8dfe6ca352dbd255e7",
  burrowPauseOperatorNone: "nf:near-2026-11-09:bae1e2997427d09aede7ced61f1fd206d3567618",
  councilMember_brhost_near: "nf:near-2026-11-09:d47f59ba3780ce2d31979bec6317a8c837131ef2",
  councilMember_brrrb_near: "nf:near-2026-11-09:01c411acf429fc4f351c0b95dfcaccaa55325162",
  councilMember_farbread8025_near: "nf:near-2026-11-09:47b40b6215417842c86af84b8c4b7a871b33a739",
  councilMember_nicktrust_near: "nf:near-2026-11-09:2c0ea07d1b7bd4835678b757f02bd6df3125c807",
  councilMember_wannamakeit_near: "nf:near-2026-11-09:550dd0117401332123222074a17065dfca48419d",
  garbageCollectorNone: "nf:near-2026-11-09:046fb7dca12e563b92d76ce0b656f6d2eec4eb74",
  burrowLegacyOracle: "nf:near-2026-11-09:a8182f94a992b7dd65616bcd3a1a4d62e73bda5a",
  burrowPricedBy: "nf:near-2026-11-09:5f7fb71584011ed7b662837fd401ac50fe99b7ad",
  burrowRoutesDcl: "nf:near-2026-11-09:ca2e45a79814668ce1fedb2e2b98b0792d0d896f",
  burrowRoutesRef: "nf:near-2026-11-09:7fdc415226369d29e750be4c56d74e7c3e78ab04",
  aggregateOracleOwnerUnknown: "nf:near-2026-11-09:c4749babce0f6c3b2d6aec8add2f7f327e28a2a1",
  dclOwnerUnknown: "nf:near-2026-11-09:99d267c5960d306fcca87d6c4cce1a74ff810c68",
  priceOracleOwnerUnknown: "nf:near-2026-11-09:cb076ca93a8a391726a7e03fbee71e1f31711db7",
  sputnikDeployedBy: "nf:near-2026-11-09:9435558b4052fcdd2f82c5877850960b39a9c9f0",
  refOwnedBy: "nf:near-2026-11-09:b3270450173c554966d70a332bb63e52ba7411f7",
  marketOwnerGroup1: "18eb404836533793a8ddcf435aa54de67b9c4b2703d515b66e2cc60cce0322a6",
  marketOwnerGroup2: "5505aa88cff2c2a6a36805b3235d33089b8c826180a244389fb37b9ed179ac08",
  marketOwnerGroup3: "7fb1d10cb693c6e65ac60d4f5a8b7aec88049f74fb6ba640231b35fce5007d82",
  marketOwnerGroup4: "eb2803852c64475650542e1136cbb4ebb151c6fa301bd1f7952e878f2fc109c5",
  marketOwnerGroup5: "eca60167fb8058d91fddcf67a09767181132b45c7fe554737eab8d610db0b9be",
  adminGroup1: "3de7f904df43fdfaa706a7737228ab00c23f843120baf4e93c388d8963c33489",
  adminGroup2: "624f867df03c2b5fee7ea5c8e980f6eb0d559631641224653cf7c5978cf26e95",
  adminGroup3: "6bf4226cf14d1d2986d4f7e0aa35cecad6a78ca768fe3b70f7a71293d3ab9c88",
  adminGroup4: "adbd1143a9d34fe04d4e94430167c80863344ce5dd3acd5d8ab9ecd54f5fb329",
  upgradeGroup1: "907823c8d77c9c5cc46aadc91c1b529769e02f26a17a66c590cc7eb762ea681a",
  upgradeGroup2: "9f815d5a75a5979666c7f582f1d686486c74170f350c2f6555971c3420dcead6",
  constructedCodeHash: "nf:near-constructed-intents-locker-added:5980623161f4591ee842520ffe8c362fcaa6d0b9",
} as const;

const k1 = (factId: string): FactRef => ({ snapshotId: K1, factId });
const k2 = (factId: string): FactRef => ({ snapshotId: K2, factId });
const n = (factId: string): FactRef => ({ snapshotId: N, factId });
const nc = (factId: string): FactRef => ({ snapshotId: NC, factId });
const fact = (ref: FactRef): ExpectedRow => ({ rowKind: "fact", fact: ref });
const unknownRow = (ref: FactRef, object: "unknown" | "none"): ExpectedRow => ({ rowKind: "unknown", fact: ref, object });
const path = (...facts: FactRef[]): ExpectedRow => ({ rowKind: "path", facts });
const unorderedPath = (...facts: FactRef[]): ExpectedRow => ({ rowKind: "path", facts, unordered: true });
const coverage = (entries: [string, "mapped" | "partial" | "not-mapped"][]): ExpectedRow[] =>
  entries.map(([mechanic, status]) => ({ rowKind: "coverage", mechanic, status }));
const scope = (snapshotId: string, asOf: string, maxHops: number) => ({ snapshotId, asOf, maxHops, maxResults: 100 });
const term = (type: TermRef["type"], ...names: string[]): TermRef[] => names.map(name => ({ type, name }));
const P = (...names: string[]) => term("predicate", ...names);
const C = (...names: string[]) => term("coreType", ...names);
const K = (...names: string[]) => term("kind", ...names);

const KAMINO_COVERAGE = coverage([
  ["claims", "not-mapped"], ["code-upgrade", "mapped"], ["control", "mapped"], ["dependencies", "mapped"], ["fees", "not-mapped"], ["flows", "not-mapped"],
  ["governance", "not-mapped"], ["holders", "not-mapped"], ["parameters", "not-mapped"], ["supply", "not-mapped"], ["treasury", "not-mapped"],
]);
const MPC_COVERAGE = coverage([
  ["claims", "not-mapped"], ["code-upgrade", "partial"], ["control", "partial"], ["dependencies", "not-mapped"], ["fees", "not-mapped"], ["flows", "not-mapped"],
  ["governance", "not-mapped"], ["holders", "not-mapped"], ["parameters", "not-mapped"], ["supply", "not-mapped"], ["treasury", "not-mapped"],
]);

const RELATIONS_NEAR = ["owned-by", "priced-by", "legacy-oracle", "routes-through", "deployed-by"];

export const QUESTIONS: readonly Question[] = [
  {
    id: "CQ1", question: "Who can upgrade the code a given vault runs on?", useCase: "Find the party that can change a vault's behaviour by replacing its code.",
    terms: [...P("OWNER_PROGRAM", "UPGRADE_AUTHORITY"), ...C("OWNER_PROGRAM", "UPGRADE_AUTHORITY"), ...K("Vault", "Program")],
    yes: {
      status: "covered",
      steps: [
        { template: "dependencies", params: { subject: VAULT, relations: ["OWNER_PROGRAM"], scope: scope(K2, K2_AS_OF, 1) } },
        { template: "control", params: { subject: PROGRAM, scope: scope(K2, K2_AS_OF, 1) } },
      ],
      expect: [
        { rows: [fact(k2(F.vOwnerProgram))], noReasons: ["no-facts"] },
        { rows: [fact(k2(F.programUpgradeAuthority))], noReasons: ["no-facts"] },
      ],
    },
    no: {
      status: "covered",
      // A program has no owner-program fact: the chain stops here and nothing is invented.
      steps: [{ template: "dependencies", params: { subject: PROGRAM, relations: ["OWNER_PROGRAM"], scope: scope(K2, K2_AS_OF, 1) } }],
      expect: [{ rows: KAMINO_COVERAGE, onlyCoverageRows: true, reasons: [`no-facts:${PROGRAM}`] }],
    },
  },
  {
    id: "CQ2", question: "Which accounts administer a given vault, and in which role?", useCase: "List the administrators of a vault with the role each one holds.",
    terms: [...P("VAULT_ADMIN", "ALLOCATION_ADMIN"), ...C("ADMIN"), ...K("Vault")],
    yes: {
      status: "covered",
      steps: [{ template: "control", params: { subject: VAULT, scope: scope(K2, K2_AS_OF, 1) } }],
      expect: [{ rows: [fact(k2(F.allocationAdmin)), fact(k2(F.vaultAdmin))], noReasons: ["no-facts"] }],
    },
    no: {
      status: "covered",
      // A reserve has no administrator of its own.
      steps: [{ template: "control", params: { subject: RESERVE_1, scope: scope(K2, K2_AS_OF, 1) } }],
      expect: [{ rows: KAMINO_COVERAGE, onlyCoverageRows: true, reasons: [`no-facts:${RESERVE_1}`] }],
    },
  },
  {
    id: "CQ3", question: "Is the controller of a given account established?", useCase: "Tell an established controller apart from one that is unknown, never reading unknown as absent.",
    terms: [...P("CONTROLLED_BY", "owned-by"), ...C("CONTROLLED_BY", "OWNED_BY")],
    yes: {
      status: "covered",
      steps: [{ template: "control", params: { subject: BURROW, scope: scope(N, N_AS_OF, 1) } }],
      expect: [{
        rows: [fact(n(F.burrowContractMode)), unknownRow(n(F.burrowFullAccessKeyNone), "none"), fact(n(F.burrowOwnedBy)), unknownRow(n(F.burrowPauseOperatorNone), "none")],
        noReasons: ["unknown-controller"],
      }],
    },
    no: {
      status: "covered",
      // The controller is unknown: the answer is an explicit unknown row, not an empty result.
      steps: [{ template: "control", params: { subject: ADMIN, scope: scope(K2, K2_AS_OF, 1) } }],
      expect: [{ rows: [unknownRow(k2(F.adminControllerUnknown), "unknown")], reasons: [`unknown-controller:${ADMIN}`] }],
    },
  },
  {
    id: "CQ4", question: "Which price sources does a vault depend on through the reserves it allocates to?", useCase: "Trace a vault's exposure to price feeds across the reserves it funds.",
    terms: [...P("ALLOCATES_TO", "PRICED_BY"), ...C("ALLOCATES_TO", "PRICED_BY"), ...K("Vault", "Reserve", "Oracle")],
    yes: {
      status: "covered",
      steps: [{ template: "dependencies", params: { subject: VAULT, relations: ["ALLOCATES_TO", "PRICED_BY"], scope: scope(K2, K2_AS_OF, 2) } }],
      expect: [{
        rows: [
          fact(k2(F.allocatesTo1)), fact(k2(F.allocatesTo2)), fact(k2(F.allocatesTo3)), fact(k2(F.allocatesTo4)), fact(k2(F.allocatesTo5)), fact(k2(F.allocatesTo6)), fact(k2(F.allocatesTo7)),
          path(k2(F.allocatesTo1), k2(F.pricedBy1)), path(k2(F.allocatesTo2), k2(F.pricedBy2)), path(k2(F.allocatesTo3), k2(F.pricedBy3)), path(k2(F.allocatesTo4), k2(F.pricedBy4)),
          path(k2(F.allocatesTo5), k2(F.pricedBy5)), path(k2(F.allocatesTo6), k2(F.pricedBy6)), path(k2(F.allocatesTo7), k2(F.pricedBy7)),
        ],
        noReasons: ["no-facts"],
      }],
    },
    no: {
      status: "covered",
      // A reserve allocates to nothing.
      steps: [{ template: "dependencies", params: { subject: RESERVE_1, relations: ["ALLOCATES_TO"], scope: scope(K2, K2_AS_OF, 2) } }],
      expect: [{ rows: KAMINO_COVERAGE, onlyCoverageRows: true, reasons: [`no-facts:${RESERVE_1}`] }],
    },
  },
  {
    id: "CQ5", question: "Which entities of one protocol share a controller?", useCase: "Find concentration of control: one account standing behind several entities.",
    terms: [...P("VAULT_ADMIN", "ALLOCATION_ADMIN", "MARKET_OWNER", "UPGRADE_AUTHORITY"), ...C("ADMIN", "UPGRADE_AUTHORITY"), ...K("Vault", "Market", "Program")],
    yes: {
      status: "covered",
      steps: [{ template: "shared-controllers", params: { protocolId: "protocol:kamino", snapshotIds: [K2], minSubjects: 2 } }],
      expect: [{
        rows: [
          unorderedPath(k2(F.marketOwnerGroup1), k2(F.marketOwnerGroup2), k2(F.marketOwnerGroup3), k2(F.marketOwnerGroup4), k2(F.marketOwnerGroup5)),
          unorderedPath(k2(F.adminGroup1), k2(F.adminGroup2), k2(F.adminGroup3), k2(F.adminGroup4)),
          unorderedPath(k2(F.upgradeGroup1), k2(F.upgradeGroup2)),
        ],
      }],
    },
    no: {
      status: "covered",
      // The protocol's captures hold no shared-controller data: the answer is its coverage, not an empty list.
      steps: [{ template: "shared-controllers", params: { protocolId: "protocol:mpc", snapshotIds: [N], minSubjects: 2 } }],
      expect: [{ rows: MPC_COVERAGE, onlyCoverageRows: true }],
    },
  },
  {
    id: "CQ6", question: "Which entities depend on a given price source?", useCase: "Find everything that would be affected if a price source failed.",
    terms: [...P("PRICED_BY", "ALLOCATES_TO"), ...C("PRICED_BY", "ALLOCATES_TO"), ...K("Oracle", "Reserve", "Vault")],
    yes: {
      status: "covered",
      // Seven reserves at one hop; the vault at two hops, reached through the first reserve the engine meets.
      steps: [{ template: "exposure", params: { subject: ORACLE, maxHops: 3, snapshotIds: [K2] } }],
      expect: [{
        rows: [
          path(k2(F.pricedBy1)), path(k2(F.pricedBy2)), path(k2(F.pricedBy3)), path(k2(F.pricedBy4)), path(k2(F.pricedBy5)), path(k2(F.pricedBy6)), path(k2(F.pricedBy7)),
          path(k2(F.allocatesTo4), k2(F.pricedBy4)),
        ],
      }],
    },
    no: {
      status: "covered",
      // Nothing depends on the vault.
      steps: [{ template: "exposure", params: { subject: VAULT, maxHops: 3, snapshotIds: [K2] } }],
      expect: [{ rows: KAMINO_COVERAGE, onlyCoverageRows: true }],
    },
  },
  {
    id: "CQ7", question: "What changed for a subject between two captures?", useCase: "Report a change only where both captures cover the subject; a subject missing from one is missing coverage, not removed.",
    terms: [...P("IDLE_RAW"), ...K("Vault")],
    yes: {
      status: "covered",
      steps: [{ template: "changes", params: { subject: VAULT, beforeSnapshotId: K1, afterSnapshotId: K2, maxResults: 100 } }],
      expect: [{ changes: [{ kind: "changed", before: k1(F.vaultIdleBefore), after: k2(F.vaultIdleAfter) }] }],
    },
    no: {
      status: "covered",
      // The subject is covered in the earlier capture and not in the later, constructed one.
      steps: [{ template: "changes", params: { subject: NEAR_ORACLE, beforeSnapshotId: N, afterSnapshotId: NC, maxResults: 100 } }],
      expect: [{ onlyCoverageRows: true, reasons: [`missing-coverage:${NEAR_ORACLE}`], changes: [] }],
    },
  },
  {
    id: "CQ8", question: "Which accounts hold a given role on a NEAR contract?", useCase: "List the holders of a named permission, including a role nobody holds.",
    terms: [...P("holds-role"), ...C("HAS_MEMBER", "HAS_ROLE"), ...K("Role")],
    yes: {
      status: "covered",
      steps: [{ template: "control", params: { subject: "near:mainnet:burrow.sputnik-dao.near#role:council", scope: scope(N, N_AS_OF, 1) } }],
      expect: [{
        rows: [fact(n(F.councilMember_brhost_near)), fact(n(F.councilMember_brrrb_near)), fact(n(F.councilMember_farbread8025_near)), fact(n(F.councilMember_nicktrust_near)), fact(n(F.councilMember_wannamakeit_near))],
      }],
    },
    no: {
      status: "covered",
      // A role with no holder is a fact, none.
      steps: [{ template: "control", params: { subject: "near:mainnet:intents.near#role:GarbageCollector", scope: scope(N, N_AS_OF, 1) } }],
      expect: [{ rows: [unknownRow(n(F.garbageCollectorNone), "none")] }],
    },
  },
  {
    id: "CQ9", question: "What does a given NEAR contract depend on, by owner, price source, route and deployer?", useCase: "Map a contract's dependencies and show which are known and which are unknown.",
    terms: [...P("owned-by", "priced-by", "legacy-oracle", "routes-through", "deployed-by"), ...C("OWNED_BY", "PRICED_BY", "ROUTES_THROUGH", "DEPLOYED_BY")],
    yes: {
      status: "covered",
      // Hop 1 holds the owner, the price sources and the routes; hop 2 reaches the deployer through the owner.
      steps: [{ template: "dependencies", params: { subject: BURROW, relations: RELATIONS_NEAR, scope: scope(N, N_AS_OF, 2) } }],
      expect: [{
        rows: [
          fact(n(F.burrowLegacyOracle)), fact(n(F.burrowOwnedBy)), fact(n(F.burrowPricedBy)), fact(n(F.burrowRoutesDcl)), fact(n(F.burrowRoutesRef)),
          path(n(F.burrowOwnedBy), n(F.sputnikDeployedBy)), path(n(F.burrowRoutesRef), n(F.refOwnedBy)),
          unknownRow(n(F.aggregateOracleOwnerUnknown), "unknown"), unknownRow(n(F.dclOwnerUnknown), "unknown"), unknownRow(n(F.priceOracleOwnerUnknown), "unknown"),
        ],
        reasons: [`truncated:${BURROW}`, "unknown-controller:near:mainnet:aggregate-oracle.near", "unknown-controller:near:mainnet:dclv2.ref-labs.near", "unknown-controller:near:mainnet:priceoracle.near"],
      }],
    },
    no: {
      status: "covered",
      steps: [{ template: "dependencies", params: { subject: NEAR_ORACLE, relations: RELATIONS_NEAR, scope: scope(N, N_AS_OF, 1) } }],
      expect: [{ rows: [unknownRow(n(F.aggregateOracleOwnerUnknown), "unknown")], reasons: [`unknown-controller:${NEAR_ORACLE}`] }],
    },
  },
  {
    id: "CQ10", question: "Which facts about a subject rest only on current-state evidence and so cannot support a claim about the past?", useCase: "Separate facts that were read now from facts pinned to a past block.",
    terms: [...P("IDLE_RAW", "has-code-hash"), ...K("Vault")],
    yes: {
      status: "covered",
      steps: [{ template: "evidence", params: { evidenceIds: [IDLE_RECEIPT_K2], maxResults: 50 } }],
      expect: [{ rows: [{ rowKind: "receipt", snapshotId: K2, receiptId: IDLE_RECEIPT_K2, historicalState: "current-only" }] }],
    },
    no: {
      status: "covered",
      // The receipt of a constructed capture is not current-only evidence.
      steps: [{ template: "evidence", params: { evidenceIds: [HASH_RECEIPT_NC], maxResults: 50 } }],
      expect: [{ rows: [{ rowKind: "receipt", snapshotId: NC, receiptId: HASH_RECEIPT_NC, historicalState: "constructed" }] }],
    },
  },
  {
    id: "CQ11", question: "Which mechanics of a protocol are not covered by any capture?", useCase: "Read coverage as data, so that a gap is stated and not mistaken for a clean result.",
    terms: [],
    yes: {
      status: "covered",
      steps: [{ template: "coverage", params: { protocolId: "protocol:kamino", series: "kamino.sentora-pyusd" } }],
      expect: [{ rows: KAMINO_COVERAGE }],
    },
    no: {
      status: "covered",
      // An unknown protocol is one explicit not-mapped row, not an empty list.
      steps: [{ template: "coverage", params: { protocolId: "protocol:loopscale" } }],
      expect: [{ rows: [{ rowKind: "coverage", mechanic: "coverage", status: "not-mapped" }] }],
    },
  },
  {
    id: "CQ12", question: "Does a given token have a mint authority?", useCase: "Tell a token whose mint authority is revoked (none) from one whose mint authority is unknown.",
    terms: [...P("MINT_AUTHORITY"), ...C("MINT_AUTHORITY"), ...K("Token")],
    yes: { status: "uncovered", missing: "No committed public snapshot holds a MINT_AUTHORITY fact for any token, so a recorded mint read is needed.", steps: [], expect: [] },
    no: { status: "uncovered", missing: "No committed public snapshot holds a token whose MINT_AUTHORITY is none, so a recorded mint with a revoked authority is needed.", steps: [], expect: [] },
  },
];

// ---- Runtime: the local twin of the evidence templates over a set of snapshots ----

export interface RuntimeSnapshot { id: string; constructed: boolean; facts: number }
export interface RuntimeAnswer {
  rows: Record<string, unknown>[];
  reasons: { code: string; subject: string | null }[];
  changes: { kind: string; before: { id: string } | null; after: { id: string } | null }[];
}
export interface QuestionRuntime {
  run(template: string, params: Record<string, unknown>): RuntimeAnswer;
  hasFact(snapshotId: string, factId: string): { object: string } | undefined;
  hasReceipt(snapshotId: string, receiptId: string): boolean;
  /** Sorted by id. */
  snapshots(): readonly RuntimeSnapshot[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createQuestionRuntime(inputs: readonly EvidenceInput[], opts: { protocols?: ProtocolEntry[] } = {}): QuestionRuntime {
  const records = buildEvidenceRecords([...inputs], opts.protocols ? { protocols: opts.protocols } : {});
  const facts = new Map<string, Map<string, { object: string }>>();
  const receipts = new Map<string, Set<string>>();
  const snapshots: RuntimeSnapshot[] = [];
  for (const { snapshot } of inputs) {
    facts.set(snapshot.id, new Map(snapshot.facts.map(f => [f.id, { object: f.object }])));
    receipts.set(snapshot.id, new Set(snapshot.receipts.map(r => r.id)));
    snapshots.push({ id: snapshot.id, constructed: snapshot.constructed, facts: snapshot.facts.length });
  }
  snapshots.sort((a, b) => compare(a.id, b.id));
  return {
    run(template, params) {
      const result = runEvidenceLocal(records, template, params) as unknown as {
        rows: Record<string, unknown>[];
        reasons: { code: string; subject: string | null }[];
        changes: { kind: string; before: { id: string } | null; after: { id: string } | null }[];
      };
      return { rows: result.rows, reasons: result.reasons.map(r => ({ code: r.code, subject: r.subject })), changes: result.changes };
    },
    hasFact: (snapshotId, factId) => facts.get(snapshotId)?.get(factId),
    hasReceipt: (snapshotId, receiptId) => receipts.get(snapshotId)?.has(receiptId) ?? false,
    snapshots: () => snapshots,
  };
}

/** The runtime over the seven committed snapshots of the first slice. */
export function loadQuestionRuntime(root: string = join(import.meta.dir, "..", "..", "..")): QuestionRuntime {
  return createQuestionRuntime(collectSlice1Inputs(root));
}

// ---- Evaluation ----

export type CaseStatus = "pass" | "fail" | "uncovered";
export interface CaseResult { status: CaseStatus; detail: string }
export interface QuestionResult { id: string; yes: CaseResult; no: CaseResult }

interface ActualRow { kind: string; key: string; sortedKey: string; snapshotIds: string[]; problem?: string }
const factKey = (ref: FactRef): string => `${ref.snapshotId}|${ref.factId}`;

function project(row: Record<string, unknown>): ActualRow {
  const kind = String(row.rowKind);
  const snapshotIds = Array.isArray(row.snapshotIds) ? (row.snapshotIds as unknown[]).map(String) : typeof row.snapshotId === "string" ? [row.snapshotId] : [];
  if (kind === "fact" || kind === "unknown") {
    const key = `${kind}|${String(row.snapshotId)}|${String(row.factId)}`;
    return { kind, key, sortedKey: key, snapshotIds };
  }
  if (kind === "path") {
    const ids = Array.isArray(row.factIds) ? (row.factIds as unknown[]).map(String) : [];
    if (snapshotIds.length !== 1) return { kind, key: "", sortedKey: "", snapshotIds, problem: `a path row spans ${snapshotIds.length} snapshots` };
    return { kind, key: `path|${snapshotIds[0]}|${ids.join(",")}`, sortedKey: `path|${snapshotIds[0]}|${[...ids].sort(compare).join(",")}`, snapshotIds };
  }
  if (kind === "coverage") {
    const key = `coverage|${String(row.mechanic)}|${String(row.status)}`;
    return { kind, key, sortedKey: key, snapshotIds };
  }
  if (kind === "receipt") {
    const key = `receipt|${String(row.receiptId)}|${String(row.historicalState)}`;
    return { kind, key, sortedKey: key, snapshotIds };
  }
  return { kind, key: `${kind}|?`, sortedKey: `${kind}|?`, snapshotIds };
}

function describe(row: ExpectedRow): string {
  switch (row.rowKind) {
    case "fact": return `fact ${row.fact.factId} in ${row.fact.snapshotId}`;
    case "unknown": return `${row.object} row for ${row.fact.factId} in ${row.fact.snapshotId}`;
    case "path": return `path ${row.facts.map(f => f.factId).join(" > ")}`;
    case "coverage": return `coverage ${row.mechanic} ${row.status}`;
    case "receipt": return `receipt ${row.receiptId} (${row.historicalState}) in ${row.snapshotId}`;
  }
}

function matches(expected: ExpectedRow, actual: ActualRow): boolean {
  if (expected.rowKind !== actual.kind) return false;
  switch (expected.rowKind) {
    case "fact": return actual.key === `fact|${expected.fact.snapshotId}|${expected.fact.factId}`;
    case "unknown": return actual.key === `unknown|${expected.fact.snapshotId}|${expected.fact.factId}`;
    case "path": {
      const snapshot = expected.facts[0]?.snapshotId ?? "";
      const ids = expected.facts.map(f => f.factId);
      return expected.unordered ? actual.sortedKey === `path|${snapshot}|${[...ids].sort(compare).join(",")}` : actual.key === `path|${snapshot}|${ids.join(",")}`;
    }
    case "coverage": return actual.key === `coverage|${expected.mechanic}|${expected.status}`;
    case "receipt": return actual.key === `receipt|${expected.receiptId}|${expected.historicalState}` && actual.snapshotIds.includes(expected.snapshotId);
  }
}

function describeActual(actual: ActualRow): string {
  return actual.problem ?? actual.key;
}

/** The first difference between a step's answer and its expectation, or null. */
function firstDifference(expect: Expectation, answer: RuntimeAnswer, runtime: QuestionRuntime): string | null {
  const actualRows = answer.rows.map(project);
  for (const row of actualRows) if (row.problem) return row.problem;
  if (expect.onlyCoverageRows && (actualRows.length === 0 || actualRows.some(r => r.kind !== "coverage"))) {
    return `expected only coverage rows, got ${actualRows.length === 0 ? "no rows" : actualRows.map(r => r.kind).join(", ")}`;
  }
  if (expect.rows) {
    for (const row of expect.rows) {
      const refs = row.rowKind === "fact" || row.rowKind === "unknown" ? [row.fact] : row.rowKind === "path" ? row.facts : [];
      for (const ref of refs) if (!runtime.hasFact(ref.snapshotId, ref.factId)) return `${describe(row)}: no such fact in the snapshot`;
      if (row.rowKind === "unknown" && runtime.hasFact(row.fact.snapshotId, row.fact.factId)?.object !== row.object) return `${describe(row)}: the fact's object is not ${row.object}`;
      if (row.rowKind === "receipt" && !runtime.hasReceipt(row.snapshotId, row.receiptId)) return `${describe(row)}: no such receipt in the snapshot`;
    }
    const remaining = [...actualRows];
    for (const row of expect.rows) {
      const index = remaining.findIndex(a => matches(row, a));
      if (index < 0) return `expected ${describe(row)}; the answer has ${actualRows.length === 0 ? "no rows" : `${actualRows.length} rows without it`}`;
      remaining.splice(index, 1);
    }
    if (remaining.length) return `unexpected row ${describeActual(remaining[0]!)}`;
  }
  const reasons = answer.reasons.map(r => `${r.code}:${r.subject ?? ""}`);
  // An empty list is an expectation too: no reason at all, so an answer that explains itself does not pass it.
  if (expect.reasons && expect.reasons.length === 0 && reasons.length > 0) return `expected no reasons; the answer has ${reasons.join(", ")}`;
  for (const wanted of expect.reasons ?? []) if (!reasons.includes(wanted)) return `expected reason ${wanted}; the answer has ${reasons.length ? reasons.join(", ") : "no reasons"}`;
  for (const code of expect.noReasons ?? []) if (answer.reasons.some(r => r.code === code)) return `unexpected reason ${code}`;
  if (expect.changes) {
    const keyOf = (kind: string, before: string | null, after: string | null) => `${kind}|${before ?? ""}|${after ?? ""}`;
    const wanted = expect.changes.map(c => keyOf(c.kind, c.before?.factId ?? null, c.after?.factId ?? null));
    const actual = answer.changes.map(c => keyOf(c.kind, c.before?.id ?? null, c.after?.id ?? null));
    for (const change of expect.changes) for (const ref of [change.before, change.after]) if (ref && !runtime.hasFact(ref.snapshotId, ref.factId)) return `change names a fact missing from ${ref.snapshotId}`;
    for (const key of wanted) if (!actual.includes(key)) return `expected change ${key}; the answer has ${actual.length ? actual.join(", ") : "no change"}`;
    for (const key of actual) if (!wanted.includes(key)) return `unexpected change ${key}`;
  }
  return null;
}

/**
 * What is wrong with the shape of a covered case, or null. A covered case has at least one step, exactly
 * one expectation per step, and every expectation asserts something: its rows, only-coverage flag, reasons
 * (an empty list means there must be none), a non-empty list of absent reason codes, or its changes (an
 * empty list means no change at all). An expectation that asserts nothing would pass any answer.
 */
function caseShapeProblem(c: QuestionCase): string | null {
  if (c.steps.length === 0) return "covered without a step";
  if (c.expect.length !== c.steps.length) return `${c.steps.length} steps but ${c.expect.length} expectations`;
  for (const [index, expectation] of c.expect.entries()) {
    if (!expectation) return `step ${index + 1} has no expectation`;
    const asserts =
      expectation.rows !== undefined ||
      expectation.onlyCoverageRows === true ||
      expectation.reasons !== undefined ||
      (expectation.noReasons?.length ?? 0) > 0 ||
      expectation.changes !== undefined;
    if (!asserts) return `step ${index + 1} has an expectation that asserts nothing`;
  }
  return null;
}

function evaluateCase(c: QuestionCase, runtime: QuestionRuntime): CaseResult {
  if (c.status === "uncovered") return { status: "uncovered", detail: c.missing ?? "" };
  const shape = caseShapeProblem(c);
  if (shape) return { status: "fail", detail: `malformed case: ${shape}` };
  for (const [index, step] of c.steps.entries()) {
    const label = `step ${index + 1} (${step.template})`;
    let answer: RuntimeAnswer;
    try { answer = runtime.run(step.template, step.params); } catch (error) {
      return { status: "fail", detail: `${label}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const difference = firstDifference(c.expect[index]!, answer, runtime);
    if (difference) return { status: "fail", detail: `${label}: ${difference}` };
  }
  return { status: "pass", detail: "" };
}

export function evaluateQuestion(q: Question, runtime: QuestionRuntime): QuestionResult {
  return { id: q.id, yes: evaluateCase(q.yes, runtime), no: evaluateCase(q.no, runtime) };
}
export function evaluateQuestions(questions: readonly Question[], runtime: QuestionRuntime): QuestionResult[] {
  return questions.map(q => evaluateQuestion(q, runtime));
}

/** Problems in the question set itself: an unresolved fact, receipt or term, or an uncovered case that does not say why. */
export function questionProblems(questions: readonly Question[], runtime: QuestionRuntime): string[] {
  const problems: string[] = [];
  const known = new Set(TERMS.map(t => `${t.type}\0${t.name}`));
  for (const q of questions) {
    for (const t of q.terms) if (!known.has(`${t.type}\0${t.name}`)) problems.push(`${q.id}: unknown term ${t.type}/${t.name}`);
    for (const [label, c] of [["yes", q.yes], ["no", q.no]] as const) {
      if (c.status === "uncovered") { if (!c.missing?.trim()) problems.push(`${q.id} ${label}: uncovered without a reason`); continue; }
      const shape = caseShapeProblem(c);
      if (shape) problems.push(`${q.id} ${label}: ${shape}`);
      for (const expectation of c.expect) {
        for (const row of expectation?.rows ?? []) {
          const refs = row.rowKind === "fact" || row.rowKind === "unknown" ? [row.fact] : row.rowKind === "path" ? row.facts : [];
          for (const ref of refs) if (!runtime.hasFact(ref.snapshotId, ref.factId)) problems.push(`${q.id} ${label}: fact ${factKey(ref)} not in the snapshot`);
          if (row.rowKind === "unknown" && runtime.hasFact(row.fact.snapshotId, row.fact.factId)?.object !== row.object) problems.push(`${q.id} ${label}: ${factKey(row.fact)} is not ${row.object}`);
          if (row.rowKind === "receipt" && !runtime.hasReceipt(row.snapshotId, row.receiptId)) problems.push(`${q.id} ${label}: receipt ${row.receiptId} not in ${row.snapshotId}`);
        }
        for (const change of expectation?.changes ?? []) for (const ref of [change.before, change.after]) {
          if (ref && !runtime.hasFact(ref.snapshotId, ref.factId)) problems.push(`${q.id} ${label}: fact ${factKey(ref)} not in the snapshot`);
        }
      }
    }
  }
  return problems;
}
