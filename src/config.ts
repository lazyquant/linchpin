import { PublicKey } from "@solana/web3.js";

export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const MARINADE_GOVERNANCE_PROGRAM = new PublicKey("GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs");
export const MARINADE_PROGRAM_VERSION = 3; // verified 2026-10-05: program logs VERSION:"3.1.1"

export type RunOptions = { rpcUrl: string; offline: boolean; record: boolean; outDir: string; fixturesDir: string };

export function runOptions(partial: Partial<RunOptions> = {}): RunOptions {
  return {
    rpcUrl: partial.rpcUrl ?? process.env.LINCHPIN_RPC_URL ?? DEFAULT_RPC_URL,
    offline: partial.offline ?? process.env.LINCHPIN_OFFLINE === "1",
    record: partial.record ?? false,
    outDir: partial.outDir ?? "out",
    fixturesDir: partial.fixturesDir ?? "fixtures",
  };
}
