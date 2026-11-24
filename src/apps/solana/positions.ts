/**
 * Positions of one address: the replayed reads, and the sheet behind each position. A read comes from the
 * repository's position reader; this file turns its result into kit results and adds nothing to it. Bun only.
 */
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { KaminoReport } from "../../adapters/kamino/index";
import { parseTokenAccount } from "../../chain/token-layout";
import type { EvidenceReceipt, Fact } from "../../engine/contracts";
import { openStore } from "../../engine/queries/snapshot";
import type { ReadResult } from "../../positions/types";
import { engineAccess, queryChains } from "../../review/position/chain";
import { economicsFor, economicsQuantities, exitItemsFor } from "../../review/position/economics";
import { createSolanaRpcClient, type SolanaRpcClient } from "../../solana/positions/client";
import type { AnyResultV2, ReceiptRecord, ResultRow } from "../../ui/types";
import { joinOf, legOf, type JoinContext } from "./join";
import { PREFIX, type ReadData, type SheetData } from "./model";
import { CHAIN_COLUMNS, GAP_COLUMNS, cmp, controlRows, gapRow, observedOf, table, type ReceiptIndex } from "./rows";

const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const REPLAY = "fixtures/solana-app/replay";
const ECONOMICS = "src/review/position/economics.ts";
/** The replay client needs an endpoint to name. It is never contacted: every call is answered from a fixture body. */
const REPLAY_URL = "http://127.0.0.1:1/";

export interface PositionContext extends JoinContext { sentoraReport: KaminoReport }
export interface Replay { source: "recorded" | "constructed"; holder: string; client: SolanaRpcClient }

/** A reader client that answers from the committed bodies of one replayed read and never reaches a network. */
export function replayClient(root: string, source: "recorded" | "constructed"): Replay {
  const files = source === "recorded"
    ? { spl: `b64-tao-${SPL}.json`, token2022: "b64-tao-TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.json", obligations: "b64-gpa.json" }
    : { spl: "token-accounts-spl.json", token2022: "token-accounts-token2022.json", obligations: "klend-obligations.json" };
  const body = (name: string): { result: { value: { account: { data: [string, string] } }[] } } => {
    const parsed = JSON.parse(readFileSync(joinPath(root, REPLAY, source, name), "utf8"));
    return source === "constructed" ? parsed.body : parsed;
  };
  const spl = body(files.spl);
  const token2022 = body(files.token2022);
  const obligations = body(files.obligations);
  const holder = source === "constructed"
    ? String(JSON.parse(readFileSync(joinPath(root, REPLAY, source, files.spl), "utf8")).holder)
    : parseTokenAccount(Buffer.from(spl.result.value[0].account.data[0], "base64")).owner;
  const answer = (async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: [unknown, { programId?: string }] };
    const picked = request.method === "getProgramAccounts" ? obligations : request.params[1].programId === SPL ? spl : token2022;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: picked.result }), { status: 200 });
  }) as unknown as typeof fetch;
  // The bodies hold a slot and no retrieval time. The reader stamps the time it is given; it is dropped below.
  return { source, holder, client: createSolanaRpcClient({ url: REPLAY_URL, timeoutMs: 30000, programAccounts: true, fetch: answer, now: () => 0 }) };
}

const readReceipt = (receipt: EvidenceReceipt, replayed: boolean, constructed: boolean): ReceiptRecord => ({
  id: receipt.id, source: replayed ? receipt.source.replace(`@${new URL(REPLAY_URL).host}`, " (replayed fixture body)") : receipt.source, responseSha256: receipt.responseSha256,
  blockOrSlot: receipt.observation.blockOrSlot, observedAt: replayed ? null : receipt.observation.observedAt ?? null,
  historicalState: receipt.observation.historicalState, privacy: receipt.privacy, ...(constructed ? { constructed: true as const } : {}),
});

