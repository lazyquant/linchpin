// Independent tests for the Kamino Lend reserve-status contract, as amended by the
// recorded decisions (Q2: a status code above 2 drops only the status fact).
// Every expected value comes from the contract, the recorded decisions or the committed
// capture's own records — never from what the implementation prints.
// The whole file runs offline: fetch, WebSocket, Bun.connect, node:net and node:http(s)
// are trapped and any call fails.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { canonical, sha256 } from '../src/chain/evidence';
import { openStore, runQuery, validateSnapshot, VOCABULARY } from '../src/engine/queries';
import { CORE_TYPES, checkVocabulary, NOT_PROJECTED, generateSchema } from '../src/graph/evidence/schema';
import { TERMS, registryProblems } from '../src/graph/vocabulary/terms';
import { lint, defaultLintInput } from '../src/graph/vocabulary/lint';
import { collectSlice1Inputs, collectEvidenceInputs } from '../src/graph/evidence/protocols';
import { buildEvidenceRecords, recordsSha256 } from '../src/graph/evidence/build';
import {
  buildKaminoLendSnapshots, loadKaminoLendCapture, normalizeKaminoLendCapture,
} from '../src/adapters/kamino-lend';

// ---- repository-relative paths (resolved here, never absolute) ----
const ROOT = join(import.meta.dir, '..');
const RECORDED_ROOT = resolve(ROOT, 'fixtures/kamino-lend');
const CAPTURE_ID = 'main-market-20261111T195059Z';
const MARKET_FIXTURES = resolve(ROOT, 'tests/fixtures/kamino-lend-market');
const FIX = join(import.meta.dir, 'fixtures', 'kamino-lend-vocabulary');

// Some checks read inputs that only a git checkout carries (earlier commits). Without
// git history those checks are skipped rather than failed; in the repository they always run.
const BASE_REF = '8cfa7059';
const DEV_HISTORY = (() => {
  try {
    return Bun.spawnSync(['git', 'cat-file', '-e', `${BASE_REF}^{commit}`], {
      cwd: ROOT, stdout: 'ignore', stderr: 'ignore',
    }).exitCode === 0;
  } catch { return false; }
})();

// ---- identities, from the contract and the recorded capture ----
const CHAIN = 'solana:mainnet-beta:';
const MARKET = CHAIN + '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const PYUSD_RESERVE = CHAIN + '2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN';
const XSTEP_RESERVE = CHAIN + 'Ggn9EUzL5QQPM8JPsyu1MU1uD3rGJty7iXddLQnmxPyS';
const PREDICATE = 'KLEND_RESERVE_STATUS';
const STATUS_OFFSET = 4856;

// Coverage-note wording from the contract (the kept ids keep a detail that is still true;
// the three deferred areas keep their recorded details).
const STATUS_NOTE_DETAIL = 'The status code is decoded as KLEND_RESERVE_STATUS; what Active, Obsolete and Hidden permit is not, so IN_MARKET and PRICED_BY do not establish that the reserve is usable.';
const KEPT_NOTE_DETAILS: Record<string, string> = {
  'scope-chain-indices': 'Scope chain indices and their resolved entries are not covered.',
  'multisig-timelock': 'Multisig time locks are not covered.',
  'pending-owner-admin': 'Pending owner and admin are not covered.',
};

