import { readFileSync } from "node:fs";
import { canonical, sha256 } from "../../chain/evidence";
import { isNearAccountId } from "../reader/types";
import type { AssetClassification, OmftRouteEvidence, ParsedAssetId, RouteRuleSet, TokenListEntry } from "./types";
import { isOmniTokenMetadata } from "./migration";
export function parseAssetId(assetId: string): ParsedAssetId | null {
  if (typeof assetId !== "string") return null;
  const [standard, contract, ...rest] = assetId.split(":");
  if (standard === "nep141" && isNearAccountId(contract ?? "") && !rest.length) return { standard, contract };
  if (standard === "nep245" && isNearAccountId(contract ?? "") && rest.join(":")) return { standard, contract, tokenId: rest.join(":") };
  if (standard === "1cs_v1" && contract && rest[0] && rest.slice(1).join(":")) return { standard, chain: contract, tokenStandard: rest[0], address: rest.slice(1).join(":") };
  return null;
}
export function loadRouteRules(path?: string): RouteRuleSet {
  const r = JSON.parse(readFileSync(path ?? new URL("../../../fixtures/near/oneclick/route-rules.json", import.meta.url), "utf8")) as RouteRuleSet;
  if (r.version !== 1 || r.sdkPackage !== "@defuse-protocol/intents-sdk" || !r.sdkVersion || !Array.isArray(r.rules)) throw new Error("Invalid route rules");
  return r;
}
export function classifyAsset(assetId: string, rules = loadRouteRules(), evidence: Record<string, OmftRouteEvidence> = {}): AssetClassification {
  const parsed = parseAssetId(assetId), rule = parsed && rules.rules.find(r => r.standard === parsed.standard && ("any" in r.match || "contract" in parsed && (("accountSuffix" in r.match && parsed.contract.endsWith(r.match.accountSuffix!)) || ("contract" in r.match && parsed.contract === r.match.contract))));
  const result: AssetClassification = { assetId, parsed, family: rule?.family ?? null, rule: rule?.id ?? null, sdkVersion: rules.sdkVersion, ruleSetSha256: sha256(canonical(rules)), nearContract: parsed && "contract" in parsed ? `near:mainnet:${parsed.contract}` : null,
    reason: !parsed ? { code: "missing-subject", subject: null, ref: assetId } : !rule || rule.reason ? { code: "missing-coverage", subject: null, ref: `${rule?.id ?? "unmatched"}:${assetId}` } : null };
  if (parsed?.standard === "nep141" && parsed.contract.endsWith(".omft.near")) {
    const e = evidence[parsed.contract];
    result.routeEvidence = e;
    result.family = e && isOmniTokenMetadata(e.sourceMetadata?.value) && e.controller?.value === "omni.bridge.near" && e.mapping?.value
      ? "omni_bridge" : e?.owner?.value === "omft.near" ? "poa_bridge" : null;
    if (result.family === "omni_bridge") result.migrated_from = "poa";
    const listed = !!rules.migrations?.some(m => m.token === parsed.contract);
    const conflict = result.family !== null && listed !== (result.family === "omni_bridge");
    result.sdkMigration = { listed, sourceFile: rules.sourceFile, sha256: rules.sourceSha256 ?? "", conflict };
    result.reason = !result.family ? { code: "missing-evidence", subject: result.nearContract, ref: "undetermined" }
      : conflict ? { code: "conflict", subject: result.nearContract, ref: `sdk-${rules.sdkVersion}:migration-table-vs-chain` } : null;
  }
  return result;
}
export function loadTokenList(path?: string): TokenListEntry[] {
  const data = JSON.parse(readFileSync(path ?? new URL("../../../fixtures/near/oneclick/tokens-2026-10-20.json", import.meta.url), "utf8"));
  if (!Array.isArray(data)) throw new Error("Invalid token list");
  return data;
}
