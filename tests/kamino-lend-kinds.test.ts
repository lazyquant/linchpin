// Independent tests for the Kamino Lend kinds model: every entity kind comes from a
// decoded fact the recorded snapshot already holds, never from a name. Every expected
// value is a literal from the approved contract or is recomputed here from the committed
// capture's own facts — never from what the implementation prints. The whole file runs
// offline: fetch, WebSocket, Bun.connect, node:net and node:http(s) are trapped and any
// call fails.
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";
import { PublicKey } from "@solana/web3.js";
import { canonical, sha256 } from "../src/chain/evidence";
import { validateMechanics, MechanicsRejected } from "../src/adapters/kamino/mechanics";
import type { Entity, KaminoMechanics } from "../src/adapters/kamino/mechanics";
import {
  buildKaminoLendSnapshots, buildKaminoLendResults, loadKaminoLendCapture,
  normalizeKaminoLendCapture, CaptureRejected, SCOPE_PROGRAM,
} from "../src/adapters/kamino-lend";
import { collectEvidenceInputs, collectSlice1Inputs } from "../src/graph/evidence/protocols";
import type { EvidenceInput } from "../src/graph/evidence/protocols";
import { buildEvidenceRecords, recordsSha256, recordCounts } from "../src/graph/evidence/build";
import type { EvidenceRecords } from "../src/graph/evidence/build";
import { validateEvidenceRecords } from "../src/graph/evidence/validate";
import { runEvidenceLocal } from "../src/graph/evidence/templates";
import { loadMain } from "../src/graph/evidence/cli";

// ---- repository-relative paths (resolved here, never absolute) ----
const ROOT = join(import.meta.dir, "..");
const repoRoot = resolve(import.meta.dir, "..");
const RECORDED_ROOT = "fixtures/kamino-lend";
const CAPTURE_ID = "main-market-20261111T195059Z";
const NEW_PIN = "tests/fixtures/kamino-lend-kinds/records.sha256";
const SUPERSEDED_PIN = "tests/fixtures/kamino-evidence-graph/records.sha256";
const SLICE1_PIN = "tests/fixtures/evidence-graph-model/records.sha256";
const SNAPSHOT_PIN_FILE = "tests/fixtures/kamino-lend-market/snapshot.sha256";
const readPin = (rel: string) => readFileSync(join(ROOT, rel), "utf8").trim();

// ---- offline trap for the whole file ----
const hits: Record<string, number> = { fetch: 0, websocket: 0, connect: 0, net: 0 };
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
  expect(hits).toEqual({ fetch: 0, websocket: 0, connect: 0, net: 0 });
});

// ---- scratch captures: mutated copies of the recorded one, hashes recomputed locally ----
const scratch = mkdtempSync(realpathSync(tmpdir()) + "/kamino-lend-kinds-tests-");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const bytesOf = (v: any) => Buffer.from(Array.isArray(v.data) ? v.data[0] : v.data, "base64");
const toId = (b58: string) => new PublicKey(b58).toBuffer();

type RawCapture = { manifest: any; records: Record<string, any> };
function readRecordedRaw(): RawCapture {
  const dir = resolve(repoRoot, RECORDED_ROOT, CAPTURE_ID);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const records: Record<string, any> = {};
  for (const f of manifest.records) records[f] = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return { manifest, records };
}
/** Write a mutated raw capture into the scratch dir; rehash unless the test wants a mismatch. */
function writeCapture(name: string, raw: RawCapture, rehash = true): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const m = structuredClone(raw.manifest);
  m.captureId = name;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  for (const [file, rec] of Object.entries(raw.records)) {
    const r = structuredClone(rec);
    if (rehash) {
      if (r.kind === "rpc") r.responseSha256 = sha256(canonical(r.response));
      else r.bodySha256 = sha256(r.body);
    }
    writeFileSync(join(dir, file), JSON.stringify(r));
  }
  return dir;
}
function withCapture(name: string, mutate: (raw: RawCapture) => void, rehash = true): string {
  const raw = readRecordedRaw();
  mutate(raw);
  return writeCapture(name, raw, rehash);
}
/** Patch one account's bytes inside one RPC record of a raw capture. */
function patchAccount(raw: RawCapture, file: string, key: string, offset: number, b58: string) {
  const rec = raw.records[file];
  const i = rec.params[0].indexOf(key);
  if (i < 0) throw new Error(`key ${key} not in ${file}`);
  const buf = bytesOf(rec.response.value[i]);
  buf.set(toId(b58), offset);
  const v = rec.response.value[i];
  v.data = [buf.toString("base64"), Array.isArray(v.data) ? v.data[1] : "base64"];
}
const load = (dir: string) => normalizeKaminoLendCapture(loadKaminoLendCapture(dir));

