import neo4j from 'neo4j-driver';
import { CASES, type CaseId } from '../src/web/model';
import { runPipeline } from '../src/web/runner';
import { buildGraphRecords, CANNED_QUERIES, loadNeo4j, neo4jConfigFromEnv, redactedNeo4jHost, runCannedNeo4j } from '../src/graph/neo4j';

export function parseArgs(args: string[]): { dryRun: boolean; cases: CaseId[] } {
  let dryRun = false;
  const cases: CaseId[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--case') {
      const id = args[++i];
      if (!CASES.some(c => c.id === id)) throw new Error('Expected --case marinade|mip-14|mip-14-opinion|bonk-bip76');
      if (!cases.includes(id as CaseId)) cases.push(id as CaseId);
    } else throw new Error('Usage: bun run scripts/load-neo4j.ts [--dry-run] [--case <id>]...');
  }
  return { dryRun, cases: cases.length ? cases : ['marinade', 'mip-14', 'mip-14-opinion', 'bonk-bip76'] };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try { options = parseArgs(args); } catch (error) { console.error((error as Error).message); return 2; }
  let stage = 'offline fixture rebuild';
  try {
    const inputs = [];
    for (const caseId of options.cases) inputs.push({ caseId, ...await runPipeline(caseId) });
    const records = buildGraphRecords(inputs);
    for (const [caseId, stats] of Object.entries(records.stats.cases)) console.log(JSON.stringify({ case: caseId, ...stats }));
    if (options.dryRun) return 0;
    const config = neo4jConfigFromEnv();
    if (!config) {
      console.error('Neo4j configuration missing: set NEO4J_URI and NEO4J_PASSWORD, or use --dry-run.');
      return 2;
    }
    stage = 'driver creation';
    console.log(JSON.stringify({ host: redactedNeo4jHost(config.uri) }));
    const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
    try {
      stage = 'connectivity verification';
      await driver.verifyConnectivity({ database: config.database });
      stage = 'graph load';
      console.log(JSON.stringify(await loadNeo4j(driver, records, { database: config.database })));
      for (const query of CANNED_QUERIES) {
        stage = `query ${query.id}`;
        const result = await runCannedNeo4j(driver, query.id, { database: config.database });
        console.log(JSON.stringify({ query: query.id, rows: result.rows.length }));
      }
    } finally {
      await driver.close();
    }
    return 0;
  } catch {
    // Driver exceptions may contain a complete URI, credentials or local paths.
    console.error(`Neo4j loader failed during ${stage}. Check the configuration and recorded fixtures; connection details are redacted.`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main();
