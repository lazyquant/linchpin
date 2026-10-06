import { sameCouncilMembers } from './councils';
import { governanceThresholdText as recordedGovernanceThresholdText, type GovernanceLayer, type ConfiguredGovernance } from '../contracts/governance-config';
import { buildTokenomicsGraph, TOKENOMICS_QUERIES, runTokenomicsLocal, tokenomicsSubgraph } from '../graph/tokenomics-neo4j';
import type * as API from './api';
import type { readContractsLayer } from '../contracts/marinade';
import type { readParticipation } from '../contracts/participation';
import type { readAuthorities } from '../contracts/authorities';
import type { PackPacket } from '../pack/model';
import type { PackRegistry } from '../pack/build';
import { deriveLiquidStakingAddresses } from '../pack/derive';
import { formatUnits } from '../chain/token-layout';
import { EvidenceIndex, evidenceIds, unique } from './evidence';
import type { readHolders } from '../contracts/holders';
import type { readFlows } from '../contracts/flows';

const governanceThresholdText = (...args: Parameters<typeof recordedGovernanceThresholdText>) =>
  recordedGovernanceThresholdText(...args).replace(/\b1 council tokens\b/g, '1 council token');

export type SectionInputs = {
  governance: GovernanceLayer;
  layer: Awaited<ReturnType<typeof readContractsLayer>>;
  participation: Awaited<ReturnType<typeof readParticipation>>;
  authorities: Awaited<ReturnType<typeof readAuthorities>>;
  pack: PackPacket; registry: PackRegistry; evidence: EvidenceIndex;
  docs: unknown; docsId: string; registryId: string; configured: boolean;
  holders: Awaited<ReturnType<typeof readHolders>>;
  flows: Awaited<ReturnType<typeof readFlows>>;
};
export const QUESTION = "Is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?";
const amount = (raw: string, unit = 'MNDE', decimals = 9): API.Amount => ({ raw, decimals, display: formatUnits(BigInt(raw), decimals), unit });
const iso = (seconds: number | null): string | null => seconds === null ? null : new Date(seconds * 1000).toISOString();
const percent = (fraction: number | null) => fraction === null ? 'unknown' : `${(fraction * 100).toFixed(2)} %`;
const label = (field: string) => field.replaceAll('.', ' / ').replace(/([a-z])([A-Z])/g, '$1 $2');
const reference = (id: string) => ({ evidenceIds: [id] });
const controllerId = (address: string | null) => address === null ? 'controller:none' : `controller:${address}`;
const paramId = (field: string) => `liquid-staking:${field}`;
const treasury = (i: SectionInputs) => i.layer.authorities.find(a => a.field === 'treasuryMsolAccount')!;

function daoTreasuryControl(i: SectionInputs, control: API.ControlData) {
  const address = i.registry.accounts.find(a => a.id === 'dao-treasury')?.address;
  return control.rows.find(r => r.id === `control:treasury-mnde:${address}`);
}

