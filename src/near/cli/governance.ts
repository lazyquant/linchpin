import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_NEAR_SNAPSHOT } from "../subjects/registry";
import { parseNearSubject } from "../reader/types";
import { reviewProposal, sweepOpen } from "../governance/review";
import { renderGovernanceJson, renderGovernanceMarkdown } from "../governance/render";
const usage="usage: linchpin near governance <dao> (<id> | --open) [--for <account|subject>] [--snapshot <id>] [--compare <id>] [--out <dir>] [--offline]";
function subject(value:string):string {const s=value.startsWith("near:") ? value:`near:mainnet:${value}`;if(!parseNearSubject(s)) throw new Error("Invalid NEAR subject");return s;}
export async function run(args:string[]):Promise<number> {
  try {
    const positional:string[]=[],options:Record<string,string>={};let open=false;
    for(let i=0;i<args.length;i++) {
      const arg=args[i];if(arg === "--offline") continue;if(arg === "--open") {if(open) throw new Error("Duplicate option");open=true;continue;}
      if(["--for","--snapshot","--compare","--out"].includes(arg)) {const value=args[++i];if(!value || value.startsWith("--") || Object.hasOwn(options,arg)) throw new Error(`Missing or duplicate ${arg} value`);options[arg]=value;}
      else if(arg.startsWith("--")) throw new Error("Unknown option");else positional.push(arg);
    }
    if(positional.length !== (open ? 1:2)) throw new Error("Provide a DAO and either an id or --open");
    const dao=parseNearSubject(subject(positional[0]))!;if(dao.kind !== null) throw new Error("DAO must be an account");
    const raw=positional[1];if(!open && (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))) throw new Error("Invalid proposal id");
    const ctx={snapshotId:options["--snapshot"] ?? CURRENT_NEAR_SNAPSHOT},opts={forSubject:options["--for"] ? subject(options["--for"]):undefined,compareSnapshotId:options["--compare"]};
    const report=open ? sweepOpen(ctx,dao.account,opts):reviewProposal(ctx,dao.account,Number(raw),opts);
    const md=renderGovernanceMarkdown(report),json=renderGovernanceJson(report),out=options["--out"] ?? `out/near-governance/${dao.account}-${open ? "open":raw}`;
    mkdirSync(out,{recursive:true});const paths=[join(out,"governance-review.md"),join(out,"governance-review.json")];
    await Bun.write(paths[0],md);await Bun.write(paths[1],json);console.log(paths.join("\n"));return 0;
  } catch(e) {console.error(e instanceof Error ? e.message:"Governance command failed");console.error(usage);return 1;}
}
if(import.meta.main) process.exitCode=await run(process.argv.slice(2));
