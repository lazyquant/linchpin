import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as netNamespace from 'node:net';
import netDefault from 'node:net';
import { canonical, sha256 } from '../src/chain/evidence';
import { CANNED_QUERIES, type Neo4jDriverLike } from '../src/graph/neo4j';
import {
  assertTokenomicsNamespace,
  buildTokenomicsGraph,
  loadTokenomicsNeo4j,
  tokenomicsCypherBatches,
  tokenomicsQueries,
  runTokenomicsLocal,
  TOKENOMICS_QUERIES,
  TG_LABELS,
  tokenomicsSubgraph,
  type TokenomicsGraph,
} from '../src/graph/tokenomics-neo4j';
import { TokenomicsGraphService } from '../src/tokenomics/graph-service';
import { buildKaminoTokenomics, KaminoProjectionError, latestKaminoCapture, projectKamino, type KaminoBuild } from '../src/tokenomics/kamino';
import { buildTokenomics, type TokenomicsBuild } from '../src/tokenomics/build';
import { evidenceIds } from '../src/tokenomics/evidence';
import type { ProtocolsResponse, SectionEnvelope, SectionId } from '../src/tokenomics/api';
import { loadCapture } from '../src/adapters/kamino';
import { api, ResearchService } from '../src/web/server';
import { runPipeline, ROOT } from '../src/web/runner';
import { SECTIONS } from '../src/web/tokenomics-routes';
import { answerQuestion } from '../src/web/tokenomics-questions';
import { renderSection, renderTokenomicsHeader, renderTokenomicsNavigation, renderTokenomicsPrompts, tokenomicsUrl } from '../src/web/tokenomics-view';
import { selectTokenomicsPicture } from '../src/web/tokenomics-graph-picture';
import { TokenomicsWorkspace } from '../src/web/tokenomics-ui';
import baseValues from './fixtures/tokenomics-multi-protocol/base-values.json';

// Pins: the base-value table of plan 032 (measured at the run's base commit) and the
// approved spec's own section table. No string below names a private workflow file.
const V = baseValues as any;
const KAMINO_CAPTURE = 'sentora-pyusd-20261109T170418Z';
const KAMINO_SLOT = 467394687;
const VAULT = 'A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK';
const ORACLE_PROGRAM = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';
const KAMINO_QUERY_IDS = ['who-can-change', 'upgrade-control', 'claims-vs-chain', 'vault-dependencies'];
const OMITTED_QUERY_IDS = ['path-to-holders', 'parameter-control', 'supply-control', 'who-votes-where', 'holders-and-float'];
const COVERAGE =
  "Mapped from the recorded capture: who controls the vault, its lending markets and its programs (all four controlling accounts are of unresolved type); which reserves the vault allocates to, which market each reserve is in and which oracle prices it; the vault's fee and withdrawal parameters and each reserve's protocol take rate; and one documentation claim checked against the chain. Not mapped: where fees go, the treasury, KMNO supply and mint control, governance, holders and transaction flows.";
const ANSWER_TAIL =
  'Ask a question, or open Control, Programs, Parameters, Claims or Graph; answers cite the mapped facts. Mechanics that are not mapped are reported as not mapped, not as absent.';
const PENDING_NOTES: Partial<Record<SectionId, string>> = {
  path: 'Not mapped in this capture: where fees and value route. No fee-destination, treasury or distribution account was captured. Vault-to-reserve allocation is a dependency, not a value route, and is in Graph.',
  offsets: 'Not mapped in this capture: treasury, emissions and outflows.',
  participation: 'Not mapped in this capture: KMNO locking, staking and voting.',
  holders: "Not mapped in this capture: KMNO and kVault-share holders. The shares mint's supply is a supply, not a holder list.",
  flows: 'Not mapped in this capture: transactions. No transaction window was captured.',
};
const PENDING_SECTIONS: SectionId[] = ['answer', 'path', 'offsets', 'participation', 'holders', 'flows'];
const READY_SECTIONS: SectionId[] = ['control', 'programs', 'parameters', 'claims', 'graph'];
const CAPTURE_NOTE = `Projected from Kamino capture ${KAMINO_CAPTURE}, state slot ${KAMINO_SLOT}.`;
const NINE_QUESTIONS = [
  "Who can change the vault's allocations?",
  'Who can upgrade the lending program?',
  'What fees does the vault charge?',
  'What does the vault depend on?',
  "Does the documentation's buffer claim match the chain?",
  "Where do the vault's fees go?",
  'Who holds KMNO?',
  'What does the treasury hold?',
  'How is KMNO governed?',
];
const MARINADE_QUESTIONS = [
  ...NINE_QUESTIONS,
  'Who controls the reward fee?',
  'Who can change the fees?',
  'Can more MNDE be minted?',
  'Predict Bitcoin closing price tomorrow',
  'What buybacks flowed?',
  'Is the value path to MNDE holders enforced?',
  'Show external outflows',
  'Show graph program dependencies',
];
const T9_TERMS = ['safe', 'unsafe', 'risk score', 'rating', 'should', 'recommend', 'buy', 'sell', 'exploit'];
const NOT_MAPPED_ANSWER_TERMS = ['none', 'no fee', 'zero', '0 kmno', 'no holders'];

const statePath = join(ROOT, ['graph', 'artifacts'].join('/'), '032-tokenomics-multi-protocol', 'state.json');
const hasGitBase = existsSync(statePath);
const baseCommit: string | undefined = hasGitBase ? JSON.parse(readFileSync(statePath, 'utf8')).base_commit : undefined;

const sha = (text: string) => sha256(text);
const json = (value: unknown) => JSON.stringify(value);
const strip = (identity: string) => identity.replace(/^solana:mainnet-beta:/, '');
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---- network trap for the whole file (approved spec AC4) ----
const hits = { fetch: 0, websocket: 0, connect: 0, net: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
let restores: (() => void)[] = [];
const NEO4J_KEYS = ['NEO4J_URI', 'NEO4J_PASSWORD', 'NEO4J_USERNAME', 'NEO4J_DATABASE'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of NEO4J_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((): Response => { hits.fetch++; throw trapError('fetch'); }) as any);
  restores.push(() => fetchSpy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class { constructor() { hits.websocket++; throw trapError('WebSocket'); } };
  restores.push(() => { (globalThis as any).WebSocket = realWebSocket; });
  const realConnect = (Bun as any).connect;
  (Bun as any).connect = (): never => { hits.connect++; throw trapError('Bun.connect'); };
  restores.push(() => { (Bun as any).connect = realConnect; });
  for (const mod of [netNamespace as any, netDefault as any]) {
    for (const name of ['connect', 'createConnection']) {
      if (typeof mod[name] !== 'function') continue;
      try {
        const spy = spyOn(mod, name).mockImplementation(((): never => { hits.net++; throw trapError('node:net'); }) as any);
        restores.push(() => spy.mockRestore());
      } catch {
        const real = mod[name];
        mod[name] = (): never => { hits.net++; throw trapError('node:net'); };
        restores.push(() => { mod[name] = real; });
      }
    }
  }

  captured = await runPipeline('marinade');
  built = await buildTokenomics({ root: ROOT, packResult: captured });
  kamino = buildKaminoTokenomics({ root: ROOT });
  latest = latestKaminoCapture(ROOT);
  service.tokenomics = built;
  service.setTokenomicsBuild('kamino', kamino);
}, 300_000);

