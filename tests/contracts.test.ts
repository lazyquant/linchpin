import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { BorshReader } from "../src/contracts/borsh";
import { accountDiscriminator, decodeAccount, decodeAccountAs, toPlain } from "../src/contracts/decode";
import { idlAddress, readOnChainIdl, type IdlType, type LegacyIdl } from "../src/contracts/idl";
import { instructionInventory, parameterControl, readableType } from "../src/contracts/inventory";
import { RecordingRpc } from "../src/chain/rpc";
import { runOptions } from "../src/config";
import { sha256 } from "../src/chain/evidence";

const vectorBytes = readFileSync(new URL("./vectors/idl/liquid-staking.json", import.meta.url));
const liquid: LegacyIdl = JSON.parse(vectorBytes.toString());
const key = new PublicKey(Buffer.alloc(32, 17));
const empty: LegacyIdl = { name: "synthetic", version: "0", instructions: [] };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const read = (type: IdlType, data: Buffer) => new BorshReader(empty, data).read(type, "State.field");

describe("legacy Borsh", () => {
  test.each([
    ["bool", "01", true], ["bool", "00", false], ["u8", "ff", 255], ["i8", "fe", -2],
    ["u16", "3412", 0x1234], ["i16", "feff", -2], ["u32", "78563412", 0x12345678], ["i32", "feffffff", -2],
    ["u64", "ffffffffffffffff", 2n ** 64n - 1n], ["i64", "feffffffffffffff", -2n],
    ["u128", "ffffffffffffffffffffffffffffffff", 2n ** 128n - 1n], ["i128", "00000000000000000000000000000080", -(2n ** 127n)],
    ["i128", "feffffffffffffffffffffffffffffff", -2n], ["i128", "01000000000000000000000000000000", 1n],
    ["f32", "0000c03f", 1.5], ["f64", "00000000000002c0", -2.25],
  ] as const)("reads %s from %s", (type, hex, expected) => { expect(read(type, Buffer.from(hex, "hex"))).toBe(expected); });

  test("length-prefixed UTF-8, bytes and public keys", () => {
    const text = Buffer.from("žluťoučký");
    expect(read("string", Buffer.concat([u32(text.length), text]))).toBe("žluťoučký");
    expect(read("bytes", Buffer.from("030000000080ff", "hex"))).toEqual(Buffer.from([0, 128, 255]));
    expect(read("publicKey", key.toBuffer())).toEqual(key);
  });

  test("nested structs, vectors, arrays, option and four-byte coption tags", () => {
    const idl: LegacyIdl = { ...empty, types: [
      { name: "Inner", type: { kind: "struct", fields: [{ name: "amount", type: "u128" }] } },
      { name: "Outer", type: { kind: "struct", fields: [
        { name: "nested", type: { defined: "Inner" } }, { name: "items", type: { vec: "i16" } },
        { name: "fixed", type: { array: ["u8", 2] } }, { name: "some", type: { option: "u32" } },
        { name: "none", type: { option: "u8" } }, { name: "csome", type: { coption: "i8" } },
        { name: "cnone", type: { coption: "u64" } }, { name: "sentinel", type: "u8" },
      ] } },
    ] };
    const data = Buffer.concat([Buffer.from("01000000000000000200000000000000", "hex"), u32(2), Buffer.from("feff0300040501", "hex"), u32(42), Buffer.from([0]), u32(1), Buffer.from([255]), u32(0), Buffer.from([77])]);
    const reader = new BorshReader(idl, data);
    expect(reader.read({ defined: "Outer" }, "root")).toEqual({ nested: { amount: (2n << 64n) + 1n }, items: [-2, 3], fixed: [4, 5], some: 42, none: null, csome: -1, cnone: null, sentinel: 77 });
    expect(reader.offset).toBe(data.length);
  });

  test("enum unit, named fields and tuple fields including nested definitions", () => {
    const idl: LegacyIdl = { ...empty, types: [
      { name: "Inner", type: { kind: "struct", fields: [{ name: "yes", type: "bool" }] } },
      { name: "Choice", type: { kind: "enum", variants: [{ name: "Unit" }, { name: "Named", fields: [{ name: "item", type: { defined: "Inner" } }] }, { name: "Tuple", fields: ["u16", { option: "i8" }] }] } },
    ] };
    expect(new BorshReader(idl, Buffer.from([0])).read({ defined: "Choice" })).toEqual({ variant: "Unit" });
    expect(new BorshReader(idl, Buffer.from([1, 1])).read({ defined: "Choice" })).toEqual({ variant: "Named", fields: { item: { yes: true } } });
    expect(new BorshReader(idl, Buffer.from([2, 9, 0, 1, 254])).read({ defined: "Choice" })).toEqual({ variant: "Tuple", fields: [9, -2] });
    expect(() => new BorshReader(idl, Buffer.from([3])).read({ defined: "Choice" }, "State.choice")).toThrow("State.choice: unknown enum variant index 3");
    expect(() => new BorshReader(idl, Buffer.from([1])).read({ defined: "Choice" }, "State.choice")).toThrow("State.choice.Named.item.yes: read past end");
    expect(() => new BorshReader(idl, Buffer.from([2, 9, 0, 1])).read({ defined: "Choice" }, "State.choice")).toThrow("State.choice.Tuple[1]: read past end");
  });

  test.each([
    ["u64", "", "read past end"], ["bool", "02", "invalid bool"], [{ option: "u8" }, "02", "invalid option"],
    [{ coption: "u8" }, "00010000", "invalid coption"], [{ vec: "u64" }, "01000000", "State.field[0]: read past end"],
    [{ array: ["u32", 1] }, "0000", "State.field[0]: read past end"], [{ defined: "Missing" }, "", "unknown defined type Missing"],
    ["unknown", "", "unknown type"], [{ map: "u8" }, "", "unknown type"], ["bytes", "ffffffff", "read past end"],
    ["string", "01000000ff", "invalid UTF-8"], ["f32", "0000807f", "non-finite"], [{ vec: "u8" }, "ffffffff", "collection length"],
  ])("errors identify the field for %j", (type, hex, message) => {
    const fn = () => read(type as IdlType, Buffer.from(hex as string, "hex"));
    expect(fn).toThrow("State.field"); expect(fn).toThrow(message as string);
  });

  test("recursive malformed types fail with a field path", () => {
    const idl: LegacyIdl = { ...empty, types: [{ name: "Loop", type: { kind: "struct", fields: [{ name: "next", type: { defined: "Loop" } }] } }] };
    expect(() => new BorshReader(idl, Buffer.alloc(0)).read({ defined: "Loop" }, "root")).toThrow(/root.next.*nesting/);
  });
});

