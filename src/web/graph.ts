import type { TokenomicsGraph } from '../graph/tokenomics-neo4j';
import { SUMMARY_QUERIES, PROPOSAL_BRIDGE_CYPHER, GOVERNANCE_BRIDGE_CYPHER, localGraphCounts, localProposalDependencies, localGovernanceTouches, graphCount, type GraphOrigin, type GraphOverview, type ProposalBridge, type GovernanceBridge, type ProposalDependency } from './graph-overview';
import neo4j from 'neo4j-driver';
import { CANNED_QUERIES, loadNeo4j, neo4jConfigFromEnv, redactedNeo4jHost, runCannedLocal, runCannedNeo4j,
  type GraphRecords, type Neo4jDriverLike, type QueryResult } from '../graph/neo4j';

export type CannedResult = QueryResult & { params: Record<string, unknown> };
export type GraphAnswer = {
  source: 'neo4j' | 'local'; configured: boolean; host: string | null; reason: string | null;
  scope: 'captured graph'; retrievedAt: string; stats: GraphRecords['stats']; queries: CannedResult[];
  entityCases: Record<string, string[]>;
};
type Config = NonNullable<ReturnType<typeof neo4jConfigFromEnv>>;
type Driver = Neo4jDriverLike & { close?(): Promise<void> };
export type GraphOptions = {
  config?: Config | null; driverFactory?: (config: Config) => Driver;
  queryTimeoutMs?: number; loadTimeoutMs?: number; cacheMs?: number;
};
export class GraphError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
class GraphTimeout extends Error { override name = 'TimeoutError'; }
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GraphTimeout('Neo4j operation timed out')), ms);
  })]); } finally { clearTimeout(timer); }
}

