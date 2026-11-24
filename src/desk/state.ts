/**
 * What the desk holds while it runs: the policy, the loaded snapshots, the review the engine computed, the watch
 * events when an earlier snapshot was given, and the positions with where each came from. The desk computes no
 * verdict, chain or change of its own: every one of them is the answer of the function the command line uses.
 * Addresses and reader positions live in memory only; the desk writes no file.
 */
import { canonical } from "../chain/evidence";
import { DEFAULT_RPC_URL } from "../config";
import type { EvidenceReceipt, Fact, PrivatePosition, QueryReason } from "../engine/contracts";
import type { EvidenceStore } from "../engine/queries/snapshot";
import { loadNearLibraries, loadNearPolicy, referencedSnapshots, type NearLibraries } from "../near/policy/index";
import { parseNearBook, positionRoot } from "../near/private/book";
import { joinPositions, type JoinedNearPosition } from "../near/private/join";
import { buildNearReview, type NearReview } from "../near/private/review";
import { watchPolicy, type WatchEvent } from "../near/private/watch";
import { loadNearSnapshots, readNearManifest } from "../near/reader/load";
import { CURRENT_NEAR_SNAPSHOT } from "../near/subjects/registry";
import type { Policy } from "../policy/types";
import { parseAddressArg } from "../positions/addresses";
import { PositionsRejected, type ReadInput, type ReadResult } from "../positions/types";
import { createSolanaRpcClient } from "../solana/positions/client";
import { DESK_STRINGS, DESK_TEXT } from "./strings";

/** A launch or a request the desk refuses. `code` names the cause in a few fixed words and never holds a private value. */
export class DeskRejected extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeskRejected";
  }
}

export interface DeskOptions {
  policy: string;
  snapshot?: string;
  before?: string;
  /** Each as given: `<chain>:<account>`. */
  addresses: string[];
  positionsFile?: string;
}

export interface DeskDeps {
  readPositions: (input: ReadInput) => Promise<ReadResult>;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now: () => number;
}

export type PositionSource = { kind: "manual" } | { kind: "reader"; chain: string; block: string | null; host: string };

export interface DeskPosition {
  position: PrivatePosition;
  /** The chain word of the subject, or of the address the reader was given. */
  chain: string;
  /** The public NEAR root of the position, or `null` when the position is not on NEAR. */
  root: string | null;
  source: PositionSource;
  /** Private receipts of a reader position. They are served by the positions route only. */
  receiptIds: string[];
}

export interface DeskAddress {
  ordinal: number;
  chain: string;
  address: string;
  origin: "flag" | "typed";
  status: "read" | "not-read" | "error";
  /** The fixed words for why nothing, or not everything, was read; `null` when the read was complete. */
  reason: string | null;
  /** Reasons the reader gave for parts it did not read. Reason codes only, never a subject. */
  notRead: string[];
}

export interface DeskState {
  policy: Policy;
  libs: NearLibraries;
  store: EvidenceStore;
  snapshotId: string;
  before: string | null;
  /** Ids of every snapshot in the store. */
  snapshotIds: string[];
  review: NearReview;
  watch: { events: WatchEvent[]; unknowns: QueryReason[] } | null;
  book: "synthetic" | "file" | "none";
  readerHost: string;
  readerClient: unknown;
  addresses: DeskAddress[];
  positions: DeskPosition[];
  privateReceipts: EvidenceReceipt[];
}

const COMPUTED = new Map<string, { store: EvidenceStore; review: NearReview; watch: DeskState["watch"] }>();

export const SYNTHETIC_BOOK = new URL("../../fixtures/desk/book-synthetic.json", import.meta.url);
export const MAX_TYPED_ADDRESSES = 16;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;

function nearRoot(position: PrivatePosition): string | null {
  try {
    return positionRoot(position);
  } catch {
    return null;
  }
}

function manualPositions(positions: PrivatePosition[]): DeskPosition[] {
  return positions.map((position) => ({ position, chain: position.subject.split(":")[0] ?? "", root: nearRoot(position), source: { kind: "manual" }, receiptIds: [] }));
}

async function readBook(path: string | URL): Promise<PrivatePosition[]> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new DeskRejected("positions-file-not-found");
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new DeskRejected("positions-file-rejected (malformed-json)");
  }
  try {
    return parseNearBook(input);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new DeskRejected(`positions-file-rejected (${typeof code === "string" && CODE.test(code) ? code : "schema"})`);
  }
}

