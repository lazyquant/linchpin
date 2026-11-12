// Independent tests for the Kamino Lend market contract, as amended by the
// recorded decisions: Q2 (coverage notes beside the snapshot), Q3 (names only from the API
// tickers), Q4 (validFrom null for recorded captures, observedFrom for constructed).
// Every expected value comes from the contract, the recorded decisions, the recorded
// address manifest or the committed capture's own records — never from what the
// implementation prints.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { PublicKey } from '@solana/web3.js';
import { canonical, sha256 } from '../src/chain/evidence';
import { openStore, runQuery, validateSnapshot, VOCABULARY, SUBJECT_PATTERN, isPredicate } from '../src/engine/queries';
import { CORE_TYPES, checkVocabulary } from '../src/graph/evidence/schema';
import {
  buildKaminoLendSnapshots, buildKaminoLendResults, loadKaminoLendCapture,
  normalizeKaminoLendCapture, CaptureRejected,
} from '../src/adapters/kamino-lend';

// Some checks below read inputs that only the development repository carries (the publish list, private
// fixtures, capture scripts, earlier commits). The published tree leaves those out on purpose, so there
// these checks are skipped rather than failed; in the development repository they always run.
const DEV_CAPTURE = existsSync(join(import.meta.dir, "..", "scripts", "kamino-lend-capture.ts"));