function controllerThreshold(i: SectionInputs, realm: GovernanceLayer['realms'][number], side: 'community' | 'council', gs: ConfiguredGovernance[]): string {
  const treasuryAddress = i.registry.accounts.find(a => a.id === 'dao-treasury')?.address;
  if (side === 'community') {
    const g = gs.find(g => g.nativeTreasury === treasuryAddress);
    if (!g) return 'Governance-specific community vote and veto thresholds; see governances';
    const vote = g.config.community.vote;
    return `MNDE ${vote.type === 'QuorumPercentage' ? 'quorum' : 'vote'} ${percent(vote.value === null ? null : vote.value / 100)} in the DAO treasury governance${g.config.council.veto.enabled ? `; council veto ${percent(g.config.council.veto.value! / 100)}` : ''}`;
  }
  const votes = gs.filter(g => g.config.council.vote.enabled).map(g => g.config.council.vote);
  const values = unique(votes.map(v => v.value));
  if (values.length !== 1 || values[0] === null || votes.some(v => v.type !== 'YesVotePercentage')) return 'Governance-specific council vote and veto thresholds; see governances';
  const owners = unique(realm.members.map(m => m.owner));
  const equalSeats = realm.councilDecimals === 0 && realm.members.every(m => m.depositedRaw === '1') && realm.councilSupplyRaw === String(owners.length);
  const vetoes = unique(gs.filter(g => g.config.council.veto.enabled).map(g => g.config.council.veto.value)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  return `${percent(values[0] / 100)} of council votes${equalSeats ? ` (${Math.ceil(owners.length * values[0] / 100)} of ${owners.length})` : ''}${vetoes.length ? `; council veto ${vetoes.map(v => v.toFixed(2)).join('–')} % where enabled` : ''}`;
}

function claimCredits(i: SectionInputs) {
  return [...new Map((i.flows.distributorClaims?.vaults ?? []).flatMap(v => v.transactions.flatMap(t => t.recipients.map(r =>
    [`${t.signature}:${r.destination}`, { ...r, signature: t.signature }] as const)))).values()];
}
function claimResultText(i: SectionInputs): string {
  const claims = i.flows.distributorClaims, credits = claimCredits(i);
  return claims && credits.length ? `${credits.filter(c => c.voterAuthority).length} of ${credits.length} claims observed so far (${amount(claims.voterAuthorityClaimedRaw).display} MNDE) went to current MNDE lockers in VSR` : 'no distributor claims to current MNDE lockers in VSR are observed in the recorded sample';
}
/** MNDE credited to the buyback wallet with no SOL or token payment in the same transaction (for example fills by an order program).
 * Reported next to purchases, never merged into them: their cost is not observed in these transactions. */
const STANDARD_PROGRAMS = new Set(['ComputeBudget111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111']);
export function creditsWithoutPayment(i: SectionInputs) {
  const rows = (i.flows.buybacks?.transactions ?? []).filter(t => t.kind === 'MNDE in' && BigInt(t.boughtRaw) === 0n && t.mndeDeltaRaw !== null && BigInt(t.mndeDeltaRaw) > 0n);
  const programs = unique(rows.flatMap(t => (t.topLevelPrograms ?? []).filter(id => !STANDARD_PROGRAMS.has(id)))).sort();
  const byMonth = new Map<string, { raw: bigint; transactions: number }>();
  for (const t of rows) {
    const month = t.blockTime === null ? 'unknown month' : iso(t.blockTime)!.slice(0, 7), entry = byMonth.get(month) ?? { raw: 0n, transactions: 0 };
    entry.raw += BigInt(t.mndeDeltaRaw!); entry.transactions++; byMonth.set(month, entry);
  }
  return { rows, total: rows.reduce((n, t) => n + BigInt(t.mndeDeltaRaw!), 0n), programs, byMonth };
}
const day = (value: string | null | undefined) => value ? value.slice(0, 10) : 'unknown date';

function buybackAnswerText(i: SectionInputs, purchase: API.PathLink): string {
  const f = i.flows, months = f.buybacks.months.filter(m => BigInt(m.mndeBoughtRaw.value) > 0n);
  const bought = amount(months.reduce((n, m) => n + BigInt(m.mndeBoughtRaw.value), 0n).toString());
  const sol = amount(months.flatMap(m => m.costs).filter(c => c.asset === 'SOL').reduce((n, c) => n + BigInt(c.raw), 0n).toString(), 'SOL');
  const observation = purchase.observed;
  const transfers = f.buybacks.transactions.flatMap(t => t.recipients.map(r => ({ ...r, month: t.blockTime === null ? 'unknown month' : iso(t.blockTime)!.slice(0, 7) })));
  const daoAddress = i.registry.accounts.find(a => a.id === 'dao-treasury')?.address;
  const dao = transfers.filter(r => r.owner === daoAddress && r.category === 'DAO native treasury');
  const vaults = transfers.filter(r => f.distributorClaims?.vaults.some(v => v.address === r.destination));
  const sum = (rows: typeof transfers) => amount(rows.reduce((n, r) => n + BigInt(r.amountRaw), 0n).toString()).display;
  const monthly = (rows: typeof transfers) => unique(rows.map(r => r.month)).sort().map(month => `${month}: ${sum(rows.filter(r => r.month === month))} MNDE`).join('; ');
  const credits = creditsWithoutPayment(i), sampleWindow = windowOf(f.buybacks.window);
  const purchases = f.buybacks.transactions.filter(t => BigInt(t.boughtRaw) > 0n);
  const creditMonths = [...credits.byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => `${m}: ${amount(String(v.raw)).display} MNDE`).join('; ');
  const total = amount(String(BigInt(bought.raw) + credits.total));
  const purchaseText = observation && sampleWindow ? `In the recorded window (${day(sampleWindow[0])} – ${day(sampleWindow[1])}) the buyback wallet received ${total.display} MNDE: ${bought.display} MNDE in ${purchases.length} purchases paid with ${sol.display} SOL in the same transaction (${months.map(m => m.month).join(', ')})${credits.rows.length ? `, and ${amount(String(credits.total)).display} MNDE in ${credits.rows.length} transactions through program ${credits.programs.join(', ')} without a payment in the same transaction (${creditMonths})` : ''}.` : 'No buyback purchases were observed in the recorded window.';
  const outgoing = [dao.length ? `${sum(dao)} MNDE to the DAO treasury native PDA (${monthly(dao)})` : '', vaults.length ? `${sum(vaults)} MNDE to a distributor vault (${monthly(vaults)})` : ''].filter(Boolean);
  const window = f.distributorClaims && windowOf(f.distributorClaims.window);
  return `${purchaseText}${outgoing.length ? ` It sent ${outgoing.join(' and ')};` : ''} ${claimResultText(i)}${window ? ` (claim window: ${day(window[0])} – ${day(window[1])})` : ''}. Who is eligible is defined off chain.`;
}

export function controlSection(i: SectionInputs): API.ControlData {
  const p = i.evidence.provenance.bind(i.evidence);
  const controllers = new Map<string, API.Controller>();
  const derived = deriveLiquidStakingAddresses();
  const bodyId = (realm: string, side: string) => `controller:realm:${realm}:${side}`;
  const configured = (address: string | null) => i.governance.governances.find(g => g.address === address || g.nativeTreasury === address);
  const actingBodies = (g: ConfiguredGovernance) => (['community', 'council'] as const).filter(side => {
    const realm = i.governance.realms.find(r => r.address === g.realm)!;
    return (side !== 'council' || realm.councilMint) && (g.config[side].vote.enabled || g.config[side].veto.enabled);
  }).map(side => bodyId(g.realm, side));
  for (const realm of i.governance.realms) for (const side of ['community', 'council'] as const) {
    if (side === 'council' && !realm.councilMint) continue;
    const gs = i.governance.governances.filter(g => g.realm === realm.address && (g.config[side].vote.enabled || g.config[side].veto.enabled));
    if (!gs.length) continue;
    const members = unique(realm.members.map(m => m.owner)).map(address => ({ address }));
    const vsr = realm.address === i.registry.governance.realm && realm.addins.community.voterWeight === i.registry.programs.find(p => p.id === 'vsr')?.address;
    const name = side === 'council' ? `${/council/i.test(realm.name) ? realm.name : `${realm.name} council`} (${members.length} members)`
      : `${realm.name} community — ${realm.communityMint === i.registry.mints.find(m => m.id === 'mnde')?.address ? 'MNDE' : 'community token'} voters${vsr ? ' through VSR' : ''}`;
    const governances = gs.map(g => ({ address: g.address, nativeTreasury: g.nativeTreasury, votingBody: g.votingBody, side,
      canPropose: g.config[side].canPropose, canVote: g.config[side].vote.enabled, canVeto: g.config[side].veto.enabled, thresholds: governanceThresholdText(g, realm) }));
    controllers.set(bodyId(realm.address, side), { id: bodyId(realm.address, side), type: side === 'council' ? 'council-realm' : 'dao-governance', label: name,
      address: realm.address, realm: { address: realm.address, name: realm.name }, program: realm.program,
      members: side === 'council' ? members : undefined, governances, threshold: controllerThreshold(i, realm, side, gs),
      note: 'Thresholds and proposal permissions apply separately to each governance; veto permission does not confer proposal creation.', ...p([realm, gs], ['decoded', 'derived']) });
  }
  function resolve(address: string | null, source: unknown, kind?: string, name?: string): string {
    const g = configured(address);
    if (g) {
      const sides = actingBodies(g);
      const primary = sides.find(id => id.endsWith(':community') && g.config.community.canPropose) ?? sides.find(id => id.endsWith(':council') && g.config.council.canPropose)
        ?? sides.find(id => g.config[id.endsWith(':community') ? 'community' : 'council'].vote.enabled);
      if (primary) return primary;
    }
    const id = controllerId(address);
    const existing = controllers.get(id);
    if (existing) { Object.assign(existing, p([existing, source], existing.basis)); return id; }
    const observed = i.authorities.authorities.find(a => a.address === address);
    const resolution = observed?.resolutions.find(r => r.status === 'resolved');
    let c: API.Controller = { id, address, type: 'unresolved', label: name ?? `Unresolved authority ${address}`, ...p([source, observed], 'decoded') };
    if (g && !actingBodies(g).length) c = { ...c, type: 'none', label: 'No enabled voting body', note: 'Neither side can create new proposals in this governance.' };
    else if (address === null) c = { ...c, type: 'none', label: 'No authority', note: 'Authority is absent in decoded state.' };
    else if (resolution?.status === 'resolved' && resolution.threshold !== undefined && resolution.owners !== undefined && resolution.layoutBasis !== undefined) {
      c = { ...c, type: 'multisig', label: resolution.derivation.kind === 'serum-multisig' ? 'Serum multisig' : 'Squads multisig',
        threshold: resolution.threshold, members: resolution.owners.map(o => ({ address: o.address })), program: resolution.program,
        note: `Controller account ${resolution.multisig}; layout basis: ${resolution.layoutBasis}. Member identities are not established.`,
        ...p([source, resolution], ['derived', 'decoded', resolution.layoutBasis]) };
    } else if (derived.some(d => d.address === address)) {
      const d = derived.find(d => d.address === address)!;
      c = { ...c, type: 'program', label: `Liquid-staking program PDA (${d.seed})`, program: d.program,
        note: 'The liquid-staking program controls this PDA; its code is upgradeable through its upgrade controller.', ...p(source, 'derived') };
    } else if (kind === 'wallet' || kind === 'wallet-no-account') {
      c = { ...c, type: 'wallet', label: name ?? `Wallet ${address}`, note: 'Wallet address; operator identity is not established.' };
    }
    controllers.set(id, c); return id;
  }
  for (const path of i.pack.controllerPaths) resolve(path.authority, path, path.authorityKind);
  for (const a of i.layer.authorities.filter(a => ['adminAuthority', 'pauseAuthority', 'validatorSystem.managerAuthority', 'operationalSolAccount'].includes(a.field)))
    resolve(a.address, a, a.classification.kind, a.field === 'validatorSystem.managerAuthority' ? 'Validator manager wallet' : undefined);
  for (const a of i.participation.nativeProxy.authorities) resolve(a.address, a, undefined, `Native ${a.field} authority`);
  for (const a of i.authorities.authorities) if (!controllers.has(controllerId(a.address))) resolve(a.address, a);
  const rows: API.ControlRow[] = [];
  // The map is intentionally inferred; it is not a source audit of instruction semantics.
  for (const link of i.layer.parameterControl.links.filter(l => ['configMarinade', 'configLp', 'changeAuthority', 'pause', 'resume'].includes(l.instruction))) {
    for (const signer of link.signers.filter(s => s.holder !== null)) rows.push({ id: `control:${link.instruction}:${link.stateField}:${signer.role}`,
      target: link.stateField, targetKind: link.instruction === 'changeAuthority' ? 'role' : 'parameter', canChange: label(link.stateField), instructions: [link.instruction],
      role: signer.role, holder: { address: signer.holder! }, controllerId: resolve(signer.holder, signer, signer.classification?.kind), ...p([link, signer], 'inferred') });
  }
  const manager = i.layer.authorities.find(a => a.field === 'validatorSystem.managerAuthority')!;
  const liquid = i.layer.programs.find(p => p.id === 'liquid-staking')!;
  const management = ['addValidator', 'removeValidator', 'setValidatorScore', 'emergencyUnstake', 'partialUnstake', 'configValidatorSystem'];
  for (const name of management) {
    const instruction = liquid.inventory.instructions.find(ix => ix.name === name);
    if (!instruction) continue;
    rows.push({ id: `control:${name}`, target: 'Validator management', targetKind: 'operations', canChange: label(name), instructions: [name],
      role: instruction.signerRoles.find(role => /managerAuthority/i.test(role)) ?? 'managerAuthority', holder: { address: manager.address }, controllerId: resolve(manager.address, manager, manager.classification.kind), ...p([instruction, manager], ['declared', 'decoded']) });
  }
  for (const path of i.pack.controllerPaths) {
    const program = i.registry.programs.find(p => p.address === path.subject);
    const mint = i.registry.mints.find(m => m.address === path.subject);
    if (!program && !mint && path.subject !== treasury(i).address) continue;
    const id = program ? `control:program:${program.id}` : mint ? `control:${mint.id}:${path.authorityType}` : 'control:treasury-msol';
    rows.push({ id, target: program ? `${program.id} program code` : mint ? `${mint.id.toUpperCase()} ${path.authorityType === 'mint' ? 'supply' : 'freeze authority'}` : 'Treasury mSOL account funds',
      targetKind: program ? 'program-code' : mint ? 'mint' : 'treasury', canChange: program ? 'Upgrade program code' : mint ? path.authorityType === 'mint' ? 'Issue tokens' : 'Freeze token accounts' : 'Transfer treasury mSOL',
      instructions: program ? ['Upgrade'] : mint ? [path.authorityType === 'mint' ? 'MintTo' : 'FreezeAccount'] : ['Transfer'],
      role: program ? 'upgradeAuthority' : mint ? `${path.authorityType}Authority` : 'tokenAccountOwner', holder: { address: path.authority ?? 'none' },
      controllerId: resolve(path.authority, path, path.authorityKind), ...p(path, path.authorityKind.startsWith('pda') || path.authorityKind === 'native-treasury-pda' ? 'derived' : 'decoded') });
  }
  for (const program of i.layer.programs) if (!rows.some(r => r.id === `control:program:${program.id}`)) {
    const auth = program.upgradeAuthority, address = auth.kind === 'upgradeable' ? auth.upgradeAuthority : null;
    rows.push({ id: `control:program:${program.id}`, target: `${program.id} program code`, targetKind: 'program-code', canChange: 'Upgrade program code',
      instructions: ['Upgrade'], role: 'upgradeAuthority', holder: { address: address ?? 'none' }, controllerId: resolve(address, auth, auth.classification?.kind), ...p(auth, 'decoded') });
  }
  for (const realm of i.governance.realms) if (realm.councilMint) {
    const mapping = i.governance.mappings.find(m => m.target === `${realm.name} council mint authority`);
    rows.push({ id: `control:council-mint:${realm.address}`, target: `${realm.name} council mint supply`, targetKind: 'mint',
    canChange: 'Issue council tokens', instructions: ['MintTo'], role: 'mintAuthority', holder: { address: realm.councilMintAuthority ?? 'none' },
    controllerId: resolve(realm.councilMintAuthority, [realm, mapping]), governance: mapping?.governance ?? undefined, ...p([realm, mapping], ['decoded', 'derived']) });
  }
  for (const owner of i.holders.mnde.owners) {
    const g = configured(owner.owner);
    if (!g || g.nativeTreasury !== owner.owner || BigInt(owner.amountRaw) <= 0n) continue;
    const classification = i.holders.classifications.find(c => c.address === owner.owner);
    const labels = classification?.roles.map(r => `${r.name} (${r.basis})`).join('; ');
    rows.push({ id: `control:treasury-mnde:${owner.owner}`, target: `${labels || 'DAO native treasury'} MNDE (${owner.owner})`, targetKind: 'treasury',
      canChange: 'Transfer treasury MNDE', instructions: ['Transfer'], role: 'tokenAccountOwner', holder: { address: owner.owner },
      controllerId: resolve(owner.owner, owner), ...p([owner, g, classification], ['decoded', 'derived', ...(classification?.roles.map(r => r.basis) ?? [])]) });
  }
  const grouped = new Map(controllers);
  const remap = new Map([...controllers.keys()].map(id => [id, id]));
  // A key may serve both roles. Keep it discoverable in each role's detail list.
  for (const a of i.participation.nativeProxy.authorities.filter(a => ['operator', 'alternateStaker'].includes(a.field))) {
    const original = controllers.get(resolve(a.address, a))!;
    const id = original.type === 'unresolved' ? `controller:native:${a.field}` : remap.get(original.id)!;
    if (original.type === 'unresolved') {
      const group = grouped.get(id) ?? { ...original, id, address: null, members: [] };
      group.members = unique([...(group.members ?? []).map(m => m.address), a.address]).map(address => ({ address }));
      Object.assign(group, p([group, a], 'decoded')); grouped.set(id, group);
    }
    rows.push({ id: `control:native:${a.field}:${a.address}`, target: `Native/Select roots: ${a.roots.join(', ')}`, targetKind: 'operations',
      canChange: `Exercise the declared ${a.field} role`, instructions: i.layer.programs.find(p => p.id === 'native-staking-proxy')?.inventory.instructions.filter(ix => ix.signerRoles.some(r => r === a.field)).map(ix => ix.name) ?? [],
      role: a.field, holder: { address: a.address }, controllerId: id, ...p(a, ['declared', 'decoded']) });
  }
  for (const c of grouped.values()) if (c.id.startsWith('controller:native:')) { c.address = null; c.label = `Marinade Native ${c.id.endsWith(':operator') ? 'operator' : 'alternate-staker'} authorities (${c.members?.length ?? 0}, unresolved)`; }
  for (const a of i.participation.nativeProxy.authorities.filter(a => ['operator', 'alternateStaker'].includes(a.field))) {
    const id = controllerId(a.address);
    if (grouped.get(id)?.type === 'unresolved' && !rows.some(r => r.controllerId === id)) grouped.delete(id);
  }
  for (const row of rows) {
    const g = configured(row.holder.address);
    if (g) {
      row.governance = g.address;
      row.controllerIds = unique([row.controllerId, ...actingBodies(g)]);
      row.note = `${g.votingBody === 'council-only' ? 'community voting disabled in this governance; ' : g.votingBody === 'no-proposals' ? 'neither side can create new proposals in this governance; ' : ''}${governanceThresholdText(g, i.governance.realms.find(r => r.address === g.realm)!)}`;
      Object.assign(row, p([row, g, i.governance.realms.find(r => r.address === g.realm)], ['decoded', 'derived', ...(Array.isArray(row.basis) ? row.basis : [row.basis])]));
    }
    if (row.id === 'control:program:liquid-staking') {
      const overlap = i.governance.overlaps.find(o => o.realm === i.registry.governance.realm);
      if (overlap) { row.note = `${overlap.count} of the ${overlap.signerCount} multisig signers ${overlap.count === 1 ? "is a current Marinade DAO council member" : "are current Marinade DAO council members"}.`; Object.assign(row, p([row, overlap], ['decoded', 'derived'])); }
    }
  }
  return { rows, controllers: [...grouped.values()] };
}

export function parametersSection(i: SectionInputs, control: API.ControlData): API.ParametersData {
  return { rows: i.layer.parameters.map(row => {
    let unit = row.unit, display = String(row.raw);
    if (unit === 'basis points') { unit = '%'; display = `${(Number(row.raw) / 100).toFixed(2)} %`; }
    else if (unit === 'hundredths of a basis point') { unit = '%'; display = `${(Number(row.raw) / 10000).toFixed(2)} %`; }
    else if (unit === 'lamports') { unit = 'SOL'; display = `${formatUnits(BigInt(String(row.raw)), 9)} SOL`; }
    else if (row.field === 'msolPrice') { unit = 'SOL per mSOL'; display = `${row.scaling!.solPerMsol} SOL per mSOL`; }
    const links = i.layer.parameterControl.links.filter(l => l.stateField === row.field);
    return { id: paramId(row.field), program: 'liquid-staking', field: row.field, label: label(row.field), value: String(row.raw), unit, display,
      setBy: links.flatMap(l => l.signers.filter(s => s.holder).map(s => ({ instruction: l.instruction, role: s.role, holder: { address: s.holder! },
        controllerId: control.rows.find(r => r.holder.address === s.holder && r.instructions.includes(l.instruction))?.controllerId ?? control.rows.find(r => r.holder.address === s.holder)?.controllerId ?? control.controllers.find(c => c.address === s.holder)?.id ?? null, basis: 'inferred' as const }))),
      ...i.evidence.provenance([row, links], links.length ? ['decoded', 'inferred'] : 'decoded') };
  }) };
}

export function programsSection(i: SectionInputs, control: API.ControlData): API.ProgramsData {
  return { rows: i.layer.programs.map(program => {
    const activity = i.participation.activity.find(a => a.program === program.id);
    const upgrades = i.authorities.authorities.flatMap(a => a.upgrades).filter(u => u.programUpgraded === program.address && u.succeeded === true);
    const auth = program.upgradeAuthority;
    const address = auth.kind === 'upgradeable' ? auth.upgradeAuthority : null;
    return { id: program.id, address: program.address,
      idl: program.idl.kind === 'idl' ? { name: program.idl.idl.name, version: program.idl.idl.version, instructions: program.inventory.instructionCount } : null,
      upgradeable: auth.kind === 'upgradeable' && auth.upgradeable,
      upgradeAuthority: address ? { address, controllerId: control.rows.find(r => r.id === `control:program:${program.id}`)?.controllerId ?? null } : null,
      lastDeploySlot: auth.kind === 'upgradeable' ? auth.lastDeploySlot : null,
      activity: { newest: iso(activity?.newestBlockTime.value ?? null), oldestInWindow: iso(activity?.oldestBlockTime.value ?? null),
        txPerDay: activity?.transactionsPerDay.value ?? null, dormant: activity?.dormant.value ?? null },
      upgrades: unique(upgrades.map(u => u.signature)).map(signature => { const u = upgrades.find(u => u.signature === signature)!; return { time: iso(u.blockTime), slot: u.slot, signature }; }),
      ...i.evidence.provenance([program, activity, upgrades], ['declared', 'decoded', 'observed', 'derived']) };
  }) };
}

type Figure = { value: unknown; evidenceIds: string[]; basis: API.Basis; unit?: string };
type Quantity = { raw: string; evidenceIds: string[]; basis: API.Basis };
export function participationSection(i: SectionInputs): API.ParticipationData {
  const { vsr: v, ...layer } = i.participation, p = i.evidence.provenance.bind(i.evidence);
  const metric = (id: string, title: string, f: Figure): API.Metric => ({ id, label: title, value: f.value === null ? 'unknown' : typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value),
    ...p(f, f.basis), ...(f.unit ? { note: f.unit } : {}) });
  const quantity = (id: string, title: string, f: Quantity): API.Metric => ({ id, label: title, value: f.raw, amount: amount(f.raw), ...p(f, f.basis) });
  const locking: API.Metric[] = [metric('voters', 'Voters', v.voters), metric('voters-with-deposits', 'Voters with used deposits', v.votersWithUsedDeposits),
    quantity('locked-mnde', 'Time-locked MNDE', v.timeLocked), metric('locked-share-of-supply', 'Time-locked share of MNDE supply (fraction)', v.timeLockedShareOfSupply),
    quantity('deposited-mnde', 'Deposited MNDE (including unlocked)', v.totalDeposited), metric('deposited-share-of-supply', 'Deposited share of supply (fraction)', v.shareOfSupply),
    metric('top10-share-of-deposits', 'Top-10 share of deposits (fraction)', v.top10ShareOfDeposits), metric('top10-share-of-supply', 'Top-10 share of supply (fraction)', v.top10ShareOfSupply),
    ...v.byLockupKind.map(f => quantity(`kind:${f.kind}`, `Lockup kind: ${f.kind}`, f)), ...v.byRemainingLockup.map(f => quantity(`remaining:${f.bucket}`, `Remaining lockup: ${f.bucket}`, f)),
    ...(['matched', 'mismatched', 'missing'] as const).map(k => metric(`vault:${k}`, `Vault reconciliation: ${k}`, v.reconciliation[k])),
    quantity('vault:deposits', 'Reconciliation deposits', v.reconciliation.deposits), quantity('vault:balances', 'Reconciliation vault balances', v.reconciliation.vaultBalances)];
  locking.find(m => m.id === 'locked-mnde')!.amount!.shareOfSupply = v.timeLockedShareOfSupply.value;
  const votingPower = [metric('voting:total', 'Estimated voting power', v.voting.total), metric('voting:top20-share', 'Top-20 share of estimated voting power (fraction)', v.voting.top20Share),
    metric('voting:formula', 'Voting formula assumption', v.voting.formulaSource), metric('voting:time-offset', 'Registrar time offset (seconds)', v.voting.registrarTimeOffset),
    ...v.voting.configuration.flatMap(c => (['digitShift', 'baselineVoteWeightScaledFactor', 'maxExtraLockupVoteWeightScaledFactor', 'lockupSaturationSecs'] as const)
      .map(k => metric(`voting:mint:${c.index}:${k}`, `Mint slot ${c.index}: ${label(k)}`, { ...c, value: c[k] }))),
    ...v.voting.top20.map((f, index) => metric(`voting:rank:${index + 1}`, `Estimated voting power: ${f.voterAuthority}`, f))];
  const programs: API.ParticipationData['programs'] = [];
  const add = (program: string, id: string, title: string, f: Figure) => programs.push({ program, ...metric(`${program}:${id}`, title, f) });
  add('escrow-relocker', 'escrows', 'Escrows', layer.escrow.count); add('escrow-relocker', 'total', 'Escrow raw amount across all realms', layer.escrow.totalEscrowed);
  add('escrow-relocker', 'owners', 'Escrow owners', layer.escrow.owners); add('escrow-relocker', 'lockup-ends', 'Escrow lockup ends', layer.escrow.lockupEnds);
  for (const [k, group] of Object.entries(layer.gauges)) add('escrow-relocker', k, `Gauge ${k}`, group.count);
  add('directed-stake', 'records', 'Directed stake records', layer.directedStake.total); add('directed-stake', 'amount', 'Directed stake amount', layer.directedStake.amount);
  for (const target of layer.directedStake.top20Targets) add('directed-stake', `target:${target.target}`, `Records for ${target.target}`, target.records);
  add('referral', 'partners', 'Referral partners', layer.referral.count);
  for (const partner of layer.referral.partners) for (const f of partner.fields) add('referral', `${partner.address}:${f.name}`, `${partner.name}: ${label(f.name)}`, f);
  add('native-staking-proxy', 'roots', 'Native roots', layer.nativeProxy.count); add('native-staking-proxy', 'fees', 'Native fees', layer.nativeProxy.fees);
  for (const [k, f] of Object.entries(layer.delayedUnstake)) add('liquid-staking', `delayed:${k}`, `Delayed unstake: ${label(k)}`, f);
  for (const activity of layer.activity) {
    add(activity.program, 'activity', 'Transactions per day in signature window', activity.transactionsPerDay);
    add(activity.program, 'dormant', 'No recorded address transactions for over 30 days', activity.dormant);
  }
  return { locking, votingPower, programs, topLockers: v.top20.map((r, index) => ({ rank: index + 1, authority: { address: r.voterAuthority },
    amount: { ...amount(r.amount.raw), shareOfSupply: r.shareOfSupply.value }, ...p([r.amount, r.shareOfSupply], 'derived') })) };
}

