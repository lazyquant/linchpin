export interface VaultTarget { readonly vault: string; readonly tokenMint: string; readonly kvaultProgram: string }
export type VaultSlug = "sentora-pyusd" | "rwa-usdc" | "steakhouse-hy-usdg" | "kamino-commodity-yield" | "ethena-pyusd-prime" | "allez-sol";
export const VAULT_TARGETS: Readonly<Record<VaultSlug, VaultTarget>> = Object.freeze({
  "sentora-pyusd": Object.freeze({ vault: "A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK", tokenMint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", kvaultProgram: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" }),
  "rwa-usdc": Object.freeze({ vault: "DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP", tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", kvaultProgram: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" }),
  "steakhouse-hy-usdg": Object.freeze({ vault: "BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5", tokenMint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", kvaultProgram: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" }),
  "kamino-commodity-yield": Object.freeze({ vault: "B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6", tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", kvaultProgram: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" }),
  "ethena-pyusd-prime": Object.freeze({ vault: "4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf", tokenMint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", kvaultProgram: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" }),
  "allez-sol": Object.freeze({ vault: "A1so1bPD3W1TfeFwboDh8yfAAVaVtcdAYBYCjhg2mJQ", tokenMint: "So11111111111111111111111111111111111111112", kvaultProgram: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd" }),
});
export const KAMINO_TARGET = VAULT_TARGETS["sentora-pyusd"];
export function isVaultSlug(value: string): value is VaultSlug { return Object.hasOwn(VAULT_TARGETS, value); }
export const KVAULT_PROGRAM = KAMINO_TARGET.kvaultProgram;
export const KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
export const SQUADS_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const NULL_PUBKEY = "nu11111111111111111111111111111111111111111";
export const SCOPE_CHAIN_UNUSED = 65535;
export const LAYOUT_SOURCES = Object.freeze([
  "Kamino-Finance/klend-sdk@6a26d6f1b5afb29953ffd139ee8c0c4ca5f26ce6/src/idl/kvault.json",
  "Kamino-Finance/klend-sdk@6a26d6f1b5afb29953ffd139ee8c0c4ca5f26ce6/src/idl/klend.json",
  "Kamino-Finance/klend-sdk@6a26d6f1b5afb29953ffd139ee8c0c4ca5f26ce6/src/utils/pubkey.ts",
  "Squads-Protocol/v4@af94153ff77a28b6effe46b9c94baaa93742b48c/programs/squads_multisig_program/src/state/multisig.rs",
]);
export const isConfiguredKey = (key: string) => key !== SYSTEM_PROGRAM && key !== NULL_PUBKEY;
export const identity = (key: string) => `solana:mainnet-beta:${key}`;
export const METRIC_KEYS = ["apy", "apyTheoretical", "apyActual", "apyFarmRewards", "apyIncentives", "apyReservesIncentives", "apy24h", "apy7d", "apy14d", "apy30d", "apy90d", "apy180d", "apy365d"] as const;
