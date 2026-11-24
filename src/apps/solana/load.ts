/**
 * Loads the app's data from committed captures: the three public protocols and the two replayed position reads.
 * It takes about a minute, because the Marinade sections replay several thousand recorded reads. It writes nothing
 * and makes no network request. Bun only.
 */
import { resolve } from "node:path";
import { readPositions } from "../../positions/read";
import type { ReceiptRecord } from "../../ui/types";
import type { AppData, PackData, ReadData } from "./model";
import { replayClient, toReadData, type PositionContext } from "./positions";
import { kaminoLendPack, kaminoVaultsPack, loadKaminoFamily, marinadePack } from "./providers";
import { cmp } from "./rows";
import { APP_STRINGS } from "./strings";

/** The repository root, from this file's place in it. No absolute path enters the data. */
export const APP_ROOT = resolve(import.meta.dir, "../../..");

export interface LoadOptions {
  /** Further packs, with the receipts their rows cite. The private launcher adds one. */
  extraPacks?: { pack: PackData; receipts: ReceiptRecord[] }[];
  /** Whether the two replayed reads are computed. Default true. */
  positions?: boolean;
}

export interface Loaded { data: AppData; context: PositionContext }

export function readId(source: ReadData["source"]): string {
  return `solana-reader.${source}`;
}

/** The two replayed reads, through the position reader over committed bodies. */
export async function replayedReads(root: string, context: PositionContext): Promise<{ reads: ReadData[]; address: string }> {
  const reads: ReadData[] = [];
  let address = "";
  for (const source of ["recorded", "constructed"] as const) {
    const replay = replayClient(root, source);
    address = replay.holder;
    const result = await readPositions({ chain: "solana", address: replay.holder, snapshotId: readId(source), client: replay.client });
    reads.push(await toReadData(source, replay.holder, readId(source), result, context));
  }
  return { reads, address };
}

export async function loadApp(root: string = APP_ROOT, options: LoadOptions = {}): Promise<Loaded> {
  const family = loadKaminoFamily(root);
  const marinade = await marinadePack(root);
  const lend = kaminoLendPack(root, family);
  const vaults = kaminoVaultsPack(root, family);
  const extra = options.extraPacks ?? [];
  const receipts = new Map<string, ReceiptRecord>();
  for (const receipt of [...marinade.receipts, ...lend.receipts, ...vaults.receipts, ...extra.flatMap((entry) => entry.receipts)]) {
    if (!receipts.has(receipt.id)) receipts.set(receipt.id, receipt);
  }
  const context: PositionContext = { marinade: marinade.latest, lend: lend.latest, sentora: vaults.sentora.snapshot, sentoraReport: vaults.sentora.report };
  const replayed = options.positions === false ? null : await replayedReads(root, context);
  const data: AppData = {
    version: 1,
    build: extra.length > 0 ? "private" : "public",
    mode: "static",
    packs: [marinade.pack, lend.pack, vaults.pack, ...extra.map((entry) => entry.pack)],
    absent: extra.some((entry) => entry.pack.id === "loopscale") ? [] : [{ id: "loopscale", line: APP_STRINGS.loopscaleAbsent }],
    receipts: Object.fromEntries([...receipts.keys()].sort(cmp).map((id) => [id, receipts.get(id)!])),
    positions: replayed ? { reads: replayed.reads } : null,
    replayAddress: replayed ? replayed.address : null,
    live: false,
    ask: { enabled: false },
  };
  return { data, context };
}
