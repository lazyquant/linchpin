import type * as API from './api';
import type { readContractsLayer } from '../contracts/marinade';
import type { readParticipation } from '../contracts/participation';
import type { readAuthorities } from '../contracts/authorities';
import type { PackPacket, ControllerPath } from '../pack/model';
import type { PackRegistry } from '../pack/build';
import { deriveLiquidStakingAddresses } from '../pack/derive';
import { formatUnits } from '../chain/token-layout';
import { EvidenceIndex, evidenceIds, unique } from './evidence';
import type { OptionalLayer } from './build';

export type SectionInputs = {
  layer: Awaited<ReturnType<typeof readContractsLayer>>;
  participation: Awaited<ReturnType<typeof readParticipation>>;
  authorities: Awaited<ReturnType<typeof readAuthorities>>;
  pack: PackPacket; registry: PackRegistry; evidence: EvidenceIndex;
  docs: unknown; docsId: string; registryId: string; configured: boolean;
  optional: { holders: OptionalLayer<'holders'> | null; flows: OptionalLayer<'flows'> | null };
};
export const QUESTION = "Is there an enforceable path from Marinade's activity to MNDE holders, what offsets it, and who can change it?";
const amount = (raw: string, unit = 'MNDE', decimals = 9): API.Amount => ({ raw, decimals, display: formatUnits(BigInt(raw), decimals), unit });
const iso = (seconds: number | null): string | null => seconds === null ? null : new Date(seconds * 1000).toISOString();
const percent = (fraction: number | null) => fraction === null ? 'unknown' : `${Number((fraction * 100).toFixed(4))} %`;
const label = (field: string) => field.replaceAll('.', ' / ').replace(/([a-z])([A-Z])/g, '$1 $2');
const reference = (id: string) => ({ evidenceIds: [id] });
const controllerId = (address: string | null) => address === null ? 'controller:none' : `controller:${address}`;
const paramId = (field: string) => `liquid-staking:${field}`;
const treasury = (i: SectionInputs) => i.layer.authorities.find(a => a.field === 'treasuryMsolAccount')!;

export function controlSection(i: SectionInputs): API.ControlData {
  const p = i.evidence.provenance.bind(i.evidence);
  const controllers = new Map<string, API.Controller>();
  const derived = deriveLiquidStakingAddresses();
  const daoName = i.authorities.authorities.flatMap(a => a.resolutions).find(r => r.status === 'resolved' && 'realm' in r && r.realm === i.registry.governance.realm);
  const realmName = daoName && 'realmName' in daoName ? daoName.realmName : 'Marinade DAO';
  function resolve(address: string | null, source: unknown, kind?: string, path?: ControllerPath, name?: string): string {
    const id = controllerId(address);
    const existing = controllers.get(id);
    if (existing) { Object.assign(existing, p([existing, source], existing.basis)); return id; }
    const observed = i.authorities.authorities.find(a => a.address === address);
    const resolution = observed?.resolutions.find(r => r.status === 'resolved');
    let c: API.Controller = { id, address, type: 'unresolved', label: name ?? `Unresolved authority ${address}`, ...p([source, observed], 'decoded') };
    if (address === null) c = { ...c, type: 'none', label: 'No authority', note: 'Authority is absent in decoded state.' };
    else if (resolution?.status === 'resolved' && resolution.realm !== undefined && resolution.realmName !== undefined) {
      c = { ...c, type: resolution.realm === i.registry.governance.realm ? 'dao-governance' : 'council-realm',
        label: resolution.realmName, realm: { address: resolution.realm, name: resolution.realmName }, governance: resolution.governance,
        program: resolution.program, ...p([source, resolution], 'derived') };
    } else if (resolution?.status === 'resolved' && resolution.threshold !== undefined && resolution.owners !== undefined && resolution.layoutBasis !== undefined) {
      c = { ...c, type: 'multisig', label: resolution.derivation.kind === 'serum-multisig' ? 'Serum multisig' : 'Squads multisig',
        threshold: resolution.threshold, members: resolution.owners.map(o => ({ address: o.address })), program: resolution.program,
        note: `Controller account ${resolution.multisig}; layout basis: ${resolution.layoutBasis}. Member identities are not established.`,
        ...p([source, resolution], ['derived', 'decoded', resolution.layoutBasis]) };
    } else if (path?.path.includes(i.registry.governance.realm) || kind === 'dao-governance-account' || kind === 'native-treasury-pda') {
      const governance = kind === 'dao-governance-account' ? address : path?.path.at(-2);
      if (governance) c = { ...c, type: 'dao-governance', label: realmName!, realm: { address: i.registry.governance.realm, name: realmName! }, governance,
        program: i.registry.governance.program, ...p(source, 'derived') };
    } else if (derived.some(d => d.address === address)) {
      const d = derived.find(d => d.address === address)!;
      c = { ...c, type: 'program', label: `Liquid-staking program PDA (${d.seed})`, program: d.program,
        note: 'The liquid-staking program controls this PDA; its code is upgradeable through its upgrade controller.', ...p(source, 'derived') };
    } else if (kind === 'wallet' || kind === 'wallet-no-account') {
      c = { ...c, type: 'wallet', label: name ?? `Wallet ${address}`, note: 'Wallet address; operator identity is not established.' };
    }
    controllers.set(id, c); return id;
  }
  for (const path of i.pack.controllerPaths) resolve(path.authority, path, path.authorityKind, path);
  for (const a of i.layer.authorities.filter(a => ['adminAuthority', 'pauseAuthority', 'validatorSystem.managerAuthority', 'operationalSolAccount'].includes(a.field)))
    resolve(a.address, a, a.classification.kind, undefined, a.field === 'validatorSystem.managerAuthority' ? 'Validator manager wallet' : undefined);
  for (const a of i.participation.nativeProxy.authorities) resolve(a.address, a, undefined, undefined, `Native ${a.field} authority`);
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
      controllerId: resolve(path.authority, path, path.authorityKind, path), ...p(path, path.authorityKind.startsWith('pda') || path.authorityKind === 'native-treasury-pda' ? 'derived' : 'decoded') });
  }
  return { rows, controllers: [...controllers.values()] };
}