describe("account decoding and JSON values", () => {
  test("known independent Anchor discriminators", () => {
    expect(accountDiscriminator("State").toString("hex")).toBe("d8926b5e684bb6b1");
    expect(accountDiscriminator("Registrar").toString("hex")).toBe("c1cacd334ea89680");
  });
  test("dispatch, mismatch, bytes consumed and trailing allocation", () => {
    const idl: LegacyIdl = { ...empty, accounts: [{ name: "State", type: { kind: "struct", fields: [{ name: "counter", type: "u64" }] } }] };
    const data = Buffer.from("d8926b5e684bb6b12a00000000000000000000", "hex");
    expect(decodeAccount(idl, data)).toEqual({ type: "State", value: { counter: 42n }, bytesRead: 16, trailingBytes: 3 });
    expect(() => decodeAccountAs(idl, "State", Buffer.alloc(8))).toThrow("discriminator mismatch");
    expect(() => decodeAccountAs(idl, "Missing", data)).toThrow("unknown account");
    expect(() => decodeAccount(idl, Buffer.alloc(0))).toThrow("unknown discriminator");
    expect(() => decodeAccountAs(idl, "State", data.subarray(0, 10))).toThrow("State.counter: read past end");
  });
  test("plain values preserve exact integers and encode keys/bytes before Buffer.toJSON", () => {
    expect(toPlain({ integer: 2n ** 128n - 1n, key, bytes: Buffer.from([0, 128, 255]), array: [new Uint8Array([1, 2]), null, true], absent: undefined }))
      .toEqual({ integer: "340282366920938463463374607431768211455", key: key.toBase58(), bytes: "AID/", array: ["AQI=", null, true] });
    expect(() => toPlain(NaN)).toThrow("JSON-safe");
  });
});

describe("on-chain IDL", () => {
  const header = (compressed: Buffer) => {
    const h = Buffer.alloc(44); key.toBuffer().copy(h, 8); h.writeUInt32LE(compressed.length, 40);
    return Buffer.concat([h, compressed, Buffer.alloc(16)]);
  };
  const stub = (data: Buffer | null, owner = key) => {
    const rpc = new RecordingRpc(runOptions({ rpcUrl: "http://127.0.0.1:1", offline: false, record: false, minIntervalMs: 0 }), "idl-test");
    rpc.connection.getAccountInfoAndContext = async pubkey => {
      expect(pubkey).toEqual(await idlAddress(key));
      return { context: { slot: 42 }, value: data ? { data, owner, executable: false, lamports: 1, rentEpoch: 0 } : null };
    };
    return rpc;
  };
  test("derives Anchor address and round-trips the liquid-staking vector with hash of exact JSON bytes", async () => {
    const expected = await PublicKey.createWithSeed(PublicKey.findProgramAddressSync([], key)[0], "anchor:idl", key);
    expect(await idlAddress(key)).toEqual(expected);
    const compressed = deflateSync(vectorBytes);
    const rpc = stub(header(compressed));
    const result = await readOnChainIdl(rpc, key);
    expect(result).toMatchObject({ kind: "idl", program: key.toBase58(), idlAddress: expected.toBase58(), authority: key.toBase58(), idl: liquid, idlSha256: sha256(vectorBytes), dataLength: compressed.length, slot: 42, evidenceIds: [rpc.evidence[0].id] });
    expect(sha256(vectorBytes)).not.toBe(sha256(JSON.stringify(liquid)));
  });
  test("missing account is no-idl with evidence", async () => {
    const rpc = stub(null);
    expect(await readOnChainIdl(rpc, key)).toMatchObject({ kind: "no-idl", evidenceIds: [rpc.evidence[0]?.id ?? expect.any(String)], slot: 42 });
  });
  test("truncated, invalid compression/JSON/shape and wrong-owner accounts fail clearly", async () => {
    await expect(readOnChainIdl(stub(Buffer.alloc(43)), key)).rejects.toThrow("truncated header");
    const badLength = Buffer.alloc(44); badLength.writeUInt32LE(10, 40);
    await expect(readOnChainIdl(stub(badLength), key)).rejects.toThrow("compressed length");
    await expect(readOnChainIdl(stub(header(Buffer.from("garbage"))), key)).rejects.toThrow("inflate failed");
    await expect(readOnChainIdl(stub(header(deflateSync(Buffer.from("{bad")))), key)).rejects.toThrow("JSON parsing failed");
    await expect(readOnChainIdl(stub(header(deflateSync(Buffer.from("{}")))), key)).rejects.toThrow("legacy IDL structure");
    await expect(readOnChainIdl(stub(header(deflateSync(vectorBytes)), PublicKey.default), key)).rejects.toThrow("unexpected owner");
  });
});

