import { canonical } from "../../chain/evidence";
import { ask, createNearContext, parseAsk, prepareAnswer } from "../agent/index";
import { codeOf } from "../agent/errors";

export async function run(args: string[]): Promise<number> {
  try {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
      const name = args[i]!;
      if (flags.has(name)) throw new Error();
      if (["--json", "--offline"].includes(name)) flags.set(name, "true");
      else if (["--kind", "--subject", "--action", "--policy", "--snapshot"].includes(name) && args[i + 1] && !args[i + 1]!.startsWith("--")) flags.set(name, args[++i]!);
      else throw new Error();
    }
    const kind = flags.get("--kind");
    const allowed = kind === "control" ? ["--subject"] : kind === "policy" ? ["--policy"] : kind === "preflight" ? ["--action", "--policy"] : [];
    if (!allowed.length || [...flags.keys()].some(k => !["--kind", "--json", "--offline", "--snapshot", ...allowed].includes(k))) throw new Error();
    const value = kind === "control" ? { kind, subject: flags.get("--subject") } : kind === "policy" ? { kind, policyId: flags.get("--policy") }
      : { kind, policyId: flags.get("--policy"), action: JSON.parse(flags.get("--action") ?? "null") };
    const context = await createNearContext({ snapshotId: flags.get("--snapshot") });
    const input = parseAsk(value, context);
    const response = flags.has("--offline") ? await prepareAnswer(input, context) : await ask(input, { context });
    if (flags.has("--json")) console.log(canonical(response));
    else {
      console.log(response.model.label ?? `model: ${response.model.id ?? "unavailable"}`);
      console.log(`answer: ${response.kind}\nhardware attestation: ${response.attestation.status}\nresponse binding: ${response.responseBinding.status}`);
      console.log(canonical(response.authoritative));
      for (const code of response.codes) console.log(code);
    }
    return response.kind === "answer" || response.kind === "repaired" ? 0 : response.kind === "prepared" || response.kind === "no-model" ? 3 : 2;
  } catch (error) { console.error(codeOf(error, "invalid-request")); return 2; }
}
