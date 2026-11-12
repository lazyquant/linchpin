import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCapture, normalizeCapture, CaptureRejected, KVAULT_PROGRAM, KLEND_PROGRAM, identity, decodeProgramDataHead, isDecodeFailure,
  type KaminoCapture, type KaminoResult, type RpcRecord, type NamedQuantity } from '../adapters/kamino';
import { formatUnits } from '../chain/token-layout';
import { neo4jConfigFromEnv } from '../graph/neo4j';
import { buildTokenomicsGraph, tokenomicsQueries, TOKENOMICS_QUERIES, runTokenomicsLocal, tokenomicsSubgraph, type TokenomicsGraph, type GraphProfile, type DependencyEdge } from '../graph/tokenomics-neo4j';
import type { BundleResponse, SectionId, SectionData, SectionEnvelope, EvidenceRecord, ControlRow, Controller, ProgramRow, ParameterRow, ClaimRow, Basis } from './api';
import type { TokenomicsBuild } from './build';
import { EvidenceIndex, evidenceIds, unique } from './evidence';
import { PROTOCOL_VIEW } from './protocols';

export const KAMINO_CAPTURES_DIR = 'fixtures/kamino';
export const KAMINO_QUERY_IDS = ['who-can-change', 'upgrade-control', 'claims-vs-chain', 'vault-dependencies'];
export class KaminoProjectionError extends Error {
  constructor(readonly code: 'no-capture' | 'simulated-basis' | 'unsupported-basis' | 'unresolved-evidence' | 'capture-rejected', detail?: string) {
    super(`Kamino projection failed: ${code}${detail ? ` (${detail})` : ''}`); this.name = 'KaminoProjectionError';
  }
}
export type KaminoBuild = TokenomicsBuild & { graph: TokenomicsGraph; profile: GraphProfile };
type ProjectionInput = { capture: KaminoCapture; result: KaminoResult; directory: string };
export function latestKaminoCapture(root: string, dir = KAMINO_CAPTURES_DIR): ProjectionInput & { captureId: string; replayed: number } {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')); }
  catch (error) { throw new KaminoProjectionError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no-capture' : 'capture-rejected'); }
  if (!entries.length) throw new KaminoProjectionError('no-capture');
  const slots = new Set<string>();
  let replayed = 0;
  let latest: (ProjectionInput & { captureId: string }) | undefined;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const capture = loadCapture(join(root, dir, entry.name)), result = normalizeCapture(capture);
      replayed += capture.manifest.records.length;
      const slot = result.report.stateSlot;
      if (slot === null || slots.has(BigInt(slot).toString())) throw new KaminoProjectionError('capture-rejected');
      slots.add(BigInt(slot).toString());
      if (!latest || BigInt(slot) > BigInt(latest.result.report.stateSlot!)) latest = { captureId: capture.manifest.captureId, capture, result, directory: `${dir}/${entry.name}` };
    } catch (error) {
      if (error instanceof KaminoProjectionError) throw error;
      throw new KaminoProjectionError('capture-rejected', error instanceof CaptureRejected ? error.code : undefined);
    }
  }
  return { ...latest!, replayed };
}
const address = (id: string) => id.startsWith('solana:mainnet-beta:') ? id.slice('solana:mainnet-beta:'.length) : id;
const words = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