export function claimsSection(i: SectionInputs): API.ClaimsData {
  const p = i.evidence.provenance.bind(i.evidence), docs = reference(i.docsId), registry = reference(i.registryId);
  const rows: API.ClaimRow[] = i.layer.checks.map(c => ({ id: `g1:${c.field}`, text: `${c.field} matches the declared registry`, source: 'packs/marinade/registry.json',
    status: c.status === 'verified' ? 'verified' : 'contradiction', chainResult: `${c.actual}; expected ${c.expected}`, note: 'G1 decoded-state check.', ...p([c, registry], ['decoded', 'declared']) }));
  for (const c of i.layer.claims) rows.push({ id: c.id, text: c.text, source: c.source, status: c.status, chainResult: c.note, note: 'G1 fee check.', ...p([c, docs, registry], ['decoded', 'claimed']) });
  const fee = i.layer.parameters.find(r => r.field === 'delayedUnstakeFee')!;
  // Require the actual captured claim as well as the decoded value; no invented docs quote.
  const captured = JSON.stringify(i.docs).includes('Delayed unstaking of mSOL carries a 0.2% protocol fee.');
  rows.push({ id: 'delayed-unstake-fee', text: 'Delayed unstaking of mSOL carries a 0.2 % protocol fee.',
    source: i.registry.sources['docs:fees-and-pricing'], status: !captured ? 'unresolved' : String(fee.raw) === '2000' ? 'verified' : 'contradiction',
    chainResult: `Decoded delayedUnstakeFee = ${fee.raw} FeeCents = ${Number(fee.raw) / 10000} %.`, note: 'FeeCents / 10,000 gives percent; this checks the fee, not its destination.',
    ...p([fee, docs], ['decoded', 'claimed']) });
  for (const claim of i.pack.claims.filter(c => !/^v[1-9]$/.test(c.id))) {
    const related = i.pack.controllerPaths.filter(path => path.claims.some(c => c.text === claim.text));
    const statements = i.pack.statements.filter(s => claim.id.startsWith(s.id.split('-state')[0]) || s.text.includes(claim.text));
    rows.push({ id: `pack:${claim.id}`, text: claim.text, source: claim.source, status: claim.status === 'outside-scope' ? 'unresolved' : claim.status,
      chainResult: claim.note, note: 'Pack documentation check; original status retained.', ...p([docs, registry, related, statements], ['claimed', ...(related.length || statements.length ? ['decoded' as const] : [])]) });
  }
  for (const c of [...i.flows.claims, ...(i.flows.feeClaims ?? []).map((c, n) => ({ ...c, id: `fee-statement:${n}` }))]) {
    const status = (['verified', 'contradiction', 'unresolved', 'partly', 'claimed'] as const).find(s => s === c.status) ?? 'unresolved';
    const row: API.ClaimRow = { id: c.id, text: c.text, source: c.source, status, chainResult: c.chainResult, note: 'G5 check within recorded scope.', ...p(c, ['claimed', 'derived']) };
    const index = rows.findIndex(r => r.id === c.id);
    if (index < 0) rows.push(row); else rows[index] = row;
  }
  return { rows };
}

