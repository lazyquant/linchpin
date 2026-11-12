import { readdirSync } from "node:fs";
import { join } from "node:path";
import { orderSnapshots } from "../kamino";
import { loadKaminoLendCapture } from "./capture";
import { normalizeKaminoLendCapture } from "./normalize";
export * from "./constants";
export * from "./layout";
export * from "./capture";
export * from "./normalize";
export function buildKaminoLendResults(root = "fixtures/kamino-lend") {
 const results = readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()&&!d.name.startsWith(".")).map(d=>normalizeKaminoLendCapture(loadKaminoLendCapture(join(root,d.name))));
 const ordered = orderSnapshots(results.map(r=>r.snapshot)); return ordered.map(s=>results.find(r=>r.snapshot===s)!);
}
export function buildKaminoLendSnapshots(root = "fixtures/kamino-lend") { return buildKaminoLendResults(root).map(r=>r.snapshot); }
