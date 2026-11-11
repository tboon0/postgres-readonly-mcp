import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const directory = await mkdtemp(join(tmpdir(), 'postgres-readonly-package-'));
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
let client;
try {
  const output = execFileSync(npm, ['pack', '--json', '--pack-destination', directory], { encoding: 'utf8' });
  // Lifecycle output can precede the JSON on some npm versions.
  const [packed] = JSON.parse(output.slice(output.indexOf('[\n')));
  for (const { path } of packed.files) {
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|SECURITY\.md|dist\/[a-zA-Z0-9_-]+\.(?:js|d\.ts))$/, `Unexpected package file: ${path}`);
  }
  assert(packed.files.some(file => file.path === 'dist/index.js'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], { cwd: directory, stdio: 'inherit' });
  const installed = join(directory, 'node_modules', manifest.name);
  const require = createRequire(join(installed, 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  const bin = join(directory, 'node_modules', '.bin', 'postgres-readonly-mcp');
  assert.match(execFileSync(bin, ['--help'], { encoding: 'utf8' }), /--profiles/);
  const profiles = join(directory, 'profiles.yaml');
  await writeFile(profiles, 'profiles:\n  smoke:\n    host: 127.0.0.1\n    port: 1\n    database: smoke\n    user: smoke\n    password_env: PACKAGE_SMOKE_PASSWORD\n    sslmode: disable\n');
  client = new Client({ name: 'package-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(installed, 'dist/index.js'), '--profiles', profiles] }));
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === 'query'));
  const result = await client.callTool({ name: 'list_profiles', arguments: {} });
  assert(!result.isError);
  assert.match(JSON.stringify(result), /smoke/);
  assert(!JSON.stringify(result).includes('PACKAGE_SMOKE_PASSWORD'));
  console.log('Packed install, executable, MCP handshake, tool schemas, and list_profiles passed.');
} finally {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
}
