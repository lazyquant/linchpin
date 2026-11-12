import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as net from 'node:net';
import netDefault from 'node:net';
import { sha256 } from '../src/chain/evidence';
import { identity } from '../src/adapters/kamino';
import { buildTokenomics, type TokenomicsBuild } from '../src/tokenomics/build';
import { buildKaminoTokenomics, latestKaminoCapture, projectKamino, KaminoProjectionError, type KaminoBuild } from '../src/tokenomics/kamino';
import { TOKENOMICS_REGISTRY, type ProtocolEntry } from '../src/tokenomics/registry';
import { answerQuestion } from '../src/web/tokenomics-questions';
import { api, ResearchService } from '../src/web/server';
import { ROOT, runPipeline } from '../src/web/runner';
import baseValues from './fixtures/tokenomics-multi-protocol/base-values.json';

const restores: (() => void)[] = [];
const networkCalls: string[] = [];
const trap = (name: string) => (): never => {
  networkCalls.push(name);
  throw new Error(`Unexpected network access: ${name}`);
};
let kamino: KaminoBuild;
let marinade: TokenomicsBuild;
let capture: ReturnType<typeof latestKaminoCapture>;

beforeAll(async () => {
  for (const key of ['NEO4J_URI', 'NEO4J_USERNAME', 'NEO4J_PASSWORD', 'NEO4J_DATABASE']) {
    const saved = process.env[key];
    delete process.env[key];
    restores.push(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(trap('fetch') as unknown as typeof fetch);
  restores.push(() => fetchSpy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { trap('WebSocket')(); } } as unknown as typeof WebSocket;
  restores.push(() => { globalThis.WebSocket = realWebSocket; });
  const connectSpy = spyOn(Bun, 'connect').mockImplementation(trap('Bun.connect'));
  restores.push(() => connectSpy.mockRestore());
  for (const module of [net, netDefault]) {
    for (const key of ['connect', 'createConnection'] as const) {
      const spy = spyOn(module, key).mockImplementation(trap(`node:net.${key}`));
      restores.push(() => spy.mockRestore());
    }
  }
  const socketSpy = spyOn(net.Socket.prototype, 'connect').mockImplementation(trap('Socket.connect'));
  restores.push(() => socketSpy.mockRestore());
  capture = latestKaminoCapture(ROOT);
  kamino = buildKaminoTokenomics({ root: ROOT });
  marinade = await buildTokenomics({ root: ROOT, packResult: await runPipeline('marinade') });
}, 120_000);

afterEach(() => expect(networkCalls).toEqual([]));
afterAll(() => { for (const restore of restores.reverse()) restore(); });

const answer = (question: string) => answerQuestion(question, kamino.bundle);
const penalty = (build: KaminoBuild) => build.bundle.parameters.data!.rows.find(row => row.field === 'withdrawalPenaltyLamports')!;
const request = (path: string, method = 'GET') => new Request(`http://localhost/api/tokenomics${path}`, { method });

describe('R1: mapped mechanics take precedence over ambiguous topic words', () => {
  test.each([
    ['Who holds the admin authority: the multisig?', 'vaultAdminAuthority'],
    ['Who holds the allocation admin role?', 'allocationAdmin'],
    ['Who holds the lending market owner role?', 'lendingMarketOwner'],
    ['Who holds the market owner authority?', 'lendingMarketOwner'],
    ['Who holds the program upgrade authority?', 'upgradeAuthority'],
    ["Who holds the kVault program's upgrade authority?", 'upgradeAuthority'],
    ["Who holds the vault's admin role?", 'vaultAdminAuthority'],
    ['Who can transfer the allocation admin role?', 'allocationAdmin'],
    ['Who holds the upgrade authority?', 'upgradeAuthority'],
    ['Which account holds the vault admin role?', 'vaultAdminAuthority'],
    ['Who can transfer the vault admin authority?', 'vaultAdminAuthority'],
    ['Who can lock the vault?', 'vaultAdminAuthority'],
    ['Who can pause the vault?', 'vaultAdminAuthority'],
    ['Who is the holder of the admin role?', 'vaultAdminAuthority'],
  ])('%s reaches cited control rows', (question, role) => {
    const result = answer(question);
    const rows = kamino.bundle.control.data!.rows.filter(row => row.role === role);
    expect(result.facts.some(fact => rows.some(row => row.id === fact.id))).toBe(true);
    expect(result.text).not.toContain('Not mapped in this capture');
    expect(result.limitations).toEqual([]);
    expect(result.facts.some(fact => fact.text.includes('instruction not mapped'))).toBe(true);
    for (const fact of result.facts) {
      expect(fact.evidenceIds.length).toBeGreaterThan(0);
      expect(kamino.evidence.lookup(fact.evidenceIds).missing).toEqual([]);
    }
  });

  test('a per-transaction fee question retrieves the vault fee parameters', () => {
    const result = answer('What fees does the vault charge per transaction?');
    expect(result.facts.map(fact => fact.id)).toContain('vault.performanceFeeBps');
    expect(result.facts.map(fact => fact.id)).toContain('vault.managementFeeBps');
    expect(result.text).not.toContain('Not mapped in this capture');
  });

  test.each([
    ['Who holds KMNO?', 'holders'],
    ['Which account holds the vault shares?', 'holders'],
    ['Who are the kVault share holders?', 'holders'],
    ['Show vault transactions', 'flows'],
    ['Who can transfer PYUSD?', 'flows'],
    ['What flows entered the vault?', 'flows'],
    ['Who can lock KMNO?', 'participation'],
    ['Who can lock KMNO in the vault?', 'participation'],
    ['How is KMNO governed?', 'participation'],
    ["Where do the vault's fees go?", 'path'],
    ['What does the treasury hold?', 'offsets'],
  ] as const)('%s still reports missing coverage', (question, section) => {
    const result = answer(question);
    expect(result.sections).toEqual([section]);
    expect(result.text).toContain('Not mapped in this capture');
    expect(result.limitations.join(' ')).toContain('Not mapped in this capture');
    expect(result.facts).toEqual([]);
  });

  test.each([
    ['What share of supply do the top holders control?', 'holders'],
    ['Who holds the most kVault shares and what fee do they pay?', 'holders'],
    ['Which transactions changed the admin role?', 'flows'],
    ['What transfers of the vault admin role occurred?', 'flows'],
    ['Show fee transactions', 'flows'],
    ['What fee flows went out last month?', 'flows'],
  ] as const)('%s preserves unmapped coverage', (question, section) => {
    const result = answer(question);
    expect(result.sections).toEqual([section]);
    expect(result.text).toContain('Not mapped in this capture');
    expect(result.facts).toEqual([]);
    expect(result.limitations).toContain(`${section}: ${kamino.bundle[section].notes.join(' ')}`);
  });

  test.each([
    ['Who holds the upgrade authority and who holds KMNO?', 'holders'],
    ['Who can transfer a role and what fee flows went out last month?', 'flows'],
  ] as const)('%s retains missing coverage alongside mapped facts', (question, section) => {
    const result = answer(question);
    expect(result.facts.some(fact => fact.section === 'control')).toBe(true);
    expect(result.limitations.join(' ')).toContain(kamino.bundle[section].notes.join(' '));
  });

  test('Marinade bundle and the pinned question answers remain byte-identical', () => {
    const questions = [
      "Who can change the vault's allocations?", 'Who can upgrade the lending program?',
      'What fees does the vault charge?', 'What does the vault depend on?',
      "Does the documentation's buffer claim match the chain?", "Where do the vault's fees go?",
      'Who holds KMNO?', 'What does the treasury hold?', 'How is KMNO governed?',
      'Who controls the reward fee?', 'Who can change the fees?', 'Can more MNDE be minted?',
      'Predict Bitcoin closing price tomorrow', 'What buybacks flowed?',
      'Is the value path to MNDE holders enforced?', 'Show external outflows', 'Show graph program dependencies',
    ];
    expect(sha256(JSON.stringify(marinade.bundle))).toBe(baseValues.marinade.bundle);
    expect(sha256(JSON.stringify(questions.map(question => answerQuestion(question, marinade.bundle))))).toBe(baseValues.marinade.answers17);
  });
});

describe('R2: withdrawal floor uses the decoded deposit token', () => {
  test('the capture displays its zero floor in PYUSD', () => {
    expect(penalty(kamino)).toMatchObject({ value: '0', display: '0 PYUSD', unit: 'PYUSD', basis: 'decoded' });
    const lamportQuantities = capture.result.mechanics.quantities.filter(quantity => quantity.unit === 'lamports');
    expect(lamportQuantities.map(quantity => quantity.name)).toEqual(['vault.withdrawalPenaltyLamports']);
  });

  test.each([[6, '1.234567 PYUSD'], [8, '0.01234567 PYUSD']])('nonzero floor uses %i decoded decimals', (decimals, display) => {
    const variant = structuredClone(capture);
    const quantity = variant.result.mechanics.quantities.find(q => q.name === 'vault.withdrawalPenaltyLamports')!;
    quantity.value = '1234567';
    variant.result.mechanics.quantities.find(q => q.name === 'vault.minWithdrawAmount')!.decimals = decimals;
    const build = projectKamino(variant);
    expect(penalty(build)).toMatchObject({ value: '1234567', unit: 'PYUSD', display });
    expect(build.evidence.lookup(penalty(build).evidenceIds).missing).toEqual([]);
    expect(quantity.unit).toBe('lamports'); // Projection does not mutate adapter output.
  });

  test('a different decoded deposit mint is not labelled SOL or PYUSD', () => {
    const variant = structuredClone(capture);
    const mint = '11111111111111111111111111111111';
    variant.result.mechanics.quantities.find(q => q.name === 'vault.minWithdrawAmount')!.mint = identity(mint);
    expect(penalty(projectKamino(variant))).toMatchObject({ unit: mint, display: `0 ${mint}` });
  });

  test('missing deposit-token evidence fails instead of assuming a scale', () => {
    const variant = structuredClone(capture);
    variant.result.mechanics.quantities.find(q => q.name === 'vault.minWithdrawAmount')!.decimals = null;
    expect(() => projectKamino(variant)).toThrow('capture-rejected');
  });
});

describe('R3: startup failures retain diagnostic codes and registry titles', () => {
  test.each([
    new KaminoProjectionError('no-capture'),
    new KaminoProjectionError('capture-rejected', 'hash-mismatch'),
    new KaminoProjectionError('unresolved-evidence'),
    new KaminoProjectionError('simulated-basis'),
    new KaminoProjectionError('unsupported-basis'),
    Object.assign(new Error('Untrusted transport details'), { code: 'EACCES' }),
  ])('logs and serves %s while Marinade stays available', async error => {
    const service = new ResearchService(undefined, undefined, { config: null });
    service.setTokenomicsBuild('marinade', marinade);
    const entry: ProtocolEntry = { ...TOKENOMICS_REGISTRY.find(entry => entry.id === 'kamino')!,
      title: 'Captured lending vault', load: async () => { throw error; } };
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await service.prepareTokenomics(ROOT, [entry]);
      const message = service.tokenomicsProtocols.get('kamino')!.error!;
      expect(message).toContain(entry.title);
      expect(message).toContain(error.code);
      if (error instanceof KaminoProjectionError) expect(message).toContain(error.message);
      expect(message).not.toContain('Untrusted transport details');
      expect(log).toHaveBeenCalledWith(message);
      const handler = api(service);
      for (const path of ['/kamino', '/kamino/control', '/kamino/evidence', '/kamino/export/tokenomics.json', '/kamino/graph/load']) {
        const response = await handler(request(path, path.endsWith('/load') ? 'POST' : 'GET'));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Tokenomics captured build is not ready', detail: message });
      }
      const index = await (await handler(request(''))).json();
      expect(index.message).toBe(message);
      expect(index.protocols.map((protocol: { id: string }) => protocol.id)).toEqual(['marinade']);
      expect(sha256(await (await handler(request('/marinade'))).text())).toBe(baseValues.marinade.route);
    } finally { log.mockRestore(); await service.close(); }
  });

  test('a real missing-capture failure survives the startup path', async () => {
    const service = new ResearchService(undefined, undefined, { config: null });
    const entry = TOKENOMICS_REGISTRY.find(entry => entry.id === 'kamino')!;
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await service.prepareTokenomics('', [{ ...entry, load: async () => buildKaminoTokenomics({ root: ROOT, capturesDir: 'missing-capture-for-regression' }) }]);
      const response = await api(service)(request('/kamino'));
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.detail).toContain(entry.title);
      expect(body.detail).toContain('no-capture');
      expect(log).toHaveBeenCalledWith(body.detail);
    } finally { log.mockRestore(); await service.close(); }
  });

  test('Marinade startup errors still propagate unchanged', async () => {
    const service = new ResearchService(undefined, undefined, { config: null });
    const error = new Error('Captured pack unavailable');
    await expect(service.prepareTokenomics(ROOT, [{ ...TOKENOMICS_REGISTRY[0], load: async () => { throw error; } }])).rejects.toBe(error);
  });
});