export function pathSection(i: SectionInputs, parameters: API.ParametersData, control: API.ControlData, claims: API.ClaimsData): API.PathData {
  const p = i.evidence.provenance.bind(i.evidence), t = treasury(i);
  const buyback = i.registry.accounts.find(a => /buyback/i.test(a.id));
  const nodes: API.PathNode[] = [
    { id: 'staking-rewards', label: 'Staking rewards', kind: 'activity' }, { id: 'reward-fee', label: 'Reward fee', kind: 'fee' },
    { id: 'liquid-unstake', label: 'Liquid unstake', kind: 'activity' }, { id: 'lp-fee', label: 'LP fee', kind: 'fee' },
    { id: 'withdraw-stake', label: 'Withdraw stake account', kind: 'activity' }, { id: 'withdraw-fee', label: 'Stake-account withdrawal fee', kind: 'fee' },
    { id: 'delayed-unstake', label: 'Delayed unstake', kind: 'activity' }, { id: 'delayed-fee', label: 'Delayed-unstake fee', kind: 'fee' },
    { id: 'unknown-destination', label: 'No destination account declared', kind: 'account' },
    { id: 'treasury-msol', label: 'Treasury mSOL account', kind: 'account', address: t.address },
    { id: 'protocol-revenue', label: 'Protocol revenue / onward transfers', kind: 'mechanism' },
    { id: 'buyback-wallet', label: 'MIP-22 buyback wallet', kind: 'account', address: buyback?.address ?? null },
    { id: 'mnde-purchases', label: 'MNDE purchases', kind: 'mechanism' }, { id: 'mnde-stakers', label: 'MNDE stakers', kind: 'holders' },
    { id: 'vsr-locking', label: 'MNDE locked in VSR', kind: 'mechanism', address: i.layer.registrar.address },
    { id: 'voting-weight', label: 'MNDE voters (VSR)', kind: 'mechanism' },
    { id: 'dao-council', label: 'Marinade DAO council', kind: 'governance', address: i.registry.governance.realm },
    { id: 'admin-authority', label: 'Admin authority', kind: 'account', address: i.layer.authorities.find(a => a.field === 'adminAuthority')!.address },
    { id: 'fee-parameters', label: 'Fee parameters', kind: 'mechanism' },
  ];
  const links: API.PathLink[] = [];
  const liquid = i.layer.programs.find(p => p.id === 'liquid-staking')!;
  function link(id: string, from: string, to: string, mechanism: string, status: API.LinkStatus, fields: string[], instructions: string[], claimIds: string[], note: string, extra: unknown = null, basis: API.Basis | API.Basis[] = ['declared', 'decoded']) {
    const params = parameters.rows.filter(r => fields.includes(r.field));
    const controls = control.rows.filter(r => r.instructions.some(ix => instructions.includes(ix)) || (fields.length > 0 || instructions.length > 0) && r.id === 'control:program:liquid-staking');
    const declared = liquid.inventory.instructions.filter(ix => instructions.includes(ix.name));
    links.push({ id, from, to, mechanism, status, parameters: params.map(r => ({ id: r.id, display: r.display })), observed: null, claims: claimIds,
      controlledBy: controls.map(r => r.id), note, ...p([params, declared, extra, claims.rows.filter(c => claimIds.includes(c.id))], basis) });
  }
  const fee = (field: string) => parameters.rows.find(r => r.field === field)!.display;
  link('rewards-fee', 'staking-rewards', 'reward-fee', 'Reward fee', 'enforced-by-code', ['rewardFee'], ['configMarinade'], ['v1'], `${fee('rewardFee')} of staking rewards is taken.`);
  link('rewards-treasury', 'reward-fee', 'treasury-msol', 'Reward-fee treasury route', 'enforced-by-code', ['rewardFee'], ['updateActive', 'updateDeactivated'], ['v1'], 'Declared treasury route; the decoded zero fee produces no reward-fee income.', t);
  link('liquid-lp-fee', 'liquid-unstake', 'lp-fee', 'Liquid unstake LP fee', 'enforced-by-code', ['liqPool.lpMinFee', 'liqPool.lpMaxFee'], ['liquidUnstake', 'configLp'], [], 'Declared liquidUnstake route and decoded LP fee bounds.');
  link('lp-treasury', 'lp-fee', 'treasury-msol', 'LP treasury cut', 'enforced-by-code', ['liqPool.treasuryCut'], ['liquidUnstake', 'configLp'], [], `${fee('liqPool.treasuryCut')} of the LP fee routes to the treasury mSOL account.`, t);
  link('withdraw-fee', 'withdraw-stake', 'withdraw-fee', 'Withdraw stake account fee', 'enforced-by-code', ['withdrawStakeAccountFee'], ['withdrawStakeAccount', 'configMarinade'], [], `Decoded fee: ${fee('withdrawStakeAccountFee')}.`);
  link('withdraw-treasury', 'withdraw-fee', 'treasury-msol', 'Stake-account withdrawal treasury route', 'enforced-by-code', ['withdrawStakeAccountFee'], ['withdrawStakeAccount'], [], 'Declared treasury account and decoded fee.', t);
  link('delayed-fee', 'delayed-unstake', 'delayed-fee', 'Delayed unstake fee', 'enforced-by-code', ['delayedUnstakeFee'], ['orderUnstake', 'configMarinade'], ['delayed-unstake-fee'], `Decoded fee: ${fee('delayedUnstakeFee')}.`);
  link('delayed-destination', 'delayed-fee', 'unknown-destination', 'Delayed-unstake destination', 'pending', ['delayedUnstakeFee'], ['orderUnstake', 'claim'], ['delayed-unstake-fee'], 'No destination account is declared for the delayed-unstake fee; destination verification is pending.');
  const treasuryControl = control.rows.find(r => r.id === 'control:treasury-msol')!;
  link('treasury-onward', 'treasury-msol', 'protocol-revenue', 'Onward transfers', 'operated-by-accounts', [], [], [], 'Moving funds requires the treasury token-account owner’s signature; onward movements are not yet measured.', treasuryControl, 'decoded');
  links.at(-1)!.controlledBy = [treasuryControl.id];
  link('revenue-buyback', 'protocol-revenue', 'buyback-wallet', 'MIP-22 revenue allocation', 'claimed-only', [], [], ['v5'], 'The claimed revenue allocation requires matched-window funding evidence.', reference(i.registryId), 'claimed');
  link('buyback-purchases', 'buyback-wallet', 'mnde-purchases', 'Buy MNDE', 'pending', [], [], ['v5'], 'No usable dated purchase observations are available in G5.', reference(i.registryId), 'claimed');
  link('purchases-stakers', 'mnde-purchases', 'mnde-stakers', 'Distribute MNDE to stakers', 'claimed-only', [], [], ['v6'], 'The claimed staker route requires observed recipient and eligibility checks.', reference(i.registryId), 'claimed');
  const adminRow = control.rows.find(r => r.role === 'adminAuthority' && r.instructions.includes('configMarinade'))!;
  const admin = control.controllers.find(c => c.id === adminRow.controllerId)!;
  const governanceEvidence = [i.layer.registrar, admin, adminRow];
  link('lock-vote', 'vsr-locking', 'voting-weight', 'Registrar voting-weight configuration', 'enforced-by-code', [], [], [], 'Decoded registrar configures voting weight; the participation formula remains a derived estimate.', i.layer.registrar, ['decoded', 'derived']);
  nodes.find(n => n.id === 'dao-council')!.label = admin.label;
  link('council-admin', 'dao-council', 'admin-authority', 'Council governance holds admin role', 'enforced-by-code', [], ['changeAuthority'], [], adminRow.note ?? 'Voting configuration unavailable.', governanceEvidence, ['decoded', 'derived']);
  link('admin-fees', 'admin-authority', 'fee-parameters', 'Admin configures fees', 'enforced-by-code', ['rewardFee', 'liqPool.treasuryCut', 'delayedUnstakeFee', 'withdrawStakeAccountFee'], ['configMarinade', 'configLp'], [], 'IDL signer declarations and decoded admin role link the council governance to fee settings.', governanceEvidence, ['declared', 'decoded', 'derived']);
  const daoTreasury = daoTreasuryControl(i, control);
  if (daoTreasury?.governance) {
    const community = control.controllers.find(c => (daoTreasury.controllerIds ?? []).includes(c.id) && c.type === 'dao-governance');
    const g = community?.governances?.find(g => g.address === daoTreasury.governance);
    nodes.push({ id: 'dao-treasury-governance', label: 'DAO treasury governance', kind: 'governance', address: daoTreasury.governance },
      { id: 'dao-treasury-mnde', label: 'DAO treasury MNDE', kind: 'account', address: daoTreasury.holder.address });
    if (g?.canVote) {
      link('vote-treasury', 'voting-weight', 'dao-treasury-governance', 'MNDE community voting', 'enforced-by-code', [], [], [], daoTreasury.note!, [community, daoTreasury, i.layer.registrar], ['decoded', 'derived']);
      links.at(-1)!.controlledBy = [daoTreasury.id];
    }
    link('governance-treasury', 'dao-treasury-governance', 'dao-treasury-mnde', 'Governance controls native treasury', 'enforced-by-code', [], [], [], daoTreasury.note!, daoTreasury, ['decoded', 'derived']);
    links.at(-1)!.controlledBy = [daoTreasury.id];
  }
  const path = { nodes, links };
  applyFlowObservations(i, path);
  return path;
}

