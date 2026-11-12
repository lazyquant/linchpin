/**
 * Independent tests for development-graph run 018-solana-economics-adapter.
 *
 * Expectations come from the approved spec, plan 018, the gate-1 decision record and
 * the recorded fixture bytes. Real-capture assertions are computed here from those
 * bytes at the plan's layout offsets; only constructed fixtures use literals.
 *
 * All tests run offline: globalThis.fetch is replaced with a thrower for the whole file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../src/chain/evidence";
import {
  CaptureRejected,
  buildKaminoSnapshots,
  loadCapture,
  normalizeCapture,
  orderSnapshots,
  parseIdleClaim,
  compareIdleClaim,
  validateMechanics,
  verifyCapture,
  RELATION_ENDPOINTS,
} from "../src/adapters/kamino/index";
import {
  buildMarinadeSnapshots,
  openStore,
  resultSha256,
  runQuery,
  validateSnapshot,
} from "../src/engine/queries/index";
import type { EvidenceSnapshot } from "../src/engine/queries/index";
import type { Fact, QueryResult } from "../src/engine/contracts";

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_CAPTURE = existsSync(join(import.meta.dir, "..", "scripts", "kamino-capture.ts"));

// ---------------------------------------------------------------------------
// Offline guarantee: no test may reach the network.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
  fetchCalls += 1;
  throw new Error("network disabled in solana-economics-adapter tests");
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ROOT = join(import.meta.dir, "..");
const KAMINO_ROOT = join(ROOT, "fixtures", "kamino");
const A_DIR = "sentora-pyusd-20261109T163416Z";
const B_DIR = "sentora-pyusd-20261109T170418Z";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(value: string): Buffer {
  let n = 0n;
  for (const ch of value) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`bad base58 char ${ch}`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of value) {
    if (ch === "1") out.unshift(0);
    else break;
  }
  return Buffer.from(out);
}
function b58encode(buf: Buffer): string {
  let n = buf.length === 0 ? 0n : BigInt("0x" + buf.toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}
const identity = (key: string) => `solana:mainnet-beta:${key}`;
const u64 = (b: Buffer, off: number) => b.readBigUInt64LE(off);
const u128 = (b: Buffer, off: number) => b.readBigUInt64LE(off) | (b.readBigUInt64LE(off + 8) << 64n);
const pubkeyAt = (b: Buffer, off: number) => b58encode(b.subarray(off, off + 32));
const SYSTEM = "11111111111111111111111111111111";
const NULL_SENTINEL = "nu11111111111111111111111111111111111111111";
const isConfigured = (key: string) => key !== SYSTEM && key !== NULL_SENTINEL;

interface RawCapture {
  manifest: Record<string, unknown> & { captureId: string; constructed: boolean; records: string[] };
  records: Record<string, Record<string, unknown>>;
}

function readRaw(dir: string): RawCapture {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as RawCapture["manifest"];
  const records: Record<string, Record<string, unknown>> = {};
  for (const file of manifest.records) records[file] = JSON.parse(readFileSync(join(dir, file), "utf8"));
  return { manifest, records };
}
const A_RAW = readRaw(join(KAMINO_ROOT, A_DIR));
const B_RAW = readRaw(join(KAMINO_ROOT, B_DIR));
const A = normalizeCapture(loadCapture(join(KAMINO_ROOT, A_DIR)));
const B = normalizeCapture(loadCapture(join(KAMINO_ROOT, B_DIR)));

const VAULT_KEY = String(A_RAW.manifest.target && (A_RAW.manifest.target as Record<string, unknown>).vault);
const VAULT = identity(VAULT_KEY);
const TOKEN_MINT = String((A_RAW.manifest.target as Record<string, unknown>).tokenMint);

function rpcValue(raw: RawCapture, file: string, key: string): unknown {
  const rec = raw.records[file]!;
  const params = rec.params as [string[], unknown];
  const response = rec.response as { value?: unknown[] };
  const idx = params[0].indexOf(key);
  if (idx < 0) throw new Error(`${key} not in ${file}`);
  return response.value![idx];
}
function rpcBytes(raw: RawCapture, file: string, key: string): Buffer {
  const value = rpcValue(raw, file, key) as { data: [string, string] };
  return Buffer.from(value.data[0], "base64");
}

const clone = <T>(value: T): T => structuredClone(value);

/** Deep copy of real A with the case's change, captureId=name, constructed=true, hashes recomputed. */
function mutate(caseName: string, change: (raw: RawCapture) => void): RawCapture {
  const raw = clone(A_RAW);
  raw.manifest.captureId = caseName;
  raw.manifest.constructed = true;
  change(raw);
  for (const file of raw.manifest.records) {
    const rec = raw.records[file]!;
    if (rec.kind === "rpc") rec.responseSha256 = sha256(canonical(rec.response));
    else rec.bodySha256 = sha256(String(rec.body));
  }
  return raw;
}
function normalizedMut(caseName: string, change: (raw: RawCapture) => void) {
  return normalizeCapture(verifyCapture(mutate(caseName, change)));
}

function validatePasses(snapshot: EvidenceSnapshot) {
  expect(() => validateSnapshot(snapshot)).not.toThrow();
}

const vaultAdminKey = () => pubkeyAt(rpcBytes(A_RAW, "rpc-state.json", VAULT_KEY), 8);
const allocationAdminKey = () => pubkeyAt(rpcBytes(A_RAW, "rpc-state.json", VAULT_KEY), 58648);
const allocationReserveKeys = (raw: RawCapture): string[] => {
  const vault = rpcBytes(raw, "rpc-state.json", VAULT_KEY);
  const keys: string[] = [];
  for (let i = 0; i < 25; i++) {
    const key = pubkeyAt(vault, 312 + 2160 * i);
    if (isConfigured(key)) keys.push(key);
  }
  return keys;
};
const sharesMintKey = () => pubkeyAt(rpcBytes(A_RAW, "rpc-state.json", VAULT_KEY), 184);
const sharesMint = () => identity(sharesMintKey());

/** The subject set AC1-4 says must hold, computed from the recorded bytes only. */
function unionSubjects(raw: RawCapture): string[] {
  const out = new Set<string>();
  const vault = rpcBytes(raw, "rpc-state.json", VAULT_KEY);
  out.add(identity(VAULT_KEY));
  out.add(identity(pubkeyAt(vault, 184)));
  for (const reserveKey of allocationReserveKeys(raw)) {
    out.add(identity(reserveKey));
    out.add(identity(pubkeyAt(rpcBytes(raw, "rpc-state.json", reserveKey), 32)));
  }
  out.add(identity(pubkeyAt(vault, 8)));
  out.add(identity(pubkeyAt(vault, 58648)));
  const markets = new Set<string>();
  for (const reserveKey of allocationReserveKeys(raw)) {
    const reserve = rpcBytes(raw, "rpc-state.json", reserveKey);
    markets.add(pubkeyAt(reserve, 32));
    for (const off of [5112, 5160, 5192, 5224]) {
      const key = pubkeyAt(reserve, off);
      if (isConfigured(key)) out.add(identity(key));
    }
  }
  for (const marketKey of markets) {
    out.add(identity(pubkeyAt(rpcBytes(raw, "rpc-state.json", marketKey), 24)));
  }
  const programs = raw.records["rpc-programs.json"]!;
  const keys = (programs.params as [string[], unknown])[0];
  const values = (programs.response as { value?: Array<{ executable: boolean; data: [string, string] } | null> }).value!;
  for (let i = 0; i < keys.length; i++) {
    out.add(identity(keys[i]!));
    const value = values[i];
    if (value && !value.executable) {
      const bytes = Buffer.from(value.data[0], "base64");
      if (bytes.length >= 45 && bytes.readUInt32LE(0) === 3 && bytes[12] === 1) out.add(identity(pubkeyAt(bytes, 13)));
    }
  }
  return [...out].sort();
}

