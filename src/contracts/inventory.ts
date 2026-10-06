import type { IdlInstructionAccount, IdlType, LegacyIdl } from "./idl";

export function readableType(type: IdlType): string {
  if (typeof type === "string") return type;
  if ("defined" in type) return type.defined;
  if ("vec" in type) return `Vec<${readableType(type.vec)}>`;
  if ("option" in type) return `Option<${readableType(type.option)}>`;
  if ("coption" in type) return `COption<${readableType(type.coption)}>`;
  if ("array" in type) return `[${readableType(type.array[0])}; ${type.array[1]}]`;
  throw new Error(`Unknown IDL type ${JSON.stringify(type)}`);
}

type FlatAccount = { name: string; isSigner: boolean; isMut: boolean };
function flatten(accounts: IdlInstructionAccount[], prefix = ""): FlatAccount[] {
  return accounts.flatMap(a => {
    const name = prefix + a.name;
    return "accounts" in a ? flatten(a.accounts, `${name}.`) : [{ name, isSigner: a.isSigner, isMut: a.isMut }];
  });
}
export function instructionInventory(idl: LegacyIdl) {
  return idl.instructions.map(i => {
    const accounts = flatten(i.accounts);
    return { name: i.name, args: i.args.map(a => ({ name: a.name, type: readableType(a.type) })), accounts, signerRoles: accounts.filter(a => a.isSigner).map(a => a.name) };
  });
}

export const normalizeName = (name: string) => name.replaceAll("_", "").toLowerCase();
export const PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  rewardsFee: "rewardFee", admin: "adminAuthority", validatorManager: "validatorSystem.managerAuthority",
};

function structType(idl: LegacyIdl, type: IdlType) {
  if (typeof type === "string") return undefined;
  if ("option" in type) return structType(idl, type.option);
  if ("coption" in type) return structType(idl, type.coption);
  if (!("defined" in type)) return undefined;
  const def = [...(idl.types ?? []), ...(idl.accounts ?? [])].find(t => t.name === type.defined)?.type;
  return def?.kind === "struct" ? def : undefined;
}

/** Includes struct nodes (e.g. rewardFee) as well as their scalar descendants. */
export function stateFieldPaths(idl: LegacyIdl, accountName: string): string[] {
  const account = idl.accounts?.find(a => a.name === accountName);
  if (!account || account.type.kind !== "struct") throw new Error(`${accountName}: expected a struct account`);
  const walk = (fields: typeof account.type.fields, prefix: string, ancestors: IdlType[]): string[] => fields.flatMap(f => {
    const path = prefix + f.name;
    const def = structType(idl, f.type);
    if (!def || ancestors.some(t => JSON.stringify(t) === JSON.stringify(f.type))) return [path];
    return [path, ...walk(def.fields, `${path}.`, [...ancestors, f.type])];
  });
  return walk(account.type.fields, "", []);
}

export function matchingStateFields(leaf: string, paths: string[]): string[] {
  const normalized = normalizeName(leaf.split(".").at(-1)!);
  const alias = Object.entries(PARAMETER_ALIASES).find(([key]) => normalizeName(key) === normalized)?.[1];
  return alias ? paths.filter(p => p === alias) : paths.filter(p => normalizeName(p.split(".").at(-1)!) === normalized);
}

export type ControlLink = { instruction: string; argPath: string; stateField: string; signerRoles: string[]; basis: "inferred" };
export function parameterControl(idl: LegacyIdl, stateAccountName: string) {
  const paths = stateFieldPaths(idl, stateAccountName);
  const inventory = instructionInventory(idl);
  const links: ControlLink[] = [];
  const unmatched: { instruction: string; argPath: string; type: string; signerRoles: string[]; reason: string; candidates: string[] }[] = [];
  for (const [index, instruction] of idl.instructions.entries()) {
    const signerRoles = inventory[index].signerRoles;
    for (const arg of instruction.args) {
      const fields = structType(idl, arg.type)?.fields ?? [];
      for (const candidate of [{ argPath: arg.name, leaf: arg.name, type: arg.type }, ...fields.map(f => ({ argPath: `${arg.name}.${f.name}`, leaf: f.name, type: f.type }))]) {
        const matches = matchingStateFields(candidate.leaf, paths);
        if (matches.length === 1) links.push({ instruction: instruction.name, argPath: candidate.argPath, stateField: matches[0], signerRoles, basis: "inferred" });
        else unmatched.push({ instruction: instruction.name, argPath: candidate.argPath, type: readableType(candidate.type), signerRoles, reason: matches.length ? "ambiguous state field" : "no matching state field", candidates: matches });
      }
    }
  }
  return { links, unmatched };
}