export function offsetsSection(i: SectionInputs, programs: API.ProgramsData): API.OffsetsData {
  const p = i.evidence.provenance.bind(i.evidence), mnde = i.registry.mints.find(m => m.id === 'mnde')!.address;
  const external = i.pack.ledger.entries.filter(e => e.asset === mnde && e.kind === 'transfer' && e.sourceControl === 'dao-controlled' && e.destinationControl === 'external'
    && e.executedAt !== null && (e.reconciliation === 'matched' || e.reconciliation.startsWith('matched (aggregate of ')));
  const dates = external.flatMap(e => e.executedAt === null ? [] : [iso(e.executedAt)!]).sort();
  const rows: API.OffsetsData['rows'] = [{ id: 'dao-external-mnde', label: 'DAO-controlled MNDE sent to external accounts by executed proposals',
    amount: external.length ? amount(external.reduce((sum, e) => sum + BigInt(e.amountRaw!), 0n).toString()) : null,
    window: dates.length ? [dates[0], dates.at(-1)!] : null,
    note: 'Reconciled successful proposal transfers within the captured ledger; external transfers do not establish market sales. Window is first to last execution.', ...p(external, 'observed') }];
  const balances = (i.pack.stateFacts ?? []).filter(f => f.raw !== null && f.id.startsWith('balance:') && /MNDE/i.test(f.label)
    && i.pack.controllerPaths.some(c => `balance:${c.subject}` === f.id && c.authorityKind === 'native-treasury-pda' && c.path.includes(i.registry.governance.realm)));
  rows.push({ id: 'dao-mnde-held', label: 'MNDE held by DAO native treasuries at capture', amount: balances.length ? amount(balances.reduce((s, f) => s + BigInt(f.raw!), 0n).toString()) : null,
    window: p(balances).asOf ? [p(balances).asOf!, p(balances).asOf!] : null, note: 'Sum of captured MNDE token-account balances with a DAO native-treasury owner in the pack; not a complete inventory of all DAO holdings.', ...p(balances, 'decoded') });
  for (const bucket of i.participation.vsr.byRemainingLockup.filter(b => ['none', 'under 30 days'].includes(b.bucket))) rows.push({ id: `lockup:${bucket.bucket}`, label: `VSR MNDE with remaining lockup: ${bucket.bucket}`,
    amount: amount(bucket.raw), window: [i.participation.asOf, i.participation.asOf], note: 'Derived remaining-duration bucket; does not imply withdrawal or selling. Constant lockups use end minus start.', ...p(bucket, 'derived') });
  for (const program of programs.rows.filter(r => ['validator-gauges', 'liquidity-gauges', 'directed-stake'].includes(r.id) && r.activity.dormant)) rows.push({ id: `dormant:${program.id}`, label: `${program.id}: no transactions for over 30 days`, amount: null,
    window: program.activity.newest ? [program.activity.newest, i.participation.asOf] : null, note: 'Newest recorded address transaction is over 30 days before participation capture; this is not proof the program is disabled.', ...p(i.participation.activity.find(a => a.program === program.id), 'observed') });
  for (const m of holdersSection(i).mnde.float.filter(m => /DAO|Labs|verifiedOnly|includingClaimed/.test(m.id))) rows.push({ id: `holders:${m.id}`, label: m.label, amount: m.amount ?? null, window: m.asOf ? [m.asOf, m.asOf] : null, note: m.note ?? 'Captured holder balance; the Labs identity remains claimed. Custody remainder is not market liquidity.', ...p(m, m.basis) });
  return { rows };
}

