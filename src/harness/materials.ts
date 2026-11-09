import shippedRegistry from "./registry.json";
import shippedConfig from "./config.json";

export interface AgentSpec { rho: number; tokens: number }
export type Registry = Readonly<Record<string, AgentSpec>>;
export interface Config { max_depth: number; token_budget: number; p_floor: number; coin_toss: number; max_hops: number }
export interface Materials { registry: Registry; config: Config }
export const GATE_AGENT = "Verifier";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the roster: reliability and tokens per call. */
export function parseRegistry(value: unknown): Registry {
  if (!isObject(value)) throw new Error("Registry must be an object.");
  return Object.fromEntries(Object.entries(value).map(([name, spec]) => {
    if (!isObject(spec) || typeof spec.rho !== "number" || !Number.isFinite(spec.rho)
      || spec.rho < 0 || spec.rho > 1 || typeof spec.tokens !== "number"
      || !Number.isInteger(spec.tokens) || spec.tokens < 0) {
      throw new Error(`Invalid agent spec: ${name}`);
    }
    return [name, { rho: spec.rho, tokens: spec.tokens }];
  }));
}

/** Read the contract's five bindings. */
export function parseConfig(value: unknown): Config {
  const keys = ["max_depth", "token_budget", "p_floor", "coin_toss", "max_hops"] as const;
  if (!isObject(value) || keys.some((key) => !Object.hasOwn(value, key)
    || typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
    throw new Error("Config must contain five finite numeric bindings.");
  }
  const unknown = Object.keys(value).filter((key) => !(keys as readonly string[]).includes(key));
  if (unknown.length) throw new Error(`Config has unknown bindings: ${unknown.join(", ")}`); // the contract is closed: the seal must see every binding
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as Config;
}

/** The workshop materials, freshly read from the shipped values. */
export function labMaterials(): Materials {
  return { registry: parseRegistry(shippedRegistry), config: parseConfig(shippedConfig) };
}

/** Read the roster and contract from disk. */
export async function loadMaterials(registryPath: string, configPath: string): Promise<Materials> {
  const [registry, config]: unknown[] = await Promise.all([Bun.file(registryPath).json(), Bun.file(configPath).json()]);
  return { registry: parseRegistry(registry), config: parseConfig(config) };
}

/** Add a tool to a new roster. */
export function registerTool(registry: Registry, name: string, spec: AgentSpec): Registry {
  if (Object.hasOwn(registry, name)) throw new Error(`${name} is already registered.`);
  return { ...registry, ...parseRegistry({ [name]: spec }) };
}
