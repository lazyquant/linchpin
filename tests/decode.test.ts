import { describe, expect, test } from "bun:test";
import { ASSOCIATED_TOKEN_PROGRAM, decodeInstruction } from "../src/governance/decode";
const acc = (pubkey: string, isSigner = false, isWritable = true) => ({ pubkey, isSigner, isWritable });

describe("decodeInstruction", () => {
  test("associated token creates decode all six accounts and distinguish idempotence", () => {
    const ix = { programId: ASSOCIATED_TOKEN_PROGRAM, accounts: [acc("payer"), acc("account"), acc("owner"), acc("mint"), acc("system"), acc("token")] };
    for (const dataHex of ["", "00", "01"]) {
      expect(decodeInstruction({ ...ix, dataHex })).toMatchObject({ kind: "createAccount", program: ASSOCIATED_TOKEN_PROGRAM, account: "account", owner: "owner", mint: "mint", payer: "payer", idempotent: dataHex === "01" });
    }
    expect(decodeInstruction({ ...ix, dataHex: "02" })).toMatchObject({ kind: "unsupported", reason: "recover nested not supported" });
    expect(decodeInstruction({ ...ix, dataHex: "0100" }).kind).toBe("unsupported");
    expect(decodeInstruction({ ...ix, dataHex: "01", accounts: ix.accounts.slice(0, 5) }).kind).toBe("unsupported");
  });
  test("MIP-14 burn: discriminator 8, amount 3e17 raw", () => {
    const d = decodeInstruction({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "0800009e1869d02904", accounts: [acc("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi"), acc("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"), acc("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG", true, false)] });
    expect(d.kind).toBe("burn");
    if (d.kind !== "burn") throw new Error();
    expect(d.amountRaw).toBe(300000000000000000n);
    expect(d.source).toBe("GR1LBT4cU89cJWE74CP6BsJTf2kriQ9TX59tbDsfxgSi");
    expect(d.mint).toBe("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey");
    expect(d.authority).toBe("B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG");
    expect(d.decoderVersion).toBe("spl-token-legacy@1");
  });
  test("transferChecked: amount then decimals", () => {
    const d = decodeInstruction({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "0c" + "e803000000000000" + "06", accounts: [acc("S"), acc("M"), acc("D"), acc("A", true)] });
    expect(d).toMatchObject({ kind: "transfer", amountRaw: 1000n, decimals: 6, source: "S", mint: "M", destination: "D", authority: "A" });
  });
  test("setAuthority is a control change", () => {
    const d = decodeInstruction({ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataHex: "06" + "00" + "01" + "11".repeat(32), accounts: [acc("M"), acc("A", true)] });
    expect(d).toMatchObject({ kind: "setAuthority", authorityType: "mintTokens", target: "M", currentAuthority: "A" });
  });
  test("unknown program stays unsupported, never guessed", () => {
    const d = decodeInstruction({ programId: "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", dataHex: "00", accounts: [] });
    expect(d.kind).toBe("unsupported");
  });
});
