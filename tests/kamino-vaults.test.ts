// Kamino kVaults acceptance tests: five vault roots replayed offline through the shared adapter.
// Independent of the implementation: every expected value is a literal from the approved
// contract or is recomputed here from the committed captures. The whole file runs offline:
// fetch, WebSocket, Bun.connect, node:net and node:http(s) are trapped and any call fails.
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";
import { PublicKey } from "@solana/web3.js";

import { canonical, sha256 } from "../src/chain/evidence";
import { openStore, runQuery, validateSnapshot } from "../src/engine/queries/index";
import type { EvidenceSnapshot } from "../src/engine/queries/index";
import {
  VAULT_TARGETS, KAMINO_TARGET, KVAULT_PROGRAM, isConfiguredKey, identity,
  buildKaminoSnapshots, CaptureRejected, loadCapture, normalizeCapture, verifyCapture,
} from "../src/adapters/kamino/index";
import { recordCapture } from "../src/adapters/kamino/record";

// ---- repository-relative paths (resolved here, never absolute) ----
// Some checks below run scripts/kamino-capture.ts, which only the development repository carries. The
// published tree leaves it out on purpose, so there those checks are skipped rather than failed (or, for a
// negative check, passed by a missing module); in the development repository they always run.
const DEV_CAPTURE = existsSync(join(import.meta.dir, "..", "scripts", "kamino-capture.ts"));
const ROOT = join(import.meta.dir, "..");
const SENTORA_ROOT = join(ROOT, "fixtures", "kamino");
const NEW_ROOT = join(ROOT, "fixtures", "kamino-vaults");

