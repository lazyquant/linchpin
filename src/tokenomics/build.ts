import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RecordingRpc } from '../chain/rpc';
import { canonical, fixtureKey, sha256, type Evidence } from '../chain/evidence';
import { runOptions } from '../config';
import { readContractsLayer, type ContractsInput } from '../contracts/marinade';
import { readParticipation } from '../contracts/participation';
import { readAuthorities } from '../contracts/authorities';
import type { PackFile, PackRegistry } from '../pack/build';
import type { PackPacket } from '../pack/model';
import { neo4jConfigFromEnv } from '../graph/neo4j';
import type { EvidenceRecord, SectionData } from './api';
import { EvidenceIndex } from './evidence';
import { buildSections, type SectionInputs } from './sections';

export type OptionalLayer<K extends 'holders' | 'flows'> = { data: SectionData[K]; evidence: Evidence[]; assumptions: string[]; notes?: string[] };
/** Optional modules can export this adapter without coupling the stable API to their internal data model. */
export type OptionalLayerReader<K extends 'holders' | 'flows'> = (context: {
  rpc: RecordingRpc; registry: PackRegistry; contracts: ContractsInput;
  layer: SectionInputs['layer']; participation: SectionInputs['participation']; authorities: SectionInputs['authorities']; pack: PackPacket;
}) => Promise<OptionalLayer<K>>;

export async function buildTokenomics({ root, packResult }: { root: string; packResult: { packet: PackPacket | unknown; evidence: Evidence[] } }) {
  const started = performance.now();
  const pack = packResult.packet as PackPacket;
  if (pack.pack !== 'marinade' || !pack.offline || !pack.controllerPaths || !pack.ledger || packResult.evidence.some(e => e.source !== 'fixture'))
    throw new Error('Tokenomics requires the captured offline Marinade pack result');
  const json = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const registry = json<PackRegistry>('packs/marinade/registry.json');
  const contracts = json<ContractsInput>('packs/marinade/contracts.json');
  const packFile = json<PackFile>('packs/marinade/pack.json');
  const opts = runOptions({ offline: true, record: false, refresh: false, rpcUrl: 'http://127.0.0.1:1',
    fixturesDir: join(root, 'fixtures'), outDir: join(root, 'out'), minIntervalMs: 0, requestTimeoutMs: 1000 });
  Object.freeze(opts);
  const rpc = new RecordingRpc(opts, 'marinade-contracts', { onRead(e) {
    if (e.source !== 'fixture') throw new Error('Tokenomics attempted a live read');
  } });
  // Fail before a request is sent even if a future layer bypasses RecordingRpc replay.
  Object.defineProperty(rpc, 'connection', { value: new Proxy(rpc.connection, { get() { throw new Error('Tokenomics attempted a live read'); } }) });
  const layer = await readContractsLayer(rpc, registry, contracts);
  const participation = await readParticipation(rpc, registry, contracts, layer);
  const authorities = await readAuthorities(rpc, registry, layer);
  const optional: { holders: OptionalLayer<'holders'> | null; flows: OptionalLayer<'flows'> | null } = { holders: null, flows: null };
  for (const name of ['holders', 'flows'] as const) {
    const file = join(root, 'src/contracts', `${name}.ts`);
    if (!existsSync(file)) continue;
    const module = await import(pathToFileURL(file).href);
    if (typeof module.buildTokenomicsSection !== 'function') throw new Error(`Optional ${name} layer has no tokenomics adapter`);
    const value = await (module.buildTokenomicsSection as OptionalLayerReader<typeof name>)({ rpc, registry, contracts, layer, participation, authorities, pack });
    // Assignment keeps the runtime discriminator paired with its corresponding section shape.
    Object.assign(optional, { [name]: value });
  }
  if (rpc.counts.live || rpc.evidence.some(e => e.source !== 'fixture')) throw new Error('Tokenomics attempted a live read');
  const records: EvidenceRecord[] = [];
  function add(reads: Evidence[], directory: string) {
    for (const e of reads) {
      if (e.source !== 'fixture') throw new Error('Tokenomics requires fixture evidence');
      const base = `fixtures/${directory}/${fixtureKey(e.method, e.params)}.json`;
      const fixture = existsSync(join(root, base)) ? base : existsSync(join(root, `${base}.gz`)) ? `${base}.gz` : null;
      if (!fixture) throw new Error('Tokenomics evidence fixture is missing');
      // Explicit allowlist: rpcUrl and any future recorder configuration never leave the backend.
      records.push({ id: e.id, method: e.method, params: e.params, slot: e.slot, retrievedAt: e.retrievedAt, responseSha256: e.responseSha256, source: 'fixture', fixture });
    }
  }
  add(packResult.evidence, 'marinade-pack'); add(rpc.evidence, 'marinade-contracts');
  for (const value of Object.values(optional)) if (value) add(value.evidence, 'marinade-contracts');
  const document = (fixture: string, retrievedAt: string) => {
    const responseSha256 = sha256(readFileSync(join(root, fixture)));
    const method = 'documentationCapture', params = { file: fixture };
    const id = sha256(`${method}${canonical(params)}${responseSha256}`);
    records.push({ id, method, params, slot: null, retrievedAt, responseSha256, source: 'fixture', fixture });
    return id;
  };
  const docs = json<{ retrievedAt: string; [key: string]: unknown }>(packFile.docsCapture);
  const docsId = document(packFile.docsCapture, docs.retrievedAt);
  const registryId = document('packs/marinade/registry.json', registry.retrievedAt);
  const evidence = new EvidenceIndex(records);
  const inputs: SectionInputs = { layer, participation, authorities, pack, registry, evidence, docs, docsId, registryId,
    optional, configured: !!neo4jConfigFromEnv() };
  const bundle = buildSections(inputs);
  return { bundle, evidence, buildMs: performance.now() - started, reads: rpc.counts };
}
export type TokenomicsBuild = Awaited<ReturnType<typeof buildTokenomics>>;