function checkSnapshot(id: string, flag: string): void {
  try {
    readNearManifest(id);
  } catch {
    throw new DeskRejected(`unknown-snapshot (${flag})`);
  }
}

/** `<chain>:<account>` as the reader's own parser reads it. Throws `DeskRejected("malformed-address")`. */
export function parseDeskAddress(value: unknown): { chain: string; address: string } {
  try {
    if (typeof value !== "string" || value.length > 256) throw new Error();
    return parseAddressArg(value);
  } catch {
    throw new DeskRejected("malformed-address");
  }
}

/**
 * Loads everything the desk shows. Every refusal happens here, before a port is bound, in this order: the policy,
 * the snapshots, the book file, the reader configuration. Addresses given by flag are read last.
 */
export async function loadDeskState(options: DeskOptions, deps: DeskDeps): Promise<DeskState> {
  const flagAddresses = options.addresses.map(parseDeskAddress);

  const libs = await loadNearLibraries();
  let policy: Policy;
  try {
    policy = await loadNearPolicy(options.policy, libs);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new DeskRejected(code === "policy-not-found" || typeof code !== "string" || !CODE.test(code) ? "policy-not-found" : `policy-rejected (${code})`);
  }

  const snapshotId = options.snapshot ?? CURRENT_NEAR_SNAPSHOT;
  const before = options.before ?? null;
  checkSnapshot(snapshotId, "--snapshot");
  if (before !== null) checkSnapshot(before, "--before");
  const snapshotIds = [...new Set([snapshotId, ...referencedSnapshots(policy), ...(before === null ? [] : [before])])];
  let store: EvidenceStore;
  try {
    store = loadNearSnapshots(snapshotIds);
  } catch {
    throw new DeskRejected("unknown-snapshot (policy reference)");
  }

  let book: DeskState["book"] = "none";
  let positions: DeskPosition[] = [];
  if (options.positionsFile !== undefined) {
    positions = manualPositions(await readBook(options.positionsFile));
    book = "file";
  } else if (flagAddresses.length === 0) {
    positions = manualPositions(await readBook(SYNTHETIC_BOOK));
    book = "synthetic";
  }

  let client: { host: string };
  try {
    const timeout = deps.env.LINCHPIN_RPC_TIMEOUT_MS;
    client = createSolanaRpcClient({
      url: deps.env.LINCHPIN_RPC_URL || DEFAULT_RPC_URL,
      timeoutMs: timeout === undefined ? 30000 : Number(timeout),
      programAccounts: Boolean(deps.env.LINCHPIN_RPC_URL),
      fetch: deps.fetch,
      now: deps.now,
    });
  } catch {
    throw new DeskRejected("reader-configuration-rejected");
  }

  // The review and the comparison are the engine's answers for a policy and its snapshots. They do not depend on
  // the book (the comparison is given the same book on both sides), so one process computes each of them once.
  const key = canonical([policy, snapshotId, before, libs.status]);
  let computed = COMPUTED.get(key);
  if (computed === undefined) {
    try {
      const review = buildNearReview(policy, store, snapshotId, libs, before === null ? {} : { before });
      const nearBook = positions.filter((entry) => entry.root !== null).map((entry) => entry.position);
      const watch = before === null ? null : watchPolicy({ policy, store, before, after: snapshotId, libs, positions: nearBook, positionsBefore: nearBook });
      computed = { store, review, watch };
    } catch {
      throw new DeskRejected("review-failed");
    }
    COMPUTED.set(key, computed);
  }
  store = computed.store;
  const { review, watch } = computed;

  const state: DeskState = {
    policy, libs, store, snapshotId, before, snapshotIds, review, watch, book,
    readerHost: client.host, readerClient: client, addresses: [], positions, privateReceipts: [],
  };
  for (const address of flagAddresses) await readAddress(state, deps, address, "flag");
  return state;
}

