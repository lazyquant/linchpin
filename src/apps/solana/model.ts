/**
 * The data block of the app: what the loader hands to the page. Every evidence value in it sits in a kit result
 * with its bases, its block or slot and its evidence ids; the page turns results into validated surfaces.
 */
import type { AnyResultV2, CoverageInput, ReceiptRecord, ResultSet, SurfaceMeta } from "../../ui/types";

export const PREFIX = "solana:mainnet-beta:";
export const TABS = ["overview", "control", "dependencies", "value-path", "unknowns", "changes"] as const;
export type TabId = (typeof TABS)[number];

/** The ids under which a series keeps its results. A result that does not apply to a series is left out. */
export const RESULT = Object.freeze({
  members: "members", thresholds: "thresholds", graph: "graph", edges: "edges", state: "state",
  findings: "findings", path: "path", pathUnknowns: "path-unknowns", claims: "claims", value: "value",
  unknowns: "unknowns", gaps: "gaps", changes: "changes", changesGap: "changes-gap", changeNotes: "change-notes",
});

export interface SeriesData {
  id: string;
  title: string;
  /** The account the Dependencies tab opens on: the subject of the series. */
  focus: string;
  snapshotId: string;
  /** Header data: title, subject, snapshot, block or slot range, capture time and the captures on record. */
  meta: SurfaceMeta;
  coverage: CoverageInput | null;
  results: Record<string, AnyResultV2>;
  /** The chain results of the Control tab, in tab order, each with its title. */
  controlGroups: { resultId: string; title: string }[];
}

export interface PackData {
  id: string;
  title: string;
  line: string;
  builder: string;
  fixtures: string[];
  /** One scope row of counts over the loaded snapshots. */
  index: ResultSet;
  series: SeriesData[];
}

/** One position opened: its observations, the account it is joined to, who controls that account, and exit limits. */
export interface SheetData {
  ordinal: number;
  /** The series whose graph the sheet draws, and the joined account in it; `null` when nothing is joined. */
  join: { pack: string; series: string; account: string } | null;
  constructed: boolean;
  snapshotIds: string[];
  results: Record<string, AnyResultV2>;
}

export interface ReadData {
  source: "recorded" | "constructed" | "live";
  constructed: boolean;
  address: string;
  meta: SurfaceMeta;
  list: ResultSet;
  notRead: ResultSet;
  receipts: Record<string, ReceiptRecord>;
  sheets: SheetData[];
}

export interface AppData {
  version: 1;
  build: "public" | "private";
  mode: "static" | "served";
  packs: PackData[];
  /** Protocols this build leaves out, each with the line the index shows. */
  absent: { id: string; line: string }[];
  receipts: Record<string, ReceiptRecord>;
  /** The replayed reads, in a static build. A served page asks its server instead. */
  positions: { reads: ReadData[] } | null;
  /** The address of the replayed reads, so a served page can ask for them. */
  replayAddress: string | null;
  live: boolean;
  ask: { enabled: boolean };
}

/** The prepared-answer document of the mounted answers handler. */
export interface PreparedAnswers {
  label: string;
  protocols: { id: string; title: string }[];
  answers: { id: string; question: string; protocol: string; label: string; ndjson: string }[];
}

export const strip = (id: string): string => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id);

export function findSeries(data: AppData, packId: string, seriesId: string): { pack: PackData; series: SeriesData } | null {
  const pack = data.packs.find((candidate) => candidate.id === packId);
  const series = pack?.series.find((candidate) => candidate.id === seriesId);
  return pack && series ? { pack, series } : null;
}