export function parametersSection(i: SectionInputs, control: API.ControlData): API.ParametersData {
  return { rows: i.layer.parameters.map(row => {
    let unit = row.unit, display = String(row.raw);
    if (unit === 'basis points') { unit = '%'; display = `${Number(row.raw) / 100} %`; }
    else if (unit === 'hundredths of a basis point') { unit = '%'; display = `${Number(row.raw) / 10000} %`; }
    else if (unit === 'lamports') { unit = 'SOL'; display = `${formatUnits(BigInt(String(row.raw)), 9)} SOL`; }
    else if (row.field === 'msolPrice') { unit = 'SOL per mSOL'; display = `${row.scaling!.solPerMsol} SOL per mSOL`; }
    const links = i.layer.parameterControl.links.filter(l => l.stateField === row.field);
    return { id: paramId(row.field), program: 'liquid-staking', field: row.field, label: label(row.field), value: String(row.raw), unit, display,
      setBy: links.flatMap(l => l.signers.filter(s => s.holder).map(s => ({ instruction: l.instruction, role: s.role, holder: { address: s.holder! },
        controllerId: control.controllers.find(c => c.id === controllerId(s.holder))?.id ?? null, basis: 'inferred' as const }))),
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
  for (const c of i.registry.valueRouteClaims.filter(c => c.id !== 'v1')) rows.push({ id: c.id, text: c.text, source: i.registry.sources[c.source] ?? c.source,
    status: 'claimed', chainResult: 'Flow verification is not available.', note: 'checked in G5', ...p([registry, docs], 'claimed') });
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
    { id: 'voting-weight', label: 'Voting weight', kind: 'mechanism' }, { id: 'dao-governance', label: 'Marinade DAO governance', kind: 'governance', address: i.registry.governance.realm },
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
  link('revenue-buyback', 'protocol-revenue', 'buyback-wallet', 'MIP-22 revenue allocation', 'claimed-only', [], [], ['v5'], 'MIP-22 buyback funding is a documentation claim until G5.', reference(i.registryId), 'claimed');
  link('buyback-purchases', 'buyback-wallet', 'mnde-purchases', 'Buy MNDE', 'pending', [], [], ['v5'], 'MNDE purchases have not been reconstructed; G5 is pending.', reference(i.registryId), 'claimed');
  link('purchases-stakers', 'mnde-purchases', 'mnde-stakers', 'Distribute MNDE to stakers', 'claimed-only', [], [], ['v6'], 'Distribution to MNDE stakers is a documentation claim until G5.', reference(i.registryId), 'claimed');
  const admin = control.controllers.find(c => c.id === controllerId(nodes.find(n => n.id === 'admin-authority')!.address!))!;
  const governanceEvidence = [i.layer.registrar, admin];
  link('lock-vote', 'vsr-locking', 'voting-weight', 'Registrar voting-weight configuration', 'enforced-by-code', [], [], [], 'Decoded registrar configures voting weight; the participation formula remains a derived estimate.', governanceEvidence, ['decoded', 'derived']);
  link('vote-governance', 'voting-weight', 'dao-governance', 'MNDE governance voting', 'enforced-by-code', [], [], [], 'Registrar binds the MNDE governing mint to the Marinade DAO realm.', governanceEvidence, ['decoded', 'derived']);
  link('governance-admin', 'dao-governance', 'admin-authority', 'Governance holds admin role', 'enforced-by-code', [], ['changeAuthority'], [], 'Admin authority resolves to the DAO governance through a reproduced PDA derivation.', governanceEvidence, 'derived');
  link('admin-fees', 'admin-authority', 'fee-parameters', 'Admin configures fees', 'enforced-by-code', ['rewardFee', 'liqPool.treasuryCut', 'delayedUnstakeFee', 'withdrawStakeAccountFee'], ['configMarinade', 'configLp'], [], 'IDL signer declarations and decoded admin role link governance to fee settings.', governanceEvidence, ['declared', 'decoded', 'derived']);
  return { nodes, links };
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
  rows.push({ id: 'holders-pending', label: 'Holder concentration and liquid float', amount: null, window: null, note: 'Pending G4 holder classification; no holder-based offset is quantified.', ...p(null, 'derived') });
  return { rows };
}

/** Inspect directed paths, rather than array order or the separate governance loop. */
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
export function answerSection(i: SectionInputs, path: API.PathData, control: API.ControlData, parameters: API.ParametersData, participation: API.ParticipationData, programs: API.ProgramsData): API.AnswerData {
  const p = i.evidence.provenance.bind(i.evidence), field = (name: string) => parameters.rows.find(r => r.field === name)!;
  const feeControl = control.rows.find(r => r.instructions.includes('configMarinade'))!;
  const dao = control.controllers.find(c => c.id === feeControl.controllerId)!;
  const pauseControl = control.rows.find(r => r.instructions.includes('pause'))!;
  const pause = control.controllers.find(c => c.id === pauseControl.controllerId)!;
  const program = programs.rows.find(r => r.id === 'liquid-staking')!;
  const multisig = control.controllers.find(c => c.id === program.upgradeAuthority?.controllerId)!;
  const locked = participation.locking.find(m => m.id === 'locked-mnde')!;
  const dormant = programs.rows.filter(r => r.activity.dormant);
  const buybacks = path.links.filter(l => ['revenue-buyback', 'buyback-purchases', 'purchases-stakers'].includes(l.id));
  const onward = path.links.find(l => l.id === 'treasury-onward')!;
  const treasuryOwner = control.rows.find(r => onward.controlledBy.includes(r.id))!;
  const routes = path.links.filter(l => l.to === 'treasury-msol' && l.status === 'enforced-by-code' && l.id !== 'rewards-treasury').map(l => l.id === 'lp-treasury' ? 'the LP treasury cut' : 'stake-account withdrawal fees');
  const statement = (id: string, text: string, source: unknown, status: API.AnswerData['statements'][number]['status'] = 'verified') => ({ id, text, status, ...p(source, status === 'claimed-only' ? 'claimed' : 'derived') });
  return { question: QUESTION, shortAnswer: { status: answerStatus(path), text: `Program code routes ${routes.join(' and ')} to the treasury mSOL account; moving value onward to MNDE holders requires actions by the treasury token-account owner (${treasuryOwner.holder.address}) and buyback operators.` },
    statements: [
      statement('fee-control', `${dao.realm?.name ?? dao.label} governance can change liquid-staking fees through the admin authority using configMarinade and configLp.`, [feeControl, dao, control.rows.filter(r => r.instructions.includes('configLp'))]),
      statement('reward-fee', `The reward fee is ${field('rewardFee').display}; this takes ${field('rewardFee').display} of staking rewards.`, field('rewardFee')),
      statement('lp-cut', `The treasury cut is ${field('liqPool.treasuryCut').display} of the liquid-unstake LP fee.`, field('liqPool.treasuryCut')),
      statement('locked-mnde', `${locked.amount!.display} MNDE is time-locked in VSR, representing ${percent(locked.amount!.shareOfSupply ?? null)} of the recorded supply.`, [locked, participation.locking.find(m => m.id === 'locked-share-of-supply')]),
      statement('msol-upgrade', `The mSOL program can be upgraded by a ${multisig.threshold}-of-${multisig.members?.length} ${multisig.label}, with ${multisig.members?.length} recorded members.`, [multisig, program]),
      statement('pause-control', `${pause.label} controls pause and resume through the pause authority.`, [pause, pauseControl]),
      statement('dormant-programs', dormant.length ? `${dormant.map(r => r.id).join(', ')} have no recorded address transactions for more than 30 days before capture.` : 'No measured program is dormant for more than 30 days before capture.', dormant),
      statement('buyback-route', 'The MIP-22 revenue-to-buyback and MNDE-to-staker routes remain claimed-only; MNDE purchases are pending G5 verification.', buybacks, 'claimed-only'),
    ], unknowns: [
      ...control.controllers.filter(c => c.type === 'unresolved').map(c => ({ id: `authority:${c.id}`, text: `${c.label}: signing controller remains unresolved.`, ...p(c, c.basis) })),
      ...path.links.filter(l => l.status === 'pending').map(l => ({ id: `path:${l.id}`, text: l.note, ...p(l, l.basis) })),
    ] };
}

export function graphSection(path: API.PathData, control: API.ControlData, configured: boolean): API.GraphData {
  const nodes: API.GraphData['subgraph']['nodes'] = path.nodes.map(n => ({ id: n.id, label: n.label, type: n.kind }));
  const edges: API.GraphData['subgraph']['edges'] = path.links.map(l => ({ id: l.id, from: l.from, to: l.to, type: 'FEEDS', basis: Array.isArray(l.basis) ? l.basis[0] : l.basis, label: `${l.mechanism}: ${l.status}` }));
  nodes.push(...control.controllers.map(c => ({ id: c.id, label: c.label, type: c.type })));
  for (const row of control.rows) {
    nodes.push({ id: row.id, label: row.target, type: row.targetKind });
    edges.push({ id: `controls:${row.id}`, from: row.controllerId, to: row.id, type: row.targetKind === 'program-code' ? 'UPGRADE_AUTHORITY' : 'CONTROLS', basis: Array.isArray(row.basis) ? row.basis[0] : row.basis, label: row.canChange });
  }
  for (const link of path.links) for (const row of link.controlledBy) edges.push({ id: `path-control:${link.id}:${row}`, from: row, to: link.to, type: 'SETS', basis: 'inferred', label: 'Control of route' });
  for (const c of control.controllers.filter(c => c.type === 'program')) {
    const program = control.rows.find(r => r.targetKind === 'program-code' && r.id === 'control:program:liquid-staking');
    if (program) edges.push({ id: `pda-code:${c.id}`, from: program.id, to: c.id, type: 'DERIVES', basis: 'derived', label: 'Program derives authority PDA' });
  }
  return { source: 'local', host: null, reason: 'Tokenomics Neo4j namespace and loader are not built yet.', configured, queries: [], subgraph: { nodes, edges } };
}

export function buildSections(i: SectionInputs): API.BundleResponse {
  const control = controlSection(i), parameters = parametersSection(i, control), programs = programsSection(i, control);
  const participation = participationSection(i), claims = claimsSection(i), path = pathSection(i, parameters, control, claims), offsets = offsetsSection(i, programs);
  const answer = answerSection(i, path, control, parameters, participation, programs), graph = graphSection(path, control, i.configured);
  const assumptions = unique([...i.layer.assumptions, ...i.participation.assumptions, ...i.authorities.assumptions, ...i.pack.ledger.notes]);
  const envelope = <K extends API.SectionId>(section: K, title: string, data: API.SectionData[K] | null, notes: string[] = [], extra: unknown = null): API.SectionEnvelope<API.SectionData[K]> => ({
    protocol: 'marinade', section, status: data === null ? 'pending' : 'ready', title, data, notes,
    assumptions: unique([...assumptions, ...(section === 'holders' ? i.optional.holders?.assumptions ?? [] : section === 'flows' ? i.optional.flows?.assumptions ?? [] : [])]),
    ...i.evidence.metadata(evidenceIds([data, extra])) });
  return {
    answer: envelope('answer', 'Activity to MNDE holders', answer, [], path), path: envelope('path', 'Value path', path, ['Code-route statuses describe IDL declarations and decoded parameters under the carried assumptions; observed flows remain separate.']),
    control: envelope('control', 'Who can change it', control), offsets: envelope('offsets', 'Offsets', offsets), parameters: envelope('parameters', 'Liquid-staking parameters', parameters),
    programs: envelope('programs', 'Programs and activity', programs, ['Activity is the recorded newest-25 signature window, including failures. Upgrades include only successful observed upgrades in the authority layer’s bounded window; an empty list is not proof of no upgrades.']),
    participation: envelope('participation', 'MNDE participation', participation, ['Top lockers rank deposited MNDE, including unlocked deposits; time-locked totals are reported separately.']),
    claims: envelope('claims', 'Claims versus chain', claims), graph: envelope('graph', 'Tokenomics graph', graph, [], [path, control]),
    holders: envelope('holders', 'Holders and float', i.optional.holders?.data ?? null, i.optional.holders?.notes ?? ['Pending G4: optional holders layer is absent.']),
    flows: envelope('flows', 'Observed value flows', i.optional.flows?.data ?? null, i.optional.flows?.notes ?? ['Pending G5: optional flows layer is absent.']),
  };
}