/** Inspect directed paths, rather than array order or the separate governance branches. */
export function answerStatus(path: API.PathData): API.AnswerData['shortAnswer']['status'] {
  if (!path.links.some(l => l.status === 'enforced-by-code')) return 'undetermined';
  const conditional = new Set<API.LinkStatus>(['operated-by-accounts', 'claimed-only', 'pending']);
  function walk(node: string, enforced: boolean, conditionalAfter: boolean, visited: Set<string>): boolean {
    if (path.nodes.find(n => n.id === node)?.kind === 'holders') return enforced && conditionalAfter;
    return path.links.filter(l => l.from === node && !visited.has(l.id)).some(l => walk(l.to, enforced || l.status === 'enforced-by-code',
      conditionalAfter || enforced && conditional.has(l.status), new Set([...visited, l.id])));
  }
  if (path.nodes.filter(n => n.kind === 'activity').some(n => walk(n.id, false, false, new Set()))) return 'partly';
  // Evidence of code alone cannot establish an end-to-end entitlement to holders.
  return 'undetermined';
}
export function governanceAnswerText(i: SectionInputs, control: API.ControlData) {
  const fee = control.rows.find(r => r.role === 'adminAuthority' && r.instructions.includes('configMarinade'))!;
  const body = control.controllers.find(c => c.id === fee.controllerId)!;
  const g = i.governance.governances.find(g => g.address === fee.governance);
  const fees = g?.votingBody === 'council-only'
    ? `Liquid-staking fees, caps, LP parameters, the treasury destination and role reassignment are changed through a governance in which only the ${body.label} votes; MNDE holders ${g.config.community.canPropose ? 'cannot vote there' : 'cannot propose or vote there'}.`
    : `Liquid-staking configuration is controlled by ${body.label}: ${fee.note ?? 'voting configuration unresolved'}.`;
  const treasury = daoTreasuryControl(i, control);
  const tg = i.governance.governances.find(g => g.address === treasury?.governance);
  const realm = i.governance.realms.find(r => r.address === tg?.realm);
  const treasuryText = tg && realm ? `MNDE holders ${tg.config.community.vote.enabled ? 'vote' : 'cannot vote'} in the DAO treasury governance (${governanceThresholdText(tg, realm).replace('community tokens', 'MNDE')}).` : null;
  const overlap = i.governance.overlaps.find(o => o.realm === i.registry.governance.realm);
  return { fees, treasury: treasuryText, overlap: overlap ? `${overlap.count} of the ${overlap.signerCount} signers of the multisig that can upgrade the mSOL program ${overlap.count === 1 ? "is a current Marinade DAO council member" : "are current Marinade DAO council members"}.` : 'Council-member overlap is unresolved.' };
}

export function answerSection(i: SectionInputs, path: API.PathData, control: API.ControlData, parameters: API.ParametersData, participation: API.ParticipationData, programs: API.ProgramsData): API.AnswerData {
  const p = i.evidence.provenance.bind(i.evidence), field = (name: string) => parameters.rows.find(r => r.field === name)!;
  const feeControl = control.rows.find(r => r.instructions.includes('configMarinade'))!;
  const dao = control.controllers.find(c => c.id === feeControl.controllerId)!;
  const pauseControl = control.rows.find(r => r.instructions.includes('pause'))!;
  const pause = control.controllers.find(c => c.id === pauseControl.controllerId)!;
  const program = programs.rows.find(r => r.id === 'liquid-staking')!;
  const multisig = control.controllers.find(c => c.id === program.upgradeAuthority?.controllerId)!;
  const locked = participation.locking.find(m => m.id === 'locked-mnde')!;
  const deposited = participation.locking.find(m => m.id === 'deposited-mnde')!;
  const buybacks = path.links.filter(l => ['revenue-buyback', 'buyback-purchases', 'purchases-stakers'].includes(l.id));
  const statement = (id: string, text: string, source: unknown, status: API.AnswerData['statements'][number]['status'] = 'verified') => ({ id, text: text.trim().replace(/(\d+(?:\.\d+)?) %/g, (_, n) => `${Number(n).toFixed(2)} %`).replace(/\.?$/, '.'), status, ...p(source, status === 'claimed-only' ? 'claimed' : 'derived') });
  const purchase = buybacks.find(l => l.id === 'buyback-purchases')!;
  const buybackText = buybackAnswerText(i, purchase);
  const governanceAnswer = governanceAnswerText(i, control);
  const councils = control.controllers.filter(c => c.type === 'council-realm');
  const emergency = councils.find(c => c.realm?.name === 'Marinade DAO Emergency Council');
  const shared = emergency && sameCouncilMembers(dao, emergency);
  const mintRow = control.rows.find(r => r.id === `control:council-mint:${emergency?.realm?.address}`);
  const mintMapping = i.governance.mappings.find(m => m.target === 'Marinade DAO Emergency Council council mint authority');
  const seats = mintRow && mintMapping?.realm === dao.realm?.address && mintMapping?.votingBody === 'council-only';
  const distributionResult = claimResultText(i);
  return { question: QUESTION, shortAnswer: { status: answerStatus(path), text: `Program code routes the liquid-unstake LP treasury cut (${field('liqPool.treasuryCut').display} of the LP fee) and the stake-account withdrawal fee (${field('withdrawStakeAccountFee').display}) into the treasury mSOL account; the reward fee is ${field('rewardFee').display}. Moving treasury funds, buying MNDE and funding the distributor depend on account actions; ${distributionResult}. The Marinade DAO council (${dao.members?.length ?? 0} members) sets the fee route through its admin governance; MNDE holders cannot vote there.` },
    statements: [
      statement('fee-control', governanceAnswer.fees, [feeControl, dao]),
      ...(governanceAnswer.treasury ? [statement('treasury-voting', governanceAnswer.treasury, [daoTreasuryControl(i, control), i.governance])] : []),
      statement('reward-fee', `The reward fee is ${field('rewardFee').display}; this takes ${field('rewardFee').display} of staking rewards.`, field('rewardFee')),
      statement('lp-cut', `The treasury cut is ${field('liqPool.treasuryCut').display} of the liquid-unstake LP fee.`, field('liqPool.treasuryCut')),
      statement('locked-mnde', `${deposited.amount!.display} MNDE is deposited in VSR (${percent(i.participation.vsr.shareOfSupply.value)} of supply); ${locked.amount!.display} MNDE (${percent(locked.amount!.shareOfSupply ?? null)}) is under an active time lock`, [deposited, locked, participation.locking.find(m => m.id === 'locked-share-of-supply')]),
      statement('msol-upgrade', `The mSOL program can be upgraded by a ${multisig.threshold}-of-${multisig.members?.length} ${multisig.label}. ${governanceAnswer.overlap}`, [multisig, program, i.governance.overlaps]),
      statement('pause-control', `${pause.label} can pause and resume the liquid-staking program through the pause authority.`, [pause, pauseControl]),

      statement('buyback-route', buybackText, [buybacks, i.flows.buybacks, i.flows.distributorClaims], purchase.status),
      ...(shared ? [statement('shared-council-members', `The Marinade DAO council and the Marinade DAO Emergency Council have the same ${dao.members!.length} members.`, [dao, emergency])] : []),
      ...(seats ? [statement('emergency-council-seats', 'Seats of the Emergency Council are issued through a council-only Marinade DAO governance.', [mintRow, mintMapping])] : []),
    ], unknowns: [
      ...control.controllers.filter(c => c.type === 'unresolved').map(c => ({ id: `authority:${c.id}`, text: `${c.label}: signing controller remains unresolved.`, ...p(c, c.basis) })),
      ...path.links.filter(l => l.status === 'pending').map(l => ({ id: `path:${l.id}`, text: l.note, ...p(l, l.basis) })),
    ] };
}