/** Project only captured mechanics; no reads or writes occur here. */
export function projectKamino({ capture, result }: ProjectionInput): KaminoBuild {
  const { facts, receipts } = result.snapshot;
  for (const fact of facts) {
    if (fact.basis === 'simulated') throw new KaminoProjectionError('simulated-basis');
    if (!['decoded', 'derived', 'claimed', 'observed', 'unknown'].includes(fact.basis)) throw new KaminoProjectionError('unsupported-basis');
  }
  for (const quantity of [...result.mechanics.quantities, ...result.report.quantities])
    if (!['decoded', 'derived', 'reported'].includes(quantity.basis)) throw new KaminoProjectionError('unsupported-basis');
  const records: EvidenceRecord[] = receipts.map(receipt => {
    const parsed = /^kamino-capture:([A-Za-z0-9-]+)\/([a-z0-9-]+\.json)(?:#(.+))?$/.exec(receipt.source);
    if (!parsed || parsed[1] !== capture.manifest.captureId) throw new KaminoProjectionError('unresolved-evidence');
    const [, , file, key] = parsed, record = capture.records[file];
    if (!record) throw new KaminoProjectionError('unresolved-evidence');
    return { id: receipt.id, method: record.kind === 'rpc' ? 'getMultipleAccounts' : 'httpCapture',
      params: record.kind === 'rpc' ? { file, key: key ?? null } : { file, host: record.host, path: record.path },
      slot: record.kind === 'rpc' && receipt.observation.blockOrSlot !== null ? Number(receipt.observation.blockOrSlot) : null,
      retrievedAt: receipt.observation.retrievedAt, responseSha256: receipt.responseSha256, source: 'fixture',
      fixture: `${KAMINO_CAPTURES_DIR}/${capture.manifest.captureId}/${file}` };
  });
  const evidence = new EvidenceIndex(records);
  const provenance = (ids: string[], basis: Basis | Basis[] = 'decoded') => {
    if (!ids.length || evidence.lookup(ids).missing.length) throw new KaminoProjectionError('unresolved-evidence');
    return evidence.provenance({ evidenceIds: ids }, basis);
  };
  const entities = new Map(result.mechanics.entities.map(e => [e.id, e]));
  const find = (subject: string, predicate: string) => facts.find(f => f.subject === subject && f.predicate === predicate);
  const programLabel = (id: string) => address(id) === KLEND_PROGRAM ? 'Lending program (klend)' : address(id) === KVAULT_PROGRAM ? 'Vault program (kVault)'
    : facts.some(f => f.predicate === 'OWNER_PROGRAM' && f.object === id && entities.get(f.subject)?.kind === 'OracleSource') ? 'Oracle owner program' : 'Program';
  const roles = ['VAULT_ADMIN', 'ALLOCATION_ADMIN', 'MARKET_OWNER', 'UPGRADE_AUTHORITY'];
  const roleFacts = facts.filter(f => roles.includes(f.predicate)).sort((a, b) => roles.indexOf(a.predicate) - roles.indexOf(b.predicate) || a.subject.localeCompare(b.subject));
  const controllers: Controller[] = unique(roleFacts.map(f => f.object)).map(id => {
    const supporting = roleFacts.filter(f => f.object === id).flatMap(f => f.evidenceIds);
    if (id === 'none') return { id: 'controller:none', type: 'none', address: null, label: 'No upgrade authority', ...provenance(supporting) };
    const key = address(id), entity = entities.get(id);
    if (entity?.controllerType === 'squads-v4-multisig') {
      const threshold = find(id, 'MULTISIG_THRESHOLD'), members = facts.filter(f => f.subject === id && f.predicate === 'MULTISIG_MEMBER');
      if (!threshold || !/^amount:\d+$/.test(threshold.object)) throw new KaminoProjectionError('capture-rejected');
      return { id: `controller:${key}`, type: 'multisig', address: key, label: key, threshold: `${threshold.object.slice(7)} of ${members.length}`,
        members: members.map(f => ({ address: address(f.object), label: null })), ...provenance([...(threshold.evidenceIds), ...members.flatMap(f => f.evidenceIds)]) };
    }
    return { id: `controller:${key}`, type: 'unresolved', address: key, label: key,
      note: 'Account does not decode as a known controller; controller type not established.', ...provenance(find(id, 'CONTROLLED_BY')?.evidenceIds ?? entity?.evidenceIds ?? supporting) };
  });
  const rows: ControlRow[] = roleFacts.map(f => {
    const key = address(f.subject);
    const mapping = f.predicate === 'VAULT_ADMIN' ? ['vault-admin', 'Vault administration', 'vaultAdminAuthority', 'vault']
      : f.predicate === 'ALLOCATION_ADMIN' ? ['allocation-admin', 'Vault allocations', 'allocationAdmin', 'vault']
      : f.predicate === 'MARKET_OWNER' ? ['market-owner', 'Lending market settings', 'lendingMarketOwner', 'lending market']
      : ['program', `${programLabel(f.subject)} code`, 'upgradeAuthority', 'programdata'];
    return { id: `control:${mapping[0]}:${key}`, target: mapping[1], targetKind: f.predicate === 'UPGRADE_AUTHORITY' ? 'program-code' : 'role',
      role: mapping[2], canChange: `Role recorded in decoded ${mapping[3]} state; the instructions it can sign are not captured.`, instructions: [],
      holder: { address: address(f.object), label: null }, controllerId: `controller:${address(f.object)}`, ...provenance(f.evidenceIds) };
  });
  const programRecord = capture.records['rpc-programs.json'] as RpcRecord;
  const programs: ProgramRow[] = result.mechanics.entities.filter(e => e.kind === 'Program').sort((a, b) => a.id.localeCompare(b.id)).map(e => {
    const data = find(e.id, 'PROGRAM_DATA'), authority = find(e.id, 'UPGRADE_AUTHORITY');
    const accountIndex = data ? programRecord.params[0].indexOf(address(data.object)) : -1;
    const head = decodeProgramDataHead(programRecord.response.value?.[accountIndex]);
    return { id: address(e.id), address: address(e.id), idl: null, upgradeable: !!authority && authority.object !== 'none',
      upgradeAuthority: authority && authority.object !== 'none' ? { address: address(authority.object), label: null, controllerId: `controller:${address(authority.object)}` } : null,
      lastDeploySlot: isDecodeFailure(head) ? null : Number(head.slot), activity: { newest: null, oldestInWindow: null, txPerDay: null, dormant: null }, upgrades: [],
      ...provenance([...(data?.evidenceIds ?? []), ...(authority?.evidenceIds ?? [])]) };
  });
  const vaultFields = ['performanceFeeBps', 'managementFeeBps', 'withdrawalPenaltyBps', 'withdrawalPenaltyLamports', 'minWithdrawAmount', 'unallocatedWeight', 'unallocatedTokensCap'];
  const reserveFields = ['protocolTakeRatePct', 'withdrawalCapCapacity', 'vaultTargetWeight'];
  const names = [...vaultFields.map(f => `vault.${f}`), ...facts.filter(f => f.predicate === 'ALLOCATES_TO').sort((a, b) => a.object.localeCompare(b.object)).flatMap(f => reserveFields.map(field => `reserve.${address(f.object)}.${field}`))];
  const quantities = new Map(result.mechanics.quantities.filter(q => q.basis === 'decoded').map(q => [q.name, q]));
  function parameter(q: NamedQuantity): ParameterRow {
    // The withdrawal floor is denominated in the deposit token despite the
    // field's historical suffix. Its mint and scale come from decoded vault state.
    if (q.name === 'vault.withdrawalPenaltyLamports') {
      const token = quantities.get('vault.minWithdrawAmount');
      if (!token || token.subject !== q.subject || token.unit !== 'token-base-units' || !token.mint || token.decimals === null)
        throw new KaminoProjectionError('capture-rejected');
      q = { ...q, unit: 'token-base-units', mint: token.mint, decimals: token.decimals,
        evidenceIds: unique([...q.evidenceIds, ...token.evidenceIds]) };
    }
    const field = q.name.split('.').at(-1)!;
    let display = q.value, unit: string = q.unit;
    if (q.unit === 'bps') { unit = '%'; display = `${Number(q.value) / 100}%`; }
    else if (q.unit === 'pct') { unit = '%'; display = `${q.value}%`; }
    else if (q.unit === 'lamports') { unit = 'SOL'; display = `${formatUnits(BigInt(q.value), 9)} SOL`; }
    else if (q.unit === 'token-base-units') { unit = q.mint === identity(capture.manifest.target.tokenMint) ? 'PYUSD' : address(q.mint!); display = `${formatUnits(BigInt(q.value), q.decimals!)} ${unit}`; }
    if (field === 'withdrawalCapCapacity') display += ` per ${q.window}`;
    return { id: q.name, program: address(find(q.subject, 'OWNER_PROGRAM')?.object ?? ''), field,
      label: `${q.name.startsWith('vault.') ? 'Vault' : `Reserve ${address(q.subject)}`} ${words(field)}`, value: q.value, display, unit, setBy: [], ...provenance(q.evidenceIds) };
  }
  const parameters = names.flatMap(name => quantities.has(name) ? [parameter(quantities.get(name)!)] : []);
  const claims: ClaimRow[] = result.report.claims.flatMap(view => {
    if (!view.claim) return [];
    const idle = result.mechanics.quantities.find(q => q.name === view.observedQuantity && q.basis === 'derived');
    const observed = idle ? `Observed idle share ${idle.value} ppm (${Number(idle.value) / 10000}%) as of slot ${idle.asOfSlot}, state read at slot ${result.report.stateSlot}` : 'Observed idle share is not mapped';
    return [{ id: view.id, text: view.claim.text, source: 'kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals.md', status: 'unresolved',
      chainResult: `${observed}; the documentation states ${view.claim.lowPpm / 10000}–${view.claim.highPpm / 10000}%. Scope: ${view.scope}.`,
      note: `Comparison result: ${view.result}.`, ...provenance([...view.claimEvidenceIds, ...view.observationEvidenceIds], ['claimed', 'derived']) }];
  });
  const captureNote = `Projected from Kamino capture ${capture.manifest.captureId}, state slot ${result.report.stateSlot}.`;
  function envelope<K extends SectionId>(section: K, title: string, data: SectionData[K] | null, notes: string[] = []): SectionEnvelope<SectionData[K]> {
    return { protocol: 'kamino', section, status: data === null ? 'pending' : 'ready', title,
      ...(data === null ? { asOf: null, slotRange: null, evidenceCount: 0 } : evidence.metadata(evidenceIds(data))), assumptions: [], notes: data === null ? notes : [captureNote, ...notes], data };
  }
  const omittedReasons: Record<string, string> = { 'path-to-holders': 'value routes', 'parameter-control': 'the instructions that set parameters', 'supply-control': 'mint authorities', 'who-votes-where': 'governance', 'holders-and-float': 'holders' };
  const bundle: BundleResponse = {
    answer: envelope('answer', 'Coverage', null, [PROTOCOL_VIEW.kamino.coverage!, 'Ask a question, or open Control, Programs, Parameters, Claims or Graph; answers cite the mapped facts. Mechanics that are not mapped are reported as not mapped, not as absent.']),
    path: envelope('path', 'Value routes', null, ['Not mapped in this capture: where fees and value route. No fee-destination, treasury or distribution account was captured. Vault-to-reserve allocation is a dependency, not a value route, and is in Graph.']),
    control: envelope('control', 'Who can change it', { rows, controllers }),
    offsets: envelope('offsets', 'Offsets', null, ['Not mapped in this capture: treasury, emissions and outflows.']),
    parameters: envelope('parameters', 'Vault and reserve parameters', { rows: parameters }),
    programs: envelope('programs', 'Programs', { rows: programs }, ['No signature or upgrade history is captured for Kamino; an empty list is not evidence of no upgrades.']),
    participation: envelope('participation', 'Participation', null, ['Not mapped in this capture: KMNO locking, staking and voting.']),
    holders: envelope('holders', 'Holders', null, ["Not mapped in this capture: KMNO and kVault-share holders. The shares mint's supply is a supply, not a holder list."]),
    flows: envelope('flows', 'Flows', null, ['Not mapped in this capture: transactions. No transaction window was captured.']),
    claims: envelope('claims', 'Claims versus chain', { rows: claims }, ['The two API-versus-chain cross-checks are not projected in this slice.']),
    graph: envelope('graph', 'Tokenomics graph', null),
  };
  function dependencyNode(id: string): DependencyEdge['from'] {
    const entity = entities.get(id);
    const prefixes = { Vault: 'vault', Reserve: 'reserve', Market: 'market', OracleSource: 'oracle' };
    if (!entity || !Object.hasOwn(prefixes, entity.kind)) throw new KaminoProjectionError('capture-rejected');
    const type = entity.kind as keyof typeof prefixes;
    return { id: `${prefixes[type]}:${address(id)}`, type, address: address(id) };
  }
  const profile: GraphProfile = { namespace: 'TGKamino', mints: [],
    dependencies: result.mechanics.relations.filter(r => ['ALLOCATES_TO', 'IN_MARKET', 'PRICED_BY'].includes(r.kind)).map(r => ({ type: r.kind as DependencyEdge['type'], from: dependencyNode(r.from), to: dependencyNode(r.to), provenance: provenance(r.evidenceIds) })),
    targetFor: row => row.id.startsWith('control:vault-admin:') || row.id.startsWith('control:allocation-admin:') ? `vault:${row.id.split(':').at(-1)}` : row.id.startsWith('control:market-owner:') ? `market:${row.id.split(':').at(-1)}` : null };
  const graph = buildTokenomicsGraph(bundle, profile), queries = tokenomicsQueries(profile.namespace, KAMINO_QUERY_IDS), configured = !!neo4jConfigFromEnv();
  bundle.graph = envelope('graph', 'Tokenomics graph', { source: 'local', configured, host: null, reason: configured ? 'Neo4j has not been queried yet' : 'Neo4j is not configured',
    queries: queries.map(q => runTokenomicsLocal(graph, q.id, queries)), subgraph: tokenomicsSubgraph(graph) },
    TOKENOMICS_QUERIES.filter(q => omittedReasons[q.id]).map(q => `Query ${q.id} (${q.title}) is omitted: ${omittedReasons[q.id]} are not mapped in this capture.`));
  // Graph presentation rows omit citations; its envelope still dates the complete index.
  Object.assign(bundle.graph, evidence.metadata(evidenceIds(graph)));
  if (evidence.lookup(evidenceIds(bundle)).missing.length) throw new KaminoProjectionError('unresolved-evidence');
  return { bundle, evidence, graph, profile, buildMs: 0, reads: { live: 0, replayed: 0, retries: 0 } };
}
export function buildKaminoTokenomics(options: { root: string; capturesDir?: string }): KaminoBuild {
  const selected = latestKaminoCapture(options.root, options.capturesDir);
  const built = projectKamino(selected);
  built.reads.replayed = selected.replayed;
  return built;
}
