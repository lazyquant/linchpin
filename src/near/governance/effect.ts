import { NEAR_REGISTRY, type SubjectEntry } from "../subjects/registry";
import { EFFECT_PRECEDENCE, type DecodedProposal, type EffectClass, type EffectResult, type EffectRule } from "./types";
const kinds: [string, EffectClass][] = [["AddMemberToRole","control"],["RemoveMemberFromRole","control"],["ChangePolicy","control"],["ChangePolicyAddOrUpdateRole","control"],["ChangePolicyRemoveRole","control"],["ChangePolicyUpdateDefaultVotePolicy","control"],["ChangePolicyUpdateParameters","control"],["UpgradeSelf","code"],["UpgradeRemote","code"],["Transfer","funds"],["Vote","text"],["ChangeConfig","other"],["SetStakingContract","other"],["FactoryInfoUpdate","other"],["AddBounty","other"],["BountyDone","other"],["unknown-kind","other"]];
export const CODE_METHODS = ["upgrade", "upgrade_and_migrate", "deploy", "deploy_code", "up_deploy_code", "up_stage_code", "stage_code", "update_contract"] as const;
export const EFFECT_TABLE: readonly EffectRule[] = [
  ...kinds.map(([match, effectClass], i): EffectRule => ({ id: `K${String(i+1).padStart(2,"0")}`, scope: "kind", match, effectClass, note: "Proposal kind" })),
  ...([ ["acl_*","control"], ["set_owner","control"], ["add_guardians | remove_guardians","control"], ["*pause_operator*","control"], ["add_full_access_key","control"], [CODE_METHODS.join(" | "),"code"], ["ft_transfer | ft_transfer_call","funds"], ["withdraw* | storage_withdraw","funds"], ["lender execute | execute_with_pyth with Withdraw","funds"], ["registry receiver","parameter"], ["otherwise","other"] ] as [string, EffectClass][]).map(([match,effectClass], i): EffectRule => ({ id: `A${String(i+1).padStart(2,"0")}`, scope: "action", match, effectClass, note: "First matching action rule" })),
];
export function classify(p: DecodedProposal, registry: readonly SubjectEntry[] = NEAR_REGISTRY): EffectResult {
  const d = p.decoded;
  if (d.kind !== "FunctionCall") { const r = EFFECT_TABLE.find(r => r.scope === "kind" && r.match === d.kind)!; return { effectClass: r.effectClass, ruleId: r.id, actions: [] }; }
  const entry = registry.find(e => e.account === d.receiver_id);
  const actions = d.actions.map((a,index) => {
    const m = a.method_name, args = a.args as { actions?: unknown[] } | null;
    const conditions = [m.startsWith("acl_"), m === "set_owner", ["add_guardians","remove_guardians"].includes(m), m.includes("pause_operator"), m === "add_full_access_key", (CODE_METHODS as readonly string[]).includes(m), ["ft_transfer","ft_transfer_call"].includes(m), m.startsWith("withdraw") || m === "storage_withdraw", entry?.recipes.some(r => r.kind === "burrow-config") && ["execute","execute_with_pyth"].includes(m) && a.argsFormat === "json" && Array.isArray(args?.actions) && args.actions.some(v => !!v && typeof v === "object" && Object.hasOwn(v,"Withdraw")), !!entry, true];
    const r = EFFECT_TABLE[17 + conditions.findIndex(Boolean)];
    return { index, method_name: m, effectClass: r.effectClass, ruleId: r.id };
  });
  const winner = [...actions].sort((a,b) => EFFECT_PRECEDENCE.indexOf(a.effectClass) - EFFECT_PRECEDENCE.indexOf(b.effectClass) || a.index-b.index)[0];
  return { effectClass: winner?.effectClass ?? "other", ruleId: winner?.ruleId ?? "A11", actions };
}
export function effectClass(p: DecodedProposal, registry?: readonly SubjectEntry[]): EffectClass { return classify(p, registry).effectClass; }
