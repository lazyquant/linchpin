import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { runOptions } from '../config';
import { RecordingRpc } from '../chain/rpc';
import { loadCase } from '../governance/claims';
import { readProposalBundle } from '../governance/reader';
import { reviewBundle } from '../cli';
import { buildPack, type PackFile, type PackRegistry, type DocsCapture } from '../pack/build';
import { CASES, present, type CaseId, type Result } from './model';

export type Event = { at: string; message: string; evidenceCount?: number };
export type Run = { id: string; caseId: CaseId; status: 'running' | 'completed' | 'failed'; events: Event[]; error?: string };
export const ROOT = resolve(import.meta.dir, '../..');
const json = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const stringify = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);

export async function runPipeline(caseId: CaseId, emit: (event: Event) => void = () => {}): Promise<Result> {
  const scope = CASES.find(c => c.id === caseId);
  if (!scope) throw new Error('Unknown research case');
  const outDir = join(ROOT, 'out/web', caseId);
  const rpc = new RecordingRpc(runOptions({ offline: true, record: false, refresh: false, rpcUrl: 'http://127.0.0.1:1', fixturesDir: join(ROOT, 'fixtures'), outDir }), caseId === 'marinade' ? 'marinade-pack' : caseId);
  const event = (message: string) => emit({ at: new Date().toISOString(), message, evidenceCount: rpc.evidence.length });
  event('Opened the fixed case specification. Recorded fixtures only; no network reads.');
  let packet;
  if (caseId === 'marinade') {
    const config = json(scope.file) as PackFile;
    const registry = json(config.registry) as PackRegistry;
    event('Loaded documented claims and the declared program, mint and account boundary.');
    packet = await buildPack(rpc, registry, { title: config.title, docsCapture: json(config.docsCapture) as DocsCapture, burns: config.burns, ledger: config.ledger });
    event(`Resolved control and supply checks; reconstructed ${packet.ledger.entries.length} treasury rows from ${packet.ledger.proposalsScanned} proposals.`);
  } else {
    const spec = loadCase(join(ROOT, scope.file));
    const bundle = await readProposalBundle(rpc, new PublicKey(spec.programId), spec.programVersion, new PublicKey(spec.proposal));
    event(`Read proposal accounts and ${bundle.transactions.length} transaction payloads from recorded responses.`);
    packet = await reviewBundle(spec, rpc, bundle);
    event(`Decoded effects, replayed conditional simulations and reconciled ${packet.observed.receipts.length} execution receipts.`);
  }
  if (rpc.counts.live !== 0) throw new Error('Offline run unexpectedly accessed the network');
  const result = present(caseId, packet, rpc.evidence);
  event('Assembled findings, source references and the draft memo using deterministic checks.');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'packet.json'), stringify(packet));
  writeFileSync(join(outDir, 'graph.json'), stringify(result.view.graph));
  writeFileSync(join(outDir, 'evidence.jsonl'), rpc.evidence.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(outDir, 'memo.md'), result.view.memo);
  event(`Saved packet, graph, evidence and memo locally. ${rpc.counts.replayed} fixture reads; 0 live reads.`);
  return result;
}