describe("instruction inventory and inferred control", () => {
  test("nested account groups keep dotted signer roles", () => {
    const idl: LegacyIdl = { ...empty, instructions: [{ name: "configure", args: [{ name: "data", type: { vec: { option: { array: ["u64", 2] } } } }], accounts: [
      { name: "group", accounts: [{ name: "nested", accounts: [{ name: "authority", isSigner: true, isMut: false }] }, { name: "state", isSigner: false, isMut: true }] },
    ] }] };
    expect(instructionInventory(idl)[0]).toEqual({ name: "configure", args: [{ name: "data", type: "Vec<Option<[u64; 2]>>" }], accounts: [{ name: "group.nested.authority", isSigner: true, isMut: false }, { name: "group.state", isSigner: false, isMut: true }], signerRoles: ["group.nested.authority"] });
    expect(readableType({ coption: { defined: "SomeStruct" } })).toBe("COption<SomeStruct>");
  });
  test("liquid-staking authority and fee aliases, with unmatched arguments retained", () => {
    const inventory = instructionInventory(liquid);
    for (const name of ["configMarinade", "changeAuthority"]) expect(inventory.find(i => i.name === name)?.signerRoles).toEqual(["adminAuthority"]);
    const control = parameterControl(liquid, "State");
    expect(control.links.filter(l => l.instruction === "changeAuthority").map(l => [l.argPath, l.stateField])).toEqual([
      ["data.admin", "adminAuthority"], ["data.validatorManager", "validatorSystem.managerAuthority"], ["data.operationalSolAccount", "operationalSolAccount"],
      ["data.treasuryMsolAccount", "treasuryMsolAccount"], ["data.pauseAuthority", "pauseAuthority"],
    ]);
    expect(control.links).toContainEqual({ instruction: "configMarinade", argPath: "params.rewardsFee", stateField: "rewardFee", signerRoles: ["adminAuthority"], basis: "inferred" });
    expect(control.links).toContainEqual({ instruction: "configMarinade", argPath: "params.liquiditySolCap", stateField: "liqPool.liquiditySolCap", signerRoles: ["adminAuthority"], basis: "inferred" });
    expect(control.unmatched).toContainEqual(expect.objectContaining({ instruction: "changeAuthority", argPath: "data", reason: "no matching state field" }));
    expect(control.unmatched.some(a => a.instruction === "deposit" && a.argPath === "lamports")).toBe(true);
  });
  test("normalizes case/underscores and reports ambiguous fields", () => {
    const idl: LegacyIdl = { ...empty, instructions: [{ name: "set", accounts: [], args: [{ name: "rEwArD_fEE", type: "u8" }, { name: "value", type: "u8" }, { name: "absent", type: "u8" }] }],
      accounts: [{ name: "State", type: { kind: "struct", fields: [{ name: "rewardFee", type: "u8" }, { name: "a", type: { defined: "Nested" } }, { name: "b", type: { defined: "Nested" } }] } }],
      types: [{ name: "Nested", type: { kind: "struct", fields: [{ name: "value", type: "u8" }] } }] };
    const control = parameterControl(idl, "State");
    expect(control.links[0].stateField).toBe("rewardFee");
    expect(control.unmatched[0]).toMatchObject({ argPath: "value", reason: "ambiguous state field", candidates: ["a.value", "b.value"] });
    expect(control.unmatched[1].argPath).toBe("absent");
  });
  test("all nine spike IDLs can be inventoried as test inputs", () => {
    const files = readdirSync(new URL("./vectors/idl/", import.meta.url)).filter(f => f.endsWith(".json"));
    expect(files).toHaveLength(9);
    for (const file of files) {
      const idl: LegacyIdl = JSON.parse(readFileSync(new URL(`./vectors/idl/${file}`, import.meta.url), "utf8"));
      expect(instructionInventory(idl)).toHaveLength(idl.instructions.length);
    }
  });
});
