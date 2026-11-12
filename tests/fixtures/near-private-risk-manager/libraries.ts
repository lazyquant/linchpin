/**
 * Fake and broken sibling libraries for the tester node. Built from the
 * published interfaces only (src/near/policy/libraries.ts exports), never from the
 * real intent or governance modules.
 */
import type { EvidenceStore } from "../../../src/engine/index";
import type { GovernanceLibrary, IntentLibrary, NearLibraries, ProposalSummaryLite, RouteClassification } from "../../../src/near/policy/index";

const strip = (s: string) => s.replace(/^near:mainnet:/, "");
const full = (s: string) => `near:mainnet:${strip(s)}`;
export const EFFECT_CLASS: Record<string, string> = { Withdraw: "funds", Transfer: "funds", ChangePolicy: "control", FunctionCall: "code" };

export interface FakeOptions {
  families?: Record<string, string | null>;
  /** proposal id -> override of state/effectClass; default derives from the proposal fact */
  overrides?: Record<string, { state?: string | null; effectClass?: string }>;
  touching?: Record<string, string[]>; // root -> proposal subjects
  gap?: boolean;
  calls?: string[];
}

function proposals(store: EvidenceStore, snapshotId: string, dao: string, o: FakeOptions): ProposalSummaryLite[] {
  const out: ProposalSummaryLite[] = [];
  const snap = store.snapshot(snapshotId);
  if (!snap) return out;
  for (const f of snap.facts) {
    if (f.predicate !== "proposal" || !f.subject.startsWith(`${full(dao)}#proposal:`)) continue;
    let body: any; try { body = JSON.parse(f.object); } catch { continue; }
    const kind = typeof body.kind === "string" ? body.kind : Object.keys(body.kind ?? {})[0] ?? "other";
    const ov = o.overrides?.[f.subject] ?? {};
    out.push({
      proposalSubject: f.subject, id: Number(body.id), status: String(body.status),
      state: ov.state !== undefined ? ov.state : body.status === "InProgress" ? "open" : "closed",
      effectClass: ov.effectClass ?? EFFECT_CLASS[kind] ?? "other", constructed: snap.constructed, factIds: [f.id],
    });
  }
  return out;
}

export function fakeLibraries(store: EvidenceStore, o: FakeOptions = {}): NearLibraries {
  const intents: IntentLibrary = {
    classify(assetId: string): RouteClassification {
      o.calls?.push(`classify:${assetId}`);
      const family = o.families && assetId in o.families ? o.families[assetId] : "near_withdrawal";
      return { family, reason: family === null ? "undocumented" : null, rule: "fake", ruleSetSha256: null, sdkVersion: null, factIds: [], receiptIds: [] };
    },
    review: (assetId: string) => ({ outcome: "complete", assetId }),
  };
  const governance: GovernanceLibrary = {
    openProposals(snapshotId: string, dao: string) { o.calls?.push(`open:${dao}`); return { proposals: proposals(store, snapshotId, dao, o), coverageGap: o.gap === true }; },
    proposalsTouching(snapshotId: string, subject: string) {
      o.calls?.push(`touching:${subject}`);
      const subs = o.touching?.[strip(subject)] ?? o.touching?.[full(subject)] ?? [];
      const all = [...new Set(subs.map(s => s.split("#")[0]))].flatMap(dao => proposals(store, snapshotId, dao, o));
      return { proposals: all.filter(p => subs.includes(p.proposalSubject)), coverageGap: o.gap === true };
    },
    review: () => ({ outcome: "complete" }),
  };
  return { intents, governance, status: [{ name: "near-intent-review", status: "loaded" }, { name: "near-governance-review", status: "loaded" }] };
}

/** Libraries whose every call throws or returns a wrong shape. */
export function brokenLibraries(mode: "throw" | "shape" = "throw"): NearLibraries {
  const bad = (): never => { throw new Error("broken-library"); };
  const wrong: any = () => ({ nonsense: true });
  const intents = (mode === "throw" ? { classify: bad, review: bad } : { classify: wrong, review: wrong }) as unknown as IntentLibrary;
  const governance = (mode === "throw" ? { openProposals: bad, proposalsTouching: bad, review: bad } : { openProposals: wrong, proposalsTouching: wrong, review: wrong }) as unknown as GovernanceLibrary;
  return { intents, governance, status: [{ name: "near-intent-review", status: "loaded" }, { name: "near-governance-review", status: "loaded" }] };
}
