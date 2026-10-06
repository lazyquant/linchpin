import { buildTokenomics } from '../src/tokenomics/build';
import { TokenomicsGraphService } from '../src/tokenomics/graph-service';
import { runPipeline, ROOT } from '../src/web/runner';
const args = process.argv.slice(2);
if (args.some(a => a !== '--dry-run')) { console.error('Usage: bun run scripts/load-tokenomics-neo4j.ts [--dry-run]'); process.exit(1); }
let service: TokenomicsGraphService | undefined;
try {
  const build = await buildTokenomics({ root: ROOT, packResult: await runPipeline('marinade') });
  service = new TokenomicsGraphService(build.bundle);
  const graph = service.graph;
  const counts = <T>(rows: T[], key: (r: T) => string) => Object.fromEntries([...new Set(rows.map(key))].sort().map(k => [k, rows.filter(r => key(r) === k).length]));
  console.log(JSON.stringify({ nodes: graph.nodes.length, relationships: graph.relationships.length,
    nodesByType: counts(graph.nodes, n => n.labels[1]), relationshipsByType: counts(graph.relationships, r => r.type) }, null, 2));
  if (!args.includes('--dry-run')) {
    const result = await service.load(); console.log(JSON.stringify(result, null, 2));
    if (result.regression === 'changed') process.exitCode = 1;
    const answer = await service.query();
    console.log(JSON.stringify({ source: answer.source, reason: answer.reason, queries: answer.queries.map(q => ({ id: q.id, rows: q.rows.length })) }, null, 2));
    if (answer.source !== 'neo4j') process.exitCode = 1;
  }
} catch (error) {
  // The graph service already scrubs driver errors. Build errors contain only offline layer context.
  console.error(error instanceof Error ? error.message : 'Tokenomics load failed'); process.exitCode = 1;
} finally { await service?.close(); }
