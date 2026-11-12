import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPrivateExportPath } from '../../review/position/export';
import { loadNearSnapshots, loadNearSnapshot } from '../reader/load';
import { openStore } from '../../engine/queries/snapshot';
import { captureSnapshot } from '../reader/capture';
import { CURRENT_NEAR_SNAPSHOT } from '../subjects/registry';
import { loadNearLibraries, loadNearPolicy, referencedSnapshots } from '../policy/index';
import { callTool } from '../mcp/tools';
import { startMcpServer } from '../mcp/server';
import { option } from './policy';
export async function run(args: string[]): Promise<number> {
  if (args.some(arg => arg === '--host' || arg.startsWith('--host='))) { console.error('serve does not accept --host; the listener binds to 127.0.0.1'); return 2; }
  const token = process.env.LINCHPIN_MCP_TOKEN;
  if (!token || token.length < 32) { console.error('LINCHPIN_MCP_TOKEN is required (at least 32 characters)'); return 2; }
  try {
    const port = Number(option(args, '--port', '8787')); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error();
    const live = option(args, '--live'); if (live && args.includes('--offline')) throw new Error();
    const snapshotId = live ?? option(args, '--snapshot', CURRENT_NEAR_SNAPSHOT)!;
    let root: string | undefined;
    if (live) { root = await mkdtemp(join(tmpdir(), 'linchpin-near-')); await captureSnapshot({ snapshotId: live, root }); }
    const libs = await loadNearLibraries(), policyDir = option(args, '--policies'), policiesDir = policyDir ? pathToFileURL(resolve(policyDir) + sep) : undefined;
    const policy = await loadNearPolicy('quantrin-near-v1', libs, policiesDir);
    const ids = [...new Set([snapshotId, ...referencedSnapshots(policy)])];
    const store = root ? openStore(ids.map(id => loadNearSnapshot(id, id === snapshotId ? { root } : {}).snapshot(id)!)) : loadNearSnapshots(ids);
    const accessPath = option(args, '--access-log');
    let accessLog: ((line: string) => void) | undefined;
    if (accessPath) {
      const path = checkPrivateExportPath(accessPath); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, '', { mode: 0o600 }); chmodSync(path, 0o600);
      accessLog = line => appendFileSync(path, line + '\n', { mode: 0o600 });
    }
    const allowedOrigins = args.flatMap((v, i) => v === '--allow-origin' ? [args[i + 1] ?? ''] : []);
    // Complete committed-policy library work before advertising readiness.
    await callTool('linchpin_policy_verdict', { policyId: 'quantrin-near-v1' }, { store, snapshotId, libs, policiesDir });
    const server = startMcpServer({ token, snapshotId, store, libs, port, policiesDir, accessLog, allowedOrigins });
    console.log(`listening ${server.url}`);
    await new Promise<void>(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void server.stop().then(resolve); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
    return 0;
  } catch { console.error('serve-failed'); return 1; }
}