function compactTime(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function greatestBlock(receipts: EvidenceReceipt[]): string | null {
  const blocks = receipts.map((receipt) => receipt.observation.blockOrSlot).filter((block): block is string => typeof block === "string");
  if (blocks.length === 0) return null;
  if (!blocks.every((block) => /^[0-9]+$/.test(block))) return blocks[0];
  return blocks.reduce((greatest, block) => (BigInt(block) > BigInt(greatest) ? block : greatest));
}

const isText = (value: unknown): value is string => typeof value === "string";

/**
 * Reads one address through the injected reader and adds what it returned to the state. It never throws: a reader
 * that fails leaves an address entry with status `error` and the reader's code. The address itself goes into no
 * reason, row or log line.
 */
export async function readAddress(state: DeskState, deps: DeskDeps, address: { chain: string; address: string }, origin: "flag" | "typed"): Promise<DeskAddress> {
  const entry: DeskAddress = { ordinal: state.addresses.length + 1, chain: address.chain, address: address.address, origin, status: "read", reason: null, notRead: [] };
  state.addresses.push(entry);
  let result: ReadResult;
  try {
    result = await deps.readPositions({ chain: address.chain, address: address.address, snapshotId: `desk-reader.${compactTime(deps.now())}`, client: state.readerClient });
  } catch (error) {
    const code = error instanceof PositionsRejected ? error.code : (error as { reason?: unknown } | null)?.reason;
    entry.status = "error";
    entry.reason = DESK_TEXT.readerError(typeof code === "string" && CODE.test(code) ? code : "failed");
    return entry;
  }
  const receipts = Array.isArray(result?.receipts) ? result.receipts.filter((receipt) => receipt !== null && typeof receipt === "object" && isText(receipt.id)) : [];
  const known = new Set(state.privateReceipts.map((receipt) => receipt.id));
  for (const receipt of receipts) if (!known.has(receipt.id)) state.privateReceipts.push(receipt);
  for (const read of Array.isArray(result?.positions) ? result.positions : []) {
    if (read === null || typeof read !== "object" || !isText(read.id) || !isText(read.subject) || !isText(read.quantity) || !isText(read.unit)) continue;
    const receiptIds = Array.isArray(read.receiptIds) ? read.receiptIds.filter(isText) : [];
    const position: PrivatePosition = {
      id: read.id, subject: read.subject, quantity: read.quantity, unit: read.unit,
      snapshotId: isText(read.snapshotId) ? read.snapshotId : "", source: "reader", fixtureKind: read.fixtureKind === "synthetic" ? "synthetic" : "real-private",
    };
    state.positions.push({
      position, chain: address.chain, root: nearRoot(position), receiptIds,
      source: { kind: "reader", chain: address.chain, block: greatestBlock(receipts.filter((receipt) => receiptIds.includes(receipt.id))), host: state.readerHost },
    });
  }
  const reasons = [...new Set((Array.isArray(result?.notRead) ? result.notRead : []).map((item) => (item !== null && typeof item === "object" && isText(item.reason) && CODE.test(item.reason) ? item.reason : "not-covered")))].sort();
  entry.notRead = reasons;
  if (reasons.includes("chain-not-supported")) {
    entry.status = "not-read";
    entry.reason = DESK_STRINGS.notReadNoReader;
  } else if (reasons.length > 0) {
    entry.reason = DESK_TEXT.notRead(reasons.join(", "));
  }
  return entry;
}

/** The NEAR positions of the book in book order, each joined to its chain by the engine's own join. */
export function nearPositions(state: DeskState): { entry: DeskPosition; joined: JoinedNearPosition }[] {
  const entries = state.positions.filter((entry) => entry.root !== null);
  const joined = joinPositions(state.review, entries.map((entry) => entry.position));
  return entries.map((entry, at) => ({ entry, joined: joined[at] }));
}

/** Every fact of every loaded snapshot, by id. */
export function factIndex(state: DeskState): Map<string, Fact> {
  const index = new Map<string, Fact>();
  for (const id of state.snapshotIds) for (const fact of state.store.snapshot(id)?.facts ?? []) if (!index.has(fact.id)) index.set(fact.id, fact);
  return index;
}

/** The receipt ids of every loaded snapshot: what a public surface may cite. */
export function publicReceiptIds(state: DeskState): string[] {
  const ids = new Set<string>();
  for (const id of state.snapshotIds) for (const receipt of state.store.snapshot(id)?.receipts ?? []) ids.add(receipt.id);
  return [...ids];
}
