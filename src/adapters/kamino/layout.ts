import { PublicKey } from "@solana/web3.js";
import { sha256 } from "../../chain/evidence";
import { KVAULT_PROGRAM, KLEND_PROGRAM, SQUADS_PROGRAM, UPGRADEABLE_LOADER, isConfiguredKey } from "./constants";

export interface AccountRecord { owner: string; executable: boolean; data: [string, "base64"]; lamports?: number; rentEpoch?: number; space?: number }
export interface DecodeFailure { ok: false; reason: string }
export const isDecodeFailure = (value: unknown): value is DecodeFailure => !!value && typeof value === "object" && "ok" in value && value.ok === false;
export const OFFSETS = Object.freeze({
  vault: { length: 62552, vaultAdminAuthority: 8, tokenMint: 80, tokenMintDecimals: 112, sharesMint: 184, sharesMintDecimals: 216, tokenAvailable: 224, sharesIssued: 232, unallocatedWeight: 248, performanceFeeBps: 256, managementFeeBps: 264, pendingFeesSf: 296, allocations: 312, allocationStride: 2160, allocationCount: 25, minWithdrawAmount: 58416, name: 58528, unallocatedTokensCap: 58640, allocationAdmin: 58648, withdrawalPenaltyLamports: 58680, withdrawalPenaltyBps: 58688 },
  reserve: { length: 8624, lastUpdateSlot: 16, lendingMarket: 32, mintPubkey: 128, totalAvailableAmount: 224, borrowedAmountSf: 232, mintDecimals: 272, accumulatedProtocolFeesSf: 344, accumulatedReferrerFeesSf: 360, pendingReferrerFeesSf: 376, collateralMint: 2560, collateralMintTotalSupply: 2592, protocolTakeRatePct: 4870, scopePriceFeed: 5112, scopePriceChain: 5144, switchboardPrice: 5160, switchboardTwap: 5192, pythPrice: 5224, withdrawalCapCapacity: 5416, withdrawalCapIntervalSeconds: 5440 },
  market: { length: 4664, lendingMarketOwner: 24, name: 3248 },
});
export function accountBytes(account: unknown): Buffer {
  if (!account || typeof account !== "object") throw new Error("missing account");
  const a = account as AccountRecord;
  if (typeof a.owner !== "string" || typeof a.executable !== "boolean" || !Array.isArray(a.data) || a.data.length !== 2 || a.data[1] !== "base64" || typeof a.data[0] !== "string") throw new Error("invalid account shape");
  new PublicKey(a.owner);
  const data = Buffer.from(a.data[0], "base64");
  if (data.toString("base64") !== a.data[0]) throw new Error("invalid base64");
  return data;
}
const key = (b: Buffer, offset: number) => new PublicKey(b.subarray(offset, offset + 32)).toBase58();
const u128 = (b: Buffer, offset: number) => b.readBigUInt64LE(offset) + (b.readBigUInt64LE(offset + 8) << 64n);
function checked(account: unknown, owner: string, size: number, name: string) {
  const b = accountBytes(account);
  if ((account as AccountRecord).owner !== owner || b.length !== size || !b.subarray(0, 8).equals(Buffer.from(sha256(`account:${name}`), "hex").subarray(0, 8))) throw new Error(`invalid ${name} owner, length or discriminator`);
  return b;
}
function decode<T>(fn: () => T): T | DecodeFailure { try { return fn(); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : "invalid account" }; } }
export function printableName(b: Buffer): string | null {
  try { const s = new TextDecoder("utf-8", { fatal: true }).decode(b).replace(/\0+$/, ""); return s.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(s) ? s : null; } catch { return null; }
}
export interface VaultAllocation { reserve: string; ctokenVault: string; targetAllocationWeight: bigint; ctokenAllocation: bigint; lastInvestSlot: bigint }
export function decodeVault(account: unknown) { return decode(() => {
  const b = checked(account, KVAULT_PROGRAM, 62552, "VaultState");
  const allocations: VaultAllocation[] = [];
  for (let i = 0; i < 25; i++) { const o = 312 + 2160 * i; const reserve = key(b, o); if (isConfiguredKey(reserve)) allocations.push({ reserve, ctokenVault: key(b, o + 32), targetAllocationWeight: b.readBigUInt64LE(o + 64), ctokenAllocation: b.readBigUInt64LE(o + 1104), lastInvestSlot: b.readBigUInt64LE(o + 1112) }); }
  const tokenMintDecimals = Number(b.readBigUInt64LE(112)), sharesMintDecimals = Number(b.readBigUInt64LE(216));
  if (tokenMintDecimals > 18 || sharesMintDecimals > 18) throw new Error("unsupported decimals");
  return { vaultAdminAuthority: key(b, 8), tokenMint: key(b, 80), tokenMintDecimals, sharesMint: key(b, 184), sharesMintDecimals, tokenAvailable: b.readBigUInt64LE(224), sharesIssued: b.readBigUInt64LE(232), unallocatedWeight: b.readBigUInt64LE(248), performanceFeeBps: b.readBigUInt64LE(256), managementFeeBps: b.readBigUInt64LE(264), pendingFeesSf: u128(b, 296), allocations, minWithdrawAmount: b.readBigUInt64LE(58416), name: printableName(b.subarray(58528, 58568)), unallocatedTokensCap: b.readBigUInt64LE(58640), allocationAdmin: key(b, 58648), withdrawalPenaltyLamports: b.readBigUInt64LE(58680), withdrawalPenaltyBps: b.readBigUInt64LE(58688) };
}); }
export type VaultState = Exclude<ReturnType<typeof decodeVault>, DecodeFailure>;
export function decodeReserve(account: unknown) { return decode(() => {
  const b = checked(account, KLEND_PROGRAM, 8624, "Reserve");
  const mintDecimals = Number(b.readBigUInt64LE(272)); if (mintDecimals > 18) throw new Error("unsupported decimals");
  const scope = { priceFeed: key(b, 5112), priceChain: Array.from({ length: 4 }, (_, i) => b.readUInt16LE(5144 + i * 2)) };
  const switchboard = { priceAggregator: key(b, 5160), twapAggregator: key(b, 5192) }, pyth = { price: key(b, 5224) };
  return { lastUpdateSlot: b.readBigUInt64LE(16), lendingMarket: key(b, 32), mintPubkey: key(b, 128), mintDecimals, totalAvailableAmount: b.readBigUInt64LE(224), borrowedAmountSf: u128(b, 232), accumulatedProtocolFeesSf: u128(b, 344), accumulatedReferrerFeesSf: u128(b, 360), pendingReferrerFeesSf: u128(b, 376), collateralMint: key(b, 2560), collateralMintTotalSupply: b.readBigUInt64LE(2592), protocolTakeRatePct: b[4870]!, withdrawalCapCapacity: b.readBigInt64LE(5416), withdrawalCapIntervalSeconds: b.readBigUInt64LE(5440), scope, switchboard, pyth, oracleKeys: [...new Set([scope.priceFeed, switchboard.priceAggregator, switchboard.twapAggregator, pyth.price].filter(isConfiguredKey))] };
}); }
export type ReserveState = Exclude<ReturnType<typeof decodeReserve>, DecodeFailure>;
export function decodeMarket(account: unknown) { return decode(() => { const b = checked(account, KLEND_PROGRAM, 4664, "LendingMarket"); return { lendingMarketOwner: key(b, 24), name: printableName(b.subarray(3248, 3280)) }; }); }
export function programDataAddress(program: string) { return PublicKey.findProgramAddressSync([new PublicKey(program).toBuffer()], new PublicKey(UPGRADEABLE_LOADER))[0].toBase58(); }
export function decodeProgram(account: unknown, address: string) { return decode(() => {
  const b = accountBytes(account), a = account as AccountRecord;
  if (a.owner !== UPGRADEABLE_LOADER || !a.executable || b.length < 36 || b.readUInt32LE(0) !== 2) throw new Error("invalid program");
  const programData = key(b, 4); if (programData !== programDataAddress(address)) throw new Error("programdata PDA mismatch");
  return { programData };
}); }
export function decodeProgramDataHead(account: unknown) { return decode(() => {
  const b = accountBytes(account);
  if ((account as AccountRecord).owner !== UPGRADEABLE_LOADER || b.length < 13 || b.readUInt32LE(0) !== 3 || (b[12] !== 0 && b[12] !== 1) || b[12] === 1 && b.length < 45) throw new Error("invalid programdata head");
  return { slot: b.readBigUInt64LE(4), upgradeAuthority: b[12] === 0 ? null : key(b, 13) };
}); }
export function decodeSquadsMultisig(account: unknown) { return decode(() => {
  const b = accountBytes(account);
  if ((account as AccountRecord).owner !== SQUADS_PROGRAM || b.length < 100 || !b.subarray(0, 8).equals(Buffer.from(sha256("account:Multisig"), "hex").subarray(0, 8))) throw new Error("not a Squads v4 Multisig");
  const tag = b[94]; if (tag !== 0 && tag !== 1) throw new Error("invalid rent collector option");
  const offset = tag === 0 ? 95 : 127, count = b.readUInt32LE(offset + 1);
  if (count > 1000 || b.length < offset + 5 + count * 33) throw new Error("invalid members length");
  const members = Array.from({ length: count }, (_, i) => ({ key: key(b, offset + 5 + i * 33), permissions: b[offset + 37 + i * 33]! }));
  const threshold = b.readUInt16LE(72); if (threshold < 1 || threshold > count || new Set(members.map(m => m.key)).size !== count) throw new Error("invalid members or threshold");
  return { configAuthority: key(b, 40), threshold, members };
}); }
