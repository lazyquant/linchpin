import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RecordingRpc } from '../chain/rpc';
import { canonical, fixtureKey, sha256, type Evidence } from '../chain/evidence';
import { runOptions } from '../config';
import { readContractsLayer, type ContractsInput } from '../contracts/marinade';
import { readParticipation } from '../contracts/participation';
import { readAuthorities } from '../contracts/authorities';
import { readHolders, validateLabels } from '../contracts/holders';
import { readFlows, type DocsCapture } from '../contracts/flows';
import type { PackFile, PackRegistry } from '../pack/build';
import type { PackPacket } from '../pack/model';
import { neo4jConfigFromEnv } from '../graph/neo4j';
import type { EvidenceRecord } from './api';
import { EvidenceIndex } from './evidence';
import { buildSections, type SectionInputs } from './sections';

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
  const docs = json<DocsCapture>(packFile.docsCapture);
  const labelsDir = 'packs/marinade/sources/labels';
  const labelFiles = existsSync(join(root, labelsDir)) ? readdirSync(join(root, labelsDir)).filter(f => f.endsWith('.json')).sort().map(f => `${labelsDir}/${f}`) : [];
  const labels = labelFiles.map(f => validateLabels(json(f)));
  const holders = await readHolders(rpc, registry, layer, participation, authorities, labels);
  const flows = await readFlows(rpc, registry, layer, participation, holders, docs, pack.ledger);
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
  const document = (fixture: string, retrievedAt: string) => {
    const responseSha256 = sha256(readFileSync(join(root, fixture)));
    const method = 'documentationCapture', params = { file: fixture };
    const id = sha256(`${method}${canonical(params)}${responseSha256}`);
    records.push({ id, method, params, slot: null, retrievedAt, responseSha256, source: 'fixture', fixture });
    return id;
  };
  const docsId = document(packFile.docsCapture, docs.retrievedAt);
  const registryId = document('packs/marinade/registry.json', registry.retrievedAt);
  const aliases = new Map<string, string[]>([
    [`registry:${sha256(canonical(registry))}`, [registryId]],
    [`docs:${sha256(canonical(docs))}`, [docsId]],
    [`ledger:${sha256(canonical(pack.ledger))}`, packResult.evidence.map(e => e.id)],
  ]);
  labels.forEach((file, n) => aliases.set(`labels:${sha256(canonical(file))}`, [document(labelFiles[n], file.retrievedAt)]));
  const evidence = new EvidenceIndex(records, aliases);
  const inputs: SectionInputs = { layer, participation, authorities, pack, registry, evidence, docs, docsId, registryId,
    holders, flows, configured: !!neo4jConfigFromEnv() };
  const bundle = buildSections(inputs);
  return { bundle, evidence, buildMs: performance.now() - started, reads: rpc.counts };
}
export type TokenomicsBuild = Awaited<ReturnType<typeof buildTokenomics>>;