const repoRoot = resolve(import.meta.dir, '..');
const RECORDED_ROOT = 'fixtures/kamino-lend';
const CAPTURE_ID = 'main-market-20261111T195059Z';
const CONSTRUCTED_ROOT = resolve(repoRoot, 'tests/fixtures/kamino-lend-market');
const scratch = mkdtempSync(realpathSync(tmpdir()) + '/kamino-lend-tests-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---- offline trap for the whole file (spec AC8; pattern of tests/evidence-graph-model.test.ts) ----
const hits: Record<string, number> = { fetch: 0, websocket: 0, connect: 0, net: 0, http: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
const restores: Array<() => void> = [];
beforeAll(() => {
  for (const [obj, key, bucket] of [
    [globalThis, 'fetch', 'fetch'], [globalThis, 'WebSocket', 'websocket'], [Bun, 'connect', 'connect'],
    [net, 'connect', 'net'], [net, 'createConnection', 'net'],
    [http, 'request', 'http'], [http, 'get', 'http'], [https, 'request', 'http'], [https, 'get', 'http'],
  ] as const) {
    const o = obj as any, old = o[key];
    o[key] = function (...args: unknown[]) { hits[bucket]++; throw trapError(String(key)); };
    restores.push(() => { o[key] = old; });
  }
});
afterAll(() => { for (const restore of restores) restore(); });
afterEach(() => {
  for (const [kind, n] of Object.entries(hits)) expect([kind, n]).toEqual([kind, 0]);
  for (const k of Object.keys(hits)) hits[k] = 0;
});

// ---- identities, all from the spec, the gate-1 decisions or the address manifest ----
const CHAIN = 'solana:mainnet-beta:';
const MARKET = CHAIN + '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const KLEND = CHAIN + 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const GLOBAL_CONFIG = CHAIN + 'BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W';
const PYUSD_RESERVE = CHAIN + '2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN';
const PYUSD_MINT = CHAIN + '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const FEED_A = CHAIN + '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';
const FEED_B = CHAIN + '3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C';
const SWITCHBOARD_PRICE = CHAIN + '2fnxDPcLAZzYy1pJTMFNUo2mxWHD4ggrEgTu6my54Npm';
const XSTEP_RESERVE = CHAIN + 'Ggn9EUzL5QQPM8JPsyu1MU1uD3rGJty7iXddLQnmxPyS';
const MARKET_OWNER = CHAIN + '24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT';
const COUNCIL = CHAIN + '4VtJ1yCCyU2YGgPTZGHZRwzwaZ3hmzgqMtRQo8RqMa57';
const PROPOSER = CHAIN + 'BN73b8HCQUsqdrBTqFuzqk9o1SH7fUTEcXxYmv43agJH';
const KLEND_UPGRADE = CHAIN + 'GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW';
const SCOPE_UPGRADE = CHAIN + '4R33WT7isNgzALNyvpZKiZQARtZNAXarWB3prUbPkXX7';
const GLOBAL_ADMIN = CHAIN + 'A9rQoX1sictAQkyXxaZA8nz674xutHwoqpK2mwLyexCZ';
const SPL_TOKEN = CHAIN + 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MS_MARKET_OWNER = CHAIN + '7idEEVRidWrahZJhxXMqniDbV6ESj7ZjyLrigcMcEt6H';
const MS_COUNCIL = CHAIN + '9thcmURbz3xgvv362Fy2uGVGoxMnD3ADRuwRp13nuXE5';
const MS_PROPOSER = CHAIN + '53EGEAU2TqM9rrqhskJUT5qFfxfPADb647LnCqrfciVV';
const MS_KLEND_UPGRADE = CHAIN + '6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM';
const MS_SCOPE_UPGRADE = CHAIN + 'DDJGaWjVREXffoMe9nyvb1c7wpajLdh7fTnAb2giD9RM';
const NULL_KEY = CHAIN + '11111111111111111111111111111111';

// Authority -> multisig, threshold, member count (spec AC4; manifest roles).
const CONTROL_PAIRS: [string, string, number, number][] = [
  [MARKET_OWNER, MS_MARKET_OWNER, 4, 10],
  [COUNCIL, MS_COUNCIL, 2, 10],
  [PROPOSER, MS_PROPOSER, 1, 4],
  [KLEND_UPGRADE, MS_KLEND_UPGRADE, 5, 10],
  [SCOPE_UPGRADE, MS_SCOPE_UPGRADE, 5, 10],
];

// ---- recorded manifest of the case (independent expectation source) ----
const manifestRows: any[] = JSON.parse(readFileSync(resolve(repoRoot, 'tests/fixtures/kamino-lend-market/address-manifest.json'), 'utf8')).addresses ?? [];
const reserveRows = new Map(manifestRows.filter(r => r.role === 'reserve').map(r => [CHAIN + r.address, r]));

// ---- helpers: nothing here trusts the implementation; hashes are recomputed locally ----
const bytesOf = (v: any) => Buffer.from(Array.isArray(v.data) ? v.data[0] : v.data, 'base64');
const toId = (b58: string) => new PublicKey(b58.replace(CHAIN, '')).toBuffer();

type RawCapture = { manifest: any; records: Record<string, any> };
function readRecordedRaw(): RawCapture {
  const dir = resolve(repoRoot, RECORDED_ROOT, CAPTURE_ID);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const records: Record<string, any> = {};
  for (const f of manifest.records) records[f] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return { manifest, records };
}
/** Write a mutated raw capture into the scratch dir; rehash unless the test wants a mismatch. */
function writeCapture(name: string, raw: RawCapture, rehash = true): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const m = structuredClone(raw.manifest);
  m.captureId = name;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
  for (const [file, rec] of Object.entries(raw.records)) {
    const r = structuredClone(rec);
    if (rehash) {
      if (r.kind === 'rpc') r.responseSha256 = sha256(canonical(r.response));
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
function fullCopy(name: string): string { return withCapture(name, () => {}); }
const load = (dir: string) => normalizeKaminoLendCapture(loadKaminoLendCapture(dir));
function rejectedCode(dir: string): { thrown: boolean; code: string } {
  try { loadKaminoLendCapture(dir); return { thrown: false, code: '' }; }
  catch (e) { return { thrown: e instanceof CaptureRejected, code: e instanceof CaptureRejected ? e.code : String((e as Error).message) }; }
}
/** Patch one account's bytes inside one RPC record of a raw capture. */
function patchAccount(raw: RawCapture, file: string, key: string, offset: number, b58: string) {
  const rec = raw.records[file];
  const i = rec.params[0].indexOf(key.replace(CHAIN, ''));
  if (i < 0) throw new Error(`key ${key} not in ${file}`);
  const buf = bytesOf(rec.response.value[i]);
  buf.set(toId(b58), offset);
  const v = rec.response.value[i];
  v.data = [buf.toString('base64'), Array.isArray(v.data) ? v.data[1] : 'base64'];
}
const subject = (b58: string) => CHAIN + b58;

let recorded: ReturnType<typeof load>;
let recordedSnapshot: ReturnType<typeof validateSnapshot>;
let recordedRaw: RawCapture;
const SNAPSHOT_PIN = 'd902fb6f6b4683df43f5ca8abbe29b09a9829b6e153f2450c2723da19e67d88c';

beforeAll(() => {
  recorded = load(resolve(repoRoot, RECORDED_ROOT, CAPTURE_ID));
  recordedSnapshot = validateSnapshot(recorded.snapshot);
  recordedRaw = readRecordedRaw();
});

const isIdentity = (s: string) => SUBJECT_PATTERN.test(s);
const factsWith = (pred: string, snap = recordedSnapshot) => snap.facts.filter(f => f.predicate === pred);
const receiptsOf = (snap: ReturnType<typeof validateSnapshot>, ids: string[]) => snap.receipts.filter(r => ids.includes(r.id));

// ============================================================ AC1
describe('AC1 recorded capture and receipts', () => {
  test('T1.1 the committed capture builds, validates, and an unlisted stray file changes nothing', () => {
    expect(recordedSnapshot.constructed).toBe(false);
    expect(validateSnapshot(recorded.snapshot)).toBeDefined();
    const strayRoot = join(scratch, 'stray-root');
    cpSync(resolve(repoRoot, RECORDED_ROOT), strayRoot, { recursive: true });
    writeFileSync(join(strayRoot, CAPTURE_ID, 'stray-not-listed.txt'), 'not in the manifest');
    const withStray = buildKaminoLendSnapshots(strayRoot);
    expect(withStray.length).toBe(1);
    expect(canonical(withStray[0])).toBe(canonical(recorded.snapshot));
    expect(canonical(withStray[0].facts)).toBe(canonical(recordedSnapshot.facts));
  });

  test('T1.2 every stored hash and slot equals the locally recomputed one', () => {
    for (const [file, rec] of Object.entries(recordedRaw.records)) {
      if (rec.kind === 'rpc') {
        expect([file, rec.responseSha256]).toEqual([file, sha256(canonical(rec.response))]);
        expect([file, rec.slot]).toEqual([file, rec.response.context.slot]);
      } else {
        expect([file, rec.bodySha256]).toEqual([file, sha256(rec.body)]);
      }
    }
  });

  test('T1.3 every receipt is fixture-sourced, offline, dated, current-only; recorded facts have validFrom null', () => {
    const ids = new Set<string>();
    const fileRe = /(api-reserves|rpc-state|rpc-assets|rpc-control|rpc-programs)\.json/;
    for (const r of recordedSnapshot.receipts) {
      expect(ids.has(r.id)).toBe(false); ids.add(r.id);
      expect(r.source).toMatch(new RegExp(`^fixture:kamino-lend/${CAPTURE_ID}/${fileRe.source}#([1-9A-HJ-NP-Za-km-z]{32,44}|body)$`));
      expect(r.source).not.toMatch(/:\/\//);
      expect(r.source).not.toContain('api.kamino.finance');
      expect(r.source.startsWith('/')).toBe(false);
      expect(r.observation.historicalState).toBe('current-only');
      expect(r.observation.observedAt).toBe(r.observation.retrievedAt);
      expect(r.privacy).toBe('public');
      const fileName = fileRe.exec(r.source)![1] + '.json';
      const rec = recordedRaw.records[fileName];
      if (rec.kind === 'rpc') {
        expect([fileName, r.observation.blockOrSlot]).toEqual([fileName, String(rec.slot)]);
      } else {
        expect(r.observation.blockOrSlot).toBeNull();
      }
      expect(r.observation.observedAt).toBe(rec.retrievedAt);
    }
    expect(recordedSnapshot.receipts.length).toBe(140);
    for (const f of recordedSnapshot.facts) expect(f.validFrom).toBeNull();
  });

  test('T1.4 negative: a null account is a recorded absence — missing-account gap, no fact for that subject', () => {
    const dir = withCapture('null-mint', raw => {
      const rec = raw.records['rpc-assets.json'];
      const i = rec.params[0].indexOf(PYUSD_MINT.replace(CHAIN, ''));
      rec.response.value[i] = null;
    });
    const result = load(dir);
    const subj = PYUSD_MINT;
    expect(result.gaps.some(g => g.code === 'missing-account' && g.subject === subj)).toBe(true);
    expect(result.snapshot.facts.some(f => f.subject === subj)).toBe(false);
  });
});

// ============================================================ AC2
describe('AC2 typed facts, exact identities, the full case', () => {
  test('T2.1 predicates are vocabulary entries; identities exact; evidence resolves; derived cites two receipts', () => {
    const receiptIds = new Set(recordedSnapshot.receipts.map(r => r.id));
    for (const f of recordedSnapshot.facts) {
      expect(isPredicate(f.predicate)).toBe(true);
      expect(f.subject).toMatch(SUBJECT_PATTERN);
      if (!f.object.startsWith('amount:') && f.object !== 'none' && f.object !== 'unknown') {
        expect(isIdentity(f.object)).toBe(true);
      }
      expect(f.evidenceIds.length).toBeGreaterThan(0);
      for (const id of f.evidenceIds) expect(receiptIds.has(id)).toBe(true);
      if (f.basis === 'derived') {
        expect(f.evidenceIds.length).toBeGreaterThanOrEqual(2);
        expect(new Set(f.evidenceIds).size).toBe(f.evidenceIds.length);
      }
    }
  });

  test('T2.2 exactly the full case: 58 reserves in the market, 58 mints, 59 priced-by edges matching the recorded manifest', () => {
    const inMarket = factsWith('IN_MARKET');
    expect(inMarket.length).toBe(58);
    for (const f of inMarket) expect([f.subject, f.object]).toEqual([f.subject, MARKET]);
    const assetMint = factsWith('ASSET_MINT');
    expect(assetMint.length).toBe(58);
    expect(new Set(assetMint.map(f => f.subject)).size).toBe(58);
    const pricedBy = factsWith('PRICED_BY');
    expect(pricedBy.length).toBe(59);
    for (const f of pricedBy) {
      expect([FEED_A, FEED_B, SWITCHBOARD_PRICE].includes(f.object)).toBe(true);
      expect([NULL_KEY, CHAIN + 'nu1111111111111111111111111111111111111nu1111'].includes(f.object)).toBe(false);
    }
    // each reserve's priced-by edges equal the manifest's configured sources
    const bySubject = new Map<string, string[]>();
    for (const f of pricedBy) bySubject.set(f.subject, [...(bySubject.get(f.subject) ?? []), f.object]);
    for (const [reserve, objects] of bySubject) {
      const row = reserveRows.get(reserve);
      expect(row).toBeDefined();
      const expected = [CHAIN + row.scopePriceFeed, ...(row.switchboardPrice ? [CHAIN + row.switchboardPrice] : [])].sort();
      expect([reserve, objects.slice().sort()]).toEqual([reserve, expected]);
    }
    expect(bySubject.get(XSTEP_RESERVE)).toContain(SWITCHBOARD_PRICE);
    expect(bySubject.size).toBe(58);
    // the recorded reserve bytes carry the market at offset 32 and the feed at 5112
    const state = recordedRaw.records['rpc-state.json'];
    for (const [b58, row] of reserveRows) {
      const i = state.params[0].indexOf(b58.replace(CHAIN, ''));
      if (i < 0) continue;
      const buf = bytesOf(state.response.value[i]);
      expect(buf.subarray(32, 64).equals(toId(MARKET))).toBe(true);
      expect(buf.subarray(5112, 5144).equals(toId(CHAIN + row.scopePriceFeed))).toBe(true);
    }
  });

  test('T2.3 renaming every API ticker leaves facts byte-identical and changes names (Q3)', () => {
    // same directory name, so the captureId — and every receipt source — stays identical
    const dir = withCapture(CAPTURE_ID, raw => {
      const api = raw.records['api-reserves.json'];
      const body = JSON.parse(api.body);
      for (const e of body) e.liquidityToken = e.liquidityToken + ' renamed-display';
      api.body = JSON.stringify(body);
    });
    const result = load(dir);
    expect(validateSnapshot(result.snapshot)).toBeDefined();
    expect(Object.keys(recordedSnapshot.names).length).toBeGreaterThan(0);
    expect(canonical(result.snapshot.facts)).toBe(canonical(recordedSnapshot.facts));
    expect(canonical(result.snapshot.names)).not.toBe(canonical(recordedSnapshot.names));
    const renamedValues = new Set(Object.values(result.snapshot.names));
    expect([...renamedValues].some(v => v.endsWith('renamed-display'))).toBe(true);
  });
});

// ============================================================ AC3
describe('AC3 dependencies through the existing query', () => {
  const scope = (snap: ReturnType<typeof validateSnapshot>, asOf?: string) =>
    ({ snapshotId: snap.id, asOf: asOf ?? snap.observedTo, maxHops: 2, maxResults: 500 });

  test('T3.1 dependencies of the PYUSD reserve are exactly market, mint and Scope feed, outcome complete', () => {
    const store = openStore(buildKaminoLendSnapshots(resolve(repoRoot, RECORDED_ROOT)));
    const result = runQuery(store, { name: 'dependencies', subject: PYUSD_RESERVE, relations: ['IN_MARKET', 'ASSET_MINT', 'PRICED_BY'], scope: scope(recordedSnapshot) });
    expect(result.outcome).toBe('complete');
    expect(result.facts.map(f => f.object).sort()).toEqual([MARKET, PYUSD_MINT, FEED_A].sort());
  });

  test('T3.2 an asOf after freshUntil answers stale', () => {
    const store = openStore(buildKaminoLendSnapshots(resolve(repoRoot, RECORDED_ROOT)));
    const late = new Date(Date.parse(recordedSnapshot.freshUntil) + 1000).toISOString();
    const result = runQuery(store, { name: 'dependencies', subject: PYUSD_RESERVE, relations: ['IN_MARKET', 'ASSET_MINT', 'PRICED_BY'], scope: scope(recordedSnapshot, late) });
    expect(result.reasons.some(r => r.code === 'stale')).toBe(true);
  });

  test('T3.3 negative: a reserve whose feed bytes changed prices through the other feed', () => {
    const dir = withCapture('feed-moved', raw => patchAccount(raw, 'rpc-state.json', PYUSD_RESERVE, 5112, FEED_B));
    const result = load(dir);
    const snap = validateSnapshot(result.snapshot);
    const store = openStore([snap]);
    const answer = runQuery(store, { name: 'dependencies', subject: PYUSD_RESERVE, relations: ['IN_MARKET', 'ASSET_MINT', 'PRICED_BY'], scope: scope(snap) });
    const objects = answer.facts.map(f => f.object);
    expect(objects).toContain(FEED_B);
    expect(objects).not.toContain(FEED_A);
  });
});

// ============================================================ AC4
describe('AC4 control, honestly bounded', () => {
  const scope = (snap: ReturnType<typeof validateSnapshot>) =>
    ({ snapshotId: snap.id, asOf: snap.observedTo, maxHops: 2, maxResults: 500 });
  const storeOf = () => openStore(buildKaminoLendSnapshots(resolve(repoRoot, RECORDED_ROOT)));

  test('T4.1 control on the market returns the three decoded powers', () => {
    const result = runQuery(storeOf(), { name: 'control', subject: MARKET, scope: scope(recordedSnapshot) });
    const byPredicate = new Map(result.facts.map(f => [f.predicate, f]));
    for (const [pred, object] of [['MARKET_OWNER', MARKET_OWNER], ['EMERGENCY_AUTHORITY', COUNCIL], ['RESERVE_PROPOSER', PROPOSER]] as const) {
      const f = byPredicate.get(pred);
      expect(f).toBeDefined();
      expect([f!.object, f!.basis]).toEqual([object, 'decoded']);
    }
    expect(byPredicate.size).toBe(3);
  });

  test('T4.2 the five authorities derive to their multisigs with thresholds and members', () => {
    for (const [authority, ms, threshold, members] of CONTROL_PAIRS) {
      const f = recordedSnapshot.facts.find(x => x.predicate === 'CONTROLLED_BY' && x.subject === authority);
      expect([authority, f?.object]).toEqual([authority, ms]);
      expect([authority, f?.basis, f?.status]).toEqual([authority, 'derived', 'verified']);
      expect(f!.evidenceIds.length).toBeGreaterThanOrEqual(2);
      for (const id of f!.evidenceIds) expect(recordedSnapshot.receipts.some(r => r.id === id)).toBe(true);
      const thr = recordedSnapshot.facts.find(x => x.predicate === 'MULTISIG_THRESHOLD' && x.subject === ms);
      expect([ms, thr?.object]).toEqual([ms, `amount:${threshold}`]);
      const mem = recordedSnapshot.facts.filter(x => x.predicate === 'MULTISIG_MEMBER' && x.subject === ms);
      expect([ms, mem.length]).toEqual([ms, members]);
    }
  });

  test('T4.3 the global admin stays unknown-controller, honestly', () => {
    const gf = recordedSnapshot.facts.find(x => x.predicate === 'GLOBAL_ADMIN' && x.subject === GLOBAL_CONFIG);
    expect(gf?.object).toBe(GLOBAL_ADMIN);
    const ctl = recordedSnapshot.facts.find(x => x.predicate === 'CONTROLLED_BY' && x.subject === GLOBAL_ADMIN);
    expect([ctl?.object, ctl?.basis, ctl?.status]).toEqual(['unknown', 'unknown', 'unverified']);
    const result = runQuery(storeOf(), { name: 'control', subject: GLOBAL_ADMIN, scope: scope(recordedSnapshot) });
    expect(result.reasons.some(r => r.code === 'unknown-controller')).toBe(true);
  });

  test('T4.4 negative: a multisig whose vault PDA does not derive to the authority stays unknown', () => {
    const dir = withCapture('ms-key-moved', raw => {
      const rec = raw.records['rpc-control.json'];
      const keys = rec.params[0];
      const i = keys.indexOf(MS_MARKET_OWNER.replace(CHAIN, ''));
      keys[i] = SPL_TOKEN.replace(CHAIN, '');
    });
    const snap = validateSnapshot(load(dir).snapshot);
    const f = snap.facts.find(x => x.predicate === 'CONTROLLED_BY' && x.subject === MARKET_OWNER);
    expect([f?.object, f?.basis, f?.status]).toEqual(['unknown', 'unknown', 'unverified']);
    expect(f?.object).not.toBe(MS_MARKET_OWNER);
  });
});

// ============================================================ AC5
describe('AC5 changes between constructed snapshots', () => {
  const byId = new Map<string, ReturnType<typeof validateSnapshot>>();
  beforeAll(() => {
    for (const name of ['constructed-base', 'constructed-price-feed', 'constructed-market-owner']) {
      const snap = validateSnapshot(load(join(CONSTRUCTED_ROOT, name)).snapshot);
      byId.set(name, snap);
    }
  });

  test('Q4 constructed captures carry validFrom = observedFrom', () => {
    for (const snap of byId.values()) {
      expect(snap.constructed).toBe(true);
      for (const f of snap.facts) expect([snap.id, f.validFrom]).toEqual([snap.id, snap.observedFrom]);
      for (const r of snap.receipts) expect(r.observation.historicalState).toBe('constructed');
    }
  });

  test('T5.4 no capture under fixtures/kamino-lend is constructed', () => {
    const root = resolve(repoRoot, RECORDED_ROOT);
    const dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'));
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const m = JSON.parse(readFileSync(join(root, d.name, 'manifest.json'), 'utf8'));
      expect([d.name, m.constructed]).toEqual([d.name, false]);
    }
  });

  test('T5.1 a replaced price source is one removed and one added, receipts on both sides, constructed observations', () => {
    const store = openStore([...byId.values()]);
    const result = runQuery(store, { name: 'changes', subject: PYUSD_RESERVE, beforeSnapshotId: byId.get('constructed-base')!.id, afterSnapshotId: byId.get('constructed-price-feed')!.id, maxResults: 500 });
    const removed = result.changes.filter(c => c.kind === 'removed');
    const added = result.changes.filter(c => c.kind === 'added');
    expect([removed.length, added.length, result.changes.length]).toEqual([1, 1, 2]);
    expect(removed[0]!.before?.object).toBe(FEED_A);
    expect(added[0]!.after?.object).toBe(FEED_B);
    expect(removed[0]!.before!.evidenceIds.length).toBeGreaterThan(0);
    expect(added[0]!.after!.evidenceIds.length).toBeGreaterThan(0);
    for (const o of result.observations) expect(o.constructed).toBe(true);
  });

  test('T5.2 a replaced market owner is one changed', () => {
    const store = openStore([...byId.values()]);
    const result = runQuery(store, { name: 'changes', subject: MARKET, beforeSnapshotId: byId.get('constructed-base')!.id, afterSnapshotId: byId.get('constructed-market-owner')!.id, maxResults: 500 });
    const changed = result.changes.filter(c => c.kind === 'changed');
    expect([changed.length, result.changes.length]).toEqual([1, 1]);
    expect(changed[0]!.before!.object).toBe(MARKET_OWNER);
    expect(changed[0]!.after!.object).toBe(SPL_TOKEN);
    expect(changed[0]!.before!.evidenceIds.length).toBeGreaterThan(0);
    expect(changed[0]!.after!.evidenceIds.length).toBeGreaterThan(0);
    for (const o of result.observations) expect(o.constructed).toBe(true);
  });

  test('T5.3 negative: a pair differing only in receipts and ids returns no change', () => {
    const a = validateSnapshot(load(join(CONSTRUCTED_ROOT, 'constructed-base')).snapshot);
    const dirB = withCapture('constructed-base-twin', raw => {
      raw.manifest.constructed = true;
      const api = raw.records['api-reserves.json'];
      api.retrievedAt = new Date(Date.parse(api.retrievedAt) + 1000).toISOString();
      for (const rec of Object.values(raw.records)) if (rec.kind === 'rpc') rec.retrievedAt = api.retrievedAt;
    });
    const b = validateSnapshot(load(dirB).snapshot);
    const store = openStore([a, b]);
    const result = runQuery(store, { name: 'changes', subject: PYUSD_RESERVE, beforeSnapshotId: a.id, afterSnapshotId: b.id, maxResults: 500 });
    expect(result.changes).toEqual([]);
  });
});

// ============================================================ AC6
describe('AC6 failure and malformed input', () => {
  test('T6.1 a listed record file missing: missing-record, no network call', () => {
    const name = 'missing-record-copy';
    const dir = fullCopy(name);
    rmSync(join(dir, 'rpc-control.json'));
    const r = rejectedCode(dir);
    expect(r.thrown).toBe(true);
    expect(r.code).toBe('missing-record');
    expect(Object.values(hits).every(n => n === 0)).toBe(true);
  });

  test('T6.2 a response-hash mismatch and a body-hash mismatch are refused', () => {
    const rpcDir = withCapture('hash-mismatch-rpc', raw => {
      patchAccount(raw, 'rpc-assets.json', PYUSD_MINT, 44, SPL_TOKEN);
    }, /* rehash */ false);
    expect(rejectedCode(rpcDir)).toEqual({ thrown: true, code: 'hash-mismatch' });
    const httpDir = withCapture('hash-mismatch-http', raw => {
      const api = raw.records['api-reserves.json'];
      api.body = api.body.replace('"liquidityToken"', '"liquidityTokenX"');
    }, false);
    expect(rejectedCode(httpDir)).toEqual({ thrown: true, code: 'hash-mismatch' });
  });

  test('T6.3 a slot that disagrees with response.context.slot is refused', () => {
    const dir = withCapture('slot-mismatch-copy', raw => { raw.records['rpc-state.json'].slot += 1; });
    expect(rejectedCode(dir)).toEqual({ thrown: true, code: 'slot-mismatch' });
  });

  test('T6.4 an account named in two RPC records is refused', () => {
    const dir = withCapture('duplicate-account-copy', raw => {
      const state = raw.records['rpc-state.json'];
      const control = raw.records['rpc-control.json'];
      const i = state.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ''));
      control.params[0] = [...control.params[0], PYUSD_RESERVE.replace(CHAIN, '')];
      control.response.value = [...control.response.value, structuredClone(state.response.value[i])];
    });
    expect(rejectedCode(dir)).toEqual({ thrown: true, code: 'duplicate-account' });
  });

  test('T6.5 malformed manifest, malformed record JSON and a record path outside the capture directory', () => {
    const badManifest = fullCopy('malformed-manifest-copy');
    writeFileSync(join(badManifest, 'manifest.json'), '{ not json');
    expect(rejectedCode(badManifest).code).toBe('malformed-capture');

    const badRecord = fullCopy('malformed-record-copy');
    writeFileSync(join(badRecord, 'rpc-programs.json'), '{ truncated');
    expect(rejectedCode(badRecord).code).toBe('malformed-capture');

    const outside = fullCopy('path-outside-copy');
    const m = JSON.parse(readFileSync(join(outside, 'manifest.json'), 'utf8'));
    m.records = [...m.records, '../rpc-state.json'];
    writeFileSync(join(outside, 'manifest.json'), JSON.stringify(m));
    const r = rejectedCode(outside);
    expect(r.thrown).toBe(true);
    expect(r.code).toBe('malformed-capture');
  });

  test('T6.6 a reserve of another market gets membership-mismatch and no facts, the others are unaffected', () => {
    const dir = withCapture('membership-copy', raw => patchAccount(raw, 'rpc-state.json', PYUSD_RESERVE, 32, SPL_TOKEN));
    const result = load(dir);
    expect(result.gaps.some(g => g.code === 'membership-mismatch' && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(result.snapshot.facts.some(f => f.subject === PYUSD_RESERVE)).toBe(false);
    expect(factsWith('IN_MARKET', result.snapshot).length).toBe(57);
  });

  test('T6.7 a reserve of the wrong size, and one with a broken discriminator, get malformed-record', () => {
    const truncated = withCapture('truncated-reserve-copy', raw => {
      const rec = raw.records['rpc-state.json'];
      const i = rec.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ''));
      const buf = bytesOf(rec.response.value[i]).subarray(0, 8000);
      rec.response.value[i].data = [buf.toString('base64'), 'base64'];
    });
    let result = load(truncated);
    expect(result.gaps.some(g => g.code === 'malformed-record' && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(result.snapshot.facts.some(f => f.subject === PYUSD_RESERVE)).toBe(false);
    expect(factsWith('IN_MARKET', result.snapshot).length).toBe(57);

    const discriminator = withCapture('discriminator-copy', raw => {
      const rec = raw.records['rpc-state.json'];
      const i = rec.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ''));
      const buf = bytesOf(rec.response.value[i]);
      buf[0] = buf[0]! ^ 0xff;
      rec.response.value[i].data = [buf.toString('base64'), 'base64'];
    });
    result = load(discriminator);
    expect(result.gaps.some(g => g.code === 'malformed-record' && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(factsWith('IN_MARKET', result.snapshot).length).toBe(57);
  });

  test.skipIf(!DEV_CAPTURE)('T6.8 the capture checker exits 0 on the committed fixtures and non-zero on every rejected capture', () => {
    const run = (dir: string) => spawnSync('bun', ['run', 'scripts/kamino-lend-capture.ts', '--check', dir], { cwd: repoRoot, encoding: 'utf8' });
    const good = run(resolve(repoRoot, RECORDED_ROOT));
    expect([good.status, good.stderr]).toEqual([0, good.stderr]);
    const cases: [string, (raw: RawCapture) => void, string | null][] = [
      ['check-missing-record', () => {}, 'rpc-control.json'],
      ['check-hash-mismatch', raw => { patchAccount(raw, 'rpc-state.json', PYUSD_RESERVE, 100, SPL_TOKEN); }, null],
      ['check-slot-mismatch', raw => { raw.records['rpc-state.json'].slot += 1; }, null],
      ['check-duplicate-account', raw => {
        const state = raw.records['rpc-state.json'];
        const control = raw.records['rpc-control.json'];
        const i = state.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ''));
        control.params[0] = [...control.params[0], PYUSD_RESERVE.replace(CHAIN, '')];
        control.response.value = [...control.response.value, structuredClone(state.response.value[i])];
      }, null],
      ['check-membership', raw => patchAccount(raw, 'rpc-state.json', PYUSD_RESERVE, 32, SPL_TOKEN), null],
      ['check-truncated', raw => {
        const rec = raw.records['rpc-state.json'];
        const i = rec.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ''));
        rec.response.value[i].data = [bytesOf(rec.response.value[i]).subarray(0, 8000).toString('base64'), 'base64'];
      }, null],
      ['check-malformed-record-file', () => {}, null], // record JSON broken below
      ['check-malformed-manifest', () => {}, null], // manifest JSON broken below
      ['check-path-outside', () => {}, null], // extra listed path added below
    ];
    for (const [name, mutate, drop] of cases) {
      const dir = withCapture(name, mutate);
      if (name === 'check-malformed-record-file') writeFileSync(join(dir, 'rpc-programs.json'), '{ truncated');
      if (name === 'check-malformed-manifest') writeFileSync(join(dir, 'manifest.json'), '{ not json');
      if (name === 'check-path-outside') {
        const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        m.records = [...m.records, '../rpc-state.json'];
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
      }
      if (drop) rmSync(join(dir, drop));
      const bad = run(dir);
      expect([name, bad.status !== 0]).toEqual([name, true]);
    }
  });
});

