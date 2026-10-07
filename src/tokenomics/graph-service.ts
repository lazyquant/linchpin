import neo4j from 'neo4j-driver';
import { canonical } from '../chain/evidence';
import { neo4jConfigFromEnv, redactedNeo4jHost, type Neo4jDriverLike } from '../graph/neo4j';
import { buildTokenomicsGraph, loadTokenomicsNeo4j, runTokenomicsLocal, runTokenomicsNeo4j, TOKENOMICS_QUERIES, tokenomicsSubgraph, readTokenomicsSubgraph } from '../graph/tokenomics-neo4j';
import { GraphError, type GraphOptions } from '../web/graph';
import type { BundleResponse, GraphData } from './api';
class Timeout extends Error { override name = 'TimeoutError'; }
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout('Neo4j operation timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
export class TokenomicsGraphService {
  readonly graph;
  private config;
  private driver?: Neo4jDriverLike & { close?(): Promise<void> };
  private cached?: { at: number; data: GraphData };
  private pending?: Promise<GraphData>;
  private loading = false;
  private generation = 0;
  failure: string | null = null;
  constructor(bundle: BundleResponse, private options: GraphOptions = {}) {
    this.graph = buildTokenomicsGraph(bundle);
    this.config = options.config === undefined ? neo4jConfigFromEnv() : options.config;
  }
  private getDriver() {
    if (!this.config) throw new GraphError('Neo4j is not configured', 409);
    return this.driver ??= this.options.driverFactory ? this.options.driverFactory(this.config) : neo4j.driver(this.config.uri, neo4j.auth.basic(this.config.username, this.config.password), {
      connectionTimeout: this.options.queryTimeoutMs ?? 5000, connectionAcquisitionTimeout: this.options.queryTimeoutMs ?? 5000, maxTransactionRetryTime: 0,
    });
  }
  async close() { await this.driver?.close?.(); }
  private scrub(error: unknown) {
    let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const secrets = this.config ? [this.config.uri, this.config.username, this.config.password] : [];
    if (this.config) try { const u = new URL(this.config.uri); secrets.push(u.username, u.password, decodeURIComponent(u.username), decodeURIComponent(u.password)); } catch { /* URI below */ }
    for (const s of [...new Set(secrets.filter(Boolean).flatMap(s => [s, encodeURIComponent(s)]))].sort((a, b) => b.length - a.length)) message = message.split(s).join('[redacted]');
    return message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted URI]').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  }
  local(reason = this.config ? 'Neo4j has not been queried yet' : 'Neo4j is not configured'): GraphData {
    return { source: 'local', host: null, reason, configured: !!this.config, queries: TOKENOMICS_QUERIES.map(q => runTokenomicsLocal(this.graph, q.id)), subgraph: tokenomicsSubgraph(this.graph) };
  }
  query(): Promise<GraphData> {
    if (this.failure || this.loading) return Promise.resolve(this.local(this.failure ?? 'Neo4j load is in progress'));
    if (!this.config) return Promise.resolve(this.local());
    if (this.cached && Date.now() - this.cached.at < (this.options.cacheMs ?? 30000)) return Promise.resolve(this.cached.data);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const work = this.read().then(data => { if (generation === this.generation) this.cached = { at: Date.now(), data }; return data; })
      .finally(() => { if (this.pending === work) this.pending = undefined; });
    this.pending = work; return work;
  }
  private async read(): Promise<GraphData> {
    try {
      const driver = this.getDriver(), ms = this.options.queryTimeoutMs ?? 5000;
      const bounded: Neo4jDriverLike = { executeQuery: (cypher, params, config) => deadline(driver.executeQuery(cypher, params, { ...config, transactionConfig: { timeout: ms } } as typeof config), ms) };
      const queries = await Promise.all(TOKENOMICS_QUERIES.map(q => runTokenomicsNeo4j(bounded, q.id, this.config!)));
      const subgraph = await readTokenomicsSubgraph(bounded, this.config!);
      const local = this.local();
      if (queries.some((q, n) => canonical(q.rows) !== canonical(local.queries[n].rows))) return this.local('Neo4j TG snapshot differs from this captured bundle; reload the tokenomics graph.');
      const normalized = (g: GraphData['subgraph']) => canonical({ nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)), edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id)) });
      if (normalized(subgraph) !== normalized(local.subgraph)) return this.local('Neo4j TG picture differs from this captured bundle; reload the tokenomics graph.');
      return { ...local, subgraph, source: 'neo4j', host: redactedNeo4jHost(this.config!.uri), reason: null, queries };
    } catch (error) { return this.local(this.scrub(error)); }
  }
  async load() {
    if (!this.config) throw new GraphError('Neo4j is not configured', 409);
    if (this.loading) throw new GraphError('A tokenomics Neo4j load is already running', 409);
    this.loading = true; this.generation++; this.cached = undefined; this.pending = undefined;
    let work: Promise<unknown> | undefined;
    try {
      const driver = this.getDriver(), ms = this.options.loadTimeoutMs ?? 120000, end = Date.now() + ms;
      let expired = false;
      const bounded: Neo4jDriverLike = { executeQuery: (cypher, params, config) => {
        if (expired || Date.now() >= end) throw new Timeout('Neo4j load timed out');
        return driver.executeQuery(cypher, params, { ...config, transactionConfig: { timeout: Math.max(1, end - Date.now()) } } as typeof config);
      } };
      const loading = loadTokenomicsNeo4j(bounded, this.graph, this.config); work = loading;
      try {
        const result = await deadline(loading, ms);
        this.failure = result.regression === 'changed' ? `Governance-case query regression changed: ${result.changedQueries.join(', ')}` : null;
        return { ...result, host: redactedNeo4jHost(this.config.uri) };
      } finally { expired = true; }
    } catch (error) { this.failure = this.scrub(error); throw new GraphError(this.failure, error instanceof Timeout ? 504 : 502); }
    finally {
      const release = () => { this.loading = false; this.generation++; this.cached = undefined; this.pending = undefined; };
      // A response timeout does not release the writer until the in-flight call settles.
      if (work) void work.then(release, release); else release();
    }
  }
}
