import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { canonical, sha256 } from "../../chain/evidence";
import { deriveLiquidStakingAddresses, LIQUID_STAKING_PROGRAM } from "../../pack/derive";
import type { EvidenceReceipt, Fact } from "../contracts";
import { validateSnapshot, type EvidenceSnapshot } from "./snapshot";

/** Declared freshness policy; not a claim that account state remains valid for 24 hours. */
export const PUBLIC_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const PROGRAM = LIQUID_STAKING_PROGRAM.toBase58();
const MNDE = "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const identity = (address: string) => `solana:mainnet-beta:${address}`;
function requireFixture(ok: unknown): asserts ok { if (!ok) throw new Error("Invalid recorded Marinade capture"); }
function readCapture(root: string, dir: string, key: string, address: string) {
  const file = join(root, dir, `${key}.json`);
  const fixture = JSON.parse(existsSync(file) ? readFileSync(file, "utf8") : gunzipSync(readFileSync(`${file}.gz`)).toString("utf8"));
  requireFixture(fixture.method === "getAccountInfo" && fixture.params?.pubkey === address);
  requireFixture(sha256(canonical(fixture.response)) === fixture.responseSha256);
  const slot: number | null = fixture.slot ?? null;
  requireFixture(slot === null || Number.isSafeInteger(slot) && slot >= 0);
  const observedAt = fixture.retrievedAt;
  const receipt: EvidenceReceipt = {
    id: sha256(canonical({ method: fixture.method, params: fixture.params, responseSha256: fixture.responseSha256, slot, observedAt })),
    source: `fixture:${dir}/${key}`, responseSha256: fixture.responseSha256, privacy: "public",
    observation: { chain: "solana", network: "mainnet-beta", blockOrSlot: slot === null ? null : String(slot), blockHash: null,
      observedAt, retrievedAt: observedAt, historicalState: "current-only" },
  };
  requireFixture(typeof fixture.response?.data === "string");
  return { receipt, account: fixture.response as { owner: string; executable: boolean; data: string }, data: Buffer.from(fixture.response.data, "base64") };
}
function authority(data: Buffer, offset: number): string {
  const flag = data.readUInt32LE(offset); requireFixture(flag === 0 || flag === 1);
  return flag === 0 ? "none" : identity(new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58());
}

/** Decode local recorded bytes only. Capture endpoints are neither read into receipts nor contacted. */
export function buildMarinadeSnapshots(fixturesRoot = "fixtures"): EvidenceSnapshot[] {
  return ([ ["marinade-pack", "2026-10-05"], ["marinade-contracts", "2026-10-06"] ] as const).map(([dir, date]) => {
    const p = readCapture(fixturesRoot, dir, "getAccountInfo-0575a5f60ef2", PROGRAM);
    requireFixture(p.account.owner === LOADER && p.account.executable === true && p.data.length >= 36 && p.data.readUInt32LE(0) === 2);
    const programData = new PublicKey(p.data.subarray(4, 36)).toBase58();
    const d = readCapture(fixturesRoot, dir, "getAccountInfo-706568e6546e", programData);
    requireFixture(d.account.owner === LOADER && d.data.length >= 45 && d.data.readUInt32LE(0) === 3 && (d.data[12] === 0 || d.data[12] === 1));
    const mnde = readCapture(fixturesRoot, dir, "getAccountInfo-9a435fb17148", MNDE);
    const msol = readCapture(fixturesRoot, dir, "getAccountInfo-ba300a779c0c", MSOL);
    const receipts = [p.receipt, d.receipt, mnde.receipt, msol.receipt].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const facts: Fact[] = [];
    const add = (address: string, predicate: string, object: string, evidence: EvidenceReceipt[], basis: Fact["basis"] = "decoded") => {
      const fields = { subject: identity(address), predicate, object, basis, status: "verified" as const,
        evidenceIds: evidence.map(r => r.id).sort(), path: [], validFrom: null, validTo: null, privacy: "public" as const };
      facts.push({ id: sha256(canonical(fields)), ...fields });
    };
    add(PROGRAM, "PROGRAM_DATA", identity(programData), [p.receipt]);
    add(PROGRAM, "UPGRADE_AUTHORITY", d.data[12] === 1 ? identity(new PublicKey(d.data.subarray(13, 45)).toBase58()) : "none", [p.receipt, d.receipt]);
    for (const [address, mint] of [[MNDE, mnde], [MSOL, msol]] as const) {
      requireFixture(mint.account.owner === TOKEN && mint.data.length === 82 && mint.data[45] === 1);
      add(address, "MINT_AUTHORITY", authority(mint.data, 0), [mint.receipt]);
      add(address, "FREEZE_AUTHORITY", authority(mint.data, 46), [mint.receipt]);
      add(address, "SUPPLY_RAW", `amount:${mint.data.readBigUInt64LE(36)}`, [mint.receipt]);
    }
    const derived = deriveLiquidStakingAddresses().find(a => a.seed === "st_mint")!;
    requireFixture(authority(msol.data, 0) === identity(derived.address) && derived.program === PROGRAM);
    add(MSOL, "ISSUED_BY_PROGRAM", identity(PROGRAM), [msol.receipt, p.receipt], "derived");
    const times = receipts.map(r => r.observation.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    const slots = receipts.map(r => r.observation.blockOrSlot).filter((s): s is string => s !== null).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    const subjects = [PROGRAM, programData, MNDE, MSOL].map(identity).sort();
    return validateSnapshot({ version: 1, id: `solana-mainnet-beta.marinade.${date}`, chain: "solana", network: "mainnet-beta", constructed: false,
      observedFrom: times[0], observedTo: times[times.length - 1], fromBlockOrSlot: slots[0] ?? null, toBlockOrSlot: slots[slots.length - 1] ?? null,
      freshUntil: new Date(Date.parse(times[times.length - 1]) + PUBLIC_FRESHNESS_MS).toISOString(), subjects,
      readers: [{ id: "recorded-marinade-accounts", status: "complete", subjects: [...subjects] }],
      names: { [identity(PROGRAM)]: "Marinade liquid staking", [identity(MNDE)]: "MNDE", [identity(MSOL)]: "mSOL" },
      receipts, facts: facts.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
  });
}
