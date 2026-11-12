import { canonical, sha256 } from "../../chain/evidence";
import { nearSubject } from "../reader/types";
export type NearChain = "rhea" | "intents" | "governance" | "mpc";
export type RelationName = "owned-by" | "priced-by" | "routes-through" | "deployed-by" | "upgraded-by" | "holds-role";
export type Recipe =
  | { kind: "account" } | { kind: "keys" } | { kind: "code" }
  | { kind: "acl"; upgradeRoles?: string[]; rolePredicates?: Record<string, "token-depositer" | "fee-collector"> }
  | { kind: "pause" } | { kind: "owner"; method: "get_owner" } | { kind: "guardians" } | { kind: "burrow-config" }
  | { kind: "sputnik-policy" } | { kind: "sputnik-proposals"; window: number | "all"; pinned?: number[] }
  | { kind: "controller-deployments" } | { kind: "mpc-state" } | { kind: "mpc-images" } | { kind: "ft-metadata" };
export interface SubjectEntry { account: string; subject: string; label: string; chains: [NearChain, ...NearChain[]]; recipes: Recipe[]; deployedBy?: string; yields: RelationName[] }
const owner: Recipe = { kind: "owner", method: "get_owner" };
const policy: Recipe = { kind: "sputnik-policy" };
const proposals = (window: number | "all", pinned?: number[]): Recipe => ({ kind: "sputnik-proposals", window, ...(pinned ? { pinned } : {}) });
function entry(account: string, chains: SubjectEntry["chains"], recipes: Recipe[] = [], yields: RelationName[] = [], deployedBy?: string): SubjectEntry {
  return { account, subject: nearSubject(account), label: account, chains, recipes: [{ kind: "account" }, { kind: "keys" }, ...recipes], yields, ...(deployedBy ? { deployedBy } : {}) };
}
const dao = (account: string, chains: SubjectEntry["chains"], window: number | "all", pinned?: number[]) => entry(account, chains, [policy, proposals(window, pinned)], ["deployed-by", "holds-role"], "sputnik-dao.near");
export const NEAR_REGISTRY: readonly SubjectEntry[] = [
  entry("contract.main.burrow.near", ["rhea"], [{ kind: "burrow-config" }], ["owned-by", "priced-by", "routes-through"]),
  dao("burrow.sputnik-dao.near", ["rhea", "governance"], 200, [1745, 1746]),
  entry("aggregate-oracle.near", ["rhea"], [owner], ["owned-by"]),
  entry("priceoracle.near", ["rhea"], [owner], ["owned-by"]),
  entry("v2.ref-finance.near", ["rhea"], [owner, { kind: "guardians" }], ["owned-by", "holds-role"]),
  dao("ref-finance.sputnik-dao.near", ["rhea", "governance"], 200),
  entry("sputnik-dao.near", ["rhea", "governance"], [owner], ["owned-by"]),
  entry("dclv2.ref-labs.near", ["rhea"], [owner], ["owned-by"]),
  entry("intents.near", ["intents"], [{ kind: "acl", upgradeRoles: ["Upgrader"] }, { kind: "pause" }], ["upgraded-by", "holds-role"]),
  entry("ctl-intents.near", ["intents"], [{ kind: "acl" }, { kind: "controller-deployments" }], ["holds-role"]),
  dao("intents.sputnik-dao.near", ["intents", "governance"], "all"),
  ...["relay-key-manager.near", "pm.bridge.near", "bridge-mng.near", "bridge-ops.near"].map(a => entry(a, ["intents"])),
  entry("wrap.near", ["intents"], [{ kind: "ft-metadata" }]),
  entry("omft.near", ["intents"], [{ kind: "acl", rolePredicates: { TokenDepositer: "token-depositer" } }], ["holds-role"]),
  entry("sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", ["intents"], [{ kind: "ft-metadata" }], ["deployed-by"], "omft.near"),
  dao("int-mnt-dao.sputnik-dao.near", ["intents", "governance"], "all"),
  entry("omni.bridge.near", ["intents"], [{ kind: "acl", upgradeRoles: ["UpgradableCodeDeployer", "UpgradableCodeStager"] }, { kind: "pause" }], ["upgraded-by", "holds-role"]),
  dao("rainbowbridge.sputnik-dao.near", ["intents", "governance"], 200, [330]),
  entry("omdep.near", ["intents"]),
  entry("sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near", ["intents"], [{ kind: "ft-metadata" }], ["deployed-by"], "omdep.near"),
  entry("v2_1.omni.hot.tg", ["intents"], [owner], ["owned-by"]),
  entry("v1.signer", ["mpc", "intents"], [{ kind: "mpc-state" }, { kind: "mpc-images" }]),
  dao("hos-root.sputnik-dao.near", ["governance"], "all"),
];
export const REGISTRY_VERSION = "near-registry/1";
export const CURRENT_NEAR_SNAPSHOT = "near-2026-11-09";
export function registryEntry(account: string): SubjectEntry | undefined { return NEAR_REGISTRY.find(e => e.account === account); }
export function registrySha256(): string { return sha256(canonical(NEAR_REGISTRY)); }