/** Every authority key the capture presents: vault admin, allocation admin, market owners, upgrade authorities. */
function authorityKeys(raw: RawCapture): string[] {
  const vault = rpcBytes(raw, "rpc-state.json", VAULT_KEY);
  const out = new Set<string>([pubkeyAt(vault, 8), pubkeyAt(vault, 58648)]);
  const marketKeys = new Set(allocationReserveKeys(raw).map((k) => pubkeyAt(rpcBytes(raw, "rpc-state.json", k), 32)));
  for (const marketKey of marketKeys) out.add(pubkeyAt(rpcBytes(raw, "rpc-state.json", marketKey), 24));
  const programs = raw.records["rpc-programs.json"]!;
  const keys = (programs.params as [string[], unknown])[0];
  const values = (programs.response as { value?: Array<{ executable: boolean; data: [string, string] } | null> }).value!;
  for (let i = 0; i < keys.length; i++) {
    const value = values[i];
    if (!value || value.executable) continue;
    const bytes = Buffer.from(value.data[0], "base64");
    if (bytes.length >= 45 && bytes.readUInt32LE(0) === 3 && bytes[12] === 1) out.add(pubkeyAt(bytes, 13));
  }
  return [...out].sort();
}
const RECEIPT_SOURCE = /^kamino-capture:([^/]+)\/([^#]+)(?:#(.+))?$/;
const tupleOf = (f: Fact) => [f.subject, f.predicate, f.object, f.basis, f.status].join("|");
const factsById = (facts: Fact[]) => facts.map((f) => f.id).sort();
const metricsReceiptId = (snapshot: EvidenceSnapshot) =>
  snapshot.receipts.find((r) => r.source.endsWith("api-metrics.json"))?.id;
const docsReceiptId = (snapshot: EvidenceSnapshot) =>
  snapshot.receipts.find((r) => r.source.endsWith("docs-liquidity.json"))?.id;
const vaultReceiptId = (snapshot: EvidenceSnapshot) =>
  snapshot.receipts.find((r) => r.source === `kamino-capture:${A_DIR}/rpc-state.json#${VAULT_KEY}`)?.id;
const quantity = (result: ReturnType<typeof normalizeCapture>, name: string) => {
  const found = result.report.quantities.find((q) => q.name === name);
  if (!found) throw new Error(`missing quantity ${name}`);
  return found;
};

// ===========================================================================
// AC1: bounded public capture
// ===========================================================================
describe("AC1 bounded public capture", () => {
  test("T-AC1-1 both real captures load, validate and build a sorted snapshot list", () => {
    const a = loadCapture(join(KAMINO_ROOT, A_DIR));
    const b = loadCapture(join(KAMINO_ROOT, B_DIR));
    expect(a.manifest.captureId).toBe(A_DIR);
    expect(b.manifest.captureId).toBe(B_DIR);
    validatePasses(normalizeCapture(a).snapshot);
    validatePasses(normalizeCapture(b).snapshot);

    const snapshots = buildKaminoSnapshots(KAMINO_ROOT);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(new Set(snapshots.map((s) => s.id)).size).toBe(snapshots.length);
    for (let i = 1; i < snapshots.length; i++) {
      expect(BigInt(snapshots[i]!.toBlockOrSlot!)).toBeGreaterThan(BigInt(snapshots[i - 1]!.toBlockOrSlot!));
    }
  });

  test("T-AC1-2 every receipt hashes, sources and slot fields follow the contract", () => {
    for (const snapshot of [A.snapshot, B.snapshot]) {
      for (const receipt of snapshot.receipts) {
        expect(receipt.responseSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.source.startsWith("kamino-capture:")).toBe(true);
        expect(receipt.source.includes("://")).toBe(false);
        expect(receipt.privacy).toBe("public");
        const match = RECEIPT_SOURCE.exec(receipt.source);
        expect(match).not.toBeNull();
        const isAccount = Boolean(match![3]);
        if (isAccount) {
          expect(receipt.observation.blockOrSlot).toMatch(/^\d+$/);
        } else {
          expect(receipt.observation.blockOrSlot).toBeNull();
          expect(match![2]!.endsWith(".json")).toBe(true);
        }
      }
      // Both kinds are present, so the distinction is real.
      expect(snapshot.receipts.some((r) => r.observation.blockOrSlot === null)).toBe(true);
      expect(snapshot.receipts.some((r) => r.observation.blockOrSlot !== null)).toBe(true);
    }
  });

  test("T-AC1-3 per-account and HTTP receipt hashes equal the recorded bytes", () => {
    for (const [raw, snapshot] of [[A_RAW, A.snapshot], [B_RAW, B.snapshot]] as const) {
      for (const receipt of snapshot.receipts) {
        const match = RECEIPT_SOURCE.exec(receipt.source)!;
        const file = match[2]!;
        const key = match[3];
        const record = raw.records[file]!;
        if (key) {
          const params = record.params as [string[], unknown];
          const response = record.response as { value?: unknown[] };
          const idx = params[0].indexOf(key);
          expect(idx).toBeGreaterThanOrEqual(0);
          const value = response.value![idx];
          const expected = value === null ? sha256("null") : sha256(canonical(value));
          expect(receipt.responseSha256).toBe(expected);
        } else {
          expect(receipt.responseSha256).toBe(String(record.bodySha256));
        }
      }
    }
  });

  test("T-AC1-4 the subject set equals the computed bounded union (falsifier: no extra subject)", () => {
    for (const [raw, snapshot] of [[A_RAW, A.snapshot], [B_RAW, B.snapshot]] as const) {
      const expected = unionSubjects(raw);
      expect([...snapshot.subjects]).toEqual(expected);
      expect(snapshot.subjects.length).toBe(expected.length);
    }
    // Explicit negative: a key that is not in the capture must not appear.
    expect(A.snapshot.subjects).not.toContain(identity("SysvarC1ock11111111111111111111111111111111"));
  });

  test("T-AC1-5 fact bases are decoded/unknown; reported quantities are reported with the metrics receipt", () => {
    for (const result of [A, B]) {
      for (const fact of result.snapshot.facts) {
        expect(["decoded", "unknown"]).toContain(fact.basis);
      }
      const metricsId = metricsReceiptId(result.snapshot);
      expect(metricsId).toBeDefined();
      const reported = result.report.quantities.filter((q) => q.name.includes(".reported."));
      expect(reported.length).toBeGreaterThan(0);
      for (const q of reported) {
        expect(q.basis).toBe("reported");
        expect(q.evidenceIds).toEqual([metricsId!]);
      }
      // Negative: no non-report quantity is reported basis.
      for (const q of result.report.quantities.filter((x) => !x.name.includes(".reported."))) {
        expect(q.basis).not.toBe("reported");
      }
    }
  });

  test.skipIf(!DEV_CAPTURE)("T-AC1-6 the capture script without --record exits 2 and creates no fixture", () => {
    const before = existsSync(KAMINO_ROOT) ? readdirSync(KAMINO_ROOT).length : 0;
    const proc = Bun.spawnSync(["bun", "run", "scripts/kamino-capture.ts"], {
      cwd: ROOT,
      env: { ...process.env, LINCHPIN_RPC_URL: "http://127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    expect(output).toMatch(/Usage/);
    expect(readdirSync(KAMINO_ROOT).length).toBe(before);
  });
});

// ===========================================================================
// AC2: typed mechanics
// ===========================================================================
const RELATION_KINDS = Object.keys(RELATION_ENDPOINTS);

describe("AC2 typed mechanics", () => {
  test("T-AC2-1 both captures validate and every relational fact has a relation", () => {
    for (const result of [A, B]) {
      expect(() => validateMechanics(result.mechanics)).not.toThrow();
      const relationKeys = new Set(result.mechanics.relations.map((r) => `${r.kind}|${r.from}|${r.to}`));
      const relationalFacts = result.snapshot.facts.filter((f) => RELATION_KINDS.includes(f.predicate));
      expect(relationalFacts.length).toBeGreaterThan(0);
      for (const fact of relationalFacts) {
        expect(relationKeys.has(`${fact.predicate}|${fact.subject}|${fact.object}`)).toBe(true);
      }
    }
    // Falsifier: the reverse direction is not also a relation in real A.
    const allocates = A.mechanics.relations.find((r) => r.kind === "ALLOCATES_TO")!;
    expect(allocates.from).toBe(VAULT);
  });

  test("T-AC2-2 endpoint, relation and entity rejections give their stated codes", () => {
    const reserveId = identity(allocationReserveKeys(A_RAW)[0]!);
    const marketId = identity(pubkeyAt(rpcBytes(A_RAW, "rpc-state.json", allocationReserveKeys(A_RAW)[0]!), 32));
    const codeOf = (change: (m: typeof A.mechanics) => void): string => {
      const model = clone(A.mechanics);
      change(model);
      try {
        validateMechanics(model);
        return "no-error";
      } catch (error) {
        return (error as { code?: string }).code ?? "no-code";
      }
    };
    expect(codeOf((m) => {
      const rel = m.relations.find((r) => r.kind === "ALLOCATES_TO")!;
      rel.from = reserveId;
      rel.to = VAULT;
    })).toBe("incompatible-endpoint");
    expect(codeOf((m) => {
      m.relations.find((r) => r.kind === "PRICED_BY")!.to = marketId;
    })).toBe("incompatible-endpoint");
    expect(codeOf((m) => {
      m.relations.find((r) => r.kind === "IN_MARKET")!.to = identity("SysvarC1ock11111111111111111111111111111111");
    })).toBe("unknown-entity");
    expect(codeOf((m) => {
      (m.relations[0] as { kind: string }).kind = "BACKED_BY";
    })).toBe("unknown-relation");
    expect(codeOf((m) => {
      const existing = m.entities[1]!;
      m.entities.push({ id: existing.id, kind: "Market", evidenceIds: clone(existing.evidenceIds) });
    })).toBe("duplicate-entity");
    expect(codeOf((m) => {
      (m.entities[0] as unknown as Record<string, unknown>).name = "extra";
    })).toBe("schema");
    // Negative control: the untouched model still validates.
    expect(codeOf(() => undefined)).toBe("no-error");
  });

  test("T-AC2-3 quantity rejections are bad-quantity", () => {
    const codeOf = (change: (m: typeof A.mechanics) => void): string => {
      const model = clone(A.mechanics);
      change(model);
      try {
        validateMechanics(model);
        return "no-error";
      } catch (error) {
        return (error as { code?: string }).code ?? "no-code";
      }
    };
    const token = "vault.tokenAvailable";
    expect(codeOf((m) => { m.quantities.find((q) => q.name === token)!.decimals = null; })).toBe("bad-quantity");
    expect(codeOf((m) => { m.quantities.find((q) => q.name === token)!.decimals = 6.5; })).toBe("bad-quantity");
    expect(codeOf((m) => { m.quantities.find((q) => q.name === "vault.performanceFeeBps")!.value = "1.5"; })).toBe("bad-quantity");
    expect(codeOf((m) => { m.quantities[0]!.window = ""; })).toBe("bad-quantity");
    expect(codeOf((m) => { m.quantities.find((q) => q.name === "vault.totalAssets")!.inputs = []; })).toBe("bad-quantity");
    expect(codeOf((m) => { m.quantities.find((q) => q.name === token)!.inputs = [token]; })).toBe("bad-quantity");
    expect(codeOf((m) => { m.quantities[0]!.evidenceIds = []; })).toBe("bad-quantity");
    expect(codeOf((m) => { (m.quantities[0] as { unit: string }).unit = "percent"; })).toBe("bad-quantity");
    expect(codeOf(() => undefined)).toBe("no-error");
  });

  test("T-AC2-4 vault.tokenAvailable matches the recorded bytes and its unit rules", () => {
    const vault = rpcBytes(A_RAW, "rpc-state.json", VAULT_KEY);
    const expectedValue = u64(vault, 224).toString();
    const expectedDecimals = Number(u64(vault, 112));
    const q = quantity(A, "vault.tokenAvailable");
    expect(q.value).toBe(expectedValue);
    expect(q.unit).toBe("token-base-units");
    expect(q.mint).toBe(identity(pubkeyAt(vault, 80)));
    expect(q.decimals).toBe(expectedDecimals);
    expect(q.window).toBe("point");
    expect(q.basis).toBe("decoded");
    // Falsifier: the decoded value is not the string of some other offset.
    expect(q.value).not.toBe(u64(vault, 232).toString());
    // The mechanics quantity carries the same value and unit.
    const mech = A.mechanics.quantities.find((x) => x.name === "vault.tokenAvailable")!;
    expect(mech.value).toBe(expectedValue);
    expect(mech.unit).toBe("token-base-units");
    expect(mech.decimals).toBe(expectedDecimals);
  });
});

// ===========================================================================
// AC3: explainable yield and exit
// ===========================================================================
const RESERVE_NAMES = [
  "available", "borrowed", "utilizationPpm", "protocolTakeRatePct", "withdrawalCapCapacity",
  "vaultCtokenAllocation", "vaultTargetWeight", "vaultInvested", "vaultAllocationPpm",
];
const VAULT_NAMES = [
  "tokenAvailable", "sharesIssued", "pendingFees", "performanceFeeBps", "managementFeeBps",
  "withdrawalPenaltyBps", "withdrawalPenaltyLamports", "minWithdrawAmount", "unallocatedWeight",
  "unallocatedTokensCap", "totalAssets", "idleSharePpm",
];
const METRIC_NAMES = [
  "apy", "apyTheoretical", "apyActual", "apyFarmRewards", "apyIncentives", "apyReservesIncentives",
  "apy24h", "apy7d", "apy14d", "apy30d", "apy90d", "apy180d", "apy365d",
];

function expectedQuantityNames(raw: RawCapture): string[] {
  const names: string[] = [];
  for (const name of VAULT_NAMES) names.push(`vault.${name}`);
  for (const reserveKey of allocationReserveKeys(raw)) for (const name of RESERVE_NAMES) names.push(`reserve.${reserveKey}.${name}`);
  for (const metric of METRIC_NAMES) names.push(`vault.reported.${metric}`);
  return names.sort();
}
function reserveFormulas(raw: RawCapture, reserveKey: string) {
  const rpc = raw.records["rpc-state.json"]!;
  const vault = rpcBytes(raw, "rpc-state.json", VAULT_KEY);
  const reserve = rpcBytes(raw, "rpc-state.json", reserveKey);
  const allocIdx = allocationReserveKeys(raw).indexOf(reserveKey);
  const ctokenAllocation = u64(vault, 312 + 2160 * allocIdx + 1104);
  const available = u64(reserve, 224);
  const borrowedSf = u128(reserve, 232);
  const protocol = u128(reserve, 344);
  const referrer = u128(reserve, 360);
  const pendingReferrer = u128(reserve, 376);
  const collateralSupply = u64(reserve, 2592);
  const totalSupplySf = (available << 60n) + borrowedSf - protocol - referrer - pendingReferrer;
  const utilizationPpm = totalSupplySf > 0n ? (borrowedSf * 1_000_000n) / totalSupplySf : null;
  const invested = collateralSupply > 0n
    ? (ctokenAllocation * totalSupplySf) / (collateralSupply * (1n << 60n))
    : null;
  return { available, borrowedSf, borrowed: borrowedSf >> 60n, totalSupplySf, utilizationPpm, invested, ctokenAllocation };
}
function vaultTotals(raw: RawCapture) {
  const vault = rpcBytes(raw, "rpc-state.json", VAULT_KEY);
  const tokenAvailable = u64(vault, 224);
  const pendingFees = u128(vault, 296) >> 60n;
  let sumInvested = 0n;
  for (const reserveKey of allocationReserveKeys(raw)) {
    const f = reserveFormulas(raw, reserveKey);
    if (f.invested !== null) sumInvested += f.invested;
  }
  const totalAssets = tokenAvailable + sumInvested - pendingFees;
  const idleSharePpm = totalAssets > 0n ? (tokenAvailable * 1_000_000n) / totalAssets : null;
  return { tokenAvailable, pendingFees, sumInvested, totalAssets, idleSharePpm };
}

describe("AC3 explainable yield and exit", () => {
  test("T-AC3-1 missing is empty and quantity names equal the computed fixed set", () => {
    for (const [raw, result] of [[A_RAW, A], [B_RAW, B]] as const) {
      expect(result.report.missing).toEqual([]);
      expect(result.report.quantities.map((q) => q.name).sort()).toEqual(expectedQuantityNames(raw));
    }
  });

  test("T-AC3-2 one reserve's formulas and the allocation weights", () => {
    const key = allocationReserveKeys(A_RAW)[0]!;
    const f = reserveFormulas(A_RAW, key);
    const avail = quantity(A, `reserve.${key}.available`);
    expect(avail.value).toBe(f.available.toString());
    expect(avail.unit).toBe("token-base-units");
    expect(avail.decimals).toBe(6);
    const borrowed = quantity(A, `reserve.${key}.borrowed`);
    expect(borrowed.value).toBe(f.borrowed.toString());
    const util = quantity(A, `reserve.${key}.utilizationPpm`);
    expect(util.value).toBe(f.utilizationPpm!.toString());
    expect(util.unit).toBe("ppm");
    const invested = quantity(A, `reserve.${key}.vaultInvested`);
    expect(invested.value).toBe(f.invested!.toString());
    expect(invested.basis).toBe("derived");
    // Allocation ppm sums to 10^6 within the reserve count (flooring).
    const allocations = allocationReserveKeys(A_RAW).map((k) => BigInt(quantity(A, `reserve.${k}.vaultAllocationPpm`).value));
    const total = allocations.reduce((sum, v) => sum + v, 0n);
    const n = BigInt(allocations.length);
    expect(total).toBeGreaterThanOrEqual(1_000_000n - n);
    expect(total).toBeLessThanOrEqual(1_000_000n);
    // Falsifier: a wrong denominator (totalSupplySf without fees) would differ.
    expect(util.value).not.toBe(((f.borrowedSf * 1_000_000n) / ((f.available << 60n) + f.borrowedSf)).toString());
  });

  test("T-AC3-3 vault totalAssets and idleSharePpm match the formulas", () => {
    const totals = vaultTotals(A_RAW);
    expect(quantity(A, "vault.totalAssets").value).toBe(totals.totalAssets.toString());
    expect(quantity(A, "vault.idleSharePpm").value).toBe(totals.idleSharePpm!.toString());
    expect(quantity(A, "vault.pendingFees").value).toBe(totals.pendingFees.toString());
    expect(quantity(A, "vault.tokenAvailable").value).toBe(totals.tokenAvailable.toString());
    expect(totals.totalAssets).toBeGreaterThan(0n);
    // Negative: idle share is not the idle-per-share ratio (a different, wrong definition).
    const sharesIssued = u64(rpcBytes(A_RAW, "rpc-state.json", VAULT_KEY), 232);
    expect(quantity(A, "vault.idleSharePpm").value).not.toBe(((totals.tokenAvailable * 1_000_000n) / sharesIssued).toString());
  });

  test("T-AC3-4 (mutate metrics-missing-key) only apy7d is missing and no gap is added", () => {
    const result = normalizedMut("metrics-missing-key", (raw) => {
      const record = raw.records["api-metrics.json"]!;
      const body = JSON.parse(String(record.body)) as Record<string, unknown>;
      delete body.apy7d;
      record.body = JSON.stringify(body);
    });
    expect(result.report.missing).toEqual(["vault.reported.apy7d"]);
    // No new gap beyond the ordinary unknown-controller set.
    expect(result.gaps.every((g) => g.code === "unknown-controller")).toBe(true);
    validatePasses(result.snapshot);
  });

  test("T-AC3-5 notComputed/notCaptured exact and no projected or exit key", () => {
    expect(A.report.notComputed).toEqual(["exit-capacity", "guaranteed-return", "interest-accrued-since-last-refresh"]);
    expect(A.report.notCaptured).toEqual([
      "LendingMarket.emergencyCouncil", "LendingMarket.proposerAuthority", "VaultState.pendingAdmin", "farms",
    ]);
    for (const key of Object.keys(A.report)) {
      expect(key).not.toMatch(/expected|guarantee|projected|exitCapacity/i);
    }
    expect(JSON.stringify(A.report)).not.toMatch(/exitCapacity|guaranteedReturn|projectedReturn/);
  });

  test("T-AC3-6 reported quantities carry unit ratio and the window mapping", () => {
    const windows: Record<string, string> = {
      apy: "current", apyTheoretical: "current", apyActual: "current",
      apyFarmRewards: "current", apyIncentives: "current", apyReservesIncentives: "current",
      apy24h: "24h", apy7d: "7d", apy14d: "14d", apy30d: "30d", apy90d: "90d", apy180d: "180d", apy365d: "365d",
    };
    for (const result of [A, B]) {
      for (const metric of METRIC_NAMES) {
        const q = quantity(result, `vault.reported.${metric}`);
        expect(q.unit).toBe("ratio");
        expect(q.basis).toBe("reported");
        expect(q.window).toBe(windows[metric]!);
        // Falsifier: a wrong window (e.g. all "current") would fail for apy7d.
        if (metric !== "apy7d") expect(q.window === "7d").toBe(false);
      }
    }
    // Withdrawal cap windows are the configured interval in seconds.
    const key = allocationReserveKeys(A_RAW)[0]!;
    const interval = u64(rpcBytes(A_RAW, "rpc-state.json", key), 5440);
    expect(quantity(A, `reserve.${key}.withdrawalCapCapacity`).window).toBe(`${interval}s`);
  });
});

// ===========================================================================
// AC4: claims versus observations (K4)
// ===========================================================================
describe("AC4 claims versus observations", () => {
  test("T-AC4-1 parseIdleClaim literals", () => {
    const enDash = parseIdleClaim("A typical vault holds 5\u201310% of total assets in the buffer.");
    expect(enDash?.lowPpm).toBe(50_000);
    expect(enDash?.highPpm).toBe(100_000);
    expect(enDash?.definition).toBe("unallocated-buffer/total-assets");
    const hyphen = parseIdleClaim("A typical vault holds 5-10% of total assets in the buffer.");
    expect(hyphen?.lowPpm).toBe(50_000);
    expect(hyphen?.highPpm).toBe(100_000);
    expect(parseIdleClaim("A typical vault holds 5\u201310% of deposits in the buffer.")).toBeNull();
    expect(parseIdleClaim("A typical vault holds 10\u20135% of total assets in the buffer.")).toBeNull();
    expect(parseIdleClaim("")).toBeNull();
  });

  test("T-AC4-2 compareIdleClaim literals", () => {
    const claim = parseIdleClaim("A typical vault holds 5\u201310% of total assets in the buffer.")!;
    const same = "2026-11-10T09:00:00.000Z";
    const rows: Array<[number | null, ReturnType<typeof parseIdleClaim>, string,
      "below-claimed-range" | "within-claimed-range" | "above-claimed-range" | "not-comparable",
      "claim-missing" | "observation-missing" | "time-window-mismatch" | null]> = [
      [375, claim, same, "below-claimed-range", null],
      [49999, claim, same, "below-claimed-range", null],
      [50000, claim, same, "within-claimed-range", null],
      [100000, claim, same, "within-claimed-range", null],
      [100001, claim, same, "above-claimed-range", null],
      [null, claim, same, "not-comparable", "observation-missing"],
      [375, null, same, "not-comparable", "claim-missing"],
      [375, claim, "2026-11-10T10:00:00.001Z", "not-comparable", "time-window-mismatch"],
      [375, claim, "2026-11-10T10:00:00.000Z", "below-claimed-range", null],
    ];
    for (const [observed, input, observationAt, result, reason] of rows) {
      const got = compareIdleClaim(input, observed, same, observationAt);
      expect(got.result).toBe(result);
      expect(got.reason).toBe(reason);
    }
    // Falsifier: an observed value inside a different range is not hard-coded to one answer.
    expect(compareIdleClaim(claim, 60000, same, same).result).toBe("within-claimed-range");
    expect(compareIdleClaim(claim, 99999, same, same).result).toBe("within-claimed-range");
  });

  test("T-AC4-3 real claims are recomputed and their docs receipt resolves", () => {
    for (const [raw, result] of [[A_RAW, A], [B_RAW, B]] as const) {
      const entry = result.report.claims[0]!;
      expect(entry.id).toBe("kamino-docs-typical-buffer-share");
      expect(entry.claim).not.toBeNull();
      expect(entry.claimBasis).toBe("claimed");
      expect(entry.observedQuantity).toBe("vault.idleSharePpm");
      expect(entry.observationBasis).toBe("derived");
      expect(entry.scope).toBe("documented typical vault, not this vault's policy");
      const observed = quantity(result, "vault.idleSharePpm").value;
      const docs = raw.records["docs-liquidity.json"]!;
      const state = raw.records["rpc-state.json"]!;
      const recomputed = compareIdleClaim(entry.claim, observed, String(docs.retrievedAt), String(state.retrievedAt));
      expect(entry.result).toBe(recomputed.result);
      expect(entry.reason).toBe(recomputed.reason);
      expect(entry.result).toBe("below-claimed-range");
      // claimEvidenceIds resolve through the evidence query to the docs receipt.
      const store = openStore([result.snapshot]);
      const answer = runQuery(store, { name: "evidence", evidenceIds: entry.claimEvidenceIds, maxResults: 10 });
      expect(answer.receipts.length).toBe(entry.claimEvidenceIds.length);
      for (const receipt of answer.receipts) expect(receipt.source.endsWith("docs-liquidity.json")).toBe(true);
    }
    // Falsifier: the claim's ppm bounds are not the observed idle share.
    expect(A.report.claims[0]!.claim!.lowPpm).not.toBe(Number(quantity(A, "vault.idleSharePpm").value));
  });

  test("T-AC4-4 (mutate docs-shifted) time-window-mismatch", () => {
    const result = normalizedMut("docs-shifted", (raw) => {
      const record = raw.records["docs-liquidity.json"]!;
      record.retrievedAt = new Date(Date.parse(String(record.retrievedAt)) - 2 * 24 * 60 * 60 * 1000).toISOString();
    });
    expect(result.report.claims[0]!.result).toBe("not-comparable");
    expect(result.report.claims[0]!.reason).toBe("time-window-mismatch");
  });

  test("T-AC4-5 no fact cites the docs receipt and no risk language", () => {
    for (const result of [A, B]) {
      const docs = docsReceiptId(result.snapshot);
      expect(docs).toBeDefined();
      for (const fact of result.snapshot.facts) expect(fact.evidenceIds).not.toContain(docs!);
      expect(JSON.stringify(result.report.claims)).not.toMatch(/\b(risk|loss|exploit|unsafe|insolven)/i);
    }
  });
});

// ===========================================================================
// AC5: replay and failure
// ===========================================================================
const CONSTRUCTED_ROOT = join(import.meta.dir, "fixtures", "solana-economics-adapter");
const RPC_STATE = "rpc-state.json";

function gapTuple(g: { code: string; source: string; subject: string | null }) {
  return [g.code, g.source, g.subject];
}
function nonControllerGaps(result: ReturnType<typeof normalizeCapture>) {
  return result.gaps.filter((g) => g.code !== "unknown-controller").map(gapTuple);
}
function readerOf(result: ReturnType<typeof normalizeCapture>, id: string) {
  return result.snapshot.readers.find((r) => r.id === id);
}
function controlAt(result: ReturnType<typeof normalizeCapture>, subject: string): QueryResult {
  const store = openStore([result.snapshot]);
  return runQuery(store, {
    name: "control", subject,
    scope: { asOf: result.snapshot.observedTo, snapshotId: result.snapshot.id, maxHops: 8, maxResults: 500 },
  });
}
function dependenciesAt(result: ReturnType<typeof normalizeCapture>, subject: string): QueryResult {
  const store = openStore([result.snapshot]);
  return runQuery(store, {
    name: "dependencies", subject,
    relations: ["ALLOCATES_TO", "IN_MARKET", "PRICED_BY", "OWNER_PROGRAM", "PROGRAM_DATA"],
    scope: { asOf: result.snapshot.observedTo, snapshotId: result.snapshot.id, maxHops: 8, maxResults: 500 },
  });
}
const SQUADS_DISCRIMINATOR = sha256("account:Multisig").slice(0, 16);

describe("AC5 replay and failure", () => {
  test("T-AC5-1 replay is deterministic offline", () => {
    const before = fetchCalls;
    const first = normalizeCapture(loadCapture(join(KAMINO_ROOT, A_DIR)));
    const second = normalizeCapture(loadCapture(join(KAMINO_ROOT, A_DIR)));
    expect(canonical(first)).toBe(canonical(second));
    expect(resultSha256(runQuery(openStore([first.snapshot]), {
      name: "dependencies", subject: VAULT,
      relations: ["ALLOCATES_TO"], scope: { asOf: first.snapshot.observedTo, snapshotId: first.snapshot.id, maxHops: 8, maxResults: 500 },
    }))).toBe(resultSha256(runQuery(openStore([second.snapshot]), {
      name: "dependencies", subject: VAULT,
      relations: ["ALLOCATES_TO"], scope: { asOf: second.snapshot.observedTo, snapshotId: second.snapshot.id, maxHops: 8, maxResults: 500 },
    })));
    expect(fetchCalls).toBe(before);
  });

  test("T-AC5-2 real gaps are only unknown-controller with one CONTROLLED_BY fact each", () => {
    for (const result of [A, B]) {
      expect(result.gaps.every((g) => g.code === "unknown-controller")).toBe(true);
      const unknownAuthorities = result.mechanics.entities
        .filter((e) => e.kind === "Authority" && e.controllerType === "unknown")
        .map((e) => e.id).sort();
      const gapSubjects = result.gaps.map((g) => g.subject!).sort();
      expect(gapSubjects).toEqual(unknownAuthorities);
      for (const subject of unknownAuthorities) {
        const facts = result.snapshot.facts.filter((f) => f.predicate === "CONTROLLED_BY" && f.subject === subject);
        expect(facts.length).toBe(1);
        expect(facts[0]!.object).toBe("unknown");
        expect(facts[0]!.basis).toBe("unknown");
        expect(facts[0]!.status).toBe("unverified");
      }
      // Every authority the bytes present is unknown here; the gap list is exactly that set.
      const expectedAuthorities = authorityKeys(result === A ? A_RAW : B_RAW).map(identity);
      expect(unknownAuthorities).toEqual(expectedAuthorities);
      expect(result.gaps.length).toBe(expectedAuthorities.length);
      expect(unknownAuthorities).toContain(identity(vaultAdminKey()));
    }
  });

  test("T-AC5-3 (mutate http-error) gaps, failed reader, missing 13 and same fact tuples", () => {
    const result = normalizedMut("http-error", (raw) => {
      raw.records["api-metrics.json"]!.httpStatus = 500;
      raw.records["api-metrics.json"]!.body = "upstream error";
    });
    expect(nonControllerGaps(result)).toContainEqual(["http-error", "api-metrics.json", null]);
    expect(readerOf(result, "kamino-api-metrics")?.status).toBe("failed");
    expect(result.report.missing).toEqual(METRIC_NAMES.map((name) => `vault.reported.${name}`).sort());
    const expected = A.snapshot.facts.map(tupleOf).sort();
    expect(result.snapshot.facts.map(tupleOf).sort()).toEqual(expected);
    validatePasses(result.snapshot);
    // Negative: the reported quantities are absent, not zero-filled.
    expect(result.report.quantities.some((q) => q.name.includes(".reported."))).toBe(false);
  });

  test("T-AC5-4 (mutate rate-limited-api) rate-limited gap and empty crossChecks", () => {
    const result = normalizedMut("rate-limited-api", (raw) => {
      raw.records["api-vault.json"]!.httpStatus = 429;
      (raw.records["api-vault.json"]!.headers as Record<string, string>)["retry-after"] = "30";
    });
    expect(nonControllerGaps(result)).toContainEqual(["rate-limited", "api-vault.json", null]);
    expect(result.report.crossChecks).toEqual([]);
    expect(readerOf(result, "kamino-api-vault")?.status).toBe("failed");
  });

  test("T-AC5-5 (mutate rate-limited-rpc) failed state reader, no account facts, control unknown", () => {
    const result = normalizedMut("rate-limited-rpc", (raw) => {
      const record = raw.records[RPC_STATE]!;
      record.response = { code: 429, message: "Too many requests" };
      record.slot = null;
      record.httpStatus = 429;
    });
    expect(nonControllerGaps(result)).toEqual([["rate-limited", RPC_STATE, null]]);
    expect(readerOf(result, "kamino-chain-state")?.status).toBe("failed");
    expect(readerOf(result, "kamino-chain-state")?.subjects).toEqual([VAULT]);
    const forbidden = ["ALLOCATES_TO", "IN_MARKET", "PRICED_BY", "VAULT_ADMIN", "ALLOCATION_ADMIN",
      "MARKET_OWNER", "CONTROLLED_BY", "IDLE_RAW", "AVAILABLE_LIQUIDITY_RAW", "BORROWED_RAW", "SUPPLY_RAW"];
    expect(result.snapshot.facts.some((f) => forbidden.includes(f.predicate))).toBe(false);
    validatePasses(result.snapshot);
    const control = controlAt(result, VAULT);
    expect(control.outcome).toBe("unknown");
    expect(control.reasons.map((r) => r.code)).toEqual(["no-facts", "partial-reader"]);
  });

  test("T-AC5-6 (mutate malformed-api) malformed-record for api-vault", () => {
    const result = normalizedMut("malformed-api", (raw) => {
      raw.records["api-vault.json"]!.httpStatus = 200;
      raw.records["api-vault.json"]!.body = "<!DOCTYPE html>";
    });
    expect(nonControllerGaps(result)).toContainEqual(["malformed-record", "api-vault.json", null]);
    expect(result.report.crossChecks).toEqual([]);
  });

  test("T-AC5-7 (mutate malformed-market) no MARKET_OWNER but IN_MARKET kept", () => {
    const marketKey = pubkeyAt(rpcBytes(A_RAW, RPC_STATE, allocationReserveKeys(A_RAW)[0]!), 32);
    const market = identity(marketKey);
    const result = normalizedMut("malformed-market", (raw) => {
      const record = raw.records[RPC_STATE]!;
      const params = record.params as [string[], unknown];
      const response = record.response as { value: Array<{ data: [string, string] }> };
      const idx = params[0].indexOf(marketKey);
      expect(idx).toBeGreaterThanOrEqual(0);
      response.value[idx]!.data = [Buffer.alloc(100).toString("base64"), "base64"];
    });
    expect(nonControllerGaps(result)).toContainEqual(["malformed-record", RPC_STATE, market]);
    expect(result.snapshot.facts.some((f) => f.predicate === "MARKET_OWNER" && f.subject === market)).toBe(false);
    const inMarket = result.snapshot.facts.filter((f) => f.predicate === "IN_MARKET" && f.object === market);
    expect(inMarket.length).toBeGreaterThan(0);
  });

  test("T-AC5-8 (mutate partial-reserves) gap, kept edge, missing totals, partial dependency", () => {
    const reserveKey = allocationReserveKeys(A_RAW)[0]!;
    const reserve = identity(reserveKey);
    const result = normalizedMut("partial-reserves", (raw) => {
      (raw.records[RPC_STATE]!.response as { value: unknown[] }).value[1] = null;
    });
    expect(nonControllerGaps(result)).toEqual([["partial-reserves", RPC_STATE, reserve]]);
    const gapsReader = readerOf(result, "kamino-gaps");
    expect(gapsReader?.status).toBe("partial");
    expect([...gapsReader!.subjects].sort()).toEqual([reserve, VAULT].sort());
    expect(result.snapshot.facts.some((f) => f.predicate === "ALLOCATES_TO" && f.object === reserve)).toBe(true);
    expect(result.report.missing).toContain("vault.totalAssets");
    expect(result.report.missing).toContain("vault.idleSharePpm");
    expect(result.report.claims[0]!.reason).toBe("observation-missing");
    const dependencies = dependenciesAt(result, VAULT);
    expect(dependencies.outcome).toBe("partial");
    const partialSubjects = dependencies.reasons.filter((r) => r.code === "partial-reader").map((r) => r.subject).sort();
    expect(partialSubjects).toContain(VAULT);
    expect(partialSubjects).toContain(reserve);
    validatePasses(result.snapshot);
  });

  test("T-AC5-9 (mutate inconsistent-slots) implied unread reserve is a gap and totals vanish", () => {
    const implied = "SysvarC1ock11111111111111111111111111111111";
    const result = normalizedMut("inconsistent-slots", (raw) => {
      const record = raw.records[RPC_STATE]!;
      const response = record.response as { value: Array<{ data: [string, string] }> };
      const vaultBytes = Buffer.from(response.value[0]!.data[0], "base64");
      b58decode(implied).copy(vaultBytes, 312);
      response.value[0]!.data = [vaultBytes.toString("base64"), "base64"];
    });
    expect(nonControllerGaps(result).some(([code, source, subject]) =>
      code === "inconsistent-slots" && source === RPC_STATE && subject === identity(implied))).toBe(true);
    expect(result.report.missing).toContain("vault.totalAssets");
    // PC2: the vault's own decoded ALLOCATES_TO edge to the implied key is kept.
    expect(result.snapshot.facts.some((f) => f.predicate === "ALLOCATES_TO" && f.object === identity(implied))).toBe(true);
    validatePasses(result.snapshot);
  });

  test("T-AC5-10 (mutate unknown-controller-null) gap, controllable fact, partial control", () => {
    const admin = identity(vaultAdminKey());
    const result = normalizedMut("unknown-controller-null", (raw) => {
      const record = raw.records[RPC_STATE]!;
      const params = record.params as [string[], unknown];
      const response = record.response as { value: unknown[] };
      response.value[params[0].indexOf(vaultAdminKey())] = null;
    });
    expect(result.gaps.some((g) =>
      g.code === "unknown-controller" && g.source === RPC_STATE && g.subject === admin)).toBe(true);
    const fact = result.snapshot.facts.find((f) => f.predicate === "CONTROLLED_BY" && f.subject === admin);
    expect(fact?.object).toBe("unknown");
    const control = controlAt(result, admin);
    expect(control.outcome).toBe("partial");
    expect(control.reasons.some((r) => r.code === "unknown-controller")).toBe(true);
  });

  test("T-AC5-11 (mutate squads) multisig facts, config authority none, complete control", () => {
    const adminKey = vaultAdminKey();
    const admin = identity(adminKey);
    const members = [
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    ];
    const bytes = Buffer.alloc(199);
    Buffer.from(SQUADS_DISCRIMINATOR, "hex").copy(bytes, 0);
    b58decode(adminKey).copy(bytes, 8);
    bytes.writeUInt16LE(2, 72);
    bytes.writeUInt32LE(0, 74);
    bytes[94] = 0;
    bytes[95] = 255;
    bytes.writeUInt32LE(3, 96);
    let offset = 100;
    for (const member of members) {
      b58decode(member).copy(bytes, offset);
      bytes[offset + 32] = 7;
      offset += 33;
    }
    const result = normalizedMut("squads", (raw) => {
      const record = raw.records[RPC_STATE]!;
      const params = record.params as [string[], unknown];
      const response = record.response as { value: unknown[] };
      response.value[params[0].indexOf(adminKey)] = {
        owner: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
        executable: false, lamports: 1, rentEpoch: 0, space: bytes.length,
        data: [bytes.toString("base64"), "base64"],
      };
    });
    expect(controlAt(result, admin).outcome).toBe("complete");
    const facts = result.snapshot.facts;
    const memberFacts = facts.filter((f) => f.predicate === "MULTISIG_MEMBER" && f.subject === admin);
    expect(memberFacts.map((f) => f.object).sort()).toEqual(members.map(identity).sort());
    expect(facts.some((f) => f.predicate === "CONFIG_AUTHORITY" && f.subject === admin && f.object === "none")).toBe(true);
    expect(facts.some((f) => f.predicate === "CONTROLLED_BY" && f.subject === admin)).toBe(false);
    expect(facts.some((f) => f.predicate === "MULTISIG_THRESHOLD" && f.subject === admin && f.object === "amount:2")).toBe(true);
    const view = result.report.controllers.find((c) => c.address === admin);
    expect(view?.type).toBe("squads-v4-multisig");
    // Falsifier: members are not inferred from names; no entity carries a name field.
    expect(JSON.stringify(view)).not.toContain("memberName");
  });

  test("T-AC5-12 orderSnapshots rejects a same-slot pair", () => {
    const other = normalizedMut("same-slot-copy", () => undefined);
    expect(other.snapshot.toBlockOrSlot).toBe(A.snapshot.toBlockOrSlot);
    expect(() => orderSnapshots([A.snapshot, other.snapshot])).toThrow(CaptureRejected);
    try {
      orderSnapshots([A.snapshot, other.snapshot]);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("same-slot");
    }
  });

  test("T-AC5-L1 loaded constructed fixture hash-mismatch is rejected", () => {
    expect(() => loadCapture(join(CONSTRUCTED_ROOT, "hash-mismatch"))).toThrow(CaptureRejected);
    try { loadCapture(join(CONSTRUCTED_ROOT, "hash-mismatch")); } catch (e) { expect((e as { code?: string }).code).toBe("hash-mismatch"); }
  });

  test("T-AC5-L2 loaded constructed fixture missing-record is rejected", () => {
    try { loadCapture(join(CONSTRUCTED_ROOT, "missing-record")); throw new Error("should reject"); } catch (e) {
      expect((e as { code?: string }).code).toBe("missing-record");
    }
  });

  test("T-AC5-L3 loaded constructed fixture malformed-capture is rejected", () => {
    try { loadCapture(join(CONSTRUCTED_ROOT, "malformed-capture")); throw new Error("should reject"); } catch (e) {
      expect((e as { code?: string }).code).toBe("malformed-capture");
    }
  });

  test("T-AC5-L4 loaded constructed fixture slot-mismatch is rejected", () => {
    try { loadCapture(join(CONSTRUCTED_ROOT, "slot-mismatch")); throw new Error("should reject"); } catch (e) {
      expect((e as { code?: string }).code).toBe("slot-mismatch");
    }
  });

  test("T-AC5-L5 in-memory duplicate-account is rejected", () => {
    const raw = mutate("duplicate-account", (copy) => {
      const record = copy.records[RPC_STATE]!;
      const params = record.params as [string[], unknown];
      const response = record.response as { value: unknown[] };
      params[0].push(params[0][0]!);
      response.value.push(response.value[0]);
    });
    try { verifyCapture(raw); throw new Error("should reject"); } catch (e) {
      expect((e as { code?: string }).code).toBe("duplicate-account");
    }
  });
});

// ===========================================================================
// AC6: no false attribution
// ===========================================================================
const FORBIDDEN_PREDICATES = ["BACKED_BY", "ORIGINATES_FROM", "ISSUED_BY_PROGRAM", "MINT_AUTHORITY", "FREEZE_AUTHORITY"];
const CONTROL_MECHANISMS = ["VAULT_ADMIN", "ALLOCATION_ADMIN", "MARKET_OWNER", "UPGRADE_AUTHORITY", "MULTISIG_MEMBER", "CONFIG_AUTHORITY"];

describe("AC6 no false attribution", () => {
  test("T-AC6-1 no backing/issuer predicates and controller views are four-key mechanism views", () => {
    for (const result of [A, B]) {
      for (const fact of result.snapshot.facts) expect(FORBIDDEN_PREDICATES).not.toContain(fact.predicate);
      for (const view of result.report.controllers) {
        expect(Object.keys(view).sort()).toEqual(["address", "evidenceIds", "mechanisms", "type"]);
        // The mechanisms are predicates whose object is this address.
        for (const mechanism of view.mechanisms) {
          expect(CONTROL_MECHANISMS).toContain(mechanism);
          expect(result.snapshot.facts.some((f) => f.predicate === mechanism && f.object === view.address)).toBe(true);
        }
        expect([...view.mechanisms].sort()).toEqual([...view.mechanisms]);
      }
      // Every authority seen in the real captures is System-owned, hence unknown.
      for (const view of result.report.controllers) expect(view.type).toBe("unknown");
      // Negative: the vault and markets are not controller views.
      expect(result.report.controllers.some((v) => v.address === VAULT)).toBe(false);
    }
  });

  test("T-AC6-2 (mutate renamed) only names change, fact tuples are identical", () => {
    const marketKey = pubkeyAt(rpcBytes(A_RAW, RPC_STATE, allocationReserveKeys(A_RAW)[0]!), 32);
    const result = normalizedMut("renamed", (raw) => {
      const record = raw.records[RPC_STATE]!;
      const response = record.response as { value: Array<{ data: [string, string] }> };
      const index = (record.params as [string[], unknown])[0].indexOf(marketKey);
      const bytes = Buffer.from(response.value[index]!.data[0], "base64");
      bytes.fill(0, 3248, 3280);
      bytes.write("Kamino Main Market", 3248);
      response.value[index]!.data = [bytes.toString("base64"), "base64"];
    });
    expect(result.snapshot.facts.map(tupleOf).sort()).toEqual(A.snapshot.facts.map(tupleOf).sort());
    expect(result.snapshot.names[identity(marketKey)]).toBe("Kamino Main Market");
    // No other snapshot name changed.
    const namesA = Object.entries(A.snapshot.names).sort();
    const namesB = Object.entries(result.snapshot.names).sort();
    const differing = namesB.filter(([key, value]) => A.snapshot.names[key] !== value);
    expect(differing).toEqual([[identity(marketKey), "Kamino Main Market"]]);
    expect(namesA.length).toBe(namesB.length);
  });

  test("T-AC6-3 Marinade queries are byte-identical with the Kamino snapshots in the store", () => {
    const marinade = buildMarinadeSnapshots(join(ROOT, "fixtures"));
    const kamino = buildKaminoSnapshots(KAMINO_ROOT);
    const alone = openStore(marinade);
    const together = openStore([...marinade, ...kamino]);
    const MNDE = "solana:mainnet-beta:MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey";
    const MSOL = "solana:mainnet-beta:mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    for (const subject of [MNDE, MSOL]) {
      const snapshot = marinade.find((s) => s.subjects.includes(subject))!;
      const scope = { asOf: snapshot.observedTo, snapshotId: snapshot.id, maxHops: 8, maxResults: 500 };
      expect(resultSha256(runQuery(together, { name: "control", subject, scope })))
        .toBe(resultSha256(runQuery(alone, { name: "control", subject, scope })));
    }
    const s05 = marinade.find((s) => s.id.endsWith("2026-10-05"))!;
    const s06 = marinade.find((s) => s.id.endsWith("2026-10-06"))!;
    for (const subject of [MNDE, MSOL]) {
      const request = { name: "changes" as const, subject, beforeSnapshotId: s05.id, afterSnapshotId: s06.id, maxResults: 500 };
      expect(resultSha256(runQuery(together, request))).toBe(resultSha256(runQuery(alone, request)));
    }
    // Falsifier: adding the Kamino snapshots does add subjects to the combined store.
    expect(together.snapshot(kamino[0]!.id)).toBeDefined();
  });

  test("T-AC6-4 every receipt resolves to exactly its own capture's snapshot", () => {
    const both = openStore([A.snapshot, B.snapshot]);
    for (const [result, other] of [[A, B], [B, A]] as const) {
      for (const receipt of result.snapshot.receipts) {
        const owners = both.snapshotsForReceipt(receipt.id).map((s) => s.id);
        expect(owners).toEqual([result.snapshot.id]);
        expect(owners).not.toContain(other.snapshot.id);
      }
      // No receipt id is shared with the other capture.
      const otherIds = new Set(other.snapshot.receipts.map((r) => r.id));
      expect(result.snapshot.receipts.some((r) => otherIds.has(r.id))).toBe(false);
    }
  });
});

// ===========================================================================
// K2 and K6: slice-1 queries over the adapter output
// ===========================================================================
const KAMINO_STORE = openStore([A.snapshot, B.snapshot]);

describe("K2 and K6 slice-1 queries", () => {
  test("T-K2-1 dependencies from the vault covers exactly the traversal facts", () => {
    const relations = ["ALLOCATES_TO", "IN_MARKET", "PRICED_BY", "OWNER_PROGRAM", "PROGRAM_DATA"];
    const answer = runQuery(KAMINO_STORE, {
      name: "dependencies", subject: VAULT, relations,
      scope: { asOf: A.snapshot.observedTo, snapshotId: A.snapshot.id, maxHops: 8, maxResults: 500 },
    });
    expect(answer.outcome).toBe("complete");
    expect(factsById(answer.facts)).toEqual(factsById(A.snapshot.facts.filter((f) => relations.includes(f.predicate))));
    // Falsifier: the set is non-empty and excludes state facts.
    expect(answer.facts.length).toBeGreaterThan(0);
    expect(answer.facts.some((f) => f.predicate === "IDLE_RAW")).toBe(false);
  });

  test("T-K2-2 control on the vault is exactly the two admin facts", () => {
    const answer = controlAt(A, VAULT);
    expect(answer.outcome).toBe("complete");
    expect(answer.facts.map((f) => [f.predicate, f.object]).sort()).toEqual([
      ["ALLOCATION_ADMIN", identity(pubkeyAt(rpcBytes(A_RAW, RPC_STATE, VAULT_KEY), 58648))],
      ["VAULT_ADMIN", identity(pubkeyAt(rpcBytes(A_RAW, RPC_STATE, VAULT_KEY), 8))],
    ]);
  });

  test("T-K2-3 control on each unknown authority is partial with unknown-controller", () => {
    const unknown = A.mechanics.entities.filter((e) => e.kind === "Authority" && e.controllerType === "unknown").map((e) => e.id);
    expect(unknown.length).toBe(4);
    for (const subject of unknown) {
      const answer = controlAt(A, subject);
      expect(answer.outcome).toBe("partial");
      expect(answer.reasons.some((r) => r.code === "unknown-controller")).toBe(true);
      expect(answer.unknowns).toContain(subject);
    }
  });

  test("T-K6-1 captures differ in slot and A is lower", () => {
    expect(BigInt(A.snapshot.toBlockOrSlot!)).toBeLessThan(BigInt(B.snapshot.toBlockOrSlot!));
    expect(A.snapshot.toBlockOrSlot).not.toBe(B.snapshot.toBlockOrSlot);
  });

  test("T-K6-2 changes across the vault, reserves and shares mint", () => {
    const reserves = allocationReserveKeys(A_RAW);
    const subjects = [VAULT, ...reserves.map(identity), sharesMint()];
    let changed = 0;
    const aReceipts = new Set(A.snapshot.receipts.map((r) => r.id));
    const bReceipts = new Set(B.snapshot.receipts.map((r) => r.id));
    const oneCardinality = new Set(["IDLE_RAW", "AVAILABLE_LIQUIDITY_RAW", "BORROWED_RAW", "SUPPLY_RAW", "IN_MARKET", "PRICED_BY", "VAULT_ADMIN", "ALLOCATION_ADMIN", "MARKET_OWNER", "UPGRADE_AUTHORITY", "CONTROLLED_BY"]);
    for (const subject of subjects) {
      const answer = runQuery(KAMINO_STORE, {
        name: "changes", subject, beforeSnapshotId: A.snapshot.id, afterSnapshotId: B.snapshot.id, maxResults: 500,
      });
      for (const change of answer.changes) {
        expect(change.kind).toBe("changed");
        const predicate = change.key.split("|")[1]!;
        expect(["IDLE_RAW", "AVAILABLE_LIQUIDITY_RAW", "BORROWED_RAW", "SUPPLY_RAW"].includes(predicate)
          || oneCardinality.has(predicate)).toBe(true);
        for (const id of change.before!.evidenceIds) expect(aReceipts.has(id)).toBe(true);
        for (const id of change.after!.evidenceIds) expect(bReceipts.has(id)).toBe(true);
        if (change.kind === "changed") changed += 1;
      }
    }
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  test("T-K6-3 changed state entries carry amounts computed from each capture", () => {
    const expectedAmounts: Record<string, { before: string; after: string }> = {};
    const vaultA = rpcBytes(A_RAW, RPC_STATE, VAULT_KEY);
    const vaultB = rpcBytes(B_RAW, RPC_STATE, VAULT_KEY);
    expectedAmounts[`${VAULT}|IDLE_RAW`] = { before: `amount:${u64(vaultA, 224)}`, after: `amount:${u64(vaultB, 224)}` };
    for (const reserveKey of allocationReserveKeys(A_RAW)) {
      const rA = rpcBytes(A_RAW, RPC_STATE, reserveKey);
      const rB = rpcBytes(B_RAW, RPC_STATE, reserveKey);
      expectedAmounts[`${identity(reserveKey)}|AVAILABLE_LIQUIDITY_RAW`] = {
        before: `amount:${u64(rA, 224)}`, after: `amount:${u64(rB, 224)}`,
      };
      expectedAmounts[`${identity(reserveKey)}|BORROWED_RAW`] = {
        before: `amount:${u128(rA, 232) >> 60n}`, after: `amount:${u128(rB, 232) >> 60n}`,
      };
    }
    const mintA = rpcBytes(A_RAW, RPC_STATE, sharesMintKey());
    const mintB = rpcBytes(B_RAW, RPC_STATE, sharesMintKey());
    expectedAmounts[`${sharesMint()}|SUPPLY_RAW`] = {
      before: `amount:${u64(mintA, 36)}`, after: `amount:${u64(mintB, 36)}`,
    };
    const vaultChanges = runQuery(KAMINO_STORE, {
      name: "changes", subject: VAULT, beforeSnapshotId: A.snapshot.id, afterSnapshotId: B.snapshot.id, maxResults: 500,
    });
    let checked = 0;
    for (const change of vaultChanges.changes) {
      if (!["IDLE_RAW"].includes(change.key.split("|")[1]!)) continue;
      expect(change.before!.object).toBe(expectedAmounts[change.key]!.before);
      expect(change.after!.object).toBe(expectedAmounts[change.key]!.after);
      checked += 1;
    }
    for (const reserveKey of allocationReserveKeys(A_RAW)) {
      const answer = runQuery(KAMINO_STORE, {
        name: "changes", subject: identity(reserveKey), beforeSnapshotId: A.snapshot.id, afterSnapshotId: B.snapshot.id, maxResults: 500,
      });
      for (const change of answer.changes) {
        const predicate = change.key.split("|")[1]!;
        if (!["AVAILABLE_LIQUIDITY_RAW", "BORROWED_RAW"].includes(predicate)) continue;
        expect(change.before!.object).toBe(expectedAmounts[change.key]!.before);
        expect(change.after!.object).toBe(expectedAmounts[change.key]!.after);
        checked += 1;
      }
    }
    const supply = runQuery(KAMINO_STORE, {
      name: "changes", subject: sharesMint(), beforeSnapshotId: A.snapshot.id, afterSnapshotId: B.snapshot.id, maxResults: 500,
    });
    for (const change of supply.changes) {
      if (change.key.split("|")[1] !== "SUPPLY_RAW") continue;
      expect(change.before!.object).toBe(expectedAmounts[change.key]!.before);
      expect(change.after!.object).toBe(expectedAmounts[change.key]!.after);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
    // Falsifier: the shares mint supply differs between captures, so a stale value would fail.
    expect(expectedAmounts[`${sharesMint()}|SUPPLY_RAW`]!.before).not.toBe(expectedAmounts[`${sharesMint()}|SUPPLY_RAW`]!.after);
  });

  test("T-K6-4 equal reserve sets produce no added or removed allocation", () => {
    const setA = allocationReserveKeys(A_RAW).sort();
    const setB = allocationReserveKeys(B_RAW).sort();
    expect(setA).toEqual(setB);
    const answer = runQuery(KAMINO_STORE, {
      name: "changes", subject: VAULT, beforeSnapshotId: A.snapshot.id, afterSnapshotId: B.snapshot.id, maxResults: 500,
    });
    const allocationChanges = answer.changes.filter((c) => c.key.split("|")[1] === "ALLOCATES_TO");
    if (setA.length === setB.length) {
      expect(allocationChanges.some((c) => c.kind === "added" || c.kind === "removed")).toBe(false);
    }
    // The dynamic half: any added/removed must carry the documented composite key.
    for (const change of allocationChanges.filter((c) => c.kind !== "changed")) {
      expect(change.key).toBe(`${VAULT}|ALLOCATES_TO|${change.kind === "added" ? change.after!.object : change.before!.object}`);
    }
  });

  test("T-K6-5 the evidence query returns docs and vault receipts with A's snapshot id", () => {
    const docs = docsReceiptId(A.snapshot)!;
    const vaultAccount = vaultReceiptId(A.snapshot)!;
    expect(docs).toBeDefined();
    expect(vaultAccount).toBeDefined();
    const answer = runQuery(openStore([A.snapshot, B.snapshot]), {
      name: "evidence", evidenceIds: [docs, vaultAccount], maxResults: 10,
    });
    expect(answer.outcome).toBe("complete");
    expect(answer.receipts.length).toBe(2);
    expect(answer.observations[0]!.snapshotId).toBe(A.snapshot.id);
    expect(answer.receipts.find((r) => r.id === docs)?.source.endsWith("docs-liquidity.json")).toBe(true);
    // Falsifier: B's snapshot is not reported for A's receipts.
    expect(answer.observations.some((o) => o.snapshotId === B.snapshot.id)).toBe(false);
  });
});
