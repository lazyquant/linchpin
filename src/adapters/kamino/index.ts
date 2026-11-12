import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceSnapshot } from "../../engine/queries/index";
import { CaptureRejected, loadCapture } from "./capture";
import { normalizeCapture } from "./normalize";
export * from "./constants";
export * from "./layout";
export * from "./capture";
export * from "./mechanics";
export * from "./claims";
export * from "./normalize";
export function orderSnapshots(snapshots: EvidenceSnapshot[]): EvidenceSnapshot[] {
  const seen = new Set<string>();
  for (const snapshot of snapshots) { if (snapshot.toBlockOrSlot === null || seen.has(BigInt(snapshot.toBlockOrSlot).toString())) throw new CaptureRejected("same-slot"); seen.add(BigInt(snapshot.toBlockOrSlot).toString()); }
  return [...snapshots].sort((a, b) => BigInt(a.toBlockOrSlot!) < BigInt(b.toBlockOrSlot!) ? -1 : 1);
}
export function buildKaminoSnapshots(root = "fixtures/kamino"): EvidenceSnapshot[] {
  return orderSnapshots(readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".")).map(d => normalizeCapture(loadCapture(join(root, d.name))).snapshot));
}