export function buildSections(i: SectionInputs): API.BundleResponse {
  const control = controlSection(i), parameters = parametersSection(i, control), programs = programsSection(i, control);
  const participation = participationSection(i), claims = claimsSection(i), path = pathSection(i, parameters, control, claims), offsets = offsetsSection(i, programs);
  const answer = answerSection(i, path, control, parameters, participation, programs);
  const assumptions = unique([...i.layer.assumptions, ...i.participation.assumptions, ...i.authorities.assumptions, ...i.governance.assumptions, ...i.pack.ledger.notes]);
  const envelope = <K extends API.SectionId>(section: K, title: string, data: API.SectionData[K] | null, notes: string[] = [], extra: unknown = null): API.SectionEnvelope<API.SectionData[K]> => ({
    protocol: 'marinade', section, status: data === null ? 'pending' : 'ready', title, data, notes,
    assumptions: unique([...assumptions, ...i.holders.assumptions, ...i.flows.assumptions]),
    ...i.evidence.metadata(evidenceIds([data, extra])) });
  const bundle: API.BundleResponse = {
    answer: envelope('answer', 'Activity to MNDE holders', answer, [], path), path: envelope('path', 'Value path', path, ['Code-route statuses describe IDL declarations and decoded parameters under the carried assumptions; observed flows remain separate.']),
    control: envelope('control', 'Who can change it', control), offsets: envelope('offsets', 'Offsets', offsets), parameters: envelope('parameters', 'Liquid-staking parameters', parameters),
    programs: envelope('programs', 'Programs and activity', programs, ['Activity is the recorded newest-25 signature window, including failures. Upgrades include only successful observed upgrades in the authority layer’s bounded window; an empty list is not proof of no upgrades.']),
    participation: envelope('participation', 'MNDE participation', participation, ['Top lockers rank deposited MNDE, including unlocked deposits; time-locked totals are reported separately.']),
    claims: envelope('claims', 'Claims versus chain', claims), graph: envelope('graph', 'Tokenomics graph', null, [], [path, control, claims, holdersSection(i), participation]),
    holders: envelope('holders', 'Holders and float', holdersSection(i), i.holders.float.notes),
    flows: envelope('flows', 'Observed value flows', flowsSection(i), ['Bounded address samples; unavailable deltas are not zero.']),
  };
  const graph = buildTokenomicsGraph(bundle);
  bundle.graph.status = 'ready';
  bundle.graph.data = { source: 'local', configured: i.configured, host: null, reason: i.configured ? 'Neo4j has not been queried yet' : 'Neo4j is not configured',
    queries: TOKENOMICS_QUERIES.map(q => runTokenomicsLocal(graph, q.id)), subgraph: tokenomicsSubgraph(graph) };
  return bundle;
}

function windowOf(w: { oldestBlockTime: number | null; newestBlockTime: number | null }): [string, string] | null {
  return w.oldestBlockTime === null || w.newestBlockTime === null ? null : [iso(w.oldestBlockTime)!, iso(w.newestBlockTime)!];
}
export function flowsSection(i: SectionInputs): API.FlowsData {
  const f = i.flows, p = i.evidence.provenance.bind(i.evidence), window = windowOf(f.treasury.window);
  const positive = f.treasury.transactions.filter(t => t.deltaRaw !== null && BigInt(t.deltaRaw) > 0n);
  return {
    declaredRoutes: f.routes.flatMap(r => r.destinations.length ? r.destinations.flatMap(d => (d.resolutions.length ? d.resolutions : [null]).map((s, n) => ({
      id: `${r.program}:${r.instruction}:${d.account}:${n}`, program: r.program, instruction: r.instruction, account: d.account, address: s?.address ?? null,
      note: r.note, ...p([r, d, s], s ? ['declared', 'decoded'] : 'declared'),
    }))) : [{ id: `${r.program}:${r.instruction}:none`, program: r.program, instruction: r.instruction, account: 'No destination account declared', address: null, note: r.note, ...p(r, 'declared') }]),
    treasury: { inflows: window && f.treasury.transactions.some(t => t.deltaRaw !== null) ? { window, transactions: positive.length, amount: amount(f.treasury.inflowRaw.value, 'mSOL'),
      byInstruction: f.treasury.byInstruction.map(r => ({ instruction: r.instruction, amount: amount(r.inflowRaw, 'mSOL'),
        transactions: positive.filter(t => t.attribution.instruction === r.instruction).length })), ...p(f.treasury, 'observed') } : null,
      outflows: f.treasuryAuthority.transfers.filter(t => t.blockTime !== null).map(t => ({ time: iso(t.blockTime)!, to: { address: t.destination, label: t.destinationDetail.category, labelBasis: (['declared', 'decoded', 'observed', 'derived', 'claimed', 'reported', 'inferred'] as API.Basis[]).find(b => b === t.destinationDetail.categoryBasis) ?? 'observed' },
        amount: amount(t.amountRaw, i.registry.mints.find(m => m.address === t.mint)?.id === 'msol' ? 'mSOL' : i.registry.mints.find(m => m.address === t.mint)?.id === 'mnde' ? 'MNDE' : t.mint ?? 'unknown', t.decimals ?? 9),
        signature: t.signature, ...p(t, 'observed') })) },
    buybacks: (() => {
      const credits = creditsWithoutPayment(i);
      const months = (f.buybacks.months ?? []).map(m => ({ month: m.month, mndeBought: amount(m.mndeBoughtRaw.value), mndeSent: amount(m.mndeSentOutRaw.value),
        cost: m.costs.map(c => amount(c.raw, c.asset, c.decimals ?? 9)), recipients: m.recipients.length, shareToLockers: m.voterAuthorityShare.value,
        mndeCreditedWithoutPayment: amount(String(credits.byMonth.get(m.month)?.raw ?? 0n)), creditTransactions: credits.byMonth.get(m.month)?.transactions ?? 0, ...p(m, 'observed') }));
      for (const [month, v] of credits.byMonth) if (!months.some(m => m.month === month)) months.push({ month, mndeBought: amount('0'), mndeSent: amount('0'), cost: [], recipients: 0, shareToLockers: null,
        mndeCreditedWithoutPayment: amount(String(v.raw)), creditTransactions: v.transactions, ...p(credits.rows.filter(t => (t.blockTime === null ? 'unknown month' : iso(t.blockTime)!.slice(0, 7)) === month), 'observed') });
      months.sort((a, b) => a.month.localeCompare(b.month));
      return { months, creditPrograms: credits.programs };
    })(),
  };
}
export function holdersSection(i: SectionInputs): API.HoldersData {
  const h = i.holders, p = i.evidence.provenance.bind(i.evidence);
  function metrics(stats: typeof h.mnde | typeof h.msol, unit: string): API.Metric[] {
    const rows: API.Metric[] = Object.entries(stats).flatMap(([id, v]) => v && typeof v === 'object' && 'value' in v && 'evidenceIds' in v ? [{
      id, label: label(id), value: v.value === null ? 'unknown' : String(v.value), ...p(v, 'derived'),
      ...(/Raw$/.test(id) && typeof v.value === 'string' ? { amount: amount(v.value, unit) } : {}),
    }] : []);
    rows.push(...stats.topShares.map(s => ({ id: `top-${s.n}`, label: `Top ${s.n} share of supply`, value: String(s.share ?? 'unknown'),
      amount: { ...amount(s.amountRaw, unit), shareOfSupply: s.share }, ...p(s, 'derived') })));
    return rows;
  }
  const supply = BigInt(h.mnde.supplyRaw.value);
  const float = [...h.float.components.map(c => ({ id: `float:${c.name}`, label: c.name, value: c.raw,
    amount: { ...amount(c.raw), shareOfSupply: supply ? Number(BigInt(c.raw) * 1000000000000n / supply) / 1e12 : null }, ...p(c, c.basis) })),
    ...(['verifiedOnly', 'includingClaimed'] as const).map(id => ({ id: `float:${id}`, label: id === 'verifiedOnly' ? 'Float excluding verified custody' : 'Float also excluding claimed Labs treasury',
      value: h.float[id].raw, amount: { ...amount(h.float[id].raw), shareOfSupply: supply ? Number(BigInt(h.float[id].raw) * 1000000000000n / supply) / 1e12 : null }, note: h.float.notes.join(' '), ...p(h.float[id], 'derived') }))];
  return { mnde: { metrics: metrics(h.mnde, 'MNDE'), float, top: h.mnde.topOwners.map((r, n) => ({ rank: n + 1,
    owner: { address: r.owner, kind: r.classification.kind, label: r.classification.roleName, labelBasis: r.classification.roles[0]?.basis ?? null },
    role: r.classification.roles.map(role => `${role.name} (${role.basis})`).join('; ') || null,
    amount: { ...amount(r.amountRaw), shareOfSupply: r.shareOfSupply }, ...p([r, r.classification], ['decoded', ...r.classification.roles.map(role => role.basis)]) })) },
    msol: { metrics: metrics(h.msol, 'mSOL'), top: h.msol.top20.map((r, n) => ({ rank: n + 1, owner: { address: r.owner ?? r.address, kind: r.classification?.kind ?? 'unknown',
      label: r.roles[0]?.name ?? r.classification?.roleName ?? null, labelBasis: r.roles[0]?.basis ?? r.classification?.roles[0]?.basis ?? null },
      amount: { ...amount(r.amountRaw, 'mSOL'), shareOfSupply: r.shareOfSupply }, program: r.classification?.kind === 'program-owned' ? r.classification.ownerProgram : null,
      label: r.roles[0]?.name ?? r.classification?.roleName ?? null, ...p([r, r.classification], ['derived', ...r.roles.map(role => role.basis), ...(r.classification?.roles ?? []).map(role => role.basis)]) })),
      downstream: h.downstream.map(r => ({ entity: r.entity, label: r.label?.name ?? null, amount: { ...amount(r.msolHeldRaw, 'mSOL'), shareOfSupply: r.shareOfSupply }, accounts: r.accounts.length, ...p([r, r.label], r.label ? [r.basis, r.label.basis] : r.basis) })) } };
}