// ============================================================ AC7
describe('AC7 analyst output only, gaps visible', () => {
  const FORBIDDEN = /\b(exploit|unsafe|safe|rating|should|recommend|buy|sell)\b|\brisk\s+score\b/i;
  const collect = (result: ReturnType<typeof load>) => {
    const strings: string[] = [];
    for (const g of result.gaps) strings.push(g.code, g.detail);
    for (const c of result.coverage) strings.push(c.id, c.detail);
    for (const [k, v] of Object.entries(result.snapshot.names)) strings.push(k, v);
    for (const f of result.snapshot.facts) strings.push(f.predicate, f.object);
    return strings;
  };

  test('T7.1 no forbidden analyst word in gaps, coverage, names, predicates or fact objects', () => {
    for (const s of collect(recorded)) expect([s.slice(0, 60), FORBIDDEN.test(s)]).toEqual([s.slice(0, 60), false]);
  });

  test('T7.2 every fact object is an identity, none, unknown or a raw amount; no reported decimal anywhere', () => {
    for (const f of recordedSnapshot.facts) {
      expect([f.object === 'none' || f.object === 'unknown' || /^amount:\d+$/.test(f.object) || isIdentity(f.object), f.predicate]).toEqual([true, f.predicate]);
    }
    expect(/\d+\.\d{4,}/.test(canonical(recordedSnapshot))).toBe(false);
  });

  test('T7.3 the coverage notes name every uncovered area, and every reserve its undecoded status', () => {
    const ids = new Set(recorded.coverage.map(c => c.id));
    for (const id of ['reserve-list-completeness', 'reserve-status', 'scope-chain-indices', 'multisig-timelock', 'pending-owner-admin', 'squads-v3-layout', 'fee-collector', 'switchboard-upgrade-authority', 'proposer-initialisation-phase']) {
      expect([id, ids.has(id)]).toEqual([id, true]);
    }
    const notes = recorded.coverage.filter(c => c.id === 'reserve-status-not-decoded');
    const reserves = new Set(factsWith('IN_MARKET').map(f => f.subject));
    for (const reserve of reserves) expect(notes.some(n => n.subject === reserve)).toBe(true);
    // Q2: notes are returned beside the snapshot, never inside it
    expect((recorded.snapshot as unknown as Record<string, unknown>).coverage).toBeUndefined();
    expect(recorded.coverage.every(c => c.code === 'missing-coverage')).toBe(true);
  });
});

