import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Governance, GovernanceAccountParser, TokenOwnerRecord, Realm } from '@solana/spl-governance';
import { PublicKey } from '@solana/web3.js';
import { CANNOT_PROPOSE, classifyVotingBody, governanceFieldOffset, parseGovernanceConfig, readGovernanceConfig } from '../src/contracts/governance-config';
import { assertTokenomicsNamespace, buildTokenomicsGraph, runTokenomicsLocal, runTokenomicsNeo4j } from '../src/graph/tokenomics-neo4j';
import { configuration, dao, emergency, governanceKeys, hasGovernanceFixture, sdkAccount, syntheticGovernance, syntheticAnswer } from './helpers/governance';
import { key } from './helpers/contracts';
import { readContractsLayer, type ContractsInput } from '../src/contracts/marinade';
import { readAuthorities } from '../src/contracts/authorities';
import { RecordingRpc } from '../src/chain/rpc';
import { runOptions } from '../src/config';
import type { PackRegistry } from '../src/pack/build';

describe('SDK governance configurations and council membership', () => {
  test.each([
    [false, true, 'council-only'], [true, false, 'community-only'], [true, true, 'community-and-council'], [false, false, 'no-proposals'],
  ] as const)('SDK bytes classify community=%s council=%s as %s', (community, council, expected) => {
    for (const accountType of [3, 18]) {
      const data = sdkAccount(Governance, accountType, { realm: dao, config: configuration(community, council) });
      const parsed = GovernanceAccountParser(Governance)(new PublicKey(key(1)), { data, owner: new PublicKey(key(2)), executable: false, lamports: 1 }).account;
      const config = parseGovernanceConfig(parsed.config);
      expect(classifyVotingBody(config)).toBe(expected);
      expect(config.votingTimeSeconds).toBe(86400); expect(config.instructionHoldUpSeconds).toBe(3600);
    }
  });
  test('u64 max proposal minima override enabled votes without erasing vote and veto settings', async () => {
    const { i } = await syntheticGovernance();
    const g = i.governance.governances.find(g => g.address === governanceKeys[3])!;
    expect(g.votingBody).toBe('no-proposals'); expect(g.config.community.vote.enabled).toBe(true);
    expect(g.config.community.proposalMinimumRaw).toBe(CANNOT_PROPOSE); expect(g.config.council.veto.value).toBe(50);
    expect(g.config.council.tipping).toBe('Early'); expect(g.config.votingCoolOffSeconds).toBe(1800);
  });
  test('recorded queries derive SDK offsets; positive deposits define members, delegates stay separate, and overlaps are intersections', async () => {
    const { i, rpc } = await syntheticGovernance();
    expect(governanceFieldOffset(TokenOwnerRecord, 'realm')).toBe(1);
    expect(governanceFieldOffset(TokenOwnerRecord, 'governingTokenMint')).toBe(33);
    expect(() => governanceFieldOffset(Realm, 'name')).toThrow();
    const realm = i.governance.realms.find(r => r.address === dao)!;
    expect(realm.records).toHaveLength(3); expect(realm.members.map(m => m.owner)).toEqual([key(60), key(61)].sort());
    expect(realm.members.find(m => m.owner === key(60))?.delegate).toBe(key(90)); expect(realm.councilSupplyRaw).toBe('5');
    expect(realm.addins.community.voterWeight).toBe(i.registry.programs[0].address);
    expect(i.governance.overlaps.map(o => [o.realm, o.count, o.signerCount])).toEqual([[dao, 2, 3], [emergency, 1, 3]]);
    const queries = rpc.evidence.filter(e => e.method === 'getProgramAccounts');
    expect(queries.filter(e => (e.params as any).filters.length === 3)).toHaveLength(4);
    for (const member of realm.members) expect(member.evidenceIds.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(i.governance)).not.toThrow();
  });
  test('admin, pause, program upgrades, council mint authority, and every native treasury map to their governance', async () => {
    const { i, treasuries } = await syntheticGovernance();
    expect(i.governance.mappings.find(m => m.target === 'adminAuthority')).toMatchObject({ address: treasuries[0], governance: governanceKeys[0], votingBody: 'council-only' });
    expect(i.governance.mappings.find(m => m.target === 'pauseAuthority')?.realm).toBe(emergency);
    expect(i.governance.mappings.find(m => m.target === 'native-staking-proxy upgrade authority')?.votingBody).toBe('community-only');
    expect(i.governance.mappings.find(m => m.target === 'Marinade DAO council mint authority')?.governance).toBe(governanceKeys[0]);
    expect(i.governance.mappings.filter(m => m.target === 'native treasury')).toHaveLength(5);
  });
  test('wrong program ownership fails closed', async () => {
    const { i, rpc, infos } = await syntheticGovernance();
    infos.get(dao)!.owner = new PublicKey(key(1));
    await expect(readGovernanceConfig(rpc, i.registry, i.layer, i.authorities)).rejects.toThrow('invalid Realm');
  });
});