function applyFlowObservations(i: SectionInputs, path: API.PathData) {
  const f = i.flows, p = i.evidence.provenance.bind(i.evidence), treasury = flowsSection(i).treasury.inflows;
  for (const [id, instructions] of Object.entries({ 'rewards-treasury': ['updateActive', 'updateDeactivated'], 'lp-treasury': ['liquidUnstake'], 'withdraw-treasury': ['withdrawStakeAccount'] })) {
    const link = path.links.find(l => l.id === id)!;
    if (treasury) {
      const byInstruction = treasury.byInstruction!.filter(r => instructions.includes(r.instruction));
      link.observed = { ...treasury, byInstruction, amount: amount(byInstruction.reduce((s, r) => s + BigInt(r.amount.raw), 0n).toString(), 'mSOL'), transactions: byInstruction.reduce((s, r) => s + r.transactions, 0) };
      Object.assign(link, p([link, link.observed], ['declared', 'decoded', 'observed']));
    }
  }
  const window = windowOf(f.buybacks.window), purchases = f.buybacks.transactions.filter(t => BigInt(t.boughtRaw) > 0n);
  const bought = f.buybacks.months.reduce((s, m) => s + BigInt(m.mndeBoughtRaw.value), 0n);
  const purchase = path.links.find(l => l.id === 'buyback-purchases')!;
  if (window && f.buybacks.transactions.some(t => t.mndeDeltaRaw !== null)) {
    const purchaseTimes = purchases.flatMap(t => t.blockTime === null ? [] : [t.blockTime]);
    const purchaseWindow: [string, string] = purchaseTimes.length === purchases.length && purchaseTimes.length ? [iso(Math.min(...purchaseTimes))!, iso(Math.max(...purchaseTimes))!] : window;
    const credits = creditsWithoutPayment(i);
    purchase.observed = { window: credits.rows.length ? window : purchaseWindow, transactions: purchases.length + credits.rows.length, amount: amount(String(bought + credits.total)),
      byInstruction: [
        { instruction: 'Purchase with a same-transaction SOL or token payment', amount: amount(String(bought)), transactions: purchases.length },
        ...(credits.rows.length ? [{ instruction: `Credit through program ${credits.programs.join(', ')} without a same-transaction payment`, amount: amount(String(credits.total)), transactions: credits.rows.length }] : []),
      ], ...p([purchases, credits.rows, f.buybacks.months], 'observed') };
    purchase.status = bought + credits.total > 0n ? 'operated-by-accounts' : 'not-observed';
    purchase.note = 'Purchases: positive MNDE credits with same-transaction wallet spend. Credits without payment: MNDE credited through the listed program with no SOL or token payment in the same transaction; their cost is not observed in these transactions.';
    Object.assign(purchase, p([purchase.observed], 'observed'));
    // Keep actual recipients distinct from the claimed staker destination.
    const recipients = new Map<string, typeof f.buybacks.transactions>();
    for (const tx of f.buybacks.transactions) for (const r of tx.recipients) {
      const key = f.distributorClaims?.vaults.some(v => v.address === r.destination) ? r.destination : r.owner ?? r.destination; const rows = recipients.get(key) ?? [];
      if (!rows.includes(tx)) rows.push(tx); recipients.set(key, rows);
    }
    for (const [address, txs] of recipients) {
      const rows = txs.flatMap(t => t.recipients.filter(r => (f.distributorClaims?.vaults.some(v => v.address === r.destination) ? r.destination : r.owner ?? r.destination) === address)), first = rows[0];
      const vault = f.distributorClaims?.vaults.find(v => v.address === address);
      const program = vault?.program ?? first.classification?.owner;
      const logs = vault ? f.distributorClaims.instructionNameCounts.filter(n => n.program === vault.program) : [];
      const logLabel = logs.map(n => `${n.name} ×${n.count}`).join(', ');
      const recipientLabel = vault ? `Distributor vault; ${logLabel || 'no named instructions'} in program logs for ${program}` : first.category === 'DAO native treasury' ? 'DAO native treasury' : program ? `Account owned by program ${program}` : 'Observed recipient';
      const node = `buyback-recipient:${address}`;
      path.nodes.push({ id: node, label: recipientLabel, kind: 'account', address });
      const times = txs.flatMap(t => t.blockTime === null ? [] : [t.blockTime]);
      path.links.push({ id: node, from: 'buyback-wallet', to: node, mechanism: vault ? `${logLabel || 'No named instructions'} in program logs for ${program}` : 'Observed MNDE sent from buyback wallet', status: 'operated-by-accounts', parameters: [], claims: ['v6'], controlledBy: [],
        observed: { window: times.length === txs.length ? [iso(Math.min(...times))!, iso(Math.max(...times))!] : window, transactions: txs.length,
          amount: amount(String(rows.reduce((s, r) => s + BigInt(r.amountRaw), 0n))), ...p(txs, 'observed') }, note: vault ? 'The label reports program log names; names alone do not establish eligibility or instruction-level causality.' : 'Recipient ownership and category follow G5.', ...p([txs, vault, logs], 'observed') });
    }
  }
  const distribution = path.links.find(l => l.id === 'purchases-stakers')!;
  const claims = f.distributorClaims, claimWindow = claims && windowOf(claims.window);
  if (claims && claimWindow && BigInt(claims.totalClaimedRaw) > 0n) {
    const credits = claimCredits(i);
    distribution.status = 'operated-by-accounts';
    distribution.mechanism = 'Observed distributor vault claims';
    distribution.observed = { window: claimWindow, transactions: unique(credits.map(c => c.signature)).length,
      amount: amount(claims.totalClaimedRaw), claims: credits.length, voterAuthorityClaims: credits.filter(c => c.voterAuthority).length,
      distinctClaimants: claims.distinctClaimants, voterAuthorityClaimants: claims.voterAuthorityClaimants,
      claimantShare: claims.claimantShare, claimedAmountShare: claims.claimedAmountShare,
      voterAuthorityAmount: amount(claims.voterAuthorityClaimedRaw), ...p(claims, ['observed', 'derived']) };
    distribution.note = `${claimResultText(i)}; ${percent(claims.claimantShare)} of known claimants and ${percent(claims.claimedAmountShare)} of claimed MNDE match current VSR voter authorities. Who is eligible is defined off chain; current overlap does not establish historical eligibility or trace the purchased fungible tokens.`;
    Object.assign(distribution, p([distribution, claims], ['observed', 'derived']));
  } else {
    distribution.status = 'not-observed';
    distribution.note = 'No distributor claims to current VSR voter authorities are observed in the recorded sample; eligibility remains unresolved.';
  }
  const onward = path.links.find(l => l.id === 'treasury-onward')!;
  if (treasury) onward.observed = { ...treasury, amount: amount(f.treasury.outflowRaw.value, 'mSOL'), transactions: f.treasury.transactions.filter(t => t.deltaRaw !== null && BigInt(t.deltaRaw) < 0n).length, byInstruction: undefined };
  onward.note = 'Observed treasury mSOL debits in its captured window; onward transfers require account operation.';
  Object.assign(onward, p([onward, onward.observed], ['decoded', 'observed']));
  path.links.find(l => l.id === 'revenue-buyback')!.note = f.claims.find(c => c.id === 'v5')?.chainResult ?? 'Revenue allocation remains unresolved.';
}