// ---- identities, all from the approved contract or the recorded manifest ----
const CHAIN = "solana:mainnet-beta:";
const MARKET = CHAIN + "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const PYUSD_RESERVE = CHAIN + "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN";
const SCOPE_ORACLE_A = CHAIN + "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";
const SCOPE_ORACLE_B = CHAIN + "3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C";
const SWITCHBOARD_PRICE = CHAIN + "2fnxDPcLAZzYy1pJTMFNUo2mxWHD4ggrEgTu6my54Npm";
const SQUADS_V3_ADMIN = CHAIN + "4htL3T1tBMRNczRXiQrZvNMhmZsxL7PPQtQSzMuSDpvX";
const SPL_TOKEN_B58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN = CHAIN + SPL_TOKEN_B58;
const SCOPE_IDENTITY = CHAIN + SCOPE_PROGRAM;

// ---- the K2/K3 rules, recomputed here from the snapshot facts alone ----
type Expected = Map<string, Map<string, string[]>>; // kind -> id -> evidenceIds
function expectedEntities(facts: { subject: string; predicate: string; object: string; evidenceIds: string[] }[]): Expected {
  const kinds: Expected = new Map([
    ["Market", new Map()], ["Reserve", new Map()], ["Mint", new Map()], ["OracleSource", new Map()],
    ["Program", new Map()], ["ProgramData", new Map()], ["Authority", new Map()],
  ]);
  const ownerProgram = new Map<string, string[]>();
  const pricedObjects = new Set<string>();
  for (const f of facts) {
    if (f.predicate === "OWNER_PROGRAM") ownerProgram.set(f.subject, f.evidenceIds);
    if (f.predicate === "PRICED_BY") pricedObjects.add(f.object);
  }
  for (const f of facts) {
    const add = (kind: string, id: string, evidenceIds: string[]) => {
      if (!kinds.get(kind)!.has(id)) kinds.get(kind)!.set(id, evidenceIds);
    };
    if (f.predicate === "IN_MARKET" && f.object === MARKET) add("Reserve", f.subject, f.evidenceIds);
    else if (f.predicate === "DECIMALS") add("Mint", f.subject, f.evidenceIds);
    else if (f.predicate === "PROGRAM_DATA") {
      add("Program", f.subject, f.evidenceIds);
      add("ProgramData", f.object, f.evidenceIds);
    } else if (f.predicate === "MULTISIG_THRESHOLD") add("Authority", f.subject, f.evidenceIds);
    else if (f.predicate === "OWNER_PROGRAM" && f.object === SCOPE_IDENTITY && pricedObjects.has(f.subject)) {
      add("OracleSource", f.subject, f.evidenceIds);
    } else if (f.predicate === "MARKET_OWNER" && f.subject === MARKET && ownerProgram.has(MARKET)) {
      add("Market", MARKET, ownerProgram.get(MARKET)!);
    }
  }
  return kinds;
}

// ---- shared fixtures, built once ----
let recordedRaw: RawCapture;
let recorded: ReturnType<typeof normalizeKaminoLendCapture>;
let expected: Expected;
let inputs: EvidenceInput[];
let records: EvidenceRecords;
let baseRecords: EvidenceRecords;
let lendInput: EvidenceInput;
const LEND_SNAPSHOT_ID_RE = /^solana-mainnet-beta\.kamino-lend\./;

beforeAll(() => {
  recordedRaw = readRecordedRaw();
  recorded = load(resolve(repoRoot, RECORDED_ROOT, CAPTURE_ID));
  expected = expectedEntities(recorded.snapshot.facts);
  inputs = collectEvidenceInputs(".");
  lendInput = inputs.find(i => LEND_SNAPSHOT_ID_RE.test(i.snapshot.id))!;
  records = buildEvidenceRecords(inputs);
  // the base full build: the same inputs with the Lend kinds model removed
  baseRecords = buildEvidenceRecords(inputs.map(i => LEND_SNAPSHOT_ID_RE.test(i.snapshot.id) ? { snapshot: i.snapshot } : i));
});

