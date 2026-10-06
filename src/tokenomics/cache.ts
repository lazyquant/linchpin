import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../chain/evidence';
import { neo4jConfigFromEnv } from '../graph/neo4j';
import { assertCapturedPack, buildTokenomics, type TokenomicsBuild } from './build';
import { EvidenceIndex, evidenceIds } from './evidence';
import type { EvidenceRecord, SectionId } from './api';

/** Bump when tokenomics assembly or its contract/graph dependencies change. */
export const TOKENOMICS_BUNDLE_VERSION = 'b1e-3';
const sections: SectionId[] = ['answer', 'path', 'control', 'offsets', 'parameters', 'programs', 'participation', 'holders', 'flows', 'claims', 'graph'];

/** Metadata inventory covers both recorder namespaces, including compressed fixtures,
 * and all pack inputs (registry, contracts, docs and optional labels). No RPC reads. */
export function tokenomicsDigest(root: string, version = TOKENOMICS_BUNDLE_VERSION): string {
  const files: [string, number, number][] = [];
  function visit(directory: string) {
    if (!existsSync(join(root, directory))) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const stat = statSync(join(root, file));
        files.push([file, stat.size, stat.mtimeMs]);
      }
    }
  }
  for (const directory of ['fixtures/marinade-contracts', 'fixtures/marinade-pack', 'packs/marinade']) visit(directory);
  // The code that turns evidence into the bundle is part of the key, so a stale bundle is never served after a code change.
  const code: [string, string][] = [];
  for (const directory of ['src/tokenomics', 'src/contracts', 'src/graph']) {
    if (!existsSync(join(root, directory))) continue;
    for (const name of readdirSync(join(root, directory)).filter(n => n.endsWith('.ts')).sort()) code.push([`${directory}/${name}`, sha256(readFileSync(join(root, directory, name), 'utf8'))]);
  }
  return sha256(JSON.stringify({ version, files, code }));
}

type CachedBuild = Omit<TokenomicsBuild, 'evidence'> & { records: EvidenceRecord[] };
type CacheFile = { digest: string; checksum: string; build: CachedBuild };

export async function loadTokenomicsBundle(options: Parameters<typeof buildTokenomics>[0], dependencies: {
  build?: typeof buildTokenomics; log?: (message: string) => void;
} = {}): Promise<TokenomicsBuild> {
  assertCapturedPack(options.packResult);
  const started = performance.now(), digest = tokenomicsDigest(options.root);
  const directory = join(options.root, 'out/tokenomics/marinade'), file = join(directory, `bundle-${digest}.json`);
  const log = (hit: boolean) => (dependencies.log ?? console.log)(`tokenomics bundle: cache ${hit ? 'hit' : 'miss'} in ${Math.round(performance.now() - started)} ms`);
  try {
    const cached: CacheFile = JSON.parse(readFileSync(file, 'utf8'));
    if (cached.digest !== digest || cached.checksum !== sha256(JSON.stringify(cached.build))) throw new Error('Invalid cache checksum');
    const { records, ...built } = cached.build;
    if (!Array.isArray(records) || !records.length || built.reads.live !== 0 || !sections.every(id => built.bundle[id]?.section === id && built.bundle[id]?.protocol === 'marinade')) throw new Error('Invalid cached build');
    const evidence = new EvidenceIndex(records);
    evidence.metadata(evidenceIds(built.bundle));
    if (!built.bundle.graph.data) throw new Error('Missing cached graph');
    // Configuration is runtime state, never a cached endpoint or credential.
    built.bundle.graph.data.configured = !!neo4jConfigFromEnv();
    built.bundle.graph.data.reason = built.bundle.graph.data.configured ? 'Neo4j has not been queried yet' : 'Neo4j is not configured';
    log(true);
    return { ...built, evidence };
  } catch {
    // Missing, truncated, malformed or checksum-invalid cache: replay fixtures.
  }
  const built = await (dependencies.build ?? buildTokenomics)(options);
  const { evidence, ...data } = built;
  const cached: CachedBuild = { ...data, records: [...evidence.records.values()] };
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ digest, checksum: sha256(JSON.stringify(cached)), build: cached } satisfies CacheFile));
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  log(false);
  return built;
}
