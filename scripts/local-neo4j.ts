import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(import.meta.dir, '..');
const configPath = resolve(root, '.neo4j.local');
const command = process.argv[2];
if (!['up', 'down', 'status', 'load', 'web'].includes(command ?? '')) {
  console.error('Usage: bun run scripts/local-neo4j.ts up|down|status|load|web');
  process.exit(2);
}
if (!existsSync(configPath)) {
  console.error('Missing .neo4j.local. See docs/local-neo4j.md for setup.');
  process.exit(2);
}
let password: unknown;
try { password = (await Bun.file(configPath).json()).password; }
catch { console.error('Invalid local database configuration.'); process.exit(2); }
if (typeof password !== 'string' || password.length < 8) {
  console.error('Local database password must contain at least 8 characters.');
  process.exit(2);
}
const env = { ...process.env, NEO4J_URI: 'bolt://127.0.0.1:7687',
  NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: password, NEO4J_DATABASE: 'neo4j' };
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
if (command === 'load') {
  await run([process.execPath, 'run', 'scripts/load-neo4j.ts']);
  await run([process.execPath, 'run', 'scripts/load-tokenomics-neo4j.ts']);
} else if (command === 'web') {
  await run([process.execPath, 'run', 'src/web/server.ts']);
} else {
  const desktop = '/Applications/Docker.app/Contents/Resources/bin/docker';
  const docker = Bun.which('docker') ?? (existsSync(desktop) ? desktop : undefined);
  if (!docker) { console.error('Install and start Docker before running this command.'); process.exit(2); }
  const bundledCompose = '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose';
  const socket = resolve(homedir(), '.docker/run/docker.sock');
  if (docker === desktop && !env.DOCKER_HOST && !env.DOCKER_CONTEXT && existsSync(socket)) {
    env.DOCKER_HOST = `unix://${socket}`;
  }
  const args = command === 'up' ? ['up', '-d', '--wait', '--wait-timeout', '240']
    : command === 'down' ? ['down'] : ['ps'];
  const compose = docker === desktop && existsSync(bundledCompose) ? [bundledCompose] : [docker, 'compose'];
  await run([...compose, '-f', resolve(root, 'compose.yaml'), ...args]);
}