describe('corrected governance API and graph with synthetic recorded accounts', () => {
  test('admin controller is the council; treasury voting includes council veto; council members exclude authority addresses', async () => {
    const { control, parameters, treasuries } = await syntheticAnswer();
    const row = control.rows.find(r => r.role === 'adminAuthority')!, council = control.controllers.find(c => c.id === row.controllerId)!;
    expect(council.type).toBe('council-realm'); expect(council.label).toBe('Marinade DAO council (2 members)');
    expect(council.members?.map(m => m.address)).toEqual([key(60), key(61)].sort());
    expect(row.note).toContain('community voting disabled in this governance');
    expect(parameters.rows.find(p => p.field === 'rewardFee')?.setBy[0].controllerId).toBe(council.id);
    const treasury = control.rows.find(r => r.holder.address === treasuries[1])!;
    expect(treasury.controllerIds).toHaveLength(2); expect(treasury.note).toContain('council veto 50 %');
    expect(control.controllers.find(c => c.id === treasury.controllerId)?.label).toBe('Marinade DAO community — MNDE voters through VSR');
    expect(control.rows.find(r => r.holder.address === treasuries[2])?.note).toContain('community vote 2 %');
  });
  test('no directed path from VSR to admin; answer uses decoded voting permissions and membership counts', async () => {
    const { answer, path } = await syntheticAnswer();
    const reachable = new Set(['vsr-locking']);
    for (let n = 0; n < path.nodes.length; n++) for (const l of path.links) if (reachable.has(l.from)) reachable.add(l.to);
    expect(reachable.has('admin-authority')).toBe(false); expect(reachable.has('dao-treasury-mnde')).toBe(true);
    expect(path.links.find(l => l.id === 'council-admin')?.status).toBe('enforced-by-code');
    expect(answer.shortAnswer.text).toContain('The Marinade DAO council (2 members) sets the fee route');
    expect(answer.statements.find(s => s.id === 'fee-control')?.text).toContain('MNDE holders cannot propose or vote there');
    expect(answer.statements.find(s => s.id === 'treasury-voting')?.text).toContain('200,000 MNDE to propose');
    expect(answer.statements.find(s => s.id === 'msol-upgrade')?.text).toContain('2 of the 3 signers');
    expect(answer.statements.find(s => s.id === 'pause-control')?.text).toContain('Emergency Council (2 members) can pause');
  });
  test('who-votes-where follows actual governances and preserves TG namespaces and local/Neo4j columns', async () => {
    const { bundle } = await syntheticAnswer(), graph = buildTokenomicsGraph(bundle);
    assertTokenomicsNamespace(graph);
    const local = runTokenomicsLocal(graph, 'who-votes-where');
    expect(local.rows.some(r => r.governance === governanceKeys[0] && r.votingBody === 'Marinade DAO council (2 members)')).toBe(true);
    expect(local.rows.some(r => r.governance === governanceKeys[0] && String(r.votingBody).includes('community'))).toBe(false);
    expect(local.rows.some(r => r.governance === governanceKeys[1] && String(r.thresholds).includes('council veto 50 %'))).toBe(true);
    const remote = await runTokenomicsNeo4j({ executeQuery: async () => ({ records: local.rows.map(r => ({ toObject: () => r })) }) }, 'who-votes-where', { database: 'neo4j' });
    expect(remote).toEqual(local);
  });
});

const registry: PackRegistry = JSON.parse(readFileSync(new URL('../packs/marinade/registry.json', import.meta.url), 'utf8'));
test.skipIf(!hasGovernanceFixture(registry))('recorded mainnet admin governance is council-only', async () => {
  const rpc = new RecordingRpc(runOptions({ offline: true, record: false, refresh: false }), 'marinade-contracts');
  const input: ContractsInput = JSON.parse(readFileSync(new URL('../packs/marinade/contracts.json', import.meta.url), 'utf8'));
  const layer = await readContractsLayer(rpc, registry, input), authorities = await readAuthorities(rpc, registry, layer);
  const governance = await readGovernanceConfig(rpc, registry, layer, authorities);
  expect(governance.mappings.find(m => m.target === 'adminAuthority')?.votingBody).toBe('council-only');
  expect(rpc.counts.live).toBe(0);
}, 120_000);