// ============================================================ AC8
describe('AC8 replay, isolation, compatibility', () => {
  test('T8.1 two builds are byte-identical and equal the pinned sha256', () => {
    const a = canonical(buildKaminoLendSnapshots()[0]);
    const b = canonical(buildKaminoLendSnapshots(resolve(repoRoot, RECORDED_ROOT))[0]);
    expect(a).toBe(b);
    expect(sha256(b as unknown as string)).toBe(SNAPSHOT_PIN);
  });

  test('T8.2 the trap is live: a direct fetch throws offline', () => {
    expect(() => globalThis.fetch('https://invalid.example/probe')).toThrow();
    hits.fetch = 0; // this one call was intentional; the afterEach check still covers every accidental call
  });

  test('T8.3 the vocabulary baseline is unchanged; the three control entries added; schema maps each once', () => {
    const baseline = JSON.parse(readFileSync(join(CONSTRUCTED_ROOT, 'vocabulary-baseline.json'), 'utf8')) as Record<string, { class: string; direction: string; cardinality: string; traversable?: boolean }>;
    for (const [key, entry] of Object.entries(baseline)) {
      expect(JSON.stringify(VOCABULARY[key as keyof typeof VOCABULARY])).toBe(JSON.stringify(entry));
    }
    for (const key of ['EMERGENCY_AUTHORITY', 'RESERVE_PROPOSER', 'GLOBAL_ADMIN'] as const) {
      expect([key, VOCABULARY[key]]).toEqual([key, { class: 'control', direction: 'subject-to-object', cardinality: 'one' }]);
    }
    expect(() => checkVocabulary()).not.toThrow();
    for (const key of ['EMERGENCY_AUTHORITY', 'RESERVE_PROPOSER', 'GLOBAL_ADMIN']) {
      const mappings = Object.values(CORE_TYPES).flatMap(t => t.mappedFrom.map(m => m.predicate));
      expect([key, mappings.filter(p => p === key).length]).toEqual([key, 1]);
    }
    const pause = CORE_TYPES['PAUSE_AUTHORITY'];
    expect(pause.mappedFrom.some(m => m.predicate === 'EMERGENCY_AUTHORITY' && m.role === undefined)).toBe(true);
    const admin = CORE_TYPES['ADMIN'].mappedFrom;
    expect(admin.some(m => m.predicate === 'RESERVE_PROPOSER' && m.role === 'reserve-proposer')).toBe(true);
    expect(admin.some(m => m.predicate === 'GLOBAL_ADMIN' && m.role === 'global-admin')).toBe(true);
  });

  test('T8.4 the neighbouring kamino layout this adapter imports, and the kVault fixtures, are byte-pinned', () => {
    const pins = JSON.parse(readFileSync(join(CONSTRUCTED_ROOT, 'file-pins.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
    expect(pins.files.length).toBeGreaterThan(0);
    for (const p of pins.files) {
      const bytes = readFileSync(resolve(repoRoot, p.path));
      expect([p.path, sha256(new Uint8Array(bytes))]).toEqual([p.path, p.sha256]);
    }
  });
});


describe('review 043 follow-ups', () => {
  test('O1 unset emergency authority is none without an unknown controller', () => {
    const dir = withCapture('unset-emergency-authority', raw => {
      const rec = raw.records['rpc-state.json'];
      const i = rec.params[0].indexOf(MARKET.replace(CHAIN, ''));
      const bytes = bytesOf(rec.response.value[i]);
      bytes.fill(0, 160, 192);
      rec.response.value[i].data = [bytes.toString('base64'), 'base64'];
    });
    const result = load(dir);
    const fact = result.snapshot.facts.find(f => f.subject === MARKET && f.predicate === 'EMERGENCY_AUTHORITY');
    expect([fact?.object, fact?.basis, fact?.status]).toEqual(['none', 'decoded', 'verified']);
    expect(result.gaps.some(g => g.code === 'unknown-controller' && g.subject === NULL_KEY)).toBe(false);
    expect(result.snapshot.facts.some(f => f.subject === NULL_KEY && f.predicate === 'CONTROLLED_BY')).toBe(false);
  });

  test('O2 truncated response values are a malformed capture', () => {
    const dir = withCapture('truncated-response-values', raw => {
      raw.records['rpc-state.json'].response.value.pop();
    });
    expect(rejectedCode(dir)).toEqual({ thrown: true, code: 'malformed-capture' });
  });

  test('O3 exported names never collide with different Kamino values', () => {
    const probe = spawnSync('bun', ['-e', `
      import * as lend from './src/adapters/kamino-lend';
      import * as vault from './src/adapters/kamino';
      const conflicts = Object.keys(lend).filter(k => k in vault && lend[k] !== vault[k]);
      console.log(JSON.stringify(conflicts));
      process.exit(conflicts.length ? 1 : 0);
    `], { cwd: repoRoot, encoding: 'utf8' });
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe('[]');
  });
});
