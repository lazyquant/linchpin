import { join } from "node:path";
import { loadNearSnapshots } from "../reader/load";
import { isNearAccountId, nearSubject } from "../reader/types";
import { CURRENT_NEAR_SNAPSHOT } from "../subjects/registry";
import { PanelRejected, writePanel } from "../panel";
import { PANEL_REPO_ROOT } from "../panel/output";

export async function run(args:string[]):Promise<number> {
  try {
    const seen=new Set<string>();let account:string|undefined;
    let snapshotId=CURRENT_NEAR_SNAPSHOT,before:string|undefined,out=join(PANEL_REPO_ROOT,"dist/near-panels");
    for (let i=0;i<args.length;i++) {
      const arg=args[i];
      if (!arg.startsWith("--")) {if(account !== undefined) throw new TypeError("One account is required");account=arg;continue;}
      if (seen.has(arg)) throw new TypeError("Duplicate option");seen.add(arg);
      if (arg === "--offline") continue;
      if (!["--snapshot","--before","--out"].includes(arg)) throw new TypeError("Unknown panel option");
      const value=args[++i];if(!value || value.startsWith("--")) throw new TypeError("Missing panel option value");
      if(arg === "--snapshot") snapshotId=value;else if(arg === "--before") before=value;else out=value;
    }
    if (!account || !isNearAccountId(account)) throw new TypeError("A valid NEAR account is required");
    const store=loadNearSnapshots(before ? [before,snapshotId] : [snapshotId],{root:join(PANEL_REPO_ROOT,"fixtures/near")});
    const files=await writePanel(store,snapshotId,nearSubject(account),out,before ? {beforeSnapshotId:before} : {});
    console.log(JSON.stringify({subject:nearSubject(account),snapshotId,files}));return 0;
  } catch(error) {
    console.error(error instanceof Error ? error.message.replace(/[\r\n]+/g," ") : "Panel command failed");
    return error instanceof PanelRejected || error instanceof TypeError ? 2 : 1;
  }
}

