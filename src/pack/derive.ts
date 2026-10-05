import { PublicKey } from "@solana/web3.js";

export const LIQUID_STAKING_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
export const LIQUID_STAKING_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const seeds = ["st_mint", "liq_mint", "withdraw", "reserve", "deposit", "liq_sol", "liq_st_sol"] as const;

/** Candidate seeds only: failure to match does not establish a different controller. */
export function deriveLiquidStakingAddresses() {
  return seeds.map(seed => {
    const [address, bump] = PublicKey.findProgramAddressSync(
      [LIQUID_STAKING_STATE.toBuffer(), Buffer.from(seed)], LIQUID_STAKING_PROGRAM,
    );
    return { seed, address: address.toBase58(), bump, program: LIQUID_STAKING_PROGRAM.toBase58() };
  });
}
