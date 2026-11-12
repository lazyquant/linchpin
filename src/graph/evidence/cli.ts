import { buildEvidenceRecords, recordCounts, recordsSha256 } from './build';
import { collectSlice1Inputs } from './protocols';
import { validateEvidenceRecords } from './validate';
import { loadEvidenceGraph, type EvidenceDriverLike } from './neo4j';
export interface CliDependencies { createDriver(config:{uri:string;username:string;password:string;database:string}): EvidenceDriverLike & {close():Promise<void>}; readText(path:string):string; out(line:string):void; err(line:string):void }
export async function loadMain(args:string[], env:Record<string,string|undefined>,deps:CliDependencies):Promise<number> {
  try {
    if(args.some(a=>!['--dry-run','--allow-private','--enforce-graph-type'].includes(a))) {deps.err('Unknown argument');return 2;}
    const dry=args.includes('--dry-run'),allowPrivate=args.includes('--allow-private');
    const records=buildEvidenceRecords(collectSlice1Inputs(),{allowPrivate});validateEvidenceRecords(records);
    deps.out(JSON.stringify({...recordCounts(records),recordsSha256:recordsSha256(records)}));
    if(dry) return 0;
    const uri=env.NEO4J_URI,password=env.NEO4J_PASSWORD;
    if(!uri||!password) {deps.err('Neo4j configuration missing');return 2;}
    if(records.nodes.some(n=>n.props.privacy==='private') && (!allowPrivate || !['localhost','127.0.0.1','[::1]','::1'].includes(new URL(uri).hostname))) {deps.err('Private input requires loopback Neo4j');return 1;}
    const config={uri,password,username:env.NEO4J_USERNAME??'neo4j',database:env.NEO4J_DATABASE??'neo4j'};
    const driver=deps.createDriver(config);
    try {await loadEvidenceGraph(driver,records,{database:config.database,enforceGraphType:args.includes('--enforce-graph-type'),log:deps.out});} finally {await driver.close();}
    return 0;
  } catch(error) {deps.err(error instanceof Error && error.message.startsWith('Run bun run')?error.message:'Evidence load failed; connection details redacted');return 1;}
}