export class GraphService {
  private readonly config: Config | null;
  private driver?: Driver;
  private cached = new Map<string, { at: number; answer: GraphAnswer }>();
  private pending = new Map<string, Promise<GraphAnswer>>();
  private loading = false;
  private generation = 0;
  constructor(readonly records: GraphRecords, private options: GraphOptions = {}) {
    this.config = options.config === undefined ? neo4jConfigFromEnv() : options.config;
  }
  private getDriver(): Driver {
    if (!this.config) throw new GraphError('Neo4j is not configured', 409);
    return this.driver ??= this.options.driverFactory ? this.options.driverFactory(this.config)
      : neo4j.driver(this.config.uri, neo4j.auth.basic(this.config.username, this.config.password), {
        connectionTimeout: this.options.queryTimeoutMs ?? 5_000,
        connectionAcquisitionTimeout: this.options.queryTimeoutMs ?? 5_000,
        maxTransactionRetryTime: 0,
      });
  }
  private summaryCache?: { at: number; graph: TokenomicsGraph; answer: GraphOverview };
  private summaryPending?: { graph: TokenomicsGraph; work: Promise<GraphOverview> };
  invalidateSummary() { this.summaryCache = undefined; this.summaryPending = undefined; }
  private async acrossNamespaces<T extends object>(remote: (driver: Neo4jDriverLike, database: string) => Promise<T>, local: () => T): Promise<T & GraphOrigin> {
    const origin = (source: GraphOrigin['source'], reason: string | null): GraphOrigin => ({ source, reason,
      host: source === 'neo4j' ? redactedNeo4jHost(this.config!.uri) : null, retrievedAt: new Date().toISOString() });
    if (!this.config) return { ...local(), ...origin('local', 'Neo4j is not configured') };
    try {
      const driver = this.getDriver(), ms = this.options.queryTimeoutMs ?? 20_000;
      const bounded: Neo4jDriverLike = { executeQuery: (cypher, params, config) => deadline(driver.executeQuery(cypher, params,
        { ...config, transactionConfig: { timeout: ms } } as typeof config), ms) };
      return { ...await deadline(remote(bounded, this.config.database), ms), ...origin('neo4j', null) };
    } catch (error) { return { ...local(), ...origin('local', this.scrub(error)) }; }
  }
  summary(tokenomics: TokenomicsGraph): Promise<GraphOverview> {
    if (this.summaryCache?.graph === tokenomics && Date.now() - this.summaryCache.at < (this.options.cacheMs ?? 60_000)) return Promise.resolve(this.summaryCache.answer);
    if (this.summaryPending?.graph === tokenomics) return this.summaryPending.work;
    const work = this.acrossNamespaces(async (driver, database) => {
      const results = await Promise.all(SUMMARY_QUERIES.map(cypher => driver.executeQuery(cypher, {}, { database, routing: 'READ' })));
      const count = (i: number) => graphCount(results[i].records[0]?.toObject().count);
      return { nodes: count(0), relationships: count(1), byNamespace: { governance: count(2), tokenomics: count(3) },
        byLabel: Object.fromEntries(results[4].records.map(r => { const row = r.toObject(); return [String(row.l), graphCount(row.count)]; })) };
    }, () => localGraphCounts(this.records, tokenomics)).then(answer => {
      if (this.summaryPending?.work === work) this.summaryCache = { at: Date.now(), graph: tokenomics, answer };
      return answer;
    }).finally(() => { if (this.summaryPending?.work === work) this.summaryPending = undefined; });
    this.summaryPending = { graph: tokenomics, work }; return work;
  }
  proposalDependencies(tokenomics: TokenomicsGraph, caseId: string): Promise<ProposalBridge> {
    return this.acrossNamespaces(async (driver, database) => {
      const result = await driver.executeQuery(PROPOSAL_BRIDGE_CYPHER, { case: caseId }, { database, routing: 'READ' });
      return { rows: result.records.map(r => {
        const row = r.toObject();
        return { address: String(row.address), caseRole: String(row.caseRole ?? ''), caseLabel: String(row.caseLabel ?? ''),
          tokenomicsType: String(row.tokenomicsType ?? ''), tokenomicsLabel: String(row.tokenomicsLabel ?? ''), links: (row.links as unknown[] ?? []).map(String) } satisfies ProposalDependency;
      }) };
    }, () => ({ rows: localProposalDependencies(this.records, tokenomics, caseId) }));
  }
  governanceTouches(tokenomics: TokenomicsGraph): Promise<GovernanceBridge> {
    return this.acrossNamespaces(async (driver, database) => {
      const result = await driver.executeQuery(GOVERNANCE_BRIDGE_CYPHER, {}, { database, routing: 'READ' });
      return { rows: result.records.map(r => { const row = r.toObject(); return { caseId: String(row.caseId), sharedAccounts: graphCount(row.sharedAccounts),
        examples: (row.examples as unknown[] ?? []).map(String), entityLabels: (row.entityLabels as unknown[] ?? []).map(String) }; }) };
    }, () => ({ rows: localGovernanceTouches(this.records, tokenomics) }));
  }
  async close() { await this.driver?.close?.(); }
  private scrub(error: unknown): string {
    let message = error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;
    const secrets = this.config ? [this.config.uri, this.config.username, this.config.password] : [];
    if (this.config) {
      try { const uri = new URL(this.config.uri); secrets.push(uri.username, uri.password, decodeURIComponent(uri.username), decodeURIComponent(uri.password)); } catch { /* Full URI is still scrubbed. */ }
    }
    const tokens = [...new Set(secrets.filter(Boolean).flatMap(s => [s, encodeURIComponent(s)]))].sort((a, b) => b.length - a.length);
    for (const secret of tokens) message = message.split(secret).join('[redacted]');
    return message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted URI]').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  }
  private answer(source: GraphAnswer['source'], reason: string | null, queries: QueryResult[]): GraphAnswer {
    return { source, configured: !!this.config, host: source === 'neo4j' ? redactedNeo4jHost(this.config!.uri) : null,
      reason, scope: 'captured graph', retrievedAt: new Date().toISOString(), stats: this.records.stats,
      entityCases: Object.fromEntries(this.records.nodes.map(n => [n.id, n.props.cases])),
      queries: queries.map(q => ({ ...q, params: CANNED_QUERIES.find(c => c.id === q.id)!.params })) };
  }
  local(reason = this.config ? 'Neo4j has not been queried yet' : 'Neo4j is not configured', id?: string) {
    return this.answer('local', reason, CANNED_QUERIES.filter(q => !id || q.id === id).map(q => runCannedLocal(this.records, q.id)));
  }
  query(id?: string): Promise<GraphAnswer> {
    if (id && !CANNED_QUERIES.some(q => q.id === id)) return Promise.reject(new GraphError('Unknown canned query', 404));
    if (!this.config) return Promise.resolve(this.local(undefined, id));
    const key = id ?? '*', cached = this.cached.get(key) ?? this.cached.get('*');
    if (cached && Date.now() - cached.at < (this.options.cacheMs ?? 30_000)) {
      return Promise.resolve(id ? { ...cached.answer, queries: cached.answer.queries.filter(q => q.id === id) } : cached.answer);
    }
    const existing = this.pending.get(key); if (existing) return existing;
    const generation = this.generation;
    const work = this.read(id).then(answer => {
      if (answer.source === 'neo4j' && generation === this.generation) this.cached.set(key, { at: Date.now(), answer });
      return answer;
    }).finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); });
    this.pending.set(key, work); return work;
  }
  private async read(id?: string): Promise<GraphAnswer> {
    try {
      const driver = this.getDriver(), ms = this.options.queryTimeoutMs ?? 5_000;
      const bounded: Neo4jDriverLike = { executeQuery: (cypher, params, config) => deadline(driver.executeQuery(cypher, params,
        { ...config, transactionConfig: { timeout: ms } } as typeof config), ms) };
      const queries = await Promise.all(CANNED_QUERIES.filter(q => !id || q.id === id).map(q => runCannedNeo4j(bounded, q.id, this.config!)));
      return this.answer('neo4j', null, queries);
    } catch (error) { return this.local(this.scrub(error), id); }
  }
  async load() {
    if (!this.config) throw new GraphError('Neo4j is not configured. Set NEO4J_URI and NEO4J_PASSWORD on the server.', 409);
    if (this.loading) throw new GraphError('A Neo4j load is already running', 409);
    this.loading = true;
    this.generation++; this.cached.clear(); this.pending.clear(); this.invalidateSummary();
    let work: Promise<unknown> | undefined;
    try {
      const driver = this.getDriver(), ms = this.options.loadTimeoutMs ?? 120_000, end = Date.now() + ms;
      let expired = false;
      // Stop subsequent batches after the response deadline. Retain the load lock
      // until any in-flight driver call settles, so two loads cannot overlap.
      const bounded: Neo4jDriverLike = { executeQuery: (cypher, params, config) => {
        if (expired || Date.now() >= end) throw new GraphTimeout('Neo4j load timed out');
        return driver.executeQuery(cypher, params, { ...config, transactionConfig: { timeout: Math.max(1, end - Date.now()) } } as typeof config);
      } };
      const loading = loadNeo4j(bounded, this.records, this.config); work = loading;
      try { return { ...await deadline(loading, ms), host: redactedNeo4jHost(this.config.uri) }; }
      finally { expired = true; }
    } catch (error) { throw new GraphError(this.scrub(error), error instanceof GraphTimeout ? 504 : 502); }
    finally {
      const release = () => { this.loading = false; this.generation++; this.cached.clear(); this.pending.clear(); this.invalidateSummary(); };
      if (work) void work.then(release, release); else release();
    }
  }
}
