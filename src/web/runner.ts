import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { runOptions } from '../config';
import { RecordingRpc, redactedRpcUrl } from '../chain/rpc';
import { loadCase } from '../governance/claims';
import { readProposalBundle } from '../governance/reader';
import { reviewBundle } from '../cli';
import { buildPack, type PackFile, type PackRegistry, type DocsCapture } from '../pack/build';
import { CASES, present, type CaseId, type Result } from './model';

export type Event = { at: string; message: string; evidenceCount?: number; liveReads?: number; replayedReads?: number };
export type Run = { id: string; caseId: CaseId; source?: 'captured' | 'live'; rpcHost?: string | null; status: 'running' | 'completed' | 'failed'; events: Event[]; error?: string };
export type PipelineOptions = { source?: 'captured' | 'live'; outDir?: string; signal?: AbortSignal };
export const ROOT = resolve(import.meta.dir, '../..');
const json = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const stringify = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
let lastRefresh = 0;
export function liveDirectory(caseId: CaseId) {
  lastRefresh = Math.max(Date.now(), lastRefresh + 1);
  return join(ROOT, 'out/web', caseId, 'live', new Date(lastRefresh).toISOString().replace(/[:.]/g, '-'));
}
export function saveResult(result: Result, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'packet.json'), stringify(result.packet));
  writeFileSync(join(outDir, 'graph.json'), stringify(result.view.graph));
  writeFileSync(join(outDir, 'evidence.jsonl'), result.evidence.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(outDir, 'memo.md'), result.view.memo);
}

export async function runPipeline(caseId: CaseId, emit: (event: Event) => void = () => {}, options: PipelineOptions = {}): Promise<Result> {
  const scope = CASES.find(c => c.id === caseId);
  if (!scope) throw new Error('Unknown research case');
  const live = options.source === 'live';
  const outDir = options.outDir ?? (live ? liveDirectory(caseId) : join(ROOT, 'out/web', caseId));
  const opts = live ? runOptions({ offline: false, record: true, refresh: true, fixturesDir: join(outDir, 'fixtures'), outDir })
    : runOptions({ offline: true, record: false, refresh: false, rpcUrl: 'http://127.0.0.1:1', fixturesDir: join(ROOT, 'fixtures'), outDir });
  let ledgerRpc: RecordingRpc | undefined;
  const event = (message: string) => emit({ at: new Date().toISOString(), message, evidenceCount: rpc.evidence.length + (ledgerRpc?.evidence.length ?? 0), liveReads: rpc.counts.live, replayedReads: rpc.counts.replayed + (ledgerRpc?.counts.replayed ?? 0) });
  const rpc = new RecordingRpc(opts, caseId === 'marinade' ? 'marinade-pack' : caseId, { signal: options.signal, onRead: live ? e => event(`Read ${e.method} · slot ${e.slot ?? 'not supplied'}.`) : undefined });
  event(live ? `Opened the fixed case specification. Reading ${redactedRpcUrl(opts.rpcUrl)}; live evidence is isolated from committed fixtures.` : 'Opened the fixed case specification. Recorded fixtures only; no network reads.');
  let packet;
  if (caseId === 'marinade') {
    const config = json(scope.file) as PackFile;
    const registry = json(config.registry) as PackRegistry;
    if (live) ledgerRpc = new RecordingRpc(runOptions({ offline: true, record: false, refresh: false, rpcUrl: 'http://127.0.0.1:1', fixturesDir: join(ROOT, 'fixtures'), outDir }), 'marinade-pack', { signal: options.signal });
    event(`Loaded documented claims and the declared program, mint and account boundary.${live ? ' Control, supply, governance list and treasury state are live; the proposal ledger replays committed fixtures.' : ''}`);
    packet = await buildPack(rpc, registry, { title: config.title, docsCapture: json(config.docsCapture) as DocsCapture, burns: config.burns, ledger: config.ledger, ledgerRpc });
    event(`Resolved control and supply checks; reconstructed ${packet.ledger.entries.length} treasury rows from ${packet.ledger.proposalsScanned} proposals${live ? ' using the offline ledger' : ''}.`);
  } else {
    const spec = loadCase(join(ROOT, scope.file));
    const bundle = await readProposalBundle(rpc, new PublicKey(spec.programId), spec.programVersion, new PublicKey(spec.proposal));
    event(`Read proposal accounts and ${bundle.transactions.length} transaction payloads from ${live ? 'the configured endpoint' : 'recorded responses'}.`);
    packet = await reviewBundle(spec, rpc, bundle);
    event(`Decoded effects, ${live ? 'ran' : 'replayed'} conditional simulations and reconciled ${packet.observed.receipts.length} execution receipts.`);
  }
  options.signal?.throwIfAborted();
  if (!live && rpc.counts.live !== 0) throw new Error('Offline run unexpectedly accessed the network');
  const evidence = [...rpc.evidence, ...(ledgerRpc?.evidence ?? [])];
  const result = present(caseId, packet, evidence, live ? { rpcHost: redactedRpcUrl(opts.rpcUrl), dir: relative(ROOT, outDir) } : undefined);
  event('Assembled findings, source references and the draft memo using deterministic checks.');
  saveResult(result, outDir);
  event(`Saved packet, graph, evidence and memo locally. ${rpc.counts.replayed + (ledgerRpc?.counts.replayed ?? 0)} fixture reads; ${rpc.counts.live} live reads.`);
  return result;
}
