import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCapture, normalizeCapture, orderSnapshots, type KaminoReport } from "../../adapters/kamino/index";
import { openStore, type EvidenceSnapshot, type EvidenceStore } from "../../engine/index";
export interface PositionEvidence { store: EvidenceStore; snapshots: EvidenceSnapshot[]; reports: Map<string, KaminoReport> }
export function loadKaminoEvidence(root = "fixtures/kamino"): PositionEvidence {
  const results = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("."))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(d => normalizeCapture(loadCapture(join(root, d.name))));
  const snapshots = orderSnapshots(results.map(result => result.snapshot));
  return { store: openStore(snapshots), snapshots, reports: new Map(results.map(result => [result.snapshot.id, result.report])) };
}