const entityIdsOf = (kind: string) => [...(expected.get(kind) ?? new Map<string, string[]>()).keys()];
const nodesOf = (recs: EvidenceRecords, id: string) => recs.nodes.filter(n => n.label === "Entity" && n.id === id);

// ================================================================ AC1
describe("AC1 the kinds model of the recorded capture", () => {
  test("relations and quantities are empty; the model survives its own validator unchanged", () => {
    expect(recorded.mechanics.relations).toEqual([]);
    expect(recorded.mechanics.quantities).toEqual([]);
    expect(validateMechanics(recorded.mechanics)).toEqual(recorded.mechanics);
  });

  test("the entities are exactly Market 1, Reserve 58, Mint 55, OracleSource 2, Program 2, ProgramData 2, Authority 5", () => {
    const counts: Record<string, number> = {};
    for (const e of recorded.mechanics.entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    expect(counts).toEqual({
      Market: 1, Reserve: 58, Mint: 55, OracleSource: 2, Program: 2, ProgramData: 2, Authority: 5,
    });
    expect(recorded.mechanics.entities.length).toBe(125);
  });

  test("every Authority is a decoded Squads v4 multisig", () => {
    const authorities = recorded.mechanics.entities.filter(e => e.kind === "Authority");
    expect(authorities.length).toBe(5);
    for (const e of authorities) expect(e.controllerType).toBe("squads-v4-multisig");
    for (const e of recorded.mechanics.entities) {
      if (e.kind !== "Authority") expect(e.controllerType).toBeUndefined();
    }
  });

  test("entity ids are unique, sorted, and every one is a subject of the snapshot", () => {
    const ids = recorded.mechanics.entities.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    const subjects = new Set(recorded.snapshot.subjects);
    for (const id of ids) expect(subjects.has(id)).toBe(true);
  });

  test("the ordered build of the recorded fixture carries the same model", () => {
    const result = buildKaminoLendResults(resolve(repoRoot, RECORDED_ROOT))[0]!;
    expect(canonical(result.mechanics)).toBe(canonical(recorded.mechanics));
  });

  test("falsifying example: the entity validator refuses a duplicate id and accepts the recorded model", () => {
    const forged: KaminoMechanics = structuredClone(recorded.mechanics);
    forged.entities = [forged.entities[0]!, forged.entities[0]!];
    let error: any;
    try { validateMechanics(forged); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(MechanicsRejected);
    expect(error.code).toBe("duplicate-entity");
    expect(() => validateMechanics(recorded.mechanics)).not.toThrow();
  });
});

// ================================================================ AC2
describe("AC2 kinds come from decoded facts, never names", () => {
  test("each kind's id set equals the set recomputed from the snapshot facts, both directions", () => {
    for (const [kind, map] of expected) {
      const actual = recorded.mechanics.entities.filter(e => e.kind === kind).map(e => e.id);
      expect([kind, actual.slice().sort()]).toEqual([kind, [...map.keys()].sort()]);
      expect(new Set(actual).size).toBe(actual.length);
    }
  });

  test("each entity cites the evidence of the fact its rule ties it to", () => {
    for (const [kind, map] of expected) {
      for (const [id, evidenceIds] of map) {
        const entity = recorded.mechanics.entities.find(e => e.kind === kind && e.id === id)!;
        expect([kind, id, entity.evidenceIds]).toEqual([kind, id, evidenceIds]);
      }
    }
    // an OracleSource cites the oracle account's own OWNER_PROGRAM read, one receipt each
    for (const id of [SCOPE_ORACLE_A, SCOPE_ORACLE_B]) {
      const fact = recorded.snapshot.facts.find(f => f.predicate === "OWNER_PROGRAM" && f.subject === id)!;
      expect(fact.evidenceIds.length).toBe(1);
      const entity = recorded.mechanics.entities.find(e => e.kind === "OracleSource" && e.id === id)!;
      expect(entity.evidenceIds).toEqual(fact.evidenceIds);
    }
  });

  test("renaming every API liquidity token changes the names and leaves the model byte-identical", () => {
    expect(Object.keys(recorded.snapshot.names).length).toBeGreaterThan(0);
    const dir = withCapture(CAPTURE_ID, raw => {
      const api = raw.records["api-reserves.json"];
      const body = JSON.parse(api.body);
      for (const e of body) e.liquidityToken = "Reserve";
      api.body = JSON.stringify(body);
    });
    const renamed = load(dir);
    expect(canonical(renamed.snapshot.names)).not.toBe(canonical(recorded.snapshot.names));
    expect(canonical(renamed.mechanics)).toBe(canonical(recorded.mechanics));
  });
});

// ================================================================ AC3
describe("AC3 failure and missing evidence leave no kind", () => {
  test("a reserve whose market membership bytes point elsewhere: membership-mismatch, no entity, 57 reserves", () => {
    const dir = withCapture("membership-moved", raw =>
      patchAccount(raw, "rpc-state.json", PYUSD_RESERVE.replace(CHAIN, ""), 32, SPL_TOKEN_B58));
    const result = load(dir);
    expect(result.gaps.some(g => g.code === "membership-mismatch" && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(result.mechanics.entities.some(e => e.id === PYUSD_RESERVE)).toBe(false);
    expect(result.mechanics.entities.filter(e => e.kind === "Reserve").length).toBe(57);
    expect(expectedEntities(result.snapshot.facts).get("Reserve")!.size).toBe(57);
  });

  test("a reserve with a corrupted discriminator: malformed-record, no entity, 57 reserves", () => {
    const dir = withCapture("discriminator-broken", raw => {
      const rec = raw.records["rpc-state.json"];
      const i = rec.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ""));
      const buf = bytesOf(rec.response.value[i]);
      buf[0] = buf[0]! ^ 0xff;
      rec.response.value[i].data = [buf.toString("base64"), Array.isArray(rec.response.value[i].data) ? "base64" : rec.response.value[i].data[1]];
    });
    const result = load(dir);
    expect(result.gaps.some(g => g.code === "malformed-record" && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(result.mechanics.entities.some(e => e.id === PYUSD_RESERVE)).toBe(false);
    expect(result.mechanics.entities.filter(e => e.kind === "Reserve").length).toBe(57);
  });

  test("a null market account: missing-account, no Market entity, and the build gives the market no Market kind", () => {
    // the same capture id keeps the snapshot id on its registered series, so the build accepts it
    const dir = withCapture(CAPTURE_ID, raw => {
      const rec = raw.records["rpc-state.json"];
      const i = rec.params[0].indexOf(MARKET.replace(CHAIN, ""));
      rec.response.value[i] = null;
    });
    const result = load(dir);
    expect(result.gaps.some(g => g.code === "missing-account" && g.subject === MARKET)).toBe(true);
    expect(result.mechanics.entities.some(e => e.kind === "Market")).toBe(false);
    const recs = buildEvidenceRecords([{ snapshot: result.snapshot, mechanics: result.mechanics }]);
    const marketNodes = nodesOf(recs, MARKET);
    for (const node of marketNodes) expect(node.kinds).not.toContain("Market");
  });

  test("the Switchboard price account and the Squads v3 admin are not entities; nothing is a Vault", () => {
    const ids = new Set(recorded.mechanics.entities.map(e => e.id));
    expect(ids.has(SWITCHBOARD_PRICE)).toBe(false);
    expect(ids.has(SQUADS_V3_ADMIN)).toBe(false);
    expect(recorded.mechanics.entities.some(e => e.kind === "Vault")).toBe(false);
  });

  test("a capture the verifier rejects throws CaptureRejected with the recorded code, so no mechanics at all", () => {
    const dir = withCapture("hash-mismatch-copy", raw => {
      patchAccount(raw, "rpc-state.json", PYUSD_RESERVE.replace(CHAIN, ""), 100, SPL_TOKEN_B58);
    }, /* rehash */ false);
    let error: any;
    try { loadKaminoLendCapture(dir); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CaptureRejected);
    expect(error.code).toBe("hash-mismatch");
  });
});

// ================================================================ AC4
describe("AC4 the snapshot and slice 1 stay byte-identical", () => {
  test("the canonical Kamino Lend snapshot still matches its pinned sha256", () => {
    const a = canonical(buildKaminoLendSnapshots()[0]);
    const b = canonical(buildKaminoLendSnapshots(resolve(repoRoot, RECORDED_ROOT))[0]);
    expect(a).toBe(b);
    expect(sha256(b)).toBe(readPin(SNAPSHOT_PIN_FILE));
  });

  test("slice 1 still builds to its pinned records hash", () => {
    expect(recordsSha256(buildEvidenceRecords(collectSlice1Inputs(".")))).toBe(readPin(SLICE1_PIN));
  });

  test("the plain dry run prints the slice-1 hash and reads no configuration", async () => {
    const out: string[] = [], err: string[] = [];
    let forbiddenCalls = 0;
    const deps = {
      createDriver: () => { forbiddenCalls++; throw new Error("no driver in a dry run"); },
      readText: () => { forbiddenCalls++; throw new Error("no config file read in a dry run"); },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
    const exit = await loadMain(["--dry-run"], new Proxy({}, {
      get() { throw new Error("no configuration read in a dry run"); },
    }) as Record<string, string | undefined>, deps);
    expect(exit).toBe(0);
    expect(forbiddenCalls).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.at(-1)!).recordsSha256).toBe(readPin(SLICE1_PIN));
  });
});

// ================================================================ AC5
describe("AC5 the labels the full build gains", () => {
  const CHANGED = new Set(["Reserve", "Token", "Oracle", "Multisig", "Market", "Program", "ProgramData"]);

  test("the Lend input carries the recorded kinds model", () => {
    expect(canonical(lendInput.mechanics!)).toBe(canonical(recorded.mechanics));
  });

  test("the changed label counts are the contract's literals; every other label count is the base build's", () => {
    const labels = recordCounts(records).labels;
    expect(labels["Reserve"]).toBe(90);
    expect(labels["Token"]).toBe(61);
    expect(labels["Oracle"]).toBe(2);
    expect(labels["Multisig"]).toBe(5);
    expect(labels["Market"]).toBe(24);
    expect(labels["Program"]).toBe(23);
    expect(labels["ProgramData"]).toBe(3);
    const baseLabels = recordCounts(baseRecords).labels;
    expect(baseLabels["Entity"]).toBe(1271);
    // Facts are scoped to their snapshot, even when fact ids recur across snapshots.
    const factUids = new Set(inputs.flatMap(({ snapshot }) =>
      snapshot.facts.map(fact => `${snapshot.id}/${fact.id}`),
    ));
    expect(baseLabels["Fact"]).toBe(factUids.size);
    expect(baseLabels["Receipt"]).toBe(636);
    expect(baseLabels["Snapshot"]).toBe(18);
    expect(baseLabels["Protocol"]).toBe(11);
    expect(baseLabels["Coverage"]).toBe(121);
    const rest = (all: Record<string, number>) =>
      Object.fromEntries(Object.entries(all).filter(([k]) => !CHANGED.has(k)));
    expect(rest(labels)).toEqual(rest(baseLabels));
  });

  test("every relationship type count is the base build's", () => {
    expect(recordCounts(records).types).toEqual(recordCounts(baseRecords).types);
  });

  test("the relationships are byte-identical to the base build's", () => {
    expect(canonical(records.relationships)).toBe(canonical(baseRecords.relationships));
  });

  test("every reserve and mint carries its kind, subkind, basis and evidence; every multisig its kind", () => {
    const nodeOf = (id: string) => {
      const nodes = nodesOf(records, id);
      expect(nodes.length).toBe(1);
      return nodes[0]!;
    };
    const check = (kind: string, label: string, id: string, subkind: string | null) => {
      const node = nodeOf(id);
      expect(node.kinds).toContain(label);
      expect(node.props.kindBasis).toBe("decoded");
      if (subkind !== null) expect(node.props.subkind).toBe(subkind);
      for (const evidenceId of expected.get(kind)!.get(id)!) {
        expect(node.props.kindEvidenceIds as string[]).toContain(evidenceId);
      }
    };
    for (const id of entityIdsOf("Reserve")) check("Reserve", "Reserve", id, "klend.reserve");
    for (const id of entityIdsOf("Mint")) check("Mint", "Token", id, "spl.mint");
    for (const id of entityIdsOf("Authority")) check("Authority", "Multisig", id, null);
  });

  test("the multisig label sits on exactly the five decoded Squads v4 accounts", () => {
    const multisigNodes = records.nodes.filter(n => n.label === "Entity" && n.kinds.includes("Multisig"));
    expect(multisigNodes.map(n => n.id).sort()).toEqual(entityIdsOf("Authority").sort());
  });

  test("the Switchboard price account keeps kinds [] and no node outside the model changes", () => {
    const board = nodesOf(records, SWITCHBOARD_PRICE);
    expect(board.length).toBe(1);
    expect(board[0]!.kinds).toEqual([]);
    const modelIds = new Set(recorded.mechanics.entities.map(e => e.id));
    const kindOf = (recs: EvidenceRecords) => {
      const map = new Map<string, { kinds: string[]; subkind: unknown }>();
      for (const n of recs.nodes.filter(n => n.label === "Entity")) {
        map.set(n.id, { kinds: n.kinds, subkind: n.props.subkind ?? null });
      }
      return map;
    };
    const newMap = kindOf(records), baseMap = kindOf(baseRecords);
    expect([...newMap.keys()].sort()).toEqual([...baseMap.keys()].sort());
    for (const [id, node] of newMap) {
      if (modelIds.has(id)) continue;
      expect([id, node]).toEqual([id, baseMap.get(id)!]);
    }
  });
});

// ================================================================ AC6
describe("AC6 determinism and the new full-set pin", () => {
  const OLD_HASH = "f5279c48b3c625123e3bb63a9e7a4deb4cadc8da60c1bd0313de78327962fb9f";

  test("two builds and one from shuffled inputs share the pinned hash", () => {
    const pinned = readPin(NEW_PIN);
    expect(recordsSha256(records)).toBe(pinned);
    expect(recordsSha256(buildEvidenceRecords(collectEvidenceInputs(".")))).toBe(pinned);
    const shuffled = [...inputs].sort(() => Math.random() - 0.5);
    expect(recordsSha256(buildEvidenceRecords(shuffled))).toBe(pinned);
  });

  test("both pin files hold the new hash, and it differs from the old full-set hash", () => {
    for (const pin of [NEW_PIN, SUPERSEDED_PIN]) {
      expect(readPin(pin)).toMatch(/^[0-9a-f]{64}$/);
      expect(readPin(pin)).toBe(recordsSha256(records));
    }
    expect(readPin(NEW_PIN)).not.toBe(OLD_HASH);
  });

  test("the validator accepts the full build", () => {
    expect(() => validateEvidenceRecords(records)).not.toThrow();
  });

  test("the full-set dry run exits 0 and prints the pinned hash", async () => {
    const out: string[] = [], err: string[] = [];
    let forbiddenCalls = 0;
    const deps = {
      createDriver: () => { forbiddenCalls++; throw new Error("no driver in a dry run"); },
      readText: () => { forbiddenCalls++; throw new Error("no config file read in a dry run"); },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
    const exit = await loadMain(["--dry-run", "--all"], new Proxy({}, {
      get() { throw new Error("no configuration read in a dry run"); },
    }) as Record<string, string | undefined>, deps);
    expect(exit).toBe(0);
    expect(forbiddenCalls).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.at(-1)!).recordsSha256).toBe(readPin(NEW_PIN));
  });

  test("entity-resolve for the market and dependencies for a reserve run locally without error", () => {
    expect(() => runEvidenceLocal(records, "entity-resolve", { text: MARKET, limit: 10 })).not.toThrow();
    expect(() => runEvidenceLocal(records, "dependencies", {
      subject: PYUSD_RESERVE,
      scope: {
        snapshotId: lendInput.snapshot.id, asOf: lendInput.snapshot.observedTo,
        maxHops: 1, maxResults: 100,
      },
      relations: ["IN_MARKET", "ALLOCATES_TO", "ASSET_MINT", "PRICED_BY"],
    })).not.toThrow();
  });
});

// ================================================================ AC7
describe("AC7 offline and isolated", () => {
  test("the trap is live: a direct fetch throws offline", () => {
    expect(() => globalThis.fetch("https://invalid.example/probe")).toThrow();
    hits.fetch = 0; // this one call was intentional; the check below still covers every accidental call
  });

  afterEach(() => {
    for (const [kind, n] of Object.entries(hits)) expect([kind, n]).toEqual([kind, 0]);
    for (const k of Object.keys(hits)) hits[k] = 0;
  });
});