// ---- literals from the approved contract ----
const EXPECTED_KEYS = ["sentora-pyusd", "rwa-usdc", "steakhouse-hy-usdg", "kamino-commodity-yield", "ethena-pyusd-prime", "allez-sol"];
const EXPECTED_TARGETS: Record<string, { vault: string; tokenMint: string }> = {
  "sentora-pyusd": { vault: "A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK", tokenMint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" },
  "rwa-usdc": { vault: "DWSXb18xZApz29vnQpgR2m6MynCT7PznaXt7Ut7M7KaP", tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  "steakhouse-hy-usdg": { vault: "BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5", tokenMint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH" },
  "kamino-commodity-yield": { vault: "B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6", tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  "ethena-pyusd-prime": { vault: "4TwKA9JXEGeLEpAPLoarhSQoQwoiu12dkDCjSuVvHQUf", tokenMint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" },
  "allez-sol": { vault: "A1so1bPD3W1TfeFwboDh8yfAAVaVtcdAYBYCjhg2mJQ", tokenMint: "So11111111111111111111111111111111111111112" },
};
const SLUGS = EXPECTED_KEYS.filter(s => s !== "sentora-pyusd");
const SENTORA_VAULT_ID = identity(EXPECTED_TARGETS["sentora-pyusd"]!.vault);
const PYUSD_IDENTITY = identity("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo");
const EXPECTED_NAMES: Record<string, string> = {
  "rwa-usdc": "RWA USDC",
  "steakhouse-hy-usdg": "Steakhouse High Yield USDG",
};
const TOKEN_DECIMALS: Record<string, number> = { "allez-sol": 9 };

// ---- vault-state offsets at which the test reads the recorded bytes ----
const SHARES_MINT_OFFSET = 184;
const SHARES_DECIMALS_OFFSET = 216;
const ALLOCATION_BASE = 312;
const ALLOCATION_STRIDE = 2160;
const ALLOCATION_COUNT = 25;
const NAME_OFFSET = 58528;
const NAME_WINDOW = 40;

// ---- pinned values (regression pins, computed once from the committed fixtures) ----
const CANONICAL_KAMINO_TARGET = '{"kvaultProgram":"KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd","tokenMint":"2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo","vault":"A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK"}';
const DEFAULT_ROOT_SHA256 = "403922a90c933980ecebc388a7a3d129997492202740dabbd6116410c304c3f8";
const LAYOUT_SHA256 = "8e6ea4e46123bf2bcbef70b4a91d45a75081cf47d3306be58b302a4505ab2b7f";
const SNAPSHOT_SHA256: Record<string, string> = {
  "rwa-usdc/rwa-usdc-20261112T003925Z": "93b77bbddb16ae2e28d6849201de868350567867749f487090284d6bb9d611a8",
  "rwa-usdc/rwa-usdc-20261112T011109Z": "79179d20938daeae43220df8c6a7bf5190e83825b7823afa5ceede1e2346fed8",
  "steakhouse-hy-usdg/steakhouse-hy-usdg-20261112T003932Z": "1bf75c507674b7c6c75255353143c8e3b10a1e0d6b0032bcc6163c42999e1bfe",
  "steakhouse-hy-usdg/steakhouse-hy-usdg-20261112T011116Z": "272edb6bd6e0b49f48d3547f47dc3a4c1fcbd2f9673f6dcfcbdf09e6befbcd4f",
  "kamino-commodity-yield/kamino-commodity-yield-20261112T003939Z": "c07bb5b863a1d735d34339f2ea786cc4126b02e5de7d59ed2bb7bf1f2a3c0a1c",
  "kamino-commodity-yield/kamino-commodity-yield-20261112T011123Z": "7ed07f93bb658e35d0d5fb2bc0d98f1b757a108144c32555b10aa029836a0b10",
  "ethena-pyusd-prime/ethena-pyusd-prime-20261112T003946Z": "2dc7197f8277567e42f153fbb8552a34bb2ecd374796ac622aef74dda0771cd8",
  "ethena-pyusd-prime/ethena-pyusd-prime-20261112T014204Z": "dec172a7f90dc56a33732a6aa113848db9f490c6ca50e6acf95e6d65adbb182c",
  "allez-sol/allez-sol-20261112T003953Z": "7445f5e3792aa5429a0ddfd930d64dd566d1a5ee4dec3fcdce01954a8cdaad11",
  "allez-sol/allez-sol-20261112T011137Z": "a93732fc0db7f669a798a36f8c7e7b67473aac39f682e0e0a4b307de0636f95e",
};

// ---- offline trap for the whole file ----
const hits = { fetch: 0, websocket: 0, connect: 0, net: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
const trapFetch = (): Response => { hits.fetch++; throw trapError("fetch"); };
let restores: (() => void)[] = [];
let fetchSpy: any;

beforeAll(() => {
  process.chdir(ROOT);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(trapFetch as any);
  restores.push(() => fetchSpy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class { constructor() { hits.websocket++; throw trapError("WebSocket"); } };
  restores.push(() => { (globalThis as any).WebSocket = realWebSocket; });
  const realConnect = (Bun as any).connect;
  (Bun as any).connect = (): never => { hits.connect++; throw trapError("Bun.connect"); };
  restores.push(() => { (Bun as any).connect = realConnect; });
  for (const mod of [netNamespace as any, netDefault as any, httpModule as any, httpsModule as any]) {
    for (const name of ["connect", "createConnection", "request", "get"]) {
      if (typeof mod[name] !== "function") continue;
      const trap = (): never => { hits.net++; throw trapError("node:net/http(s)"); };
      try {
        const spy = spyOn(mod, name).mockImplementation(trap as any);
        restores.push(() => spy.mockRestore());
      } catch {
        const real = mod[name];
        try { mod[name] = trap; restores.push(() => { mod[name] = real; }); } catch { /* read-only export */ }
      }
    }
  }
});

afterAll(() => {
  for (const restore of restores) restore();
  restores = [];
});

afterEach(() => {
  for (const value of Object.values(hits)) expect(value).toBe(0);
});

// ---- helpers ----
type AnyRecord = Record<string, any>;

const listDirs = (p: string): string[] =>
  readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

const captureDirs = (slug: string): string[] => listDirs(join(NEW_ROOT, slug));
const firstCaptureDir = (slug: string): string => join(NEW_ROOT, slug, captureDirs(slug)[0]!);
const firstSentoraDir = (): string => join(SENTORA_ROOT, listDirs(SENTORA_ROOT)[0]!);const tmpRoot = (prefix: string): string =>
  mkdirSync(join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true }) as string;

/** Copies a committed capture into toDir/<captureId>, with manifest.captureId set to captureId. */
function copyCapture(srcDir: string, toDir: string, captureId: string): string {
  const dir = join(toDir, captureId);
  mkdirSync(dir, { recursive: true });
  const manifest = readJson(join(srcDir, "manifest.json"));
  manifest.captureId = captureId;
  manifest.constructed = true;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const file of manifest.records as string[]) copyFileSync(join(srcDir, file), join(dir, file));
  return dir;
}

function rewriteManifest(dir: string, mutate: (m: AnyRecord) => void): void {
  const path = join(dir, "manifest.json");
  const manifest = readJson(path);
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

/** Rewrites one record file in a copied capture, recomputing its integrity hash. */
function rewriteRecord(dir: string, file: string, mutate: (r: AnyRecord) => void): void {
  const path = join(dir, file);
  const record = readJson(path);
  mutate(record);
  if (record.kind === "rpc") record.responseSha256 = sha256(canonical(record.response));
  else record.bodySha256 = sha256(record.body);
  writeFileSync(path, JSON.stringify(record));
}

/** The vault-state account bytes recorded for a capture's own vault. */
function vaultBytes(dir: string): Buffer {
  const manifest = readJson(join(dir, "manifest.json"));
  const state = readJson(join(dir, "rpc-state.json"));
  const keys = state.params[0] as string[];
  const index = keys.indexOf(manifest.target.vault);
  expect(index).toBeGreaterThanOrEqual(0);
  return Buffer.from(state.response.value[index].data[0], "base64");
}

const pubkeyAt = (bytes: Buffer, offset: number): string =>
  new PublicKey(bytes.subarray(offset, offset + 32)).toBase58();

/** Reserve keys configured in the allocation slots, recomputed from the recorded bytes. */
function allocationKeys(bytes: Buffer): string[] {
  const keys: string[] = [];
  for (let i = 0; i < ALLOCATION_COUNT; i++) {
    const key = pubkeyAt(bytes, ALLOCATION_BASE + ALLOCATION_STRIDE * i);
    if (isConfiguredKey(key)) keys.push(key);
  }
  return keys;
}

/** Name decoded from the vault-state bytes in the printable-name window. */
const decodeName = (bytes: Buffer): string =>
  Buffer.from(bytes.subarray(NAME_OFFSET, NAME_OFFSET + NAME_WINDOW)).toString("utf8").replace(/\0+$/, "");

interface ChildResult { exitCode: number; stdout: string; stderr: string }

function spawnScript(args: string[]): ChildResult {
  const child = Bun.spawnSync([process.execPath, "run", "scripts/kamino-capture.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, LINCHPIN_RPC_URL: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1" },
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function rejectCode(fn: () => unknown): string {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(CaptureRejected);
    return (e as CaptureRejected).code;
  }
  throw new Error("expected the call to reject");
}

const scopeOf = (s: EvidenceSnapshot) => ({ asOf: s.observedTo, snapshotId: s.id, maxHops: 8, maxResults: 500 });

// ====================================================================
// AC1 — registry and Sentora alias
// ====================================================================
describe("AC1 registry and Sentora alias", () => {
  test("keys, values, freezing and the alias", () => {
    expect(Object.keys(VAULT_TARGETS)).toEqual(EXPECTED_KEYS);
    for (const slug of EXPECTED_KEYS) {
      const target = (VAULT_TARGETS as AnyRecord)[slug];
      expect(target.vault).toBe(EXPECTED_TARGETS[slug]!.vault);
      expect(target.tokenMint).toBe(EXPECTED_TARGETS[slug]!.tokenMint);
      expect(target.kvaultProgram).toBe(KVAULT_PROGRAM);
      expect(Object.isFrozen(target)).toBe(true);
    }
    expect(Object.isFrozen(VAULT_TARGETS)).toBe(true);
    expect(Object.is(KAMINO_TARGET, (VAULT_TARGETS as AnyRecord)["sentora-pyusd"])).toBe(true);
    expect(canonical(KAMINO_TARGET)).toBe(CANONICAL_KAMINO_TARGET);
    expect(Object.keys(KAMINO_TARGET)).toEqual(["vault", "tokenMint", "kvaultProgram"]);
  });

  test("no slug is a prefix of another followed by a dash", () => {
    for (const a of EXPECTED_KEYS) for (const b of EXPECTED_KEYS) {
      if (a === b) continue;
      expect(a.startsWith(`${b}-`)).toBe(false);
    }
  });

  test("negative: the frozen registry refuses writes", () => {
    expect(() => { ((VAULT_TARGETS as AnyRecord)["rwa-usdc"] as AnyRecord).vault = "9xQeWvG816bUx9EPjHmaT23yvQM2nZs"; }).toThrow();
    expect(() => { ((VAULT_TARGETS as AnyRecord)["fresh-slug"] as AnyRecord) = {}; }).toThrow();
  });
});

// ====================================================================
// AC2 — capture bound to its slug
// ====================================================================
describe("AC2 capture bound to its slug", () => {
  const tmp = tmpRoot("kamino-bind");

  test("accepts both committed Sentora captures and every committed new capture", () => {
    for (const id of listDirs(SENTORA_ROOT)) expect(() => loadCapture(join(SENTORA_ROOT, id))).not.toThrow();
    for (const slug of SLUGS) for (const id of captureDirs(slug)) {
      expect(() => loadCapture(join(NEW_ROOT, slug, id))).not.toThrow();
    }
  });

  test("accepts a capture with a free captureId and Sentora's target", () => {
    const src = firstSentoraDir();
    const manifest = readJson(join(src, "manifest.json"));
    const records: AnyRecord = {};
    for (const file of manifest.records) records[file] = readJson(join(src, file));
    manifest.captureId = "hash-check-free";
    expect(() => verifyCapture({ manifest, records })).not.toThrow();
  });

  test("rejects a slug/target mismatch in both directions, an unregistered target, and a mixed binding", () => {
    const sentoraDir = firstSentoraDir();
    const rwaDir = firstCaptureDir("rwa-usdc");
    const unregistered = {
      vault: "So1111111111111111111111111111111111111112",
      tokenMint: EXPECTED_TARGETS["sentora-pyusd"]!.tokenMint,
      kvaultProgram: KVAULT_PROGRAM,
    };

    // (a) a rwa capture carrying allez's target
    const dirA = copyCapture(rwaDir, tmp, "rwa-usdc-binding-a");
    rewriteManifest(dirA, m => { m.target = { ...(VAULT_TARGETS as AnyRecord)["allez-sol"] }; });
    expect(rejectCode(() => loadCapture(dirA))).toBe("malformed-capture");
    expect(() => loadCapture(rwaDir)).not.toThrow(); // the unmodified twin is accepted

    // (b) a Sentora capture renamed under the rwa slug
    const dirB = copyCapture(sentoraDir, tmp, "rwa-usdc-20261111T000000Z");
    expect(rejectCode(() => loadCapture(dirB))).toBe("malformed-capture");
    expect(() => loadCapture(sentoraDir)).not.toThrow();

    // (c) a Sentora capture with a well-formed but unregistered target
    const dirC = copyCapture(sentoraDir, tmp, "sentora-free-unregistered-target");
    rewriteManifest(dirC, m => { m.target = unregistered; });
    expect(rejectCode(() => loadCapture(dirC))).toBe("malformed-capture");

    // (d) a free captureId bound to Sentora but carrying rwa's target
    const dirD = copyCapture(sentoraDir, tmp, "hash-check-free-mixed");
    rewriteManifest(dirD, m => { m.target = { ...(VAULT_TARGETS as AnyRecord)["rwa-usdc"] }; });
    expect(rejectCode(() => loadCapture(dirD))).toBe("malformed-capture");
  }, 120000);
});

// ====================================================================
// AC3 — recording a registered vault, refusing an unregistered one
// ====================================================================
describe("AC3 record a registered vault, refuse an unregistered one", () => {
  const RWA_FIRST = join(NEW_ROOT, "rwa-usdc", "rwa-usdc-20261112T003925Z");

  function recordedResponses(): { http: AnyRecord[]; rpc: AnyRecord[] } {
    const http: AnyRecord[] = [];
    const rpc: AnyRecord[] = [];
    for (const file of readJson(join(RWA_FIRST, "manifest.json")).records as string[]) {
      const record = readJson(join(RWA_FIRST, file));
      (record.kind === "rpc" ? rpc : http).push(record);
    }
    return { http, rpc };
  }

  test("records rwa-usdc from the committed responses through a stubbed fetch", async () => {
    const { http, rpc } = recordedResponses();
    const out = tmpRoot("kamino-rec");
    let stubCalls = 0;
    const stub = async (input: any, init?: any): Promise<Response> => {
      stubCalls++;
      const url = typeof input === "string" ? input : String(input.url);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        const parsed = new URL(url);
        const record = http.find(r => r.host === parsed.host && r.path === parsed.pathname);
        if (!record) throw new Error(`stub: no recorded GET response for ${url}`);
        return new Response(record.body, { status: record.httpStatus, headers: record.headers });
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      const record = rpc.find(r => canonical(r.params) === canonical(body.params));
      if (!record) throw new Error(`stub: no recorded RPC response for ${url}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: record.response }),
        { status: 200, headers: { "content-type": "application/json" } });
    };
    fetchSpy.mockImplementation(stub);
    try {
      const capture = await recordCapture({
        vault: "rwa-usdc", out, rpcUrl: "https://api.mainnet-beta.solana.com", offline: false, minIntervalMs: 0,
      } as any);
      expect(capture.manifest.captureId).toMatch(/^rwa-usdc-\d{8}T\d{6}Z$/);
      expect(canonical(capture.manifest.target)).toBe(canonical((VAULT_TARGETS as AnyRecord)["rwa-usdc"]));
      expect((capture.records["api-vault.json"] as AnyRecord).path).toContain(EXPECTED_TARGETS["rwa-usdc"]!.vault);
      expect((capture.records["api-metrics.json"] as AnyRecord).path).toContain(EXPECTED_TARGETS["rwa-usdc"]!.vault);
      expect(readdirSync(out)).toEqual([capture.manifest.captureId]);
      expect(readdirSync(join(out, capture.manifest.captureId)).sort())
        .toEqual(["manifest.json", ...(capture.manifest.records as string[])].sort());
      expect(stubCalls).toBe(8);
 expect(hits.fetch).toBe(0);
    } finally {
      fetchSpy.mockImplementation(trapFetch);
      rmSync(out, { recursive: true, force: true });
    }
  }, 60000);

  test("negative: an unregistered vault is refused before any request and writes nothing", async () => {
    const out = tmpRoot("kamino-ref");
    const listingBefore = readdirSync(NEW_ROOT);
    const kaminoBefore = readdirSync(SENTORA_ROOT);
    try {
      await expect(recordCapture({ vault: "no-such-vault", out } as any)).rejects.toThrow("Unregistered vault: no-such-vault");
      await expect(recordCapture({ vault: "__proto__", out } as any)).rejects.toThrow();
      await expect(recordCapture({ vault: "toString", out } as any)).rejects.toThrow();
      expect(existsSync(join(NEW_ROOT, "no-such-vault"))).toBe(false);
      expect(readdirSync(NEW_ROOT)).toEqual(listingBefore);
      expect(readdirSync(SENTORA_ROOT)).toEqual(kaminoBefore);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60000);

  test.skipIf(!DEV_CAPTURE)("negative: the CLI refuses an unregistered vault without a request and without writes", () => {
    const kaminoBefore = readdirSync(SENTORA_ROOT);
    const vaultsBefore = readdirSync(NEW_ROOT);
    const child = spawnScript(["--record", "--vault", "no-such-vault"]);
    expect(child.exitCode).toBe(1);
    expect(child.stderr).toContain("Unregistered vault");
    expect(child.stderr).toContain("no-such-vault");
    expect(child.stderr).not.toContain("network request failed");
    expect(readdirSync(SENTORA_ROOT)).toEqual(kaminoBefore);
    expect(readdirSync(NEW_ROOT)).toEqual(vaultsBefore);
  }, 60000);

  test.skipIf(!DEV_CAPTURE)("the CLI with no arguments prints the usage line and exits 2", () => {
    const child = spawnScript([]);
    expect(child.exitCode).toBe(2);
    expect(child.stdout + child.stderr).toContain("Usage");
  }, 60000);
});

// ====================================================================
// AC4 — committed captures and their check
// ====================================================================
describe("AC4 committed captures and their check", () => {
  for (const slug of SLUGS) {
    test(`${slug}: exactly two real captures, 30 minutes apart, check passes`, () => {
      const ids = captureDirs(slug);
      expect(ids).toHaveLength(2);
      const manifests = ids.map(id => readJson(join(NEW_ROOT, slug, id, "manifest.json")));
      for (let i = 0; i < 2; i++) {
        expect(manifests[i].captureId).toBe(ids[i]);
        expect(ids[i].startsWith(`${slug}-`)).toBe(true);
        expect(manifests[i].constructed).toBe(false);
      }
      const gapMinutes = (Date.parse(manifests[1].startedAt) - Date.parse(manifests[0].startedAt)) / 60000;
      expect(gapMinutes).toBeGreaterThanOrEqual(30);
      const stateA = readJson(join(NEW_ROOT, slug, ids[0], "rpc-state.json"));
      const stateB = readJson(join(NEW_ROOT, slug, ids[1], "rpc-state.json"));
      expect(stateA.slot).not.toBeNull();
      expect(stateB.slot).not.toBeNull();
      expect(stateA.slot).not.toBe(stateB.slot);

      if (DEV_CAPTURE) expect(spawnScript(["--check", join("fixtures", "kamino-vaults", slug)]).exitCode).toBe(0);

      const snapshots = buildKaminoSnapshots(join("fixtures", "kamino-vaults", slug));
      expect(snapshots).toHaveLength(2);
      expect(Number(snapshots[0].toBlockOrSlot)).toBeLessThan(Number(snapshots[1].toBlockOrSlot));
      for (let i = 0; i < 2; i++) {
        expect(snapshots[i].id).toBe(`solana-mainnet-beta.kamino.${ids[i]}`);
        expect(snapshots[i].constructed).toBe(false);
        expect(() => validateSnapshot(snapshots[i])).not.toThrow();
      }
    }, 120000);
  }
});

// ====================================================================
// AC5 — each vault's own graph, from its own capture
// ====================================================================
describe("AC5 each vault's own graph", () => {
  for (const slug of SLUGS) {
    test(`${slug}: subjects, decoded name, allocations and token quantities`, () => {
      const dir = firstCaptureDir(slug);
      const vaultId = identity(EXPECTED_TARGETS[slug]!.vault);
      const mintId = identity(EXPECTED_TARGETS[slug]!.tokenMint);
      const bytes = vaultBytes(dir);
      const result = normalizeCapture(loadCapture(dir));
      const snapshot = result.snapshot;

      expect(snapshot.subjects).toContain(vaultId);
      expect(snapshot.subjects).not.toContain(SENTORA_VAULT_ID);
      expect(snapshot.names[vaultId]).toBe(decodeName(bytes));
      if (EXPECTED_NAMES[slug] !== undefined) expect(snapshot.names[vaultId]).toBe(EXPECTED_NAMES[slug]);

      const secondDir = join(NEW_ROOT, slug, captureDirs(slug)[1]!);
      const snapshots = [snapshot, normalizeCapture(loadCapture(secondDir)).snapshot];
      const answer = runQuery(openStore(snapshots), {
        name: "dependencies", subject: vaultId, relations: ["ALLOCATES_TO"], scope: scopeOf(snapshot),
      });
      expect(answer.outcome).toBe("complete");
      const allocated = answer.facts
        .filter(f => f.subject === vaultId && f.predicate === "ALLOCATES_TO")
        .map(f => f.object).sort();
      expect(allocated).toEqual(allocationKeys(bytes).map(identity).sort());
      expect(allocated.length).toBeGreaterThan(0);

      const decimals = TOKEN_DECIMALS[slug] ?? 6;
      const sharesMintId = identity(pubkeyAt(bytes, SHARES_MINT_OFFSET));
      const sharesDecimals = bytes[SHARES_DECIMALS_OFFSET];
      let sawShares = false;
      for (const q of result.mechanics.quantities) {
        if (q.subject !== vaultId || q.unit !== "token-base-units") continue;
        if (q.name === "vault.sharesIssued") {
          sawShares = true;
          expect(q.mint).toBe(sharesMintId);
          expect(q.decimals).toBe(sharesDecimals);
        } else {
          expect(q.mint).toBe(mintId);
          expect(q.decimals).toBe(decimals);
        }
      }
      expect(sawShares).toBe(true);
    }, 120000);
  }

  test("ethena-pyusd-prime and the existing vault share the PYUSD identity with disjoint vault subjects", () => {
    const prime = normalizeCapture(loadCapture(firstCaptureDir("ethena-pyusd-prime")));
    const sentora = normalizeCapture(loadCapture(firstSentoraDir()));
    const primeToken = prime.mechanics.quantities.find(q => q.name === "vault.tokenAvailable");
    const sentoraToken = sentora.mechanics.quantities.find(q => q.name === "vault.tokenAvailable");
    expect(primeToken!.mint).toBe(PYUSD_IDENTITY);
    expect(sentoraToken!.mint).toBe(PYUSD_IDENTITY);
    const vaultsOf = (r: ReturnType<typeof normalizeCapture>) =>
      r.mechanics.entities.filter(e => e.kind === "Vault").map(e => e.id);
    const primeVaults = vaultsOf(prime);
    const sentoraVaults = vaultsOf(sentora);
    expect(primeVaults.length).toBeGreaterThan(0);
    for (const v of primeVaults) expect(sentoraVaults).not.toContain(v);
  }, 120000);
});

// ====================================================================
// AC6 — failure and malformed input
// ====================================================================
describe("AC6 failure and malformed input", () => {
  const tmp = tmpRoot("kamino-fail");

  test("a vault account carrying another mint yields malformed-record and no allocation fact", () => {
    const vaultId = identity(EXPECTED_TARGETS["rwa-usdc"]!.vault);
    const dir = copyCapture(firstCaptureDir("rwa-usdc"), tmp, "rwa-usdc-mint-mismatch");
    const wrongMint = new PublicKey(EXPECTED_TARGETS["allez-sol"]!.tokenMint).toBytes();
    rewriteRecord(dir, "rpc-state.json", record => {
      const keys = record.params[0] as string[];
      const index = keys.indexOf(EXPECTED_TARGETS["rwa-usdc"]!.vault);
      const data = Buffer.from(record.response.value[index].data[0], "base64");
      data.set(wrongMint, 80);
      record.response.value[index].data[0] = data.toString("base64");
    });
    const result = normalizeCapture(loadCapture(dir));
    expect(result.gaps.some(g => g.code === "malformed-record" && g.subject === vaultId)).toBe(true);
    expect(result.snapshot.facts.some(f => f.subject === vaultId && f.predicate === "ALLOCATES_TO")).toBe(false);
  }, 120000);

  test("a listed record file deleted from a copy yields missing-record with no network call", () => {
    const dir = copyCapture(firstCaptureDir("allez-sol"), tmp, "allez-sol-missing-record");
    unlinkSync(join(dir, "rpc-state.json"));
    expect(rejectCode(() => loadCapture(dir))).toBe("missing-record");
  }, 120000);

  test("a changed response byte without a recomputed hash yields hash-mismatch", () => {
    const dir = copyCapture(firstCaptureDir("rwa-usdc"), tmp, "rwa-usdc-hash-mismatch");
    rewriteRecord(dir, "api-metrics.json", () => { /* body changed below, hash deliberately stale */ });
    const path = join(dir, "api-metrics.json");
    const record = readJson(path);
    record.body = `${record.body}x`; // changed body, stale bodySha256
    writeFileSync(path, JSON.stringify(record));
    expect(rejectCode(() => loadCapture(dir))).toBe("hash-mismatch");
  }, 120000);

  test("a record slot disagreeing with the response context yields slot-mismatch", () => {
    const dir = copyCapture(firstCaptureDir("rwa-usdc"), tmp, "rwa-usdc-slot-mismatch");
    const path = join(dir, "rpc-state.json");
    const state = readJson(path);
    state.slot += 1; // response unchanged, hash still valid
    writeFileSync(path, JSON.stringify(state));
    expect(rejectCode(() => loadCapture(dir))).toBe("slot-mismatch");
  }, 120000);

  test("two captures of different slugs at one slot yield same-slot; each alone builds", () => {
    const shared = join(tmp, "shared");
    const slot = Number(readJson(join(firstCaptureDir("rwa-usdc"), "rpc-state.json")).slot);
    const dirA = copyCapture(firstCaptureDir("rwa-usdc"), shared, "rwa-usdc-same-slot-a");
    const dirB = copyCapture(firstCaptureDir("allez-sol"), shared, "allez-sol-same-slot-b");
    for (const [dir, file] of [[dirA, "rpc-state.json"], [dirA, "rpc-programs.json"], [dirB, "rpc-state.json"], [dirB, "rpc-programs.json"]] as const) {
      rewriteRecord(dir, file, record => { record.slot = slot; record.response.context.slot = slot; });
    }
    expect(rejectCode(() => buildKaminoSnapshots(shared))).toBe("same-slot");

    const aloneA = join(tmp, "alone-a");
    const aloneB = join(tmp, "alone-b");
    copyCapture(firstCaptureDir("rwa-usdc"), aloneA, "rwa-usdc-same-slot-a");
    copyCapture(firstCaptureDir("allez-sol"), aloneB, "allez-sol-same-slot-b");
    expect(buildKaminoSnapshots(aloneA)).toHaveLength(1);
    expect(buildKaminoSnapshots(aloneB)).toHaveLength(1);
  }, 120000);

  test.skipIf(!DEV_CAPTURE)("a root with one real capture fails the CLI check with nothing on stdout", () => {
    const single = join(tmp, "single");
    copyCapture(firstCaptureDir("rwa-usdc"), single, "rwa-usdc-20261112T003925Z");
    const child = spawnScript(["--check", single]);
    expect(child.exitCode).toBe(1);
    expect(child.stdout).toBe("");
  }, 120000);
});

// ====================================================================
// AC7 — analyst output only
// ====================================================================
describe("AC7 analyst output only", () => {
  const FORBIDDEN = /\b(exploit|safe|unsafe|risk score|rating|should|recommend|buy|sell)\b/i;
  const UNITS = new Set(["token-base-units", "ctoken-base-units", "bps", "pct", "ppm", "weight", "lamports", "ratio"]);

  test("the forbidden-word detector fires on a seeded string", () => {
    expect(FORBIDDEN.test("you should sell")).toBe(true);
    expect(FORBIDDEN.test("SAFE")).toBe(true);
    expect(FORBIDDEN.test("risk score")).toBe(true);
  });

  test("no snapshot text, gap detail or check output carries an added analyst word", () => {
    for (const slug of SLUGS) {
      for (const id of captureDirs(slug)) {
        const result = normalizeCapture(loadCapture(join(NEW_ROOT, slug, id)));
        const scrubbed = canonical({ ...result.snapshot, names: {} });
        expect(FORBIDDEN.test(scrubbed)).toBe(false);
        for (const gap of result.gaps) expect(FORBIDDEN.test(gap.detail)).toBe(false);
      }
    }
    const sentora = normalizeCapture(loadCapture(firstSentoraDir()));
    expect(FORBIDDEN.test(canonical({ ...sentora.snapshot, names: {} }))).toBe(false);
    for (const slug of DEV_CAPTURE ? SLUGS : []) {
      const child = spawnScript(["--check", join("fixtures", "kamino-vaults", slug)]);
      expect(child.exitCode).toBe(0);
      expect(FORBIDDEN.test(child.stdout)).toBe(false);
    }
  }, 180000);

  test("quantities carry no USD unit and keep the adapter's bases; facts stay decoded except the unknown controller", () => {
    for (const slug of SLUGS) {
      for (const id of captureDirs(slug)) {
        const result = normalizeCapture(loadCapture(join(NEW_ROOT, slug, id)));
        for (const q of result.mechanics.quantities) {
          expect(UNITS.has(q.unit)).toBe(true);
          expect(q.unit.toLowerCase()).not.toContain("usd");
          expect(q.name.toLowerCase()).not.toContain("usd");
          if (q.name.startsWith("vault.reported.")) expect(q.basis).toBe("reported");
          else expect(["decoded", "derived"]).toContain(q.basis);
        }
        for (const fact of result.snapshot.facts) {
          if (fact.predicate === "CONTROLLED_BY") {
            expect(fact.basis).toBe("unknown");
            expect(fact.status).toBe("unverified");
            expect(fact.object).toBe("unknown");
          } else {
            expect(fact.basis).toBe("decoded");
          }
        }
      }
    }
  }, 180000);

  test("an authority not decoded as a multisig stays CONTROLLED_BY unknown and answers unknown-controller", () => {
    let checked = 0;
    for (const slug of SLUGS) {
      const dir = firstCaptureDir(slug);
      const result = normalizeCapture(loadCapture(dir));
      const unknowns = result.mechanics.entities
        .filter(e => e.kind === "Authority" && e.controllerType === "unknown").map(e => e.id);
      for (const subject of unknowns) {
        checked++;
        const fact = result.snapshot.facts.find(f => f.predicate === "CONTROLLED_BY" && f.subject === subject);
        expect(fact).toBeDefined();
        expect(fact!.object).toBe("unknown");
        const answer = runQuery(openStore([result.snapshot]), { name: "control", subject, scope: scopeOf(result.snapshot) });
        expect(answer.reasons.some(r => r.code === "unknown-controller")).toBe(true);
      }
    }
    if (checked === 0) {
      // no new vault has an unknown controller; the shared code path is exercised on the existing vault instead
      const sentora = normalizeCapture(loadCapture(firstSentoraDir()));
      const subject = sentora.mechanics.entities.find(e => e.kind === "Authority" && e.controllerType === "unknown")!.id;
      const answer = runQuery(openStore([sentora.snapshot]), { name: "control", subject, scope: scopeOf(sentora.snapshot) });
      expect(answer.reasons.some(r => r.code === "unknown-controller")).toBe(true);
    }
  }, 180000);
});

// ====================================================================
// AC8 — replay, isolation, compatibility
// ====================================================================
describe("AC8 replay, isolation, compatibility", () => {
  test("two builds of each new root are byte-identical and match the pinned snapshot hashes", () => {
    for (const slug of SLUGS) {
      const root = join("fixtures", "kamino-vaults", slug);
      const first = buildKaminoSnapshots(root);
      const second = buildKaminoSnapshots(root);
      expect(second.map(s => canonical(s))).toEqual(first.map(s => canonical(s)));
      for (const snapshot of first) {
        const key = `${slug}/${snapshot.id.replace("solana-mainnet-beta.kamino.", "")}`;
        expect(SNAPSHOT_SHA256[key]).toBeDefined();
        expect(sha256(canonical(snapshot))).toBe(SNAPSHOT_SHA256[key]);
      }
    }
  }, 180000);

  test("the default root keeps its pinned hash and the layout file stays byte-identical", () => {
    expect(sha256(canonical(buildKaminoSnapshots()))).toBe(DEFAULT_ROOT_SHA256);
    expect(sha256(readFileSync(join(ROOT, "src", "adapters", "kamino", "layout.ts")))).toBe(LAYOUT_SHA256);
  }, 120000);

  test("every runtime export of the shared adapter survives unchanged", () => {
    const adapter = require("../src/adapters/kamino/index") as AnyRecord;
    const expected = [
      "CLAIM_WINDOW_MS", "CaptureRejected", "HTTP_HEADERS", "KAMINO_TARGET", "KLEND_PROGRAM",
      "KVAULT_PROGRAM", "LAYOUT_SOURCES", "METRIC_KEYS", "MechanicsRejected", "NULL_PUBKEY",
      "OFFSETS", "RELATION_ENDPOINTS", "REQUIRED_RECORDS", "SCOPE_CHAIN_UNUSED", "SQUADS_PROGRAM",
      "SYSTEM_PROGRAM", "UPGRADEABLE_LOADER", "accountBytes", "buildKaminoSnapshots", "compareIdleClaim",
      "decodeMarket", "decodeProgram", "decodeProgramDataHead", "decodeReserve", "decodeSquadsMultisig",
      "decodeVault", "identity", "isConfiguredKey", "isDecodeFailure", "loadCapture", "normalizeCapture",
      "orderSnapshots", "parseIdleClaim", "printableName", "programDataAddress", "validateMechanics",
      "verifyCapture",
    ];
    for (const name of expected) expect(typeof adapter[name]).not.toBe("undefined");
    expect(Object.isFrozen((VAULT_TARGETS as AnyRecord)["sentora-pyusd"])).toBe(true);
  });
});


describe("review 051 follow-ups", () => {
  test.skipIf(!DEV_CAPTURE)("check rejects captures under another registered root slug", () => {
    const tmp = tmpRoot("review-051-root");
    try {
      const root = join(tmp, "rwa-usdc");
      for (const id of captureDirs("allez-sol")) {
        const dir = copyCapture(join(NEW_ROOT, "allez-sol", id), root, id);
        copyFileSync(join(NEW_ROOT, "allez-sol", id, "manifest.json"), join(dir, "manifest.json"));
      }
      const result = spawnScript(["--check", root]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("does not match root slug rwa-usdc");
      expect(result.stdout).toBe("");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test.skipIf(!DEV_CAPTURE)("check rejects a directory name different from captureId", () => {
    const tmp = tmpRoot("review-051-folder");
    try {
      const dir = copyCapture(firstCaptureDir("allez-sol"), tmp, "wrong-folder");
      copyFileSync(join(firstCaptureDir("allez-sol"), "manifest.json"), join(dir, "manifest.json"));
      const result = spawnScript(["--check", tmp]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must equal manifest captureId");
      expect(result.stdout).toBe("");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("recorder refuses Sentora root before fetch", async () => {
    await expect(recordCapture({ vault: "rwa-usdc", out: "fixtures/kamino" })).rejects.toThrow("reserved for sentora-pyusd");
    expect(hits.fetch).toBe(0);
  });

  test("recorder refuses another registered output slug before fetch", async () => {
    await expect(recordCapture({ vault: "rwa-usdc", out: "fixtures/kamino-vaults/allez-sol/" })).rejects.toThrow("does not match recording slug rwa-usdc");
    expect(hits.fetch).toBe(0);
  });
});
