import { readdirSync } from "node:fs";
import { callTool } from "../mcp/tools";
import { publicEvidenceStore } from "../mcp/privacy";
import { evaluateNearPolicy, loadNearLibraries, loadNearPolicy, referencedSnapshots } from "../policy/index";
import { loadNearSnapshots } from "../reader/load";
import { CURRENT_NEAR_SNAPSHOT, NEAR_REGISTRY } from "../subjects/registry";
import { loadTokenList } from "../intents/rules";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import type { Policy } from "../../policy/types";
import type { NearLibraries } from "../policy/libraries";
import type { NearAgentContext } from "./types";
import { NearAgentError } from "./errors";

export interface ContextOptions {
  snapshotId?: string; snapshotIds?: string[]; store?: EvidenceStore; libs?: NearLibraries;
  policies?: ReadonlyMap<string, Policy>; policiesDir?: URL; assets?: Iterable<string>;
  dispatch?: typeof callTool; warm?: boolean;
}
export async function createNearContext(options: ContextOptions = {}): Promise<NearAgentContext> {
  const snapshotId = options.snapshotId ?? CURRENT_NEAR_SNAPSHOT;
  const libs = options.libs ?? await loadNearLibraries();
  const policiesDir = options.policiesDir ?? new URL("../../../fixtures/near/policies/", import.meta.url);
  const policies = new Map(options.policies);
  if (!options.policies) {
    for (const name of readdirSync(policiesDir).sort()) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) continue;
      const policy = await loadNearPolicy(name.slice(0, -5), libs, policiesDir);
      policies.set(policy.policyId, policy);
    }
  }
  const snapshotIds = [...new Set([snapshotId, ...options.snapshotIds ?? [], ...[...policies.values()].flatMap(referencedSnapshots)])].sort();
  const store = publicEvidenceStore(options.store ?? loadNearSnapshots(snapshotIds));
  const snapshot = store.snapshot(snapshotId);
  if (!snapshot) throw new NearAgentError("missing-snapshot");
  const subjects = new Set([...snapshot.subjects, ...NEAR_REGISTRY.map(s => s.subject)].filter(s => !s.includes("#holder:")));
  const assets = new Set(options.assets ?? loadTokenList().map(t => t.assetId));
  const context: NearAgentContext = { store, snapshotId, snapshotIds, libs, policies, subjects, assets, policiesDir, dispatch: options.dispatch ?? callTool };
  if (options.warm !== false && policies.size) await warmContext(context);
  return context;
}
export async function warmContext(context: NearAgentContext): Promise<void> {
  const policyId = context.policies.keys().next().value;
  if (!policyId) throw new NearAgentError("readiness-failed");
  // Populate the existing libraries' caches before entering the MCP tool's short per-call cap.
  // Readiness is not advertised until the normal tool succeeds over that warmed context.
  evaluateNearPolicy(context.policies.get(policyId)!, context.store, context.snapshotId, context.libs);
  const response = await context.dispatch("linchpin_policy_verdict", { policyId }, context);
  if (response.isError) throw new NearAgentError("readiness-failed");
}
