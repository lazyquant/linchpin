import type { Fact, QueryReason } from "../../engine/contracts";
import { OMNI_PROGRAM, REPORTED_MINTS, RHEA_MINT, TREASURY } from "./extension";
import type { HopRole, IntentLeg, RouteFamily } from "./types";
export const RECIPE_RELATIONS = ["upgraded-by", "super-admin-of", "holds-role", "owned-by", "deployed-by"];
export const FAMILY_RECIPES: Record<RouteFamily, readonly string[]> = {
  poa_bridge: ["omft.near"], omni_bridge: ["omni.bridge.near", "v1.signer"], hot_bridge: ["v2_1.omni.hot.tg"], near_withdrawal: [], undocumented: [],
};
export interface HopSpec { role: HopRole; family: RouteFamily | "common"; subject: string | null; viaFact?: Fact; reasons?: QueryReason[] }
export function recipeHops(legs: IntentLeg[], facts: Fact[]): HopSpec[] {
  const out: HopSpec[] = [], n = (s: string) => `near:mainnet:${s}`;
  const values = (s: string, p: string) => facts.filter(f => f.subject === s && f.predicate === p && f.object.startsWith("near:mainnet:") && f.object !== s);
  const edge = (role: HopRole, s: string, p: string, family: RouteFamily | "common") => { for (const f of values(s, p)) out.push({ role, family, subject: f.object, viaFact: f }); };
  for (const leg of legs) {
    const c = leg.classification, family = c.family ?? "common"; if (!c.parsed) continue;
    out.push({ role: "asset", family, subject: c.nearContract, reasons: c.reason ? [c.reason] : [] });
    out.push({ role: "verifier", family: "common", subject: n("intents.near") });
    edge("controller", n("intents.near"), "upgraded-by", "common");
    edge("dao", n("intents.near"), "super-admin-of", "common");
    for (const f of values(n("intents.near"), "super-admin-of")) edge("factory", f.object, "deployed-by", "common");
    edge("relay", n("intents.near#role:RelayerKeysManager"), "holds-role", "common");
    const solana = leg.token?.blockchain === "sol" || c.parsed.standard === "1cs_v1" && c.parsed.chain === "sol" || c.nearContract?.includes(":sol-");
    if (family === "poa_bridge") {
      out.push({ role: "bridge", family, subject: n("omft.near"), viaFact: facts.find(f => f.subject === c.nearContract && f.predicate === "deployed-by" && f.object === n("omft.near")) });
      edge("bridge-dao", n("omft.near"), "super-admin-of", family);
      edge("depositer", n("omft.near"), "token-depositer", family);
      if (solana) out.push({ role: "origin-artefact", family, subject: TREASURY });
    } else if (family === "omni_bridge") {
      if (!c.migrated_from) out.push({ role: "factory", family, subject: n("omdep.near"), viaFact: facts.find(f => f.subject === c.nearContract && f.predicate === "deployed-by" && f.object === n("omdep.near")) });
      out.push({ role: "bridge", family, subject: n("omni.bridge.near"), reasons: solana ? [{ code: "missing-coverage", subject: n("omni.bridge.near"), ref: "omni-solana-derivation-path" }] : [] });
      edge("bridge-dao", n("omni.bridge.near"), "super-admin-of", family);
      edge("bridge-ops", n("omni.bridge.near"), "upgraded-by", family);
      out.push({ role: "mpc", family, subject: n("v1.signer") });
      if (solana) out.push({ role: "origin-artefact", family, subject: OMNI_PROGRAM });
    } else if (family === "hot_bridge") out.push({ role: "hot", family, subject: n("v2_1.omni.hot.tg"), reasons: [{ code: "unknown-controller", subject: n("v2_1.omni.hot.tg"), ref: "hot-validator-identities" }] });
    else if (family === "undocumented" && c.parsed.standard === "1cs_v1") {
      const reasons: QueryReason[] = [{ code: "missing-coverage", subject: null, ref: "1cs_v1-semantics" }];
      if (c.parsed.address === RHEA_MINT) reasons.push({ code: "missing-evidence", subject: null, ref: "reported:rhea-mint-authority" });
      if (c.parsed.chain === "sol" && c.parsed.tokenStandard === "spl" && (REPORTED_MINTS as readonly string[]).includes(c.parsed.address)) out.push({ role: "origin-artefact", family, subject: n(`intents.near#solana:${c.parsed.address}`), reasons });
      else out[out.length - 1].reasons = [...out[out.length - 1].reasons ?? [], ...reasons];
    }
  }
  const seen = new Map<string, HopSpec>();
  for (const h of out) { const key = `${h.role}|${h.subject}`; const old = seen.get(key); if (old) old.reasons = [...old.reasons ?? [], ...h.reasons ?? []]; else seen.set(key, h); }
  return [...seen.values()];
}
