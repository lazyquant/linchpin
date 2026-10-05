import { expect, test } from "bun:test";
import { deriveLiquidStakingAddresses } from "../src/pack/derive";

test("liquid-staking candidates reproduce the printed addresses and bumps deterministically", () => {
  const candidates = deriveLiquidStakingAddresses();
  expect(deriveLiquidStakingAddresses()).toEqual(candidates);
  expect(candidates.map(({ seed, address, bump }) => [seed, address, bump])).toEqual([
    ["st_mint", "3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM", 253],
    ["liq_mint", "HZsepB79dnpvH6qfVgvMpS738EndHw3qSHo4Gv5WX1KA", 255],
    ["withdraw", "9eG63CdHjsfhHmobHgLtESGC8GabbmRcaSpHAZrtmhco", 255],
    ["reserve", "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN", 255],
    ["deposit", "4bZ6o3eUUNXhKuqjdCnCoPAoLgWiuLYixKaxoa8PpiKk", 255],
    ["liq_sol", "UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q", 254],
    ["liq_st_sol", "CgWRmpveS9MVdo384zfxfteSKPc3TkqVeQUdF9Ccaf9Z", 251],
  ]);
});