// Explicit semantic exemptions keep this oracle independent of the parser.
const pureRoleQuestions = new Set([
  "Who holds the allocation admin role?",
  "Who holds the lending market owner role?",
  "Who holds the market owner authority?",
  "Who holds the program upgrade authority?",
  "Who holds the kVault program's upgrade authority?",
  "Who holds the vault's admin role?",
  "Who can transfer the allocation admin role?",
  "Who holds the upgrade authority?",
  "Which account holds the vault admin role?",
  "Who can transfer the vault admin authority?",
  "Who can lock the vault?",
  "Who can pause the vault?",
  "Who is the holder of the admin role?"
]);
describe('R4: pending topic coverage survives every retrieval path', () => {
  test.each([
  "Who holds the allocation admin role?",
  "Who holds the lending market owner role?",
  "Who holds the market owner authority?",
  "Who holds the program upgrade authority?",
  "Who holds the kVault program's upgrade authority?",
  "Who holds the vault's admin role?",
  "Who can transfer the allocation admin role?",
  "Who holds the upgrade authority?",
  "Which account holds the vault admin role?",
  "Who can transfer the vault admin authority?",
  "Who can lock the vault?",
  "Who can pause the vault?",
  "Who is the holder of the admin role?",
  "What fees does the vault charge per transaction?",
  "Who holds KMNO?",
  "Which account holds the vault shares?",
  "Who are the kVault share holders?",
  "Show vault transactions",
  "Who can transfer PYUSD?",
  "What flows entered the vault?",
  "Who can lock KMNO?",
  "Who can lock KMNO in the vault?",
  "How is KMNO governed?",
  "Where do the vault's fees go?",
  "What does the treasury hold?",
  "What share of supply do the top holders control?",
  "Who holds the most kVault shares and what fee do they pay?",
  "Which transactions changed the admin role?",
  "What transfers of the vault admin role occurred?",
  "Show fee transactions",
  "What fee flows went out last month?",
  "Who holds the upgrade authority and who holds KMNO?",
  "Who can transfer a role and what fee flows went out last month?",
  "Who can change the vault's allocations?",
  "Who can upgrade the lending program?",
  "What fees does the vault charge?",
  "What does the vault depend on?",
  "Does the documentation's buffer claim match the chain?",
  "Who controls the reward fee?",
  "Who can change the fees?",
  "Can more MNDE be minted?",
  "Predict Bitcoin closing price tomorrow",
  "What buybacks flowed?",
  "Is the value path to MNDE holders enforced?",
  "Show external outflows",
  "Show graph program dependencies",
  "Which holders of KMNO are signers?",
  "Who holds KMNO and is an admin?",
  "Who holds the most shares among admin wallets?",
  "Who holds the token that the admin controls?",
  "Which transfers involved the vault admin?",
  "List token transfers from the vault admin",
  "Who transfers PYUSD to the vault owner?",
  "Do multisig signers hold kVault shares?",
  "How much KMNO does the market owner hold?",
  "Who holds more KMNO than the market owner?",
  "Who holds kVault shares besides the admin?",
  "Who holds KMNO but not the admin role?",
  "Do whales hold more than the multisig?",
  "Who holds shares at the vault owner?",
  "Who can transfer kVault shares for the vault admin?",
  "Who can transfer funds via the admin?",
  "Who holds the market owner's shares?",
  "Who holds the admin's KMNO?",
  "Who holds the admin wallets?",
  "Who holds the owner tokens?",
  "Who holds my admin tokens?",
  "Who can transfer the admin's PYUSD?",
  "Who holds the vault admin authority and KMNO?",
  "Who holds the admin role, KMNO and kVault shares?",
  "Who holds the admin, KMNO or shares?",
  "Who holds the admin role: KMNO and kVault shares?",
  "Who holds the admin; KMNO or shares?",
  "Show transfers to the treasury owner"
])('coverage invariant: %s', question => {
    const result = answer(question);
    const topics = [
      [/treasur/, 'offsets'],
      [/where[^?]*fee|fee[^?]*\b(go|goes|route|routed|destination|sent|collected)\b|value route/, 'path'],
      [/\bholders?\b|\bholds?\b|\bfloat\b/, 'holders'],
      [/govern|\bvot|\block|\bstak/, 'participation'],
      [/\bflows?\b|transaction|transfer/, 'flows'],
    ] as const;
    if (pureRoleQuestions.has(question)) return;
    for (const [pattern, section] of topics) {
      const envelope = kamino.bundle[section];
      if (!pattern.test(question.toLowerCase()) || envelope.status !== 'pending') continue;
      for (const note of envelope.notes.filter(note => note.startsWith('Not mapped in this capture'))) {
        expect(result.limitations.join(' ')).toContain(note);
        expect(result.text.toLowerCase()).toContain('not mapped');
      }
    }
  });
});