// ---- offline trap for the whole file ----
const hits: Record<string, number> = { fetch: 0, websocket: 0, connect: 0, net: 0, http: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
const restores: Array<() => void> = [];
beforeAll(() => {
  process.chdir(ROOT);
  for (const [obj, key, bucket] of [
    [globalThis, 'fetch', 'fetch'], [globalThis, 'WebSocket', 'websocket'], [Bun, 'connect', 'connect'],
    [net, 'connect', 'net'], [net, 'createConnection', 'net'],
    [http, 'request', 'http'], [http, 'get', 'http'], [https, 'request', 'http'], [https, 'get', 'http'],
  ] as const) {
    const o = obj as any, old = o[key];
    o[key] = function (...args: unknown[]) { hits[bucket]++; throw trapError(String(key)); };
    restores.push(() => { o[key] = old; });
  }
}, 60000);
afterAll(() => { for (const restore of restores) restore(); });
afterEach(() => {
  for (const [kind, n] of Object.entries(hits)) expect([kind, n]).toEqual([kind, 0]);
  for (const k of Object.keys(hits)) hits[k] = 0;
});

// ---- scratch captures for the constructed cases (never under fixtures/kamino-lend) ----
const scratch = mkdtempSync(realpathSync(tmpdir()) + '/kamino-lend-status-tests-');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---- helpers: nothing here trusts the implementation ----
const bytesOf = (v: any) => Buffer.from(Array.isArray(v.data) ? v.data[0] : v.data, 'base64');
type RawCapture = { manifest: any; records: Record<string, any> };
function readRecordedRaw(): RawCapture {
  const dir = join(RECORDED_ROOT, CAPTURE_ID);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const records: Record<string, any> = {};
  for (const f of manifest.records) records[f] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return { manifest, records };
}
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
/** Set one byte of one account inside one RPC record of a raw capture. */
function patchByte(raw: RawCapture, file: string, key: string, offset: number, value: number) {
  const rec = raw.records[file];
  const i = rec.params[0].indexOf(key.replace(CHAIN, ''));
  if (i < 0) throw new Error(`key ${key} not in ${file}`);
  const buf = bytesOf(rec.response.value[i]);
  buf[offset] = value;
  const v = rec.response.value[i];
  v.data = [buf.toString('base64'), Array.isArray(v.data) ? v.data[1] : 'base64'];
}
const load = (dir: string) => normalizeKaminoLendCapture(loadKaminoLendCapture(dir));
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Facts with receipt-derived fields removed, so captures that differ only in capture id compare equal. */
const bareFacts = (facts: any[]) =>
  facts.map(({ id: _id, evidenceIds: _e, ...rest }) => rest).sort((a, b) => canonical(a) < canonical(b) ? -1 : 1);
const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const readPin = (p: string) => readFileSync(p, 'utf8').trim();

// ---- recorded build and its status byte, decoded independently from the capture ----
let recorded: ReturnType<typeof load>;
let recordedSnapshot: ReturnType<typeof validateSnapshot>;
let recordedRaw: RawCapture;
let statusBytes: Map<string, number>;
beforeAll(() => {
  recorded = load(join(RECORDED_ROOT, CAPTURE_ID));
  recordedSnapshot = validateSnapshot(recorded.snapshot);
  recordedRaw = readRecordedRaw();
  const state = recordedRaw.records['rpc-state.json'];
  statusBytes = new Map();
  for (const [i, key] of (state.params[0] as string[]).entries()) {
    statusBytes.set(CHAIN + key, bytesOf(state.response.value[i])[STATUS_OFFSET]);
  }
}, 60000);

const statusFacts = (snap: ReturnType<typeof validateSnapshot>) => snap.facts.filter(f => f.predicate === PREDICATE);
const factsWith = (pred: string, snap = recordedSnapshot) => snap.facts.filter(f => f.predicate === pred);
const scopeOf = (snap: ReturnType<typeof validateSnapshot>) =>
  ({ snapshotId: snap.id, asOf: snap.observedTo, maxHops: 2, maxResults: 500 });

// Memoised heavy builds (each is used by more than one assertion below).
let fullHashCache: string | undefined;
const fullSetHash = () => fullHashCache ??= recordsSha256(buildEvidenceRecords(collectEvidenceInputs('.')));
let lintIdsCache: string[] | undefined;
function lintIds(): string[] {
  if (lintIdsCache) return lintIdsCache;
  const inputs = collectSlice1Inputs(ROOT);
  const snapshots = inputs
    .filter(i => i.snapshot.constructed === false)
    .map(i => ({
      id: i.snapshot.id,
      facts: i.snapshot.facts.map(f => ({ id: f.id, predicate: f.predicate, object: f.object, privacy: f.privacy })),
    }));
  lintIdsCache = lint(defaultLintInput(snapshots)).map(f => f.id);
  return lintIdsCache;
}

// ============================================================ AC1
describe('AC1 decoded from the recorded bytes, no new read', () => {
  test.skipIf(!DEV_HISTORY)('T1.1 the committed capture is unchanged since the base commit', () => {
    const diff = Bun.spawnSync(['git', 'diff', BASE_REF, '--', 'fixtures/kamino-lend'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout.toString()).toBe('');
  });

  test('T1.2 the recorded snapshot still has 140 receipts and validates', () => {
    expect(recordedSnapshot.receipts.length).toBe(140);
    expect(validateSnapshot(recorded.snapshot)).toBeDefined();
  });

  test('T3.0 (shared) every status fact cites exactly its reserve receipt, decoded, verified, public, validFrom null', () => {
    expect(statusFacts(recordedSnapshot).length).toBe(58);
    for (const f of statusFacts(recordedSnapshot)) {
      const b58 = f.subject.slice(CHAIN.length);
      const receipt = recordedSnapshot.receipts.find(r =>
        r.source === `fixture:kamino-lend/${CAPTURE_ID}/rpc-state.json#${b58}`);
      expect([f.subject, receipt?.source]).toEqual([f.subject, `fixture:kamino-lend/${CAPTURE_ID}/rpc-state.json#${b58}`]);
      expect([f.subject, f.basis, f.status, f.privacy]).toEqual([f.subject, 'decoded', 'verified', 'public']);
      expect([f.subject, f.validFrom]).toEqual([f.subject, null]);
      expect([f.subject, /^amount:[0-2]$/.test(f.object)]).toEqual([f.subject, true]);
      expect([f.subject, f.evidenceIds]).toEqual([f.subject, [receipt!.id]]);
    }
  });
});

// ============================================================ AC2
describe('AC2 the 58 reserves', () => {
  test('T2.1 exactly 58 status facts, one per IN_MARKET subject, each object the stored byte at offset 4856', () => {
    const facts = statusFacts(recordedSnapshot);
    expect(facts.length).toBe(58);
    const inMarketSubjects = new Set(factsWith('IN_MARKET').map(f => f.subject));
    expect(new Set(facts.map(f => f.subject))).toEqual(inMarketSubjects);
    const tally: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    for (const f of facts) {
      const byte = statusBytes.get(f.subject);
      expect(byte).toBeDefined();
      expect([f.subject, f.object]).toEqual([f.subject, `amount:${byte}`]);
      tally[byte!]! += 1;
    }
    expect(tally).toEqual({ 0: 47, 1: 7, 2: 4 });
    const pyusd = facts.find(f => f.subject === PYUSD_RESERVE);
    const xstep = facts.find(f => f.subject === XSTEP_RESERVE);
    expect(pyusd?.object).toBe('amount:0');
    expect(xstep?.object).toBe('amount:1');
  });

  test('T2.2 every fact the base snapshot carried is still present, byte-identical; only the 58 status facts were added', () => {
    const basePin = readPin(join(FIX, 'base-facts.sha256'));
    const kept = recordedSnapshot.facts.filter(f => f.predicate !== PREDICATE);
    expect(sha256(canonical([...kept].sort(byId)))).toBe(basePin);
    expect(kept.length + statusFacts(recordedSnapshot).length).toBe(recordedSnapshot.facts.length);
  });
});

// ============================================================ AC3
describe('AC3 failure and malformed input', () => {
  test('T3.1 a status code of 3 drops only that status fact, keeps the reserve (Q2)', () => {
    const dir = withCapture('status-code-3', raw => patchByte(raw, 'rpc-state.json', PYUSD_RESERVE, STATUS_OFFSET, 3));
    const result = load(dir);
    const snap = validateSnapshot(result.snapshot);
    expect(result.gaps.some(g => g.code === 'malformed-record' && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(statusFacts(snap).some(f => f.subject === PYUSD_RESERVE)).toBe(false);
    expect(statusFacts(snap).length).toBe(57);
    expect(factsWith('IN_MARKET', snap).some(f => f.subject === PYUSD_RESERVE)).toBe(true);
    expect(canonical(bareFacts(statusFacts(snap)))).toBe(
      canonical(bareFacts(statusFacts(recordedSnapshot).filter(f => f.subject !== PYUSD_RESERVE))),
    );
  });

  test('T3.2 a status code of 255 behaves the same (no wrap-around)', () => {
    const dir = withCapture('status-code-255', raw => patchByte(raw, 'rpc-state.json', PYUSD_RESERVE, STATUS_OFFSET, 255));
    const result = load(dir);
    const snap = validateSnapshot(result.snapshot);
    expect(result.gaps.some(g => g.code === 'malformed-record' && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(statusFacts(snap).some(f => f.subject === PYUSD_RESERVE)).toBe(false);
    expect(statusFacts(snap).length).toBe(57);
  });

  test('T3.3 a null reserve account is a missing-account gap with no fact at all for that reserve', () => {
    const dir = withCapture('null-reserve-account', raw => {
      const rec = raw.records['rpc-state.json'];
      const i = rec.params[0].indexOf(PYUSD_RESERVE.replace(CHAIN, ''));
      rec.response.value[i] = null;
    });
    const result = load(dir);
    const snap = validateSnapshot(result.snapshot);
    expect(result.gaps.some(g => g.code === 'missing-account' && g.subject === PYUSD_RESERVE)).toBe(true);
    expect(snap.facts.some(f => f.subject === PYUSD_RESERVE)).toBe(false);
    expect(statusFacts(snap).length).toBe(57);
  });
});

// ============================================================ AC4
describe('AC4 changes between snapshots', () => {
  test('T4.1 a status byte 0 -> 1 is exactly one changed KLEND_RESERVE_STATUS with receipts on both sides', () => {
    const dirA = withCapture('constructed-status-base', () => {});
    const dirB = withCapture('constructed-status-bumped', raw =>
      patchByte(raw, 'rpc-state.json', PYUSD_RESERVE, STATUS_OFFSET, 1));
    for (const dir of [dirA, dirB]) {
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      m.constructed = true;
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    }
    const a = validateSnapshot(load(dirA).snapshot);
    const b = validateSnapshot(load(dirB).snapshot);
    expect(a.constructed).toBe(true);
    const store = openStore([a, b]);
    const result = runQuery(store, {
      name: 'changes', subject: PYUSD_RESERVE,
      beforeSnapshotId: a.id, afterSnapshotId: b.id, maxResults: 500,
    });
    expect(result.changes.length).toBe(1);
    const change = result.changes[0]!;
    expect([change.kind, change.before!.predicate, change.after!.predicate])
      .toEqual(['changed', PREDICATE, PREDICATE]);
    expect([change.before!.object, change.after!.object]).toEqual(['amount:0', 'amount:1']);
    expect(change.before!.evidenceIds.length).toBeGreaterThan(0);
    expect(change.after!.evidenceIds.length).toBeGreaterThan(0);
    expect(result.observations.length).toBeGreaterThan(0);
    for (const o of result.observations) expect(o.constructed).toBe(true);
  });

  test('T4.2 negative: a pair differing only in capture id (receipts and fact ids) returns no change', () => {
    const dirA = withCapture('constructed-twin-a', raw => { raw.manifest.constructed = true; });
    const dirB = withCapture('constructed-twin-b', raw => { raw.manifest.constructed = true; });
    const a = validateSnapshot(load(dirA).snapshot);
    const b = validateSnapshot(load(dirB).snapshot);
    expect(a.id).not.toBe(b.id);
    const store = openStore([a, b]);
    const result = runQuery(store, {
      name: 'changes', subject: PYUSD_RESERVE,
      beforeSnapshotId: a.id, afterSnapshotId: b.id, maxResults: 500,
    });
    expect(result.changes).toEqual([]);
  });
});

// ============================================================ AC5
describe('AC5 control and dependency answers unchanged', () => {
  const storeWith = (facts: any[]) => openStore([{ ...recordedSnapshot, facts }]);
  const storeFull = () => storeWith(recordedSnapshot.facts);
  const storeBase = () => storeWith(recordedSnapshot.facts.filter(f => f.predicate !== PREDICATE));

  test('T5.1 control on the market is byte-identical with and without the status facts', () => {
    const withStatus = runQuery(storeFull(), { name: 'control', subject: MARKET, scope: scopeOf(recordedSnapshot) });
    const withoutStatus = runQuery(storeBase(), { name: 'control', subject: MARKET, scope: scopeOf(recordedSnapshot) });
    expect(new Set(withStatus.facts.map(f => f.predicate))).toEqual(
      new Set(['MARKET_OWNER', 'EMERGENCY_AUTHORITY', 'RESERVE_PROPOSER']));
    expect(canonical(withStatus.facts)).toBe(canonical(withoutStatus.facts));
    for (const o of withStatus.observations) expect(o.constructed).toBe(false);
  });

  test('T5.2 the PYUSD dependencies answer is unchanged; a state fact is never traversed', () => {
    const relations = ['IN_MARKET', 'ASSET_MINT', 'PRICED_BY'];
    const withStatus = runQuery(storeFull(), { name: 'dependencies', subject: PYUSD_RESERVE, relations, scope: scopeOf(recordedSnapshot) });
    const withoutStatus = runQuery(storeBase(), { name: 'dependencies', subject: PYUSD_RESERVE, relations, scope: scopeOf(recordedSnapshot) });
    expect(canonical(withStatus.facts)).toBe(canonical(withoutStatus.facts));
    expect(withStatus.outcome).toBe(withoutStatus.outcome);
    expect(withStatus.facts.some(f => f.predicate === PREDICATE)).toBe(false);
    for (const o of withStatus.observations) expect(o.constructed).toBe(false);
  });

  test('T5.3 negative: no deferred-area fact (pending owner, time lock, chain index) is emitted', () => {
    for (const f of recordedSnapshot.facts) {
      expect([f.predicate, /pending-owner|timelock-delay|chain-index|CHAIN/.test(f.predicate)])
        .toEqual([f.predicate, false]);
    }
  });
});

// ============================================================ AC6
describe('AC6 vocabulary, schema and registry', () => {
  test('T6.1 the vocabulary keeps every earlier entry and adds exactly the one status entry', () => {
    const baseline = readJson(join(MARKET_FIXTURES, 'vocabulary-baseline.json')) as Record<string, unknown>;
    const before = readJson(join(FIX, 'vocabulary-before.json')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(baseline)) {
      expect([key, JSON.stringify(VOCABULARY[key as keyof typeof VOCABULARY])]).toEqual([key, JSON.stringify(value)]);
    }
    for (const [key, value] of Object.entries(before)) {
      expect([key, JSON.stringify(VOCABULARY[key as keyof typeof VOCABULARY])]).toEqual([key, JSON.stringify(value)]);
    }
    expect(Object.keys(VOCABULARY).filter(k => !(k in before))).toEqual([PREDICATE]);
    expect(JSON.stringify(VOCABULARY[PREDICATE as keyof typeof VOCABULARY])).toBe(
      JSON.stringify({ class: 'state', direction: 'subject-to-object', cardinality: 'one' }));
  });

  test('T6.2 core types and the schema file are the contract\'s', () => {
    expect(CORE_TYPES).toEqual(readJson(join(FIX, 'core-types-before.json')));
    expect(() => checkVocabulary()).not.toThrow();
    expect(NOT_PROJECTED.filter(p => p === PREDICATE).length).toBe(1);
    expect(readFileSync(join(ROOT, 'src/graph/evidence/schema.json'), 'utf8'))
      .toBe(JSON.stringify(generateSchema(), null, 2) + '\n');
  });

  test('T6.3 the registry holds the term; no registry problem; the definition says what the contract says', () => {
    expect(Object.values(registryProblems(TERMS)).map(l => (l as unknown[]).length)).toEqual([0, 0, 0]);
    const term = TERMS.find(t => t.type === 'predicate' && t.name === PREDICATE);
    expect(term).toBeDefined();
    for (const word of ['Active', 'Obsolete', 'Hidden', '6a26d6f1']) {
      expect([word, term!.definition.includes(word)]).toEqual([word, true]);
    }
  });

  test('T6.4 the lint findings are the recorded ones plus exactly the one notice; no case or wording rule fires on it', () => {
    const pinned = readJson(join(ROOT, 'tests/fixtures/vocabulary-gate-v2/findings.json')) as string[];
    expect([...pinned].sort()).toEqual(pinned);
    const before = readJson(join(FIX, 'findings-before.json')) as string[];
    expect(pinned.filter(id => !before.includes(id))).toEqual([`VL8:${PREDICATE}`]);
    expect(before.filter(id => !pinned.includes(id))).toEqual([]);
    const got = lintIds();
    expect(got).toEqual(pinned);
    for (const rule of ['VL3', 'VL4', 'VL7']) {
      expect(got.some(id => id.startsWith(`${rule}:`) && id.includes(PREDICATE))).toBe(false);
    }
  });
});

// ============================================================ AC7
describe('AC7 analyst output, gaps visible', () => {
  const FORBIDDEN = /\b(exploit|unsafe|safe|rating|should|recommend|buy|sell)\b|\brisk\s+score\b/i;
  const strings = () => {
    const out: string[] = [];
    for (const g of recorded.gaps) out.push(g.code, g.detail);
    for (const c of recorded.coverage) out.push(c.id, c.detail);
    for (const [k, v] of Object.entries(recordedSnapshot.names)) out.push(k, v);
    for (const f of recordedSnapshot.facts) out.push(f.predicate, f.object);
    return out;
  };

  test('T7.1 no advice or verdict word anywhere in gaps, coverage, names, predicates or fact objects', () => {
    for (const s of strings()) expect([s.slice(0, 60), FORBIDDEN.test(s)]).toEqual([s.slice(0, 60), false]);
  });

  test('T7.2 a status is a code, never the word for it', () => {
    for (const f of statusFacts(recordedSnapshot)) {
      expect(['Active', 'Obsolete', 'Hidden'].includes(f.object)).toBe(false);
      expect(/^amount:[0-2]$/.test(f.object)).toBe(true);
    }
    for (const f of recordedSnapshot.facts) {
      expect([f.predicate, /pending-owner|timelock-delay|chain-index|CHAIN/.test(f.predicate)])
        .toEqual([f.predicate, false]);
    }
  });

  test('T7.3 the kept coverage notes keep their ids and say only what is still not covered', () => {
    const notes = recorded.coverage;
    expect(notes.every(c => c.code === 'missing-coverage')).toBe(true);
    const status = notes.filter(c => c.id === 'reserve-status');
    expect(status.length).toBe(1);
    expect(status[0]!.detail).toBe(STATUS_NOTE_DETAIL);
    const perReserve = notes.filter(c => c.id === 'reserve-status-not-decoded');
    expect(perReserve.length).toBe(58);
    const reserves = new Set(factsWith('IN_MARKET').map(f => f.subject));
    for (const reserve of reserves) {
      const note = perReserve.find(n => n.subject === reserve);
      expect(note).toBeDefined();
      expect(note!.detail).toBe(STATUS_NOTE_DETAIL);
    }
    for (const [id, detail] of Object.entries(KEPT_NOTE_DETAILS)) {
      const note = notes.filter(c => c.id === id);
      expect(note.length).toBe(1);
      expect(note[0]!.detail).toBe(detail);
    }
    expect((recordedSnapshot as unknown as Record<string, unknown>).coverage).toBeUndefined();
  });
});

// ============================================================ AC8
describe('AC8 replay, isolation, compatibility', () => {
  test('T8.1 two builds are byte-identical and equal the pinned snapshot hash', () => {
    const a = canonical(buildKaminoLendSnapshots()[0]);
    const b = canonical(buildKaminoLendSnapshots(RECORDED_ROOT)[0]);
    expect(a).toBe(b);
    expect(sha256(b)).toBe(readPin(join(MARKET_FIXTURES, 'snapshot.sha256')));
  }, 60000);

  test('T8.2 the full-set hash equals both pinned records hashes; the slice-1 pin is unchanged', () => {
    const full = fullSetHash();
    expect(full).toBe(readPin(join(ROOT, 'tests/fixtures/kamino-evidence-graph/records.sha256')));
    expect(full).toBe(readPin(join(ROOT, 'tests/fixtures/kamino-lend-kinds/records.sha256')));
    expect(recordsSha256(buildEvidenceRecords(collectSlice1Inputs('.'))))
      .toBe(readPin(join(ROOT, 'tests/fixtures/evidence-graph-model/records.sha256')));
  }, 60000);

  test('T8.3 the trap is live: a direct fetch throws offline', () => {
    expect(() => globalThis.fetch('https://invalid.example/probe')).toThrow();
    hits.fetch = 0; // this one call was intentional; afterEach still covers every accidental call
  });

  test.skipIf(!DEV_HISTORY)('T8.4 the protected neighbours of this change are untouched since the base commit', () => {
    const diff = Bun.spawnSync(['git', 'diff', BASE_REF, '--',
      'src/adapters/kamino', 'fixtures/kamino', 'fixtures/kamino-lend', 'fixtures/kamino-vaults', 'src/engine/queries/request.ts', 'src/engine/queries/snapshot.ts',
      'src/graph/evidence/protocols.ts', 'src/graph/evidence/build.ts'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout.toString()).toBe('');
  }, 60000);
});
