import type { ProposalBundle } from "../governance/reader";
import type { Decoded } from "../governance/decode";
import type { Effect } from "../governance/effects";
import { reconcileReceipt, type Receipt } from "../governance/receipt";
import type { SimulationRun } from "../governance/simulate";
import type { Claim } from "../governance/claims";
import type { Graph, GNode, GEdge } from "./model";

export function buildGraph(b: ProposalBundle, decoded: Decoded[], effects: Effect[], receipts: Receipt[], sims: SimulationRun[], claims: Claim[]): Graph {
  const nodes = new Map<string, GNode>(); const edges: GEdge[] = [];
  const add = (n: GNode) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
  const realm = add({ id: `realm:${b.realm.address}`, type: "Realm", label: b.realm.name });
  const gov = add({ id: `gov:${b.governance.address}`, type: "Governance", label: `Governance ${b.governance.address.slice(0, 6)}…` });
  const treasury = add({ id: `treasury:${b.governance.nativeTreasury}`, type: "NativeTreasury", label: `Native treasury ${b.governance.nativeTreasury.slice(0, 6)}…` });
  const prop = add({ id: `proposal:${b.proposal.address}`, type: "Proposal", label: b.proposal.name, props: { state: b.proposal.stateName } });
  edges.push({ from: gov, to: realm, type: "BELONGS_TO", basis: "observed", evidenceIds: [b.governance.evidenceId] });
  edges.push({ from: treasury, to: gov, type: "TREASURY_OF", basis: "observed", evidenceIds: [b.governance.evidenceId], props: { derivation: "getNativeTreasuryAddress(program, governance)" } });
  edges.push({ from: prop, to: gov, type: "PROPOSED_IN", basis: "observed", evidenceIds: [b.proposal.evidenceId] });
  for (const [addr, ta] of Object.entries(b.tokenAccounts)) {
    const n = add({ id: `ta:${addr}`, type: "TokenAccount", label: `Token account ${addr.slice(0, 6)}…`, props: { balanceRaw: ta.amountRaw.toString(), slot: ta.slot } });
    const ownerId = ta.owner === b.governance.nativeTreasury ? treasury : add({ id: `acct:${ta.owner}`, type: "NativeTreasury", label: `Owner ${ta.owner.slice(0, 6)}…` });
    edges.push({ from: n, to: ownerId, type: "OWNED_BY", basis: "observed", evidenceIds: [ta.evidenceId] });
    edges.push({ from: n, to: add({ id: `mint:${ta.mint}`, type: "Mint", label: `Mint ${ta.mint.slice(0, 6)}…` }), type: "OF_MINT", basis: "observed", evidenceIds: [ta.evidenceId] });
  }
  for (const [addr, m] of Object.entries(b.mints)) add({ id: `mint:${addr}`, type: "Mint", label: `Mint ${addr.slice(0, 6)}…`, props: { supplyRaw: m.supplyRaw.toString(), decimals: m.decimals, slot: m.slot } });
  let decodedIndex = 0;
  b.transactions.forEach((t, ti) => {
    const tx = add({ id: `ptx:${t.address}`, type: "ProposalTransaction", label: `Transaction ${t.optionIndex}/${t.index}`, props: { executedAt: t.executedAt, executionStatus: t.executionStatus } });
    edges.push({ from: prop, to: tx, type: "HAS_TRANSACTION", basis: "observed", evidenceIds: [t.evidenceId] });
    t.instructions.forEach((ix, ii) => {
      const d = decoded[decodedIndex++];
      const ins = add({ id: `ix:${t.address}:${ii}`, type: "Instruction", label: d.kind === "unsupported" ? `Unsupported (${ix.programId.slice(0, 6)}…)` : d.kind, props: { program: ix.programId } });
      edges.push({ from: tx, to: ins, type: "CONTAINS_INSTRUCTION", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "createAccount") edges.push({ from: ins, to: add({ id: `ta:${d.account}`, type: "TokenAccount", label: `Token account ${d.account.slice(0, 6)}…` }), type: "CREATES", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "burn" || d.kind === "transfer") edges.push({ from: ins, to: `ta:${d.source}`, type: "DEBITS", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "burn") edges.push({ from: ins, to: `mint:${d.mint}`, type: "BURNS_FROM", basis: "decoded", evidenceIds: [t.evidenceId] });
      if (d.kind === "transfer") edges.push({ from: ins, to: add({ id: `ta:${d.destination}`, type: "TokenAccount", label: `Token account ${d.destination.slice(0, 6)}…` }), type: "CREDITS", basis: "decoded", evidenceIds: [t.evidenceId] });
    });
  });
  for (const e of effects) {
    const n = add({ id: `effect:${e.id}`, type: "Effect", label: `${e.type}: ${String(e.detail.display ?? e.detail.amountDisplay ?? e.detail.reason ?? "")}`, props: e.detail });
    const [, txIndex, ixIndex] = e.id.split("-");
    const tx = b.transactions[Number(txIndex)];
    const ixId = tx ? `ix:${tx.address}:${ixIndex}` : null; if (ixId) edges.push({ from: ixId, to: n, type: "PRODUCES", basis: e.basis, evidenceIds: e.evidenceIds });
    const mech = add({ id: e.type === "supplyChange" || e.type === "mint" ? "mech:supply" : e.type === "treasuryMovement" ? "mech:treasury" : "mech:control", type: "Mechanism", label: e.type === "supplyChange" || e.type === "mint" ? "Token supply" : e.type === "treasuryMovement" ? "DAO treasury" : "Control" });
    edges.push({ from: n, to: mech, type: "AFFECTS", basis: e.basis, evidenceIds: e.evidenceIds });
  }
  for (const receipt of receipts) {
    const r = add({ id: `receipt:${receipt.signature}`, type: "ExecutionReceipt", label: `Execution ${receipt.signature.slice(0, 8)}… @${receipt.slot}` });
    const tx = b.transactions[receipt.txIndex];
    if (!tx) continue;
    const offset = b.transactions.slice(0, receipt.txIndex).reduce((n, t) => n + t.instructions.length, 0);
    const rec = reconcileReceipt(decoded.slice(offset, offset + tx.instructions.length), tx, receipt);
    for (const e of effects.filter((e) => e.id.startsWith(`fx-${receipt.txIndex}-`) && e.type !== "unknown")) {
      if (rec.status === "matched" || !receipt.success) edges.push({ from: r, to: `effect:${e.id}`, type: receipt.success ? "CONFIRMS" : "FAILS", basis: "observed", evidenceIds: receipt.evidenceIds });
    }
  }
  for (const s of sims) {
    const n = add({ id: `sim:${s.txIndex ?? 0}:${s.ixIndex ?? "all"}:${s.id}`, type: "SimulationRun", label: `${s.kind}: ${s.success ? "success" : "failed"}` });
    for (const e of effects.filter((e) => e.id.startsWith(`fx-${s.txIndex ?? 0}-`) && (s.ixIndex == null || e.id.replace(/-(supply|move)$/, "") === `fx-${s.txIndex ?? 0}-${s.ixIndex}`))) edges.push({ from: n, to: `effect:${e.id}`, type: "PREVIEWS", basis: "simulated", evidenceIds: s.evidenceIds, props: { kind: s.kind } });
  }
  for (const c of claims) { const n = add({ id: `claim:${c.id}`, type: "Claim", label: c.text.slice(0, 60) }); edges.push({ from: n, to: prop, type: "DESCRIBES", basis: "claimed", evidenceIds: [], props: { source: c.source } }); }
  return { nodes: [...nodes.values()], edges };
}

/** The control path the demo follows: token account → treasury PDA → governance → realm. */
export function controlPath(g: Graph, tokenAccount: string): string[] {
  const path = [`ta:${tokenAccount}`]; let cur = path[0];
  for (const t of ["OWNED_BY", "TREASURY_OF", "BELONGS_TO"]) { const e = g.edges.find((x) => x.from === cur && x.type === t); if (!e) break; path.push(e.to); cur = e.to; }
  return path;
}

export function mermaid(g: Graph): string {
  const esc = (s: string) => s.replace(/"/g, "'");
  const id = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  return ["flowchart LR", ...g.nodes.map((n) => `  ${id(n.id)}["${esc(n.type)}: ${esc(n.label)}"]`), ...g.edges.map((e) => `  ${id(e.from)} -- ${e.type} (${e.basis}) --> ${id(e.to)}`)].join("\n");
}