/** The sheet of one position: observations, the control chain of the joined account, and exit limits or the gap. */
async function sheetOf(ordinal: number, row: ResultRow, key: string, readId: string, constructed: boolean, context: PositionContext): Promise<SheetData> {
  const mark = constructed ? { constructed: true as const } : {};
  const { join, source } = joinOf(key, context);
  const results: Record<string, AnyResultV2> = {};
  const observations: ResultRow[] = [{
    ...row, key: `${row.key}-read`, values: { observation: "position read", id: readId, "block or slot": row.blockOrSlot, time: row.asOf },
  }];
  if (!join) {
    results.observations = table("observations", "table", [["observation", "label"], ["id", "value"], ["block or slot", "value"], ["time", "time"]], observations);
    results.gaps = table("gaps", "unknowns", GAP_COLUMNS, [gapRow("not-joined", "not-mapped", source, { item: "chain behind this position", account: `${PREFIX}${key}`, detail: "No recorded subject is joined to this account." }, constructed)], { total: 1, ...mark });
    return { ordinal, join: null, constructed, snapshotIds: [], results };
  }
  const snapshot = join.snapshot;
  observations.push({
    rowKind: "scope", key: `${row.key}-snapshot`, factIds: [], bases: [], evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [snapshot.id], scopeSource: source, ...mark,
    values: { observation: "protocol snapshot", id: snapshot.id, "block or slot": `${snapshot.fromBlockOrSlot ?? "not recorded"} to ${snapshot.toBlockOrSlot ?? "not recorded"}`, time: snapshot.observedTo },
  });
  results.observations = table("observations", "table", [["observation", "label"], ["id", "value"], ["block or slot", "value"], ["time", "time"]], observations);

  const receipts: ReceiptIndex = new Map(snapshot.receipts.map((receipt) => [receipt.id, receipt]));
  const { chains } = await queryChains(engineAccess(openStore([snapshot])), [join.account], snapshot.id, snapshot.observedTo);
  const chain = chains.get(join.account);
  const controlFacts: Fact[] = chain ? chain.controlFacts : [];
  const rows = controlRows(controlFacts, receipts, snapshot.id).chain;
  const own = (candidate: ResultRow): number => (candidate.values.target === join.account ? 0 : 1);
  rows.sort((a, b) => own(a) - own(b));
  results.control = table("control", "chain", CHAIN_COLUMNS, rows, { total: rows.length });

  const economics = join.series === "sentora-pyusd" ? economicsFor(context.sentoraReport, join.account) : null;
  if (economics) {
    const quantities = new Map(economicsQuantities(economics).map((quantity) => [quantity.name, quantity]));
    const items = exitItemsFor(economics, chain ? chain.stateFacts : []);
    results.exit = table("exit", "table", [["role", "role"], ["account", "address"], ["name", "label"], ["value", "amount"], ["unit", "unit"]], items.map((item, at): ResultRow => {
      const quantity = quantities.get(item.name);
      return {
        rowKind: "fact", key: `exit-${at}`, values: { role: item.role, account: item.subject, name: item.name, value: quantity?.value ?? null, unit: quantity?.unit ?? null },
        factIds: [...item.factIds], bases: quantity ? [quantity.basis] : [], evidenceIds: [...item.receiptIds], ...observedOf(item.receiptIds, receipts),
        snapshotIds: [snapshot.id],
      };
    }), { total: items.length });
    const exitSource = `${ECONOMICS} over the adapter report of ${snapshot.id}`;
    const gaps = [
      ...economics.missing.map((name, at) => gapRow(`missing-${at}`, "not-captured", exitSource, { item: name, account: null, detail: null }, constructed)),
      ...economics.notComputed.map((name, at) => gapRow(`not-computed-${at}`, "not-computed", exitSource, { item: name, account: null, detail: null }, constructed)),
    ];
    if (gaps.length > 0) results.gaps = table("gaps", "unknowns", GAP_COLUMNS, gaps, { total: gaps.length, ...mark });
  } else {
    results.gaps = table("gaps", "unknowns", GAP_COLUMNS, [gapRow("exit-not-mapped", "not-mapped", ECONOMICS, { item: "exit limits", account: join.account, detail: "Exit limits are mapped for the Sentora PYUSD vault only." }, constructed)], { total: 1, ...mark });
  }
  return { ordinal, join: { pack: join.pack, series: join.series, account: join.account }, constructed, snapshotIds: [snapshot.id], results };
}

/** A reader's result as the page draws it. Every position is a reader row: receipts and a source, no basis word. */
export async function toReadData(source: ReadData["source"], address: string, readId: string, result: ReadResult, context: PositionContext): Promise<ReadData> {
  const constructed = source === "constructed";
  const replayed = source !== "live";
  const mark = constructed ? { constructed: true as const } : {};
  const receipts: ReceiptIndex = new Map(result.receipts.map((receipt) => [receipt.id, receipt]));
  const readTime = (ids: string[]): string | null => {
    if (replayed) return null;
    const times = ids.map((id) => receipts.get(id)?.observation)
      .map((observation) => observation?.observedAt ?? observation?.retrievedAt)
      .filter((time): time is string => typeof time === "string" && time !== "").sort(cmp);
    return times.at(-1) ?? null;
  };
  const keyOf = (subject: string): string => subject.slice(PREFIX.length).split("#")[0];
  const rows: ResultRow[] = [];
  const sheets: SheetData[] = [];
  for (const [at, position] of result.positions.entries()) {
    const key = keyOf(position.subject);
    const unit = position.unit.startsWith(PREFIX) ? position.unit.slice(PREFIX.length) : position.unit;
    const joined = joinOf(key, context);
    const row: ResultRow = {
      rowKind: "reader", key: position.id, source: "reader", scopeSource: joined.source, ...mark,
      values: { account: `${PREFIX}${key}`, quantity: position.quantity, unit: position.unit, leg: legOf(key, unit), "joined to": joined.join ? joined.join.account : null },
      factIds: [], bases: [], evidenceIds: [...position.receiptIds], blockOrSlot: observedOf(position.receiptIds, receipts).blockOrSlot, asOf: readTime(position.receiptIds), snapshotIds: [readId],
    };
    rows.push(row);
    sheets.push(await sheetOf(at + 1, row, key, readId, constructed, context));
  }
  const slots = result.receipts.map((receipt) => receipt.observation.blockOrSlot).filter((slot): slot is string => slot !== null).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const readerSource = `position reader, read ${readId}`;
  return {
    source, constructed, address,
    meta: { title: "Positions of one address", subjectId: `${PREFIX}${address}`, kind: `read ${readId}`, snapshotIds: [readId], fromBlockOrSlot: slots[0] ?? null, toBlockOrSlot: slots.at(-1) ?? null, capturedAt: readTime(result.receipts.map((receipt) => receipt.id)), constructed },
    list: table("positions", "table", [["account", "address"], ["quantity", "amount"], ["unit", "address"], ["leg", "label"], ["joined to", "address"]], rows, { total: rows.length, ...mark }),
    notRead: table("not-read", "unknowns", [["account", "address"], ["reader reason", "label"]],
      result.notRead.map((entry, at) => gapRow(`not-read-${at}`, "not-read", readerSource, { account: `${PREFIX}${keyOf(entry.subject)}`, "reader reason": entry.reason }, constructed)), { total: result.notRead.length, ...mark }),
    receipts: Object.fromEntries([...result.receipts].sort((a, b) => cmp(a.id, b.id)).map((receipt) => [receipt.id, readReceipt(receipt, replayed, constructed)])),
    sheets,
  };
}
