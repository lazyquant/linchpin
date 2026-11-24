import type { Fact } from "../../engine/contracts";
export const GAP_TEXTS = ["none read", "one capture only: nothing to compare", "not a DAO", "unknown", "no relation recorded"] as const;
export const SECTION_TITLES = {
  identity: "Identity and capture", controls: "Who can change it", dependencies: "What it rests on",
  reverse: "What rests on it", state: "State", proposals: "Open proposals",
  changes: "Changes", gaps: "Not mapped", receipts: "Receipts",
} as const;
const WORDS: Record<string, string> = {
  "upgraded-by": "Upgrade authority", "owned-by": "Owner", "has-full-access-key": "Full-access keys",
  "has-function-call-key": "Function-call key", "super-admin-of": "Super administrator",
  "paused": "Paused", "pause-operator": "Pause operator", "has-code-hash": "Code hash",
  "council-member": "Council member", "vote-threshold": "Vote threshold",
  "priced-by": "Price source", "routes-through": "Route", "deployed-by": "Deployed by",
};
export const factWhat = (f: Fact): string => WORDS[f.predicate] ?? f.predicate;
export function factValue(f: Fact): string {
  if (f.object === "unknown") return "unknown";
  if (f.predicate === "has-full-access-key" && f.object === "none") return "none read as present";
  return f.object;
}