afterAll(() => {
  for (const restore of restores) restore();
  restores = [];
  for (const key of NEO4J_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterEach(() => {
  for (const value of Object.values(hits)) expect(value).toBe(0);
});

// ---- shared state ----
let captured: Awaited<ReturnType<typeof runPipeline>>;
let built: TokenomicsBuild;
let kamino: KaminoBuild;
let latest: ReturnType<typeof latestKaminoCapture>;
const service = new ResearchService(undefined, undefined, { config: null });
const request = (path: string, init?: RequestInit) => new Request(`http://localhost:8875${path}`, init);
const handler = (path: string, init?: RequestInit) => api(service)(request(path, init));
const marinadeBase = '/api/tokenomics/marinade';
const kaminoBase = '/api/tokenomics/kamino';

const graphOf = (): TokenomicsGraph => kamino.graph;
const marinadeGraph = (): TokenomicsGraph => buildTokenomicsGraph(built.bundle);
const kaminoQueries = () => tokenomicsQueries('TGKamino', KAMINO_QUERY_IDS);

function collect(value: unknown, key: string): unknown[] {
  const out: unknown[] = [];
  const walk = (v: any, k: string | null): void => {
    if (Array.isArray(v)) { for (const item of v) walk(item, k); return; }
    if (v && typeof v === 'object') { for (const [name, child] of Object.entries(v)) walk(child, name); return; }
    if (k === key) out.push(v);
  };
  walk(value, null);
  return out;
}

// ---- stateful fake driver executing the statement shapes over an in-memory store ----
function makeFakeDriver() {
  type Side = { nodes: Map<string, any>; rels: any[] };
  const store = new Map<string, Side>();
  const side = (ns: string): Side => {
    let s = store.get(ns);
    if (!s) { s = { nodes: new Map(), rels: [] }; store.set(ns, s); }
    return s;
  };
  const calls: { cypher: string; params: any; routing: string | null }[] = [];
  let changed = false;
  const queriesOf = (ns: string) => (ns === 'TGKamino' ? kaminoQueries() : TOKENOMICS_QUERIES);
  const productGraph = (ns: string): TokenomicsGraph => (ns === 'TGKamino' ? graphOf() : marinadeGraph());
  const stored = (ns: string): TokenomicsGraph => {
    const s = side(ns);
    return { nodes: [...s.nodes.values()], relationships: s.rels };
  };
  const driver: Neo4jDriverLike = {
    async executeQuery(cypher: string, params: any, config: any) {
      calls.push({ cypher, params, routing: config?.routing ?? null });
      const constraint = cypher.match(/^CREATE CONSTRAINT ([A-Za-z0-9_]+) IF NOT EXISTS FOR \(n:([A-Za-z0-9_]+)\)/);
      if (constraint) { side(constraint[2]); return { records: [] }; }
      const wipe = cypher.match(/^MATCH \(n:([A-Za-z0-9_]+)\) DETACH DELETE n/);
      if (wipe) { const s = side(wipe[1]); s.nodes.clear(); s.rels = []; return { records: [] }; }
      if (/UNWIND \$rows/.test(cypher)) {
        const ns = cypher.match(/:\s*(TG[A-Za-z0-9_]*)/)?.[1] ?? 'TG';
        const s = side(ns);
        for (const row of params.rows) {
          if ('source' in row && 'target' in row) s.rels.push(row);
          else if ('labels' in row && 'props' in row) s.nodes.set(row.id, { id: row.id, labels: row.labels, props: row.props });
          else s.nodes.set(row.id ?? row.key, row);
        }
        return { records: [] };
      }
      const canned = CANNED_QUERIES.find(q => q.cypher === cypher);
      if (canned) {
        const row = Object.fromEntries(canned.columns.map(c => [c, ['inboundControlEdges', 'hops', 'proposals', 'nodes', 'relationships', 'evidence', 'slotMin', 'slotMax'].includes(c) ? 1 : 'recorded']));
        if (changed && canned.id === CANNED_QUERIES[0].id) row[canned.columns[0]] = 'changed';
        return { records: [{ toObject: () => row }] };
      }
      const ns = cypher.match(/:\s*(TG[A-Za-z0-9_]*)/)?.[1] ?? 'TG';
      const query = queriesOf(ns).find(q => q.cypher === cypher);
      if (query) return { records: runTokenomicsLocal(productGraph(ns), query.id, queriesOf(ns)).rows.map(row => ({ toObject: () => row })) };
      if (/RETURN n\.id AS id/.test(cypher)) {
        return { records: tokenomicsSubgraph(stored(ns)).nodes.map(row => ({ toObject: () => row })) };
      }
      if (/RETURN r\.key AS id/.test(cypher)) {
        return { records: tokenomicsSubgraph(stored(ns)).edges.map(row => ({ toObject: () => row })) };
      }
      return { records: [] };
    },
  };
  return { driver, calls, store, side, setChanged: (v: boolean) => { changed = v; } };
}

const NEO4J_CONFIG = { uri: 'neo4j+s://aura.example:7687', username: 'u', password: 'p', database: 'neo4j' };

function pair(driver: Neo4jDriverLike, lock: { holder: string | null }) {
  const marinade = new TokenomicsGraphService(built.bundle, { config: NEO4J_CONFIG, driverFactory: () => driver }, { lock });
  const kaminoService = new TokenomicsGraphService(kamino.bundle, { config: NEO4J_CONFIG, driverFactory: () => driver }, { graph: graphOf(), namespace: 'TGKamino', queries: kaminoQueries(), lock });
  return { marinade, kaminoService };
}

// ---- constructed in-memory variants from a deep copy of the recorded replay ----
function multisigVariant() {
  const v = structuredClone(latest) as any;
  const auth = 'solana:mainnet-beta:24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT';
  const entity = v.result.mechanics.entities.find((e: any) => e.id === auth);
  entity.controllerType = 'squads-v4-multisig';
  const index = v.result.snapshot.facts.findIndex((f: any) => f.predicate === 'CONTROLLED_BY' && f.subject === auth);
  const controlledBy = v.result.snapshot.facts[index];
  v.result.snapshot.facts.splice(index, 1);
  const make = (predicate: string, object: string) => ({
    id: 'e'.repeat(64), subject: auth, predicate, object, basis: 'decoded', status: 'verified',
    evidenceIds: controlledBy.evidenceIds, path: [], validFrom: null, validTo: null, privacy: 'public',
  });
  v.result.snapshot.facts.push(make('MULTISIG_THRESHOLD', 'amount:2'));
  for (const member of ['MultisigMember1111111111111111111111111111111', 'MultisigMember2222222222222222222222222222222', 'MultisigMember3333333333333333333333333333333'])
    v.result.snapshot.facts.push(make('MULTISIG_MEMBER', `solana:mainnet-beta:${member}`));
  const oracleUpgrade = v.result.snapshot.facts.find((f: any) => f.predicate === 'UPGRADE_AUTHORITY' && f.subject === `solana:mainnet-beta:${ORACLE_PROGRAM}`);
  oracleUpgrade.object = 'none';
  return v;
}

function simulatedVariant() {
  const v = structuredClone(latest) as any;
  v.result.snapshot.facts[0].basis = 'simulated';
  return v;
}

function renamedNamesVariant() {
  const v = structuredClone(latest) as any;
  for (const key of Object.keys(v.result.snapshot.names)) v.result.snapshot.names[key] = 'X';
  return v;
}

// ===========================================================================
describe('tokenomics multi-protocol (run 032)', () => {

  test('network traps are live (sanity of the trap itself)', () => {
    expect(() => fetch('http://localhost:1/trap')).toThrow('network is trapped');
    expect(hits.fetch).toBe(1);
    hits.fetch = 0;
    expect(() => new (globalThis as any).WebSocket('ws://localhost:1')).toThrow('network is trapped');
    hits.websocket = 0;
  });

  // ---------------------------------------------------------------- AC1
  describe('AC1 contract change, additive and bounded', () => {
    test('the protocol index entry type accepts a Kamino entry without a question', () => {
      const entry: ProtocolsResponse['protocols'][number] = { id: 'kamino', title: 'Kamino: Sentora PYUSD kVault', asOf: null, slotRange: null, sections: { answer: 'pending' } as any };
      expect(entry.id).toBe('kamino');
      const envelope: SectionEnvelope<unknown> = { protocol: 'kamino', section: 'answer', status: 'pending', title: 'Coverage', asOf: null, slotRange: null, evidenceCount: 0, assumptions: [], notes: [COVERAGE], data: null };
      expect(envelope.protocol).toBe('kamino');
    });

    test.skipIf(!hasGitBase)('the api contract diff is exactly the additive change the plan lists', async () => {
      const diff = await Bun.$`git diff ${baseCommit} -- src/tokenomics/api.ts`.nothrow().text();
      const changed = diff.split('\n').filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
      const added = changed.filter(l => l.startsWith('+')).map(l => l.slice(1).trim());
      const removed = changed.filter(l => l.startsWith('-')).map(l => l.slice(1).trim());
      expect(added.filter(l => l.startsWith('export type ProtocolId'))).toHaveLength(1);
      expect(added.filter(l => l.includes('question?') && l.includes('a headline view'))).toHaveLength(1);
      expect(removed.filter(l => l.includes('question: string'))).toHaveLength(1);
      expect(removed.filter(l => l.includes("'marinade'"))).toHaveLength(2);
      expect(added.filter(l => l.includes('ProtocolId') && !l.startsWith('export type ProtocolId'))).toHaveLength(2);
      expect(added.filter(l => l === '')).toHaveLength(1);
      for (const line of [...added, ...removed]) if (line !== '') expect(/ProtocolId|'marinade'|question/.test(line)).toBe(true);
      const untouched = await Bun.$`git diff --name-only ${baseCommit} -- src/adapters src/engine src/contracts src/pack packs fixtures`.nothrow().text();
      expect(untouched.trim()).toBe('');
    });
  });

  // ---------------------------------------------------------------- AC2
  describe('AC2 Marinade byte-identical to the base', () => {
    test('the Marinade bundle equals the pinned base hash', () => {
      expect(sha(json(built.bundle))).toBe(V.marinade.bundle);
    });

    test('a deliberately altered bundle copy changes the hash (helper sanity)', () => {
      const clone = structuredClone(built.bundle) as any;
      clone.answer.data.shortAnswer.text += ' altered';
      expect(sha(json(clone))).not.toBe(V.marinade.bundle);
      expect(sha(json(clone))).not.toBe(sha(json(built.bundle)));
    });

    test('protocols[0], the bundle route, all 11 sections and the export are byte-identical', async () => {
      const index = await (await handler('/api/tokenomics')).json();
      expect(sha(json(index.protocols[0]))).toBe(V.marinade.protocols0);
      expect(sha(await (await handler(marinadeBase)).text())).toBe(V.marinade.route);
      for (const section of SECTIONS)
        expect(sha(await (await handler(`${marinadeBase}/${section}`)).text())).toBe(V.marinade.sections[section]);
      const exporter = await handler(`${marinadeBase}/export/tokenomics.json`);
      expect(exporter.headers.get('Content-Disposition')).toBe(V.marinade.export.contentDisposition);
      expect(sha(await exporter.text())).toBe(V.marinade.export.body);
    });

    test('evidence lookups keep the base id set, body and unknown-id hashes', async () => {
      const ids = [...built.evidence.records.keys()].slice(0, 200);
      expect(sha(ids.join('\n'))).toBe(V.marinade.evidenceIdSet);
      const evidenceBody = sha(await (await handler(`${marinadeBase}/evidence?${ids.map(id => `id=${id}`).join('&')}`)).text());
      expect(evidenceBody).toBe(V.marinade.evidence200);
      const unknownBody = sha(await (await handler(`${marinadeBase}/evidence?id=${'0'.repeat(64)}`)).text());
      expect(unknownBody).toBe(V.marinade.evidenceUnknown);
    });

    test('the Marinade TG graph, its query list and the exported query array equal the base', () => {
      const graph = marinadeGraph();
      expect(graph.nodes).toHaveLength(V.marinade.graph.nodes);
      expect(graph.relationships).toHaveLength(V.marinade.graph.relationships);
      expect(sha(canonical(graph))).toBe(V.marinade.graph.canonical);
      const queries = built.bundle.graph.data!.queries.map(q => ({ id: q.id, title: q.title, question: q.question, cypher: q.cypher, params: q.params, columns: q.columns, rows: q.rows }));
      expect(sha(canonical(queries))).toBe(V.marinade.queryList);
      expect(sha(canonical(TOKENOMICS_QUERIES))).toBe(V.marinade.tokenomicsQueries);
    });

    test('a recorded Marinade Neo4j load replays the exact 37 base statements', async () => {
      const calls: any[] = [];
      const recorder: Neo4jDriverLike = { async executeQuery(cypher: any, params: any, config: any) { calls.push({ cypher, params, routing: config?.routing ?? null }); return { records: [] }; } };
      const loader = new TokenomicsGraphService(built.bundle, { config: NEO4J_CONFIG, driverFactory: () => recorder });
      await loader.load();
      expect(calls).toHaveLength(V.marinade.fakeLoad.statements);
      expect(sha(canonical(calls))).toBe(V.marinade.fakeLoad.canonical);
    });

    test('the 17 Marinade answers are byte-identical to the base', () => {
      expect(sha(json(MARINADE_QUESTIONS.map(q => answerQuestion(q, built.bundle))))).toBe(V.marinade.answers17);
    });

    test.skipIf(!hasGitBase)('the two existing tokenomics test files are untouched', async () => {
      const result = await Bun.$`git diff --quiet ${baseCommit} -- tests/tokenomics.test.ts tests/web-tokenomics-ui.test.ts`.nothrow();
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------- AC3
  describe('AC3 generic routes', () => {
    test('the protocol index lists marinade then kamino in registry order', async () => {
      const index = await (await handler('/api/tokenomics')).json();
      expect(index.protocols.map((p: any) => p.id)).toEqual(['marinade', 'kamino']);
      expect('question' in index.protocols[1]).toBe(false);
      expect(index.protocols[1].sections).toEqual(Object.fromEntries(SECTIONS.map(s => [s, kamino.bundle[s].status])));
      expect(index.protocols[1].title).toBe('Kamino: Sentora PYUSD kVault');
      expect(sha(json(index.protocols[0]))).toBe(V.marinade.protocols0);
    });

    test('the Kamino bundle, every section and the export are served', async () => {
      expect(await (await handler(kaminoBase)).json()).toEqual(kamino.bundle);
      for (const section of SECTIONS) expect(await (await handler(`${kaminoBase}/${section}`)).json()).toEqual(kamino.bundle[section]);
      const exporter = await handler(`${kaminoBase}/export/tokenomics.json`);
      expect(exporter.headers.get('Content-Disposition')).toBe('attachment; filename="linchpin-kamino-tokenomics.json"');
      expect(await exporter.json()).toEqual(kamino.bundle);
    });

    test('Kamino evidence keeps the id-count, non-hex and missing-id rules', async () => {
      const ids = [...kamino.evidence.records.keys()].slice(0, 200);
      const response = await handler(`${kaminoBase}/evidence?${ids.map(id => `id=${id}`).join('&')}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toHaveLength(ids.length);
      expect(body.missing).toEqual([]);
      const repeated = Array.from({ length: 201 }, (n, i) => `id=${ids[i % ids.length]}`).join('&');
      expect((await handler(`${kaminoBase}/evidence?${repeated}`)).status).toBe(400);
      expect((await handler(`${kaminoBase}/evidence?id=not-hex`)).status).toBe(400);
      expect(await (await handler(`${kaminoBase}/evidence?id=${'0'.repeat(64)}`)).json()).toEqual({ items: [], missing: ['0'.repeat(64)] });
    });

    test('unknown protocols, wrong case, prototype paths and nested paths return 404', async () => {
      for (const path of ['/api/tokenomics/loopscale', '/api/tokenomics/Kamino', '/api/tokenomics/__proto__', `${kaminoBase}/unknown`, `${kaminoBase}/answer/extra`])
        expect((await handler(path)).status).toBe(404);
    });

    test('cross-origin Kamino load is 403 and the unconfigured same-origin load is 409', async () => {
      expect((await handler(`${kaminoBase}/graph/load`, { method: 'POST', headers: { Origin: 'https://other.example' } })).status).toBe(403);
      const response = await handler(`${kaminoBase}/graph/load`, { method: 'POST', headers: { Origin: 'http://localhost:8875' } });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Neo4j is not configured' });
    });

    test('a failed Kamino build is omitted from the index with a plain message, and Kamino serves 503 while Marinade keeps working', async () => {
      const broken = new ResearchService(undefined, undefined, { config: null });
      broken.tokenomics = built;
      broken.setTokenomicsError('kamino', 'Kamino is unavailable because its build failed.');
      const brokenHandler = (path: string, init?: RequestInit) => api(broken)(request(path, init));
      const index = await (await brokenHandler('/api/tokenomics')).json();
      expect(index.protocols.map((p: any) => p.id)).toEqual(['marinade']);
      expect(typeof index.message).toBe('string');
      expect(index.message.length).toBeGreaterThan(0);
      expect(index.message).toContain('Kamino');
      expect(index.message).not.toContain('\n');
      expect(index.message).not.toContain('/');
      for (const path of [kaminoBase, ...SECTIONS.map(s => `${kaminoBase}/${s}`)]) expect((await brokenHandler(path)).status).toBe(503);
      expect(sha(await (await brokenHandler(marinadeBase)).text())).toBe(V.marinade.route);
    });
  });

  // ---------------------------------------------------------------- AC4
  describe('AC4 Kamino build offline and deterministic', () => {
    test('two builds give the same bundle, pinned by hash, with no live reads', () => {
      const again = buildKaminoTokenomics({ root: ROOT });
      expect(json(again.bundle)).toBe(json(kamino.bundle));
      expect(sha(json(kamino.bundle))).toBe(V.kamino.bundle);
      expect(kamino.reads).toEqual({ live: 0, replayed: V.kamino.reads.replayed, retries: 0 });
      expect(kamino.reads.replayed).toBeGreaterThan(0);
    });

    test('every evidence citation in the bundle resolves through the Kamino evidence route', async () => {
      const ids = [...new Set(evidenceIds(kamino.bundle))];
      expect(ids.length).toBeGreaterThan(0);
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        const body = await (await handler(`${kaminoBase}/evidence?${batch.map(id => `id=${id}`).join('&')}`)).json();
        expect(body.missing).toEqual([]);
      }
    });

    test('every record carries the projected shape and never the capture endpoint', () => {
      const receipts = new Map(latest.result.snapshot.receipts.map((r: any) => [r.id, r]));
      const records = [...kamino.evidence.records.values()];
      expect(records).toHaveLength(latest.result.snapshot.receipts.length);
      const endpoints = new Set<string>();
      for (const record of records) {
        expect(Object.keys(record).sort()).toEqual(['fixture', 'id', 'method', 'params', 'responseSha256', 'retrievedAt', 'slot', 'source']);
        expect(record.source).toBe('fixture');
        const receipt = receipts.get(record.id)!;
        const file = (record.params as any).file;
        expect(record.fixture).toBe(`fixtures/kamino/${KAMINO_CAPTURE}/${file}`);
        if (file.startsWith('rpc-')) {
          expect(record.method).toBe('getMultipleAccounts');
          expect(Object.keys(record.params as any).sort()).toEqual(['file', 'key']);
          expect(record.slot).toBe(Number(receipt.observation.blockOrSlot));
        } else {
          expect(record.method).toBe('httpCapture');
          expect(Object.keys(record.params as any).sort()).toEqual(['file', 'host', 'path']);
          expect(record.slot).toBeNull();
        }
        expect(record.responseSha256).toBe(receipt.responseSha256);
        expect(record.retrievedAt).toBe(receipt.observation.retrievedAt);
        expect(json(record)).not.toContain('endpoint');
        expect(json(record)).not.toContain('://');
      }
      for (const captureId of readdirSync(join(ROOT, 'fixtures/kamino'))) {
        const capture = loadCapture(join(ROOT, 'fixtures/kamino', captureId));
        for (const record of Object.values(capture.records)) if ('endpoint' in record) endpoints.add((record as any).endpoint);
      }
      expect(endpoints.size).toBeGreaterThan(0);
      for (const endpoint of endpoints) expect(json(kamino.bundle)).not.toContain(endpoint);
    });

    test('no Kamino response carries endpoint material or an authority URL', async () => {
      for (const path of [kaminoBase, ...SECTIONS.map(s => `${kaminoBase}/${s}`), `${kaminoBase}/export/tokenomics.json`]) {
        const body = await (await handler(path)).text();
        expect(body).not.toContain('endpoint');
        expect(body).not.toContain('://');
      }
    });

    test('a corrupted committed capture fails the Kamino build as capture-rejected', () => {
      const root = mkdtempSync(join(tmpdir(), 'kamino-broken-'));
      try {
        cpSync(join(ROOT, 'fixtures/kamino'), join(root, 'fixtures/kamino'), { recursive: true });
        const state = join(root, 'fixtures/kamino', KAMINO_CAPTURE, 'rpc-state.json');
        const original = readFileSync(state, 'utf8');
        const flipped = original.replace(/"responseSha256"\s*:\s*"([0-9a-f])/, (m, first: string) => m.replace(first, first === 'a' ? 'b' : 'a'));
        expect(flipped).not.toBe(original);
        writeFileSync(state, flipped);
        let code: string | null = null;
        try { buildKaminoTokenomics({ root }); } catch (e) {
          expect(e).toBeInstanceOf(KaminoProjectionError);
          code = (e as KaminoProjectionError).code;
        }
        expect(code).toBe('capture-rejected');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });

  // ---------------------------------------------------------------- AC5
  describe('AC5 section statuses are honest', () => {
    test('the five mapped sections are ready and the six uncovered ones pending', () => {
      for (const section of READY_SECTIONS) expect(kamino.bundle[section].status).toBe('ready');
      for (const section of PENDING_SECTIONS) expect(kamino.bundle[section].status).toBe('pending');
    });

    test('pending envelopes carry no data and exactly the promised note text', () => {
      for (const section of PENDING_SECTIONS) {
        const envelope = kamino.bundle[section];
        expect(envelope.data).toBeNull();
        expect(envelope.asOf).toBeNull();
        expect(envelope.slotRange).toBeNull();
        expect(envelope.evidenceCount).toBe(0);
        if (section === 'answer') {
          expect(envelope.notes[0]).toBe(COVERAGE);
          expect(envelope.notes[1]).toBe(ANSWER_TAIL);
        } else {
          expect(envelope.notes).toEqual([PENDING_NOTES[section]!]);
        }
        for (const note of envelope.notes) expect(note).not.toMatch(/[0-9]/);
      }
    });

    test('ready envelopes open with the capture note naming id and slot', () => {
      for (const section of READY_SECTIONS) expect(kamino.bundle[section].notes[0]).toBe(CAPTURE_NOTE);
    });

    test('no envelope claims a headline answer and every envelope is Kamino', () => {
      for (const envelope of Object.values(kamino.bundle)) expect(envelope.protocol).toBe('kamino');
      expect(json(kamino.bundle)).not.toContain('shortAnswer');
      for (const status of collect(kamino.bundle, 'status'))
        expect(['yes', 'no', 'partly', 'undetermined']).not.toContain(status);
    });
  });

  // ---------------------------------------------------------------- AC6
  describe('AC6 control and programs are exact', () => {
    test('12 control rows in the four role kinds, every instruction list empty', () => {
      const { rows } = kamino.bundle.control.data!;
      expect(rows).toHaveLength(V.kamino.controlRows);
      expect(rows.filter(r => r.targetKind === 'role')).toHaveLength(9);
      expect(rows.filter(r => r.targetKind === 'program-code')).toHaveLength(3);
      expect(rows.filter(r => r.role === 'vaultAdminAuthority')).toHaveLength(1);
      expect(rows.filter(r => r.role === 'allocationAdmin')).toHaveLength(1);
      expect(rows.filter(r => r.role === 'lendingMarketOwner')).toHaveLength(7);
      expect(rows.filter(r => r.role === 'upgradeAuthority')).toHaveLength(3);
      for (const row of rows) {
        expect(row.instructions).toEqual([]);
        expect(row.basis).toBe('decoded');
        expect(row.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(rows.map(r => r.id)).toContain(`control:vault-admin:${VAULT}`);
      expect(rows.map(r => r.id)).toContain(`control:allocation-admin:${VAULT}`);
    });

    test('all four controllers are unresolved with the established-type note', () => {
      const { controllers } = kamino.bundle.control.data!;
      expect(controllers).toHaveLength(V.kamino.controllers);
      for (const controller of controllers) {
        expect(controller.type).toBe('unresolved');
        expect(controller.note).toBe('Account does not decode as a known controller; controller type not established.');
      }
    });

    test('the three program rows carry the upgrade-authority facts as bare addresses', () => {
      const facts = latest.result.snapshot.facts.filter((f: any) => f.predicate === 'UPGRADE_AUTHORITY');
      const rows = kamino.bundle.programs.data!.rows;
      expect(rows).toHaveLength(V.kamino.programRows);
      for (const row of rows) {
        expect(row.idl).toBeNull();
        expect(row.upgrades).toEqual([]);
        expect(row.activity).toEqual({ newest: null, oldestInWindow: null, txPerDay: null, dormant: null });
        expect(facts.some((f: any) => strip(f.object) === row.upgradeAuthority!.address)).toBe(true);
      }
      expect(rows.find(r => r.address === ORACLE_PROGRAM)!.upgradeAuthority!.address).toBe('4R33WT7isNgzALNyvpZKiZQARtZNAXarWB3prUbPkXX7');
    });

    test('a decoded Squads v4 authority becomes a multisig controller and a none upgrade authority becomes a none controller', () => {
      const variant = multisigVariant();
      const builtVariant = projectKamino({ capture: variant.capture, result: variant.result, directory: variant.directory });
      const controllers = builtVariant.bundle.control.data!.controllers;
      const multisig = controllers.find(c => c.id === 'controller:24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT') as any;
      expect(multisig.type).toBe('multisig');
      expect(multisig.threshold).toBe('2 of 3');
      expect(multisig.members).toHaveLength(3);
      const none = controllers.find(c => c.id === 'controller:none') as any;
      expect(none.type).toBe('none');
      const oracle = builtVariant.bundle.programs.data!.rows.find(r => r.address === ORACLE_PROGRAM)!;
      expect(oracle.upgradeable).toBe(false);
      expect(oracle.upgradeAuthority).toBeNull();
    });

    test('renaming every snapshot label leaves control and programs byte-identical', () => {
      const variant = renamedNamesVariant();
      const builtVariant = projectKamino({ capture: variant.capture, result: variant.result, directory: variant.directory });
      expect(json(builtVariant.bundle.control)).toBe(json(kamino.bundle.control));
      expect(json(builtVariant.bundle.programs)).toBe(json(kamino.bundle.programs));
    });
  });

  // ---------------------------------------------------------------- AC7
  describe('AC7 parameters, claims and basis mapping', () => {
    test('exactly the vault and reserve parameter rows of the plan, decoded and unsettable', () => {
      const rows = kamino.bundle.parameters.data!.rows;
      expect(rows).toHaveLength(V.kamino.parameterRows);
      expect(rows.slice(0, 7).map(r => r.id)).toEqual([
        'vault.performanceFeeBps', 'vault.managementFeeBps', 'vault.withdrawalPenaltyBps', 'vault.withdrawalPenaltyLamports',
        'vault.minWithdrawAmount', 'vault.unallocatedWeight', 'vault.unallocatedTokensCap',
      ]);
      for (const row of rows) {
        expect(row.basis).toBe('decoded');
        expect(row.setBy).toEqual([]);
      }
      const reserves = rows.slice(7);
      expect(reserves).toHaveLength(21);
      for (const row of reserves) expect(['protocolTakeRatePct', 'withdrawalCapCapacity', 'vaultTargetWeight']).toContain(row.field);
    });

    test('display units follow the presentation rules', () => {
      const rows = kamino.bundle.parameters.data!.rows;
      expect(rows.find(r => r.id === 'vault.performanceFeeBps')!.display).toBe('10%');
      expect(rows.find(r => r.id === 'vault.managementFeeBps')!.display).toBe('0%');
      expect(rows.find(r => r.field === 'withdrawalCapCapacity')!.display.endsWith(' per 86400s')).toBe(true);
      expect(rows.find(r => r.field === 'withdrawalPenaltyLamports')!.unit).toBe('PYUSD');
    });

    test('the documentation claim is unresolved and cites the observed chain state', () => {
      const data = kamino.bundle.claims.data!;
      expect(data.rows).toHaveLength(1);
      const row = data.rows[0];
      expect(row.id).toBe('kamino-docs-typical-buffer-share');
      expect(row.status).toBe('unresolved');
      expect(row.source).toBe('kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals.md');
      expect(row.chainResult).toContain('404 ppm');
      expect(row.chainResult).toContain('467392859');
      expect(row.chainResult).toContain('5–10%');
      expect(row.chainResult).toContain("documented typical vault, not this vault's policy");
      expect(row.note).toBe('Comparison result: below-claimed-range.');
      expect(row.basis).toEqual(['claimed', 'derived']);
      expect(row.evidenceIds.length).toBeGreaterThan(0);
    });

    test('no basis anywhere in the bundle is declared, inferred or reported', () => {
      for (const basis of collect(kamino.bundle, 'basis')) {
        for (const value of Array.isArray(basis) ? basis : [basis]) expect(['declared', 'inferred', 'reported']).not.toContain(value);
      }
    });

    test('no reported API quantity value appears anywhere in the bundle', () => {
      const reported = latest.result.report.quantities.filter((q: any) => q.basis === 'reported');
      expect(reported.length).toBeGreaterThan(0);
      const bundleText = json(kamino.bundle);
      for (const quantity of reported) {
        // A bare "0" is not an identifiable value; every reported value of two or more
        // characters must be absent. The two "0" quantities are disclosed in the test report.
        if (String(quantity.value).length >= 2) expect(bundleText).not.toContain(String(quantity.value));
      }
    });

    test('a simulated fact makes the projection fail with an explicit code', () => {
      const variant = simulatedVariant();
      let code: string | null = null, name: string | null = null;
      try { projectKamino({ capture: variant.capture, result: variant.result, directory: variant.directory }); }
      catch (e) { name = (e as Error).name; code = (e as KaminoProjectionError).code; }
      expect(name).toBe('KaminoProjectionError');
      expect(code).toBe('simulated-basis');
    });
  });

  // ---------------------------------------------------------------- AC8
  describe('AC8 graph and Neo4j, all protocols together', () => {
    test('the Kamino graph passes its namespace check with exact two-label nodes and no mint nodes', () => {
      const graph = graphOf();
      expect(() => assertTokenomicsNamespace(graph, 'TGKamino')).not.toThrow();
      for (const node of graph.nodes) {
        expect(node.labels).toHaveLength(2);
        expect(node.labels[0]).toBe('TGKamino');
        expect(TG_LABELS).toContain(node.labels[1] as (typeof TG_LABELS)[number]);
      }
      for (const id of ['mint:mnde', 'mint:msol']) expect(graph.nodes.some(n => n.id === id)).toBe(false);
      expect(graph.nodes.some(n => n.labels[1] === 'Mint')).toBe(false);
      for (const type of ['ALLOCATES_TO', 'IN_MARKET', 'PRICED_BY'])
        expect(graph.relationships.filter(r => r.type === type)).toHaveLength((V.kamino.dependencyCounts as any)[type]);
    });

    test('unsafe namespaces and governance-case vocabulary are rejected before any driver call', async () => {
      let driverCalls = 0;
      const counting: Neo4jDriverLike = { async executeQuery() { driverCalls++; return { records: [] }; } };
      const graph = graphOf();
      expect(() => assertTokenomicsNamespace(graph, 'Entity')).toThrow();
      expect(() => assertTokenomicsNamespace(graph, 'X`) DELETE n')).toThrow();
      expect(() => assertTokenomicsNamespace(graph, 'TG`')).toThrow();
      expect(() => assertTokenomicsNamespace({ ...graph, nodes: [{ ...graph.nodes[0], labels: ['TGKamino', 'Entity'] }] })).toThrow();
      expect(() => assertTokenomicsNamespace({ ...graph, relationships: [{ ...graph.relationships[0], type: 'TRANSFER' }] })).toThrow();
      expect(() => assertTokenomicsNamespace({ ...graph, relationships: [{ ...graph.relationships[0], type: 'BURN' }] })).toThrow();
      expect(() => tokenomicsCypherBatches({ ...graph, nodes: [{ ...graph.nodes[0], labels: ['TGKamino', 'Entity'] }] }, 'TGKamino')).toThrow();
      expect(driverCalls).toBe(0);
      await expect(loadTokenomicsNeo4j(counting, { ...graph, relationships: [{ ...graph.relationships[0], type: 'TRANSFER' }] }, NEO4J_CONFIG, 'TGKamino')).rejects.toThrow();
      expect(driverCalls).toBe(0);
    });

    test('the Kamino query list is the four promised queries with the omitted ones named in the notes', () => {
      const queries = kamino.bundle.graph.data!.queries;
      expect(queries.map(q => q.id)).toEqual(KAMINO_QUERY_IDS);
      for (const omitted of OMITTED_QUERY_IDS) expect(json(kamino.bundle.graph.notes)).toContain(omitted);
      expect(json(kamino.bundle.graph.notes)).not.toContain('vault-dependencies (');
      const vault = queries.find(q => q.id === 'vault-dependencies')!;
      expect(vault.title).toBe('Vault dependencies');
      expect(vault.question).toBe('What does the vault depend on: which reserves, lending markets and oracles?');
    });

    test('the vault-dependencies local rows list every dependency relationship exactly once', () => {
      const rows = runTokenomicsLocal(graphOf(), 'vault-dependencies', kaminoQueries()).rows;
      expect(rows).toHaveLength(V.kamino.vaultDependenciesRows);
      const keys = rows.map(r => `${r.relation}:${r.from}:${r.to}`);
      expect(new Set(keys).size).toBe(keys.length);
      const addresses = new Map(graphOf().nodes.map(n => [n.id, n.props.address as string]));
      for (const rel of graphOf().relationships.filter(r => ['ALLOCATES_TO', 'IN_MARKET', 'PRICED_BY'].includes(r.type)))
        expect(keys).toContain(`${rel.type}:${addresses.get(rel.source)}:${addresses.get(rel.target)}`);
    });

    test('a kamino load creates its own constraint and never writes another namespace', async () => {
      const fake = makeFakeDriver();
      const { kaminoService } = pair(fake.driver, { holder: null });
      await kaminoService.load();
      expect(fake.calls[4].cypher).toBe('CREATE CONSTRAINT tg_kamino_id IF NOT EXISTS FOR (n:TGKamino) REQUIRE n.id IS UNIQUE');
      expect(fake.calls.slice(0, 4).map(c => c.cypher)).toEqual(CANNED_QUERIES.map(q => q.cypher));
      expect(fake.calls.slice(-4).map(c => c.cypher)).toEqual(CANNED_QUERIES.map(q => q.cypher));
      expect(fake.calls.some(c => c.cypher === 'MATCH (n:TGKamino) DETACH DELETE n')).toBe(true);
      const own = fake.calls.filter(c => c.routing === 'WRITE' || c.cypher.includes('DETACH DELETE'));
      expect(own.length).toBeGreaterThan(0);
      for (const call of own) {
        expect(/:TG(?![A-Za-z0-9_])/.test(call.cypher)).toBe(false);
        expect(call.cypher).not.toContain(':Entity');
      }
      expect(fake.side('TGKamino').nodes.size).toBe(graphOf().nodes.length);
      expect(fake.side('TGKamino').rels.length).toBe(graphOf().relationships.length);
      expect(fake.store.has('TG')).toBe(false);
    });

    test('after loading marinade then kamino both namespaces coexist and both views read Neo4j', async () => {
      const fake = makeFakeDriver();
      const lock = { holder: null as string | null };
      const { marinade, kaminoService } = pair(fake.driver, lock);
      await marinade.load();
      expect(fake.side('TG').nodes.size).toBe(V.marinade.graph.nodes);
      expect(fake.side('TG').rels.length).toBe(V.marinade.graph.relationships);
      await kaminoService.load();
      expect(fake.side('TGKamino').nodes.size).toBe(graphOf().nodes.length);
      expect(fake.side('TGKamino').rels.length).toBe(graphOf().relationships.length);
      expect(fake.side('TG').nodes.size).toBe(V.marinade.graph.nodes);
      const marinadeView = await marinade.query();
      expect(marinadeView.source).toBe('neo4j');
      for (const q of marinadeView.queries) expect(q.rows).toEqual(runTokenomicsLocal(marinadeGraph(), q.id).rows);
      const kaminoView = await kaminoService.query();
      expect(kaminoView.source).toBe('neo4j');
      for (const q of kaminoView.queries) expect(q.rows).toEqual(runTokenomicsLocal(graphOf(), q.id, kaminoQueries()).rows);
    });

    test('reloading kamino leaves every marinade node and relationship untouched', async () => {
      const fake = makeFakeDriver();
      const { marinade, kaminoService } = pair(fake.driver, { holder: null });
      await marinade.load();
      await kaminoService.load();
      const before = json({ nodes: [...fake.side('TG').nodes.values()], rels: fake.side('TG').rels });
      await kaminoService.load();
      expect(json({ nodes: [...fake.side('TG').nodes.values()], rels: fake.side('TG').rels })).toBe(before);
      expect(fake.side('TGKamino').nodes.size).toBe(graphOf().nodes.length);
    });

    test('a load of either protocol while another load runs gets 409 through the shared lock', async () => {
      const fake = makeFakeDriver();
      const lock = { holder: null as string | null };
      const { marinade, kaminoService } = pair(fake.driver, lock);
      lock.holder = 'TG';
      await expect(kaminoService.load()).rejects.toMatchObject({ status: 409 });
      lock.holder = 'TGKamino';
      await expect(marinade.load()).rejects.toMatchObject({ status: 409 });
      lock.holder = null;
    });

    test('with the shared lock held, both views fall back locally with the in-progress reason', async () => {
      const fake = makeFakeDriver();
      const lock = { holder: 'TG' as string | null };
      const { marinade, kaminoService } = pair(fake.driver, lock);
      const marinadeView = await marinade.query();
      const kaminoView = await kaminoService.query();
      expect(marinadeView.source).toBe('local');
      expect(kaminoView.source).toBe('local');
      expect(marinadeView.reason).toContain('load is in progress');
      expect(kaminoView.reason).toContain('load is in progress');
      expect(fake.calls).toHaveLength(0);
      lock.holder = null;
    });

    test('an altered kamino node moves only the kamino view off Neo4j', async () => {
      const fake = makeFakeDriver();
      const lock = { holder: null as string | null };
      const { marinade, kaminoService } = pair(fake.driver, lock);
      await marinade.load();
      await kaminoService.load();
      const nodes = fake.side('TGKamino').nodes;
      const first = [...nodes.values()][0];
      nodes.set(first.id, { ...first, props: { ...first.props, label: 'altered' } });
      const kaminoView = await kaminoService.query();
      expect(kaminoView.source).toBe('local');
      expect(kaminoView.reason).toContain('differs');
      const marinadeView = await marinade.query();
      expect(marinadeView.source).toBe('neo4j');
      lock.holder = null;
    });

    test('the loader script prints kamino counts for the kamino protocol flag', async () => {
      const run = await Bun.$`bun scripts/load-tokenomics-neo4j.ts --protocol kamino --dry-run`.nothrow();
      expect(run.exitCode).toBe(0);
      const out = JSON.parse(run.stdout.toString());
      expect(out.protocol).toBe('kamino');
      expect(out.nodes).toBe(graphOf().nodes.length);
      expect(out.relationships).toBe(graphOf().relationships.length);
      const nodesByType: Record<string, number> = {}, relsByType: Record<string, number> = {};
      for (const node of graphOf().nodes) nodesByType[node.labels[1]] = (nodesByType[node.labels[1]] ?? 0) + 1;
      for (const rel of graphOf().relationships) relsByType[rel.type] = (relsByType[rel.type] ?? 0) + 1;
      expect(out.nodesByType).toEqual(nodesByType);
      expect(out.relationshipsByType).toEqual(relsByType);
    }, 300_000);

    test('the loader script without a protocol flag keeps the marinade dry-run behaviour', async () => {
      const result = await Bun.$`bun scripts/load-tokenomics-neo4j.ts --dry-run`.nothrow();
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout.toString());
      expect(out.nodes).toBe(V.kamino.loaderDryRun.default.nodes);
      expect(out.relationships).toBe(V.kamino.loaderDryRun.default.relationships);
      expect(marinadeGraph().nodes.length).toBe(V.marinade.graph.nodes);
      expect(marinadeGraph().relationships.length).toBe(V.marinade.graph.relationships);
      expect(out.protocol).toBeUndefined();
    }, 300_000);

    test('an unknown protocol id prints usage and exits 1', async () => {
      const result = await Bun.$`bun scripts/load-tokenomics-neo4j.ts --protocol loopscale --dry-run`.nothrow();
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('Usage');
    }, 60_000);
  });

  // ---------------------------------------------------------------- AC9
  describe('AC9 workspace and questions over the Kamino graph', () => {
    test('navigation renders a button per protocol in registry order', () => {
      const nav = renderTokenomicsNavigation({ protocols: [{ id: 'marinade', title: 'Marinade tokenomics' }, { id: 'kamino', title: 'Kamino: Sentora PYUSD kVault' }] });
      expect(nav).toContain('Marinade tokenomics');
      expect(nav).toContain('Kamino: Sentora PYUSD kVault');
      expect(nav.indexOf('Kamino: Sentora PYUSD kVault')).toBeGreaterThan(nav.indexOf('Marinade tokenomics'));
    });

    test('every workspace URL for Kamino stays under the kamino protocol path', () => {
      for (const rest of ['', '/control', '/parameters', `/evidence?id=${'a'.repeat(64)}`, '/graph/load', '/export/tokenomics.json'])
        expect(tokenomicsUrl('kamino', rest)).toBe(`/api/tokenomics/kamino${rest}`);
      expect(tokenomicsUrl('marinade', '')).toBe('/api/tokenomics/marinade');
    });

    test('opening Kamino fetches only kamino URLs and never a governance-graph URL', async () => {
      const urls: string[] = [];
      const previous = {
        fetch: globalThis.fetch,
        document: (globalThis as any).document,
        window: (globalThis as any).window,
        history: (globalThis as any).history,
        location: (globalThis as any).location,
      };
      const fakeElement = (): any => {
        const store: any = { hidden: false, textContent: '', innerHTML: '', value: '', disabled: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
        return new Proxy(store, {
          get(target, property) {
            if (property in target) return target[property];
            if (property === 'querySelector' || property === 'closest') return () => fakeElement();
            if (property === 'querySelectorAll' || property === 'children' || property === 'parentElement') return () => [];
            if (property === 'getAttribute') return () => null;
            return () => undefined;
          },
          set(target, property, value) { target[property] = value; return true; },
        });
      };
      (globalThis as any).document = {
        body: fakeElement(),
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => fakeElement(),
        querySelectorAll: () => [],
        createElement: () => fakeElement(),
      };
      (globalThis as any).window = globalThis;
      (globalThis as any).history = { replaceState() {}, pushState() {} };
      (globalThis as any).location = { hash: '' };
      globalThis.fetch = (async (url: any) => {
        urls.push(String(url));
        return new Response(String(url).startsWith(kaminoBase) ? json(kamino.bundle) : '{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as any;
      try {
        const workspace = new TokenomicsWorkspace(() => {}, () => {});
        await workspace.open('kamino');
        try { (workspace as any).setTab('graph'); } catch { /* rendering past the fetch surface is not needed for this assertion */ }
        expect(urls.length).toBeGreaterThan(0);
        expect(urls).toContain(kaminoBase);
        for (const url of urls) expect(url.startsWith(kaminoBase)).toBe(true);
        expect(urls.some(url => url.startsWith('/api/graph'))).toBe(false);
      } finally {
        globalThis.fetch = previous.fetch;
        (globalThis as any).document = previous.document;
        (globalThis as any).window = previous.window;
        (globalThis as any).history = previous.history;
        (globalThis as any).location = previous.location;
      }
    });

    test('the rendered Kamino workspace never shows Marinade, MNDE or mSOL', () => {
      const header = renderTokenomicsHeader('kamino', kamino.bundle);
      expect(header.heading).toBe('Kamino: Sentora PYUSD kVault');
      expect(header.coverage).toBe(COVERAGE);
      expect(header.heading.includes('?')).toBe(false);
      expect(header.eyebrow).not.toContain('MARINADE');
      const parts = [
        header.eyebrow, header.heading, header.coverage ?? '', renderTokenomicsPrompts('kamino'),
        renderSection(kamino.bundle, 'overview'),
        ...SECTIONS.map(section => renderSection(kamino.bundle, section)),
      ];
      for (const question of NINE_QUESTIONS) {
        const result = answerQuestion(question, kamino.bundle);
        parts.push(result.text, ...result.facts.map(f => f.text), ...result.limitations, result.query ? json(result.query) : '');
      }
      const html = parts.join('\n');
      for (const term of ['Marinade', 'MNDE', 'mSOL']) expect(html).not.toContain(term);
    });

    test('pending tabs render as in progress with their notes', () => {
      for (const section of ['path', 'offsets', 'participation', 'holders', 'flows'] as SectionId[]) {
        const html = renderSection(kamino.bundle, section);
        expect(html).toContain('In progress');
        expect(html).toContain(escapeHtml(PENDING_NOTES[section]!));
      }
      expect(renderSection(kamino.bundle, 'overview')).toContain(escapeHtml(COVERAGE));
    });

    test('the default graph picture seeds from the vault and the controllers', () => {
      const picture = selectTokenomicsPicture(kamino.bundle.graph.data!) as { nodes: { id: string; type: string; label: string }[]; edges: unknown[] };
      expect(picture.nodes.length).toBeGreaterThan(0);
      const labels = picture.nodes.map(n => n.label);
      for (const node of graphOf().nodes.filter(n => ['Vault', 'Controller'].includes(n.labels[1])))
        expect(labels).toContain(String(node.props.address));
    });

    test('question 1 returns exactly the two control rows naming the address and role', () => {
      const answer = answerQuestion(NINE_QUESTIONS[0], kamino.bundle);
      expect(answer.facts.map(f => f.id).sort()).toEqual([
        `control:allocation-admin:${VAULT}`,
        `control:vault-admin:${VAULT}`,
      ]);
      expect(answer.text).toContain('7fLxEftpppneavpueYgP2s7HhSGbWpj2jTCmAEwwqonY');
      expect(answer.text).toContain('allocationAdmin');
      expect(answer.text).toContain('not yet mapped');
    });

    test('question 2 names the controller and the unmapped instruction for the lending program', () => {
      const answer = answerQuestion(NINE_QUESTIONS[1], kamino.bundle);
      expect(answer.text).toContain('GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW');
      expect(answer.text).toContain('upgradeAuthority');
      expect(answer.text).toContain('not yet mapped');
      expect(answer.facts.length).toBeGreaterThan(0);
    });

    test('question 3 returns the fee parameter rows first', () => {
      const answer = answerQuestion(NINE_QUESTIONS[2], kamino.bundle);
      expect(answer.facts[0].id).toBe('vault.performanceFeeBps');
      expect(answer.facts[1].id).toBe('vault.managementFeeBps');
      expect(answer.text).toContain('10%');
    });

    test('question 4 returns the vault-dependencies rows from the local graph', () => {
      const answer = answerQuestion(NINE_QUESTIONS[3], kamino.bundle);
      expect(answer.query).toBeDefined();
      expect(answer.query!.title).toBe('Vault dependencies');
      expect(answer.query!.source).toBe('local');
      expect(answer.query!.rows).toHaveLength(5);
      expect(answer.query!.rows).toEqual(runTokenomicsLocal(graphOf(), 'vault-dependencies', kaminoQueries()).rows.slice(0, 5));
      for (const row of answer.query!.rows) expect(['ALLOCATES_TO', 'IN_MARKET', 'PRICED_BY']).toContain(String(row.relation));
    });

    test('question 5 returns the claim row with its unresolved status', () => {
      const answer = answerQuestion(NINE_QUESTIONS[4], kamino.bundle);
      expect(answer.facts[0].id).toBe('kamino-docs-typical-buffer-share');
      expect(json(answer.facts[0])).toContain('unresolved');
      expect(answer.limitations.join(' ')).toContain(COVERAGE);
    });

    test.each([5, 6, 7, 8])('unmapped question %i reports not mapped, never absence', index => {
      const answer = answerQuestion(NINE_QUESTIONS[index], kamino.bundle);
      expect(answer.facts).toHaveLength(0);
      expect(answer.text).toContain('Not mapped in this capture');
      expect(answer.text).toContain('not as absent');
      const lowered = answer.text.toLowerCase();
      for (const term of NOT_MAPPED_ANSWER_TERMS) expect(lowered).not.toContain(term);
      const limitations = answer.limitations.join(' ');
      expect(limitations).toContain('Not mapped in this capture');
      const note = PENDING_NOTES[answer.sections[0] as SectionId]!;
      expect(limitations).toContain(note.slice(0, 40));
    });

    test('every fact of the mapped questions cites resolvable Kamino evidence', async () => {
      const all: string[] = [];
      for (const question of NINE_QUESTIONS.slice(0, 5)) {
        for (const fact of answerQuestion(question, kamino.bundle).facts) {
          expect(fact.basis).toBeDefined();
          expect(fact.evidenceIds.length).toBeGreaterThan(0);
          all.push(...fact.evidenceIds);
        }
      }
      const unique = [...new Set(all)];
      for (let i = 0; i < unique.length; i += 200) {
        const body = await (await handler(`${kaminoBase}/evidence?${unique.slice(i, i + 200).map(id => `id=${id}`).join('&')}`)).json();
        expect(body.missing).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------- AC10
  describe('AC10 analyst wording and conventions', () => {
    test('no analyst-judgement term appears in the Kamino bundle', () => {
      const lowered = json(kamino.bundle).toLowerCase();
      for (const term of T9_TERMS) expect(lowered).not.toContain(term);
    });

    test('no analyst-judgement term appears in the rendered Kamino surfaces', () => {
      const header = renderTokenomicsHeader('kamino', kamino.bundle);
      const parts = [
        header.eyebrow, header.heading, header.coverage ?? '', renderTokenomicsPrompts('kamino'),
        renderSection(kamino.bundle, 'overview'),
        ...SECTIONS.map(section => renderSection(kamino.bundle, section)),
        ...NINE_QUESTIONS.map(question => {
          const answer = answerQuestion(question, kamino.bundle);
          return [answer.text, ...answer.facts.map(f => f.text), ...answer.limitations, answer.query ? json(answer.query) : ''].join('\n');
        }),
      ];
      const lowered = parts.join('\n').toLowerCase();
      for (const term of T9_TERMS) expect(lowered).not.toContain(term);
    });

    test('no source file imports the private Loopscale adapter', () => {
      const scan = (dir: string): string[] => readdirSync(dir).flatMap(name => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return scan(path);
        return /\.tsx?$|\.html$/.test(name) ? [path] : [];
      });
      for (const file of scan(join(ROOT, 'src'))) expect(readFileSync(file, 'utf8')).not.toContain('adapters/loopscale');
    });

    test.skipIf(!hasGitBase)('no file the implementer changed or created carries a forbidden publish marker', async () => {
      const changed = (await Bun.$`git diff --name-only ${baseCommit} -- src scripts`.nothrow().text()).split('\n').map(l => l.trim()).filter(Boolean);
      const untracked = (await Bun.$`git ls-files --others --exclude-standard -- src scripts`.nothrow().text()).split('\n').map(l => l.trim()).filter(Boolean);
      const lines = readFileSync(join(ROOT, 'scripts', 'publish' + '.allowlist'), 'utf8').split('\n');
      const start = lines.findIndex(l => l.trim() === '[forbidden]');
      const forbidden = lines.slice(start + 1).filter(l => l.trim() && !l.startsWith('[')).map(l => l.trim());
      expect(forbidden.length).toBeGreaterThan(10);
      for (const file of [...changed, ...untracked]) {
        const text = readFileSync(join(ROOT, file), 'utf8');
        for (const marker of forbidden) expect(text).not.toContain(marker);
      }
    });
  });
});
