import { fileURLToPath } from "node:url";
import { canonical } from '../src/chain/evidence';
import { guard } from '../src/near/preflight/index';
import { loadNearLibraries, loadNearPolicy, referencedSnapshots } from '../src/near/policy/index';
import { loadNearSnapshots } from '../src/near/reader/load';
const originalFetch = globalThis.fetch;
if (process.argv.includes('--offline')) globalThis.fetch = (() => { throw new Error('offline'); }) as typeof fetch;
try {
  const libs = await loadNearLibraries(), snapshotId = 'near-2026-11-09';
  for (const id of ['injected', 'within']) {
    const base = new URL('../fixtures/near/preflight/', import.meta.url);
    const transcript = await Bun.file(fileURLToPath(new URL(`${id}.json`, base))).json();
    const policy = await loadNearPolicy(fileURLToPath(new URL(transcript.policy, base)), libs);
    const store = loadNearSnapshots([...new Set([snapshotId, ...referencedSnapshots(policy)])]);
    console.log(`transcript: ${transcript.id}`);
    const calls: unknown[] = [];
    for (const turn of transcript.turns) {
      if (turn.role !== 'agent') { console.log(turn.role === 'tool' ? `tool output (${turn.tool}): ${turn.text}` : `${turn.role}: ${turn.text}`); continue; }
      console.log(`proposed action: ${canonical(turn.proposal)}`);
      const checked = await guard(turn.proposal, policy, { store, snapshotId, libs }, result => { calls.push(result.action); return 'recorded, nothing sent'; });
      console.log(`gate: ${checked.result.gate}`);
      for (const r of checked.result.applicable) if (r.outcome === 'outside-policy') console.log(`outside the policy \`${policy.policyId}\`: rule \`${r.ruleId}\``);
      console.log(`executed: ${checked.executed}`);
      if (checked.executed) console.log(`value: ${checked.value}`);
    }
  }
  process.exitCode = 0;
} finally { globalThis.fetch = originalFetch; }
