import { PublicKey } from "@solana/web3.js";

export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const MARINADE_GOVERNANCE_PROGRAM = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs");
export const MARINADE_PROGRAM_VERSION = 3; // verified 2026-10-05: program logs VERSION:"3.1.1"

export type RunOptions = {
  rpcUrl: string; offline: boolean; record: boolean; refresh: boolean;
  minIntervalMs: number; requestTimeoutMs: number; retryDelaysMs?: readonly number[];
  outDir: string; fixturesDir: string;
};

export function runOptions(partial: Partial<RunOptions> = {}): RunOptions {
  const record = partial.record ?? false;
  const minIntervalMs = partial.minIntervalMs ?? (process.env.LINCHPIN_RPC_MIN_INTERVAL_MS == null
    ? (record ? 250 : 0) : Number(process.env.LINCHPIN_RPC_MIN_INTERVAL_MS));
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error("LINCHPIN_RPC_MIN_INTERVAL_MS must be a non-negative finite number");
  const requestTimeoutMs = partial.requestTimeoutMs ?? Number(process.env.LINCHPIN_RPC_TIMEOUT_MS ?? 30000);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("LINCHPIN_RPC_TIMEOUT_MS must be a positive safe integer");
  return {
    rpcUrl: partial.rpcUrl ?? process.env.LINCHPIN_RPC_URL ?? DEFAULT_RPC_URL,
    offline: partial.offline ?? process.env.LINCHPIN_OFFLINE === "1",
    record,
    refresh: partial.refresh ?? process.env.LINCHPIN_REFRESH === "1",
    minIntervalMs,
    requestTimeoutMs,
    retryDelaysMs: partial.retryDelaysMs,
    outDir: partial.outDir ?? "out",
    fixturesDir: partial.fixturesDir ?? "fixtures",
  };
}
